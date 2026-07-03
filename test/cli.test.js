import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
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

// --- stdin → stdout -------------------------------------------------------

test('reads stdin with "-" and writes stdout', () => {
  const { status, stdout } = run(['-'], 'Hello {{= 1 + 1 }}');
  assert.equal(status, 0);
  assert.equal(stdout.trim(), 'Hello 2');
});

test('--html emits HTML on stdout from stdin', () => {
  const { stdout } = run(['-', '--html'], '# Hi {{= 2 * 3 }}');
  assert.match(stdout, /<h1>Hi 6<\/h1>/);
});

test('-d supplies context; JSON values parse, bare stays a string', () => {
  const { stdout } = run(['-', '-d', 'n=3', '-d', 'name=ada'], '{{= name }}×{{= n }}={{= name.repeat(n) }}');
  assert.equal(stdout.trim(), 'ada×3=adaadaada');
});

test('-d overrides a ```data fence', () => {
  const { stdout } = run(['-', '-d', 'who=world'], '```data\nwho: nobody\n```\nhi {{= who }}');
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
  assert.match(stderr, /refusing to overwrite the input/);
});

test('--doc selects a document from a multi-document file', () => {
  const src = 'entry doc\n---\nsecond {{= 1 + 1 }}';
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

test('missing input file exits non-zero with a message', () => {
  const { status, stderr } = run(['does-not-exist.mdy']);
  assert.equal(status, 1);
  assert.match(stderr, /cannot read input/);
});

test('--help prints usage', () => {
  const { stdout } = run(['--help']);
  assert.match(stdout, /Usage:\s+mdy \[input\]/);
});
