// Exactly three dashes, as YAML has it. More than three stays a thematic break
// or a Setext underline, which is the way out of the collision: `----`, `***`,
// `___` and `- - -` all still mean what they meant.
const separator = /^---[ \t]*$/

/**
 * @typedef Settings
 * @property {string | false} wrapper
 *   Element each document is put in, or `false` to run them together.
 */

/**
 * Resolve the `documents` option.
 *
 * Off unless asked for: `---` already means two other things, and quietly
 * taking it away from them would rewrite documents that parse fine today.
 *
 * @param {boolean | string | Partial<Settings> | undefined} documents
 * @returns {Settings | undefined}
 */
export function normalizeDocuments(documents) {
  if (!documents) return
  if (documents === true) return {wrapper: 'article'}
  if (typeof documents === 'string') return {wrapper: documents}

  return {wrapper: documents.wrapper ?? 'article'}
}

/**
 * Split a source into the documents it holds.
 *
 * A line of exactly `---` starts the next one. A leading separator opens the
 * first document rather than making an empty one before it, and documents
 * holding nothing but whitespace are dropped, so a stream can be spaced out
 * however reads best.
 *
 * @param {string} value
 * @returns {Array<string>}
 */
export function splitDocuments(value) {
  return splitWithLines(value).map((document) => document.value)
}

/**
 * The same split, keeping the line each document starts on.
 *
 * Positions are worth more when they point at the file somebody can open, so
 * every document knows how far down it begins.
 *
 * @param {string} value
 * @returns {Array<{value: string, line: number}>}
 */
export function splitWithLines(value) {
  /** @type {Array<{lines: Array<string>, line: number}>} */
  const documents = [{lines: [], line: 0}]
  let line = 0

  for (const source of String(value).split(/\r\n|\r|\n/)) {
    if (separator.test(source)) documents.push({lines: [], line: line + 1})
    else documents.at(-1).lines.push(source)

    line += 1
  }

  return documents
    .map((document) => ({
      value: document.lines.join('\n'),
      line: document.line
    }))
    .filter((document) => document.value.trim() !== '')
}
