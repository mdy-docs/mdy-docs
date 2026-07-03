#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { render, renderToMarkdown } from '../index.js';

const USAGE = `mdy — generate a document from an mdy template.

Usage:
  mdy [input] [options]

Arguments:
  input                 Path to an .mdy template. Reads stdin if omitted or "-".

Options:
  -o, --out <file>      Write output to <file> (default: stdout).
      --html            Emit HTML instead of generated markdown.
      --doc <index>     Render document <index> from a multi-document file
                        (0-based; default 0, the entry document).
  -d, --data <k=v>      Add a context value (repeatable). Value is parsed as
                        JSON when possible, otherwise treated as a string.
      --data-file <f>   Merge a YAML/JSON file into the context.
  -h, --help            Show this help.

Extra context (from --data / --data-file) overrides \`\`\`data fences in the doc.

Examples:
  mdy report.mdy
  mdy report.mdy --html -o report.html
  mdy report.mdy -d env=prod -d 'build=42' --data-file overrides.yaml
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

if (positionals.length > 1) fail('expected at most one input file');

// Which document to render from a multi-document file.
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

// Read input.
const inputPath = positionals[0];
const fromFile = inputPath && inputPath !== '-';

if (fromFile && extname(inputPath).toLowerCase() !== '.mdy') {
  process.stderr.write(`mdy: warning: input "${inputPath}" does not have a .mdy extension\n`);
}

let source;
try {
  source = fromFile
    ? readFileSync(inputPath, 'utf8')
    : readFileSync(0, 'utf8'); // fd 0 = stdin
} catch (err) {
  fail(`cannot read input: ${err.message}`);
}

// Process.
let output;
try {
  output = values.html
    ? render(source, context, entry)
    : renderToMarkdown(source, context, entry);
} catch (err) {
  fail(err.message);
}
if (!output.endsWith('\n')) output += '\n';

// Write to --out when given, otherwise stdout.
if (values.out) {
  if (fromFile && resolve(values.out) === resolve(inputPath)) {
    fail('refusing to overwrite the input file');
  }
  try {
    writeFileSync(values.out, output);
  } catch (err) {
    fail(`cannot write --out: ${err.message}`);
  }
} else {
  process.stdout.write(output);
}
