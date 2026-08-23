import {LinkifyIt} from 'linkify-it'

const linkify = new LinkifyIt()

/**
 * @typedef Link
 * @property {number} index
 *   Where the URL starts in the run.
 * @property {number} end
 *   Where it stops.
 * @property {string} text
 *   The URL as it was written, which is what the link says.
 * @property {string} url
 *   Where it points, which is the same thing except for bare email addresses,
 *   where `mailto:` is added.
 */

/**
 * Find the URLs in a run of text.
 *
 * `linkify-it` does the hard parts: knowing that the full stop at the end of
 * "see https://example.com." is punctuation rather than URL, and that the
 * closing bracket in "(https://example.com/a_(b))" is not.
 *
 * Only URLs that name their scheme are matched, plus protocol-relative `//`
 * ones and bare email addresses. Bare domains are deliberately left alone: a
 * two-letter country code is a valid suffix, so matching them would turn
 * `README.md` and `node.js` into links.
 *
 * @param {string} value
 * @returns {Array<Link>}
 */
export function findLinks(value) {
  const matches = linkify.match(value)

  if (!matches) return []

  return matches.map((match) => ({
    index: match.index,
    end: match.lastIndex,
    text: match.text,
    url: match.url
  }))
}

// A scheme, or the `//host` of a protocol-relative URL: either way the link
// leaves the site.
const scheme = /^[a-z][a-z0-9+.-]*:/i

/**
 * Where a link points.
 *
 * Three answers, and only the third is a page of your own: `internet` names a
 * scheme or a `//host` and is somebody else's, `fragment` opens with `#` and
 * is somewhere on this page, and `page` is everything left — a path, a name, a
 * relative step upward.
 *
 * @param {string} href
 * @returns {'internet' | 'fragment' | 'page'}
 */
export function linkKind(href) {
  if (href.startsWith('#')) return 'fragment'
  if (href.startsWith('//') || scheme.test(href)) return 'internet'

  return 'page'
}

/**
 * Tidy a link to a page of your own.
 *
 * Lower case, and spaces written as the dashes a path would have. A page is a
 * file somewhere in the end, and `Getting Started` and `getting-started` should
 * not be two of them.
 *
 * Only ever handed a `page` link: a URL belongs to whoever it points at, case
 * and all, and a fragment belongs to the id it names.
 *
 * @param {string} href
 * @returns {string}
 */
export function normalizeLink(href) {
  return href.toLowerCase().replace(/\s+/g, '-')
}
