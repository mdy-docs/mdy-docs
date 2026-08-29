/**
 * Getting a page out of Wikipedia.
 *
 * Parsoid HTML (`/api/rest_v1/page/html/{title}`), not the Action API's
 * `action=parse` and emphatically not wikitext. Parsoid marks up what the
 * other two leave implicit — `<section data-mw-section-id>` around each
 * section, `rel="mw:WikiLink"` on internal links, `typeof="mw:Transclusion"`
 * on template output — and the cleaner needs all three. Wikitext loses worse
 * still: Babylon's infobox says its area is `{{cvt|9|km2|sp=us}}` and its
 * founding is `{{circa|2200 BC}}`, so reading it means implementing
 * MediaWiki's template expander. Parsoid has already run it, and hands over
 * `9 km2 (3.5 sq mi)` and `c. 2200 BC`.
 *
 * The summary endpoint comes along for the ride. It is small, and it holds
 * four things that are a nuisance to dig out of the HTML: the Wikidata id, the
 * revision, the short description, and coordinates as numbers.
 *
 * Wikimedia's API etiquette is not optional and is cheap to honour: a
 * `User-Agent` naming the tool with somewhere to complain to, one request at a
 * time, and a cache on disk so that iterating on the converter costs nothing
 * after the first fetch.
 */

import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'

const project = 'https://github.com/mdy-docs/mdy-docs'
const version = '0.1.0'
const wikiUrl = /^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/(.+)$/i
const langPrefix = /^([a-z]{2,3}(?:-[a-z]+)?):(.+)$/i

/**
 * @typedef Target
 * @property {string} lang
 * @property {string} title
 *   The page title with spaces, as a reader would write it.
 */

/**
 * Work out which page is meant.
 *
 * A full URL, a `fr:Babylone` prefix, or a bare title with `--lang` deciding
 * the wiki.
 *
 * @param {string} input
 * @param {{lang?: string}} [options]
 * @returns {Target}
 */
export function resolveTarget(input, options = {}) {
  const value = String(input ?? '').trim()

  if (!value) throw new Error('Expected a page title or URL')

  const url = wikiUrl.exec(value)

  if (url) {
    return {
      lang: url[1].toLowerCase(),
      // A URL carries the title percent-encoded and with underscores for
      // spaces; both are spelling, not the name.
      title: decodeURIComponent(url[2].split('#')[0].split('?')[0]).replaceAll('_', ' ')
    }
  }

  const prefixed = langPrefix.exec(value)

  // Only a prefix that is not itself part of a title: `fr:Babylone` is a wiki,
  // `Talk:Babylon` is a namespace on this one.
  if (prefixed && !namespaces.has(prefixed[1].toLowerCase())) {
    return {lang: prefixed[1].toLowerCase(), title: prefixed[2].trim().replaceAll('_', ' ')}
  }

  return {lang: (options.lang ?? 'en').toLowerCase(), title: value.replaceAll('_', ' ')}
}

// The namespace prefixes on the English wiki that would otherwise read as a
// language code. Not exhaustive on purpose: it only has to cover the ones
// short enough to collide.
const namespaces = new Set([
  'talk', 'user', 'file', 'help', 'draft', 'special', 'media', 'category',
  'template', 'portal', 'module', 'wp', 'mos', 'h', 't', 'cat'
])

/**
 * Fetch a page's Parsoid HTML and its summary.
 *
 * @param {Target} target
 * @param {object} [options]
 *   `cache` (directory, or `false` for none), `refresh` (fetch even when
 *   cached), `contact` (added to the User-Agent), `fetch` (an implementation,
 *   so tests never touch the network).
 * @returns {Promise<{html: string, summary: object | undefined}>}
 */
export async function fetchPage(target, options = {}) {
  const html = await get(target, 'html', options)
  const summary = await get(target, 'summary', options)

  return {
    html,
    summary: summary === undefined ? undefined : parseSummary(summary, options)
  }
}

/**
 * @param {string} value
 * @param {object} options
 * @returns {object | undefined}
 */
function parseSummary(value, options) {
  try {
    return JSON.parse(value)
  } catch {
    options.file?.message('The page summary did not parse as JSON, ignoring it', {
      ruleId: 'summary',
      source: 'mdy-wikipedia'
    })
  }
}

/**
 * One resource, from the cache when it is there and from Wikipedia when it is
 * not. A summary that will not fetch is not fatal — it is extra, and the HTML
 * is the page — but HTML that will not fetch is.
 *
 * @param {Target} target
 * @param {'html' | 'summary'} kind
 * @param {object} options
 * @returns {Promise<string | undefined>}
 */
async function get(target, kind, options) {
  const path = options.cache === false ? undefined : cachePath(target, kind, options)

  if (path && !options.refresh) {
    const cached = await readFile(path, 'utf8').catch(() => undefined)

    if (cached !== undefined) return cached
  }

  const request = options.fetch ?? globalThis.fetch
  const url = endpoint(target, kind)
  const response = await request(url, {
    headers: {'user-agent': userAgent(options), accept: accepts[kind]}
  })

  if (!response.ok) {
    if (kind === 'summary') return

    throw new Error(
      'Could not fetch ' + url + ': ' + response.status + ' ' + response.statusText
    )
  }

  const value = await response.text()

  if (path) {
    await mkdir(dirname(path), {recursive: true})
    await writeFile(path, value)
  }

  return value
}

const accepts = {
  // Pinning the profile is what keeps a future Parsoid version from changing
  // the shape of the tree under the cleaner without warning.
  html: 'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/2.8.0"',
  summary: 'application/json'
}

/**
 * @param {Target} target
 * @param {'html' | 'summary'} kind
 * @returns {string}
 */
function endpoint(target, kind) {
  return (
    'https://' +
    target.lang +
    '.wikipedia.org/api/rest_v1/page/' +
    kind +
    '/' +
    encodeURIComponent(target.title.replaceAll(' ', '_'))
  )
}

/**
 * Where a resource is kept. `--cache` names the directory; the default is the
 * one every other tool on the machine uses.
 *
 * @param {Target} target
 * @param {'html' | 'summary'} kind
 * @param {object} options
 * @returns {string}
 */
function cachePath(target, kind, options) {
  const base =
    options.cache ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'mdy-wikipedia')

  return join(
    base,
    target.lang,
    encodeURIComponent(target.title) + (kind === 'html' ? '.html' : '.summary.json')
  )
}

/**
 * Who is asking. Wikimedia asks for a name and somewhere to complain to, and a
 * tool that does not say gets rate limited on principle.
 *
 * @param {object} options
 * @returns {string}
 */
export function userAgent(options = {}) {
  const contact = options.contact ? '; ' + options.contact : ''

  return 'mdy-wikipedia/' + version + ' (' + project + contact + ')'
}
