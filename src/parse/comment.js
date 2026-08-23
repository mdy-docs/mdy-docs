import {closesFence, parseFence} from './fence.js'
import {indentWidth} from './list.js'

const leading = /^[ \t]*/
// A `#` with nothing against it: a space, or the end of the line. What follows
// the `#` is the whole of what says a comment was meant, because a word against
// it makes a tag instead — which also makes a Markdown heading, `# Title`, a
// comment here. MDY writes headings with `=`.
const comment = /^[ \t]*#([ \t]|$)/

/**
 * Whether a line is a comment rather than content.
 *
 * Leading space is allowed and carries no meaning: a comment is taken out of
 * the document before any column is counted, so how far in the author writes it
 * is their own business and none of the markup's.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isCommentLine(line) {
  return comment.test(line)
}

/**
 * Take a document's comments out.
 *
 * A comment is a whole line and leaves nothing behind, so the markup around it
 * closes over the gap: the lines either side of one are as adjacent as they
 * were, and the indentation the block parser reads is the content's alone.
 *
 * A fenced block is the one place they are content. `# ` opens a comment in
 * half the languages a block might hold, and a code sample that quietly lost
 * its comments would be worse than useless, so the fences are found first and
 * whatever they hold is left exactly as it is.
 *
 * @param {Array<string>} lines
 * @param {Array<number> | undefined} map
 *   Where each line came from, when code has already moved them about.
 * @returns {{lines: Array<string>, map: Array<number> | undefined}}
 */
export function stripComments(lines, map) {
  // Documents without a comment in them are left exactly as they are.
  if (!lines.some(isCommentLine)) return {lines, map}

  /** @type {Array<string>} */
  const result = []
  /** @type {Array<number>} */
  const next = []
  /** @type {{marker: string, indent: number} | undefined} */
  let fence

  for (const [index, line] of lines.entries()) {
    const space = leading.exec(line)[0]
    const content = line.slice(space.length)

    if (fence) {
      if (closesFence(content, fence.marker)) {
        // The closer belongs to the block and cannot open another.
        fence = undefined
        keep(index, line)
        continue
      }

      // An unclosed fence runs to the end of whatever encloses it, which is
      // wherever the indentation comes back out.
      if (content && indentWidth(space) < fence.indent) fence = undefined
      else {
        keep(index, line)
        continue
      }
    }

    const opener = parseFence(content)

    if (opener) fence = {marker: opener.marker, indent: indentWidth(space)}
    else if (isCommentLine(line)) continue

    keep(index, line)
  }

  return {lines: result, map: next}

  /**
   * @param {number} index
   * @param {string} line
   */
  function keep(index, line) {
    result.push(line)
    next.push(map?.[index] ?? index)
  }
}
