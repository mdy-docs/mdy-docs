/**
 * A footnote definition: `[[ ^id ]]: the note itself`.
 */
export const definitionLine = /^\[\[[ \t]*\^([^\]|]+?)[ \t]*\]\][ \t]*:[ \t]*(.*)$/

/**
 * @typedef Settings
 * @property {string} label
 *   Heading above the notes. It is visually hidden but read aloud, and named by
 *   every reference through `aria-describedby`.
 * @property {string} prefix
 *   Put in front of every generated `id`. The default matches GitHub's, which
 *   exists so that a note called `content` cannot shadow a page's own element.
 * @property {string} backLabel
 *   `aria-label` on the link back up to the reference.
 */

/**
 * Resolve the `footnotes` option.
 *
 * @param {boolean | Partial<Settings> | undefined} footnotes
 * @returns {Settings | undefined}
 */
export function normalizeFootnotes(footnotes) {
  if (footnotes === false) return
  if (footnotes === undefined || footnotes === true) {
    return {
      label: 'Footnotes',
      prefix: 'user-content-',
      backLabel: 'Back to content'
    }
  }

  return {
    label: footnotes.label ?? 'Footnotes',
    prefix: footnotes.prefix ?? 'user-content-',
    backLabel: footnotes.backLabel ?? 'Back to content'
  }
}

/**
 * Find every id that has a definition somewhere in the document.
 *
 * A reference is only a reference when something defines it, and a definition
 * may come after the text that points at it, so this has to be known before a
 * single line is parsed.
 *
 * @param {Array<string>} lines
 * @returns {Set<string>}
 */
export function findDefinitions(lines) {
  /** @type {Set<string>} */
  const known = new Set()

  for (const line of lines) {
    const match = definitionLine.exec(line.trimStart())

    if (match) known.add(match[1])
  }

  return known
}

/**
 * Collect footnotes across one document.
 *
 * References are numbered as they are met, so the notes come out in the order a
 * reader runs into them rather than the order they were written.
 *
 * @param {Settings} settings
 * @param {Set<string>} known
 */
export function createFootnotes(settings, known) {
  /** @type {Map<string, Array<import('hast').ElementContent>>} */
  const defined = new Map()
  /** @type {Map<string, {number: number, count: number}>} */
  const counters = new Map()
  /** @type {Array<string>} */
  const order = []

  return {known, define, reference, section}

  /**
   * @param {string} id
   * @param {Array<import('hast').ElementContent>} children
   */
  function define(id, children) {
    defined.set(id, children)
  }

  /**
   * @param {string} id
   * @returns {import('hast').Element | undefined}
   *   Nothing when no definition claims this id, in which case the source stays
   *   the text it always was.
   */
  function reference(id) {
    if (!known.has(id)) return

    let counter = counters.get(id)

    if (!counter) {
      counter = {number: counters.size + 1, count: 0}
      counters.set(id, counter)
      order.push(id)
    }

    counter.count += 1

    return {
      type: 'element',
      tagName: 'sup',
      properties: {},
      children: [
        {
          type: 'element',
          tagName: 'a',
          properties: {
            href: '#' + anchor('fn', id),
            id: anchor('fnref', id, counter.count),
            dataFootnoteRef: true,
            ariaDescribedBy: 'footnote-label'
          },
          children: [{type: 'text', value: String(counter.number)}]
        }
      ]
    }
  }

  /**
   * The list of notes, or nothing when none were pointed at.
   *
   * @returns {import('hast').Element | undefined}
   */
  function section() {
    const items = order
      .filter((id) => defined.has(id))
      .map((id) => item(id, counters.get(id)))

    if (!items.length) return

    return {
      type: 'element',
      tagName: 'section',
      properties: {dataFootnotes: true, className: ['footnotes']},
      children: rows([
        {
          type: 'element',
          tagName: 'h2',
          properties: {className: ['sr-only'], id: 'footnote-label'},
          children: [{type: 'text', value: settings.label}]
        },
        {
          type: 'element',
          tagName: 'ol',
          properties: {},
          children: rows(items)
        }
      ])
    }
  }

  /**
   * @param {string} id
   * @param {{number: number, count: number}} counter
   * @returns {import('hast').Element}
   */
  function item(id, counter) {
    /** @type {Array<import('hast').ElementContent>} */
    const children = [...defined.get(id)]

    // One arrow per place that pointed here, numbered when there is more than
    // one so each has somewhere distinct to go back to.
    for (let count = 1; count <= counter.count; count++) {
      children.push({type: 'text', value: ' '}, backref(id, counter, count))
    }

    return {
      type: 'element',
      tagName: 'li',
      properties: {id: anchor('fn', id)},
      children: rows([
        {type: 'element', tagName: 'p', properties: {}, children}
      ])
    }
  }

  /**
   * @param {string} id
   * @param {{count: number}} counter
   * @param {number} count
   * @returns {import('hast').Element}
   */
  function backref(id, counter, count) {
    /** @type {Array<import('hast').ElementContent>} */
    const children = [{type: 'text', value: '↩'}]

    if (counter.count > 1) {
      children.push({
        type: 'element',
        tagName: 'sup',
        properties: {},
        children: [{type: 'text', value: String(count)}]
      })
    }

    return {
      type: 'element',
      tagName: 'a',
      properties: {
        href: '#' + anchor('fnref', id, count),
        dataFootnoteBackref: true,
        ariaLabel: settings.backLabel,
        className: ['data-footnote-backref']
      },
      children
    }
  }

  /**
   * Build an `id`, keeping it to characters that behave in one.
   *
   * @param {string} kind
   * @param {string} id
   * @param {number} [count]
   * @returns {string}
   */
  function anchor(kind, id, count) {
    const safe = id.replace(/[^\w-]+/g, '-')

    return (
      settings.prefix + kind + '-' + safe + (count && count > 1 ? '-' + count : '')
    )
  }
}

/**
 * Put each child on its own line, matching how the rest of MDY lays out block
 * children.
 *
 * @param {Array<import('hast').ElementContent>} children
 * @returns {Array<import('hast').ElementContent>}
 */
function rows(children) {
  /** @type {Array<import('hast').ElementContent>} */
  const result = [{type: 'text', value: '\n'}]

  for (const child of children) {
    result.push(child, {type: 'text', value: '\n'})
  }

  return result
}
