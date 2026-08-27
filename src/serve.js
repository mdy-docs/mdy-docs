import { nodeFsProvider } from './fs-provider.js';
import { renderSite } from './build.js';

/*
 * mdy dev — the dev loop.
 *
 * Pages are rendered in memory (renderSite) and served straight from the
 * Map; a $.resize result (images.js) is served the same way, from
 * renderSite's binaryOutputs Map; static/ is served from disk. Nothing
 * touches dist/. One recursive watcher on the site root (nodeFsProvider's
 * watch(), mdy-docs' own fs-provider.js — the same recursive fs.watch this
 * file used to call directly) triggers a debounced full rebuild — a
 * script-defined site has no incremental cache (see script-site.js), so
 * every save re-walks the whole directory and reruns the entry from
 * scratch. Browsers hold an SSE connection (/__mdy__/events) and reload
 * when a rebuild lands; a failed rebuild logs the error and keeps serving
 * the last good build.
 *
 * node:http/node:fs/node:path are imported LAZILY (dynamic import, inside
 * serveSite) rather than at module scope — index.js re-exports serveSite
 * alongside everything else, so a browser bundle of index.js reaches this file
 * transitively even though it never calls serveSite (an HTTP dev server
 * makes no sense in a browser); Rollup statically rejects a *static* named
 * import of a browser-externalized Node builtin even when nothing would
 * call it at runtime. See build.js/fs-provider.js for the same pattern
 * with the same reasoning.
 */

const RELOAD_PATH = '/__mdy__/events';

const RELOAD_SNIPPET = `<script>
new EventSource(${JSON.stringify(RELOAD_PATH)}).onmessage = () => location.reload();
</script>`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Changes that must not retrigger a rebuild: build output, VCS/editor
// droppings, dependencies.
const IGNORE = /(^|\/)(dist|node_modules|\.[^/]+)(\/|$)/;

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inject the live-reload client into an HTML document (serve-time only —
 * built output stays clean). */
function withReload(html) {
  return html.includes('</body>')
    ? html.replace('</body>', `${RELOAD_SNIPPET}\n</body>`)
    : html + RELOAD_SNIPPET;
}

/** Default `options.onRebuild` — plain, uncolored text; callers wanting
 * their own presentation (the CLI's colored dev-server banner, say) pass
 * their own and this is never called. */
const defaultOnRebuild = (info) => {
  if (info.changed?.length > 0) console.log(`mdy: changed: ${info.changed.join(', ')}`);
  if (info.ok) {
    const detail = info.reused > 0 ? ` (${info.reused} reused, ${info.rebuilt} rebuilt)` : '';
    const held = info.messages?.length > 0 ? `, ${info.messages.length} message(s) held` : '';
    console.log(`mdy: rendered ${info.pages} page(s) in ${info.ms}ms${detail}${held}`);
  } else {
    console.error(`mdy: build failed — still serving the last good build\n  ${info.error}`);
  }
};

/**
 * Serve a site with watch + rebuild + live reload. Returns
 * { server, port, url, stats, close } — close() stops the watcher, drops
 * SSE clients, and shuts the server down. `stats` is a live getter for the
 * most recent build's `{ reused, rebuilt }` output-file lists (see
 * build.js's renderSite — `reused` is always empty; no incremental cache).
 *
 * `options.onRebuild(info)` — fires after every rebuild attempt, including
 * the first (`info.first`): `{ ok: true, first, changed, pages, ms, reused,
 * rebuilt, messages }` on success, `{ ok: false, first, changed, error }` on
 * failure. `messages` is every `$.publish` the rebuild made, unsent — the
 * dev server never publishes (a rebuild happens on every save, and a
 * publish that went out would re-fire on every keystroke), but it says so
 * rather than dropping them silently
 * (the last good build keeps serving). `changed` is the list of watched
 * paths that triggered this rebuild — empty for the first (nothing changed
 * yet, it just ran). Defaults to plain `console.log`/`console.error` text
 * (defaultOnRebuild, above) — a hook, not policy, same shape as
 * onQuery/onEmit elsewhere. `options.onSource` — see renderSite/
 * renderScriptSite; passed straight through, so it fires on every rebuild,
 * not just the first (a script-defined site has no incremental cache —
 * see script-site.js — so every rebuild re-walks and re-ingests the whole
 * directory).
 */
export async function serveSite(root, options = {}) {
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { extname, join, resolve, sep } = await import('node:path');

  /** Read `p` (URL-decoded, no leading slash) from the first of `dirs` that
   * has it, pinned inside each against traversal — root's own static/
   * first, then each import's, matching build.js's "site overrides theme"
   * precedence. null if `p` is a metadata sidecar (a .mdy — queryable via
   * $.find, not something to serve raw, matching buildSite's own exclusion
   * of these from static/'s copy to dist/) or found in none of them. */
  async function readStatic(dirs, p) {
    if (p.endsWith('.mdy')) return null;
    for (const dir of dirs) {
      const file = resolve(dir, ...p.split('/'));
      if (!file.startsWith(dir + sep)) continue;
      try {
        return await readFile(file);
      } catch {
        // not in this root — try the next
      }
    }
    return null;
  }

  const onRebuild = options.onRebuild ?? defaultOnRebuild;

  root = resolve(root);
  const clients = new Set();
  let outputs = new Map();
  let binaryOutputs = new Map(); // images.js's $.resize results — served like outputs, never written to disk here
  let stats = { reused: [], rebuilt: [] }; // last successful build's report (reused is always empty — no cache)
  // static/ dirs to serve from, root's own first — populated from the first
  // successful build's import graph (see the `roots` comment below).
  let staticDirs = [join(root, 'static')];
  let allRoots = [root]; // root + every resolved import, for the watcher set below
  let firstRun = true;
  let pendingChanges = new Set(); // watched paths changed since the last rebuild attempt

  const rebuild = async () => {
    const first = firstRun;
    firstRun = false;
    const changed = [...pendingChanges];
    pendingChanges = new Set();
    const started = Date.now();
    try {
      const rendered = await renderSite(root, options);
      outputs = rendered.outputs;
      binaryOutputs = rendered.binaryOutputs;
      stats = rendered.stats;
      // rendered.roots is every import-graph directory, root itself last;
      // root's own static/ first here instead, so a lookup below tries it
      // before any import's (first match wins — the same "site overrides
      // theme" precedence build.js's copy order gives via last-write-wins).
      staticDirs = [root, ...rendered.roots.filter((r) => r !== root)].map((r) => join(r, 'static'));
      allRoots = [root, ...rendered.roots.filter((r) => r !== root)];
      onRebuild({
        ok: true,
        first,
        changed,
        pages: outputs.size,
        ms: Date.now() - started,
        reused: stats.reused.length,
        rebuilt: stats.rebuilt.length,
        // What the site WOULD have published. The dev server never sends:
        // there is no incremental cache here, so every save reruns the
        // entry from scratch and a publish that went out would re-fire on
        // every keystroke (see src/publish.js). But dropping them without
        // a word made $.publish look like it did nothing at all, which is
        // the one thing it must not look like.
        messages: rendered.messages,
        // The set this rebuild produced. A caller that also delivers
        // messages to pages needs to swap to it, so that editing a page
        // changes what the next message renders — the whole reason this
        // is one process and not two.
        site: { set: rendered.set, pages: rendered.pages, messages: rendered.messages },
      });
      return true;
    } catch (err) {
      onRebuild({ ok: false, first, changed, error: err.message ?? String(err) });
      return false;
    }
  };

  // Debounced rebuild-on-change; changes arriving mid-rebuild queue one more.
  let timer = null;
  let building = false;
  let dirty = false;
  const run = async () => {
    if (building) {
      dirty = true;
      return;
    }
    building = true;
    const ok = await rebuild();
    building = false;
    if (dirty) {
      dirty = false;
      return run();
    }
    if (ok) for (const res of clients) res.write('data: reload\n\n');
  };
  const onChange = ({ path }) => {
    if (IGNORE.test(path)) return;
    pendingChanges.add(path);
    clearTimeout(timer);
    timer = setTimeout(run, 80);
  };

  await rebuild(); // a broken first build still serves — fix and save
  // One watcher per resolved root (root + every import) — so editing an
  // imported style package while `mdy dev` is running triggers a rebuild
  // too, not just editing the site itself. Fixed at startup from the first
  // build's import graph: a later edit that changes WHICH packages are
  // imported won't pick up a new watcher until `mdy dev` is restarted —
  // an accepted limitation, same spirit as any dev server needing a
  // restart after a fundamental config change.
  const watchers = await Promise.all(allRoots.map((dir) => nodeFsProvider().watch(dir, onChange)));

  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    if (pathname === RELOAD_PATH) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 300\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // Rendered pages first: /, /posts/hello/, and the slashless /posts/hello.
    const p = pathname.replace(/^\/+/, '');
    const candidates = p === '' ? ['index.html'] : p.endsWith('/') ? [`${p}index.html`] : [p, `${p}/index.html`];
    for (const key of candidates) {
      if (!outputs.has(key)) continue;
      const type = MIME[extname(key)] ?? 'application/octet-stream';
      const body = type.startsWith('text/html') ? withReload(outputs.get(key)) : outputs.get(key);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    // Then a binary build output (an images.js $.resize result) — exact
    // path, no pretty-URL candidates (these are literal file paths, not
    // pages).
    if (binaryOutputs.has(p)) {
      const type = MIME[extname(p)] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(Buffer.from(binaryOutputs.get(p)));
      return;
    }

    // Then static/ from disk — pinned inside the directory against traversal.
    if (p !== '') {
      const body = await readStatic(staticDirs, p);
      if (body) {
        res.writeHead(200, {
          'content-type': MIME[extname(p)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(body);
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    const notFound = outputs.get('404.html') ?? `<h1>404</h1>\n<p><code>${escapeHtml(pathname)}</code> not found.</p>`;
    res.end(withReload(notFound));
  });

  await new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 4321, ready);
  });
  const { port } = server.address();

  return {
    server,
    port,
    url: `http://localhost:${port}/`,
    // A live getter, not a snapshot — reflects the most recent build's
    // { reused, rebuilt } output-file lists (both empty before the first
    // build completes; `rebuild` reassigns `stats`, this always reads it).
    get stats() {
      return stats;
    },
    close: () =>
      new Promise((done) => {
        for (const watcher of watchers) watcher.close();
        clearTimeout(timer);
        for (const res of clients) res.end();
        clients.clear();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
