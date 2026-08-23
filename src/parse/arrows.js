/**
 * Arrows drawn with dashes and angles, written as the characters they draw.
 */

/**
 * The sequences replaced by default.
 *
 * Three characters at least, never `->` or `=>`: those turn `x <= 5` into a
 * double arrow and every JavaScript lambda into `() ⇒ {}`, which is why the
 * two-character forms are left to mean what they say. Pass `arrows` to use a
 * table of your own, spreading this one to add to it rather than replace it.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const defaultArrows = Object.freeze({
  '-->': '→',
  '<--': '←',
  '<-->': '↔',
  '==>': '⇒',
  '<==': '⇐',
  '<==>': '⇔'
})

/**
 * @typedef Arrow
 * @property {string} sequence
 *   Literal characters that draw it.
 * @property {string} character
 *   What is written in their place.
 *
 * @typedef Table
 * @property {Array<Arrow>} arrows
 *   Every arrow, longest sequence first.
 * @property {Set<string>} letters
 *   Every character the table draws with. An arrow standing against one of
 *   them is part of a longer run, so `--->` and `<===` are left as the rules
 *   they may well be.
 */

/**
 * Resolve the `arrows` option.
 *
 * @param {boolean | Record<string, string> | undefined} arrows
 * @returns {Table | undefined}
 *   The table, longest sequence first so `<-->` wins over `<--`, or nothing
 *   when this is off.
 */
export function normalizeArrows(arrows) {
  if (arrows === false) return
  const table = arrows === undefined || arrows === true ? defaultArrows : arrows
  /** @type {Array<Arrow>} */
  const list = []

  for (const [sequence, character] of Object.entries(table)) {
    if (typeof character !== 'string' || !character) {
      throw new TypeError(
        'Expected arrow `' + sequence + '` to have a replacement'
      )
    }

    list.push({sequence, character})
  }

  if (!list.length) return

  return {
    arrows: list.sort((a, b) => b.sequence.length - a.sequence.length),
    letters: new Set(list.flatMap((arrow) => [...arrow.sequence]))
  }
}

/**
 * Match an arrow at `index`.
 *
 * The characters on both sides are checked against the table's own alphabet:
 * an arrow may not sit against another character it is drawn with, so nothing
 * inside `<--->` is an arrow and the longest match is the one that counts.
 *
 * @param {string} value
 * @param {number} index
 * @param {Table | undefined} table
 * @returns {{text: string, length: number} | undefined}
 */
export function matchArrow(value, index, table) {
  if (!table || !table.letters.has(value.charAt(index))) return
  if (table.letters.has(value.charAt(index - 1))) return

  for (const arrow of table.arrows) {
    if (!value.startsWith(arrow.sequence, index)) continue

    // The longest match wins, so a shorter one that fits here is a piece of
    // this same run: if this one is hemmed in, they all are.
    return table.letters.has(value.charAt(index + arrow.sequence.length))
      ? undefined
      : {text: arrow.character, length: arrow.sequence.length}
  }
}
