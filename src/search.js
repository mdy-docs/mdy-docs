/*
 * tokenize — the search widget's word-list algorithm. Exposed to a
 * script-defined site as the $.tokenize native (script-site.js), since a
 * word-list index is exactly the kind of host-only-but-not-policy
 * primitive documented there: it doesn't decide what's searchable, the
 * entry script does (which pages to index, what excerpt/tags to ship).
 *
 * `tokenize` here and the widget's own copy (examples/blog/static/
 * search.js) are two independent implementations (Node here, a plain
 * <script> there — no bundler in this project to share one module between
 * them) that must stay in algorithmic agreement: if this one changes,
 * update the widget's too, or a shipped `words` list stops matching what a
 * visitor's query tokenizes to.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will',
  'with',
]);

/** Lowercased, punctuation-stripped words of length > 1, stopwords and
 * duplicates removed, in order of first appearance. */
export function tokenize(text) {
  const words = String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return [...new Set(words)];
}
