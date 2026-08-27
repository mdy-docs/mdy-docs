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
 *   - front matter is a FENCED block: +++, YAML, +++, opening on the
 *     document's first non-blank line and required to close; an opener with
 *     no partner is prose      (FRONT_MATTER_SEPARATOR, parseDocument)
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
 *   frontMatterStartLine: number | null, // the opening +++ (null: none)
 *   frontMatterEndLine: number | null,   // the closing +++ (null: none)
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

    // The fence has to open on the first line, give or take blank ones, and
    // it has to close. This read the FIRST +++ as the end of front matter
    // and everything above it as the YAML — the language's other, older
    // spelling. Against a fenced document that put the end ON the opener,
    // so the title scan ran over an empty range: every document in the repo
    // showed up in the outline untitled and folded nothing away.
    let fmStart = -1;
    let fmEnd = -1;
    let open = 0;
    while (open < chunkLines.length && chunkLines[open].trim() === '') open += 1;
    if (FRONT_MATTER_SEPARATOR.test(chunkLines[open] ?? '')) {
      let close = open + 1;
      while (close < chunkLines.length && !FRONT_MATTER_SEPARATOR.test(chunkLines[close])) close += 1;
      if (close < chunkLines.length) {
        fmStart = open;
        fmEnd = close;
      }
    }

    let title = null;
    let titleLine = null;
    if (fmEnd !== -1) {
      for (let i = fmStart + 1; i < fmEnd; i++) {
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
      frontMatterStartLine: fmStart === -1 ? null : s + fmStart,
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
      frontMatterStartLine: null,
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
    // Opener to closer, and only when there is YAML between them: a `+++`
    // immediately followed by its partner has nothing to fold away.
    if (doc.frontMatterEndLine !== null && doc.frontMatterEndLine > doc.frontMatterStartLine + 1) {
      ranges.push({ start: doc.frontMatterStartLine, end: doc.frontMatterEndLine, kind: 'frontmatter' });
    }
  }
  return ranges;
}

module.exports = { scanDocuments, foldingRanges };
