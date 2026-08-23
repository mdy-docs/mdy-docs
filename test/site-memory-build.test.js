import { test } from 'node:test';
import assert from 'node:assert/strict';

import { imageSize } from 'image-size';
import { memoryFsProvider } from '../index.js';
import { renderSite } from '../src/build.js';
import { makePng } from './png-fixture.js';

// The fs-provider contract itself (list/read/mtime, both providers) is
// tested in test/fs-provider.test.js — this file only covers mdy-docs' own
// payoff: renderSite (every site is a script-defined one — see
// script-site.js) working entirely in memory, no disk access at all, which
// is what makes web/'s browser editor possible.

test('renderSite over memoryFsProvider builds a real site with zero disk I/O', async () => {
  const files = new Map([
    ['main.mdy', '+++\n% const body = $.render({ path: "hello.mdy" })\n% $.emit("hello/index.html", "<html><body>" + body + "</body></html>")'],
    ['hello.mdy', 'title: Hello\n+++\nBuilt entirely in memory.'],
  ]);
  const fs = memoryFsProvider(files);

  const { outputs } = await renderSite('/', { fs });
  assert.ok(outputs.has('hello/index.html'));
  const html = outputs.get('hello/index.html');
  assert.match(html, /Built entirely in memory\./);
  assert.match(html, /<html><body>/);
});

test('renderSite over memoryFsProvider: an edit is reflected on the next render (live-editing shape)', async () => {
  const files = new Map([
    ['main.mdy', '+++\n% const body = $.render({ path: "note.mdy" })\n% $.emit("note/index.html", body)'],
    ['note.mdy', 'title: Draft one\n+++\nfirst version'],
  ]);
  const fs = memoryFsProvider(files);

  const first = await renderSite('/', { fs });
  assert.match(first.outputs.get('note/index.html'), /first version/);

  files.set('note.mdy', 'title: Draft one\n+++\nsecond version');
  const second = await renderSite('/', { fs });
  assert.match(second.outputs.get('note/index.html'), /second version/);
});

test('a script can $.find raw file records — static assets are queryable even though they are not renderable pages', async () => {
  const files = new Map([
    [
      'main.mdy',
      '+++\n' +
        '% const images = $.find({ ext: ".png" })\n' +
        '% const lines = images.map((f) => "asset: " + f.path + " (" + f.size + " bytes)").join("\\n")\n' +
        '% $.emit("hello/index.html", lines)',
    ],
    ['static/logo.png', 'fake-png-bytes'], // 14 chars — memoryFsProvider's size() is text length
    ['static/style.css', 'body{}'],
  ]);
  const fs = memoryFsProvider(files);

  const { outputs } = await renderSite('/', { fs });
  const html = outputs.get('hello/index.html');
  assert.match(html, /asset: static\/logo\.png \(14 bytes\)/);
  assert.doesNotMatch(html, /style\.css/); // ext: '.png' filter excludes it
});

test('a script can $.resize a raw image record — a real, correctly-sized thumbnail lands in binaryOutputs', async () => {
  const files = new Map([
    [
      'main.mdy',
      '+++\n' +
        '% const logo = $.findOne({ path: "static/logo.png" })\n' +
        '% const thumb = $.resize(logo, { width: 20 })\n' +
        '% $.emit("hello/index.html", "<img src=" + JSON.stringify(thumb.url) + " width=" + JSON.stringify(String(thumb.width)) + " height=" + JSON.stringify(String(thumb.height)) + ">")',
    ],
    ['static/logo.png', makePng(40, 20)], // 2:1 aspect ratio
  ]);
  const fs = memoryFsProvider(files);

  const { outputs, binaryOutputs } = await renderSite('/', { fs });
  const html = outputs.get('hello/index.html');
  // Flattened, matching static/'s own dist-root convention (see images.js).
  assert.match(html, /<img src="\/logo-20x10\.png" width="20" height="10">/);

  assert.ok(binaryOutputs.has('logo-20x10.png'));
  const thumbDims = imageSize(Buffer.from(binaryOutputs.get('logo-20x10.png')));
  assert.equal(thumbDims.width, 20);
  assert.equal(thumbDims.height, 10);
  assert.equal(thumbDims.type, 'png');
});

test('an entry document can $.emit its own output files — a script defining a feature (a tag index), entirely in template code', async () => {
  // Proves mdy-docs' $.emit is genuinely enough to move "compute this
  // aggregate, write N pages for it" out of any host code and into the
  // entry document's own template body — the primitive script-defined
  // sites are built on (see docs/site-plan.md's "Toward a script-defined
  // site" note).
  const files = new Map([
    ['posts/hello.mdy', 'title: Hello\ntags: [wasm]\n+++\nHi.'],
    ['posts/other.mdy', 'title: Other\ntags: [wasm]\n+++\nMore.'],
    ['posts/unrelated.mdy', 'title: Unrelated\ntags: [misc]\n+++\nSkip me.'],
    [
      'main.mdy',
      '+++\n' +
        '% const posts = $.find({}).filter((d) => d.path && d.path.indexOf("posts/") === 0)\n' +
        '% const wasmPosts = posts.filter((p) => (p.tags || []).includes("wasm"))\n' +
        '% $.emit("tags/wasm/index.html", "<ul>" + wasmPosts.map((p) => "<li>" + p.title + "</li>").join("") + "</ul>")\n' +
        'Tag pages generated.',
    ],
  ]);

  const { outputs } = await renderSite('/', { fs: memoryFsProvider(files) });

  // The entry document itself still has a return value, alongside the
  // side effect — $.emit doesn't replace it, though a whole-site build
  // (renderSite/buildSite) never writes that return value anywhere; only
  // $.emit output lands in `outputs`.
  assert.ok(!outputs.has('index.html'));

  // The emitted output landed in `outputs`, at the path the script chose.
  const tagPage = outputs.get('tags/wasm/index.html');
  assert.match(tagPage, /<li>Hello<\/li>/);
  assert.match(tagPage, /<li>Other<\/li>/);
  assert.doesNotMatch(tagPage, /Unrelated/); // tagged "misc", correctly excluded
});
