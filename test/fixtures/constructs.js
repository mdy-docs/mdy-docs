/*
 * The constructs an MDY syntax highlighter has to know about.
 *
 * There are several highlighters in this repo and none of them is generated
 * from the parser: mdy-site paints the language by hand (its src/syntax.js),
 * the editors carry a TextMate grammar, a Sublime syntax and an Obsidian
 * mode. They drifted, quietly and in different directions — the grammar had
 * no typography, nothing had footnotes — because a language change lands in
 * src/parse/ and nothing tells the rest.
 *
 * This is the shared half of the fix: one list of constructs, and for each,
 * the substring that must come out highlighted. Every highlighter asserts
 * against it in its own vocabulary — `mdy-*` classes here, TextMate scopes
 * there — because the point is not that they agree on names. It is that a
 * construct the language has cannot be invisible in any of them.
 *
 * `marks` are substrings of `source` that must carry SOME highlighting.
 * Deliberately not "which colour": a fixture that pinned scope names would
 * be a second grammar to maintain, and would fail on a rename that broke
 * nothing.
 */

export const CONSTRUCTS = [
  // --- structure ---------------------------------------------------------
  /*
   * Front matter is everything BEFORE the first bare +++ — the parser's own
   * answer, checked rather than assumed: openDocumentSet('title: R\n+++\nb')
   * yields { title: 'R' }, and the fenced +++ … +++ spelling yields {}.
   */
  { name: 'front matter', source: 'title: Roster\n+++\nbody', marks: ['+++'] },
  { name: 'document separator', source: 'one\n---\ntwo', marks: ['---'] },
  { name: 'script line', source: '% const x = 1', marks: ['%'] },
  { name: 'script block', source: '%% const x = 1', marks: ['%%'] },
  { name: 'comment line', source: '# a note', marks: ['#'] },
  { name: 'fence', source: '```js\nconst a = 1;\n```', marks: ['```'] },

  // --- blocks ------------------------------------------------------------
  { name: 'heading', source: '= Title', marks: ['='] },
  { name: 'thematic break', source: '- - -', marks: ['- - -'] },
  { name: 'list item', source: '- an item', marks: ['-'] },
  { name: 'task box', source: '- [x] done', marks: ['[x]'] },
  { name: 'table', source: '| a | b |\n| - | - |\n| 1 | 2 |', marks: ['|'] },
  { name: 'html container', source: '<div', marks: ['div'] },

  // --- inline ------------------------------------------------------------
  { name: 'interpolation', source: '{{ res.data.title }}', marks: ['{{', '}}'] },
  // Raw spans are DOUBLE backticks (docs/language.md §8): a single one is a
  // `<code>` marker like `!!` or `//`, not a fence.
  { name: 'inline marker', source: 'a !!bold!! b', marks: ['!!'] },
  { name: 'raw span', source: 'a ``literal`` b', marks: ['``'] },
  { name: 'wiki link', source: '[[Some Page]]', marks: ['[['] },
  { name: 'autolink', source: 'see https://example.com now', marks: ['https://example.com'] },
  { name: 'hashtag', source: '#topic', marks: ['#topic'] },
  { name: 'mention', source: '@someone', marks: ['@someone'] },
  { name: 'emoji shortcode', source: 'ship :rocket: it', marks: [':rocket:'] },
  { name: 'escape', source: 'a \\!! b', marks: ['\\!!'] },

  /*
   * A footnote is a wiki label opening with `^` — `[[ ^1 ]]`, not
   * CommonMark's `[^1]` (docs/language.md §9). Worth the comment because
   * every wrong guess made while writing this file was a Markdown one:
   * `[^1]` for footnotes, a single backtick for a raw span, `->` for an
   * arrow, `\*` for an escape. MDY is not Markdown, and a fixture written
   * from memory tests the memory.
   */
  { name: 'footnote reference', source: 'a claim[[ ^1 ]]', marks: ['[[ ^1 ]]'] },
  { name: 'footnote definition', source: '[[ ^1 ]]: the note', marks: ['[[ ^1 ]]'] },

  // --- typography --------------------------------------------------------
  // Three substitutions the parser makes inside text. mdy-site painted
  // these; the TextMate grammar left them as prose.
  { name: 'ellipsis', source: 'Well... maybe', marks: ['...'] },
  { name: 'em dash', source: 'a -- b', marks: ['--'] },
  // Arrows are drawn, not typed: --> and ==> (docs/language.md, Typography).
  { name: 'arrow', source: 'MDY --> hast', marks: ['-->'] },
];

/** Every construct's name, for a test that wants to report what it skipped. */
export const names = () => CONSTRUCTS.map((c) => c.name);

/**
 * Where each mark sits in the source, as [start, end) character offsets.
 *
 * Shared because "is this highlighted" is easy to get wrong in the same way
 * twice: a highlighter is free to split `[x]` into three tokens, so asking
 * whether any ONE token contains the whole mark reports a gap that is not
 * there. The question is whether the mark's characters are covered.
 *
 * @param {{ source: string, marks: string[] }} construct
 * @returns {Array<{ mark: string, start: number, end: number }>}
 */
export function markRanges({ source, marks }) {
  return marks.map((mark) => {
    const start = source.indexOf(mark);
    if (start < 0) throw new Error(`fixture: ${JSON.stringify(mark)} is not in its own source`);
    return { mark, start, end: start + mark.length };
  });
}

/**
 * Which marks are NOT covered by any highlighted range.
 *
 * `spans` is what the highlighter under test produced, as [start, end)
 * offsets into the same source — whatever it calls them.
 *
 * @param {{ source: string, marks: string[] }} construct
 * @param {Array<{ start: number, end: number }>} spans
 */
export function unhighlighted(construct, spans) {
  return markRanges(construct)
    .filter(({ start, end }) => !spans.some((s) => s.start < end && s.end > start))
    .map((r) => r.mark);
}
