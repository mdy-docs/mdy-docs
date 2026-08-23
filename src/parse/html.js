import {find, html} from 'property-information'

const tagName = /^[A-Za-z][A-Za-z0-9-]*/
const attributeName = /^[A-Za-z_:][A-Za-z0-9._:-]*/
const unquoted = /^[^\s>]*/

/**
 * @typedef Attribute
 * @property {string} name
 *   Attribute name, as written.
 * @property {string | undefined} value
 *   Its value, or nothing when it was written bare.
 *
 * @typedef Opener
 * @property {string} tagName
 *   Element to create; `div` when the line names none.
 * @property {Array<Attribute>} attributes
 *   Attributes in source order, under the names they were written with.
 * @property {string} text
 *   Anything written after the closing `>`, treated as inline content.
 */

/**
 * Read an element opener off a line.
 *
 * The whole line is the opener: `<`, `<table`, or
 * `<table class="grid" style="border: 1px solid red;"`. The closing `>` is
 * optional, and anything after it is content.
 *
 * Space after the `<` means nothing, the same as space between the attributes
 * further along: `< table` names the element `<table` does. A `<` with only
 * space behind it is still the bare `<div>` it always was.
 *
 * @param {string} value
 * @returns {Opener | undefined}
 */
export function parseHtmlLine(value) {
  if (!value.startsWith('<')) return

  const start = skipSpace(value, 1)
  const tag = tagName.exec(value.slice(start))
  /** @type {Array<Attribute>} */
  const attributes = []
  let index = start + (tag ? tag[0].length : 0)
  let text = ''

  while (index < value.length) {
    const character = value.charAt(index)

    if (character === ' ' || character === '\t') {
      index += 1
      continue
    }

    if (character === '>') {
      text = value.slice(index + 1).trim()
      break
    }

    if (character === '/' && value.charAt(index + 1) === '>') {
      text = value.slice(index + 2).trim()
      break
    }

    const name = attributeName.exec(value.slice(index))

    // Not something that can be an attribute name: step over it rather than
    // spinning, and carry on looking for ones that are.
    if (!name) {
      index += 1
      continue
    }

    index += name[0].length
    index = skipSpace(value, index)

    /** @type {string | undefined} */
    let raw

    if (value.charAt(index) === '=') {
      index = skipSpace(value, index + 1)
      const quote = value.charAt(index)

      if (quote === '"' || quote === "'") {
        const close = value.indexOf(quote, index + 1)

        // An unterminated quote runs to the end of the line, which is what a
        // half-typed attribute looks like while the editor is being typed in.
        raw = value.slice(index + 1, close === -1 ? undefined : close)
        index = close === -1 ? value.length : close + 1
      } else {
        raw = unquoted.exec(value.slice(index))[0]
        index += raw.length
      }
    }

    attributes.push({name: name[0], value: raw})
  }

  return {tagName: tag ? tag[0].toLowerCase() : 'div', attributes, text}
}

/**
 * @param {string} value
 * @param {number} index
 * @returns {number}
 */
function skipSpace(value, index) {
  while (value.charAt(index) === ' ' || value.charAt(index) === '\t') index += 1

  return index
}

/**
 * Turn attributes into hast properties, splitting the values that hast models
 * as lists and mapping names onto their property equivalents, so `class`
 * becomes `className` and `for` becomes `htmlFor`.
 *
 * @param {Array<Attribute>} attributes
 * @returns {import('hast').Properties}
 */
export function toProperties(attributes) {
  /** @type {import('hast').Properties} */
  const properties = {}

  for (const {name, value} of attributes) {
    const info = find(html, name)

    if (value === undefined) {
      properties[info.property] = true
    } else if (info.spaceSeparated) {
      properties[info.property] = value.split(/\s+/).filter(Boolean)
    } else if (info.commaSeparated) {
      properties[info.property] = value.split(/,\s*/)
    } else {
      properties[info.property] = value
    }
  }

  return properties
}
