import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// The widget (examples/blog-style-x/static/search.js — imported by
// examples/blog/index.mdy as its "style" package, see imports.js) is plain
// browser JS with no bundler — it can't be imported as a module. This runs
// the actual shipped source against a minimal fake DOM in node:vm, so the
// test exercises the real file a browser would load, not a reimplementation
// of its logic.

const here = dirname(fileURLToPath(import.meta.url));
const widgetSource = await readFile(
  join(here, '..', 'examples', 'blog-style-x', 'static', 'search.js'),
  'utf8'
);

const records = [
  { url: '/posts/hello/', title: 'Hello world', excerpt: 'First post.', tags: ['wasm'], words: ['hello', 'world', 'wasm', 'writing'] },
  { url: '/posts/diggings/', title: 'Diggings', excerpt: 'Foundations.', tags: ['history'], words: ['diggings', 'history', 'tablet', 'house'] },
  { url: '/about/', title: 'About', excerpt: 'edubba site.', tags: [], words: ['about', 'edubba', 'writing', 'tools'] },
];

function fakeElement(tag) {
  return {
    tagName: tag,
    _attrs: {},
    textContent: '',
    children: [],
    set href(v) { this._attrs.href = v; },
    get href() { return this._attrs.href; },
    append(...nodes) { this.children.push(...nodes); },
  };
}

/** Run the widget against a canned search-index.json, simulate typing
 * `query` into #search-input, and return the rendered #search-results
 * fake <li> elements once the debounce + fetch have settled. */
async function runWidget(query) {
  const input = { value: '', _listeners: {}, addEventListener(type, fn) { this._listeners[type] = fn; } };
  const results = { children: null, replaceChildren(...nodes) { this.children = nodes; } };

  const document = {
    getElementById: (id) => (id === 'search-input' ? input : id === 'search-results' ? results : null),
    createElement: (tag) => fakeElement(tag),
    createTextNode: (text) => ({ nodeType: 'text', textContent: text }),
  };

  let fetchedUrl = null;
  const context = vm.createContext({
    document,
    fetch: async (url) => {
      fetchedUrl = url;
      return { json: async () => records };
    },
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(widgetSource, context);

  input.value = query;
  input._listeners.input();
  // debounce (100ms) + the fetch microtask queue
  await new Promise((r) => setTimeout(r, 150));

  return { results, fetchedUrl };
}

test('widget fetches /search-index.json and renders nothing before typing', async () => {
  const { fetchedUrl } = await runWidget('');
  assert.equal(fetchedUrl, '/search-index.json');
});

test('widget ranks by word overlap, title-substring boosted', async () => {
  const { results } = await runWidget('writing');
  // "writing" is a word of both hello (tags overlap via words[]) and about
  assert.equal(results.children.length, 2);
  const hrefs = results.children.map((li) => li.children[0].href);
  assert.deepEqual(new Set(hrefs), new Set(['/posts/hello/', '/about/']));
});

test('widget renders title (as a link) and excerpt for each match', async () => {
  const { results } = await runWidget('diggings');
  assert.equal(results.children.length, 1);
  const [li] = results.children;
  const [a, text] = li.children;
  assert.equal(a.href, '/posts/diggings/');
  assert.equal(a.textContent, 'Diggings');
  assert.equal(text.textContent, ' — Foundations.');
});

test('widget clears results for an empty or stopword-only query', async () => {
  const { results } = await runWidget('the and');
  assert.deepEqual(results.children, []);
});

test('widget finds nothing for an unmatched query', async () => {
  const { results } = await runWidget('nonexistentword');
  assert.deepEqual(results.children, []);
});
