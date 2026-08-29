/**
 * Parsoid HTML → a tree that is the article and nothing else.
 *
 * Most of a Wikipedia page is not the article. Babylon's very first `<p>` holds
 * no prose at all: it is an `mw-empty-elt` wrapping a protection-template
 * `<meta>` and a category `<link>`. Under that come 114 `<style>` elements from
 * template stylesheets, 172 citation `<sup>`s, 169 transclusion `<span>`s that
 * exist only to say where a template started, and a navbox at the bottom the
 * size of the lead.
 *
 * So this is a list rather than a program: what to drop, what to unwrap, and
 * what to rewrite. Reading the list should be enough to know what the output
 * will contain, and adding to it should be the whole of the work when
 * Wikipedia changes something.
 *
 * The distinction that matters is **drop** versus **unwrap**. Dropping takes
 * the element and its content; unwrapping takes the element and keeps the
 * content. A navbox is dropped because none of it is the article. A
 * `<span typeof="mw:Transclusion">` is unwrapped because all of it is: the
 * span is Parsoid's bookkeeping around real prose. Getting these two the wrong
 * way round is how an importer silently loses paragraphs, so each rule says
 * which it is and the tests count what each one took.
 */

import {defaultResolve} from 'mdy-docs/parse/wiki.js'
import {toText} from 'mdy-docs/parse/script.js'

// Parsoid's own ids (`mwDQ`), which are addresses in a tree we are about to
// stop having, not names anybody wrote.
const parsoidId = /^mw[A-Za-z0-9_-]{0,4}$/
// An internal link, as Parsoid writes it: `./Third_Dynasty_of_Ur`.
const wikiHref = /^\.\/([^#]*)(#.*)?$/

/** Elements that go, with everything inside them. */
const drops = [
  {name: 'chrome', tagName: ['style', 'link', 'meta', 'noscript']},
  {name: 'edit-links', className: ['mw-editsection']},
  {name: 'empty', className: ['mw-empty-elt']},
  {name: 'hatnotes', className: ['hatnote', 'dablink', 'shortdescription']},
  {
    name: 'banners',
    className: [
      'navbox', 'navbox-styles', 'vertical-navbox', 'metadata', 'ambox',
      'mbox', 'ombox', 'sistersitebox', 'side-box', 'navigation-not-searchable',
      'noprint', 'mw-kartographer-container'
    ]
  },
  {name: 'inline-templates', className: ['Inline-Template', 'Template-Fact']},
  // Harvested as data rather than read as prose (phase 2), and noise until then.
  {name: 'infobox', className: ['infobox']},
  {name: 'coordinates', id: ['coordinates']},
  {
    name: 'references',
    className: ['reflist', 'refbegin', 'mw-references-wrap', 'mw-reflink-text'],
    typeOf: ['mw:Extension/references']
  },
  {name: 'citations', typeOf: ['mw:Extension/ref'], className: ['mw-ref', 'reference']},
  {name: 'indicators', typeOf: ['mw:Extension/indicator']},
  // An empty `<span id="Etymology">` is an anchor Wikipedia keeps so that
  // links written before a section was renamed still land. It anchors nothing
  // here, and an element with an id has to be written in element form — a
  // line — which would break the sentence it sits in.
  {
    name: 'legacy-anchors',
    test: (node) => node.tagName === 'span' && !node.children.length
  },
  // Video and audio are not prose and mdy has nowhere to put them. Phase 2
  // takes the media out as data, where a player belongs.
  {name: 'media', tagName: ['video', 'audio', 'track', 'source', 'map']}
]

// Elements MDY writes as toggling inline markers (rule 8). A marker carries no
// attributes, so an element here with one on it would have to be written in
// element form — and an element opener is a *line*, which would break the
// sentence it sits in. The attribute goes and the emphasis stays: for an
// importer that is the right way round, and `lang="ar-Latn"` on a
// transliteration is the common case.
const inlineMarkup = new Set([
  'b', 'i', 'em', 'strong', 'u', 's', 'strike', 'del', 'mark', 'sup', 'sub', 'code'
])

const presentational = [
  'width', 'height', 'bgcolor', 'align', 'valign', 'cellPadding',
  'cellSpacing', 'border', 'noWrap', 'frame', 'rules', 'summary'
]

// The same elements under the names MDY's marker table knows them by. `<i>`
// and `<b>` say how a thing looked; `<em>` and `<strong>` say what it is, and
// they are what `//` and `!!` produce.
const renames = {i: 'em', b: 'strong', s: 'del', strike: 'del'}

// Elements that carry no meaning MDY can write. A `<cite>` around a book title
// is `<i>` with a name; a `<div>` is a box. They go and their content stays.
const plainTags = [
  'span', 'div', 'bdi', 'bdo', 'abbr', 'cite', 'small', 'big', 'kbd', 'samp',
  'var', 'data', 'time', 'q', 'font', 'center', 'ruby', 'rb'
]

// Attributes taken off so that the element carrying them can be unwrapped or
// written. MDY has no inline element syntax, so a `<span lang="ar">` around a
// word cannot be written at all: taking the `lang` off is what lets the span
// unwrap quietly, leaving the word. The text is the article; the annotation is
// not.
const unwritable = {
  // Every element that is about to be unwrapped: `lang` and `dir` on one are
  // worth keeping and there is nowhere to keep them, and leaving them on is
  // what stops the unwrap.
  // `id` goes for the same reason a heading's does: the anchors in the
  // document being written are mdy's, and Wikipedia's — `id="Beaulieu2018"` on
  // a bibliography entry, pointing at a citation that has already gone — name
  // nothing here.
  ...Object.fromEntries(plainTags.map((name) => [name, ['lang', 'dir', 'id']])),
  // Wikipedia's tables are laid out in HTML 3.2. None of it survives mdy's
  // sanitizer — `width` on a `<th>` is reported and dropped on every row — and
  // an attribute mdy will not keep is one that stops the table being written
  // with pipes for no gain at all.
  table: presentational,
  thead: presentational,
  tbody: presentational,
  tr: presentational,
  th: presentational,
  td: presentational
}

/** Elements that go, leaving their content behind. */
const unwraps = [
  // Sections are the page's outline, and the outline is the headings. An mdy
  // document is flat.
  {name: 'sections', tagName: ['section']},
  {name: 'bookkeeping', typeOf: ['mw:Transclusion', 'mw:Entity', 'mw:Nowiki', 'mw:ExpandedAttrs', 'mw:LocalizedAttrs']},
  // The link Wikipedia wraps every thumbnail in, pointing at the file page.
  // The figure owns the image; a link around it is chrome.
  {name: 'file-links', className: ['mw-file-description', 'image']},
  {name: 'plain', tagName: plainTags}
]

/**
 * @typedef Options
 * @property {'url' | 'path' | 'wiki'} [links='url']
 *   How an internal link is written: the full URL, `/wiki/Babylonia`, or a
 *   bare `[[ Babylonia ]]` into a vault of your own.
 *
 *   The full URL is the default because mdy tidies a link to a page of your
 *   own by lower casing it (language rule 9), which is right for pages you
 *   write and wrong for Wikipedia's: `/wiki/Help:IPA/English` arrives as
 *   `/wiki/help:ipa/english`, which is not a page. `path` is for a site whose
 *   pages these really are.
 * @property {boolean} [keepSections=false]
 *   Whether the end matter — See also, References, External links — is prose
 *   too. It is data (phase 2), so it goes by default.
 * @property {Array<string>} [sections]
 *   Only these sections, by id or heading text; `lead` is the part above the
 *   first heading.
 */

// Sections that are a list of pointers rather than an article.
const endMatter = new Set([
  'see also', 'notes', 'references', 'sources', 'citations', 'bibliography',
  'further reading', 'external links'
])

/**
 * Clean a Parsoid document.
 *
 * @param {import('hast').Root} tree
 * @param {Options & {lang?: string, title?: string, file?: object}} [options]
 * @returns {{tree: import('hast').Root, counts: Record<string, number>}}
 */
export function clean(tree, options = {}) {
  const counts = {}
  const body = find(tree, 'body') ?? tree
  const sections = pickSections(body, options, counts)

  return {
    tree: {type: 'root', children: walk(sections, options, counts)},
    counts
  }
}

/**
 * Take the sections that are prose.
 *
 * Done before the general walk, because it is the one decision that needs the
 * `<section>` wrappers the walk is about to unwrap.
 *
 * @param {import('hast').Element} body
 * @param {Options} options
 * @param {Record<string, number>} counts
 * @returns {Array<import('hast').RootContent>}
 */
function pickSections(body, options, counts) {
  const wanted = options.sections?.map((name) => name.toLowerCase())
  /** @type {Array<import('hast').RootContent>} */
  const out = []
  let dropping = false

  for (const node of body.children) {
    if (node.type !== 'element' || node.tagName !== 'section') {
      if (!dropping) out.push(node)
      continue
    }

    const id = String(node.properties?.dataMwSectionId ?? '')
    const heading = find(node, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    const title = heading ? toText(heading).trim() : ''
    const depth = heading ? Number(heading.tagName.slice(1)) : 0

    // End matter carries its subsections with it: `Sources` under `References`
    // is part of the same apparatus, and only the top of the run says so.
    if (depth <= 2) dropping = false

    if (!options.keepSections && depth === 2 && endMatter.has(title.toLowerCase())) {
      dropping = true
    }

    if (dropping) {
      count(counts, 'end-matter')
      continue
    }

    if (wanted) {
      const named =
        wanted.includes(title.toLowerCase()) ||
        wanted.includes(id) ||
        (wanted.includes('lead') && id === '0')

      if (!named) {
        count(counts, 'unselected')
        continue
      }
    }

    out.push(node)
  }

  return out
}

/**
 * @param {Array<import('hast').RootContent>} nodes
 * @param {Options} options
 * @param {Record<string, number>} counts
 * @returns {Array<import('hast').RootContent>}
 */
function walk(nodes, options, counts) {
  /** @type {Array<import('hast').RootContent>} */
  const out = []

  for (const node of nodes) {
    if (node.type === 'comment') continue

    if (node.type !== 'element') {
      out.push(node)
      continue
    }

    const dropped = drops.find((rule) => matches(node, rule))

    if (dropped) {
      count(counts, dropped.name)
      continue
    }

    const children = walk(node.children, options, counts)
    const kept = properties(node, options)
    const unwrapped = unwraps.find((rule) => matches(node, rule))

    // A `<span>` or `<div>` with nothing left on it is a wrapper; one still
    // carrying something might be saying it, so it stays.
    if (unwrapped && (unwrapped.name !== 'plain' || !Object.keys(kept).length)) {
      count(counts, unwrapped.name)
      out.push(...children)
      continue
    }

    out.push({
      type: 'element',
      tagName: renames[node.tagName] ?? node.tagName,
      properties: kept,
      children
    })
  }

  return out
}

// Attributes that describe the page Wikipedia rendered rather than the
// document being written. `className` is here because Wikipedia's classes name
// its own stylesheets, and an mdy document has no use for them.
const bookkeeping = new Set([
  'about', 'typeof', 'rel', 'resource', 'dataMw', 'dataParsoid', 'dataMwSectionId',
  'className', 'style', 'title', 'decoding', 'loading', 'srcSet', 'sizes',
  'dataFileWidth', 'dataFileHeight', 'dataFileType', 'referrerPolicy'
])

/**
 * @param {import('hast').Element} node
 * @param {Options} options
 * @returns {import('hast').Properties}
 */
function properties(node, options) {
  /** @type {import('hast').Properties} */
  const out = {}

  for (const [key, value] of Object.entries(node.properties ?? {})) {
    if (bookkeeping.has(key)) continue
    if (inlineMarkup.has(node.tagName)) continue
    if (unwritable[node.tagName]?.includes(key)) continue

    // Headings keep no id: the document is about to be given its own, from its
    // own slugifier, and two schemes for one anchor is one too many.
    if (key === 'id') {
      if (parsoidId.test(String(value))) continue
      if (/^h[1-6]$/.test(node.tagName)) continue
    }

    out[key] = value
  }

  if (node.tagName === 'a' && typeof out.href === 'string') {
    out.href = href(out.href, node, options)
  }

  if (node.tagName === 'img' && typeof out.src === 'string') {
    out.src = source(out.src)
  }

  return out
}

/**
 * An image URL worth writing down: a scheme rather than Wikipedia's
 * protocol-relative `//upload.wikimedia.org/…`, and without the analytics
 * parameters the renderer hangs off every thumbnail.
 *
 * @param {string} value
 * @returns {string}
 */
function source(value) {
  const absolute = value.startsWith('//') ? 'https:' + value : value

  try {
    const url = new URL(absolute)

    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_')) url.searchParams.delete(key)
    }

    return url.href
  } catch {
    return absolute
  }
}

/**
 * Where a link points once it is in a document of ours.
 *
 * Internal links are Parsoid's `./Page_Title`. A fragment of this same page
 * becomes a bare `#fragment`, slugified the way mdy slugifies a heading — the
 * document is about to name its own anchors, and a link into it has to use
 * those names. Everything else is somebody else's URL and is left alone.
 *
 * @param {string} value
 * @param {import('hast').Element} node
 * @param {Options & {lang?: string, title?: string}} options
 * @returns {string}
 */
function href(value, node, options) {
  const match = wikiHref.exec(value)

  if (!match) return value

  const page = decodeURIComponent(match[1]).replaceAll('_', ' ')
  const fragment = match[2] ? decodeURIComponent(match[2].slice(1)).replaceAll('_', ' ') : ''

  if (!page || page === options.title) {
    return fragment ? '#' + defaultResolve(fragment) : ''
  }

  if (options.links === undefined || options.links === 'url') {
    return (
      'https://' + (options.lang ?? 'en') + '.wikipedia.org/wiki/' +
      encodeURIComponent(page.replaceAll(' ', '_')) + (fragment ? '#' + fragment : '')
    )
  }

  // The mode that makes an import behave like a page you wrote: the link is
  // slugified into a page of your own, and mdy writes it down on
  // `res.data.links` as it parses.
  if (options.links === 'wiki') {
    return defaultResolve(page + (fragment ? '#' + fragment : ''))
  }

  return (
    '/wiki/' + page.replaceAll(' ', '_') + (fragment ? '#' + fragment : '')
  )
}

/**
 * @param {import('hast').Element} node
 * @param {object} rule
 * @returns {boolean}
 */
function matches(node, rule) {
  if (rule.test?.(node)) return true
  if (rule.tagName?.includes(node.tagName)) return true

  const properties = node.properties ?? {}

  if (rule.id?.includes(properties.id)) return true

  if (rule.className) {
    const classes = properties.className ?? []

    if (classes.some((name) => rule.className.includes(name))) return true
  }

  if (rule.typeOf) {
    const values = String(properties.typeof ?? '').split(/\s+/)

    if (values.some((name) => rule.typeOf.includes(name))) return true
  }

  return false
}

/**
 * @param {import('hast').Root | import('hast').Element} tree
 * @param {string | Array<string>} tagNames
 * @returns {import('hast').Element | undefined}
 */
function find(tree, tagNames) {
  const names = Array.isArray(tagNames) ? tagNames : [tagNames]

  for (const node of tree.children ?? []) {
    if (node.type !== 'element') continue
    if (names.includes(node.tagName)) return node

    const found = find(node, names)

    if (found) return found
  }
}

/**
 * @param {Record<string, number>} counts
 * @param {string} name
 */
function count(counts, name) {
  counts[name] = (counts[name] ?? 0) + 1
}
