/**
 * Lexical helpers for GitHub flavoured tables.
 *
 * These only look at one line at a time; assembling them into a table block is
 * `block.js`'s job.
 */

const delimiterCell = /^(:?)-+(:?)$/

/**
 * @typedef Row
 * @property {Array<string>} cells
 *   Trimmed cell sources, still carrying their `\|` escapes.
 * @property {boolean} delimited
 *   Whether the line contained an unescaped `|` at all.
 */

/**
 * Split one line into table cells on unescaped pipes.
 *
 * A leading pipe and a trailing pipe are optional framing and do not create
 * empty cells; pipes inside the line do.
 *
 * @param {string} line
 * @returns {Row}
 */
export function splitRow(line) {
  const value = line.trim()
  /** @type {Array<string>} */
  const cells = []
  let cell = ''
  let index = 0
  let delimited = false
  let openEnded = false

  while (index < value.length) {
    const character = value.charAt(index)

    // Keep the escape in place: the inline parser deals with every escape
    // except `\|`, which is ours because it has to survive splitting.
    if (character === '\\' && index + 1 < value.length) {
      cell += character + value.charAt(index + 1)
      index += 2
      openEnded = false
      continue
    }

    if (character === '|') {
      cells.push(cell)
      cell = ''
      delimited = true
      openEnded = true
      index += 1
      continue
    }

    cell += character
    openEnded = false
    index += 1
  }

  if (!openEnded || !cells.length) cells.push(cell)
  if (value.startsWith('|')) cells.shift()

  return {cells: cells.map((cell) => cell.trim()), delimited}
}

/**
 * Read a delimiter row (`| --- | :-: |`) and its column alignments.
 *
 * @param {string} line
 * @returns {Array<'left' | 'center' | 'right' | undefined> | undefined}
 *   Alignments, or nothing when the line is not a delimiter row.
 */
export function parseDelimiterRow(line) {
  const {cells, delimited} = splitRow(line)

  // A bare `---` is not a table: without a pipe somewhere there is nothing to
  // say this line is tabular at all.
  if (!delimited || !cells.length) return

  /** @type {Array<'left' | 'center' | 'right' | undefined>} */
  const alignments = []

  for (const cell of cells) {
    const match = delimiterCell.exec(cell)

    if (!match) return

    const [, start, end] = match

    alignments.push(
      start && end ? 'center' : start ? 'left' : end ? 'right' : undefined
    )
  }

  return alignments
}

/**
 * Resolve `\|` now that splitting is done. Every other escape is left for the
 * inline parser.
 *
 * @param {string} value
 * @returns {string}
 */
export function unescapePipes(value) {
  return value.replace(/\\\|/g, '|')
}
