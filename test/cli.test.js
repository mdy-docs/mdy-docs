import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'mdy.js');
const example = (name) => join(here, '..', 'examples', name);
const workdir = () => mkdtempSync(join(tmpdir(), 'mdy-'));

// Run the CLI without throwing. Returns { status, stdout, stderr }.
const run = (args, input) =>
  spawnSync('node', [bin, ...args], { input, encoding: 'utf8' });

// Poll until `cond()` is true (up to `ms`), else throw.
const waitFor = async (cond, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
};

// --- stdin → stdout -------------------------------------------------------

test('reads stdin with "-" and writes stdout', () => {
  const { status, stdout } = run(['-'], 'Hello {{ 1 + 1 }}');
  assert.equal(status, 0);
  assert.equal(stdout.trim(), 'Hello 2');
});

test('--html emits HTML on stdout from stdin', () => {
  const { stdout } = run(['-', '--html'], '# Hi {{ 2 * 3 }}');
  assert.match(stdout, /<h1>Hi 6<\/h1>/);
});

test('-d supplies context; JSON values parse, bare stays a string', () => {
  const { stdout } = run(['-', '-d', 'n=3', '-d', 'name=ada'], '{{ name }}×{{ n }}={{ name.repeat(n) }}');
  assert.equal(stdout.trim(), 'ada×3=adaadaada');
});

test('-d overrides front matter data', () => {
  const { stdout } = run(['-', '-d', 'who=world'], 'who: nobody\n+++\nhi {{ who }}');
  assert.equal(stdout.trim(), 'hi world');
});

// --- file input → stdout by default ---------------------------------------

test('a .mdy file renders to stdout by default (no file written)', () => {
  const dir = workdir();
  const src = join(dir, 'roster.mdy');
  copyFileSync(example('roster.mdy'), src);

  const { status, stdout } = run([src]);
  assert.equal(status, 0);
  assert.match(stdout, /# Team Roster/);
  assert.match(stdout, /- \*\*Ada Lovelace\*\* \(36\) — team lead/);
  assert.ok(!existsSync(join(dir, 'roster.md')), 'should not write a file without -o');
});

test('-o writes output to a file', () => {
  const dir = workdir();
  const src = join(dir, 'roster.mdy');
  const out = join(dir, 'out.md');
  copyFileSync(example('roster.mdy'), src);

  const { status } = run([src, '-o', out]);
  assert.equal(status, 0);
  assert.match(readFileSync(out, 'utf8'), /# Team Roster/);
});

test('-o --html writes HTML to a file', () => {
  const dir = workdir();
  const src = join(dir, 'shared-scope.mdy');
  const out = join(dir, 'out.html');
  copyFileSync(example('shared-scope.mdy'), src);

  const { status } = run([src, '--html', '-o', out]);
  assert.equal(status, 0);
  assert.match(readFileSync(out, 'utf8'), /<h1>Fibonacci<\/h1>/);
});

// --- warnings & guards ----------------------------------------------------

test('warns on non-.mdy input but still processes', () => {
  const dir = workdir();
  const src = join(dir, 'note.txt');
  copyFileSync(example('roster.mdy'), src);

  const { status, stdout, stderr } = run([src]);
  assert.equal(status, 0);
  assert.match(stderr, /does not have a \.mdy extension/);
  assert.match(stdout, /# Team Roster/);
});

test('-o refuses to overwrite the input file', () => {
  const dir = workdir();
  const src = join(dir, 'thing.mdy');
  copyFileSync(example('roster.mdy'), src);

  const { status, stderr } = run([src, '-o', src]);
  assert.equal(status, 1);
  assert.match(stderr, /refusing to overwrite an input/);
});

test('-o refuses to overwrite any of several input files', () => {
  const dir = workdir();
  const tpl = join(dir, 'invoice.mdy');
  const data = join(dir, 'invoice-data.mdy');
  copyFileSync(example('invoice.mdy'), tpl);
  copyFileSync(example('invoice-data.mdy'), data);

  const { status, stderr } = run([tpl, data, '-o', data]);
  assert.equal(status, 1);
  assert.match(stderr, /refusing to overwrite an input/);
});

test('--doc selects a document from a multi-document file', () => {
  const src = 'entry doc\n---\nx: 1\n+++\nsecond {{ x + 1 }}';
  assert.equal(run(['-'], src).stdout.trim(), 'entry doc');
  assert.equal(run(['-', '--doc', '1'], src).stdout.trim(), 'second 2');
});

test('--doc out of range fails with a single mdy: prefix', () => {
  const { status, stderr } = run(['-', '--doc', '5'], 'only one');
  assert.equal(status, 1);
  assert.match(stderr, /no document at index 5/);
  assert.doesNotMatch(stderr, /mdy: mdy:/);
});

test('--doc rejects a non-integer', () => {
  const { status, stderr } = run(['-', '--doc', 'abc'], 'x');
  assert.equal(status, 1);
  assert.match(stderr, /--doc expects a non-negative integer/);
});

test('--emit-js prints the compiled function of every document', () => {
  const src = 'hi {{ x }}\n---\ny: 2\n+++\n{% let z = 1 %}z is {{ z }}';
  const { status, stdout } = run(['-', '--emit-js'], src);
  assert.equal(status, 0);
  assert.match(stdout, /function __doc0\(__ctx\)/);
  assert.match(stdout, /function __doc1\(__ctx\)/);
  assert.match(stdout, /__out \+= \(x\)/);
  assert.match(stdout, /let z = 1/);
});

test('--emit-js --doc selects a single document', () => {
  const src = 'hi {{ x }}\n---\ny: 2\n+++\nsecond {{ y }}';
  const { stdout } = run(['-', '--emit-js', '--doc', '1'], src);
  assert.match(stdout, /function __doc1\(__ctx\)/);
  assert.doesNotMatch(stdout, /function __doc0/);
});

test('--emit-js rejects --html', () => {
  const { status, stderr } = run(['-', '--emit-js', '--html'], 'x');
  assert.equal(status, 1);
  assert.match(stderr, /--emit-js cannot be combined with --html/);
});

test('missing input file exits non-zero with a message', () => {
  const { status, stderr } = run(['does-not-exist.mdy']);
  assert.equal(status, 1);
  assert.match(stderr, /cannot read input/);
});

test('--help prints usage', () => {
  const { stdout } = run(['--help']);
  assert.match(stdout, /Usage:\s+mdy \[input\.\.\.\]/);
});

// --- multiple inputs & --each ---------------------------------------------

test('multiple input files form one document set', () => {
  const dir = workdir();
  const tpl = join(dir, 'tpl.mdy');
  const data = join(dir, 'data.mdy');
  copyFileSync(example('invoice.mdy'), tpl);
  copyFileSync(example('invoice-data.mdy'), data);

  // Document 1 of the combined set is the first record of the data file.
  const { status, stdout } = run([tpl, data, '--doc', '1', '--emit-js']);
  assert.equal(status, 0);
  assert.match(stdout, /function __doc1\(__ctx\)/);
});

test('--each applies the template file to each data document', () => {
  const dir = workdir();
  const tpl = join(dir, 'invoice.mdy');
  const data = join(dir, 'invoice-data.mdy');
  copyFileSync(example('invoice.mdy'), tpl);
  copyFileSync(example('invoice-data.mdy'), data);

  const { status, stdout } = run([tpl, data, '--each']);
  assert.equal(status, 0);
  assert.match(stdout, /Invoice #57/);
  assert.match(stdout, /Order total: \$40\.25/);
  assert.match(stdout, /Invoice #58/);
  assert.match(stdout, /Order total: \$20\.99/);
  assert.doesNotMatch(stdout, /Invoice #42/); // the template's own sample data is not rendered
});

test('--each with -d overrides every record', () => {
  const src = 'Hello {{ name }} ({{ env }})\n---\nname: Ada\n+++\n---\nname: Bob\n+++\n';
  const { stdout } = run(['-', '--each', '-d', 'env=prod'], src);
  assert.equal(stdout.trim(), 'Hello Ada (prod)\n\nHello Bob (prod)');
});

test('--each --html renders each record to HTML', () => {
  const dir = workdir();
  const tpl = join(dir, 'invoice.mdy');
  const data = join(dir, 'invoice-data.mdy');
  copyFileSync(example('invoice.mdy'), tpl);
  copyFileSync(example('invoice-data.mdy'), data);

  const { status, stdout } = run([tpl, data, '--each', '--html']);
  assert.equal(status, 0);
  assert.match(stdout, /<h1>Invoice #57<\/h1>/);
  assert.match(stdout, /<h1>Invoice #58<\/h1>/);
});

test('stdin ("-") can be one of several inputs', () => {
  const dir = workdir();
  const data = join(dir, 'invoice-data.mdy');
  copyFileSync(example('invoice-data.mdy'), data);

  const { status, stdout } = run(['-', data, '--each'], 'Owner: {{ report.owner }}');
  assert.equal(status, 0);
  assert.equal(stdout.trim(), 'Owner: Ada Lovelace\n\nOwner: Alan Turing');
});

test('stdin given more than once fails', () => {
  const { status, stderr } = run(['-', '-'], 'x');
  assert.equal(status, 1);
  assert.match(stderr, /stdin \("-"\) given more than once/);
});

// --- watch mode -----------------------------------------------------------

test('--watch re-renders when an input file changes', async () => {
  const dir = workdir();
  const src = join(dir, 'doc.mdy');
  const out = join(dir, 'out.md');
  writeFileSync(src, 'hello {{ 1 + 1 }}\n');

  const child = spawn('node', [bin, src, '-o', out, '--watch']);
  try {
    await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').includes('hello 2'));
    writeFileSync(src, 'changed {{ 2 + 2 }}\n');
    await waitFor(() => readFileSync(out, 'utf8').includes('changed 4'));
  } finally {
    child.kill();
  }
});

test('--watch survives a render error and recovers on the next save', async () => {
  const dir = workdir();
  const src = join(dir, 'doc.mdy');
  const out = join(dir, 'out.md');
  writeFileSync(src, 'ok {{ 1 + 1 }}\n');

  const child = spawn('node', [bin, src, '-o', out, '--watch']);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').includes('ok 2'));
    writeFileSync(src, 'broken {{ unclosed\n');
    await waitFor(() => /unclosed/.test(stderr));
    assert.equal(readFileSync(out, 'utf8').includes('ok 2'), true); // old output intact
    writeFileSync(src, 'fixed {{ 3 + 3 }}\n');
    await waitFor(() => readFileSync(out, 'utf8').includes('fixed 6'));
  } finally {
    child.kill();
  }
});

test('--watch re-renders when the --data-file changes', async () => {
  const dir = workdir();
  const src = join(dir, 'doc.mdy');
  const data = join(dir, 'ctx.yaml');
  const out = join(dir, 'out.md');
  writeFileSync(src, 'env is {{ env }}\n');
  writeFileSync(data, 'env: dev\n');

  const child = spawn('node', [bin, src, '--data-file', data, '-o', out, '--watch']);
  try {
    await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').includes('env is dev'));
    writeFileSync(data, 'env: prod\n');
    await waitFor(() => readFileSync(out, 'utf8').includes('env is prod'));
  } finally {
    child.kill();
  }
});

test('--watch rejects stdin input', () => {
  const { status, stderr } = run(['-', '--watch'], 'x');
  assert.equal(status, 1);
  assert.match(stderr, /--watch cannot read from stdin/);
});
