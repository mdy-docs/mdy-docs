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
import {defaultResolve} from 'mdy-docs/parse/wiki.js'
import {clean} from './clean.js'
import {
  extractImages,
  extractInfobox,
  extractReferences,
  outline
} from './extract.js'
import {fetchIndexes, fetchPage, fetchWikidata, resolveTarget} from './fetch.js'
import {toMdy} from './to-mdy.js'
import {wikidataRecord} from './wikidata.js'

export {toMdy} from './to-mdy.js'
export {escapeInline} from './escape.js'
export {clean} from './clean.js'
export {fetchPage, fetchIndexes, fetchWikidata, resolveTarget} from './fetch.js'
export {wikidataRecord} from './wikidata.js'
export {extractInfobox, extractImages, extractReferences, outline} from './extract.js'

/**
 * Fetch a page and write it as an mdy document.
 *
 * @param {string} input
 *   A title, a `fr:Babylone` prefix, or a Wikipedia URL.
 * @param {object} [options]
 *   `lang`, `links`, `sections`, `keepSections`, `refs`, `wikidata`,
 *   `categories`, `langLinks`, `wrap`, `cache`, `refresh`, `contact`, `file`,
 *   and `fetch` for an implementation of your own.
 * @returns {Promise<{source: string, data: object, counts: object}>}
 */
export async function wikipediaToMdy(input, options = {}) {
  const target = resolveTarget(input, options)
  const page = await fetchPage(target, options)

  // The optional records, each its own round trip and each behind its own
  // flag. They are asked for here rather than in `buildDocument` so that
  // everything after the network stays a pure function of what came back.
  const indexes = await fetchIndexes(target, options, options)
  const wikidata = options.wikidata
    ? await fetchWikidata(page.summary?.wikibase_item, target, options)
    : undefined

  return buildDocument({...page, ...indexes, wikidata, target}, options)
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
  const raw = fromHtml(page.html)
  const settings = {...options, lang: target.lang, title: target.title}

  // Extraction runs first, on the page as it arrived, because most of what it
  // wants is in the parts the cleaner is about to take out.
  const references = extractReferences(raw)
  const record = {
    infobox: options.infobox === false ? undefined : extractInfobox(raw),
    images: options.images === false ? undefined : extractImages(raw)
  }

  const {tree, counts, used} = clean(raw, {...settings, references})

  // The notes the body reaches, cleaned the same way the body was, so a
  // citation's own links are rewritten like every other link on the page.
  const notes = used.map((id) => {
    const reference = references.get(id)

    return {
      id: reference.number,
      children: clean({type: 'root', children: reference.children}, settings).tree.children
    }
  })

  const data = frontMatter(page, options, {
    ...record,
    wikidata: page.wikidata
      ? wikidataRecord(page.wikidata.entity, page.wikidata.labels, {lang: target.lang})
      : undefined,
    categories: page.categories,
    langlinks: page.langlinks,
    sections: outline(tree, defaultResolve),
    references:
      options.refs === 'data'
        ? [...references.values()].map(({number, text, url}) =>
            url ? {number, text, url} : {number, text}
          )
        : undefined
  })

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

  tree.data = {matter: data, footnotes: notes}

  return {
    source: toMdy(tree, {
      ...options,
      // The ids in this tree are Wikipedia's — `id="Names"`, from its own
      // slugifier — and the document is about to be given mdy's. Saying the
      // parser was not assigning them is what lets a heading be written as a
      // heading rather than as an element pinned to a foreign anchor.
      headingId: false,
      // The document is meant to be templated — that is the whole point of
      // putting the infobox in the front matter — so it has to compile.
      script: options.script !== false,
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
function frontMatter(page, options, extracted) {
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

  // Where the page is, when it is somewhere. From the summary rather than from
  // the coordinate span in the HTML: the same numbers, already numbers.
  if (summary?.coordinates) {
    data.coordinates = {lat: summary.coordinates.lat, lon: summary.coordinates.lon}
  }

  if (summary?.originalimage?.source) {
    data.image = summary.originalimage.source.replace(/[?&]utm_[^&]*/g, '')
  }

  for (const [key, value] of Object.entries(extracted)) {
    if (value === undefined) continue
    if (Array.isArray(value) && !value.length) continue
    if (!Array.isArray(value) && typeof value === 'object' && !Object.keys(value).length) continue

    data[key] = value
  }

  data.source = source

  return data
}
