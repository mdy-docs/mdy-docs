import {defaultResolve} from './wiki.js'

/**
 * @typedef Settings
 * @property {(text: string) => string} slug
 *   Turns a heading's text into an id.
 *
 * @typedef State
 * @property {(text: string) => string | undefined} id
 *   The id for a heading reading `text`, or nothing when it has no text to
 *   make one from.
 */

/**
 * Resolve the `headingId` option.
 *
 * On unless turned off. An `id` costs a document nothing and is what makes
 * `[[ jump | #some-heading ]]` land, which otherwise takes a transform of your
 * own to arrange.
 *
 * The slugifier is `[[ label ]]`'s, so a heading and a link written from the
 * same words agree without either of them being told about the other.
 *
 * @param {boolean | Partial<Settings> | undefined} headingId
 * @returns {Settings | undefined}
 */
export function normalizeHeadingId(headingId) {
  if (headingId === false) return
  if (headingId === undefined || headingId === true) {
    return {slug: defaultResolve}
  }

  return {slug: headingId.slug ?? defaultResolve}
}

/**
 * Start handing out ids.
 *
 * Two headings reading the same thing are two places, so the second one and
 * every one after it is numbered: `notes`, `notes-1`, `notes-2`. The state is
 * per document, or per stream when there is one, so the ids on a page are
 * unique across the whole of it.
 *
 * @param {Settings} settings
 * @returns {State}
 */
export function createHeadingIds(settings) {
  /** @type {Set<string>} */
  const used = new Set()

  return {id}

  /**
   * @param {string} text
   * @returns {string | undefined}
   */
  function id(text) {
    const base = settings.slug(text)

    // A heading of nothing but punctuation slugs to nothing, and an empty id
    // is worse than none: it cannot be linked to and it is not valid.
    if (!base) return

    let candidate = base
    let count = 0

    while (used.has(candidate)) {
      count += 1
      candidate = base + '-' + count
    }

    used.add(candidate)

    return candidate
  }
}
