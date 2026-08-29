/**
 * The parts of a page that are data rather than prose.
 *
 * This runs **first**, on the tree as Parsoid sent it, because most of what it
 * wants is in the parts `clean.js` is about to remove. The infobox is a table
 * pretending to be a record; the citations are a list at the bottom that the
 * body points into; the images are figures with captions. Rendering the page
 * to markup throws all of that away and leaves text. Reading it out first is
 * the whole reason this package exists rather than a general HTML converter:
 * a directory of imports where `$.find({'infobox.type': 'Settlement'})` works
 * is a different thing from a directory of articles.
 */

import {toText as textOf} from 'mdy-docs/parse/script.js'

// The citation markers, which are not part of any value: `Built c. 2200 BC[12]`
// is not a date. Matched the way `clean.js` matches them, by Parsoid's own
// marker rather than by class, so a skin change cannot quietly break it.
const citation = (node) =>
  node.type === 'element' &&
  (String(node.properties?.typeof ?? '').split(/\s+/).includes('mw:Extension/ref') ||
    (node.properties?.className ?? []).includes('mw-cite-backlink'))

const invisible = new Set(['style', 'link', 'meta', 'script'])
// Elements that draw a break rather than a character. Without a space in their
// place, Wikipedia's `<br>`-separated infobox values run together:
// `10 December 1815London, England`.
const spacing = new Set(['br', 'p', 'div', 'li', 'tr', 'dd', 'dt', 'hr'])
// Wikipedia puts machine-readable microformats beside the text and hides them,
// so a birth date reads `(1815-12-10)10 December 1815`. What a reader cannot
// see is not part of the value.
const hidden = (node) =>
  /display\s*:\s*none/i.test(String(node.properties?.style ?? '')) ||
  (node.properties?.className ?? []).some((name) =>
    name === 'noprint' || name === 'sortkey' || name === 'mw-empty-elt'
  )

/**
 * The text a value reads as, with the apparatus taken off.
 *
 * @param {import('hast').ElementContent | Array<import('hast').ElementContent>} node
 * @returns {string}
 */
export function plainText(node) {
  // Collapsed once, at the end. Doing it per level would eat the space
  // *between* two elements, which is how `Part of` becomes `Partof` and
  // `c. 2200 BC` becomes `c.2200 BC`. Zero-width characters go with it: they
  // are typesetting, and they survive a trip through YAML looking like a bug.
  return raw(Array.isArray(node) ? node : [node])
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {Array<import('hast').ElementContent>} children
 * @returns {string}
 */
function raw(children) {
  let out = ''

  for (const child of children) {
    if (child.type === 'text') {
      out += child.value
      continue
    }

    // A root as readily as an element: this is asked of whole trees as often
    // as of cells.
    if (child.type === 'root') {
      out += raw(child.children)
      continue
    }

    if (child.type !== 'element') continue
    if (citation(child) || invisible.has(child.tagName) || hidden(child)) continue

    if (spacing.has(child.tagName)) out += ' '

    out += raw(child.children)

    if (spacing.has(child.tagName)) out += ' '
  }

  return out
}

/**
 * Read the infobox as a record.
 *
 * Parsoid renders it as `<th class="infobox-label">` / `<td class="infobox-data">`
 * pairs, broken into groups by `<th class="infobox-header">`. Slugify the
 * labels, nest by the headers, and Babylon's comes out as the plan's sample —
 * `history.built`, `site-notes.area`, `unesco-world-heritage-site.criteria`.
 *
 * The nesting is not decoration. Babylon has a `region` (Mesopotamia) *and* a
 * World Heritage listing with a `region` (Arab States); flat, one silently eats
 * the other. Grouped, both survive and each says which region it means.
 *
 * Values are kept as the strings they are. An infobox value is display text —
 * `9 km2 (3.5 sq mi)`, `c. 2200 BC` — and the few that look like numbers are
 * usually identifiers, where being a number is wrong: a World Heritage
 * reference number is `278`, not two hundred and seventy-eight. A cell holding
 * a list becomes a list.
 *
 * @param {import('hast').Root} tree
 * @returns {Record<string, unknown> | undefined}
 */
export function extractInfobox(tree) {
  const table = findFirst(tree, (node) => classOf(node).includes('infobox'))

  if (!table) return

  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {Record<string, unknown>} */
  let group = out

  // A row at a time, because a label and its value are cells of one row and
  // that is the only thing that pairs them: Parsoid puts a header in a row of
  // its own and an image in another, so position in the table says nothing.
  for (const row of collect(table, (node) => node.tagName === 'tr')) {
    const cells = row.children.filter((child) => child.type === 'element')
    const header = cells.find((cell) => classOf(cell).includes('infobox-header'))
    const label = cells.find((cell) => classOf(cell).includes('infobox-label'))
    const data = cells.find((cell) => classOf(cell).includes('infobox-data'))
    const picture = cells.find((cell) => classOf(cell).includes('infobox-image'))

    if (picture && !out.image) {
      const image = findFirst(picture, (node) => node.tagName === 'img')
      const caption = findFirst(picture, (node) =>
        classOf(node).includes('infobox-caption')
      )

      if (image) {
        out.image = clip({
          src: sourceUrl(String(image.properties?.src ?? '')),
          caption: caption ? plainText(caption) : undefined
        })
      }
    }

    if (header) {
      const name = slug(plainText(header))

      // A header with no name groups nothing; keep writing where we were.
      group = name ? (out[name] = {}) : out
      continue
    }

    if (!label || !data) continue

    const name = slug(plainText(label))
    const value = cellValue(data)

    if (name && value !== undefined && group[name] === undefined) {
      group[name] = value
    }
  }

  return Object.keys(out).length ? out : undefined
}

/**
 * @param {import('hast').Element} cell
 * @returns {string | Array<string> | undefined}
 */
function cellValue(cell) {
  const items = collect(cell, (node) => node.tagName === 'li')
    .map(plainText)
    .filter(Boolean)

  if (items.length > 1) return items

  const text = plainText(cell)

  return text || undefined
}

/**
 * Every image on the page, with its caption.
 *
 * @param {import('hast').Root} tree
 * @returns {Array<object>}
 */
export function extractImages(tree) {
  const out = []

  for (const figure of collect(tree, (node) => node.tagName === 'figure')) {
    const image = findFirst(figure, (node) => node.tagName === 'img')

    if (!image) continue

    const caption = findFirst(figure, (node) => node.tagName === 'figcaption')
    const resource = String(image.properties?.resource ?? '')

    out.push(
      clip({
        file: resource.startsWith('./File:') ? decodeURIComponent(resource.slice(7)) : undefined,
        src: sourceUrl(String(image.properties?.src ?? '')),
        width: number(image.properties?.dataFileWidth),
        height: number(image.properties?.dataFileHeight),
        caption: caption ? plainText(caption) : undefined
      })
    )
  }

  return out
}

/**
 * The citations, keyed by the id the body's `<sup>`s point at.
 *
 * Each is kept twice over: as the text it reads as, for the record, and as the
 * tree it is, so the note in the document can carry the links the citation had.
 * The number is Wikipedia's own — `1`, `2`, or `a`, `b` for a second group —
 * which is what a reader saw on the page they came from.
 *
 * @param {import('hast').Root} tree
 * @returns {Map<string, {id: string, number: string, text: string, url: string | undefined, children: Array<import('hast').ElementContent>}>}
 */
export function extractReferences(tree) {
  const out = new Map()

  for (const item of collect(tree, (node) => node.tagName === 'li')) {
    const id = String(item.properties?.id ?? '')

    if (!id.startsWith('cite_note')) continue

    const body = findFirst(item, (node) => classOf(node).includes('mw-reference-text'))

    if (!body) continue

    const link = findFirst(
      body,
      (node) => node.tagName === 'a' && /^https?:/.test(String(node.properties?.href ?? ''))
    )

    out.set(id, {
      id,
      number: String(item.properties?.dataMwFootnoteNumber ?? out.size + 1),
      text: plainText(body),
      url: link ? String(link.properties.href) : undefined,
      children: body.children
    })
  }

  return out
}

/**
 * The outline, read off the document rather than off the page.
 *
 * Taken after cleaning, and slugified with mdy's own slugifier, so every entry
 * names an anchor that will actually be in the rendered page — the sections
 * that were dropped are not in it, and the ids are the ones mdy is about to
 * give the headings.
 *
 * @param {import('hast').Root} tree
 * @param {(text: string) => string} resolve
 * @returns {Array<{level: number, id: string, title: string}>}
 */
export function outline(tree, resolve) {
  const out = []
  /** @type {Set<string>} */
  const used = new Set()

  for (const heading of collect(tree, (node) => /^h[1-6]$/.test(node.tagName))) {
    const title = plainText(heading)
    const base = resolve(title)

    if (!base) continue

    let id = base
    let count = 0

    while (used.has(id)) id = base + '-' + ++count

    used.add(id)
    out.push({level: Number(heading.tagName.slice(1)), id, title})
  }

  return out
}

/* ------------------------------------------------------------------- parts */

/**
 * The same tidying `clean.js` does to an image URL, needed here too because
 * the infobox and the image list are read before the cleaner runs.
 *
 * @param {string} value
 * @returns {string | undefined}
 */
function sourceUrl(value) {
  if (!value) return

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
 * Lower case, non-alphanumerics to single hyphens — the spelling the plan's
 * sample uses, and the one a label like `Reference no.` has to survive.
 *
 * @param {string} value
 * @returns {string}
 */
function slug(value) {
  // Letters and numbers, not `a-z0-9`: a label is whatever language the wiki
  // is in, and `Encyclopædia` should key as `encyclopædia` rather than as
  // `encyclop-dia`. ASCII labels are unaffected, which is every label on the
  // English infobox.
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
function clip(value) {
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === '') delete value[key]
  }

  return value
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function number(value) {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * @param {import('hast').Element} node
 * @returns {Array<string>}
 */
function classOf(node) {
  const classes = node.properties?.className

  return Array.isArray(classes) ? classes.map(String) : []
}

/**
 * Every element matching `test`, in document order.
 *
 * @param {import('hast').Parent} tree
 * @param {(node: import('hast').Element) => boolean} test
 * @returns {Array<import('hast').Element>}
 */
function collect(tree, test, out = []) {
  for (const child of tree.children ?? []) {
    if (child.type !== 'element') continue
    if (test(child)) out.push(child)

    collect(child, test, out)
  }

  return out
}

/**
 * @param {import('hast').Parent} tree
 * @param {(node: import('hast').Element) => boolean} test
 * @returns {import('hast').Element | undefined}
 */
function findFirst(tree, test) {
  for (const child of tree.children ?? []) {
    if (child.type !== 'element') continue
    if (test(child)) return child

    const found = findFirst(child, test)

    if (found) return found
  }
}

