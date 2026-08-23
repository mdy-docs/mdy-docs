import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import { createReactProcessor, renderToReact, mdySanitizeSchema } from '../src/index.js';

const render = async (source, options) =>
  renderToStaticMarkup(await renderToReact(source, {}, options));

const clean = (source) => render(source, { sanitize: true });

// The other front end, for the features that belong to markdown rather than
// to MDY (GitHub alerts are remark-github-blockquote-alert's).
const cleanMarkdown = async (source) =>
  renderToStaticMarkup(await createReactProcessor({ sanitize: true }).renderMarkdown(source));

// --- the default is mdy's default -----------------------------------------

test('unsanitized by default, exactly like mdy-docs own HTML output', async () => {
  const out = await render('< div class="mine"\n  hi\n');
  assert.match(out, /<div class="mine">/);
});

// --- what sanitization must not break -------------------------------------
//
// The failure mode worth testing for is not "the sanitizer let something
// through" — it is "the sanitizer quietly ate a feature". A stock schema does
// all four of these.

test('elements and their indentation survive sanitization', async () => {
  const out = await clean('< section class="team"\n  < div class="roster"\n    body\n');
  assert.match(out, /<section class="team">/);
  assert.match(out, /<div class="roster">/);
  assert.match(out, /body/);
});

test('alert boxes keep their classes and their icon', async () => {
  const out = await cleanMarkdown('> [!TIP]\n> useful');
  assert.match(out, /class="markdown-alert markdown-alert-tip"/);
  assert.match(out, /class="markdown-alert-title"/);
  assert.match(out, /<svg[^>]*viewBox="0 0 16 16"/);
  assert.match(out, /<path d="/);
});

test('heading ids are not clobber-prefixed, so $.toc anchors still land', async () => {
  const out = await clean('== My Heading\n');
  assert.match(out, /<h2 id="my-heading">/);
  assert.doesNotMatch(out, /user-content-/);
});

test('fenced code keeps its language class for highlighters', async () => {
  const out = await clean('```js\nlet x = 1\n```\n');
  assert.match(out, /class="language-js hljs"/);
});

// --- what sanitization must catch -----------------------------------------

test('scripts and event handlers are removed', async () => {
  const out = await clean('< div class="x"\n  text\n\n<script>alert(1)\n');
  assert.doesNotMatch(out, /<script/);
  assert.doesNotMatch(out, /alert\(1\)/);

  const handler = await clean('<div onclick="alert(1)">click\n');
  assert.doesNotMatch(handler, /onclick/);
});

test('javascript: URLs are removed', async () => {
  const out = await clean('[[ click | javascript:alert(1) ]]\n');
  assert.doesNotMatch(out, /javascript:/);
});

// --- what the React target gives you for free, and what it does not -------
//
// Worth pinning down, because it is not the same trade as the string target's.
// React refuses to emit a string event handler at all, and rewrites a
// `javascript:` URL into an inert throw — so two of the three classic markdown
// injection vectors are closed by the renderer itself, before any schema is
// consulted. The third is not: a raw `<script>` is rendered verbatim and will
// run. Unsanitized output is therefore *safer* here than on the string path,
// and still not safe. Sanitize untrusted documents.

test('React drops inline event handlers even unsanitized', async () => {
  assert.equal(await render('<div onclick="alert(1)">click\n'), '<div>click</div>');
  assert.doesNotMatch(await render('<img src=x onerror="alert(1)"\n'), /onerror/);
});

test('React neutralizes javascript: URLs even unsanitized', async () => {
  const out = await render('[[ click | javascript:alert(1) ]]\n');
  assert.doesNotMatch(out, /alert\(1\)/);
  assert.match(out, /React has blocked a javascript: URL/);
});

test('a script element still runs unsanitized — the default is a choice', async () => {
  // mdy's own parser has a sanitizer, and mdy-docs turns it off: these are
  // the author's own files. That is the same choice the string target makes,
  // and it is a choice, not an oversight.
  assert.match(await render('<script>alert(1)\n'), /<script>alert\(1\)<\/script>/);
});

// --- custom schemas -------------------------------------------------------

test('a custom schema replaces the mdy one', async () => {
  const out = await render('= heading\n\n!!bold!!\n', {
    sanitize: { ...mdySanitizeSchema, tagNames: ['p'] },
  });
  assert.doesNotMatch(out, /<h1/);
  assert.doesNotMatch(out, /<strong>/);
  assert.match(out, /<p>bold<\/p>/);
});
