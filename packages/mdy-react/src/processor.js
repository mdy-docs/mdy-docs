// The React target for mdy documents.
//
// There is deliberately almost nothing here, and that is the point: both of
// mdy-docs' front ends — its own parser for `.mdy`, remark for `.md` — end at
// hast, a plain tree, and everything after that is output-agnostic. Producing
// an HTML string from that tree is one compiler (rehype-stringify); producing
// React elements is another (hast-util-to-jsx-runtime). Every stage above the
// compiler is shared verbatim with the string path, so the two targets cannot
// drift: a fix to the grammar, to composition, or to heading ids lands in
// both at once.
//
// This got smaller when documents stopped being composed as text. There is no
// raw-HTML repair step to keep in step any more, and no markdown boundary to
// agree about: a nested render arrives as a subtree that was already spliced
// into place before either compiler saw it.
//
// Nothing in the document engine itself — splitting, front matter, the lamassu
// VM, nisaba queries — is involved in this choice at all. It never touches a
// DOM, so there was nothing to "port".

import { createProcessor } from 'mdy-docs';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import rehypeSanitize from 'rehype-sanitize';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { mdySanitizeSchema } from './sanitize.js';

/**
 * The unified compiler: hast → React element. Returned as an already-bound,
 * option-free plugin, because `.use(plugin)` is the shape createProcessor's
 * `compiler` slot takes — an array there would be read as a plugin *list*.
 *
 * @param {{ components?: object, passNode?: boolean }} [options]
 */
const reactCompiler = ({ components, passNode = true, tableCellAlignToStyle = false } = {}) =>
  function () {
    this.compiler = (tree) =>
      toJsxRuntime(tree, { Fragment, jsx, jsxs, components, passNode, tableCellAlignToStyle });
  };

/**
 * Create a processor whose renders resolve to React elements instead of HTML
 * strings. Same signature and same return shape as mdy-docs' createProcessor
 * — `render`, `renderMdy`, `renderMarkdown` and `renderTree` all still exist
 * and mean the same things; only what they resolve to changes.
 *
 * `components` is where the real leverage is. Every tag the pipeline emits can
 * be replaced by a component of yours — `{ code: CodeBlock, a: Link, h2: … }`
 * — which is how a fenced block becomes a live Shiki highlighter or a mermaid
 * diagram with its own lifecycle, rather than an HTML string you re-scan and
 * patch after the fact. Components receive the usual props plus `node` (the
 * hast node) unless `passNode: false`.
 *
 * @param {object} [options]
 * @param {Record<string, any>} [options.components] tag name → React component
 * @param {boolean} [options.passNode] pass the hast node as a `node` prop
 *   (default true)
 * @param {boolean} [options.tableCellAlignToStyle] rewrite a table cell's
 *   `align` attribute as an inline `text-align` style. Defaults to `false`,
 *   unlike hast-util-to-jsx-runtime's own default: `align` is obsolete HTML,
 *   but it is what mdy's string target emits, and a stylesheet that works
 *   against one target should work against the other. Set it true if you
 *   would rather have the modern attribute than the matching one.
 * @param {Array} [options.rehypePlugins] extra hast-side plugins, run on the
 *   finished tree and before sanitization
 * @param {boolean | object} [options.sanitize] `false` (the default, matching
 *   mdy-docs' own HTML output) renders the document's own elements as
 *   written — correct when you author the documents, unsafe when your users
 *   do. `true` applies mdySanitizeSchema, which keeps mdy's own markup
 *   (elements, alert boxes with their icons, heading ids) working; pass a
 *   schema object to use your own. See ./sanitize.js. Note that mdy's parser
 *   has a sanitizer of its own, on by default for untrusted input — this one
 *   is a second pass over the finished tree, and the two compose.
 * @returns {{ processor: object, renderMdy: Function, renderMarkdown: Function, renderTree: Function, render: Function }}
 */
export function createReactProcessor(options = {}) {
  const { components, passNode, tableCellAlignToStyle, rehypePlugins = [], sanitize = false } = options;
  return createProcessor({
    // Sanitization goes last: it must see the tree every other plugin has
    // finished with.
    rehypePlugins: sanitize
      ? [...rehypePlugins, [rehypeSanitize, sanitize === true ? mdySanitizeSchema : sanitize]]
      : rehypePlugins,
    compiler: reactCompiler({ components, passNode, tableCellAlignToStyle }),
  });
}

/**
 * One-shot: mdy source → React element. Builds a document set, renders the
 * entry document, drops the set — the React-target twin of mdy-docs' `render`.
 * For repeated renders of a changing source (a live editor), create one
 * processor and reuse it, or use the `useMdy` hook, which does that for you.
 *
 * @param {string | string[]} source
 * @param {object} [data] the entry document's `req`
 * @param {object} [options] as createReactProcessor, plus `entry`
 * @returns {Promise<import('react').ReactElement>}
 */
export function renderToReact(source, data = {}, options = {}) {
  const { entry = 0, ...rest } = options;
  return createReactProcessor(rest).render(source, data, entry);
}
