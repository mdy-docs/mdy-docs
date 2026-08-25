import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { serveSite } from '../src/serve.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleBlog = join(here, '..', 'examples', 'blog');
const exampleBlogStyleX = join(here, '..', 'examples', 'blog-style-x');

// The watch test edits content, so serve a throwaway copy of the example —
// blog-style-x copied alongside it as a real sibling (blog/main.mdy
// imports it as "../blog-style-x"), not just blog itself.
let tmpRoot;
let siteDir;
let site;
before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'edubba-serve-'));
  siteDir = join(tmpRoot, 'blog');
  await cp(exampleBlog, siteDir, { recursive: true });
  await cp(exampleBlogStyleX, join(tmpRoot, 'blog-style-x'), { recursive: true });
  site = await serveSite(siteDir, { port: 0 });
});
after(async () => {
  await site.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

const get = (path) => fetch(new URL(path, site.url));

test('serves rendered pages from memory, with the reload client injected', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Tablet House<\/title>/);
  assert.match(html, /EventSource\("\/__mdy__\/events"\)/);
});

test('slashless pretty URLs resolve', async () => {
  const res = await get('/posts/hello');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1 id="[^"]*">Hello world<\/h1>/);
});

test('static files come from static/ on disk', async () => {
  const res = await get('/style.css');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/css/);
  assert.match(await res.text(), /max-width/);
});

test('static/logo.png is served flattened at /logo.png; its metadata sidecar is not served at all', async () => {
  const logo = await get('/logo.png');
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get('content-type'), /image\/png/);

  const sidecar = await get('/logo.png.mdy');
  assert.equal(sidecar.status, 404);
});

test('the search index and widget script are both served', async () => {
  const index = await get('/search-index.json');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /application\/json/);
  const records = await index.json();
  assert.ok(records.some((r) => r.url === '/posts/hello/'));

  const widget = await get('/search.js');
  assert.equal(widget.status, 200);
  assert.match(await widget.text(), /search-index\.json/);
});

test('unknown paths 404 (and still carry the reload client)', async () => {
  const res = await get('/no/such/page/');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /EventSource/);
});

test('path traversal out of static/ is refused', async () => {
  const res = await fetch(new URL('/%2e%2e/site.yaml', site.url));
  assert.equal(res.status, 404);
});

test('editing content rebuilds and pings live-reload clients', async () => {
  // Hold an SSE connection like a browser would.
  const events = await get('/__mdy__/events');
  const reader = events.body.getReader();
  const sawReload = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream closed before a reload event');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('data: reload')) return;
    }
  })();

  await writeFile(
    join(siteDir, 'about.mdy'),
    'title: About the tablet house\n+++\nRewritten while the server watched.\n'
  );

  await Promise.race([
    sawReload,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('no reload event within 10s of the edit')), 10_000)
    ),
  ]);
  await reader.cancel();

  const html = await (await get('/about/')).text();
  assert.match(html, /<h1 id="[^"]*">About the tablet house<\/h1>/);
  assert.match(html, /Rewritten while the server watched/);
});

test('editing one post rebuilds the whole script-defined site (no incremental reuse — see script-site.js)', async () => {
  // Unlike the conventional content/layouts/site.yaml pipeline, a
  // script-defined site (main.mdy, here) has no incremental cache — every
  // rebuild walks the whole directory and re-runs the entry from scratch
  // (src/script-site.js's own file-level comment). So editing ONE
  // post rebuilds EVERY output, not just that post's page.
  const events = await get('/__mdy__/events');
  const reader = events.body.getReader();
  const sawReload = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream closed before a reload event');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('data: reload')) return;
    }
  })();

  await writeFile(
    join(siteDir, 'posts', '2026-07-hello.mdy'),
    'title: Hello world\ndate: 2026-07-18\n+++\nEdited again, this time via serve.'
  );
  await Promise.race([
    sawReload,
    new Promise((_, reject) => setTimeout(() => reject(new Error('no reload within 10s')), 10_000)),
  ]);
  await reader.cancel();

  assert.ok(site.stats.rebuilt.includes('posts/hello/index.html'));
  assert.equal(site.stats.reused.length, 0);
  // about/ WAS rewritten by the previous test — confirm the edit survived
  // this second, whole-site rebuild (nothing was silently dropped).
  const aboutHtml = await (await get('/about/')).text();
  assert.match(aboutHtml, /Rewritten while the server watched/);
});

test("onRebuild's info.changed lists the watched path(s) that triggered the rebuild", async () => {
  // A separate site instance (own tmp copy, own onRebuild) rather than
  // reusing the shared `site` above — the shared instance's onRebuild is
  // the default logger, and the previous tests already drove its own
  // rebuilds, so a fresh instance keeps this assertion isolated.
  const dir = await mkdtemp(join(tmpdir(), 'edubba-serve-changed-'));
  await cp(exampleBlog, dir, { recursive: true });

  const rebuilds = [];
  const changedSite = await serveSite(dir, {
    port: 0,
    onRebuild: (info) => rebuilds.push(info),
  });
  try {
    assert.equal(rebuilds.length, 1);
    assert.deepEqual(rebuilds[0].changed, []); // first build: nothing "changed", it just ran

    const changedPath = join('posts', '2026-07-hello.mdy');
    await writeFile(join(dir, changedPath), 'title: Hello world\ndate: 2026-07-18\n+++\nEdited for the changed-path test.');

    await new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (rebuilds.length > 1) return resolve();
        if (Date.now() - started > 10_000) return reject(new Error('no rebuild within 10s'));
        setTimeout(check, 50);
      };
      check();
    });

    assert.equal(rebuilds.length, 2);
    assert.deepEqual(rebuilds[1].changed, [changedPath]);
  } finally {
    await changedSite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("onRebuild reports what the site would have published, unsent", async () => {
  // The dev server deliberately does not publish: there is no incremental
  // cache, so every save reruns the entry from scratch and anything that
  // went out would re-fire on every keystroke (src/publish.js). Dropping
  // them without a word, though, made $.publish look like it did nothing —
  // so they come back on the rebuild info instead.
  const dir = await mkdtemp(join(tmpdir(), 'mdy-serve-publish-'));
  await writeFile(
    join(dir, 'main.mdy'),
    '+++\n% $.publish("h", { n: 1 })\n% $.publish("h", { n: 2 })\n% $.emit("index.html", "hi")'
  );
  await writeFile(join(dir, 'h.mdy'), '+++\nhandler');

  const rebuilds = [];
  const site = await serveSite(dir, { port: 0, onRebuild: (info) => rebuilds.push(info) });
  try {
    assert.equal(rebuilds.length, 1);
    assert.deepEqual(rebuilds[0].messages.map((m) => m.name), ['h', 'h']);
    assert.deepEqual(rebuilds[0].messages.map((m) => m.data.n), [1, 2]);
  } finally {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
