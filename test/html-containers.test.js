import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expandHtmlContainers, render, renderToMarkdown } from '../index.js';

// A container's HTML, with the pipeline's incidental whitespace between
// blocks collapsed — these tests are about structure, not formatting.
const html = async (source) => (await render(source)).replace(/\n+/g, '\n').trim();

// --- the expansion itself -------------------------------------------------

test('a `<tag` line with no `>` opens a container; the two-space indent is its body', () => {
  assert.equal(
    expandHtmlContainers('<div\n  # heading in the div\n# heading after div closed\n'),
    '<div>\n\n# heading in the div\n\n</div>\n\n# heading after div closed\n'
  );
});

test('attributes on the opener carry onto the emitted tag', () => {
  assert.equal(
    expandHtmlContainers('<section class="card" id="a"\n  hi\n'),
    '<section class="card" id="a">\n\nhi\n\n</section>\n'
  );
});

test('a line ending in `>` is an ordinary raw HTML block, left exactly alone', () => {
  const source = '<div class="note">\n  <p>hi</p>\n</div>\n';
  assert.equal(expandHtmlContainers(source), source);
});

test("an attribute value may contain `>` — only the line's LAST character decides", () => {
  assert.equal(
    expandHtmlContainers('<div title="a > b"\n  hi\n'),
    '<div title="a > b">\n\nhi\n\n</div>\n'
  );
  const closed = '<div title="a > b">\n  hi\n';
  assert.equal(expandHtmlContainers(closed), closed);
});

test('blank lines do not close a container; the first line out of the indent does', () => {
  assert.equal(
    expandHtmlContainers('<div\n  a\n\n  b\n\nout\n'),
    '<div>\n\na\n\nb\n\n</div>\n\nout\n'
  );
});

test('exactly two spaces are removed, so 4+ still means an indented code block', () => {
  assert.equal(
    expandHtmlContainers('<div\n      code\n'),
    '<div>\n\n    code\n\n</div>\n'
  );
});

test('containers nest, each level stripping its own two spaces', () => {
  assert.equal(
    expandHtmlContainers('<a\n  <b\n    deep\n'),
    '<a>\n\n<b>\n\ndeep\n\n</b>\n\n</a>\n'
  );
});

test('a container with no indented content is simply empty', () => {
  assert.equal(expandHtmlContainers('<div class="spacer"\ntext\n'), '<div class="spacer">\n</div>\n\ntext\n');
});

test('an opener inside a fenced code block is sample text, not a container', () => {
  const source = '```md\n<div\n  shown\n```\n';
  assert.equal(expandHtmlContainers(source), source);
  assert.equal(expandHtmlContainers('~~~\n<div\n~~~\n'), '~~~\n<div\n~~~\n');
});

test('expansion is idempotent — the expanded form ends in `>`, so it is not an opener', () => {
  const once = expandHtmlContainers('<div\n  # h\n');
  assert.equal(expandHtmlContainers(once), once);
});

test('markdown with no line-initial `<` passes through untouched', () => {
  const source = '# hi\n\nsome *text* with a < in it\n';
  assert.equal(expandHtmlContainers(source), source);
});

// --- element kinds --------------------------------------------------------

test('a void element becomes a standalone self-closing tag', () => {
  assert.equal(expandHtmlContainers('<img src="x.png" alt="x"\n'), '<img src="x.png" alt="x" />\n');
  assert.equal(expandHtmlContainers('<br\n'), '<br />\n');
  assert.equal(expandHtmlContainers('<hr /\n'), '<hr />\n');
});

test('a non-void element written self-closing gets a real pair, not `<div />`', () => {
  // HTML honours self-closing syntax only for void elements: `<div />` would
  // read as an unclosed div and swallow everything after it.
  assert.equal(expandHtmlContainers('<div class="spacer" /\n'), '<div class="spacer"></div>\n');
});

test('a void element with indented content is an error, not a silent mis-nesting', () => {
  assert.throws(() => expandHtmlContainers('<br\n  oops\n'), /void element/);
  assert.throws(() => expandHtmlContainers('<div /\n  oops\n'), /self-closing/);
});

test('raw-text elements keep their content verbatim — de-indented, never markdown', () => {
  assert.equal(
    expandHtmlContainers('<pre\n  keep   *this*\n    and this\n'),
    '<pre>\nkeep   *this*\n  and this\n</pre>\n'
  );
  assert.equal(expandHtmlContainers('<style\n  a { color: red }\n'), '<style>\na { color: red }\n</style>\n');
});

test('an opener inside a raw-text body is content, not a nested container', () => {
  assert.equal(expandHtmlContainers('<pre\n  <div\n'), '<pre>\n<div\n</pre>\n');
});

// --- through the render pipeline ------------------------------------------

test('containers render as real nested HTML, with headings still headings', async () => {
  assert.equal(
    await html('<div\n  # heading in the div\n# heading after div closed\n'),
    '<div>\n<h1 id="heading-in-the-div">heading in the div</h1>\n</div>\n'
      + '<h1 id="heading-after-div-closed">heading after div closed</h1>'
  );
});

test('block markdown inside a container is fully processed', async () => {
  assert.equal(
    await html('<aside class="note"\n  **bold** text\n\n  - a\n  - b\n'),
    '<aside class="note">\n<p><strong>bold</strong> text</p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n</aside>'
  );
});

test('a container sits inside a list item at the item\'s content column', async () => {
  assert.match(await html('- item\n\n  <div class="x"\n    inner\n'), /<li>[\s\S]*<div class="x">[\s\S]*<\/div>[\s\S]*<\/li>/);
});

test('GitHub alerts still work inside a container', async () => {
  assert.match(await html('<div class="wrap"\n  > [!NOTE]\n  > careful\n'), /markdown-alert-note/);
});

test('a template loop can generate a container body by emitting the indent', async () => {
  const source = 'members:\n  - Ada\n  - Grace\n+++\n'
    + '<ul class="team"\n{% for (const m of self.members) { %}\n  - {{ m }}\n{% } %}\n';
  assert.equal(
    await html(source),
    '<ul class="team">\n<ul>\n<li>Ada</li>\n<li>Grace</li>\n</ul>\n</ul>'
  );
});

test('$.parse sees the expanded structure, so $.toc() finds headings in containers', async () => {
  const toc = await html('+++\n{{ $.toc() }}\n<div\n  # Alpha\n  ## Beta\n');
  assert.match(toc, /<a href="#alpha">Alpha<\/a>/);
  assert.match(toc, /<a href="#beta">Beta<\/a>/);
});

test('the markdown boundary emits the expanded form — portable CommonMark', async () => {
  assert.equal(
    await renderToMarkdown('<div class="n"\n  # h\nafter\n'),
    '<div class="n">\n\n# h\n\n</div>\n\nafter\n'
  );
});

test("$.render's indent lands a nested document inside a container", async () => {
  const src = '<section class="team"\n{% for (const m of self.members) { %}\n  <article\n'
    + "{{ $.render({ template: 'card' }, m, 4) }}\n{% } %}\n"
    + '---\ntemplate: card\n+++\n### {{ arg.name }}\n';
  const set = 'members:\n  - { name: Ada }\n  - { name: Grace }\n+++\n' + src;
  assert.equal(
    await html(set),
    '<section class="team">\n<article>\n<h3 id="ada">Ada</h3>\n</article>\n'
      + '<article>\n<h3 id="grace">Grace</h3>\n</article>\n</section>'
  );
});

test('without the indent, a nested render lands OUTSIDE the container', async () => {
  const src = '<div class="w"\n{{ $.render(1) }}\n---\n# outside\n';
  assert.equal(await html(src), '<div class="w">\n</div>\n<h1 id="outside">outside</h1>');
});

test('a container body may hold a fenced code block, indented with it', async () => {
  assert.match(
    await html('<div\n  ```js\n  const x = 1\n  ```\n'),
    /<div>\s*<pre><code class="language-js">const x = 1/
  );
});
