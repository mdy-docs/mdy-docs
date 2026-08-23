/**
 * Three dots, written as the one character they stand for.
 */

const dots = '...'
const character = '…'

/**
 * Resolve the `ellipsis` option.
 *
 * On by default, the way the emoji are: it changes how a document looks rather
 * than what it says, and a document that means three dots can escape one of
 * them or turn this off.
 *
 * @param {boolean | string | undefined} ellipsis
 * @returns {string | undefined}
 *   What to write in their place, or nothing when they are to be left alone.
 */
export function normalizeEllipsis(ellipsis) {
  if (ellipsis === false) return
  if (ellipsis === undefined || ellipsis === true) return character

  return ellipsis
}

/**
 * Match an ellipsis at `index`.
 *
 * Exactly three dots, with no fourth on either side: `....` is left as it was
 * written, since nothing about a longer run says it was meant as one
 * character. The dot before is checked as well as the one after, so the second
 * dot of `....` cannot start a match the first one was refused.
 *
 * @param {string} value
 * @param {number} index
 * @param {string | undefined} replacement
 *   The resolved option: nothing when this is off.
 * @returns {{text: string, length: number} | undefined}
 */
export function matchEllipsis(value, index, replacement) {
  if (!replacement || !value.startsWith(dots, index)) return
  if (value.charAt(index - 1) === '.') return
  if (value.charAt(index + dots.length) === '.') return

  return {text: replacement, length: dots.length}
}
