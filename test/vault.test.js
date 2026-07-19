import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkVault, walkFiles } from '../src/vault.js';
import { memoryFsProvider, nodeFsProvider } from '../src/fs-provider.js';

test('walkVault: raw sources, no interpretation beyond path + mtime identity', async () => {
  const files = new Map([
    ['notes/today.mdy', 'title: Today\n+++\nWhat happened.'],
    ['notes/ideas.mdy', 'A loose idea.'],
  ]);
  const sources = await walkVault('/', { fs: memoryFsProvider(files) });

  assert.equal(sources.length, 2);
  const today = sources.find((s) => s.meta.path === 'notes/today.mdy');
  assert.equal(today.text, 'title: Today\n+++\nWhat happened.');
  assert.deepEqual(Object.keys(today.meta).sort(), ['mtime', 'path']);
  assert.ok(today.meta.mtime instanceof Date);
  // No url, section, slug, date, title, draft — that's all consumer-specific.
  assert.deepEqual(Object.keys(today.meta), ['path', 'mtime']);
});

test('walkVault: subdir scopes the walk and prefixes the returned path', async () => {
  const files = new Map([
    ['layouts/base.mdy', 'base'],
    ['content/about.mdy', 'about'],
  ]);
  const fs = memoryFsProvider(files);

  const layouts = await walkVault('/', { fs, subdir: 'layouts' });
  assert.deepEqual(layouts.map((s) => s.meta.path), ['layouts/base.mdy']);

  const content = await walkVault('/', { fs, subdir: 'content' });
  assert.deepEqual(content.map((s) => s.meta.path), ['content/about.mdy']);
});

test('walkVault: no subdir option walks the whole vault', async () => {
  const files = new Map([
    ['a/one.mdy', '1'],
    ['b/two.mdy', '2'],
  ]);
  const sources = await walkVault('/', { fs: memoryFsProvider(files) });
  assert.deepEqual(sources.map((s) => s.meta.path).sort(), ['a/one.mdy', 'b/two.mdy']);
});

test('walkVault: an empty or missing vault yields no sources, not an error', async () => {
  assert.deepEqual(await walkVault('/', { fs: memoryFsProvider(new Map()) }), []);
});

test('walkVault: options.extensions widens (or narrows) which files are walked', async () => {
  const files = new Map([
    ['content/about.mdy', 'mdy'],
    ['content/plain.md', 'md'],
    ['content/data.yaml', 'yaml'],
  ]);
  const fs = memoryFsProvider(files);

  const defaultOnly = await walkVault('/', { fs, subdir: 'content' });
  assert.deepEqual(defaultOnly.map((s) => s.meta.path), ['content/about.mdy']);

  const all = await walkVault('/', { fs, subdir: 'content', extensions: ['.mdy', '.md', '.yaml'] });
  assert.deepEqual(all.map((s) => s.meta.path).sort(), [
    'content/about.mdy',
    'content/data.yaml',
    'content/plain.md',
  ]);
});

// --- walkFiles ---------------------------------------------------------

test('walkFiles: every file, any extension, by default — no text read', async () => {
  const files = new Map([
    ['content/about.mdy', 'title: About\n+++\nHi'],
    ['static/logo.png', 'not-really-png-bytes'],
    ['static/style.css', 'body { color: red }'],
    ['site.yaml', 'title: Test\n'],
  ]);
  const entries = await walkFiles('/', { fs: memoryFsProvider(files) });

  assert.deepEqual(entries.map((e) => e.path).sort(), [
    'content/about.mdy',
    'site.yaml',
    'static/logo.png',
    'static/style.css',
  ]);
  const logo = entries.find((e) => e.path === 'static/logo.png');
  assert.equal(logo.name, 'logo.png');
  assert.equal(logo.ext, '.png');
  assert.equal(logo.size, 'not-really-png-bytes'.length);
  assert.ok(logo.mtime instanceof Date);
  assert.equal(logo.text, undefined); // never read — safe for real binary content
});

test('walkFiles: subdir scopes the walk and prefixes path the same way walkVault does', async () => {
  const files = new Map([
    ['static/logo.png', 'x'],
    ['content/about.mdy', 'y'],
  ]);
  const entries = await walkFiles('/', { fs: memoryFsProvider(files), subdir: 'static' });
  assert.deepEqual(entries.map((e) => e.path), ['static/logo.png']);
});

test('walkFiles: a dotfile has no ext; options.extensions narrows like list() does', async () => {
  const files = new Map([
    ['.gitignore', 'dist/'],
    ['static/logo.png', 'x'],
    ['static/logo.jpg', 'y'],
  ]);
  const fs = memoryFsProvider(files);

  const all = await walkFiles('/', { fs });
  const dotfile = all.find((e) => e.path === '.gitignore');
  assert.equal(dotfile.ext, '');

  const pngOnly = await walkFiles('/', { fs, extensions: ['.png'] });
  assert.deepEqual(pngOnly.map((e) => e.path), ['static/logo.png']);
});

test('walkFiles: defaults to the real filesystem and reports real sizes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-walkfiles-'));
  after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'static'), { recursive: true });
  await writeFile(join(root, 'static', 'logo.png'), Buffer.from([1, 2, 3, 4, 5]));

  const entries = await walkFiles(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'static/logo.png');
  assert.equal(entries[0].size, 5);
});

test('walkVault: defaults to the real filesystem and works against a real directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-walk-'));
  after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'wiki'), { recursive: true });
  await writeFile(join(root, 'wiki', 'home.mdy'), 'title: Home\n+++\nWelcome.');

  const sources = await walkVault(root); // no options.fs — default nodeFsProvider()
  assert.equal(sources.length, 1);
  assert.equal(sources[0].meta.path, 'wiki/home.mdy');
  assert.equal(sources[0].text, 'title: Home\n+++\nWelcome.');

  // Sanity: nodeFsProvider is genuinely what's used by default.
  const viaExplicitProvider = await walkVault(root, { fs: nodeFsProvider() });
  assert.deepEqual(
    viaExplicitProvider.map((s) => ({ text: s.text, path: s.meta.path })),
    sources.map((s) => ({ text: s.text, path: s.meta.path }))
  );
});
