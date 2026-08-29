/**
 * A Wikipedia page as an mdy document.
 *
 * Five stages, each a pure function of the last, which is why `buildDocument`
 * is exported beside `wikipediaToMdy`: everything after the fetch runs on a
 * saved page, so the tests never touch the network and neither does anybody
 * iterating on the cleaner.
 *
 *   fetch → parse → extract → clean → serialise
 *
 * Phase 1 of docs/wikipedia-plan.md builds all of it except extraction: the
 * front matter holds the page's identity and its licence, and the body is the
 * article. Phase 2 fills in the infobox and the rest.
 */

import {fromHtml} from 'hast-util-from-html'
import {clean} from './clean.js'
import {fetchPage, resolveTarget} from './fetch.js'
import {toMdy} from './to-mdy.js'

export {toMdy} from './to-mdy.js'
export {escapeInline} from './escape.js'
export {clean} from './clean.js'
export {fetchPage, resolveTarget} from './fetch.js'

/**
 * Fetch a page and write it as an mdy document.
 *
 * @param {string} input
 *   A title, a `fr:Babylone` prefix, or a Wikipedia URL.
 * @param {object} [options]
 *   `lang`, `links`, `sections`, `keepSections`, `wrap`, `cache`, `refresh`,
 *   `contact`, `file`, and `fetch` for an implementation of your own.
 * @returns {Promise<{source: string, data: object, counts: object}>}
 */
export async function wikipediaToMdy(input, options = {}) {
  const target = resolveTarget(input, options)
  const page = await fetchPage(target, options)

  return buildDocument({...page, target}, options)
}

/**
 * Everything after the fetch.
 *
 * @param {{html: string, summary?: object, target: {lang: string, title: string}}} page
 * @param {object} [options]
 * @returns {{source: string, data: object, counts: object}}
 */
export function buildDocument(page, options = {}) {
  const {target, summary} = page
  const {tree, counts} = clean(fromHtml(page.html), {
    ...options,
    lang: target.lang,
    title: target.title
  })

  const data = frontMatter(page, options)

  // The title as a heading as well as a field. A document that renders on its
  // own says what it is about; a layout that would rather write the title
  // itself can drop this one line.
  if (options.title !== false) {
    tree.children.unshift({
      type: 'element',
      tagName: 'h1',
      properties: {},
      children: [{type: 'text', value: data.title}]
    })
  }

  tree.data = {matter: data}

  return {
    source: toMdy(tree, {
      ...options,
      // The ids in this tree are Wikipedia's — `id="Names"`, from its own
      // slugifier — and the document is about to be given mdy's. Saying the
      // parser was not assigning them is what lets a heading be written as a
      // heading rather than as an element pinned to a foreign anchor.
      headingId: false,
      wrap: options.wrap ?? 78
    }),
    data,
    counts
  }
}

/**
 * What the document says about where it came from.
 *
 * `source` is written whatever the options say, because it is not decoration:
 * Wikipedia's text is CC BY-SA 4.0, and a document that might be published has
 * to carry the attribution with it. Pinning the revision is what makes the
 * citation checkable and re-fetching reproducible.
 *
 * @param {{target: {lang: string, title: string}, summary?: object}} page
 * @param {object} options
 * @returns {object}
 */
function frontMatter(page, options) {
  const {target, summary} = page
  const title = summary?.titles?.normalized ?? target.title
  const url =
    summary?.content_urls?.desktop?.page ??
    'https://' + target.lang + '.wikipedia.org/wiki/' +
      encodeURIComponent(target.title.replaceAll(' ', '_'))
  const revision = summary?.revision
  const retrieved = (options.now ?? new Date()).toISOString().slice(0, 10)

  /** @type {Record<string, unknown>} */
  const source = {
    site: 'Wikipedia',
    lang: target.lang,
    title,
    url,
    'page-id': summary?.pageid,
    revision,
    modified: summary?.timestamp,
    retrieved,
    license: 'CC BY-SA 4.0',
    'license-url': 'https://creativecommons.org/licenses/by-sa/4.0/',
    attribution:
      'This document contains text from the Wikipedia article "' + title + '"' +
      (revision ? ' (revision ' + revision + ')' : '') +
      ', by Wikipedia contributors, used under CC BY-SA 4.0.'
  }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) delete source[key]
  }

  /** @type {Record<string, unknown>} */
  const data = {title}

  if (summary?.description) data.description = summary.description

  data.source = source

  return data
}
