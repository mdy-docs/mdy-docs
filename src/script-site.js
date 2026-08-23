import { nodeFsProvider } from './fs-provider.js';
import { toHtml } from './mdy.js';
import { normalizeDate, rfc822 } from './format.js';
import { createResizeNative } from './images.js';
import { tokenize } from './search.js';
import { buildImportGraph } from './imports.js';

/*
 * renderScriptSite — proving docs/plan.md's "Toward a script-defined
 * site": instead of edubba's own vault.js interpreting file paths into
 * section/slug/url/date *before* any template runs, this inserts every
 * file with nothing but its raw identity (path/name/ext/size/mtime, plus
 * width/height for images — see walkRawSources) — plus, for .mdy files,
 * whatever front matter it declares, since mdy's own parser already
 * extracts that; that's the file FORMAT's job, not an edubba convention
 * layered on top. One designated entry document then does ALL
 * interpretation itself, in template code: which files are "posts" (a
 * path prefix it chooses), what URL each gets, what layout wraps it —
 * using $.find (raw, already-inserted documents), $.render (an existing
 * layout document), $.emit (a named output), and three small, genuinely
 * host-dependent primitives no amount of script JS can replace:
 * $.resize (WASM image codecs), $.tokenize (the search widget's word
 * list), and $.rfc822 (RSS pubDate — the lamassu VM forbids `new Date()`).
 * None of these three carry any policy of their own — resize doesn't decide
 * which images get resized, tokenize doesn't decide what's searchable,
 * rfc822 doesn't decide what's in the feed; the script decides everything,
 * these just do the host-only work underneath.
 *
 * A fourth used to live here — $.markdown, CommonMark → HTML — and does
 * not any more. It is a fixed native of the document set itself now (see
 * src/mdy.js), because Markdown stopped being something a site turns into
 * HTML text and became one of the two front ends every document set has:
 * it returns a tree, the same as $.render does.
 *
 * Deliberately NOT wired into renderSite's incremental cache — a script's
 * output is only ever fully rebuilt, never reused verbatim (see build.js's
 * dispatch). See examples/blog for a real site defined this way.
 *
 * A script can also `% import name from "spec"` another mdy project —
 * a style/theme package, or anything else — entirely from its own code, no
 * host convention involved (see ./imports.js). buildImportGraph handles
 * walking/compiling the whole import graph; this file's job is just
 * building the natives every level needs (resize/tokenize/rfc822/markdown)
 * and resolving the top-level entry once the graph is built.
 */

/**
 * Render a site whose ENTIRE definition — file conventions, URLs,
 * layouts, output shape — lives in one mdy script, not host JS.
 *
 *   root            site directory: every file under it is inserted as a
 *                   raw document; dist/, node_modules/, and dotfiles/
 *                   dot-directories are excluded (walkRawSources)
 *   options.entry   path to the entry script, relative to root
 *                   (default: 'main.mdy')
 *   options.now     build-time "today", threaded into the entry script's
 *                   context as a canonical YYYY-MM-DD *string* (`today`)
 *                   — never a Date object, since the sandboxed VM cannot
 *                   construct one itself (`new` is disallowed entirely;
 *                   confirmed: `new Date()` is a SyntaxError inside a
 *                   template, not just blocked at runtime)
 *   options.context extra context merged over `{ today }` for the entry's
 *                   own render (e.g. a CLI's -d/--data-file values, or
 *                   buildSite's --drafts/--future flags)
 *   options.fs      a fs-provider.js provider (default: the real
 *                   filesystem) — memoryFsProvider works identically,
 *                   same as renderSite
 *   options.onSource(meta)  fires once per raw document, right after each
 *                   directory's walk and before anything is rendered —
 *                   every file under `root`, and under anything it (or
 *                   anything it imports) resolves an import to, that got
 *                   ingested into a document set (a hook, not policy —
 *                   e.g. the CLI's own "[read] <path>" logging; see
 *                   bin/mdy.js)
 *
 * Returns `{ output, text, outputs, binaryOutputs, roots }` — `output` is
 * the entry script's own rendered HTML and `text` the text its code wrote
 * (its own normal return values, same as any `$.render` / `$.text`);
 * `outputs` is a `Map<path, content>` of
 * everything it (or anything it `$.render`s or imports along the way)
 * produced via `$.emit`; `binaryOutputs` is a `Map<path, Uint8Array>` of
 * everything it produced via `$.resize`; `roots` is every resolved
 * directory in the import graph, `root` itself last (build.js/serve.js's
 * static/ passthrough copies in this order, so `root`'s own static/ wins
 * any filename collision against something it imports). Nothing is
 * written to disk here — that's the caller's job, mirroring
 * renderSite/buildSite's own split.
 */
export async function renderScriptSite(root, options = {}) {
  const fs = options.fs ?? nodeFsProvider();
  if (!options.fs) root = (await import('node:path')).resolve(root);

  const binaryOutputs = new Map();
  const buildNatives = (absDir) => ({
    resize: createResizeNative({ fs, root: absDir, registerBinaryOutput: (path, bytes) => binaryOutputs.set(path, bytes) }),
    tokenize,
    rfc822,
  });

  const outputs = new Map();
  const roots = [];
  const set = await buildImportGraph(root, {
    fs,
    buildNatives,
    onEmit: ({ path, content }) => outputs.set(path, typeof content === 'string' ? content : JSON.stringify(content)),
    onSource: options.onSource,
    cache: new Map(),
    roots,
  });

  const entryPath = options.entry ?? 'main.mdy';
  const entryIndex = set.docs.find((d) => d.data.path === entryPath)?.index;
  if (entryIndex === undefined) {
    throw new Error(`renderScriptSite: entry script not found at ${JSON.stringify(entryPath)} (looked among ${set.docs.length} document(s) under ${root})`);
  }

  const today = normalizeDate(options.now ?? new Date());
  const context = { today, ...options.context };
  // Both readings of "what the entry itself produced": the finished document,
  // and the text its own code wrote. An entry script is usually run for its
  // $.emit side effects and neither is used at all, but the CLI shows one or
  // the other and they are not the same thing — one document in three here
  // deliberately is not markup.
  const result = await set.renderResult(entryIndex, context);

  return { output: toHtml(result.tree), text: result.text, outputs, binaryOutputs, roots };
}
