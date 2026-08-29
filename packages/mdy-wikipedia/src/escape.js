/**
 * Escaping — putting text back into a document without it becoming markup.
 *
 * This is the hard half of serialising. MDY's inline markers *toggle*
 * (language rule 8), so a stray `//` in a sentence does not produce a stray
 * `//` in the output: it opens an `<em>` that stays open to the end of the
 * block. Wikipedia's prose is full of them — `~~` in mathematics, `^^` in
 * notation, `//` in file paths, `__` in identifiers — and so is anything else
 * imported from the web.
 *
 * The rule is one line: a backslash escapes the character after it, so putting
 * one in front of the first character of a construct stops the construct
 * without changing the text. Everything below is about finding those
 * positions, and it works by *asking the parser*. `matchEmoji`, `findLinks`,
 * `parseWikiLink` and the rest are the same functions `parseInline` calls, so
 * the escaper cannot drift away from the grammar it is escaping: a marker
 * table passed to one is passed to the other, and a construct added to the
 * parser is a construct this file already knows about.
 *
 * There is one way an escape can make things worse, and it is worth naming
 * because it is not obvious: a backslash is itself a character the grammar can
 * read. Four emoticons end in one — `:\`, `:-\`, `=\`, `=-\` — so escaping the
 * `,,` in `:,,` writes `:\,,`, and the `:` that was innocent a moment ago now
 * opens a face. `repair` below walks that back. Everything else the grammar
 * matches is backslash-free, so that is the whole of the interaction.
 *
 * Belt and braces: the result is checked by parsing it, and anything that
 * still does not read back is escaped character by character instead — a form
 * nothing can match, since every position in it is a backslash. So the
 * function's contract holds by construction rather than by argument, and the
 * property test in test/escape.test.js measures how often the tidy path is
 * enough (on real prose: always).
 */

import {matchArrow, normalizeArrows} from 'mdy-docs/parse/arrows.js'
import {matchEmDash, normalizeEmDash} from 'mdy-docs/parse/dash.js'
import {matchEllipsis, normalizeEllipsis} from 'mdy-docs/parse/ellipsis.js'
import {matchEmoji, normalizeEmoji} from 'mdy-docs/parse/emoji.js'
import {findLinks} from 'mdy-docs/parse/link.js'
import {normalizeMarkers} from 'mdy-docs/parse/markers.js'
import {matchReference, normalizeReference} from 'mdy-docs/parse/reference.js'
import {parseWikiLink} from 'mdy-docs/parse/wiki.js'
import {parseInline} from 'mdy-docs/parse'
import {toText} from 'mdy-docs/parse/script.js'
import {emoticon} from 'emoticon'

// The emoticons a backslash can appear in, as [before, after] around it. An
// inserted escape sits between the two.
const backslashFaces = []

for (const entry of emoticon) {
  for (const value of entry.emoticons) {
    const at = value.indexOf('\\')

    if (at > 0) backslashFaces.push([value.slice(0, at), value.slice(at + 1)])
  }
}

// Line starts that mean something to the *block* grammar — block.js's own
// grammar comment, read top to bottom. Escaping the first character is enough
// for every one of them: `\= x` is a paragraph, `\- x` is a paragraph,
// `\| a | b` is a paragraph.
const blockStart = [
  /^-{3}[ \t]*$/, // document separator (rule 11)
  /^\+\+\+/, // front matter fence (rule 11)
  /^%/, // script (rule 12)
  /^#([ \t]|$)/, // a comment, taken out of the document entirely (rule 13)
  /^=/, // heading, and the `=` underline (rule 1)
  /^-{4,}[ \t]*$/, // the `----` underline (rule 1)
  /^[-*_](?:[ \t]*[-*_]){2,}[ \t]*$/, // thematic break (rule 2)
  /^[`~]{3,}/, // code fence (rule 4)
  /^</, // element opener, and the doctype line (rule 5)
  /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/, // list item (rule 6)
  /^\|/ // table row, and the caption above one (rule 7)
]

/**
 * Escape a run of text so that parsing it yields exactly that text.
 *
 * @param {string} value
 * @param {object} [options]
 *   The same options the document will be parsed with. Anything turned off in
 *   the parser is not escaped for here, so `{emoji: false}` leaves `:)` alone.
 * @returns {string}
 */
export function escapeInline(value, options = {}) {
  if (!value) return ''

  const need = mark(value, options)

  repair(value, need)

  const escaped = write(value, need)

  // The contract, checked. `parseInline` is the authority on what the output
  // means, so ask it rather than trusting the scan above.
  if (readsBack(escaped, value, options)) return escaped

  return escapeAll(value)
}

/**
 * Escape every character, which nothing can match: the parser's escape branch
 * takes the string two characters at a time and never looks at a position that
 * is not a backslash.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeAll(value) {
  return Array.from(value, (character) => '\\' + character).join('')
}

/**
 * Escape a line so the block grammar reads it as prose.
 *
 * Inline escaping first, then the line start. The order matters and only in
 * this direction: inline escaping can leave a line opening with a backslash,
 * which is harmless, but it can never leave one opening with a heading.
 *
 * @param {string} line
 *   One line of already inline-escaped text.
 * @returns {string}
 */
export function escapeLineStart(line) {
  const match = /^[ \t]*/.exec(line)
  const indent = match[0]
  const rest = line.slice(indent.length)

  if (!rest || !blockStart.some((pattern) => pattern.test(rest))) return line

  return indent + '\\' + rest
}

/**
 * Which positions start something the parser would read.
 *
 * Walks the string the way `parseInline` does, including its notion of
 * `atBoundary` — the thing that decides whether `:)` is a face or two
 * characters — so the two agree about where constructs begin.
 *
 * @param {string} value
 * @param {object} options
 * @returns {Array<boolean>}
 */
function mark(value, options) {
  const markers = normalizeMarkers(options.markers)
  const emoji = normalizeEmoji(options.emoji)
  const ellipsis = normalizeEllipsis(options.ellipsis)
  const arrows = normalizeArrows(options.arrows)
  const emDash = normalizeEmDash(options.emDash)
  const wiki = options.wikiLink !== false
  const references = {
    tag: normalizeReference(options.tags, '/tags/'),
    mention: normalizeReference(options.mentions, '/users/')
  }
  // Where the linkifier would take a URL from. Found once over the whole
  // string, exactly as the parser finds them, rather than probed per index.
  const links = options.autolink === false ? [] : findLinks(value)
  const starts = new Set(links.map((link) => link.index))
  const need = Array.from({length: value.length}, () => false)
  let atBoundary = true

  for (let index = 0; index < value.length; index++) {
    const character = value.charAt(index)

    // A backslash is doubled rather than prefixed, which comes to the same
    // thing: `write` puts one in front of every marked position.
    need[index] =
      character === '\\' ||
      starts.has(index) ||
      Boolean(wiki && character === '[' && parseWikiLink(value, index)) ||
      Boolean(
        (character === '#' || character === '@') &&
          matchReference(value, index, references)
      ) ||
      Boolean(matchEmoji(value, index, emoji, atBoundary)) ||
      Boolean(matchEllipsis(value, index, ellipsis)) ||
      Boolean(matchArrow(value, index, arrows)) ||
      Boolean(matchEmDash(value, index, emDash)) ||
      markers.some((marker) => value.startsWith(marker.sequence, index))

    // Only one character is escaped, not the whole construct: the rest is
    // re-examined on the next pass, which is what makes `///` come out as
    // `\/\//` rather than `\///`, where the second and third slash would have
    // opened an emphasis of their own.
    atBoundary = need[index] ? false : /\s/.test(character)
  }

  return need
}

/**
 * Walk back the faces an escape can create.
 *
 * A marked position puts a backslash into the output, and four emoticons are
 * spelled with one. Where that backslash would complete such a face, the
 * character the face starts at is marked too — which is another backslash, so
 * this repeats until nothing moves. It always terminates: each round only ever
 * marks, and there are finitely many positions.
 *
 * @param {string} value
 * @param {Array<boolean>} need
 */
function repair(value, need) {
  let changed = true

  while (changed) {
    changed = false

    for (let index = 0; index < value.length; index++) {
      if (!need[index]) continue

      for (const [before, after] of backslashFaces) {
        const start = index - before.length

        if (
          start >= 0 &&
          !need[start] &&
          value.startsWith(before, start) &&
          value.startsWith(after, index)
        ) {
          need[start] = true
          changed = true
        }
      }
    }
  }
}

/**
 * @param {string} value
 * @param {Array<boolean>} need
 * @returns {string}
 */
function write(value, need) {
  let result = ''

  for (let index = 0; index < value.length; index++) {
    if (need[index]) result += '\\'
    result += value.charAt(index)
  }

  return result
}

/**
 * @param {string} escaped
 * @param {string} value
 * @param {object} options
 * @returns {boolean}
 */
function readsBack(escaped, value, options) {
  const children = parseInline(escaped, {...options, collect: undefined})

  return (
    children.every((child) => child.type === 'text') &&
    toText({type: 'element', tagName: 'p', properties: {}, children}) === value
  )
}
