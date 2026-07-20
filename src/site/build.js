import { nodeFsProvider } from '../fs-provider.js';
import { renderScriptSite } from './script-site.js';

/*
 * mdy build/serve — every site is a script-defined site: root has an entry
 * document (index.mdy by default, or options.entry) that decides
 * everything itself — content conventions, URLs, layouts, output shape —
 * via $.find/$.render/$.emit (see script-site.js). renderSite, below, is
 * the thin "resolve root/entry, call renderScriptSite, reshape the result"
 * layer buildSite/serveSite both build on; neither needed to change when
 * the conventional content/layouts/site.yaml convention this file used to
 * also support was removed (docs/site-plan.md's "Toward a script-defined
 * site" has the design history).
 *
 * node:path is imported LAZILY (dynamic import) — web/'s Vite bundle
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
 * string[] }` — a script-defined site has no incremental cache (every
 * build/rebuild walks the whole directory and reruns the entry from
 * scratch; see script-site.js's own file-level comment), so `reused` is
 * always empty.
 *
 * Options: `entry` (default 'index.mdy'). `drafts`/`future` thread through
 * as plain context booleans for the entry script to interpret itself, not
 * filtered here — even lifecycle filtering is the script's own call.
 * `now` overrides build-time "today". `fs` is a fs-provider.js provider —
 * the real filesystem by default; pass memoryFsProvider(...) to run
 * entirely in-browser (see web/), which is also why `root` is only
 * resolve()d against the real filesystem's cwd when no custom provider is
 * given — a browser root is just a virtual string, not an OS path.
 * `onSource` — see renderScriptSite; passed straight through.
 */
export async function renderSite(root, options = {}) {
  if (!options.fs) root = (await import('node:path')).resolve(root);
  const fs = options.fs ?? nodeFsProvider();
  const entry = options.entry ?? 'index.mdy';

  const { outputs, binaryOutputs } = await renderScriptSite(root, {
    fs,
    entry,
    now: options.now,
    context: { drafts: Boolean(options.drafts), future: Boolean(options.future) },
    onSource: options.onSource,
  });

  return {
    outputs,
    binaryOutputs,
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
 * Returns { pages, outDir }.
 */
export async function buildSite(root, options = {}) {
  const { dirname, join, resolve } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const { cp, mkdir, writeFile } = await import('node:fs/promises');
  const { walkFiles } = await import('../vault.js');

  root = resolve(root);
  const outDir = resolve(options.outDir ?? join(root, 'dist'));
  const { outputs, binaryOutputs } = await renderSite(root, options);
  const onWrite = options.onWrite;

  for (const [file, html] of outputs) {
    const dest = join(outDir, file);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, html);
    onWrite?.(file);
  }
  for (const [file, bytes] of binaryOutputs) {
    const dest = join(outDir, file);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
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
  const notSidecar = (src) => !src.endsWith('.mdy');
  const staticDir = join(root, 'static');
  if (existsSync(staticDir)) {
    if (onWrite) {
      // A plain inventory pass, purely for reporting — cp() below does the
      // actual copy; this never reads file content (walkFiles), so it's
      // cheap even for a static/ full of images. walkFiles' own paths are
      // already relative to staticDir and '/'-separated, which is exactly
      // the dist-relative path once static/'s contents are flattened to
      // the dist root (static/logo.png → dist/logo.png).
      for (const f of await walkFiles(staticDir)) {
        if (f.ext !== '.mdy') onWrite(f.path);
      }
    }
    await cp(staticDir, outDir, { recursive: true, filter: notSidecar });
  }

  return { pages: outputs.size, outDir };
}
