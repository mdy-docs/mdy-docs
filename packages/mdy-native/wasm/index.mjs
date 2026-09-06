/*
 * The engine in a browser: the same C as build/mdy, compiled with
 * emscripten, driven exactly as the command line drives it.
 *
 *   import { build } from './wasm/index.mjs';
 *   const { files, log, status } = await build(siteFiles, { site: 'blog' });
 *
 * `siteFiles` is what a site is on disk — a Map (or iterable of pairs) from
 * a relative path to its bytes or text — and `files` is what dist/ would
 * hold, the same way. Nothing is served and nothing is fetched: the files go
 * into emscripten's in-memory filesystem, main() runs against them, and
 * dist/ is read back out. That is the whole bridge, and it is why this
 * wrapper is short: the engine's only platform surface is POSIX file access,
 * which MEMFS provides, and its document store is memory already.
 *
 * A build gets a fresh module instance. Instantiation is cheap next to a
 * build, and it is the honest way to promise that two builds share nothing —
 * the engine keeps a little static state that the CLI never had to reset,
 * because a process ends.
 *
 * `site` names the subdirectory of the mounted tree that is the site. It
 * exists because a site may import a package by relative path — fixture-pkg
 * imports "../fixture-style" — and that package has to be mounted too, next
 * to it, for the import to resolve the way it does on disk.
 */

const ROOT = '/work';
const OUT = '/dist';


/**
 * @param {Iterable<[string, Uint8Array | string]> | Record<string, Uint8Array | string>} input
 * @param {{ site?: string, entry?: string, drafts?: boolean, future?: boolean,
 *           quiet?: boolean, createModule?: Function }} [options]
 * @returns {Promise<{ files: Map<string, Uint8Array>, log: string, status: number }>}
 */
export async function build(input, options = {}) {
  const {
    site = '',
    entry = 'main.mdy',
    drafts = false,
    future = false,
    quiet = true,
    createModule,
  } = options;

  const factory = createModule ?? (await import('../build/wasm/mdy-native.mjs')).default;
  const lines = [];
  const Module = await factory({
    noInitialRun: true,
    print: (s) => lines.push(s),
    printErr: (s) => lines.push(s),
  });
  const { FS } = Module;

  const entries = input instanceof Map || Symbol.iterator in Object(input)
    ? input
    : Object.entries(input);

  FS.mkdirTree(ROOT);
  FS.mkdirTree(OUT);
  for (const [rel, data] of entries) {
    const path = `${ROOT}/${rel.replace(/^\/+/, '')}`;
    const slash = path.lastIndexOf('/');
    if (slash > 0) FS.mkdirTree(path.slice(0, slash));
    FS.writeFile(path, typeof data === 'string' ? data : new Uint8Array(data));
  }

  const root = site ? `${ROOT}/${site.replace(/^\/+|\/+$/g, '')}` : ROOT;
  const args = ['build', root, '--out', OUT, '--entry', entry];
  if (drafts) args.push('--drafts');
  if (future) args.push('--future');
  if (quiet) args.push('--quiet');

  let status;
  try {
    status = Module.callMain(args);
  } catch (e) {
    // exit() inside main arrives as an ExitStatus; anything else is a real fault.
    if (e && typeof e.status === 'number') status = e.status;
    else throw e;
  }

  const files = new Map();
  const walk = (dir, rel) => {
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const path = `${dir}/${name}`;
      const child = rel ? `${rel}/${name}` : name;
      if (FS.isDir(FS.stat(path).mode)) walk(path, child);
      else files.set(child, FS.readFile(path));
    }
  };
  walk(OUT, '');

  return { files, log: lines.join('\n'), status: status ?? 0 };
}

/**
 * One document, as `mdy <file>` renders it — its own `---`-split documents,
 * the first the entry — and, with `publish`, what it published delivered
 * here as `mdy <file> --publish` does: the broker linked into the engine
 * takes each message and the page it names renders with it as `req`, its
 * output printed under the [deliver] line. That output comes back parsed
 * into `messages`, so a page need not know the log's shape.
 *
 * @param {string | Uint8Array} source
 * @param {{ html?: boolean, publish?: boolean, data?: Record<string, unknown>,
 *           createModule?: Function }} [options]
 * @returns {Promise<{ output: string, messages: Array<object>, log: string,
 *                     errors: string, status: number }>}
 */
export async function document(source, options = {}) {
  const { html = true, publish = false, data = null, createModule } = options;

  const factory = createModule ?? (await import('../build/wasm/mdy-native.mjs')).default;
  const out = [];
  const err = [];
  const Module = await factory({
    noInitialRun: true,
    print: (s) => out.push(s),
    printErr: (s) => err.push(s),
  });
  const { FS } = Module;

  FS.mkdirTree(ROOT);
  FS.mkdirTree(OUT);
  FS.writeFile(`${ROOT}/document.mdy`, typeof source === 'string' ? source : new Uint8Array(source));
  const args = [`${ROOT}/document.mdy`, '-o', `${OUT}/document.out`];
  if (html) args.push('--html');
  if (publish) args.push('--publish');
  if (data) {
    FS.writeFile(`${ROOT}/data.json`, JSON.stringify(data));
    args.push('--data-file', `${ROOT}/data.json`);
  }

  let status;
  try {
    status = Module.callMain(args);
  } catch (e) {
    if (e && typeof e.status === 'number') status = e.status;
    else throw e;
  }

  let output = '';
  try { output = text(FS.readFile(`${OUT}/document.out`)); } catch { /* a failed render writes nothing */ }
  const errors = err.filter((line) => !line.startsWith('[read] ')).join('\n');
  return { output, messages: parseMessages(out, err), log: out.join('\n'), errors, status };
}

/*
 * The --publish log, line by line. stdout carries sends and deliveries,
 * each delivery's output indented under it; stderr carries refusals, with
 * the error and the verdict indented under those. A leading clock is the
 * dev server's habit and means nothing here.
 */
const STAMP = /^\s*(?:\d{1,2}:\d\d:\d\d [AP]M )?/;
const LINE = /^\[(\w+)\] (\S+) #(\d+)(?:, (\d+) bytes)?(?: → rendered (.+?) in \d+ms(?: \(published (\d+)\))?)?(?: — (.+))?$/;

function parseMessages(out, err) {
  const messages = [];
  const scan = (lines, kinds) => {
    let current = null;
    for (const raw of lines) {
      if (raw.startsWith('  ') && current) { current.lines.push(raw.slice(2)); continue; }
      current = null;
      const m = LINE.exec(raw.replace(STAMP, ''));
      if (!m || !kinds.has(m[1])) continue;
      current = { kind: m[1], name: m[2], index: Number(m[3]), page: m[5] ?? null,
                  published: m[6] ? Number(m[6]) : 0, detail: m[7] ?? null, lines: [] };
      messages.push(current);
    }
  };
  scan(out, new Set(['send', 'deliver', 'dead']));
  scan(err, new Set(['refuse', 'dead', 'send']));
  for (const m of messages) {
    if (m.kind === 'deliver' || (m.kind === 'dead' && m.page)) m.output = m.lines.join('\n');
    else if (m.kind === 'refuse') { m.error = m.lines[0] ?? null; m.verdict = m.lines[1] ?? null; }
    delete m.lines;
  }
  /* The two streams cannot be interleaved after the fact, so the order is
   * stdout's — a send, then what it caused — with a refusal placed after
   * the send it answers, where a reader of the terminal would have seen it. */
  const refusals = messages.filter((m) => m.kind === 'refuse');
  const ordered = [];
  for (const m of messages) {
    if (m.kind === 'refuse') continue;
    ordered.push(m);
    if (m.kind === 'send') ordered.push(...refusals.filter((r) => r.name === m.name && r.index === m.index));
  }
  for (const r of refusals) if (!ordered.includes(r)) ordered.push(r);
  return ordered;
}

/** Text out of a built file, for callers that know it is text. */
export function text(bytes) {
  return new TextDecoder().decode(bytes);
}
