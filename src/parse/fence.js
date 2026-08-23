const opener = /^(`{3,}|~{3,})[ \t]*(.*)$/

/**
 * @typedef Fence
 * @property {string} marker
 *   The run of backticks or tildes that opened it.
 * @property {string} info
 *   Everything written after the marker.
 * @property {string} language
 *   The first word of the info, which is what names the language.
 */

/**
 * Read a fence opener.
 *
 * Three or more backticks or tildes. Backticks may not appear in the info of a
 * backtick fence, so a line of prose holding a stray backtick cannot open one.
 *
 * @param {string} content
 * @returns {Fence | undefined}
 */
export function parseFence(content) {
  const match = opener.exec(content)

  if (!match) return

  const [, marker, info] = match

  if (marker.startsWith('`') && info.includes('`')) return

  return {marker, info: info.trim(), language: info.trim().split(/\s+/)[0] ?? ''}
}

/**
 * Whether a line closes a fence: the same character, at least as many of them,
 * and nothing else on the line.
 *
 * @param {string} content
 * @param {string} marker
 * @returns {boolean}
 */
export function closesFence(content, marker) {
  const trimmed = content.trimEnd()

  if (trimmed.length < marker.length) return false

  for (const character of trimmed) {
    if (character !== marker[0]) return false
  }

  return true
}

/**
 * Take `width` columns of indentation off a line, and no more.
 *
 * A fence's content keeps whatever indentation it has beyond the fence's own,
 * which is what lets a code block hold indented code.
 *
 * @param {string} line
 * @param {number} width
 * @param {number} tabSize
 * @returns {string}
 */
export function dedent(line, width, tabSize = 4) {
  let index = 0
  let column = 0

  while (index < line.length && column < width) {
    const character = line.charAt(index)

    if (character === ' ') column += 1
    else if (character === '\t') column += tabSize - (column % tabSize)
    else break

    index += 1
  }

  return line.slice(index)
}
