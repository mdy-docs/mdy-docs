/*
 * mdy-docs, bundled for a browser, rendering in WebKit.
 *
 * This is the check the desktop plan (docs/desktop-plan.md) rests on: the
 * package is browser-shaped, and a desktop app is a shell around that rather
 * than a port. What it guards is narrow and worth stating, because a test that
 * launches a browser earns its keep only if it catches something the rest of
 * the suite cannot:
 *
 *   - A static `import` of a node builtin sneaking into a browser path. The
 *     lazy dynamic imports in src/build.js, src/serve.js and src/fs-provider.js
 *     exist because someone has already hit this; nothing else notices when one
 *     is undone.
 *   - The WASM engines failing to load, or to run, under JavaScriptCore. WebKit
 *     here is the same engine as WKWebView on macOS and WebKitGTK on Linux, so
 *     this is the desktop target and not an approximation of it.
 *   - The `.wasm` files not travelling with the bundle. That failure happens at
 *     runtime, in a fetch, and is invisible to any test that does not actually
 *     load the thing.
 *
 * It is deliberately NOT in the main suite — `npm test` stays fast and needs no
 * browser. `npm run test:browser` runs this, and it skips with a clear reason
 * when playwright or its WebKit build is absent rather than failing on a
 * machine that never asked for them.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import test from 'node:test';

import { buildBrowser } from '../../scripts/build-browser.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

/** playwright's WebKit, or null with a reason — this suite is opt-in. */
async function webkitOrNull() {
  let webkit;
  try {
    ({ webkit } = await import('playwright'));
  } catch {
    return { browser: null, why: 'playwright is not installed (npm i -D playwright)' };
  }
  try {
    return { browser: await webkit.launch(), why: null };
  } catch (err) {
    return { browser: null, why: `webkit will not launch (npx playwright install webkit): ${err.message}` };
  }
}

/*
 * The page under test. A document SET in one memory provider, with a second
 * root imported by path — so this exercises the site layer (import graph, name
 * resolution) and not only the document engine, which is the half
 * packages/mdy-live-preview already demonstrates.
 *
 * `who` rather than `name`: source identity is merged over front matter and is
 * not overridable, so a document's `name` is its file's, never the field's.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>mdy in webkit</title>
<script type="module">
  const done = (v) => { window.__result = v; };
  try {
    const mdy = await import('./mdy.js');
    const files = new Map([
      ['main.mdy', [
        '% import style from "/style"',
        '% for (const p of $.find({ role: "member" })) {',
        '{{ style.render({ path: "card.mdy" }, { who: p.who }) }}',
        '% }',
        '---',
        '+++',
        'role: member',
        'who: Ada',
        '+++',
        '---',
        '+++',
        'role: member',
        'who: Grace',
        '+++',
      ].join('\\n')],
      ['style/card.mdy', '= {{ req.who }}'],
    ]);
    const { output } = await mdy.renderScriptSite('/', { fs: mdy.memoryFsProvider(files) });
    done({ ok: true, output, exports: Object.keys(mdy).length });
  } catch (err) {
    done({ ok: false, error: String((err && err.stack) || err) });
  }
</script>`;

test('the browser bundle renders a script-defined site in WebKit', async (t) => {
  const { browser, why } = await webkitOrNull();
  if (!browser) return t.skip(why);

  const { outDir } = await buildBrowser({ minify: true });

  // Served over HTTP, not file:// — module scripts and WebAssembly streaming
  // both need a real origin.
  const server = createServer(async (req, res) => {
    const path = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
    if (path === '/index.html') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(PAGE);
    }
    try {
      const body = await readFile(join(outDir, path.replace(/^\/+/, '')));
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((ready) => server.listen(0, ready));
  const { port } = server.address();

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__result !== undefined, { timeout: 60_000 });
    const result = await page.evaluate(() => window.__result);

    assert.deepEqual(pageErrors, [], 'the page must load and run without errors');
    assert.ok(result.ok, `render failed in WebKit: ${result.error}`);
    // Both members found by $.find, each rendered through the imported set.
    assert.match(result.output, /<h1 id="ada">Ada<\/h1>/);
    assert.match(result.output, /<h1 id="grace">Grace<\/h1>/);
    assert.ok(result.exports > 10, 'the bundle should expose the public API');
  } finally {
    await new Promise((closed) => server.close(closed));
    await browser.close();
  }
});

test('the wasm engines ship beside the bundle', async () => {
  // Their loaders fetch by filename relative to the bundle, so this is the
  // difference between a working artifact and one that fails in a webview.
  const { outDir, wasm } = await buildBrowser({ minify: true });
  const names = wasm.map((w) => w.file).sort();
  assert.ok(names.includes('lamassu.wasm'), `lamassu.wasm missing from ${outDir}: ${names}`);
  assert.ok(names.includes('nisaba.wasm'), `nisaba.wasm missing from ${outDir}: ${names}`);
  for (const w of wasm) assert.ok(w.bytes > 0, `${w.file} is empty`);
});
