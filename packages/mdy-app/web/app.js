/*
 * mdy as a native application — the webview half.
 *
 * It renders a real directory with the unmodified mdy-docs site layer, holds
 * the outputs, and answers the shell's requests for them. The shell owns
 * `mdy://` because a page cannot register a scheme; this owns the outputs
 * because this is where they are built. See ../src-tauri/src/main.rs.
 *
 * Two things worth remembering, each of which cost a build cycle:
 *
 *   - `event.listen` needs a capability (`core:default`). Without it the call
 *     rejects, and since the preview hangs off that one await, the window sits
 *     there doing nothing rather than reporting anything.
 *   - The preview is a DIFFERENT ORIGIN from this page — `mdy://localhost`
 *     against `tauri://localhost`. The shell cannot read the iframe's DOM and
 *     should not be able to; a live reload has to be a reassigned `src` or a
 *     postMessage, never a reach into the document.
 */

import { renderSite } from 'mdy-docs';
import { tauriFsProvider } from './tauri-fs-provider.js';

const { invoke } = window.__TAURI__.core;

// Name every asset the page asks for and what it got back. A wasm that 404s
// answers with an HTML page, which surfaces later and far away as
// "module doesn't start with \0asm".
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  const res = await realFetch(input, init);
  if (!res.ok || /\.wasm(\?|$)/.test(url)) {
    invoke('log', { msg: `fetch ${res.status} ${url}` }).catch(() => {});
  }
  return res;
};
const { listen } = window.__TAURI__.event;

const status = document.getElementById('status');
const preview = document.getElementById('preview');

const trace = { steps: [], served: [] };
const provider = tauriFsProvider();
const step = (msg) => {
  trace.steps.push(msg);
  status.textContent = msg;
  invoke('log', { msg: String(msg) }).catch(() => {});
};
const finish = (result) => {
  status.textContent = JSON.stringify(result, null, 1);
  invoke('report', { result: JSON.stringify(result) }).catch(() => {});
};

// Armed before anything that can block: the failure mode of a window is silence.
setTimeout(() => finish({ ok: false, error: 'watchdog: never settled', ...summary() }), 120_000);
addEventListener('error', (e) => step(`window error: ${e.message}`));
addEventListener('unhandledrejection', (e) => step(`rejection: ${e.reason}`));

let outputs = new Map();
const summary = () => ({
  steps: trace.steps.slice(-12),
  served: trace.served.slice(0, 8),
  outputs: outputs.size,
});

/** A URL path to an output key, as src/serve.js does it. */
function keysFor(path) {
  const p = path.replace(/^\/+/, '');
  if (p === '') return ['index.html'];
  if (p.endsWith('/')) return [`${p}index.html`];
  return [p, `${p}/index.html`];
}

const MIME = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
};
const typeFor = (key) => MIME[key.slice(key.lastIndexOf('.') + 1)] ?? 'application/octet-stream';

/*
 * `static/` is not in `outputs`. renderSite returns what documents produced;
 * every root's `static/` is copied through verbatim by buildSite and served
 * from disk by serveSite. A preview without it is a site without its
 * stylesheet, so this does what serveSite does: try the outputs first, then
 * each root's static/ in turn, this site's own before anything it imports.
 */
let staticRoots = [];

async function staticFile(fs, path) {
  const rel = path.replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('.mdy')) return null; // sidecars are not served
  for (const root of staticRoots) {
    try {
      return await fs.readBinary(root, `static/${rel}`);
    } catch {
      // not in this root — try the next
    }
  }
  return null;
}

try {
  await listen('mdy://request', async ({ payload: [id, path] }) => {
    const key = keysFor(path).find((k) => outputs.has(k));
    let status = key ? 200 : 404;
    let contentType = key ? typeFor(key) : MIME.html;
    let body;

    if (key) {
      body = Array.from(new TextEncoder().encode(outputs.get(key)));
    } else {
      const bytes = await staticFile(provider, path);
      if (bytes) {
        status = 200;
        contentType = typeFor(path);
        body = Array.from(bytes);
      } else {
        body = Array.from(new TextEncoder().encode(
          `<!doctype html><meta charset="utf-8"><h1>404</h1><p>${path}</p>`));
      }
    }
    if (trace.served.length < 12) trace.served.push({ path, status });
    await invoke('respond', { id, status, contentType, body });
  });
  step('listening');

  const root = await invoke('site_root');
  if (!root) throw new Error('no site directory given — run: mdy-app <site-dir>');

  // The provider on its own, before the renderer is involved. If this hangs,
  // the fault is the filesystem boundary; if it answers, it is not.
  step(`probing provider at ${root}`);
  const probe = await provider.list(root, '.', { extensions: null });
  step(`provider listed ${probe.length} file(s)`);
  const sample = await provider.read(root, probe.find((p) => p.endsWith('.mdy')) ?? probe[0]);
  step(`provider read ${sample.length} chars`);

  step(`rendering ${root}`);
  const started = Date.now();
  let reads = 0;
  const site = await renderSite(root, {
    fs: provider,
    onSource: () => { if (++reads % 40 === 0) step(`ingested ${reads} source(s)`); },
    onIngest: ({ done, total }) => { if (done === total) step(`inserted ${total} document(s)`); },
    onEmit: ({ count }) => { if (count % 5 === 0) { const v = globalThis.__vmStats || {}; step(`emitted ${count} page(s) — vms created=${v.created} discarded=${v.created - (v.live||0)}`); } },
  });
  outputs = site.outputs;
  // root's own static/ first, matching buildSite's last-write-wins copy order.
  staticRoots = [root, ...(site.roots ?? []).filter((r) => r !== root)];
  const ms = Date.now() - started;
  step(`rendered ${outputs.size} page(s) in ${ms}ms`);

  // Navigation is checked from the serving side: the preview is cross-origin,
  // so a second request arriving is the proof that a link inside a served page
  // reached another served page.
  const first = [...outputs.keys()].find((k) => k === 'index.html') ?? [...outputs.keys()][0];
  preview.src = `mdy://localhost/${first === 'index.html' ? '' : first}`;
  step(`serving mdy://localhost/ (${first})`);

  await new Promise((r) => preview.addEventListener('load', r, { once: true }));
  finish({ ok: true, root, pages: outputs.size, ms, ...summary() });
} catch (err) {
  finish({
    ok: false,
    error: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`,
    stack: String(err?.stack ?? '').split('\n').slice(0, 4),
    ...summary(),
  });
}
