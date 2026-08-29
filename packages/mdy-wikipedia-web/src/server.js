/**
 * The server side of the reader: fetch a page, convert it, keep it.
 *
 * It is deliberately thin. All the conversion is `@mdy-docs/mdy-wikipedia`
 * exactly as the CLI uses it, and all the *rendering* happens in the browser
 * with the same parser — so the page in front of you is the document, not a
 * picture of one, and editing the source re-renders without asking the server
 * anything.
 *
 * What the server adds is memory. A document already converted is served from
 * the vault or from this process rather than fetched again, which is what makes
 * following a link feel like following a link: the second visit to Babylonia is
 * instant, and the first one costs a fetch.
 */

import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {documentPath, resolveTarget, wikipediaToMdy} from '@mdy-docs/mdy-wikipedia'

/**
 * @typedef Options
 * @property {string} [vault]
 *   A directory of documents. Read from before Wikipedia is asked, and written
 *   to after — so a session leaves something behind, and the next one starts
 *   with it.
 * @property {string} [lang]
 * @property {object} [convert]
 *   Passed to the converter. `links` is forced to `url`: the reader has to be
 *   able to tell, from an `href` alone, which article a link points at, and the
 *   full URL is the only form that still carries the title.
 */

/**
 * @param {Options} [options]
 */
export function createLibrary(options = {}) {
  /** @type {Map<string, object>} */
  const loaded = new Map()

  return {load, list, loaded}

  /**
   * @param {string} input
   *   A title, a `lang:title`, or a Wikipedia URL.
   * @param {{refresh?: boolean}} [request]
   */
  async function load(input, request = {}) {
    const target = resolveTarget(input, {lang: options.lang ?? 'en'})
    const key = target.lang + ':' + target.title
    const path = target.lang + '/' + documentPath(target)

    if (!request.refresh && loaded.has(key)) {
      return {...loaded.get(key), from: 'memory'}
    }

    if (!request.refresh && options.vault) {
      const source = await readFile(join(options.vault, path), 'utf8').catch(() => undefined)

      if (source !== undefined) {
        const page = {...target, key, path, source, messages: [], counts: {}}

        loaded.set(key, page)

        return {...page, from: 'vault'}
      }
    }

    const messages = []
    const {source, counts} = await wikipediaToMdy(input, {
      ...options.convert,
      lang: options.lang ?? 'en',
      // The one setting the reader cannot do without: a `[[ babylonia ]]` link
      // has lost the title it came from, and `/wiki/babylonia` has been lower
      // cased by mdy's own link rule. Only the full URL still says which
      // article this is.
      links: 'url',
      refresh: request.refresh,
      file: {message: (reason) => messages.push(String(reason))}
    })
    const page = {...target, key, path, source, messages, counts}

    loaded.set(key, page)

    if (options.vault) {
      const file = join(options.vault, path)

      await mkdir(dirname(file), {recursive: true})
      await writeFile(file, source)
    }

    return {...page, from: 'wikipedia'}
  }

  /**
   * Everything already converted, in the order it was met, plus whatever the
   * vault was holding before this session started.
   */
  async function list() {
    // Keyed by path, which is the one identity a document has in both places:
    // on disk it is all there is, and in memory it is what the title slugified
    // to. Keying by title instead would list a page twice — once as `hillah`
    // from the vault and once as `Hillah` from this session.
    const out = new Map()

    if (options.vault) {
      for (const path of await walk(options.vault)) {
        const [lang, ...rest] = path.split('/')
        const name = rest.join('/').replace(/\.mdy$/, '')

        if (!name) continue

        out.set(path, {lang, title: titleOf(name), path, held: 'vault'})
      }
    }

    // Second, so a real title replaces the one guessed from a file name.
    for (const page of loaded.values()) {
      out.set(page.path, {
        lang: page.lang,
        title: page.title,
        path: page.path,
        held: 'loaded'
      })
    }

    return [...out.values()].sort((a, b) => a.title.localeCompare(b.title))
  }
}

/**
 * A document's file name back into something to ask Wikipedia for.
 *
 * A guess, and only ever used for the name in a list: the slug that names a
 * file has lost the article's capitals and its punctuation, which is the whole
 * reason links are written as URLs rather than as slugs.
 *
 * @param {string} name
 * @returns {string}
 */
function titleOf(name) {
  return name
    .replaceAll('-', ' ')
    .replace(/(^|\s)\p{Ll}/gu, (character) => character.toUpperCase())
}

/**
 * @param {string} root
 * @param {string} [prefix]
 * @returns {Promise<Array<string>>}
 */
async function walk(root, prefix = '') {
  const entries = await readdir(join(root, prefix), {withFileTypes: true}).catch(() => [])
  const out = []

  for (const entry of entries) {
    const path = prefix ? prefix + '/' + entry.name : entry.name

    if (entry.isDirectory()) out.push(...(await walk(root, path)))
    else if (entry.name.endsWith('.mdy')) out.push(path)
  }

  return out
}
