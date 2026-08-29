/**
 * More than one page: a directory of documents rather than a document.
 *
 * This is the point of the whole exercise. One imported article is a nicely
 * converted article; two hundred of them in a directory is a *vault* — the
 * infobox that became `res.data.infobox` becomes a queryable field, and
 * `$.find({'infobox.type': 'Settlement'})` answers over the lot. That is a
 * different thing from a folder of prose, and it is the thing an mdy document
 * set was built for.
 *
 * Everything here is serial on purpose. Wikimedia asks for it, a category
 * import is a few hundred requests, and the cache means the second run of a
 * two-hundred-page import costs nothing at all — so there is no speed to win
 * that is worth being rude for.
 */

import {defaultResolve} from 'mdy-docs/parse/wiki.js'
import {buildDocument} from './index.js'
import {fetchCategory, fetchIndexes, fetchPage, fetchWikidata, resolveTarget} from './fetch.js'

/**
 * Where a page's document belongs, relative to the output directory.
 *
 * The same slugifier `[[ label ]]` uses, which is not a coincidence: with
 * `--links=wiki` a document links to `[[ babylonia ]]`, and this is what makes
 * that land on `babylonia.mdy` in the same directory. A title with a slash
 * keeps it and becomes a subdirectory, which is what mdy's own vault walk
 * expects.
 *
 * @param {{lang: string, title: string}} target
 * @returns {string}
 */
export function documentPath(target) {
  const name = defaultResolve(target.title) || 'untitled'

  return name.replace(/^\/+/, '') + '.mdy'
}

/**
 * Work out which pages to import, and import them.
 *
 * An async generator rather than an array, so a two-hundred-page import
 * reports as it goes and a caller can stop it. Each document is yielded the
 * moment it is written, along with what the page cost and what could not be
 * said.
 *
 * @param {Array<string>} seeds
 *   Titles, `lang:title` prefixes, or Wikipedia URLs.
 * @param {object} [options]
 *   Everything `wikipediaToMdy` takes, plus `category` (import a category's
 *   pages), `follow` (depth to follow links to, 0 for none), `max` (a hard cap
 *   on documents — following links is how an import of one page becomes an
 *   import of a thousand), and `onProgress`.
 * @yields {{target: object, path: string, source: string, data: object, counts: object, messages: Array<string>}}
 */
export async function* importVault(seeds, options = {}) {
  const lang = options.lang ?? 'en'
  const max = options.max ?? 100
  const follow = options.follow ?? 0
  /** @type {Array<{target: object, depth: number}>} */
  const queue = []
  /** @type {Set<string>} */
  const seen = new Set()

  const enqueue = (input, depth) => {
    const target = resolveTarget(input, {lang})
    const key = target.lang + ':' + target.title

    if (seen.has(key)) return

    seen.add(key)
    queue.push({target, depth})
  }

  for (const seed of seeds) enqueue(seed, 0)

  if (options.category) {
    const from = {lang, title: 'Category:' + options.category}

    for (const title of await fetchCategory(options.category, from, options)) {
      enqueue(lang + ':' + title, 0)
    }
  }

  if (!queue.length) throw new Error('Nothing to import')

  let written = 0

  while (queue.length && written < max) {
    const {target, depth} = queue.shift()
    // One file's messages, not the whole run's: which page could not say what
    // is the only useful form of that.
    const messages = []
    const file = {message: (reason) => messages.push(String(reason))}
    let document

    try {
      document = await importOne(target, {...options, file})
    } catch (error) {
      yield {target, path: documentPath(target), error, messages}
      continue
    }

    written += 1

    yield {...document, target, path: documentPath(target), messages}

    if (depth >= follow) continue

    // Queued, not fetched. The cap is on documents written, and letting the
    // queue fill past it is what lets the report say how much was left — which
    // is the number that tells you whether the cap was the right one.
    for (const title of document.links) enqueue(target.lang + ':' + title, depth + 1)
  }

  // Whatever is still queued when the cap is reached was never fetched, which
  // is the point of the cap: Babylon alone links to 292 pages.
  if (queue.length) {
    options.onProgress?.({
      kind: 'capped',
      reached: max,
      left: queue.length
    })
  }
}

/**
 * One page, fetched and built. The same work `wikipediaToMdy` does, reached
 * from a target that has already been resolved.
 *
 * @param {{lang: string, title: string}} target
 * @param {object} options
 * @returns {Promise<object>}
 */
async function importOne(target, options) {
  const page = await fetchPage(target, options)
  const indexes = await fetchIndexes(target, options, options)
  const wikidata = options.wikidata
    ? await fetchWikidata(page.summary?.wikibase_item, target, options)
    : undefined

  return buildDocument({...page, ...indexes, wikidata, target}, options)
}
