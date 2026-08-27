import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import { createElement, StrictMode, useLayoutEffect, useRef } from 'react';

// The behaviors this file covers — a preview that does not strobe, does not
// loop, and does not commit a stale render — only exist once effects run, so
// unlike the rest of the suite these need a DOM rather than server rendering.

let act;
let createRoot;
let Mdy;
let useMdy;
let container;
let root;

before(async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' });
  global.window = dom.window;
  global.document = dom.window.document;
  // Node exposes `navigator` as a getter-only global, so it has to be
  // redefined rather than assigned.
  Object.defineProperty(global, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  global.IS_REACT_ACT_ENVIRONMENT = true;

  ({ act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ Mdy, useMdy } = await import('../src/index.js'));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// Rendering an mdy document is asynchronous all the way down — the template
// runs in a WASM VM — so a single act() pass does not settle it. Pump macrotasks
// until the state the test is waiting for actually lands.
const flush = async (until) => {
  for (let i = 0; i < 50; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (!until || until()) return;
  }
  throw new Error('render never settled');
};

const mount = async (element, until = () => container.innerHTML !== '') => {
  await act(() => {
    root.render(element);
  });
  await flush(until);
};

test('renders a document into the DOM', async () => {
  await mount(createElement(Mdy, { source: '+++\ntitle: Hi\n+++\n= {{ res.data.title }}' }));
  assert.equal(container.querySelector('h1').textContent, 'Hi');
  assert.equal(container.querySelector('h1').id, 'hi');
});

test('shows the fallback only until the first render resolves', async () => {
  // Snapshotting every commit rather than sampling the DOM: a warm VM can
  // resolve the render before the test gets a turn, so "the fallback was
  // never on screen at the moment I looked" says nothing either way.
  const commits = [];
  const Recorder = ({ children }) => {
    useLayoutEffect(() => {
      commits.push(container.innerHTML);
    });
    return children;
  };

  await mount(
    createElement(
      Recorder,
      null,
      createElement(Mdy, { source: '= done', fallback: createElement('p', null, 'loading') }),
    ),
    () => container.querySelector('h1'),
  );

  assert.match(commits[0], /loading/, 'the first commit should be the fallback');
  assert.equal(container.querySelector('h1').textContent, 'done');
  assert.doesNotMatch(container.innerHTML, /loading/);
});

test('data reaches the document as req', async () => {
  await mount(createElement(Mdy, { source: '{{ req.who ?? "nobody" }}', data: { who: 'Ada' } }));
  assert.match(container.textContent, /Ada/);
});

// --- the live-editor guarantees -------------------------------------------

test('a broken edit keeps the last good render on screen', async () => {
  const errors = [];
  const props = { source: '= good', onError: (e) => errors.push(e) };

  await mount(createElement(Mdy, props));
  assert.equal(container.querySelector('h1').textContent, 'good');

  await mount(createElement(Mdy, { ...props, source: '{{ nope }}' }));
  assert.equal(container.querySelector('h1').textContent, 'good', 'output was destroyed by a template error');
  assert.equal(errors.length, 1);

  await mount(createElement(Mdy, { ...props, source: '= better' }));
  assert.equal(container.querySelector('h1').textContent, 'better');
});

test('errorFallback covers the case where there is no good render to keep', async () => {
  await mount(
    createElement(Mdy, {
      source: '{{ nope }}',
      errorFallback: (error) => createElement('pre', null, error.message),
    }),
  );
  assert.match(container.querySelector('pre').textContent, /nope/);
});

test('only the newest of several rapid edits is committed', async () => {
  const source = (n) => `= edit ${n}`;
  await act(async () => {
    for (let n = 1; n <= 8; n++) root.render(createElement(Mdy, { source: source(n) }));
  });
  assert.equal(container.querySelector('h1').textContent, 'edit 8');
});

test('inline object props do not spin the render loop', async () => {
  const renders = { count: 0 };
  const Counter = () => {
    renders.count++;
    // Fresh object literals every render: the shape that turns a naive
    // useEffect dependency list into an infinite loop.
    return createElement(Mdy, {
      source: '= stable',
      data: { nested: { a: 1 } },
      components: { h1: ({ children }) => createElement('h1', null, children) },
      rehypePlugins: [],
    });
  };

  await mount(createElement(Counter));
  const settled = renders.count;
  await act(async () => {});
  assert.equal(container.querySelector('h1').textContent, 'stable');
  assert.equal(renders.count, settled, `render loop did not settle (${renders.count} renders)`);
  assert.ok(settled < 6, `too many renders to settle: ${settled}`);
});

test('survives StrictMode double-invocation', async () => {
  await mount(createElement(StrictMode, null, createElement(Mdy, { source: '= strict' })));
  assert.equal(container.querySelector('h1').textContent, 'strict');
});

// --- the hook directly ----------------------------------------------------

test('useMdy exposes element, error and pending', async () => {
  const seen = [];
  const Probe = () => {
    const state = useMdy('= hi');
    seen.push({ element: !!state.element, error: !!state.error, pending: state.pending });
    return state.element;
  };

  await mount(createElement(Probe));
  assert.deepEqual(seen[0], { element: false, error: false, pending: true });
  assert.deepEqual(seen.at(-1), { element: true, error: false, pending: false });
});

test('the processor is not rebuilt when nothing meaningful changed', async () => {
  const seen = new Set();
  const Probe = ({ tick }) => {
    const state = useMdy('= hi', { data: { a: 1 } });
    const id = useRef({});
    seen.add(state.element ? id.current : null);
    return createElement('div', { 'data-tick': tick }, state.element);
  };

  await mount(createElement(Probe, { tick: 1 }));
  const before = container.querySelector('h1');
  await mount(createElement(Probe, { tick: 2 }));

  // An unrelated prop change must not re-render the document: the same DOM
  // node is still there, which is the reconciliation win the whole package is
  // for.
  assert.equal(container.querySelector('h1'), before);
  assert.equal(container.querySelector('div').dataset.tick, '2');
});
