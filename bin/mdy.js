#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse as loadYaml } from 'yaml';
import {
  parseDocuments,
  compileTemplateSource,
  nodeFsProvider,
  openDocumentSet,
  walkRawSources,
  renderScriptSite,
  buildSite,
  serveSite,
} from '../index.js';

// Minimal ANSI color helpers — no dependency, since this is presentation
// for the CLI only (not something a library embedder should have forced on
// them). Honors NO_COLOR (https://no-color.org/) and FORCE_COLOR, and
// disables automatically when stdout isn't a TTY — piped output, or a test
// harness capturing output via child_process, never gets escape codes.
const useColor = Boolean(process.env.FORCE_COLOR) || (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
const paint = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const bold = paint(1, 22);
const dim = paint(2, 22);
const red = paint(31, 39);
const green = paint(32, 39);
const yellow = paint(33, 39);
const blue = paint(34, 39);
const cyan = paint(36, 39);
const magenta = paint(35, 39);
const mdyTag = () => cyan('[mdy]');
const timestamp = () => dim(new Date().toLocaleTimeString());

// Ingested (read into the document set), written (produced on disk/in
// memory), and changed (a watched file whose save triggered a rebuild) —
// one color each, used consistently across build/serve and the plain CLI.
const tagRead = () => blue('[read]');
const tagWrite = () => green('[write]');
const tagChange = () => yellow('[change]');
const tagSend = () => magenta('[send]');

// `mdy build`/`mdy serve` — the static-site layer. Handled first and
// unconditionally: a bare `mdy [input...]` treats every positional as a
// document path, so these two verbs have to be claimed before that parsing
// ever runs.
const SITE_USAGE = `mdy — build sites from mdy documents.

Usage:
  mdy build [site-dir] [--out <dir>] [--drafts] [--future] [--entry <path>]
            [--publish [--broker <url>]]
      render the site (default dir: ., out: <site-dir>/dist)
  mdy serve [site-dir] [--port <n>] [--drafts] [--future] [--entry <path>]
      dev server: watch, rebuild, live reload (default port: 4321)

Every site is a script-defined site: site-dir's entry document (main.mdy,
or --entry <path>) decides everything itself — content, URLs, layouts,
output shape — via $/$.find/$.render/$.emit. --drafts/--future are
threaded through as plain context booleans for it to interpret, not
filtered here.

$.publish(name, data) queues a message for another page — $.render
deferred and made durable. Messages are collected during the build and
sent only once it has fully succeeded, so a failed build publishes
nothing and a watch-mode rebuild does not re-fire what the last one sent.
Without --publish they are reported and dropped; with it they go to a
sukkal broker (--broker, default http://127.0.0.1:8080).
`;

/** Shared flag parsing for build/serve: positional root + options. */
function parseSiteArgs(args) {
  const opts = { root: '.' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') opts.outDir = args[++i];
    else if (a === '--port') opts.port = Number(args[++i]);
    else if (a === '--drafts') opts.drafts = true;
    else if (a === '--future') opts.future = true;
    else if (a === '--entry') opts.entry = args[++i];
    else if (a === '--publish') opts.publish = true;
    else if (a === '--broker') opts.broker = args[++i];
    else opts.root = a;
  }
  return opts;
}

const siteFail = (message) => {
  console.error(red(String(message)));
  process.exit(1);
};

/** vite-style "ready" banner, printed once after the dev server's first build completes. */
function serveReadyBanner(url, ms) {
  return [
    '',
    `  ${bold(magenta('MDY'))}  ${dim('ready in')} ${bold(`${ms} ms`)}`,
    '',
    `  ${green('➜')}  ${bold('Local:')}   ${cyan(url)}`,
    `  ${green('➜')}  ${dim('press ctrl+c to stop')}`,
    '',
  ].join('\n');
}

/** serveSite's onRebuild: every rebuild AFTER the first gets its own
 * timestamped line (vite's HMR-update style), prefixed with which watched
 * file(s) triggered it; the first is covered by serveReadyBanner instead,
 * unless it failed — a broken first build still serves, so that's worth
 * surfacing immediately rather than staying silent under the ready banner. */
function makeServeLogger() {
  return (info) => {
    if (info.ok && info.first) return;
    const ts = timestamp();
    for (const path of info.changed ?? []) console.log(`${ts} ${tagChange()} ${path}`);
    if (info.ok) {
      const detail = info.reused > 0 ? dim(` (${info.reused} reused, ${info.rebuilt} rebuilt)`) : '';
      console.log(`${ts} ${mdyTag()} rendered ${bold(info.pages)} page(s) in ${info.ms}ms${detail}`);
    } else {
      console.error(`${ts} ${red('[mdy] build failed')} — still serving the last good build\n  ${info.error}`);
    }
  };
}

/** A given path gets a `[read]` line only the first time this process ever
 * sees it — a script-defined site has no incremental cache (script-site.js),
 * so every rebuild re-walks and re-ingests everything; reporting all of it
 * again on every keystroke-triggered save would drown out what matters
 * (see makeServeLogger's `[change]` line for that instead). */
function makeSourceLogger() {
  const seen = new Set();
  return (meta) => {
    if (seen.has(meta.path)) return;
    seen.add(meta.path);
    console.log(`${tagRead()} ${meta.path}`);
  };
}

if (['build', 'serve'].includes(process.argv[2])) {
  const [siteCmd, ...siteRest] = process.argv.slice(2);
  if (siteRest.includes('--help') || siteRest.includes('-h')) {
    process.stdout.write(SITE_USAGE);
    process.exit(0);
  }
  switch (siteCmd) {
    case 'build': {
      const { root, publish, broker, ...opts } = parseSiteArgs(siteRest);
      try {
        const started = Date.now();
        const { pages, outDir, messages } = await buildSite(root, {
          ...opts,
          onSource: (meta) => console.log(`${tagRead()} ${meta.path}`),
          onWrite: (file) => console.log(`${tagWrite()} ${file}`),
        });
        console.log(
          `${green('✓')} built ${bold(pages)} page(s) → ${cyan(outDir)} ${dim(`(${Date.now() - started}ms)`)}`
        );
        // Strictly after the build reported success — that ordering IS
        // the deferred half of $.publish (src/publish.js), not a
        // formatting choice.
        if (messages.length > 0) {
          if (publish) {
            const { publishMessages } = await import('./sukkal.js');
            const { sent } = await publishMessages(messages, {
              url: broker,
              onSend: ({ name, bytes }) => console.log(`${tagSend()} ${name} ${dim(`(${bytes} bytes)`)}`),
            });
            console.log(`${green('✓')} published ${bold(sent)} message(s)`);
          } else {
            for (const m of messages) console.log(`${dim('[hold]')} ${m.name}`);
            console.log(
              dim(`  ${messages.length} message(s) not sent — pass --publish to send them to a sukkal broker`)
            );
          }
        }
      } catch (err) {
        siteFail(err.message ?? err);
      }
      break;
    }
    case 'serve': {
      const { root, ...opts } = parseSiteArgs(siteRest);
      try {
        const started = Date.now();
        const { url } = await serveSite(root, {
          ...opts,
          onSource: makeSourceLogger(),
          onRebuild: makeServeLogger(),
        });
        console.log(serveReadyBanner(url, Date.now() - started));
      } catch (err) {
        siteFail(err.message ?? err);
      }
      break;
    }
  }
} else {

  // Reading/watching input files goes through nodeFsProvider (this package's
  // own vault layer) rather than calling node:fs directly — this CLI is a
  // real consumer of the same primitive any embedder gets, not a second,
  // hand-rolled implementation of "read a file, watch a directory" living
  // next to it. (writeFileSync for --out, and readFileSync(0) for stdin,
  // stay direct: neither is "getting a file into the document set", which
  // is what the vault layer is for.)
  const fs = nodeFsProvider();

  const USAGE = `mdy — generate a document from an mdy template, or a script-defined site.

Usage:
  mdy [path] [options]
  mdy build [site-dir] [options]   render a whole site — see: mdy build --help
  mdy serve [site-dir] [options]   dev server for a site — see: mdy serve --help

Arguments:
  path                   A .mdy file, a directory, or "-"/omitted for stdin.
                        A FILE renders just that file — its own \`---\`-split
                        documents, the first is the entry — with no access to
                        any other file.
                        A DIRECTORY is scanned in full: every file under it
                        is inserted as a raw document (path/name/ext/size/
                        mtime, plus front matter for .mdy files), so the
                        entry document's $/$.find/$.render reach any of
                        them — it alone decides what any file/path means
                        (which are "posts", what URL/layout each gets, …),
                        entirely in template code. The entry defaults to
                        main.mdy; --entry picks another file.

Options:
  -o, --out <file>      Write output to <file> (default: stdout). If <file>
                        is an existing directory, any $.emit(path, content)
                        the entry produced is written under it instead (the
                        entry's own rendered output still goes to stdout in
                        that case, since there is no filename for it).
      --html            Emit the finished document as HTML instead of the
                        text its own code wrote (which is what an .mdy file
                        producing a feed, a robots.txt or any other
                        non-markup output actually means).
      --entry <path>    Directory input only: the entry document's path,
                        relative to the directory (default: main.mdy).
      --emit-js         Emit the compiled JavaScript instead of rendering
                        (debug): every document for a file input, just the
                        entry document for a directory input.
  -d, --data <k=v>      Add a context value (repeatable). Value is parsed as
                        JSON when possible, otherwise treated as a string.
      --data-file <f>   Merge a YAML/JSON file into the context.
  -w, --watch           Keep running and re-render on any relevant change —
                        the given file (or, for a directory, any file under
                        it) plus --data-file. A failing render reports to
                        stderr and keeps watching. Not available with stdin.
  -h, --help            Show this help.

Extra context (from --data / --data-file) overrides the document's front matter.
A document with no $.emit calls just renders to stdout/-o as always; $.emit
is the idiom for producing more than one output from a single entry.

Examples:
  mdy report.mdy
  mdy report.mdy --html -o report.html
  mdy report.mdy -d env=prod -d 'build=42' --data-file overrides.yaml
  mdy report.mdy -o report.md --watch             # live re-render on save
  cat report.mdy | mdy - --html                   # stdin → HTML on stdout
  mdy ./my-site                                   # scan the dir, render main.mdy
  mdy ./my-site --entry other.mdy -o dist         # write $.emit output`;

  function fail(msg) {
    // Library errors are already prefixed with "mdy:"; don't double it.
    const text = String(msg).replace(/^mdy:\s*/, '');
    process.stderr.write(red(`mdy: ${text}`) + '\n');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        html: { type: 'boolean', default: false },
        entry: { type: 'string' },
        'emit-js': { type: 'boolean', default: false },
        data: { type: 'string', short: 'd', multiple: true, default: [] },
        'data-file': { type: 'string' },
        watch: { type: 'boolean', short: 'w', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(err.message);
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  // Parse -d pairs once: they are static, so malformed ones fail immediately.
  const dataPairs = {};
  for (const pair of values.data) {
    const eq = pair.indexOf('=');
    if (eq === -1) fail(`--data expects key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    try {
      dataPairs[key] = JSON.parse(raw); // numbers, booleans, null, arrays, objects, "quoted"
    } catch {
      dataPairs[key] = raw; // bare string
    }
  }

  if (positionals.length > 1) fail('mdy accepts a single input: one file, one directory, or stdin ("-")');
  const inputArg = positionals[0] ?? '-';
  const isStdin = inputArg === '-';
  const inputAbs = isStdin ? null : resolve(inputArg);

  // 'file' | 'dir' | 'stdin' — decided once, up front, so every later check
  // (flag validity, warnings, watch target) can just branch on it.
  let inputKind = 'stdin';
  if (!isStdin) {
    let stat;
    try {
      stat = statSync(inputAbs);
    } catch (err) {
      fail(`cannot read input: ${err.message}`);
    }
    inputKind = stat.isDirectory() ? 'dir' : 'file';
  }

  if (values.entry !== undefined && inputKind !== 'dir') fail('--entry is only valid with a directory input');
  if (values.watch && inputKind === 'stdin') fail('--watch cannot read from stdin');
  if (values['emit-js'] && values.html) fail('--emit-js cannot be combined with --html');
  if (values.out && inputKind !== 'stdin' && resolve(values.out) === inputAbs) {
    fail('refusing to overwrite the input');
  }
  if (inputKind === 'file' && extname(inputArg).toLowerCase() !== '.mdy') {
    process.stderr.write(`mdy: warning: input "${inputArg}" does not have a .mdy extension\n`);
  }

  // --- one render pass (re-run per change in --watch mode; throws, never exits)

  /** Extra context: --data-file (re-read each pass) first, then -d overrides. */
  async function loadContext() {
    const context = {};
    if (values['data-file']) {
      let fileText;
      try {
        fileText = await fs.read(dirname(values['data-file']), basename(values['data-file']));
      } catch (err) {
        throw new Error(`cannot read --data-file: ${err.message}`);
      }
      const loaded = loadYaml(fileText);
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
        Object.assign(context, loaded);
      } else {
        throw new Error('--data-file must contain a YAML/JSON mapping');
      }
    }
    return Object.assign(context, dataPairs);
  }

  /** A given path gets a `[read]` line only the first time this process
   * ever sees it — --watch re-walks the whole directory on every save
   * (see script-site.js), so repeating it all every keystroke would drown
   * out what matters. */
  const seenSources = new Set();
  function logSource(meta) {
    if (seenSources.has(meta.path)) return;
    seenSources.add(meta.path);
    process.stderr.write(`${tagRead()} ${meta.path}\n`);
  }

  /** $.emit output: written under --out if it's an existing directory, else just reported. */
  async function reportEmitted(emitted) {
    if (emitted.size === 0) return;
    const toDir = values.out && existsSync(values.out) && statSync(values.out).isDirectory();
    if (toDir) {
      for (const [path, content] of emitted) {
        const dest = join(values.out, path);
        await mkdir(dirname(dest), { recursive: true });
        // $.emit content is text; $.resize content ($.resize's binaryOutputs)
        // is a Uint8Array of real image bytes — never JSON.stringify that.
        const bytes =
          typeof content === 'string' ? content : content instanceof Uint8Array ? content : JSON.stringify(content);
        await writeFile(dest, bytes);
        process.stderr.write(`${tagWrite()} ${path}\n`);
      }
      process.stderr.write(`mdy: wrote ${emitted.size} emitted file(s) to ${values.out}\n`);
    } else {
      process.stderr.write(
        `mdy: ${emitted.size} file(s) emitted via $.emit not written (pass --out <existing-dir> to write them): ${[...emitted.keys()].join(', ')}\n`
      );
    }
  }

  /**
   * Position of the document whose `data.path === entryPath` in a flattened
   * document array (`set.docs`, or `parseDocuments(sources)`'s own result —
   * both carry `.data.path` and are indexed identically, array position).
   * Resolved AFTER splitting/flattening, not against the pre-split file
   * list: a sibling file with its own internal `---` splits contributes
   * more than one document, which would shift every later file's position.
   */
  function findEntryIndex(docs, entryPath, root) {
    const i = docs.findIndex((d) => d.data.path === entryPath);
    if (i === -1) {
      throw new Error(`entry script not found at ${JSON.stringify(entryPath)} (looked among ${docs.length} document(s) under ${root})`);
    }
    return i;
  }

  async function generateOutput() {
    const context = await loadContext();
    let output;
    let emitted = new Map();

    if (inputKind === 'dir') {
      // The script-entry-point mechanism: walk the whole directory into raw
      // documents and render one designated entry — its $/$.find/$.render
      // reach every other file under the directory, and $.emit/$.resize
      // collect any named side outputs. Shared with mdy build/serve's own
      // script-site detection (src/build.js) — same primitive, same
      // natives, one implementation.
      const entryPath = values.entry ?? 'main.mdy';
      if (values['emit-js']) {
        const sources = await walkRawSources(inputAbs, { fs });
        const docs = parseDocuments(sources);
        const i = findEntryIndex(docs, entryPath, inputAbs);
        output = `// document ${i}\nfunction __doc${i}(req, res) {\n${compileTemplateSource(docs[i].content)}\nreturn __out;\n}`;
      } else {
        const site = await renderScriptSite(inputAbs, {
          entry: entryPath,
          fs,
          context,
          onSource: logSource,
        });
        emitted = new Map([...site.outputs, ...site.binaryOutputs]);
        output = values.html ? site.output : site.text;
      }
    } else {
      // 'file' or 'stdin': just that one input's own text, no site walk.
      let text;
      try {
        text = isStdin ? readFileSync(0, 'utf8') : await fs.read(dirname(inputAbs), basename(inputAbs));
      } catch (err) {
        throw new Error(`cannot read input: ${err.message}`);
      }
      if (!isStdin) logSource({ path: inputAbs });
      if (values['emit-js']) {
        const docs = parseDocuments(text);
        output = docs
          .map(
            (doc, i) =>
              `// document ${i}\nfunction __doc${i}(req, res) {\n${compileTemplateSource(doc.content)}\nreturn __out;\n}`
          )
          .join('\n\n');
      } else {
        const localEmitted = new Map();
        const set = await openDocumentSet(text, {
          onEmit: ({ path, content }) => localEmitted.set(path, content),
        });
        emitted = localEmitted;
        output = values.html ? await set.render(0, context) : await set.renderText(0, context);
      }
    }

    if (!values['emit-js']) await reportEmitted(emitted);
    return output.endsWith('\n') ? output : output + '\n';
  }

  function emitOutput(output) {
    // --out as an existing directory is claimed by $.emit output (see
    // reportEmitted) — there's no filename to write the entry's own
    // rendered text to, so it goes to stdout instead, same as no --out.
    const outIsDir = values.out && existsSync(values.out) && statSync(values.out).isDirectory();
    if (values.out && !outIsDir) {
      try {
        writeFileSync(values.out, output);
      } catch (err) {
        throw new Error(`cannot write --out: ${err.message}`);
      }
    } else {
      process.stdout.write(output);
    }
  }

  if (!values.watch) {
    try {
      emitOutput(await generateOutput());
    } catch (err) {
      fail(err.message);
    }
  } else {
    // --- watch mode: re-render on change, survive render errors.
    // Status/errors go to stderr throughout (unchanged from before) since
    // stdout is the actual rendered output when there's no -o.

    let timer = null;
    let running = false;
    let dirty = false;
    let first = true;
    let pendingChanges = new Set(); // watched paths changed since the last render attempt

    const report = (msg, { error = false } = {}) => {
      const line = `${timestamp()} ${mdyTag()} ${msg}`;
      process.stderr.write((error ? red(line) : line) + '\n');
    };

    /** vite-style "watching" banner, printed once before the first render. */
    const readyBanner = (target) =>
      ['', `  ${bold(magenta('MDY'))}  ${dim('watching')} ${bold(target)}`, `  ${green('➜')}  ${dim('press ctrl+c to stop')}`, ''].join('\n');

    const rerender = async () => {
      if (running) {
        dirty = true; // a change arrived mid-render; run again after
        return;
      }
      running = true;
      const changed = [...pendingChanges];
      pendingChanges = new Set();
      const started = Date.now();
      try {
        if (!first) for (const path of changed) report(`${tagChange()} ${path}`);
        emitOutput(await generateOutput());
        if (!first) report(`rendered in ${Date.now() - started} ms`);
      } catch (err) {
        report(err.message ?? err, { error: true });
      }
      first = false;
      running = false;
      if (dirty) {
        dirty = false;
        rerender();
      }
    };

    // Editors fire several events per save; debounce them into one render.
    const schedule = (changedPath) => {
      if (changedPath) pendingChanges.add(changedPath);
      clearTimeout(timer);
      timer = setTimeout(rerender, 100);
    };

    if (inputKind === 'dir') {
      // One recursive watch on the whole directory: any file under it can
      // affect the render (the entry's $.find reaches all of them).
      await fs.watch(inputAbs, ({ path }) => schedule(path));
      if (values['data-file']) {
        await fs.watch(resolve(dirname(values['data-file'])), ({ path }) => {
          if (path === basename(values['data-file'])) schedule(values['data-file']);
        });
      }
      process.stderr.write(readyBanner(inputAbs) + '\n');
    } else {
      // A single file (+ optional --data-file): editors save atomically
      // (write temp + rename), which kills a watcher attached to the file
      // itself — so watch each containing directory and filter by filename.
      const watched = [inputAbs, ...(values['data-file'] ? [resolve(values['data-file'])] : [])];
      const byDir = new Map();
      for (const p of watched) {
        const dir = dirname(p);
        if (!byDir.has(dir)) byDir.set(dir, new Set());
        byDir.get(dir).add(basename(p));
      }
      for (const [dir, names] of byDir) {
        await fs.watch(dir, ({ path }) => {
          if (names.has(path)) schedule(join(dir, path));
        });
      }
      process.stderr.write(readyBanner(`${watched.length} file(s)`) + '\n');
    }

    await rerender();
  }
}
