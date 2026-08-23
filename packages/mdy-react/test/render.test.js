import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { render as renderHtml } from 'mdy-docs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { fromHtml } from 'hast-util-from-html';

import { createReactProcessor, renderToReact } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const example = (name) => readFileSync(join(here, '..', '..', '..', 'examples', name), 'utf8');

const toHtml = async (source, data, options) =>
  renderToStaticMarkup(await renderToReact(source, data, options));

// --- equivalence with the HTML target -------------------------------------
//
// The whole design claim of this package is that React is one compiler swap at
// the end of a shared pipeline, not a second implementation. These tests are
// what makes that claim falsifiable: if the two targets ever diverge on real
// documents, something grew a string-path-only assumption.
//
// Compared as parsed trees, not as text, because the two ends serialize the
// same document differently and none of it is a difference in the document:
// rehype writes `&#x3C;` where React writes `&lt;`, rehype writes bare `<hr>`
// where React writes `<hr/>`, and React 19 hoists a `<link rel="preload">` for
// every image it sees. Re-parsing normalizes all three away and still catches
// what actually could break — a namespace lost on `<svg>`, a void element
// given children, an element dropped, an attribute renamed.

const strip = (node) => {
  delete node.position;
  // React re-emits a `style` attribute from its parsed form, so the spacing
  // in it is React's, not the document's.
  if (typeof node.properties?.style === 'string') {
    node.properties.style = node.properties.style.replace(/\s*([:;])\s*/g, '$1').replace(/;$/, '');
  }
  if (node.children) {
    node.children = node.children.filter(
      (c) =>
        !(c.tagName === 'link' && [].concat(c.properties?.rel ?? []).includes('preload')) &&
        // Whitespace between an element's children is layout in the source,
        // not content — and React drops it outright inside a <table>, where
        // it is not legal. `<pre>` is the one place it means something.
        !(c.type === 'text' && c.value.trim() === '' && node.tagName !== 'pre'),
    );
    node.children.forEach(strip);
  }
  return node;
};

const parse = (html) => strip(fromHtml(html.trim(), { fragment: true }));

const equivalent = async (source) => {
  assert.deepEqual(parse(await toHtml(source)), parse(await renderHtml(source)));
};

test('a document set example renders identically to the HTML target', async () => {
  await equivalent(example('document-set.mdy'));
});

test('elements and indentation render identically to the HTML target', async () => {
  await equivalent(example('elements.mdy'));
});

test('a data-driven table renders identically to the HTML target', async () => {
  await equivalent(example('roster.mdy'));
});

test('an invoice example renders identically to the HTML target', async () => {
  await equivalent(example('invoice.mdy'));
});

test('tables, heading ids and inline markers all survive the React compiler', async () => {
  const out = await toHtml(
    ['= A heading', '', '| a | b |', '| - | - |', '| 1 | 2 |', '', '~~gone~~'].join('\n'),
  );
  assert.match(out, /<h1 id="a-heading">A heading<\/h1>/);
  assert.match(out, /<table>/);
  assert.match(out, /<del>gone<\/del>/);
});

test('the markdown front end reaches React too, alert icons and all', async () => {
  const { renderMarkdown } = createReactProcessor();
  const out = renderToStaticMarkup(await renderMarkdown('> [!WARNING]\n> careful\n'));
  assert.match(out, /markdown-alert-warning/);
  assert.match(out, /<svg/); // the alert icon, which sanitizers love to eat
});

// --- the template layer is untouched by the target ------------------------

test('req and res bind exactly as they do on the string path', async () => {
  const source = 'title: Mine\n+++\n{{ res.data.title }}/{{ req.title ?? "none" }}';
  assert.match(await toHtml(source), /<p>Mine\/none<\/p>/);
  assert.match(await toHtml(source, { title: 'Passed' }), /<p>Mine\/Passed<\/p>/);
});

test('renders a document other than the entry', async () => {
  const source = 'first\n---\nsecond';
  assert.match(await toHtml(source, {}, { entry: 1 }), /<p>second<\/p>/);
});

test('a tree-form document (transform) reaches React with nothing in between', async () => {
  const source = [
    '%% transform((tree) => {',
    '  tree.children.push(h("h2#added", "Added"))',
    '})',
    'body',
  ].join('\n');
  const out = await toHtml(source);
  assert.match(out, /<p>body<\/p>/);
  assert.match(out, /<h2 id="added">Added<\/h2>/);
});

test('a template error rejects rather than rendering half a document', async () => {
  await assert.rejects(() => renderToReact('{{ nope }}'));
});

// --- components -----------------------------------------------------------

test('components replace tags with real React components', async () => {
  const Code = ({ children, className }) =>
    createElement('code', { 'data-lang': className ?? 'none' }, children);

  const out = renderToStaticMarkup(
    await renderToReact('```js\nlet x = 1\n```\n', {}, { components: { code: Code } }),
  );
  assert.match(out, /data-lang="language-js hljs"/);
  assert.match(out, /x/);
});

test('components receive the hast node, and can opt out of it', async () => {
  const seen = [];
  const H2 = ({ node, children }) => {
    seen.push(node?.tagName ?? null);
    return createElement('h2', null, children);
  };
  await toHtml('== one\n', {}, { components: { h2: H2 } });
  await toHtml('== one\n', {}, { components: { h2: H2 }, passNode: false });
  assert.deepEqual(seen, ['h2', null]);
});

test('one processor renders many sources (the live-editor path)', async () => {
  const processor = createReactProcessor();
  const a = renderToStaticMarkup(await processor.render('= one'));
  const b = renderToStaticMarkup(await processor.render('= two'));
  assert.match(a, /one/);
  assert.match(b, /two/);
});

test('renderMdy takes MDY text with no document layer around it', async () => {
  const out = renderToStaticMarkup(await createReactProcessor().renderMdy('= T'));
  assert.equal(out, '<h1 id="t">T</h1>');
});
