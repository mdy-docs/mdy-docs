#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { render, renderToMarkdown, renderEach, parseDocuments, compileTemplateSource, createProcessor } from '../index.js';

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
  -h, --help            Show this help.

Extra context (from --data / --data-file) overrides the document's front matter.

Examples:
  mdy report.mdy
  mdy report.mdy --html -o report.html
  mdy report.mdy -d env=prod -d 'build=42' --data-file overrides.yaml
  mdy invoice.mdy invoice-data.mdy --each   # template × each data document
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

// Assemble extra context: --data-file first, then --data overrides.
const context = {};

if (values['data-file']) {
  let fileText;
  try {
    fileText = readFileSync(values['data-file'], 'utf8');
  } catch (err) {
    fail(`cannot read --data-file: ${err.message}`);
  }
  const loaded = loadYaml(fileText);
  if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
    Object.assign(context, loaded);
  } else {
    fail('--data-file must contain a YAML/JSON mapping');
  }
}

for (const pair of values.data) {
  const eq = pair.indexOf('=');
  if (eq === -1) fail(`--data expects key=value, got "${pair}"`);
  const key = pair.slice(0, eq);
  const raw = pair.slice(eq + 1);
  let value;
  try {
    value = JSON.parse(raw); // numbers, booleans, null, arrays, objects, "quoted"
  } catch {
    value = raw; // bare string
  }
  context[key] = value;
}

// Read inputs. Multiple files (or stdin via "-") form one document set.
const inputPaths = positionals.length > 0 ? positionals : ['-'];
const filePaths = inputPaths.filter((p) => p !== '-');
if (inputPaths.filter((p) => p === '-').length > 1) fail('stdin ("-") given more than once');

for (const p of filePaths) {
  if (extname(p).toLowerCase() !== '.mdy') {
    process.stderr.write(`mdy: warning: input "${p}" does not have a .mdy extension\n`);
  }
}

let sources;
try {
  sources = inputPaths.map((p) =>
    p === '-' ? readFileSync(0, 'utf8') : readFileSync(p, 'utf8') // fd 0 = stdin
  );
} catch (err) {
  fail(`cannot read input: ${err.message}`);
}

// Process.
let output;
try {
  if (values['emit-js']) {
    if (values.html) fail('--emit-js cannot be combined with --html');
    const docs = parseDocuments(sources);
    // All documents by default; just the selected one when --doc is given.
    const indices = values.doc !== undefined ? [entry] : docs.map((_, i) => i);
    output = indices
      .map((i) => {
        if (!docs[i]) fail(`no document at index ${i}`);
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
} catch (err) {
  fail(err.message);
}
if (!output.endsWith('\n')) output += '\n';

// Write to --out when given, otherwise stdout.
if (values.out) {
  if (filePaths.some((p) => resolve(values.out) === resolve(p))) {
    fail('refusing to overwrite an input file');
  }
  try {
    writeFileSync(values.out, output);
  } catch (err) {
    fail(`cannot write --out: ${err.message}`);
  }
} else {
  process.stdout.write(output);
}
