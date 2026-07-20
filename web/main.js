// mdy's in-browser site editor — the same renderSite() the CLI uses, run
// against an in-memory vault (mdy-docs' own memoryFsProvider) instead
// of disk. Both engines (lamassu, nisaba) are WebAssembly and bundle for
// the browser with no special config, which is what makes this whole site
// pipeline — not just single-document rendering — possible client-side.
//
// Every site is a SCRIPT-DEFINED site (the conventional content/layouts/
// site.yaml pipeline was removed — see docs/site-plan.md's "Toward a
// script-defined site"): the seed (examples/blog) is one index.mdy entry
// document deciding everything itself — which files are "posts", what URL/
// layout each gets, tags, feed/sitemap/robots, even the search index — via
// $.find/$.render/$.emit (plus $.resize/$.tokenize/$.rfc822/$.markdown; see
// src/site/script-site.js). `drafts`/`future` (below) reach it as plain
// context booleans, same as build.js's own options.
//
// `files` (the in-memory Map renderSite reads via memoryFsProvider) stays
// the source of truth for rendering — it's synchronous, which every call
// site here assumes. OPFS (mdy-docs' own opfsFsProvider), where the
// browser supports it, sits underneath as a write-through persistence
// layer: on boot, real saved content (if any) replaces the seed; every
// edit is mirrored to OPFS (best-effort, debounced with the render);
// opfs.watch() picks up a write from another tab on the same origin and
// folds it in. Not a live collaborative editor — a file open in two tabs
// at once will diverge until you switch away and back in one of them (see
// onOpfsChange below) — just "your edits survive a reload and a second
// tab sees them," which is what makes watch() worth having here at all.
//
// No "edit this page" shortcut: a script-defined site's entry decides
// output paths itself via $.emit, with no host-computed "this URL's single
// source file" mapping to point a button at (unlike the old conventional
// pipeline's `pages` list) — the file list on the left is the only way in.
import { renderSite, memoryFsProvider, opfsFsProvider } from '../index.js';

// Seed the in-memory site from examples/blog — every file, eagerly.
// import.meta.glob keys are paths relative to this file; strip the leading
// '../examples/blog/' to get vault-relative paths ("posts/hello.mdy",
// "layouts/base.mdy", "index.mdy", …).
//
// Two passes, not one: `?raw` decodes as UTF-8 text, which is correct for
// every document/config file but would silently corrupt a real binary file
// (examples/blog/static/logo.png, the metadata-sidecar example) — its
// bytes would come back mangled, and any $.resize call on it would fail.
// BINARY_EXTENSIONS gets `?url` instead (a real, Vite-served URL, both in
// dev and in the built bundle) and its actual bytes fetched separately, in
// boot() below — memoryFsProvider's Map already accepts either a string or
// a Uint8Array per path (see mdy-docs' own fs-provider.js), so this
// needs no changes on the vault side, only here at the seed.
// import.meta.glob requires literal glob strings (Vite parses these at
// build time, no dynamic template pieces) — kept in sync with
// BINARY_EXTENSIONS below by hand; there are few enough of these that
// duplicating the list here is simpler than deriving it.
const seed = import.meta.glob(
  ['../examples/blog/**/*', '!../examples/blog/**/*.{png,jpg,jpeg,gif,webp,bmp,avif,ico,tiff,tif}'],
  { eager: true, query: '?raw', import: 'default' }
);
const binarySeedUrls = import.meta.glob('../examples/blog/**/*.{png,jpg,jpeg,gif,webp,bmp,avif,ico,tiff,tif}', {
  eager: true,
  query: '?url',
  import: 'default',
});
const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.ico', '.tiff', '.tif'];
const SEED_PREFIX = '../examples/blog/';
const files = new Map(
  Object.entries(seed).map(([key, text]) => [key.slice(SEED_PREFIX.length), text])
);
const fs = memoryFsProvider(files);

/** Fetch every binary seed file's real bytes (see the comment above) and
 * add them to `files` — must finish before the first render, so images.js's
 * image-size/$.resize see real bytes, not `?raw`-mangled text. */
async function seedBinaryFiles() {
  await Promise.all(
    Object.entries(binarySeedUrls).map(async ([key, url]) => {
      const relPath = key.slice(SEED_PREFIX.length);
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      files.set(relPath, bytes);
    })
  );
}

// --- OPFS persistence (best-effort; the in-memory `files` Map above is
// always what actually renders) ---------------------------------------

const OPFS_ROOT = 'mdy-site';
const opfs = typeof navigator !== 'undefined' && navigator.storage?.getDirectory ? opfsFsProvider() : null;
const dirtyPaths = new Set(); // written/deleted since the last persistDirty()

function markDirty(path) {
  dirtyPaths.add(path);
}

/** Same extension test as the seed split above — read/write OPFS through
 * readBinary/writeBinary for these, read/write (text) for everything else.
 * OPFS itself doesn't remember which one a path was written as, so this is
 * the one signal available on the way back in too. */
function isBinaryPath(path) {
  return BINARY_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Best-effort: mirror every path touched since the last call to OPFS.
 * Failures (quota, a mid-flight browser storage error) are swallowed —
 * `files` is still correct in memory, so a persistence hiccup degrades to
 * "this edit won't survive a reload," not a broken editor. */
async function persistDirty() {
  if (!opfs || dirtyPaths.size === 0) return;
  const toPersist = [...dirtyPaths];
  dirtyPaths.clear();
  for (const path of toPersist) {
    try {
      if (!files.has(path)) {
        await opfs.remove(OPFS_ROOT, path);
      } else if (isBinaryPath(path)) {
        await opfs.writeBinary(OPFS_ROOT, path, files.get(path));
      } else {
        await opfs.write(OPFS_ROOT, path, files.get(path));
      }
    } catch {
      // best-effort — see comment above
    }
  }
}

/** On boot: real saved content (a returning visit, or another tab having
 * already written) wins over the bundled seed. First-ever visit, OPFS is
 * empty, so the seed is written through to it instead. Returns whether
 * OPFS is actually usable, for the status badge. */
async function hydrateFromOpfs() {
  if (!opfs) return false;
  try {
    const saved = await opfs.list(OPFS_ROOT, '.', { extensions: null });
    if (saved.length > 0) {
      files.clear();
      for (const path of saved) {
        files.set(path, isBinaryPath(path) ? await opfs.readBinary(OPFS_ROOT, path) : await opfs.read(OPFS_ROOT, path));
      }
    } else {
      for (const [path, value] of files) {
        if (isBinaryPath(path)) await opfs.writeBinary(OPFS_ROOT, path, value);
        else await opfs.write(OPFS_ROOT, path, value);
      }
    }
    return true;
  } catch {
    return false; // e.g. a private-browsing mode that exposes the API but rejects writes
  }
}

/** Another tab (or this one echoing its own write) changed a file in OPFS.
 * The file currently open in *this* tab's editor is left alone — folding
 * in a remote change while someone's mid-keystroke would clobber typing
 * with no merge, which is worse than a stale preview until they switch
 * away and back. */
async function onOpfsChange(event) {
  if (event.path === currentFile) return;
  try {
    if (event.type === 'delete') {
      if (!files.has(event.path)) return;
      files.delete(event.path);
    } else {
      files.set(
        event.path,
        isBinaryPath(event.path) ? await opfs.readBinary(OPFS_ROOT, event.path) : await opfs.read(OPFS_ROOT, event.path)
      );
    }
    renderFileList();
    scheduleRender();
  } catch {
    // the path may have already changed again by the time this read ran
  }
}

function setStorageStatus(text) {
  document.getElementById('storage-status').textContent = text;
}

const $id = (id) => document.getElementById(id);
const fileList = $id('file-list');
const editor = $id('editor');
const editorTitle = $id('editor-title');
const previewPage = $id('preview-page');
const previewFrame = $id('preview-frame');
const status = $id('status');
const errorBox = $id('error');
const optDrafts = $id('opt-drafts');
const optFuture = $id('opt-future');
const newFileForm = $id('new-file-form');
const newFilePath = $id('new-file-path');

function pickInitialFile() {
  // A script-defined site's own entry point (index.mdy) is the whole
  // definition of the site — the natural first thing to look at. Falls
  // back to the first file alphabetically for a conventional site (no
  // index.mdy at the root) or any other layout.
  if (files.has('index.mdy')) return 'index.mdy';
  return [...files.keys()].sort()[0];
}

let currentFile = null; // set in boot(), after hydrateFromOpfs() settles what `files` actually contains
let latestOutputs = new Map();
let latestBinaryOutputs = new Map(); // path -> Uint8Array, this build's $.resize results (images.js)
let urlToFile = new Map();
let currentPreviewUrl = '/';

// --- file list / editor ----------------------------------------------------

function renderFileList() {
  fileList.replaceChildren();
  for (const path of [...files.keys()].sort()) {
    const li = document.createElement('li');
    li.className = path === currentFile ? 'active' : '';
    li.addEventListener('click', () => selectFile(path));

    const label = document.createElement('span');
    label.textContent = path;
    li.appendChild(label);

    const remove = document.createElement('span');
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = `delete ${path}`;
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      if (files.size <= 1) return; // keep at least one file to edit
      files.delete(path);
      markDirty(path);
      if (currentFile === path) selectFile([...files.keys()].sort()[0]);
      else renderFileList();
      scheduleRender();
    });
    li.appendChild(remove);

    fileList.appendChild(li);
  }
}

function selectFile(path) {
  currentFile = path;
  editorTitle.textContent = `source — ${path}`;
  const value = files.get(path);
  // A real binary file (an image — see the seeding comment above) has no
  // sensible text representation and isn't safe to edit as one; show a
  // placeholder and disable typing rather than garble its bytes on the
  // next keystroke. Its metadata sidecar (<path>.mdy, a real text file)
  // is what's actually editable.
  const binary = value instanceof Uint8Array;
  editor.value = binary ? `[binary file — ${value.length} bytes — not editable here]` : value ?? '';
  editor.disabled = binary;
  renderFileList();
}

editor.addEventListener('input', () => {
  files.set(currentFile, editor.value);
  markDirty(currentFile);
  scheduleRender();
});

newFileForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const path = newFilePath.value.trim().replace(/^\/+/, '');
  if (!path || files.has(path)) return;
  // A layout is conventionally a shell receiving `content` (both in a
  // script-defined site's own $.render calls and the conventional
  // content/layouts pipeline); any other .mdy gets an empty front-matter
  // block, ready for a body — there's no more universal "new page"
  // starter than that once there's no content/ convention to assume.
  const starter = path.startsWith('layouts/') ? '{{ content }}' : path.endsWith('.mdy') ? '+++\n' : '';
  files.set(path, starter);
  markDirty(path);
  newFilePath.value = '';
  selectFile(path);
  scheduleRender();
});

optDrafts.addEventListener('change', scheduleRender);
optFuture.addEventListener('change', scheduleRender);

// --- build (debounced, last-wins) ------------------------------------------

let seq = 0;
let timer = null;

function scheduleRender() {
  clearTimeout(timer);
  timer = setTimeout(doRender, 300);
}

async function doRender() {
  const mySeq = ++seq;
  status.textContent = 'building…';
  const started = performance.now();
  try {
    const { outputs, binaryOutputs } = await renderSite('/', {
      fs,
      drafts: optDrafts.checked,
      future: optFuture.checked,
    });
    if (mySeq !== seq) return; // superseded by a newer edit
    latestOutputs = outputs;
    latestBinaryOutputs = binaryOutputs;
    errorBox.hidden = true;
    status.textContent = `built ${outputs.size} page(s) in ${(performance.now() - started).toFixed(0)}ms`;
    updatePreviewPageList();
    showPreview(currentPreviewUrl);
  } catch (err) {
    if (mySeq !== seq) return;
    // Keep showing the last good preview — an error is not a blank page.
    errorBox.textContent = String(err.message ?? err);
    errorBox.hidden = false;
    status.textContent = 'build failed';
  } finally {
    // Persist whatever's actually in `files` now, win or lose — even a
    // temporarily-broken build shouldn't cost the edit that caused it.
    persistDirty();
  }
}

// --- preview -----------------------------------------------------------

function outputUrlFor(file) {
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  return `/${file}`; // e.g. 404.html
}

function updatePreviewPageList() {
  const entries = [...latestOutputs.keys()]
    .filter((f) => f.endsWith('.html'))
    .map((f) => [outputUrlFor(f), f])
    .sort(([a], [b]) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
  urlToFile = new Map(entries);

  previewPage.replaceChildren(
    ...entries.map(([url]) => {
      const opt = document.createElement('option');
      opt.value = url;
      opt.textContent = url;
      return opt;
    })
  );
  if (!urlToFile.has(currentPreviewUrl)) currentPreviewUrl = entries[0]?.[0] ?? '/';
  previewPage.value = currentPreviewUrl;
}

previewPage.addEventListener('change', () => {
  currentPreviewUrl = previewPage.value;
  showPreview(currentPreviewUrl);
});

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

/** Uint8Array -> base64, chunked to stay well under a single call's
 * argument-count limit (String.fromCharCode(...bigArray) can blow the
 * stack on a large image). */
function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** A root-relative image URL (as it'd be requested from a real server) ->
 * its real bytes, or null. Mirrors the two places an image can actually
 * come from at build time: an images.js $.resize result (latestBinaryOutputs,
 * already dist-relative/flattened — see images.js), or a plain static/
 * file, flattened the same way buildSite/serve.js flatten it. */
function resolveImageBytes(url) {
  const p = url.replace(/^\/+/, '');
  if (latestBinaryOutputs.has(p)) return latestBinaryOutputs.get(p);
  const staticValue = files.get(`static/${p}`);
  return staticValue instanceof Uint8Array ? staticValue : null;
}

// A srcdoc iframe has no real origin: it can't fetch /style.css,
// /search-index.json, or an <img src="/...">, and its links can't navigate
// anywhere. All four are worked around here rather than in the shipped
// files themselves (which stay correct for a real server) — see the
// file-level comment.
function preparePreviewHtml(html) {
  let out = html;

  const css = files.get('static/style.css');
  if (css) out = out.replace('<link rel="stylesheet" href="/style.css">', `<style>${css}</style>`);

  out = out.replace(/(<img\b[^>]*\ssrc=")([^"]+)(")/g, (match, pre, src, post) => {
    const ext = src.slice(src.lastIndexOf('.')).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    const bytes = mime ? resolveImageBytes(src) : null;
    return bytes ? `${pre}data:${mime};base64,${bytesToBase64(bytes)}${post}` : match;
  });

  const widgetSrc = files.get('static/search.js');
  const indexJson = latestOutputs.get('search-index.json');
  if (widgetSrc && indexJson) {
    const shim = `<script>
      const __mdyIndex = ${JSON.stringify(indexJson)};
      const __realFetch = window.fetch.bind(window);
      window.fetch = (url, ...rest) =>
        url === '/search-index.json'
          ? Promise.resolve({ json: async () => JSON.parse(__mdyIndex) })
          : __realFetch(url, ...rest);
    </script>
    <script>${widgetSrc}</script>`;
    out = out.replace('<script src="/search.js"></script>', shim);
  }

  const navShim = `<script>
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="/"]');
      if (!a) return;
      e.preventDefault();
      parent.postMessage({ type: 'mdy-preview-navigate', href: a.getAttribute('href') }, '*');
    });
  </script>`;
  out = /<body[^>]*>/.test(out) ? out.replace(/<body([^>]*)>/, `<body$1>${navShim}`) : out + navShim;

  return out;
}

function showPreview(url) {
  const file = urlToFile.get(url);
  previewFrame.srcdoc = file ? preparePreviewHtml(latestOutputs.get(file)) : '';
}

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'mdy-preview-navigate') return;
  if (urlToFile.has(e.data.href)) {
    currentPreviewUrl = e.data.href;
    previewPage.value = currentPreviewUrl;
    showPreview(currentPreviewUrl);
  }
});

// --- boot --------------------------------------------------------------

async function boot() {
  await seedBinaryFiles(); // must finish before hydrateFromOpfs()/doRender() ever touch `files`
  const persisted = await hydrateFromOpfs();
  if (persisted) {
    setStorageStatus('saved in this browser · live across tabs');
    opfs.watch(OPFS_ROOT, onOpfsChange, { extensions: null }).catch(() => {
      // native FileSystemObserver/polling setup failed — writes/reads
      // still work, only cross-tab live sync is lost
    });
  } else {
    setStorageStatus('not saved (in-memory only)');
  }
  currentFile = pickInitialFile();
  selectFile(currentFile);
  doRender();
}

boot();
