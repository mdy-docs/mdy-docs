const opener = '[['
const closer = ']]'

/**
 * @typedef Found
 * @property {string} label
 *   What the link says.
 * @property {string | undefined} url
 *   Where it points, when the link said so; otherwise the label decides.
 * @property {number} length
 *   Characters consumed, brackets included.
 *
 * @typedef Settings
 * @property {(label: string) => string} resolve
 *   Turns a label into a URL, for links that give only a label.
 */

/**
 * Turn a label into a URL.
 *
 * Wiki convention: lower case, spaces become hyphens, and punctuation that has
 * no business in a path is dropped. Path separators, dots, underscores and
 * fragments are kept, so `[[ docs/intro ]]` and `[[ Setup#Install ]]` land
 * somewhere sensible.
 *
 * @param {string} label
 * @returns {string}
 */
export function defaultResolve(label) {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-/._#]+/gu, '')
}

/**
 * Resolve the `wikiLink` option.
 *
 * @param {boolean | Partial<Settings> | undefined} wikiLink
 * @returns {Settings | undefined}
 */
export function normalizeWikiLink(wikiLink) {
  if (wikiLink === false) return
  if (wikiLink === undefined || wikiLink === true) {
    return {resolve: defaultResolve}
  }

  return {resolve: wikiLink.resolve ?? defaultResolve}
}

/**
 * Read a `[[ label ]]` or `[[ label | url ]]` link at `index`.
 *
 * The label runs to the first `]]`, and splits on the first unescaped `|`, so
 * `\|` puts a pipe in a label the way it puts one in a table cell.
 *
 * @param {string} value
 * @param {number} index
 * @returns {Found | undefined}
 */
export function parseWikiLink(value, index) {
  if (!value.startsWith(opener, index)) return

  const start = index + opener.length
  const stop = value.indexOf(closer, start)

  if (stop === -1) return

  const inside = value.slice(start, stop)
  const split = findPipe(inside)
  const label = (split === -1 ? inside : inside.slice(0, split)).trim()

  // `[[ ]]` says nothing and links nowhere: leave it as the text it is.
  if (!label) return

  return {
    label,
    url: split === -1 ? undefined : inside.slice(split + 1).trim(),
    length: stop + closer.length - index
  }
}

/**
 * Index of the first unescaped `|`.
 *
 * @param {string} value
 * @returns {number}
 */
function findPipe(value) {
  let index = 0

  while (index < value.length) {
    const character = value.charAt(index)

    if (character === '\\') {
      index += 2
      continue
    }

    if (character === '|') return index

    index += 1
  }

  return -1
}
