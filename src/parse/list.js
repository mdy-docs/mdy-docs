/**
 * Lexical helpers for Markdown style lists.
 */

const itemLine = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])(?:([ \t]+)(.*))?$/
const taskBox = /^\[([ xX])\](?:[ \t]+(.*))?$/
const tabSize = 4

/**
 * @typedef Item
 * @property {number} indent
 *   Indent of the marker, in columns (tabs expand to the next multiple of 4).
 * @property {boolean} ordered
 *   Whether the marker was `1.` / `1)` rather than `-`, `*`, or `+`.
 * @property {number | undefined} start
 *   The number written, for ordered items.
 * @property {boolean | undefined} checked
 *   Whether the item opened with `[ ]` or `[x]`, and which.
 * @property {number} column
 *   Where the character between the brackets sits on the line, counting from
 *   one. Enough, with the line, to toggle it in the source.
 * @property {string} text
 *   Everything after the marker, and after the checkbox if there was one.
 */

/**
 * Read a list item marker off the front of a line.
 *
 * A marker has to be followed by whitespace, so `---` and `-5` are prose, not
 * items; a marker alone on its line is an empty item. A `[ ]` or `[x]` right
 * after the marker makes it a task.
 *
 * @param {string} line
 * @returns {Item | undefined}
 */
export function parseItemLine(line) {
  const match = itemLine.exec(line)

  if (!match) return

  const [, indent, bullet, number, space, text] = match
  const rest = (text ?? '').trim()
  const task = taskBox.exec(rest)

  return {
    indent: indentWidth(indent),
    ordered: !bullet,
    start: number === undefined ? undefined : Number(number),
    checked: task ? task[1] !== ' ' : undefined,
    // indent, then the marker, then the gap, then `[` — and the character
    // after that is the one that says whether the box is ticked.
    column:
      indent.length +
      (bullet ? 1 : number.length + 1) +
      (space?.length ?? 0) +
      2,
    text: task ? (task[2] ?? '').trim() : rest
  }
}

/**
 * Width of a run of indentation, expanding tabs to the next tab stop.
 *
 * @param {string} value
 * @returns {number}
 */
export function indentWidth(value) {
  let width = 0

  for (const character of value) {
    width += character === '\t' ? tabSize - (width % tabSize) : 1
  }

  return width
}
