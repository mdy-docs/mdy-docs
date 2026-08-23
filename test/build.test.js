import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

import { imageSize } from 'image-size';
import { buildSite, urlToOutFile } from '../src/build.js';
import { makePng } from './png-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleBlog = join(here, '..', 'examples', 'blog');

// --- pure helpers ---------------------------------------------------------

test('urlToOutFile: pretty URLs land on index.html', () => {
  assert.equal(urlToOutFile('/'), 'index.html');
  assert.equal(urlToOutFile('/posts/hello/'), 'posts/hello/index.html');
});

// --- building the example blog: a script-defined site (main.mdy) — every
// site is one now (the conventional content/layouts/site.yaml pipeline was
// removed; see docs/site-plan.md's "Toward a script-defined site"). Every
// one of these tests exercises renderSite's dispatch to renderScriptSite
// (src/build.js). See examples/blog/main.mdy itself for the site's
// whole definition. --------------------------------------------------------

const outDir = await mkdtemp(join(tmpdir(), 'mdy-test-'));
after(() => rm(outDir, { recursive: true, force: true }));

const result = await buildSite(exampleBlog, { outDir });
const page = (p) => readFile(join(outDir, p), 'utf8');

test('build reports what it wrote', () => {
  assert.equal(result.outDir, outDir);
  // 3 posts (2 .mdy + 1 .md — author.yaml is data-only, no page of its
  // own) + about + homepage + 5 tag pages (history/tools/wasm/wet/writing)
  // + tags index + 404 + feed + sitemap + robots + search-index.json
  assert.equal(result.pages, 16);
});

test('every human-facing page is reachable by clicking <a href> links starting from /', async () => {
  // A page nobody links to is a page nobody finds — this is not the same
  // guarantee as "the file got written" (see the test above). Scope is
  // .html only: feed.xml, sitemap.xml, and robots.txt are machine-facing
  // and deliberately NOT in the click graph (see the tests below for how
  // each is actually discovered). 404.html has one demo-only link here —
  // real sites don't link their own error page — but stays in scope
  // because that link exists.
  const entries = await readdir(outDir, { withFileTypes: true, recursive: true });
  const all = new Set(
    entries
      .filter((e) => e.isFile() && e.name.endsWith('.html'))
      .map((e) => join(e.parentPath ?? e.path, e.name).slice(outDir.length + 1).split(sep).join('/'))
  );

  // 404.html is a literal filename, not a pretty URL — urlToOutFile would
  // mangle it into 404.html/index.html.
  const hrefToFile = (href) => (href.endsWith('.html') ? href.slice(1) : urlToOutFile(href));

  const visited = new Set();
  const queue = ['index.html'];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const html = await readFile(join(outDir, file), 'utf8');
    for (const m of html.matchAll(/<a\s+href="(\/[^"]*)"/g)) {
      const target = hrefToFile(m[1]);
      if (!visited.has(target)) queue.push(target);
    }
  }

  assert.deepEqual([...all].filter((f) => !visited.has(f)).sort(), []);
});

test('RSS is discoverable via <link rel="alternate"> autodiscovery, not a nav link', async () => {
  const html = await page('index.html');
  assert.match(
    html,
    /<link rel="alternate" type="application\/rss\+xml" title="Tablet House" href="\/feed\.xml">/
  );
  assert.doesNotMatch(html, /<a\s+href="\/feed\.xml"/);
});

test('the sitemap is pointed to from robots.txt, not linked from any page', async () => {
  const html = await page('index.html');
  assert.doesNotMatch(html, /<a\s+href="\/sitemap\.xml"/);
  const robots = await page('robots.txt');
  assert.match(robots, /^User-agent: \*/);
  assert.match(robots, /Sitemap: https:\/\/example\.com\/sitemap\.xml$/m);
});

test('a post renders through post layout and base shell', async () => {
  const html = await page('posts/hello/index.html');
  assert.match(html, /<!doctype html>/);
  assert.match(html, /<title>Hello world — Tablet House<\/title>/);
  assert.match(html, /<h1 id="[^"]*">Hello world<\/h1>/);
  assert.match(html, /<em>2026-07-18<\/em>/); // post layout's //{{ req.date }}//, from front matter, not the filename
  assert.match(html, /tablet house is open/);
});

test("main.mdy's own $.render-computed `related` surfaces posts sharing a tag, excluding itself", async () => {
  // diggings and hello both carry #writing — related is computed by the
  // script itself (main.mdy), passed into layouts/post.mdy as context,
  // not a $.find the layout runs itself (script mode has no kind/section
  // convention for a layout to query against).
  const diggings = await page('posts/diggings/index.html');
  assert.match(diggings, /More like this:.*<a href="\/posts\/hello\/">Hello world<\/a>/s);

  const hello = await page('posts/hello/index.html');
  assert.match(hello, /More like this:.*<a href="\/posts\/diggings\/">Diggings<\/a>/s);
  assert.doesNotMatch(diggings, />Diggings<\/a>/); // never lists itself
});

test('the homepage lists posts newest-first via the list layout', async () => {
  const html = await page('index.html');
  assert.match(html, /<title>Tablet House<\/title>/);
  assert.match(html, /<a href="\/posts\/hello\/">Hello world<\/a>/);
  assert.match(html, /<a href="\/posts\/diggings\/">Diggings<\/a>/);
  assert.ok(
    html.indexOf('/posts/hello/') < html.indexOf('/posts/diggings/'),
    'hello (2026-07-18) sorts before diggings (2026-06-01)'
  );
});

test('the about page uses the page layout, and its own $.resize/$.render calls work', async () => {
  const html = await page('about/index.html');
  assert.match(html, /<h1 id="[^"]*">About<\/h1>/);
  assert.match(html, /<strong>mdy-docs<\/strong>/);
  assert.match(html, /<img src="\/logo-120x84\.png" alt="A stylized clay tablet">/);
  assert.match(html, /CC0-1\.0 — generated for this example/); // its static/logo.png.mdy sidecar, $.render'd directly
  assert.match(html, /This week's guest scribe is <strong>Grace Hopper<\/strong>/); // author.yaml, a data-only record
});

test('static files pass through', () => {
  assert.ok(existsSync(join(outDir, 'style.css')));
});

test('static/logo.png is published flattened to the dist root, but its metadata sidecar is not published at all', () => {
  assert.ok(existsSync(join(outDir, 'logo.png')));
  assert.ok(!existsSync(join(outDir, 'logo.png.mdy')));
  assert.ok(!existsSync(join(outDir, 'static')));
});

// --- tags, feeds, drafts ----------------------------------------------------

test('tag pages collect every page carrying the tag (posts AND the about page), newest first', async () => {
  const html = await page('tags/writing/index.html');
  assert.match(html, /<title>#writing — Tablet House<\/title>/);
  assert.match(html, /Tagged “writing”/);
  assert.match(html, /<a href="\/posts\/hello\/">Hello world<\/a>/);
  assert.match(html, /<a href="\/posts\/diggings\/">Diggings<\/a>/);
  assert.match(html, /<a href="\/about\/">About<\/a>/);
});

test('the tags index lists the census', async () => {
  const html = await page('tags/index.html');
  assert.match(html, /<a href="\/tags\/writing\/">writing<\/a> \(3\)/); // hello + diggings + about
  assert.match(html, /<a href="\/tags\/wasm\/">wasm<\/a> \(1\)/);
  assert.match(html, /<a href="\/tags\/history\/">history<\/a> \(2\)/); // diggings + the .md post
  assert.match(html, /<a href="\/tags\/tools\/">tools<\/a> \(1\)/);
  assert.match(html, /<a href="\/tags\/wet\/">wet<\/a> \(1\)/); // the .md post's inline hashtag
});

test('404.html comes from layouts/404.mdy, through the base shell', async () => {
  const html = await page('404.html');
  assert.match(html, /<title>Not found — Tablet House<\/title>/);
  assert.match(html, /no tablet at this address/);
});

test('feed.xml: raw RSS with absolute links, dates (via $.rfc822), and summaries', async () => {
  const xml = await page('feed.xml');
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<rss/);
  assert.match(xml, /<link>https:\/\/example\.com\/posts\/hello\/<\/link>/);
  assert.match(xml, /<pubDate>Sat, 18 Jul 2026 00:00:00 GMT<\/pubDate>/);
  assert.match(xml, /<description>First post, mostly about wasm and writing\./);
  assert.doesNotMatch(xml, /<body>/);
});

test('sitemap.xml covers every pretty URL, 404 excluded', async () => {
  const xml = await page('sitemap.xml');
  assert.match(xml, /<loc>https:\/\/example\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/posts\/hello\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/tags\/writing\/<\/loc>/);
  assert.doesNotMatch(xml, /404/);
});

test('drafts are excluded by default and included with { drafts: true }', async () => {
  assert.ok(!existsSync(join(outDir, 'posts/clay-tablets')));
  const draftsDir = await mkdtemp(join(tmpdir(), 'mdy-drafts-'));
  after(() => rm(draftsDir, { recursive: true, force: true }));
  await buildSite(exampleBlog, { outDir: draftsDir, drafts: true });
  const html = await readFile(join(draftsDir, 'posts/clay-tablets/index.html'), 'utf8');
  assert.match(html, /<h1 id="[^"]*">Clay tablets<\/h1>/);
});

test('future-dated pages are excluded relative to `now`', async () => {
  const futureDir = await mkdtemp(join(tmpdir(), 'mdy-future-'));
  after(() => rm(futureDir, { recursive: true, force: true }));
  await buildSite(exampleBlog, { outDir: futureDir, now: new Date('2026-06-15') });
  assert.ok(!existsSync(join(futureDir, 'posts/hello')), 'hello (2026-07-18) is in the future');
  assert.ok(existsSync(join(futureDir, 'posts/diggings/index.html')));
});

test('--entry picks a different entry document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mdy-entry-'));
  after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'main.mdy'), '+++\n% $.emit("index.html", "default entry")');
  await writeFile(join(dir, 'other.mdy'), '+++\n% $.emit("index.html", "other entry")');

  const built = await buildSite(dir, { outDir: join(dir, 'out'), entry: 'other.mdy' });
  assert.equal(built.pages, 1);
  const html = await readFile(join(dir, 'out', 'index.html'), 'utf8');
  assert.equal(html, 'other entry');
});

// --- onSource/onWrite reporting hooks ---------------------------------------

test('buildSite: onSource fires once per ingested file, onWrite once per file actually written (pages, binary outputs, and static/)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mdy-hooks-'));
  after(() => rm(dir, { recursive: true, force: true }));
  const outDir = await mkdtemp(join(tmpdir(), 'mdy-hooks-out-'));
  after(() => rm(outDir, { recursive: true, force: true }));

  await mkdir(join(dir, 'static'), { recursive: true });
  await writeFile(join(dir, 'main.mdy'), '+++\n% $.emit("index.html", "hi")');
  await writeFile(join(dir, 'static', 'style.css'), 'body{}');

  const sources = [];
  const writes = [];
  const built = await buildSite(dir, {
    outDir,
    onSource: (meta) => sources.push(meta.path),
    onWrite: (file) => writes.push(file),
  });

  assert.equal(built.pages, 1);
  assert.deepEqual(sources.sort(), ['main.mdy', 'static/style.css']);
  assert.deepEqual(writes.sort(), ['index.html', 'style.css']);
});

// --- search index -----------------------------------------------------------

test('search-index.json: one record per non-draft post (.mdy AND .md), plus the about page — no author.yaml record, since it has no page', async () => {
  const raw = await page('search-index.json');
  const records = JSON.parse(raw);
  assert.deepEqual(
    records.map((r) => r.url).sort(),
    ['/about/', '/posts/diggings/', '/posts/hello/', '/posts/plain-markdown/']
  );
});

test('search-index.json: the .md post is indexed from its real text (meta.body), same as an .mdy post', async () => {
  const records = JSON.parse(await page('search-index.json'));
  const plain = records.find((r) => r.url === '/posts/plain-markdown/');
  assert.ok(plain);
  assert.ok(plain.words.includes('markdown'));
  assert.deepEqual(plain.tags, ['wet', 'history']);
});

test('search-index.json: records carry title/excerpt/tags/words for client-side matching', async () => {
  const records = JSON.parse(await page('search-index.json'));
  const hello = records.find((r) => r.url === '/posts/hello/');
  assert.equal(hello.title, 'Hello world');
  assert.match(hello.excerpt, /^First post, mostly about wasm and writing\./); // summarize() strips # markup
  assert.deepEqual(hello.tags, ['wasm', 'writing']);
  assert.ok(hello.words.includes('tablet')); // from the body, not just title/tags
  assert.ok(hello.words.includes('wasm'));
});

test('the example blog ships a working search widget wired to the index', async () => {
  assert.ok(existsSync(join(outDir, 'search.js')));
  const html = await page('index.html');
  assert.match(html, /<input id="search-input"/);
  assert.match(html, /<ul id="search-results">/);
  assert.match(html, /<script src="\/search\.js">/);
});

// --- plain markdown (.md) and data-only (.yaml) content, in script mode ---
// (see src/vault.js's walkRawSources — the file FORMAT's own interpretation,
// same reasoning as .mdy's front matter, not a site-building convention)

test('.md: renders with no template interpolation of its own body, wrapped by main.mdy exactly like an .mdy post', async () => {
  const html = await page('posts/plain-markdown/index.html');
  assert.match(html, /<h1 id="[^"]*">Plain markdown<\/h1>/); // title: humanized from the filename (no front matter at all)
  assert.match(html, /<em>2026-07-05<\/em>/); // date: from the filename prefix (no front matter to override it)
  // The body went through its OWN front end: a bare --- didn't split the
  // document, and a % line and a {{ }} rendered as literal text, not code —
  // because a .md document never meets mdy's parser or its script stage at
  // all, it goes straight to hast through src/markdown.js.
  assert.match(html, /<hr>/);
  assert.match(html, /<code>% this stays exactly as typed<\/code>/);
  assert.match(html, /<code>\{\{ this too \}\}<\/code>/);
  assert.match(html, /const config = \{ retries: 3 \};/); // the code fence's own } is untouched
});

test('.md: inline #hashtags produce a real tag page, same as .mdy', async () => {
  const html = await page('tags/wet/index.html');
  assert.match(html, /<a href="\/posts\/plain-markdown\/">Plain markdown<\/a>/);
});

test('.yaml: a data-only file is queryable ($.findOne in about.mdy) but never gets a page of its own', () => {
  assert.ok(!existsSync(join(outDir, 'author')));
  assert.ok(!existsSync(join(outDir, 'author.html')));
  assert.ok(!existsSync(join(outDir, 'author', 'index.html')));
});

// --- $.resize: a real thumbnail, written to real disk ----------------------

test('buildSite: a template $.resize call writes a real, correctly-sized image file to dist/, never touching static/ on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdy-resize-site-'));
  after(() => rm(root, { recursive: true, force: true }));
  const resizeOutDir = await mkdtemp(join(tmpdir(), 'mdy-resize-dist-'));
  after(() => rm(resizeOutDir, { recursive: true, force: true }));

  await mkdir(join(root, 'static'), { recursive: true });
  await writeFile(
    join(root, 'main.mdy'),
    '+++\n' +
      '% const logo = $.findOne({ path: "static/logo.png" })\n' +
      '% const thumb = $.resize(logo, { width: 20 })\n' +
      '% $.emit("hello/index.html", "<img src=" + JSON.stringify(thumb.url) + ">")'
  );
  await writeFile(join(root, 'static', 'logo.png'), makePng(40, 20));

  const built = await buildSite(root, { outDir: resizeOutDir });
  assert.ok(built.pages > 0);

  const html = await readFile(join(resizeOutDir, 'hello', 'index.html'), 'utf8');
  // Flattened, matching where the ORIGINAL static/logo.png itself lands
  // (dist/logo.png, not dist/static/logo.png — see the assertion below) —
  // a resize output has to share that scheme, not its source's own.
  assert.match(html, /<img src="\/logo-20x10\.png">/);

  // A real file, at the resized dimensions, actually on disk in dist/ —
  // flattened right alongside the original (dist/logo.png), not nested
  // under dist/static/.
  const thumbBytes = await readFile(join(resizeOutDir, 'logo-20x10.png'));
  const dims = imageSize(thumbBytes);
  assert.equal(dims.width, 20);
  assert.equal(dims.height, 10);
  const originalFlattened = await readFile(join(resizeOutDir, 'logo.png'));
  assert.equal(imageSize(originalFlattened).width, 40);

  // The source is untouched — $.resize never writes back into the source
  // tree, only ever a build output.
  const originalStillThere = await readFile(join(root, 'static', 'logo.png'));
  const originalDims = imageSize(originalStillThere);
  assert.equal(originalDims.width, 40);
  assert.equal(originalDims.height, 20);
  assert.ok(!existsSync(join(root, 'static', 'logo-20x10.png')));
});
