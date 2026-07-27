import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkVault, walkFiles, walkRawSources } from '../src/vault.js';
import { memoryFsProvider, nodeFsProvider } from '../src/fs-provider.js';
import { openDocumentSet } from '../src/mdy.js';
import { makePng } from './png-fixture.js';

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

// --- walkRawSources ------------------------------------------------------
// The "a whole directory IS the document set" primitive: every file gets
// raw identity (path/name/ext/size/mtime); only .mdy files carry real text,
// so mdy's own parser can extract front matter and a live template body.

test('walkRawSources: a .mdy file gets its real text, front matter extractable via openDocumentSet', async () => {
  const files = new Map([
    ['main.mdy', 'title: Hello\n+++\nbody'],
    ['other.mdy', 'title: Other\n+++\nirrelevant'],
  ]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });

  assert.equal(sources.length, 2);
  const set = await openDocumentSet(sources);
  const index = set.docs.find((d) => d.data.path === 'main.mdy');
  assert.equal(index.data.title, 'Hello'); // front matter, merged in by mdy's own parser
  assert.equal(index.data.name, 'main.mdy');
  assert.equal(index.data.ext, '.mdy');
  assert.equal(typeof index.data.size, 'number');
  assert.ok(index.data.mtime instanceof Date);
  assert.equal('section' in index.data, false); // no interpretation beyond raw identity
});

test('walkRawSources: a non-.mdy file gets a placeholder body, never its real content', async () => {
  const files = new Map([['static/logo.png', 'not-really-png-bytes']]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });

  assert.equal(sources.length, 1);
  assert.notEqual(sources[0].text, 'not-really-png-bytes');
  assert.equal(sources[0].meta.path, 'static/logo.png');
  assert.equal(sources[0].meta.name, 'logo.png');
  assert.equal(sources[0].meta.ext, '.png');
});

test('walkRawSources: a real image gets width/height (header-only, via image-size) — real identity, not interpretation', async () => {
  const files = new Map([['static/logo.png', makePng(40, 20)]]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });

  assert.equal(sources.length, 1);
  assert.equal(sources[0].meta.width, 40);
  assert.equal(sources[0].meta.height, 20);
});

test('walkRawSources: a corrupt/unsupported "image" still gets its raw record, just no width/height', async () => {
  const files = new Map([['static/logo.png', 'not-really-png-bytes']]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });

  assert.equal(sources.length, 1);
  assert.equal('width' in sources[0].meta, false);
  assert.equal('height' in sources[0].meta, false);
});

test('walkRawSources: a .md file gets its real text in meta.body, never compiled as a template, plus inline #hashtags', async () => {
  const files = new Map([
    ['posts/note.md', 'A note about #history.\n\nThis --- is not a separator, {{ this }} is not a tag.'],
  ]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });

  assert.equal(sources.length, 1);
  const { text, meta } = sources[0];
  assert.notEqual(text, meta.body); // text is the placeholder — never handed to mdy's parser/compiler
  assert.equal(meta.body, 'A note about #history.\n\nThis --- is not a separator, {{ this }} is not a tag.');
  assert.deepEqual(meta.tags, ['history']);
  assert.equal(meta.path, 'posts/note.md');
});

test('walkRawSources: a .md file with no hashtags gets no tags field at all', async () => {
  const files = new Map([['posts/note.md', 'Just plain prose.']]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });
  assert.equal('tags' in sources[0].meta, false);
});

test('walkRawSources: a .yaml file is parsed as data — its own fields merged in, only `path` reserved', async () => {
  const files = new Map([['author.yaml', 'name: Ada Lovelace\nrole: mathematician\n']]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });

  assert.equal(sources.length, 1);
  const { text, meta } = sources[0];
  assert.notEqual(text, sources[0].meta.name); // placeholder body — data lives in meta, not text
  // The record's own `name` wins over the file's basename identity — only
  // `path` is structurally reserved (other raw-mode code resolves
  // documents by it); name/ext/size/mtime are defaults, not a mask.
  assert.equal(meta.name, 'Ada Lovelace');
  assert.equal(meta.role, 'mathematician');
  assert.equal(meta.path, 'author.yaml');
});

test('walkRawSources: a .yaml file that declares no `name` still falls back to the file\'s own identity', async () => {
  const files = new Map([['config.yaml', 'setting: on\n']]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });
  assert.equal(sources[0].meta.name, 'config.yaml');
  assert.equal(sources[0].meta.setting, 'on');
});

test('walkRawSources: a non-mapping .yaml (a list) degrades to raw identity, not a thrown error', async () => {
  const files = new Map([['list.yaml', '- one\n- two\n']]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].meta.path, 'list.yaml');
  assert.equal(sources[0].meta.name, 'list.yaml');
});

test('walkRawSources: an empty .yaml file is just an identity record, no parsed fields', async () => {
  const files = new Map([['empty.yaml', '']]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].meta.path, 'empty.yaml');
});

test('walkRawSources: dist/, node_modules/, and dotfiles/dot-directories are excluded', async () => {
  const files = new Map([
    ['main.mdy', '+++\nhi'],
    ['dist/index.html', 'built'],
    ['node_modules/x/index.js', 'dep'],
    ['.git/HEAD', 'ref'],
    ['.env', 'secret'],
  ]);
  const sources = await walkRawSources('/', { fs: memoryFsProvider(files) });
  assert.deepEqual(sources.map((s) => s.meta.path), ['main.mdy']);
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
