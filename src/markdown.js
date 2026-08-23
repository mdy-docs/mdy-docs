import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { remarkAlert } from 'remark-github-blockquote-alert';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import { createHeadingIds, normalizeHeadingId } from './parse/heading.js';
import { toText } from './parse/script.js';

/*
 * The Markdown front end: `.md` text in, hast out, and nothing after that.
 *
 * mdy-docs speaks two markup languages and composes ONE tree type. This file
 * is the second front end — the first being src/parse, mdy's own — and the
 * whole of its job is to stop at the tree. It does not stringify to HTML, and
 * nothing downstream takes a string apart again: a `.md` document arrives as
 * hast the same as an `.mdy` one does, and every later stage (composition,
 * `transform`, the TOC, the React target) sees one kind of thing from two
 * kinds of file.
 *
 * rehype-raw is here, and ONLY here. CommonMark says a raw `<div>` in
 * markdown passes through as written, so somebody has to turn that text into
 * elements, and re-parsing raw nodes is exactly what rehype-raw is for. What
 * it used to also do — put back together a page that had been assembled as a
 * string out of several documents — is gone: it runs on one document's own
 * text, at that document's own boundary, so an unclosed tag can reach the end
 * of the file it was written in and no further.
 */

// remark-parse → gfm → GitHub alerts → hast, with raw HTML reparsed into real
// elements. Frozen once; `.md` has no options to vary.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkAlert)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .freeze();

/**
 * Markdown text → a hast tree.
 *
 * Headings get ids from mdy's own slugger (see src/parse/heading.js), so a
 * `#anchor` written in one format lands on a heading written in the other.
 * `options.headingState` shares one run of ids across several documents that
 * will end up on one page; without it each document numbers its own.
 *
 * @param {string} text
 * @param {{headingState?: import('./parse/heading.js').State, headingId?: boolean}} [options]
 * @returns {import('hast').Root}
 */
export function markdownToHast(text, options = {}) {
  const tree = processor.runSync(processor.parse(String(text ?? '')));
  const settings = normalizeHeadingId(options.headingId);
  const headings = options.headingState ?? (settings ? createHeadingIds(settings) : undefined);
  if (headings) identifyHeadings(tree, headings);
  return tree;
}

/**
 * Give every heading an id it does not already have.
 *
 * @param {import('hast').Node} node
 * @param {import('./parse/heading.js').State} headings
 */
function identifyHeadings(node, headings) {
  if (/^h[1-6]$/.test(node.tagName ?? '')) {
    node.properties ??= {};
    if (node.properties.id === undefined) {
      const id = headings.id(toText(node));
      if (id) node.properties.id = id;
    }
  }
  for (const child of node.children ?? []) identifyHeadings(child, headings);
}
