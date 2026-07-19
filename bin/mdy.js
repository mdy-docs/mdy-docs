#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import {
  render,
  renderToMarkdown,
  renderEach,
  parseDocuments,
  compileTemplateSource,
  createProcessor,
  nodeFsProvider,
} from '../index.js';

// Reading/watching input files goes through nodeFsProvider (this package's
// own vault layer) rather than calling node:fs directly — this CLI is a
// real consumer of the same primitive any embedder gets, not a second,
// hand-rolled implementation of "read a file, watch a directory" living
// next to it. (writeFileSync for --out, and readFileSync(0) for stdin,
// stay direct: neither is "getting a file into the document set", which
// is what the vault layer is for.)
const fs = nodeFsProvider();

const USAGE = `mdy — generate a document from an mdy template.

Usage:
  mdy [input...] [options]

Arguments:
  input                 Paths to .mdy files. Reads stdin if omitted or "-".
                        Multiple files form ONE document set, in order — e.g. a
                        template file followed by data files; every document is
                        addressable via $ and --doc as if in a single file.

Options:
  -o, --out <file>      Write output to <file> (default: stdout).
      --html            Emit HTML instead of generated markdown.
      --each            Apply the entry document's template once per other
                        document in the set, using that document's data
                        (the entry's own front matter acts as defaults).
      --emit-js         Emit the compiled JavaScript of each document instead
                        of rendering (debug; combine with --doc for one).
      --doc <index>     Render document <index> from the document set
                        (0-based; default 0, the entry document).
  -d, --data <k=v>      Add a context value (repeatable). Value is parsed as
                        JSON when possible, otherwise treated as a string.
      --data-file <f>   Merge a YAML/JSON file into the context.
  -w, --watch           Keep running and re-render whenever an input file (or
                        the --data-file) changes. A failing render reports to
                        stderr and keeps watching. Not available with stdin.
  -h, --help            Show this help.

Extra context (from --data / --data-file) overrides the document's front matter.

Examples:
  mdy report.mdy
  mdy report.mdy --html -o report.html
  mdy report.mdy -d env=prod -d 'build=42' --data-file overrides.yaml
  mdy invoice.mdy invoice-data.mdy --each   # template × each data document
  mdy report.mdy -o report.md --watch       # live re-render on save
  cat report.mdy | mdy - --html`;

function fail(msg) {
  // Library errors are already prefixed with "mdy:"; don't double it.
  const text = String(msg).replace(/^mdy:\s*/, '');
  process.stderr.write(`mdy: ${text}\n`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      html: { type: 'boolean', default: false },
      each: { type: 'boolean', default: false },
      'emit-js': { type: 'boolean', default: false },
      doc: { type: 'string' },
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

// Which document to render from the document set.
let entry = 0;
if (values.doc !== undefined) {
  entry = Number(values.doc);
  if (!Number.isInteger(entry) || entry < 0) {
    fail(`--doc expects a non-negative integer, got "${values.doc}"`);
  }
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

// Inputs. Multiple files (or stdin via "-") form one document set.
const inputPaths = positionals.length > 0 ? positionals : ['-'];
const filePaths = inputPaths.filter((p) => p !== '-');
if (inputPaths.filter((p) => p === '-').length > 1) fail('stdin ("-") given more than once');
if (values.watch && filePaths.length < inputPaths.length) fail('--watch cannot read from stdin');
if (values['emit-js'] && values.html) fail('--emit-js cannot be combined with --html');
if (values.out && filePaths.some((p) => resolve(values.out) === resolve(p))) {
  fail('refusing to overwrite an input file');
}

for (const p of filePaths) {
  if (extname(p).toLowerCase() !== '.mdy') {
    process.stderr.write(`mdy: warning: input "${p}" does not have a .mdy extension\n`);
  }
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

async function readSources() {
  try {
    return await Promise.all(
      inputPaths.map((p) =>
        p === '-' ? readFileSync(0, 'utf8') : fs.read(dirname(p), basename(p)) // fd 0 = stdin
      )
    );
  } catch (err) {
    throw new Error(`cannot read input: ${err.message}`);
  }
}

async function generateOutput() {
  const sources = await readSources();
  const context = await loadContext();
  let output;
  if (values['emit-js']) {
    const docs = parseDocuments(sources);
    // All documents by default; just the selected one when --doc is given.
    const indices = values.doc !== undefined ? [entry] : docs.map((_, i) => i);
    output = indices
      .map((i) => {
        if (!docs[i]) throw new Error(`no document at index ${i}`);
        return `// document ${i}\nfunction __doc${i}(__ctx) {\n${compileTemplateSource(docs[i].content)}\nreturn __out;\n}`;
      })
      .join('\n\n');
  } else if (values.each) {
    // One render of the entry template per data document; the generated
    // markdown is final, so --html goes straight through markdown-it.
    const joined = (await renderEach(sources, context, entry)).join('\n\n');
    output = values.html ? createProcessor().md.render(joined) : joined;
  } else {
    output = values.html
      ? await render(sources, context, entry)
      : await renderToMarkdown(sources, context, entry);
  }
  return output.endsWith('\n') ? output : output + '\n';
}

function emitOutput(output) {
  if (values.out) {
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

  // Editors save atomically (write temp + rename), which kills a watcher
  // attached to the file itself — so watch each containing directory
  // (nodeFsProvider's watch(), recursive — subdirectory events just never
  // match a tracked filename below, no different from before) and filter
  // events by filename.
  const watched = [...filePaths, ...(values['data-file'] ? [values['data-file']] : [])];
  const byDir = new Map();
  for (const p of watched) {
    const dir = resolve(dirname(p));
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir).add(basename(p));
  }

  let timer = null;
  let running = false;
  let dirty = false;

  const report = (msg) => {
    process.stderr.write(`mdy: ${String(msg).replace(/^mdy:\s*/, '')}\n`);
  };

  const rerender = async () => {
    if (running) {
      dirty = true; // a change arrived mid-render; run again after
      return;
    }
    running = true;
    const started = Date.now();
    try {
      emitOutput(await generateOutput());
      report(`rendered in ${Date.now() - started} ms (${new Date().toLocaleTimeString()})`);
    } catch (err) {
      report(err.message ?? err);
    }
    running = false;
    if (dirty) {
      dirty = false;
      rerender();
    }
  };

  // Editors fire several events per save; debounce them into one render.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(rerender, 100);
  };

  for (const [dir, names] of byDir) {
    await fs.watch(dir, ({ path }) => {
      if (names.has(path)) schedule();
    });
  }

  report(`watching ${watched.length} file(s) — Ctrl-C to stop`);
  await rerender();
}
