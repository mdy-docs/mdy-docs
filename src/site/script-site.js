import { openDocumentSet, MarkdownIt } from '../mdy.js';
import { nodeFsProvider } from '../fs-provider.js';
import { walkRawSources } from '../vault.js';
import { normalizeDate, rfc822 } from './vault.js';
import { createResizeNative } from './images.js';
import { tokenize } from './search.js';

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
 * layout document), $.emit (a named output), and four small, genuinely
 * host-dependent primitives no amount of template JS can replace:
 * $.resize (WASM image codecs), $.tokenize (the search widget's word
 * list), $.rfc822 (RSS pubDate — the lamassu VM forbids `new Date()`), and
 * $.markdown (CommonMark → HTML — markdown-it, not a hand-rollable parser).
 * None of these four carry any policy of their own — resize doesn't decide
 * which images get resized, tokenize doesn't decide what's searchable,
 * rfc822 doesn't decide what's in the feed, markdown doesn't decide which
 * pages get rendered; the script decides everything, these just do the
 * host-only work underneath.
 *
 * Deliberately NOT wired into renderSite's incremental cache — a script's
 * output is only ever fully rebuilt, never reused verbatim (see build.js's
 * dispatch). See examples/blog for a real site defined this way.
 */

/**
 * Render a site whose ENTIRE definition — file conventions, URLs,
 * layouts, output shape — lives in one mdy script, not host JS.
 *
 *   root            site directory: every file under it is inserted as a
 *                   raw document; dist/, node_modules/, and dotfiles/
 *                   dot-directories are excluded (walkRawSources)
 *   options.entry   path to the entry script, relative to root
 *                   (default: 'index.mdy')
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
 *   options.onSource(meta)  fires once per raw document, right after the
 *                   walk and before anything is rendered — every file
 *                   under `root` that got ingested into the document set,
 *                   in walk order (a hook, not policy — e.g. the CLI's own
 *                   "[read] <path>" logging; see bin/mdy.js)
 *
 * Returns `{ output, outputs, binaryOutputs }` — `output` is the entry
 * script's own rendered markdown (its template's normal return value, same
 * as any `$.render`); `outputs` is a `Map<path, content>` of everything it
 * (or anything it `$.render`s along the way) produced via `$.emit`;
 * `binaryOutputs` is a `Map<path, Uint8Array>` of everything it produced
 * via `$.resize`. Nothing is written to disk here — that's the caller's
 * job, mirroring renderSite/buildSite's own split.
 */
export async function renderScriptSite(root, options = {}) {
  const fs = options.fs ?? nodeFsProvider();
  if (!options.fs) root = (await import('node:path')).resolve(root);

  const sources = await walkRawSources(root, { fs });
  if (options.onSource) for (const { meta } of sources) options.onSource(meta);

  const binaryOutputs = new Map();
  const resize = createResizeNative({ fs, root, registerBinaryOutput: (path, bytes) => binaryOutputs.set(path, bytes) });
  const md = new MarkdownIt({ html: true, linkify: true });

  const entryPath = options.entry ?? 'index.mdy';
  const outputs = new Map();
  const set = await openDocumentSet(sources, {
    onEmit: ({ path, content }) => outputs.set(path, typeof content === 'string' ? content : JSON.stringify(content)),
    natives: { resize, tokenize, rfc822, markdown: (text) => md.render(String(text ?? '')) },
  });

  // Resolved AFTER the set is built (not against the pre-split `sources`
  // array): a sibling file with its own internal `---` splits contributes
  // more than one document, which would otherwise shift every later file's
  // position and misalign a plain positional lookup.
  const entryIndex = set.docs.find((d) => d.data.path === entryPath)?.index;
  if (entryIndex === undefined) {
    throw new Error(`renderScriptSite: entry script not found at ${JSON.stringify(entryPath)} (looked among ${sources.length} file(s) under ${root})`);
  }

  const today = normalizeDate(options.now ?? new Date());
  const output = await set.render(entryIndex, { today, ...options.context });

  return { output, outputs, binaryOutputs };
}
