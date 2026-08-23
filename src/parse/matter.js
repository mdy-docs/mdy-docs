import {parse} from 'yaml'

/**
 * @typedef Settings
 * @property {string} fence
 *   Line that opens and closes the block.
 */

/**
 * Resolve the `frontmatter` option.
 *
 * On by default: `+++` means nothing else in MDY — it is not a list marker,
 * which needs whitespace after it, and not a thematic break, which takes only
 * `-`, `*` or `_` — so nothing that parses today changes meaning.
 *
 * @param {boolean | string | Partial<Settings> | undefined} frontmatter
 * @returns {Settings | undefined}
 */
export function normalizeFrontmatter(frontmatter) {
  if (frontmatter === false) return
  if (frontmatter === undefined || frontmatter === true) return {fence: '+++'}
  if (typeof frontmatter === 'string') return {fence: frontmatter}

  return {fence: frontmatter.fence ?? '+++'}
}

/**
 * Take the front matter off the top of a document.
 *
 * The block has to open on the document's first line, give or take blank ones,
 * and it has to close. An opening fence with no partner is left alone: it is
 * more likely to be prose than a block somebody forgot to finish, and guessing
 * would swallow the rest of the document.
 *
 * @param {Array<string>} lines
 * @param {Settings | undefined} settings
 * @param {import('vfile').VFile} [file]
 * @returns {{matter: unknown, lines: Array<string>}}
 */
export function extractMatter(lines, settings, file) {
  if (!settings) return {matter: undefined, lines}

  let open = 0

  while (open < lines.length && lines[open].trim() === '') open += 1

  if (lines[open]?.trimEnd() !== settings.fence) {
    return {matter: undefined, lines}
  }

  let close = open + 1

  while (close < lines.length && lines[close].trimEnd() !== settings.fence) {
    close += 1
  }

  if (close >= lines.length) return {matter: undefined, lines}

  const source = lines.slice(open + 1, close).join('\n')
  /** @type {unknown} */
  let matter = {}

  try {
    matter = parse(source) ?? {}
  } catch (error) {
    file?.message('Front matter failed to parse: ' + error.message, {
      place: {
        start: {line: open + 1, column: 1},
        end: {line: close + 1, column: settings.fence.length + 1}
      },
      ruleId: 'frontmatter',
      source: 'mdy'
    })
  }

  // The block is taken out either way: it was meant as data, and leaving it in
  // as prose would be a stranger outcome than losing it.
  return {matter, lines: lines.slice(close + 1)}
}
