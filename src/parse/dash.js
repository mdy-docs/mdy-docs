/**
 * Two dashes, written as the one character they stand for.
 */

const dashes = '--'
const character = '—'

/**
 * Resolve the `emDash` option.
 *
 * On by default, the way the ellipsis is: it changes how a document looks
 * rather than what it says, and a document that means two dashes can escape one
 * of them or turn this off.
 *
 * @param {boolean | string | undefined} emDash
 * @returns {string | undefined}
 *   What to write in their place, or nothing when they are to be left alone.
 */
export function normalizeEmDash(emDash) {
  if (emDash === false) return
  if (emDash === undefined || emDash === true) return character

  return emDash
}

/**
 * Match an em dash at `index`.
 *
 * Exactly two dashes, with no third on either side, which is what keeps this
 * rule clear of the three others a run of dashes can mean: `---` is a document
 * separator and `----` a heading or a break (rules 1, 2 and 11). Those are
 * settled a line at a time, before any of this runs, and a run that reaches
 * here as text is left as the run it was written as.
 *
 * The dash before is checked as well as the one after, so the second dash of
 * `---` cannot start a match the first one was refused.
 *
 * Arrows are matched first, so `-->` keeps its head.
 *
 * @param {string} value
 * @param {number} index
 * @param {string | undefined} replacement
 *   The resolved option: nothing when this is off.
 * @returns {{text: string, length: number} | undefined}
 */
export function matchEmDash(value, index, replacement) {
  if (!replacement || !value.startsWith(dashes, index)) return
  if (value.charAt(index - 1) === '-') return
  if (value.charAt(index + dashes.length) === '-') return

  return {text: replacement, length: dashes.length}
}
