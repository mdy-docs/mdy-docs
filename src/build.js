import { nodeFsProvider } from './fs-provider.js';
import { releaseHeld } from './compose.js';
import { rotateRenderMemo } from './mdy.js';
import { renderScriptSite } from './script-site.js';

/*
 * mdy build/serve — every site is a script-defined site: root has an entry
 * document (main.mdy by default, or options.entry) that decides
 * everything itself — content conventions, URLs, layouts, output shape —
 * via $.find/$.render/$.emit (see script-site.js). renderSite, below, is
 * the thin "resolve root/entry, call renderScriptSite, reshape the result"
 * layer buildSite/serveSite both build on; neither needed to change when
 * the conventional content/layouts/site.yaml convention this file used to
 * also support was removed (docs/site-plan.md's "Toward a script-defined
 * site" has the design history).
 *
 * node:path is imported LAZILY (dynamic import) — a browser bundle
 * imports this file, and Rollup statically rejects a *static* import of a
 * browser-externalized Node builtin even when nothing would call it at
 * runtime (buildSite, disk-only, is never called from the browser; see
 * fs-provider.js for the fuller explanation of this pattern).
 */

/** Pretty URL → output file: /posts/hello/ → posts/hello/index.html. A
 * generic string utility, not tied to any site-building convention — an
 * entry script is free to use it (or not) when deciding its own $.emit
 * paths. */
export function urlToOutFile(url) {
  const path = url.replace(/^\/+|\/+$/g, '');
  return path === '' ? 'index.html' : `${path}/index.html`;
}

/**
 * Render a site in memory: root (holding an entry document) → { outputs,
 * binaryOutputs, stats }, where `outputs` maps output file paths
 * (posts/hello/index.html) to their finished content, and `binaryOutputs`
 * maps output file paths to raw bytes (Uint8Array) — $.resize results
 * (images.js). No filesystem writes — buildSite persists to dist/, the dev
 * server serves straight from here. `stats: { reused: string[], rebuilt:
 * string[] }` — every build reruns the entry from scratch (it is what
 * decides the site exists at all; see script-site.js's own file-level
 * comment) and so re-emits every output, which is why `reused` is always
 * empty. That is about OUTPUTS. Work is reused underneath: an unchanged file
 * is not re-parsed and an unchanged render is not re-run (the ingest and
 * render memos, both in src/mdy.js).
 *
 * Options: `entry` (default 'main.mdy'). `drafts`/`future` thread through
 * as plain context booleans for the entry script to interpret itself, not
 * filtered here — even lifecycle filtering is the script's own call.
 * `now` overrides build-time "today". `fs` is a fs-provider.js provider —
 * the real filesystem by default; pass memoryFsProvider(...) to run
 * entirely in-browser, which is also why `root` is only
 * resolve()d against the real filesystem's cwd when no custom provider is
 * given — a browser root is just a virtual string, not an OS path.
 * `onSource`/`onQuery`/`onEmit`/`onIngest` — see renderScriptSite; passed
 * straight through.
 *
 * Also returns `roots`: every directory in `root`'s import graph (see
 * script-site.js/imports.js), `root` itself last — buildSite/serveSite use
 * this to also serve/copy each imported package's own static/, not just
 * root's.
 */
export async function renderSite(root, options = {}) {
  // A build is a closed episode: everything it emits is composed to HTML on
  // the way out, so no token it made is live once it ends. Reclaiming here, at
  // the START of the next one, is what stops `mdy dev` from accumulating every
  // tree of every rebuild — and it is a no-op if a render is somehow still
  // running, so a caller rendering from a set between builds cannot be cut off
  // mid-flight (see src/compose.js).
  releaseHeld();
  // …and start a new memo generation, so this build can reuse the last one's
  // renders and nothing older stays alive (see mdy.js's render memo).
  rotateRenderMemo();
  if (!options.fs) root = (await import('node:path')).resolve(root);
  const fs = options.fs ?? nodeFsProvider();
  const entry = options.entry ?? 'main.mdy';

  const { outputs, binaryOutputs, messages, roots, set, pages } = await renderScriptSite(root, {
    fs,
    entry,
    now: options.now,
    context: { drafts: Boolean(options.drafts), future: Boolean(options.future) },
    onEmit: options.onEmit,
    onIngest: options.onIngest,
    onQuery: options.onQuery,
    onSource: options.onSource,
  });

  return {
    outputs,
    binaryOutputs,
    messages,
    roots,
    set,
    pages,
    stats: { reused: [], rebuilt: [...outputs.keys(), ...binaryOutputs.keys()] },
  };
}

/**
 * Build a site to disk: root (holding an entry document, static/) →
 * outDir (default <root>/dist). Options: outDir, plus renderSite's
 * { entry, drafts, future, now, onSource }. `options.onWrite(file)` fires
 * once per file actually written under outDir — a page/binary output or a
 * static/ passthrough — dist-relative path, in write order (a hook, not
 * policy — e.g. the CLI's own "[write] <path>" logging; see bin/mdy.js).
 * Returns { pages, outDir, messages } — `messages` is every $.publish the
 * build made, in call order, unsent (see src/publish.js).
 *
 * Every write goes through the fs provider, so a host with no node:fs runs
 * this function unchanged rather than reimplementing it — see the note inside.
 */
export async function buildSite(root, options = {}) {
  /*
   * Writes go through the SAME provider reads do. That is not tidiness: it is
   * what lets a host with no node:fs at all — the native backend in
   * packages/mdy-native, which reaches a POSIX filesystem through five C
   * calls — run this function rather than reimplementing it beside it. The
   * only thing still node-only is resolving a relative root against a real
   * cwd, and that is already conditional for the same reason (see renderSite).
   */
  const fs = options.fs ?? nodeFsProvider();
  if (!options.fs) {
    const { resolve, join } = await import('node:path');
    root = resolve(root);
    options = { ...options, outDir: resolve(options.outDir ?? join(root, 'dist')) };
  } else if (!options.outDir) {
    options = { ...options, outDir: `${String(root).replace(/\/+$/, '')}/dist` };
  }
  const outDir = options.outDir;

  const { outputs, binaryOutputs, messages, roots } = await renderSite(root, { ...options, fs });
  const onWrite = options.onWrite;

  for (const [file, html] of outputs) {
    await fs.write(outDir, file, html);
    onWrite?.(file);
  }
  for (const [file, bytes] of binaryOutputs) {
    await fs.writeBinary(outDir, file, bytes);
    onWrite?.(file);
  }

  // static/ is copied through verbatim — the one directory a script can't
  // reach itself: there's no raw filesystem read access from inside the
  // sandboxed VM (by design — docs/site-plan.md's "Raw file access" note),
  // so binary assets have to be passed through by the host, same as
  // walkRawSources already gives $.resize host-side (not VM-side) access
  // to a source image's real bytes. .mdy files are excluded: a metadata
  // sidecar (static/logo.png.mdy) belongs in the document set, queryable
  // via $.find, not published as a raw text file a visitor could stumble
  // onto.
  //
  // Every root in the import graph gets its own static/ copied the same
  // way, root itself LAST (roots' own order — see script-site.js) — so
  // root's own static/ overwrites any same-named file an import provides,
  // matching Hugo/Jekyll's "site overrides theme".
  //
  // Byte-for-byte through readBinary/writeBinary rather than a recursive
  // copy: `cp` is faster, but it is node's, and a static/ is assets rather
  // than a corpus. A missing static/ lists as [] — the provider contract
  // says so — which is why there is no existence check here.
  for (const dir of roots) {
    for (const file of await fs.list(dir, 'static', { extensions: null })) {
      if (file.endsWith('.mdy')) continue;
      await fs.writeBinary(outDir, file, await fs.readBinary(dir, `static/${file}`));
      onWrite?.(file);
    }
  }

  // Messages are handed back rather than sent: they are the build's
  // OUTPUT, exactly like outputs/binaryOutputs, and this function's job
  // ends at the filesystem. Flushing them only now — after every write
  // above has succeeded — is the deferred half of $.publish (see
  // src/publish.js); a build that throws on its way here never publishes
  // anything, which is the point.
  return { pages: outputs.size, outDir, messages };
}
