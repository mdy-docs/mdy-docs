/*
 * The tables written into the C by hand, each against the JavaScript it was
 * copied from. `make check-generated` runs this beside the generated headers.
 *
 *   node scripts/check-tables.mjs <path to mdy-docs>
 *
 * A generator would be the stronger answer, but each of these is a short
 * list inside a C function rather than a header of its own, and a comparison
 * is what keeps a copy honest: a list that drifts goes red here.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const docs = process.argv[2] ?? join(pkg, '..', '..');
const read = (p) => readFileSync(p, 'utf8');
const strings = (text) => [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
const between = (text, open, close) => {
  const start = text.indexOf(open);
  if (start < 0) throw new Error(`cannot find ${JSON.stringify(open)}`);
  return text.slice(start + open.length, text.indexOf(close, start + open.length));
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

let failed = 0;
const report = (what, c, js) => {
  if (same(c, js)) { console.log(`  ${what.padEnd(22)} in sync`); return; }
  const only = (x, y) => [...x].filter((v) => ![...y].includes(v));
  console.log(`  ${what.padEnd(22)} DIFFERS: C has [${only(c, js)}] the JavaScript lacks; the JavaScript has [${only(js, c)}] the C lacks`);
  failed = 1;
};

/* STOPWORDS: src/search.js's Set, in engine.c's $.tokenize */
report('STOPWORDS',
  strings(between(read(join(pkg, 'src', 'engine.c')), 'STOPWORDS[] = {', '};')),
  [...between(read(join(docs, 'src', 'search.js')), 'const STOPWORDS = new Set([', '])').matchAll(/'([^']+)'/g)].map((m) => m[1]));

/* VOID: the html-void-elements package block.js reads */
const require = createRequire(join(docs, 'package.json'));
report('void elements',
  strings(between(read(join(pkg, 'src', 'parse', 'ast.c')), 'VOID[] = {', '};')),
  require('html-void-elements').htmlVoidElements);

/* image extensions: vault.js's IMAGE_EXTENSIONS, in the walk */
report('image extensions',
  strings(between(read(join(pkg, 'src', 'engine_walk.c')), 'EXTS[] = {', '};')),
  [...between(read(join(docs, 'src', 'vault.js')), 'const IMAGE_EXTENSIONS = new Set([', '])').matchAll(/'([^']+)'/g)].map((m) => m[1]));

/* MIME: serve.js's table, in the dev server */
const cMime = [...between(read(join(pkg, 'src', 'cli.c')), 'TYPES[] = {', '};').matchAll(/\{ "([^"]+)", "([^"]+)" \}/g)].map((m) => `${m[1]}=${m[2]}`);
const jsMime = [...between(read(join(docs, 'src', 'serve.js')), 'const MIME = {', '};').matchAll(/'([^']+)': '([^']+)'/g)].map((m) => `${m[1]}=${m[2]}`);
report('MIME types', cMime, jsMime);

/* BLOCK: compose.js's `block` Set, in the token splicer */
report('block tags',
  strings(between(read(join(pkg, 'src', 'engine_compose.c')), 'BLOCK[] = {', '};')),
  [...between(read(join(docs, 'src', 'compose.js')), "const block = new Set([", '])').matchAll(/'([^']+)'/g)].map((m) => m[1]));

process.exit(failed);
