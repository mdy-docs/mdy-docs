'use strict';

/*
 * Pure document-structure scan for .mdy sources — the shared logic behind
 * extension.cjs's folding and outline providers, unit-tested directly with
 * no vscode dependency (which is the whole reason it lives apart from the
 * adapter). CommonJS because VSCode loads extension entry points via
 * require(); node's ESM loader imports it fine from the tests.
 *
 * The rules mirror src/mdy.js exactly, and test/structure.test.js holds
 * them to that with parseDocuments itself as the oracle:
 *   - a bare --- line splits documents        (DOCUMENT_SEPARATOR)
 *   - the first bare +++ inside a document ends its front matter
 *                                             (FRONT_MATTER_SEPARATOR)
 *   - whitespace-only chunks are dropped, so document INDEXES here are
 *     the engine's own — the `i` a template passes to $.render(i)/$.data(i).
 */

const DOCUMENT_SEPARATOR = /^---[ \t]*$/;
const FRONT_MATTER_SEPARATOR = /^\+\+\+[ \t]*$/;
// `title:` in front matter, the outline label. A deliberate plain-scan
// approximation of YAML (no parser dependency): flow style, anchors,
// multi-line strings etc. just fall back to the raw text after the colon.
const TITLE = /^title[ \t]*:[ \t]*(.+?)[ \t]*$/;

/** Strip one pair of matching surrounding quotes, YAML-style. */
function unquote(value) {
  const m = /^(["'])(.*)\1$/.exec(value);
  return m ? m[2] : value;
}

/**
 * Scan a file's lines into the engine's documents.
 *
 * @param {string[]} lines
 * @returns {{
 *   index: number,          // the engine's document index ($.render/$.data)
 *   startLine: number,      // first line of the chunk (after any ---)
 *   endLine: number,        // last line of the chunk (before the next ---)
 *   separatorLine: number | null,   // the --- introducing it (null: first chunk)
 *   frontMatterEndLine: number | null, // the +++ line (null: no front matter)
 *   title: string | null,   // front matter `title:`, unquoted
 *   titleLine: number | null,
 * }[]}
 */
function scanDocuments(lines) {
  const chunks = [];
  let start = 0;
  let separatorLine = null;
  for (let i = 0; i < lines.length; i++) {
    if (DOCUMENT_SEPARATOR.test(lines[i])) {
      chunks.push({ start, end: i - 1, separatorLine });
      start = i + 1;
      separatorLine = i;
    }
  }
  chunks.push({ start, end: lines.length - 1, separatorLine });

  const docs = [];
  for (const { start: s, end: e, separatorLine: sep } of chunks) {
    const chunkLines = lines.slice(s, e + 1);
    if (chunkLines.every((l) => l.trim() === '')) continue; // dropped by splitDocuments

    const fmEnd = chunkLines.findIndex((l) => FRONT_MATTER_SEPARATOR.test(l));
    let title = null;
    let titleLine = null;
    if (fmEnd !== -1) {
      for (let i = 0; i < fmEnd; i++) {
        const m = TITLE.exec(chunkLines[i]);
        if (m) {
          title = unquote(m[1]);
          titleLine = s + i;
          break;
        }
      }
    }

    docs.push({
      index: docs.length,
      startLine: s,
      endLine: e,
      separatorLine: sep,
      frontMatterEndLine: fmEnd === -1 ? null : s + fmEnd,
      title,
      titleLine,
    });
  }
  // Mirror splitDocuments: an empty (or all-whitespace) source is ONE
  // empty document, not zero — an empty file renders to nothing.
  if (docs.length === 0) {
    docs.push({
      index: 0,
      startLine: 0,
      endLine: Math.max(0, lines.length - 1),
      separatorLine: null,
      frontMatterEndLine: null,
      title: null,
      titleLine: null,
    });
  }
  return docs;
}

/**
 * Folding ranges (0-based, inclusive lines): one per front-matter block, so
 * a long data header can fold away to its first `key:` line. Deliberately
 * NOT one per document — that was tried (anchored on each ---) and felt
 * wrong in practice: whole-document ranges nested awkwardly with markdown's
 * own heading/indentation folding and collapsed more than anyone wanted.
 * Document-level navigation is the OUTLINE's job (one symbol per document),
 * not folding's.
 *
 * @param {string[]} lines
 * @returns {{ start: number, end: number, kind: 'frontmatter' }[]}
 */
function foldingRanges(lines) {
  const ranges = [];
  for (const doc of scanDocuments(lines)) {
    if (doc.frontMatterEndLine !== null && doc.frontMatterEndLine > doc.startLine) {
      ranges.push({ start: doc.startLine, end: doc.frontMatterEndLine, kind: 'frontmatter' });
    }
  }
  return ranges;
}

module.exports = { scanDocuments, foldingRanges };
