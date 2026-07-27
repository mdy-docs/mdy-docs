/*
 * mdy as a web-editable static site behind Express.
 *
 * The same in-memory pipeline as `mdy serve` — renderSite() renders the
 * whole site into a Map of outputs, pages are served straight from it —
 * but with NO filesystem watcher: rebuilds are triggered by the web.
 *
 * The editor (/__edit) gives every source file of the site as raw text,
 * with three levels of "the site takes in the change":
 *
 *  - LIVE PREVIEW while typing: the editor debounces the unsaved buffer to
 *    POST /__edit/preview; the site is rebuilt through an overlay
 *    fs-provider where that ONE file reads as the buffer (nothing is
 *    written to disk), and every open page live-reloads over SSE. This is
 *    the web playground's edit loop, server-side.
 *  - SAVE (PUT /__edit/file): write the file to disk, rebuild from disk.
 *    Saving is guarded by optimistic concurrency — the editor sends the
 *    mtime it loaded (`base`), and a file that changed on disk since (your
 *    IDE, another tab) answers 409 with the current disk state instead of
 *    silently clobbering it; `force: true` overrides deliberately.
 *  - DELETE /__edit/file: remove the file, rebuild.
 *
 * The end result is exactly what a watcher would give you — change,
 * rebuild, reload — except the changes arrive over HTTP.
 *
 * Run:                         mdy-web [site-dir]
 *   (site-dir defaults to the current directory; PORT=3000 by default —
 *   from this repo's root: `npm run mdy-web` serves examples/blog)
 * Then:                        open http://localhost:3000/__edit
 *
 * Everything is consumed through package boundaries: the engine as
 * `mdy-docs`, and the editor's syntax highlighting as the `vscode-mdy`
 * extension package — the SAME TextMate grammar file the vscode plugin
 * contributes, run in the browser by shiki. One grammar, two editors.
 *
 * Notes for real use:
 *  - Anyone who can reach the server can edit the site: put auth in front
 *    of /__edit before exposing it beyond localhost.
 *  - A failed rebuild (typing mid-statement, saving a broken template)
 *    keeps serving the last good build; the error comes back in the
 *    preview/save response instead.
 *  - Only files under the site root are editable (never an imported theme
 *    package's), only with text extensions, and never through `..`.
 */
import express from 'express';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFsProvider, parseDocuments, renderSite, walkFiles, walkRawSources } from 'mdy-docs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = resolve(process.argv[2] ?? '.');
const port = process.env.PORT ?? 3000;

// Build output, dependencies, VCS/editor droppings: not source, not
// editable, not listed (mirrors the site walker's own exclusions).
const NON_SOURCE = /(^|\/)(dist|node_modules|\.[^/]+)(\/|$)/;
// Raw-text editing only — a binary (an image) has no "raw text" to show.
const TEXT_EXT = new Set(['.mdy', '.md', '.markdown', '.yaml', '.yml', '.json', '.css', '.js', '.mjs', '.html', '.svg', '.txt', '.xml']);
// Binary site assets: uploadable, listable, deletable — shown as a
// metadata view (not an editor buffer) in the editor.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tiff', '.tif']);
const BINARY_EXT = new Set([...IMAGE_EXT, '.woff', '.woff2', '.ttf', '.otf', '.pdf']);

/** A site-relative path that stays inside root, isn't build output/deps,
 * and has an extension in `exts` (case-insensitive — camera files arrive
 * as .JPG). Returns the absolute path, or null. */
function guardedPath(rel, exts) {
  if (typeof rel !== 'string' || rel === '' || NON_SOURCE.test(rel) || !exts.has(extname(rel).toLowerCase())) return null;
  const abs = resolve(root, ...rel.split('/'));
  return abs.startsWith(root + sep) ? abs : null;
}
const SOURCE_EXT = new Set([...TEXT_EXT, ...BINARY_EXT]);
const editablePath = (rel) => guardedPath(rel, TEXT_EXT);
const sourcePath = (rel) => guardedPath(rel, SOURCE_EXT);

const mtimeOf = (abs) => stat(abs).then((s) => s.mtime.toISOString(), () => null);

// --- the unsaved buffer, and the overlay fs that makes it real -------------
//
// `buffer` is the editor's unsaved state for ONE file. While it exists,
// renderSite runs against `overlay`: a provider identical to the disk
// except that this one path lists/reads as the buffer — so an unsaved (or
// brand-new, not-yet-created) file participates in the build exactly as if
// it were on disk, without being on disk.

let buffer = null; // { path, text } | null
const disk = nodeFsProvider();
const matchesExt = (name, extensions) => !extensions || extensions.some((e) => name.endsWith(e));
const overlay = {
  ...disk,
  async list(r, subdir, options = {}) {
    const names = await disk.list(r, subdir, options);
    if (buffer && r === root) {
      const prefix = subdir === '.' ? '' : `${subdir}/`;
      if (buffer.path.startsWith(prefix)) {
        const rel = buffer.path.slice(prefix.length);
        const extensions = 'extensions' in options ? options.extensions : ['.mdy'];
        if (matchesExt(rel, extensions) && !names.includes(rel)) names.push(rel), names.sort();
      }
    }
    return names;
  },
  async read(r, p) {
    return buffer && r === root && p === buffer.path ? buffer.text : disk.read(r, p);
  },
  async mtime(r, p) {
    return buffer && r === root && p === buffer.path ? new Date() : disk.mtime(r, p);
  },
  async size(r, p) {
    return buffer && r === root && p === buffer.path ? buffer.text.length : disk.size(r, p);
  },
};

// --- the site, in memory — rebuilt on every web change ---------------------

let site = { outputs: new Map(), binaryOutputs: new Map(), roots: [root] };
let lastBuild = { ok: false, error: 'not built yet' };
let buildSeq = 0;
let building = Promise.resolve();

/** Queue a rebuild; keep the last good build on failure. Serialized, and
 * COALESCING: a rebuild that is already superseded by a newer request
 * (fast typing) is skipped — only the latest buffer state gets built. */
function scheduleRebuild() {
  const seq = ++buildSeq;
  building = building.then(async () => {
    if (seq !== buildSeq) return { ...lastBuild, skipped: true };
    const started = Date.now();
    try {
      site = await renderSite(root, buffer ? { fs: overlay } : {});
      lastBuild = { ok: true, ms: Date.now() - started, pages: site.outputs.size, preview: Boolean(buffer) };
      for (const res of sseClients) res.write('data: reload\n\n');
    } catch (err) {
      lastBuild = { ok: false, error: err.message ?? String(err), preview: Boolean(buffer) };
    }
    return lastBuild;
  });
  return building;
}

// --- live reload (SSE), same shape as `mdy serve`'s ------------------------

const SSE_PATH = '/__edit/events';
const sseClients = new Set();
const RELOAD_SNIPPET = `<script>new EventSource(${JSON.stringify(SSE_PATH)}).onmessage = () => location.reload();</script>`;
const withReload = (html) =>
  html.includes('</body>') ? html.replace('</body>', `${RELOAD_SNIPPET}\n</body>`) : html + RELOAD_SNIPPET;

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get(SSE_PATH, (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write('retry: 300\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// --- the editor ------------------------------------------------------------

app.get('/__edit', (req, res, next) => {
  readFile(join(here, 'editor.html'), 'utf8')
    .then((html) => res.type('html').send(html))
    .catch(next);
});

// Syntax highlighting, reused straight from the vscode extension: the SAME
// TextMate grammar file the plugin contributes (mdy.tmLanguage.json),
// resolved through the `vscode-mdy` package dependency, served to the
// browser, and run by shiki's TextMate engine inside Monaco (via
// @shikijs/monaco).
const grammarFile = require.resolve('vscode-mdy/syntaxes/mdy.tmLanguage.json');
app.get('/__edit/grammar/mdy', (req, res, next) => {
  readFile(grammarFile, 'utf8')
    .then((json) => res.type('json').send(json))
    .catch(next);
});

// The editor runtime: Monaco itself, plus shiki's core + pure-JS regex
// engine + the stock grammars for a site's other text files + the
// shiki→monaco adapter — bundled ONCE into browser ESM (+ a css sidecar,
// codicon font inlined) by esbuild, in memory, on first request. Fully
// local: no CDN involved. (shiki's own dist files bare-import each other,
// so none of this can be served unbundled.)
let editorBundle = null; // { js, css }
async function buildEditorBundle() {
  if (editorBundle) return editorBundle;
  const esbuild = await import('esbuild');
  const entry = [
    "export * as monaco from 'monaco-editor';",
    "export { shikiToMonaco } from '@shikijs/monaco';",
    "export { createHighlighterCore } from '@shikijs/core';",
    "export { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';",
    ...['markdown', 'yaml', 'javascript', 'json', 'css', 'html', 'xml'].map(
      (l) => `export { default as ${l} } from '@shikijs/langs/${l}';`
    ),
    "export { default as darkPlus } from '@shikijs/themes/dark-plus';",
  ].join('\n');
  const out = await esbuild.build({
    stdin: { contents: entry, resolveDir: here, sourcefile: 'editor-entry.mjs' },
    bundle: true,
    format: 'esm',
    outfile: 'editor.mjs',
    write: false,
    logLevel: 'silent',
    loader: { '.ttf': 'dataurl' },
  });
  editorBundle = {
    js: out.outputFiles.find((f) => f.path.endsWith('.mjs') || f.path.endsWith('.js'))?.text ?? '',
    css: out.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '',
  };
  return editorBundle;
}

app.get('/__edit/editor.mjs', async (req, res) => {
  try {
    res.type('.js').send((await buildEditorBundle()).js);
  } catch (err) {
    res.status(503).json({ error: `editor bundle unavailable: ${err.message}` });
  }
});

app.get('/__edit/editor.css', async (req, res) => {
  try {
    res.type('.css').send((await buildEditorBundle()).css);
  } catch (err) {
    res.status(503).end();
  }
});

// The site's source files (path + size + mtime), for the file list. Text
// files open in Monaco; binary ones (`binary: true`) open as a
// metadata view.
app.get('/__edit/files', (req, res, next) => {
  walkFiles(root)
    .then((files) => {
      const listed = files
        .filter((f) => sourcePath(f.path) !== null && f.path !== 'package.json' && f.path !== 'README.md')
        .map((f) => ({ ...f, binary: !TEXT_EXT.has(f.ext) }));
      res.json({ root, files: listed, lastBuild });
    })
    .catch(next);
});

// The combined metadata view for one file: its raw-document record exactly
// as the document set sees it — identity plus whatever its file FORMAT
// contributes (walkRawSources: image width/height, .md body/tags, .yaml
// fields) — plus its `<path>.mdy` sidecar (front matter data + body), and
// the two merged the way a site script typically combines them.
app.get('/__edit/meta', async (req, res, next) => {
  try {
    const rel = req.query.path;
    if (!sourcePath(rel)) return res.status(400).json({ error: 'not a site file' });
    const sources = await walkRawSources(root);
    const rec = sources.find((s) => s.meta.path === rel);
    if (!rec) return res.status(404).json({ error: 'no such file' });
    let sidecar = null;
    const sidecarRel = `${rel}.mdy`;
    try {
      const text = await readFile(resolve(root, ...sidecarRel.split('/')), 'utf8');
      const doc = parseDocuments(text)[0];
      sidecar = { path: sidecarRel, data: doc?.data ?? {}, body: (doc?.content ?? '').trim() };
    } catch {
      // no sidecar — the response says so with null
    }
    res.json({ identity: rec.meta, sidecar, combined: { ...rec.meta, ...(sidecar?.data ?? {}) } });
  } catch (err) {
    next(err);
  }
});

// Raw bytes of any site file (the metadata view's image preview — static/
// files are also served by the site itself, but a posts/… image isn't).
app.get('/__edit/raw', async (req, res) => {
  const abs = sourcePath(req.query.path);
  if (!abs) return res.status(400).end();
  try {
    res.type(extname(abs) || '.txt');
    res.send(await readFile(abs));
  } catch {
    res.status(404).end();
  }
});

// Upload: raw request body → the file, verbatim; then the usual rebuild.
// (Text files pass through here too — drag-and-drop of a .md works.)
app.put('/__edit/binary', express.raw({ type: () => true, limit: '50mb' }), async (req, res, next) => {
  try {
    const abs = sourcePath(req.query.path);
    if (!abs || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'not an uploadable path' });
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, req.body);
    const build = await scheduleRebuild();
    res.status(build.ok ? 200 : 422).json(build);
  } catch (err) {
    next(err);
  }
});

app.get('/__edit/file', async (req, res) => {
  const abs = editablePath(req.query.path);
  if (!abs) return res.status(400).json({ error: 'not an editable path' });
  try {
    const [text, mtime] = await Promise.all([readFile(abs, 'utf8'), mtimeOf(abs)]);
    res.json({ path: req.query.path, text, mtime });
  } catch {
    res.status(404).json({ error: 'no such file' });
  }
});

// Live preview: rebuild from the unsaved buffer, write nothing. An empty
// body ({}) resets the preview back to what's on disk.
app.post('/__edit/preview', async (req, res, next) => {
  try {
    const { path: rel, text } = req.body ?? {};
    if (rel === undefined) {
      buffer = null;
    } else {
      if (!editablePath(rel) || typeof text !== 'string') return res.status(400).json({ error: 'need { path, text } for an editable path' });
      buffer = { path: rel, text };
    }
    res.json(await scheduleRebuild());
  } catch (err) {
    next(err);
  }
});

// Save: write the file, rebuild from disk. `base` is the mtime the editor
// loaded — a mismatch means the disk changed underneath (another tab, an
// IDE) and answers 409 with the current disk state; `force` overrides.
app.put('/__edit/file', async (req, res, next) => {
  try {
    const { path: rel, text, base, force } = req.body ?? {};
    const abs = editablePath(rel);
    if (!abs || typeof text !== 'string') return res.status(400).json({ error: 'need { path, text } for an editable path' });
    const diskMtime = await mtimeOf(abs);
    if (!force && diskMtime !== (base ?? null)) {
      const current = diskMtime === null ? null : await readFile(abs, 'utf8');
      return res.status(409).json({ error: 'conflict: file changed on disk since it was loaded', mtime: diskMtime, text: current });
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
    if (buffer?.path === rel) buffer = null; // saved state IS disk state now
    const build = await scheduleRebuild();
    res.status(build.ok ? 200 : 422).json({ ...build, mtime: await mtimeOf(abs) });
  } catch (err) {
    next(err);
  }
});

app.delete('/__edit/file', async (req, res, next) => {
  try {
    const abs = sourcePath(req.query.path); // text or binary — both deletable
    if (!abs) return res.status(400).json({ error: 'not a site file' });
    await rm(abs, { force: true });
    if (buffer?.path === req.query.path) buffer = null;
    res.json(await scheduleRebuild());
  } catch (err) {
    next(err);
  }
});

// --- the site itself, served from the in-memory build ----------------------

app.get(/.*/, async (req, res, next) => {
  try {
    const p = decodeURIComponent(req.path).replace(/^\/+/, '');
    // Rendered pages first: '', 'posts/hello/', and the slashless 'posts/hello'.
    const candidates = p === '' ? ['index.html'] : p.endsWith('/') ? [`${p}index.html`] : [p, `${p}/index.html`];
    for (const key of candidates) {
      if (!site.outputs.has(key)) continue;
      const body = site.outputs.get(key);
      res.type(extname(key) || '.html');
      return res.send(key.endsWith('.html') ? withReload(body) : body);
    }
    // Then a binary build output (a $.resize result) — exact path only.
    if (site.binaryOutputs.has(p)) {
      res.type(extname(p));
      return res.send(Buffer.from(site.binaryOutputs.get(p)));
    }
    // Then static/ passthrough, root's own first (site overrides theme),
    // pinned inside each static dir; .mdy sidecars are data, never served.
    // The unsaved buffer shadows the site's own static/ here too, so a CSS
    // edit previews live like everything else.
    if (!p.endsWith('.mdy')) {
      if (buffer && buffer.path === `static/${p}`) {
        res.type(extname(p) || '.txt');
        return res.send(buffer.text);
      }
      for (const dir of [root, ...site.roots.filter((r) => r !== root)].map((r) => join(r, 'static'))) {
        const file = resolve(dir, ...p.split('/'));
        if (!file.startsWith(dir + sep)) continue;
        try {
          const body = await readFile(file);
          res.type(extname(p) || 'application/octet-stream');
          return res.send(body);
        } catch {
          // not in this root — try the next
        }
      }
    }
    const nf = site.outputs.get('404.html');
    res.status(404).type('html').send(nf ? withReload(nf) : 'not found');
  } catch (err) {
    next(err);
  }
});

await scheduleRebuild();
if (!lastBuild.ok) console.error(`mdy: first build failed — ${lastBuild.error}`);
else console.log(`mdy: rendered ${lastBuild.pages} page(s) in ${lastBuild.ms}ms from ${root}`);
app.listen(port, () => console.log(`site on http://localhost:${port} — editor on http://localhost:${port}/__edit`));
