/*
 * The markdown front end, held against mdy-docs'.
 *
 * mdy-docs turns `.md` into hast with
 *
 *     remarkParse → remarkGfm → remarkAlert → remarkRehype → rehypeRaw
 *
 * and stops at the tree. So this compares TREES, not HTML: what a `.md`
 * document becomes is a hast tree that everything downstream — composition,
 * `transform`, the TOC — then works on, and two pipelines agreeing on HTML
 * while disagreeing on the tree would be a difference nobody saw until a
 * transform ran.
 *
 * Run it before writing any C. With no C tool present it reports the
 * REFERENCE side alone — how much of the corpus remark reads, and what it
 * costs — which is the baseline any port is measured against. Point `--tool`
 * at a binary that reads markdown on stdin and writes the same canonical JSON
 * on stdout, and it compares.
 *
 *   node test/compare-markdown.mjs --mdy-docs <path> [--tool <binary>] [--first]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = join(here, '..', 'build', 'corpus');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);
const baselineFile = flag('baseline');
const writeBaseline = flag('write-baseline');

const mdyDocs = flag('mdy-docs');
const tool = flag('tool');
if (!mdyDocs) {
  console.error('usage: compare-markdown.mjs --mdy-docs <path> [--tool <binary>]');
  process.exit(2);
}
if (!existsSync(corpus)) {
  console.error('compare-markdown: no corpus — run `make corpus` first');
  process.exit(2);
}

const { markdownToHast } = await import(join(mdyDocs, 'src/markdown.js'));

/*
 * The tree, reduced to what both sides could agree on. Positions are left out
 * deliberately: remark's are mdast's, carried through remark-rehype, and a C
 * front end would have md4c's own offsets. Getting the SHAPE right comes
 * first, and a position comparison is a later and separate question.
 */
function canon(node) {
  if (node.type === 'text') return { type: 'text', value: node.value };
  if (node.type === 'comment') return { type: 'comment', value: node.value };
  if (node.type === 'doctype') return { type: 'doctype' };
  if (node.type === 'raw') return { type: 'raw', value: node.value };
  if (node.type === 'root') return { type: 'root', children: (node.children ?? []).map(canon) };
  /*
   * INSERTION ORDER, not sorted. hast keeps properties in the order they were
   * set and the HTML writer writes them in that order, so sorting one side
   * and not the other invents differences — which is what the first version
   * of this did, reporting every task list as wrong when the two agreed.
   */
  const props = {};
  for (const key of Object.keys(node.properties ?? {})) {
    const v = node.properties[key];
    if (v === undefined || v === null || v === false) continue;
    props[key] = v;
  }
  return {
    type: 'element',
    tagName: node.tagName,
    properties: props,
    children: (node.children ?? []).map(canon),
  };
}

const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md')) files.push(p);
  }
};
walk(corpus);
files.sort();

const groups = {};
const differing = [];
let bytes = 0;
let nodes = 0;
let failed = 0;
let same = 0;
let shown = 0;
const started = Date.now();

for (const file of files) {
  const group = file.slice(corpus.length + 1).split('/')[0];
  groups[group] ??= { total: 0, same: 0, refFailed: 0 };
  groups[group].total += 1;

  const text = readFileSync(file, 'utf8');
  bytes += text.length;

  let expected;
  try {
    const tree = markdownToHast(text);
    let count = 0;
    (function walkTree(n) { count += 1; for (const c of n.children ?? []) walkTree(c); })(tree);
    nodes += count;
    expected = JSON.stringify(canon(tree));
  } catch (error) {
    groups[group].refFailed += 1;
    failed += 1;
    continue;
  }

  if (!tool) continue;

  let got;
  try {
    got = execFileSync(tool, [], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
  } catch (error) {
    got = `ERROR: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`;
  }
  if (got === expected) { same += 1; groups[group].same += 1; continue; }
  differing.push(file.slice(corpus.length + 1));

  if (has('first') && shown < 3) {
    shown += 1;
    const n = Math.min(got.length, expected.length);
    let i = 0;
    while (i < n && got[i] === expected[i]) i++;
    console.log(`\n${file.slice(corpus.length + 1)}, first difference at byte ${i}:`);
    console.log(`   C: …${got.slice(Math.max(0, i - 60), i + 100)}`);
    console.log(`  JS: …${expected.slice(Math.max(0, i - 60), i + 100)}`);
  }
}

const ms = Date.now() - started;
console.log(`\ncorpus: ${files.length} documents, ${(bytes / 1024).toFixed(0)} KB`);
console.log(`reference: ${nodes} hast nodes in ${ms} ms${failed ? `, ${failed} that remark itself refused` : ''}`);

if (!tool) {
  console.log('\nno --tool given: the reference side only. This is the baseline.');
  for (const [g, s] of Object.entries(groups).sort()) {
    console.log(`  ${g.padEnd(26)} ${String(s.total).padStart(5)}`);
  }
  process.exit(0);
}

const pct = ((same / files.length) * 100).toFixed(1);
console.log(`\n${same}/${files.length} trees identical (${pct}%)`);
for (const [g, s] of Object.entries(groups).sort()) {
  console.log(`  ${g.padEnd(26)} ${String(s.same).padStart(5)}/${String(s.total).padEnd(5)}`);
}

/*
 * THE BASELINE, which is what lets a check with known failures run in CI.
 *
 * Every `.md` finding this year was measured here and reported to nobody,
 * because the corpus needed a network and this exited non-zero whatever it
 * found — a check that cannot pass is a check nobody runs. It passes now when
 * the set of differing documents is EXACTLY the set written down, so a
 * document that starts differing fails the build and a document that starts
 * agreeing fails it too, until somebody says so on purpose.
 *
 * `real/` is left out of it. Those documents are whatever markdown is on the
 * machine, so the set is not the same twice and not the same anywhere else;
 * they are reported above and gated by nothing.
 */
const gated = differing.filter((f) => !f.startsWith('real/')).sort();

if (writeBaseline) {
  const header = [
    '# Documents whose tree does not match mdy-docs\' JavaScript.',
    '#',
    '# Written by `make corpus-baseline`, read by `make check-markdown`. Every',
    '# line is a document the C front end gets wrong and that somebody has',
    '# looked at; a line LEAVING this file is as much a reason to stop as a',
    '# line arriving, because it means a fix landed that nobody wrote down.',
    '#',
    '# `real/` is not here: that group is whatever markdown is on the machine.',
    '#',
  ];
  const counts = {};
  for (const f of gated) counts[f.split('/')[0]] = (counts[f.split('/')[0]] ?? 0) + 1;
  for (const [g, n] of Object.entries(counts).sort()) header.push(`#   ${g.padEnd(26)} ${n}`);
  writeFileSync(writeBaseline, header.join('\n') + '\n' + gated.join('\n') + '\n');
  console.log(`\nwrote ${gated.length} documents to ${writeBaseline}`);
  process.exit(0);
}

if (!baselineFile) process.exit(same === files.length ? 0 : 1);

if (!existsSync(baselineFile)) {
  console.error(`\ncompare-markdown: no baseline at ${baselineFile} — run \`make corpus-baseline\``);
  process.exit(2);
}
const expected = new Set(
  readFileSync(baselineFile, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));

const now = new Set(gated);
const appeared = [...now].filter((f) => !expected.has(f)).sort();
const gone = [...expected].filter((f) => !now.has(f)).sort();
const present = new Set(files.map((f) => f.slice(corpus.length + 1).split('/')[0]));
const absent = [...expected].filter((f) => !present.has(f.split('/')[0]));

if (absent.length) {
  console.log(`\n${absent.length} baselined document(s) are not in this corpus — ` +
              'build it with the spec groups before believing the result');
  process.exit(2);
}

if (appeared.length === 0 && gone.length === 0) {
  console.log(`\nas the baseline says: ${gated.length} known different, nothing new`);
  process.exit(0);
}
if (appeared.length) {
  console.log(`\n${appeared.length} document(s) that USED to match and no longer do:`);
  for (const f of appeared.slice(0, 20)) console.log(`  ${f}`);
  if (appeared.length > 20) console.log(`  … and ${appeared.length - 20} more`);
}
if (gone.length) {
  console.log(`\n${gone.length} document(s) in the baseline that now MATCH — ` +
              'that is a fix, and the baseline has to say so:');
  for (const f of gone.slice(0, 20)) console.log(`  ${f}`);
  if (gone.length > 20) console.log(`  … and ${gone.length - 20} more`);
  console.log('\n  make corpus-baseline');
}
process.exit(1);
