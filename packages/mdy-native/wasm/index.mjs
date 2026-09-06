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

/** Text out of a built file, for callers that know it is text. */
export function text(bytes) {
  return new TextDecoder().decode(bytes);
}
