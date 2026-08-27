import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeFsProvider, memoryFsProvider, watchByPolling } from '../src/fs-provider.js';

// --- memoryFsProvider --------------------------------------------------

test('memoryFsProvider: list finds *.mdy under a subdir, sorted, relative', async () => {
  const files = new Map([
    ['layouts/base.mdy', 'base'],
    ['layouts/posts/card.mdy', 'card'],
    ['content/about.mdy', 'about'],
    ['static/style.css', 'not mdy'], // must not appear
  ]);
  const fs = memoryFsProvider(files);
  assert.deepEqual(await fs.list('/', 'layouts'), ['base.mdy', 'posts/card.mdy']);
  assert.deepEqual(await fs.list('/', 'content'), ['about.mdy']);
});

test('memoryFsProvider: subdir "." lists every *.mdy in the whole vault', async () => {
  const files = new Map([
    ['layouts/base.mdy', 'base'],
    ['content/about.mdy', 'about'],
    ['notes/today.mdy', 'today'],
    ['static/style.css', 'not mdy'],
  ]);
  const fs = memoryFsProvider(files);
  assert.deepEqual(await fs.list('/', '.'), ['content/about.mdy', 'layouts/base.mdy', 'notes/today.mdy']);
});

test('memoryFsProvider: list on a missing subdir is empty, not an error', async () => {
  const fs = memoryFsProvider(new Map());
  assert.deepEqual(await fs.list('/', 'layouts'), []);
});

test('memoryFsProvider: read returns the current text; ENOENT for a missing path', async () => {
  const files = new Map([['site.yaml', 'title: X\n']]);
  const fs = memoryFsProvider(files);
  assert.equal(await fs.read('/', 'site.yaml'), 'title: X\n');
  await assert.rejects(fs.read('/', 'nope.yaml'), (err) => err.code === 'ENOENT');
});

test('memoryFsProvider: held by reference — a mutation after construction is visible', async () => {
  const files = new Map();
  const fs = memoryFsProvider(files);
  files.set('content/new.mdy', '+++\ntitle: New\n+++\nHi');
  assert.deepEqual(await fs.list('/', 'content'), ['new.mdy']);
  assert.equal(await fs.read('/', 'content/new.mdy'), '+++\ntitle: New\n+++\nHi');
});

test('memoryFsProvider: write adds/overwrites, remove deletes — both visible to list/read', async () => {
  const files = new Map([['content/about.mdy', 'old']]);
  const fs = memoryFsProvider(files);

  await fs.write('/', 'content/about.mdy', 'new');
  assert.equal(await fs.read('/', 'content/about.mdy'), 'new');

  await fs.write('/', 'content/new.mdy', '+++\ntitle: New\n+++\nHi');
  assert.deepEqual(await fs.list('/', 'content'), ['about.mdy', 'new.mdy']);

  await fs.remove('/', 'content/about.mdy');
  assert.deepEqual(await fs.list('/', 'content'), ['new.mdy']);
  await assert.rejects(fs.read('/', 'content/about.mdy'), (err) => err.code === 'ENOENT');
});

test('memoryFsProvider: readBinary/writeBinary hold real bytes; read()/readBinary() convert either way', async () => {
  const files = new Map();
  const fs = memoryFsProvider(files);
  const bytes = new Uint8Array([137, 80, 78, 71]); // arbitrary binary, not valid UTF-8 text

  await fs.writeBinary('/', 'static/logo.png', bytes);
  assert.deepEqual(await fs.readBinary('/', 'static/logo.png'), bytes);
  assert.equal(await fs.size('/', 'static/logo.png'), 4); // real byte length, not text-length approximation
  assert.equal(typeof (await fs.read('/', 'static/logo.png')), 'string'); // decodes without throwing

  await fs.write('/', 'content/about.mdy', 'hello');
  assert.deepEqual(await fs.readBinary('/', 'content/about.mdy'), new TextEncoder().encode('hello'));

  await assert.rejects(fs.readBinary('/', 'missing.png'), (err) => err.code === 'ENOENT');
});

test('memoryFsProvider: options.extensions: null lists every file, unfiltered', async () => {
  const files = new Map([
    ['content/about.mdy', 'mdy'],
    ['static/style.css', 'css'],
    ['static/search.js', 'js'],
    ['site.yaml', 'yaml'],
  ]);
  const fs = memoryFsProvider(files);
  assert.deepEqual(
    await fs.list('/', '.', { extensions: null }),
    ['content/about.mdy', 'site.yaml', 'static/search.js', 'static/style.css']
  );
  assert.deepEqual(await fs.list('/', 'static', { extensions: null }), ['search.js', 'style.css']);
});

test('memoryFsProvider: has no watch — nothing external can mutate the Map', () => {
  const fs = memoryFsProvider(new Map());
  assert.equal(fs.watch, undefined);
});

test('memoryFsProvider: mtime returns a Date (no real mtimes in memory)', async () => {
  const fs = memoryFsProvider(new Map());
  assert.ok((await fs.mtime('/', 'anything')) instanceof Date);
});

test('memoryFsProvider: size is the text length (no real bytes in memory); 0 for a missing path', async () => {
  const fs = memoryFsProvider(new Map([['note.mdy', 'hello']]));
  assert.equal(await fs.size('/', 'note.mdy'), 5);
  assert.equal(await fs.size('/', 'missing.mdy'), 0);
});

test('memoryFsProvider: options.extensions selects which files match', async () => {
  const files = new Map([
    ['content/about.mdy', 'mdy'],
    ['content/plain.md', 'md'],
    ['content/data.yaml', 'yaml'],
    ['content/data.yml', 'yml'],
    ['content/notes.txt', 'txt'],
  ]);
  const fs = memoryFsProvider(files);
  assert.deepEqual(await fs.list('/', 'content'), ['about.mdy']); // default: .mdy only
  assert.deepEqual(
    await fs.list('/', 'content', { extensions: ['.mdy', '.md', '.yaml', '.yml'] }),
    ['about.mdy', 'data.yaml', 'data.yml', 'plain.md']
  );
  assert.deepEqual(await fs.list('/', '.', { extensions: ['.txt'] }), ['content/notes.txt']);
});

// --- nodeFsProvider -------------------------------------------------------

test('nodeFsProvider: list/read/mtime against a real temp directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-fsprovider-'));
  after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'layouts'), { recursive: true });
  await writeFile(join(root, 'layouts', 'base.mdy'), 'base layout');

  const fs = nodeFsProvider();
  assert.deepEqual(await fs.list(root, 'layouts'), ['base.mdy']);
  assert.deepEqual(await fs.list(root, 'content'), []); // missing dir
  assert.equal(await fs.read(root, 'layouts/base.mdy'), 'base layout');
  assert.ok((await fs.mtime(root, 'layouts/base.mdy')) instanceof Date);
  assert.equal(await fs.size(root, 'layouts/base.mdy'), 'base layout'.length);
});

test('nodeFsProvider: subdir "." lists every *.mdy under the root, recursively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-fsprovider-'));
  after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'notes', 'today.mdy'), 'today');
  await writeFile(join(root, 'root.mdy'), 'root');
  await writeFile(join(root, 'ignore.txt'), 'not mdy');

  const fs = nodeFsProvider();
  assert.deepEqual(await fs.list(root, '.'), ['notes/today.mdy', 'root.mdy']);
});

test('nodeFsProvider: options.extensions selects which files match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-fsprovider-'));
  after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'content'), { recursive: true });
  await writeFile(join(root, 'content', 'about.mdy'), 'mdy');
  await writeFile(join(root, 'content', 'plain.md'), 'md');
  await writeFile(join(root, 'content', 'data.yaml'), 'yaml');

  const fs = nodeFsProvider();
  assert.deepEqual(await fs.list(root, 'content'), ['about.mdy']); // default: .mdy only
  assert.deepEqual(
    await fs.list(root, 'content', { extensions: ['.md', '.yaml'] }),
    ['data.yaml', 'plain.md']
  );
  assert.deepEqual(
    await fs.list(root, 'content', { extensions: null }),
    ['about.mdy', 'data.yaml', 'plain.md']
  );
});

test('nodeFsProvider: readBinary/writeBinary round-trip real bytes on disk, untouched by text encoding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-fsprovider-'));
  after(() => rm(root, { recursive: true, force: true }));

  const fs = nodeFsProvider();
  const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10, 26, 10]); // includes a PNG-like signature, and a NUL
  await fs.writeBinary(root, 'static/logo.png', bytes);
  // Node's readFile() returns a Buffer (a Uint8Array subclass) — compare by
  // value, not by exact class, since a plain Uint8Array is an equally valid
  // return per the interface.
  assert.deepEqual([...(await fs.readBinary(root, 'static/logo.png'))], [...bytes]);
  assert.equal(await fs.size(root, 'static/logo.png'), bytes.length);
});

test('nodeFsProvider: write creates parent dirs and writes text; remove deletes (missing path is not an error)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-fsprovider-'));
  after(() => rm(root, { recursive: true, force: true }));

  const fs = nodeFsProvider();
  await fs.write(root, 'content/nested/new.mdy', '+++\ntitle: New\n+++\nHi');
  assert.equal(await fs.read(root, 'content/nested/new.mdy'), '+++\ntitle: New\n+++\nHi');
  assert.deepEqual(await fs.list(root, 'content'), ['nested/new.mdy']);

  await fs.remove(root, 'content/nested/new.mdy');
  assert.deepEqual(await fs.list(root, 'content'), []);
  await fs.remove(root, 'content/never-existed.mdy'); // does not throw
});

test('nodeFsProvider: watch reports a recursive change under root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-fsprovider-'));
  after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'), { recursive: true });

  const fs = nodeFsProvider();
  const events = [];
  let notify;
  const seen = new Promise((resolve) => { notify = resolve; });
  const watcher = await fs.watch(root, (event) => {
    events.push(event);
    if (event.path === 'nested/new.mdy') notify();
  });
  try {
    await fs.write(root, 'nested/new.mdy', 'hello');
    await Promise.race([
      seen,
      new Promise((_, reject) => setTimeout(() => reject(new Error('watch: no event within 5s')), 5000)),
    ]);
    assert.ok(events.some((e) => e.path === 'nested/new.mdy'));
  } finally {
    watcher.close();
  }
});

// --- watchByPolling (opfsFsProvider's fallback, testable without a browser) ---

function fakeListMtimeProvider(initial) {
  const files = new Map(initial); // path -> mtime (number)
  return {
    files,
    provider: {
      async list(_root, _subdir, options = {}) {
        const extensions = options.extensions ?? ['.mdy'];
        return [...files.keys()].filter((p) => extensions.some((ext) => p.endsWith(ext))).sort();
      },
      async mtime(_root, path) {
        return new Date(files.get(path));
      },
    },
  };
}

test('watchByPolling: primes silently (no create events for pre-existing files), then reports create/modify/delete', async () => {
  const { files, provider } = fakeListMtimeProvider([['a.mdy', 1000]]);
  const events = [];
  const handle = await watchByPolling(provider, '/', (e) => events.push(e), { pollMs: 10 });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(events, []);

    files.set('b.mdy', 2000); // create
    files.set('a.mdy', 1500); // modify
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(events.some((e) => e.type === 'create' && e.path === 'b.mdy'));
    assert.ok(events.some((e) => e.type === 'modify' && e.path === 'a.mdy'));

    events.length = 0;
    files.delete('b.mdy');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(events.some((e) => e.type === 'delete' && e.path === 'b.mdy'));
  } finally {
    handle.close();
  }
});
