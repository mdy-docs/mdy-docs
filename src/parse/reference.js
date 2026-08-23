// A name starts with a letter or an underscore and runs to a letter, digit or
// underscore, so a trailing hyphen or full stop belongs to the sentence rather
// than the name.
//
// The first character is deliberately not a digit: `#42` and `#57` are how
// people write issue and invoice numbers, and every one of them turning into
// a link to a tag page that does not exist is worse than the handful of
// numeric tags it costs. `@42` is nobody, for the same reason.
const name = '[\\p{L}_](?:[\\p{L}\\p{N}_-]*[\\p{L}\\p{N}_])?'
const patterns = {
  tag: new RegExp('^#(' + name + ')', 'u'),
  mention: new RegExp('^@(' + name + ')', 'u')
}
const word = /[\p{L}\p{N}_]/u
// Which list on the data each kind of reference is written down in. A link
// is one of these too: not every reference wears a sigil.
const lists = {tag: 'tags', mention: 'users', link: 'links'}

/**
 * @typedef Setting
 * @property {string} href
 *   Put in front of the name to make the link.
 * @property {(name: string) => string} [resolve]
 *   Builds the whole URL instead, when a prefix is not enough.
 *
 * @typedef {Record<'tag' | 'mention', Setting | undefined>} Settings
 */

/**
 * Resolve one of the `tags` / `mentions` options.
 *
 * A string is the common case and means the prefix.
 *
 * @param {boolean | string | Partial<Setting> | undefined} option
 * @param {string} fallback
 * @returns {Setting | undefined}
 */
export function normalizeReference(option, fallback) {
  if (option === false) return
  if (option === undefined || option === true) return {href: fallback}
  if (typeof option === 'string') return {href: option}

  return {href: option.href ?? fallback, resolve: option.resolve}
}

/**
 * Give a document somewhere to write down what it refers to, and hand back
 * the way to write it.
 *
 * `tags`, `users` and `links` are put on the data as empty arrays when the
 * front matter did not name them, so a document may always be asked what it
 * refers to and always answers with a list. A value the author wrote is theirs:
 * an existing array is added to rather than replaced, and anything that is not
 * an array is left exactly as it was found.
 *
 * Names go in as they are written, in the order the document reaches them, and
 * only once each.
 *
 * @param {Record<string, unknown>} data
 * @returns {(kind: keyof lists, name: string) => void}
 */
export function collectReferences(data) {
  for (const list of Object.values(lists)) {
    if (data[list] === undefined) data[list] = []
  }

  return (kind, name) => {
    const list = data[lists[kind]]

    if (Array.isArray(list) && !list.includes(name)) list.push(name)
  }
}

/**
 * Match `#tag` or `@user` at `index`.
 *
 * Both only count at the start of a word, which is what keeps the `#` of a URL
 * fragment and the `@` of an email address out of it — though in practice a
 * link has already been taken whole by the time this runs.
 *
 * @param {string} value
 * @param {number} index
 * @param {Settings} settings
 * @returns {{kind: 'tag' | 'mention', name: string, href: string, length: number} | undefined}
 */
export function matchReference(value, index, settings) {
  const kind = value.charAt(index) === '#' ? 'tag' : 'mention'
  const setting = settings[kind]

  if (!setting) return
  if (value.charAt(index) !== '#' && value.charAt(index) !== '@') return

  // Something wordlike before it means this is the middle of something else.
  if (index > 0 && word.test(value.charAt(index - 1))) return

  const match = patterns[kind].exec(value.slice(index))

  if (!match) return

  return {
    kind,
    name: match[1],
    href: setting.resolve
      ? setting.resolve(match[1])
      : setting.href + encodeURIComponent(match[1]),
    length: match[0].length
  }
}
