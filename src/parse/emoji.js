import {emoticon} from 'emoticon'
import {nameToEmoji} from 'gemoji'

const shortcode = /^:([a-z0-9_+-]+):/i

/** @type {Map<string, string>} */
const emoticons = new Map()
/** @type {Set<string>} */
const openers = new Set()
let longest = 0

for (const entry of emoticon) {
  for (const value of entry.emoticons) {
    emoticons.set(value, entry.emoji)
    openers.add(value.charAt(0))
    longest = Math.max(longest, value.length)
  }
}

/**
 * @typedef Settings
 * @property {boolean} emoticons
 *   Whether `:)` and its 300-odd friends are replaced.
 * @property {boolean} shortcodes
 *   Whether `:rocket:` and the rest of the GitHub names are replaced.
 */

/**
 * Resolve the `emoji` option.
 *
 * @param {boolean | Partial<Settings> | undefined} emoji
 * @returns {Settings}
 */
export function normalizeEmoji(emoji) {
  if (emoji === false) return {emoticons: false, shortcodes: false}
  if (emoji === undefined || emoji === true) {
    return {emoticons: true, shortcodes: true}
  }

  return {
    emoticons: emoji.emoticons !== false,
    shortcodes: emoji.shortcodes !== false
  }
}

/**
 * Match an emoji at `index`.
 *
 * Emoticons only count when they stand on their own. Without that, `:/` would
 * turn the middle of `http://example.com` into a face; `atBoundary` says
 * whether anything real precedes this position, and the character after the
 * match has to be something other than a letter or a number.
 *
 * @param {string} value
 * @param {number} index
 * @param {Settings} settings
 * @param {boolean} atBoundary
 *   Whether this position starts a word: the run began here, the previous
 *   character was whitespace, or a marker was just consumed.
 * @returns {{emoji: string, length: number} | undefined}
 */
export function matchEmoji(value, index, settings, atBoundary) {
  const character = value.charAt(index)

  if (settings.shortcodes && character === ':') {
    const match = shortcode.exec(value.slice(index))
    const found = match && nameToEmoji[match[1].toLowerCase()]

    // Only a name GitHub knows counts, which is what keeps `12:30:45` from
    // being read as a shortcode.
    if (found) return {emoji: found, length: match[0].length}
  }

  if (!settings.emoticons || !atBoundary || !openers.has(character)) return

  for (
    let size = Math.min(longest, value.length - index);
    size > 1;
    size--
  ) {
    const found = emoticons.get(value.slice(index, index + size))

    if (found && endsWord(value, index + size)) {
      return {emoji: found, length: size}
    }
  }
}

/**
 * @param {string} value
 * @param {number} index
 * @returns {boolean}
 */
function endsWord(value, index) {
  return index >= value.length || !/[\p{L}\p{N}]/u.test(value.charAt(index))
}
