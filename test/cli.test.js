import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'mdy.js');
const example = (name) => join(here, '..', 'examples', name);
const exampleBlog = join(here, '..', 'examples', 'blog');
const exampleBlogStyleX = join(here, '..', 'examples', 'blog-style-x');
const workdir = () => mkdtempSync(join(tmpdir(), 'mdy-'));
// blog/main.mdy imports "../blog-style-x" — copy it as a real sibling,
// not just blog itself, so a copied fixture resolves the same way the real
// examples/ directory does.
const site = () => {
  const parent = workdir();
  const dir = join(parent, 'blog');
  cpSync(exampleBlog, dir, { recursive: true });
  cpSync(exampleBlogStyleX, join(parent, 'blog-style-x'), { recursive: true });
  return dir;
};

// Run the CLI without throwing. Returns { status, stdout, stderr }.
const run = (args, input) =>
  spawnSync('node', [bin, ...args], { input, encoding: 'utf8' });

// Same, but in a given working directory instead of feeding stdin — for
// the build/serve/new subcommands, which operate on a site directory
// rather than stdin/positional file input.
const runIn = (args, cwd) => spawnSync('node', [bin, ...args], { cwd, encoding: 'utf8' });

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
  const { stdout } = run(['-', '--html'], '= Hi {{ 2 * 3 }}');
  assert.match(stdout, /<h1 id="[^"]*">Hi 6<\/h1>/);
});

test('-d supplies context; JSON values parse, bare stays a string', () => {
  const { stdout } = run(['-', '-d', 'n=3', '-d', 'name=ada'], '{{ req.name }}×{{ req.n }}={{ req.name.repeat(req.n) }}');
  assert.equal(stdout.trim(), 'ada×3=adaadaada');
});

test('-d data is req, front matter is res.data; overriding is an explicit fallback', () => {
  const src = 'who: nobody\n+++\nhi {{ req.who ?? res.data.who }}';
  // -d values arrive as `req` and win in the document's own fallback…
  assert.equal(run(['-', '-d', 'who=world'], src).stdout.trim(), 'hi world');
  // …while with nothing passed, the front matter (`res.data`) is the default.
  assert.equal(run(['-'], src).stdout.trim(), 'hi nobody');
});

// --- file input → stdout by default ---------------------------------------

test('a .mdy file renders to stdout by default (no file written)', () => {
  const dir = workdir();
  const src = join(dir, 'roster.mdy');
  copyFileSync(example('roster.mdy'), src);

  const { status, stdout } = run([src]);
  assert.equal(status, 0);
  assert.match(stdout, /= Team Roster/);
  assert.match(stdout, /- !!Ada Lovelace!! \(36\) — team lead/);
  assert.ok(!existsSync(join(dir, 'roster.mdy.out')), 'should not write a file without -o');
});

test('-o writes output to a file', () => {
  const dir = workdir();
  const src = join(dir, 'roster.mdy');
  const out = join(dir, 'out.mdy');
  copyFileSync(example('roster.mdy'), src);

  const { status } = run([src, '-o', out]);
  assert.equal(status, 0);
  assert.match(readFileSync(out, 'utf8'), /= Team Roster/);
});

test('-o --html writes HTML to a file', () => {
  const dir = workdir();
  const src = join(dir, 'shared-scope.mdy');
  const out = join(dir, 'out.html');
  copyFileSync(example('shared-scope.mdy'), src);

  const { status } = run([src, '--html', '-o', out]);
  assert.equal(status, 0);
  assert.match(readFileSync(out, 'utf8'), /<h1 id="[^"]*">Fibonacci<\/h1>/);
});

// --- warnings & guards ----------------------------------------------------

test('warns on non-.mdy input but still processes', () => {
  const dir = workdir();
  const src = join(dir, 'note.txt');
  copyFileSync(example('roster.mdy'), src);

  const { status, stdout, stderr } = run([src]);
  assert.equal(status, 0);
  assert.match(stderr, /does not have a \.mdy extension/);
  assert.match(stdout, /= Team Roster/);
});

test('-o refuses to overwrite the input file', () => {
  const dir = workdir();
  const src = join(dir, 'thing.mdy');
  copyFileSync(example('roster.mdy'), src);

  const { status, stderr } = run([src, '-o', src]);
  assert.equal(status, 1);
  assert.match(stderr, /refusing to overwrite the input/);
});

test('a file input has no access to sibling files (unlike a directory input)', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'main.mdy'), '+++\n{{ $.find({}).length }}');
  writeFileSync(join(dir, 'other.mdy'), 'title: Other\n+++\nirrelevant body');

  const { status, stdout } = run([join(dir, 'main.mdy')]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), '1'); // just main.mdy's own (single) document
});

test('--emit-js prints the compiled function of every document in a file', () => {
  const src = 'hi {{ req.x }}\n---\ny: 2\n+++\n% let z = 1\nz is {{ z }}';
  const { status, stdout } = run(['-', '--emit-js'], src);
  assert.equal(status, 0);
  assert.match(stdout, /function __doc0\(req, res\)/);
  assert.match(stdout, /function __doc1\(req, res\)/);
  assert.match(stdout, /\$\{ req\.x \}/);
  assert.match(stdout, /let z = 1/);
});

test('--emit-js rejects --html', () => {
  const { status, stderr } = run(['-', '--emit-js', '--html'], 'x');
  assert.equal(status, 1);
  assert.match(stderr, /--emit-js cannot be combined with --html/);
});

test('$.emit output is reported but not written without --out', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'entry.mdy'), '+++\n% $.emit("a.html", "hi")\nentry text');

  const { status, stdout, stderr } = run([join(dir, 'entry.mdy')]);
  assert.equal(status, 0);
  assert.match(stdout, /entry text/);
  assert.match(stderr, /1 file\(s\) emitted via \$\.emit not written/);
  assert.match(stderr, /a\.html/);
});

test('$.emit output is written under -o when it is an existing directory', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'entry.mdy'), '+++\n% $.emit("nested/a.html", "hi from a")\nentry text');
  const out = join(dir, 'out');
  mkdirSync(out);

  const { status, stdout, stderr } = run([join(dir, 'entry.mdy'), '-o', out]);
  assert.equal(status, 0);
  assert.match(stdout, /entry text/); // no filename to write the primary output to, so it still goes to stdout
  assert.match(stderr, /wrote 1 emitted file\(s\)/);
  assert.equal(readFileSync(join(out, 'nested', 'a.html'), 'utf8'), 'hi from a');
});

test('missing input exits non-zero with a message', () => {
  const { status, stderr } = run(['does-not-exist.mdy']);
  assert.equal(status, 1);
  assert.match(stderr, /cannot read input/);
});

test('--help prints usage', () => {
  const { stdout } = run(['--help']);
  assert.match(stdout, /Usage:\s+mdy \[path\]/);
});

test('more than one positional is rejected', () => {
  const { status, stderr } = run(['a.mdy', 'b.mdy']);
  assert.equal(status, 1);
  assert.match(stderr, /single input/);
});

test('stdin given more than once fails (a second positional)', () => {
  const { status, stderr } = run(['-', '-'], 'x');
  assert.equal(status, 1);
  assert.match(stderr, /single input/);
});

// --- directory input: full scan, main.mdy (or --entry) as the entry -----

test('a directory input is scanned in full; the entry\'s $.find reaches every file', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'main.mdy'), '+++\n= Siblings\n% for (const d of $.find({})) {\n- {{ d.path }}\n% }');
  writeFileSync(join(dir, 'other.mdy'), 'title: Other\n+++\nirrelevant body');

  const { status, stdout } = run([dir]);
  assert.equal(status, 0);
  assert.match(stdout, /- main\.mdy/);
  assert.match(stdout, /- other\.mdy/);
});

test('a directory sibling that is not the entry is inserted with raw identity only', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'main.mdy'), '+++\n% const o = $.findOne({ path: "other.mdy" })\n{{ o.name }}/{{ o.ext }}/{{ typeof o.title }}');
  writeFileSync(join(dir, 'other.mdy'), 'title: Other\n+++\nbody');

  const { stdout } = run([dir]);
  assert.equal(stdout.trim(), 'other.mdy/.mdy/string'); // front matter still extracted for a sibling .mdy
});

test('--entry picks a different entry document', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'main.mdy'), '+++\ndefault entry');
  writeFileSync(join(dir, 'other.mdy'), '+++\nother entry');

  const { status, stdout } = run([dir, '--entry', 'other.mdy']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), 'other entry');
});

test('--entry with a missing file fails clearly', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'main.mdy'), '+++\nhi');

  const { status, stderr } = run([dir, '--entry', 'nope.mdy']);
  assert.equal(status, 1);
  assert.match(stderr, /entry script not found/);
});

test('--entry is rejected for a file or stdin input', () => {
  const dir = workdir();
  const src = join(dir, 'doc.mdy');
  writeFileSync(src, '+++\nhi');

  assert.match(run([src, '--entry', 'x.mdy']).stderr, /--entry is only valid with a directory input/);
  assert.match(run(['-', '--entry', 'x.mdy'], 'hi').stderr, /--entry is only valid with a directory input/);
});

test('--emit-js on a directory input compiles just the entry document', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'main.mdy'), '+++\nhi {{ req.x }}');
  writeFileSync(join(dir, 'other.mdy'), '+++\nother {{ req.y }}');

  const { status, stdout } = run([dir, '--emit-js']);
  assert.equal(status, 0);
  assert.match(stdout, /\$\{ req\.x \}/);
  assert.doesNotMatch(stdout, /\$\{ req\.y \}/);
});

test('-o refuses to overwrite a directory input', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'main.mdy'), '+++\nhi');

  const { status, stderr } = run([dir, '-o', dir]);
  assert.equal(status, 1);
  assert.match(stderr, /refusing to overwrite the input/);
});

// --- watch mode -----------------------------------------------------------

test('--watch re-renders when an input file changes', async () => {
  const dir = workdir();
  const src = join(dir, 'doc.mdy');
  const out = join(dir, 'out.mdy');
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
  const out = join(dir, 'out.mdy');
  writeFileSync(src, 'ok {{ 1 + 1 }}\n');

  const child = spawn('node', [bin, src, '-o', out, '--watch']);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').includes('ok 2'));
    writeFileSync(src, '% throw "kaboom"\nbroken\n');
    await waitFor(() => /kaboom/.test(stderr));
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
  const out = join(dir, 'out.mdy');
  writeFileSync(src, 'env is {{ req.env }}\n');
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

test('--watch on a directory re-renders when ANY file under it changes', async () => {
  const dir = workdir();
  const out = join(dir, 'out.mdy');
  writeFileSync(join(dir, 'main.mdy'), '+++\n% const o = $.findOne({ path: "other.mdy" })\nother says {{ o.text }}');
  writeFileSync(join(dir, 'other.mdy'), 'text: hi\n+++\n');

  const child = spawn('node', [bin, dir, '-o', out, '--watch']);
  try {
    await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').includes('other says hi'));
    writeFileSync(join(dir, 'other.mdy'), 'text: bye\n+++\n');
    await waitFor(() => readFileSync(out, 'utf8').includes('other says bye'));
  } finally {
    child.kill();
  }
});

// --- build (whole-site) -----------------------------------------------

test('mdy build renders a site to <dir>/dist by default', () => {
  const dir = site();
  const { status, stdout } = runIn(['build'], dir);
  assert.equal(status, 0);
  assert.match(stdout, /built \d+ page\(s\)/);
  assert.ok(existsSync(join(dir, 'dist', 'index.html')));
  assert.ok(existsSync(join(dir, 'dist', 'posts', 'hello', 'index.html')));
});

test('mdy build --out writes to a custom directory', () => {
  const dir = site();
  const out = join(dir, 'public');
  const { status } = runIn(['build', '.', '--out', out], dir);
  assert.equal(status, 0);
  assert.ok(existsSync(join(out, 'index.html')));
});

test('mdy build excludes drafts unless --drafts is given', () => {
  const dir = site();
  runIn(['build'], dir);
  assert.ok(!existsSync(join(dir, 'dist', 'posts', 'clay-tablets')));
  runIn(['build', '--drafts'], dir);
  assert.ok(existsSync(join(dir, 'dist', 'posts', 'clay-tablets', 'index.html')));
});

test('mdy build --entry picks a different entry document', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'main.mdy'), '+++\n% $.emit("index.html", "default entry")');
  writeFileSync(join(dir, 'other.mdy'), '+++\n% $.emit("index.html", "other entry")');
  const { status } = runIn(['build', '.', '--entry', 'other.mdy'], dir);
  assert.equal(status, 0);
  assert.equal(readFileSync(join(dir, 'dist', 'index.html'), 'utf8'), 'other entry');
});
