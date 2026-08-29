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
  const html = await get(target, {name: 'html', url: rest(target, 'html')}, options)
  const summary = await get(
    target,
    {name: 'summary', url: rest(target, 'summary'), optional: true, json: true},
    options
  )

  return {html, summary}
}

/**
 * The categories and the interwiki links, from the Action API.
 *
 * `clshow=!hidden` is the whole difference between a taxonomy and a
 * maintenance log: Babylon is in 53 categories, and 35 of them are
 * `All articles with unsourced statements` and its friends.
 *
 * @param {Target} target
 * @param {{categories?: boolean, langLinks?: boolean}} what
 * @param {object} [options]
 * @returns {Promise<{categories?: Array<string>, langlinks?: Record<string, string>}>}
 */
export async function fetchIndexes(target, what, options = {}) {
  const props = []

  if (what.categories) props.push('categories')
  if (what.langLinks) props.push('langlinks')
  if (!props.length) return {}

  const url =
    'https://' + target.lang + '.wikipedia.org/w/api.php?action=query&format=json' +
    '&formatversion=2&redirects=1&prop=' + props.join('%7C') +
    '&cllimit=max&clshow=!hidden&lllimit=max' +
    '&titles=' + encodeURIComponent(target.title)
  const body = await get(
    target,
    {name: 'indexes.' + props.join('-'), url, optional: true, json: true},
    options
  )
  const page = body?.query?.pages?.[0]

  if (!page) return {}

  /** @type {{categories?: Array<string>, langlinks?: Record<string, string>}} */
  const out = {}

  if (page.categories) {
    out.categories = page.categories.map((entry) =>
      String(entry.title).replace(/^Category:/, '')
    )
  }

  if (page.langlinks) {
    // A map rather than a list: what anybody wants from this is
    // `res.data.langlinks.fr`, and 115 languages as records is a page of YAML
    // saying almost nothing.
    out.langlinks = Object.fromEntries(
      page.langlinks.map((entry) => [entry.lang, entry.title])
    )
  }

  return out
}

/**
 * The pages in a category.
 *
 * Articles only (`cmnamespace=0`, `cmtype=page`): a category holds its
 * subcategories and its talk pages too, and neither is something to write a
 * document from. Continued to the end, because `cmlimit=max` is 500 and
 * plenty of categories are bigger.
 *
 * @param {string} name
 *   The category, with or without its `Category:` prefix.
 * @param {Target} target
 * @param {object} [options]
 * @returns {Promise<Array<string>>}
 */
export async function fetchCategory(name, target, options = {}) {
  const title = /^category:/i.test(name) ? name : 'Category:' + name
  /** @type {Array<string>} */
  const out = []
  let from

  for (let page = 0; page < 40; page++) {
    const body = await get(
      target,
      {
        name: 'category-' + page,
        url:
          'https://' + target.lang + '.wikipedia.org/w/api.php?action=query&format=json' +
          '&formatversion=2&list=categorymembers&cmnamespace=0&cmtype=page&cmlimit=max' +
          '&cmtitle=' + encodeURIComponent(title) +
          (from ? '&cmcontinue=' + encodeURIComponent(from) : ''),
        optional: true,
        json: true
      },
      {...options, cache: false}
    )

    for (const member of body?.query?.categorymembers ?? []) out.push(member.title)

    from = body?.continue?.cmcontinue

    if (!from) break
  }

  return out
}

/**
 * A Wikidata entity, and the labels for everything it names.
 *
 * The claims arrive as opaque ids — `P31` → `Q133442` — so a second round trip
 * turns them into `instance of` → `city-state`. That is what makes the record
 * readable, and it is why this is behind a flag: two more requests, ~150 ids
 * for Babylon, batched fifty at a time as the API asks.
 *
 * @param {string} id
 *   A `Q…` item id, from the page summary's `wikibase_item`.
 * @param {Target} target
 * @param {object} [options]
 * @returns {Promise<{entity: object, labels: Record<string, string>} | undefined>}
 */
export async function fetchWikidata(id, target, options = {}) {
  if (!id) return

  const entity = (
    await get(
      target,
      {
        name: 'wikidata',
        url: 'https://www.wikidata.org/wiki/Special:EntityData/' + encodeURIComponent(id) + '.json',
        optional: true,
        json: true
      },
      options
    )
  )?.entities?.[id]

  if (!entity) return

  const wanted = [...namesIn(entity)]
  const languages = target.lang === 'en' ? 'en' : target.lang + '%7Cen'
  /** @type {Record<string, string>} */
  const labels = {}

  for (let at = 0; at < wanted.length; at += 50) {
    const batch = wanted.slice(at, at + 50)
    const body = await get(
      target,
      {
        name: 'wikidata-labels-' + at / 50,
        url:
          'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json' +
          '&formatversion=2&props=labels&languages=' + languages +
          '&ids=' + batch.map(encodeURIComponent).join('%7C'),
        optional: true,
        json: true
      },
      options
    )

    for (const [name, found] of Object.entries(body?.entities ?? {})) {
      const label = found?.labels?.[target.lang]?.value ?? found?.labels?.en?.value

      if (label) labels[name] = label
    }
  }

  return {entity, labels}
}

/**
 * Every property and item an entity names, so all of them can be asked for at
 * once rather than one lookup at a time.
 *
 * @param {object} entity
 * @returns {Set<string>}
 */
function namesIn(entity) {
  /** @type {Set<string>} */
  const out = new Set()

  for (const [property, statements] of Object.entries(entity.claims ?? {})) {
    out.add(property)

    for (const statement of statements) {
      const value = statement.mainsnak?.datavalue?.value

      if (value?.id) out.add(value.id)
      if (typeof value?.unit === 'string' && value.unit.includes('/Q')) {
        out.add(value.unit.slice(value.unit.lastIndexOf('/') + 1))
      }
    }
  }

  return out
}

/**
 * One resource, from the cache when it is there and from the network when it
 * is not.
 *
 * Everything except the page's own HTML is `optional`: a summary, a category
 * list or a Wikidata entity that will not fetch leaves the document poorer and
 * still a document, and saying so beats failing the whole import over a
 * record nobody asked for by name.
 *
 * @param {Target} target
 * @param {{name: string, url: string, optional?: boolean, json?: boolean}} resource
 * @param {object} options
 * @returns {Promise<any>}
 */
async function get(target, resource, options) {
  const path =
    options.cache === false ? undefined : cachePath(target, resource, options)

  if (path && !options.refresh) {
    const cached = await readFile(path, 'utf8').catch(() => undefined)

    if (cached !== undefined) return decode(cached, resource, options)
  }

  const response = await send(resource, options)

  if (!response.ok) {
    if (resource.optional) {
      options.file?.message(
        'Could not fetch ' + resource.name + ' (' + response.status + '), leaving it out',
        {ruleId: 'fetch', source: 'mdy-wikipedia'}
      )

      return
    }

    throw new Error(
      'Could not fetch ' + resource.url + ': ' + response.status + ' ' + response.statusText
    )
  }

  const value = await response.text()

  if (path) {
    await mkdir(dirname(path), {recursive: true})
    await writeFile(path, value)
  }

  return decode(value, resource, options)
}

/**
 * @param {string} value
 * @param {{name: string, json?: boolean}} resource
 * @param {object} options
 * @returns {any}
 */
function decode(value, resource, options) {
  if (!resource.json) return value

  try {
    return JSON.parse(value)
  } catch {
    options.file?.message(
      'The ' + resource.name + ' response did not parse as JSON, ignoring it',
      {ruleId: 'fetch', source: 'mdy-wikipedia'}
    )
  }
}

/**
 * One request, made politely.
 *
 * Two things Wikimedia asks for and one it enforces. Requests go one at a
 * time — this whole module is serial, and a category import is a few hundred
 * of them — with a small gap between, which is invisible on a single page and
 * the difference between a guest and a scraper on two hundred. And a `429` or
 * `503` carries a `Retry-After` that is not advice: it is the server saying
 * when to come back, and an importer that ignores it gets blocked rather than
 * throttled.
 *
 * The gap is between *network* requests only. A cached page never reaches
 * here, which is what makes iterating on the converter free.
 *
 * @param {{url: string, json?: boolean}} resource
 * @param {object} options
 * @returns {Promise<{ok: boolean, status: number, statusText?: string, headers?: object, text: () => Promise<string>}>}
 */
async function send(resource, options) {
  const request = options.fetch ?? globalThis.fetch
  const gap = options.delay ?? 100
  const attempts = options.attempts ?? 3
  const headers = {
    'user-agent': userAgent(options),
    accept: resource.json ? 'application/json' : parsoidProfile
  }
  let response

  for (let attempt = 0; attempt < attempts; attempt++) {
    const since = Date.now() - lastRequest

    if (gap > since) await wait(gap - since)

    lastRequest = Date.now()
    response = await request(resource.url, {headers})

    if (response.status !== 429 && response.status !== 503) return response

    const after = Number(response.headers?.get?.('retry-after'))
    const backoff = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt

    options.file?.message(
      'Wikipedia asked to wait ' + Math.round(backoff / 1000) + 's (' + response.status + ')',
      {ruleId: 'fetch', source: 'mdy-wikipedia'}
    )

    await wait(Math.min(backoff, 60000))
  }

  return response
}

let lastRequest = 0

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Pinning the profile is what keeps a future Parsoid version from changing the
// shape of the tree under the cleaner without warning.
const parsoidProfile =
  'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/2.8.0"'

/**
 * @param {Target} target
 * @param {'html' | 'summary'} kind
 * @returns {string}
 */
function rest(target, kind) {
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
 * @param {{name: string}} resource
 * @param {object} options
 * @returns {string}
 */
function cachePath(target, resource, options) {
  const base =
    options.cache ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'mdy-wikipedia')

  return join(
    base,
    target.lang,
    encodeURIComponent(target.title) +
      (resource.name === 'html' ? '.html' : '.' + resource.name + '.json')
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
