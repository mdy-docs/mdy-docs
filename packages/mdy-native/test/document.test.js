/*
 * `mdy <file>`: what a file IS, from its extension.
 *
 * A directory walk has always read `.mdy`, `.md` and `.yaml` as three
 * different things. One file on its own used to be read as a document
 * whatever it was called, so `mdy notes.md` gave `*emphasis*` back literally
 * and `mdy data.yaml` rendered a YAML mapping as prose. This pins the
 * dispatch that closed that gap.
 *
 * Native only, deliberately — the same reason test/dev.test.js is. node's
 * `bin/mdy.js` reads every file as a document and warns about the extension,
 * so there is no shared behaviour here to hold both binaries to, and
 * test/cli.test.js is the wrong place for a difference rather than an
 * agreement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.env.MDY_CLI ?? join(here, '..', 'build', 'mdy');

const dir = mkdtempSync(join(tmpdir(), 'mdy-doc-'));
const MARKDOWN = '# Hello\n\nSome *markdown* and a [link](https://example.com).\n';
const RECORD = 'title: A record\ncount: 3\ntags:\n  - one\n  - two\n';

const write = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };

/* stdout only, with the `[read]` line the CLI prints for every source taken
 * out — it names an absolute path in a temp directory and says nothing about
 * what is under test. */
const run = (args, input) => {
  const out = execFileSync(bin, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return out.split('\n').filter((l) => !l.startsWith('[read]')).join('\n');
};

/* What it said and what it exited with, for the cases that refuse. */
const refuses = (args) => {
  try { execFileSync(bin, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (err) { return { status: err.status, stderr: String(err.stderr) }; }
  return { status: 0, stderr: '' };
};

test('a .md is markdown, not a document', () => {
  const md = write('notes.md', MARKDOWN);
  const html = run([md, '--html']);
  assert.match(html, /<h1 id="hello">Hello<\/h1>/);
  assert.match(html, /<em>markdown<\/em>/);
  assert.match(html, /<a href="https:\/\/example\.com">link<\/a>/);
  /* The three things a document reading would have done instead: `#` a
   * hashtag, and the emphasis and the link left as the characters typed. */
  assert.doesNotMatch(html, /\*markdown\*/);
  assert.doesNotMatch(html, /\[link\]/);
});

test('...and without --html its text is the file, as $.text on one gives', () => {
  const md = write('notes2.md', MARKDOWN);
  assert.equal(run([md]).replace(/\n$/, ''), MARKDOWN.replace(/\n$/, ''));
});

test('...and it reads exactly as the same file inside a site does', () => {
  /* The anchor for the whole dispatch: a file on its own must not be a fourth
   * reading. `--entry` names it as a site's entry document, which is the path
   * a `.md` took before this existed at all. */
  const site = join(dir, 'site');
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'page.md'), MARKDOWN);
  assert.equal(run([join(site, 'page.md'), '--html']),
               run([site, '--entry', 'page.md', '--html']));
});

test('a .yaml is a record, and JSON is what it has to give', () => {
  const y = write('data.yaml', RECORD);
  assert.equal(run([y]).replace(/\n$/, ''),
               '{"title":"A record","count":3,"tags":["one","two"]}');
});

test('...and .yml is the same file type', () => {
  const y = write('data.yml', RECORD);
  assert.equal(run([y]), run([write('same.yaml', RECORD)]));
});

test('...and one it cannot read says which line, and exits 1', () => {
  const bad = write('bad.yaml', 'a: [unclosed\n');
  const { status, stderr } = refuses([bad]);
  assert.equal(status, 1);
  assert.match(stderr, /line 2/);
});

test('a .mdy is still a document: front matter, code, mdy markup', () => {
  const m = write('page.mdy', '+++\ntitle: Title\n+++\n= {{ res.data.title }}\n');
  assert.match(run([m, '--html']), /<h1 id="title">Title<\/h1>/);
});

test('stdin has no extension, so --md is how it says it is markdown', () => {
  assert.match(run(['-', '--md', '--html'], MARKDOWN), /<h1 id="hello">Hello<\/h1>/);
  /* Without it, stdin is a document — which is the default it has always had. */
  assert.doesNotMatch(run(['-', '--html'], MARKDOWN), /<h1 id="hello">Hello<\/h1>/);
});

test('an extension the dispatch does not know is a document, and says so', () => {
  const t = write('notes.txt', 'hello\n');
  const out = execFileSync(bin, [t, '--html'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.match(out, /<p>hello<\/p>/);
});

test('an option that needs code is refused, not ignored', () => {
  /* A `--scope` that silently did nothing would be worse than one that stops:
   * the caller would get a document rendered without the variables it passed
   * and no sign of it. */
  const md = write('opts.md', MARKDOWN);
  for (const flag of [['--emit-js'], ['--publish'], ['--inert-tasks'], ['--sanitize'],
                      ['--scope', 'x.yaml'], ['--response', 'r.json'],
                      ['--data', 'k=v'], ['--data-file', 'x.yaml']]) {
    const { status, stderr } = refuses([md, ...flag]);
    assert.equal(status, 1, `${flag[0]} should be refused`);
    assert.match(stderr, new RegExp(`${flag[0].replace(/-/g, '\\-')} has no meaning for a markdown file`));
  }
});

test("a task's box is a form by default, and --inert-tasks makes it a checkbox", () => {
  /* The form carries where the `[x]` IS — line, column, and what is there now
   * — so a handler can write one byte of the file back. A disabled checkbox
   * carries nothing and is display only, which is the opt-out rather than the
   * default: a document that lists tasks is usually a document somebody means
   * to tick. */
  const m = write('tasks.mdy', '- [ ] buy milk\n');
  const live = run([m, '--html']);
  assert.match(live, /<form method="post" class="task-list-item-form">/);
  assert.match(live, /name="line" value="1"/);
  assert.match(live, /name="column" value="4"/);
  assert.match(live, /name="was" value=" "/);

  const inert = run([m, '--inert-tasks', '--html']);
  assert.match(inert, /<input type="checkbox" disabled>/);
  assert.doesNotMatch(inert, /<form/);
});

test("...but a .md's box is the markdown front end's, which has no form", () => {
  /* Not an oversight: `tasks` is an mdy-parse option and the markdown front
   * end takes none, so a `.md` task list is GFM's disabled checkbox on both
   * engines. Refusing --inert-tasks for one says that rather than hiding it. */
  const md = write('tasks.md', '- [ ] buy milk\n');
  assert.match(run([md, '--html']), /<input type="checkbox" disabled>/);
});

test('--html is refused for a record, which has no rendered form', () => {
  const y = write('r.yaml', RECORD);
  const { status, stderr } = refuses([y, '--html']);
  assert.equal(status, 1);
  assert.match(stderr, /--html has no meaning for a data file/);
});
