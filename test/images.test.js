import { test } from 'node:test';
import assert from 'node:assert/strict';

import { imageSize } from 'image-size';
import { memoryFsProvider } from '../index.js';
import { createResizeNative } from '../src/site/images.js';
import { makePng } from './png-fixture.js';

function setup(pngBytes) {
  const files = new Map([['static/logo.png', pngBytes]]);
  const fs = memoryFsProvider(files);
  const registered = new Map();
  const resize = createResizeNative({
    fs,
    root: '/',
    registerBinaryOutput: (path, bytes) => registered.set(path, bytes),
  });
  return { resize, registered };
}

function fileDoc(overrides = {}) {
  return { kind: 'file', path: 'static/logo.png', ext: '.png', width: 40, height: 20, ...overrides };
}

test('resize: exact width+height produces a real, correctly-sized PNG registered as a binary output', async () => {
  const { resize, registered } = setup(makePng(40, 20));
  const result = await resize(fileDoc(), { width: 10, height: 10 });

  // Flattened, not "static/logo-...": buildSite/serve.js already flatten
  // static/'s contents straight to the dist root (static/logo.png is
  // served at /logo.png, not /static/logo.png) — a resize output has to
  // land in that same space or its URL wouldn't match reality.
  assert.equal(result.path, 'logo-10x10.png');
  assert.equal(result.url, '/logo-10x10.png');
  assert.equal(result.width, 10);
  assert.equal(result.height, 10);

  assert.ok(registered.has('logo-10x10.png'));
  const outDims = imageSize(Buffer.from(registered.get('logo-10x10.png')));
  assert.equal(outDims.width, 10);
  assert.equal(outDims.height, 10);
});

test('resize: a source NOT under static/ keeps its full path — only the static/ prefix is special-cased', async () => {
  const files = new Map([['content/photos/sunset.png', makePng(40, 20)]]);
  const fs = memoryFsProvider(files);
  const registered = new Map();
  const resize = createResizeNative({ fs, root: '/', registerBinaryOutput: (p, b) => registered.set(p, b) });

  const result = await resize(fileDoc({ path: 'content/photos/sunset.png' }), { width: 10, height: 10 });
  assert.equal(result.path, 'content/photos/sunset-10x10.png');
  assert.equal(result.url, '/content/photos/sunset-10x10.png');
});

test('resize: width alone preserves the source aspect ratio', async () => {
  const { resize } = setup(makePng(40, 20)); // 2:1
  const result = await resize(fileDoc(), { width: 100 });
  assert.equal(result.width, 100);
  assert.equal(result.height, 50);
});

test('resize: height alone preserves the source aspect ratio', async () => {
  const { resize } = setup(makePng(40, 20)); // 2:1
  const result = await resize(fileDoc(), { height: 10 });
  assert.equal(result.width, 20);
  assert.equal(result.height, 10);
});

test('resize: memoized — the same (source, size) is only decoded/resized/encoded once', async () => {
  const { resize, registered } = setup(makePng(40, 20));
  const [a, b] = await Promise.all([resize(fileDoc(), { width: 10 }), resize(fileDoc(), { width: 10 })]);
  assert.equal(a.path, b.path);
  assert.equal(registered.size, 1);
});

test('resize: an unsupported extension rejects clearly', async () => {
  const { resize } = setup(makePng(40, 20));
  await assert.rejects(resize(fileDoc({ path: 'static/photo.jpg', ext: '.jpg' }), { width: 10 }), /unsupported image type/);
});

test('resize: a file document with no known width/height rejects clearly', async () => {
  const { resize } = setup(makePng(40, 20));
  await assert.rejects(resize(fileDoc({ width: undefined, height: undefined }), { width: 10 }), /no known width\/height/);
});

test('resize: neither width nor height given rejects clearly', async () => {
  const { resize } = setup(makePng(40, 20));
  await assert.rejects(resize(fileDoc(), {}), /pass at least one of/);
});

test('resize: a document with no ext (not a file document at all) rejects clearly', async () => {
  const { resize } = setup(makePng(40, 20));
  await assert.rejects(resize({ kind: 'page', path: 'about.mdy' }, { width: 10 }), /expected a file document/);
});

test('resize: works on a script-mode raw document with no `kind` at all (walkRawSources shape)', async () => {
  const { resize } = setup(makePng(40, 20));
  // No `kind` field — same shape a script-defined site's $.find/$.findOne
  // returns (src/vault.js's walkRawSources), unlike edubba's own
  // conventional `kind: 'file'` records.
  const result = await resize({ path: 'static/logo.png', name: 'logo.png', ext: '.png', width: 40, height: 20 }, { width: 10 });
  assert.equal(result.path, 'logo-10x5.png');
});
