import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// opfsFsProvider only runs in a real browser (navigator.storage.getDirectory,
// FileSystemObserver) — there is nothing to fake in Node that would exercise
// real OPFS semantics, so this drives an actual headless Chromium via
// Playwright instead. Skips cleanly (not a failure) wherever `playwright` or
// its Chromium binary aren't available — the other test files cover
// everything about this package that doesn't need a real browser.

const here = dirname(fileURLToPath(import.meta.url));
const fsProviderSource = await readFile(join(here, '..', 'src', 'fs-provider.js'), 'utf8');

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/fs-provider.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(fsProviderSource);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>opfs test</title>');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Launches headless Chromium on a page that can `import('/fs-provider.js')`,
 * runs `fn` in that page context via page.evaluate, and tears everything
 * down. Returns `undefined` (after calling `t.skip(...)`) if no real browser
 * is available here, rather than failing the run. */
async function inBrowser(t, fn) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    t.skip('playwright is not installed');
    return undefined;
  }

  const server = await startServer();
  after(() => server.close());

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    t.skip(`no Chromium binary available (${err.message})`);
    return undefined;
  }
  after(() => browser.close());

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  return page.evaluate(fn);
}

test('opfsFsProvider: list/read/write/remove/mtime against real OPFS, roots stay isolated', async (t) => {
  const result = await inBrowser(t, async () => {
    const { opfsFsProvider } = await import('/fs-provider.js');
    const fs = opfsFsProvider();

    await fs.write('vault-a', 'content/about.mdy', '+++\ntitle: About\n+++\nHi');
    await fs.write('vault-a', 'content/nested/note.md', 'plain');
    await fs.write('vault-b', 'content/about.mdy', 'a different vault entirely');

    const listed = await fs.list('vault-a', 'content', { extensions: ['.mdy'] });
    const listedAll = await fs.list('vault-a', '.', { extensions: ['.mdy', '.md'] });
    const listedUnfiltered = await fs.list('vault-a', 'content', { extensions: null });
    const text = await fs.read('vault-a', 'content/about.mdy');
    const otherVaultText = await fs.read('vault-b', 'content/about.mdy');
    const mtime = await fs.mtime('vault-a', 'content/about.mdy');
    const size = await fs.size('vault-a', 'content/about.mdy');
    const missingSubdir = await fs.list('vault-a', 'does-not-exist');

    await fs.remove('vault-a', 'content/about.mdy');
    const afterRemove = await fs.list('vault-a', 'content', { extensions: ['.mdy'] });

    return {
      listed,
      listedAll,
      listedUnfiltered,
      text,
      otherVaultText,
      mtimeIsRecent: Date.now() - mtime.getTime() < 60_000,
      size,
      missingSubdir,
      afterRemove,
    };
  });
  if (result === undefined) return; // skipped

  assert.deepEqual(result.listed, ['about.mdy']);
  assert.deepEqual(result.listedAll, ['content/about.mdy', 'content/nested/note.md']);
  assert.deepEqual(result.listedUnfiltered, ['about.mdy', 'nested/note.md']);
  assert.equal(result.text, '+++\ntitle: About\n+++\nHi');
  assert.equal(result.otherVaultText, 'a different vault entirely');
  assert.ok(result.mtimeIsRecent);
  assert.equal(result.size, '+++\ntitle: About\n+++\nHi'.length);
  assert.deepEqual(result.missingSubdir, []);
  assert.deepEqual(result.afterRemove, []);
});

test('opfsFsProvider: readBinary/writeBinary round-trip real bytes, untouched by text encoding', async (t) => {
  const result = await inBrowser(t, async () => {
    const { opfsFsProvider } = await import('/fs-provider.js');
    const fs = opfsFsProvider();

    const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10, 26, 10]);
    await fs.writeBinary('binary-vault', 'static/logo.png', bytes);
    const roundTripped = await fs.readBinary('binary-vault', 'static/logo.png');
    const size = await fs.size('binary-vault', 'static/logo.png');

    return { roundTripped: [...roundTripped], size };
  });
  if (result === undefined) return; // skipped

  assert.deepEqual(result.roundTripped, [0, 255, 137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(result.size, 10);
});

test('opfsFsProvider: watch() via native FileSystemObserver reports a write made after it starts', async (t) => {
  const result = await inBrowser(t, async () => {
    const { opfsFsProvider } = await import('/fs-provider.js');
    const fs = opfsFsProvider();
    const root = 'watch-vault';
    const events = [];

    const handle = await fs.watch(root, (event) => events.push(event));
    await fs.write(root, 'live.mdy', 'hello');

    const deadline = Date.now() + 5000;
    while (!events.some((e) => e.path.endsWith('live.mdy')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    handle.close();

    return { usedObserver: typeof FileSystemObserver !== 'undefined', events };
  });
  if (result === undefined) return; // skipped

  assert.equal(result.usedObserver, true); // headless Chromium here ships FileSystemObserver
  assert.ok(result.events.some((e) => e.path.endsWith('live.mdy') && e.type === 'create'));
});
