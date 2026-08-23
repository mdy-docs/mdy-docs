/**
 * @typedef {string | RegExp} AttributeRule
 *   An attribute name, or a pattern matching a family of them.
 *
 * @typedef Schema
 * @property {Array<string>} tagNames
 *   Elements an author may open. Anything else becomes a `<div>`.
 * @property {Array<string>} strip
 *   Elements removed outright, along with everything indented under them.
 * @property {Record<string, Array<AttributeRule>>} attributes
 *   Allowed attributes, per tag name; `*` applies to every element.
 * @property {Record<string, Array<string>>} protocols
 *   Allowed URL protocols, per attribute name. An attribute listed here may
 *   only carry a relative URL or one of these protocols.
 */

/**
 * What an author is allowed to write in an element opener.
 *
 * Nothing here can run script: there are no event handlers, no `<script>`, no
 * `<iframe>`, and no `javascript:` URLs. `style` *is* allowed, because posing
 * as a layout language is the point of the rule; it can restyle the page but
 * not act on it.
 *
 * @type {Schema}
 */
export const defaultSchema = {
  tagNames: [
    // Sections and grouping.
    'address', 'article', 'aside', 'blockquote', 'br', 'details', 'div',
    'figcaption', 'figure', 'footer', 'header', 'hgroup', 'hr', 'main', 'nav',
    'p', 'pre', 'section', 'summary', 'wbr',
    // Headings.
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // Lists.
    'dd', 'dl', 'dt', 'li', 'ol', 'ul',
    // Tables.
    'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th',
    'thead', 'tr',
    // Phrasing.
    'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'del', 'em',
    'i', 'ins', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small',
    'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
    // Media.
    'img', 'picture'
  ],
  strip: [
    'applet', 'base', 'body', 'canvas', 'embed', 'frame', 'frameset', 'head',
    'html', 'iframe', 'link', 'math', 'meta', 'noscript', 'object', 'portal',
    'script', 'style', 'svg', 'template', 'title'
  ],
  attributes: {
    '*': [
      'class', 'dir', 'hidden', 'id', 'lang', 'role', 'style', 'title',
      'translate', /^aria-[a-z-]+$/, /^data-[\w-]+$/
    ],
    a: ['href', 'name', 'rel', 'target'],
    blockquote: ['cite'],
    col: ['align', 'span', 'width'],
    colgroup: ['align', 'span', 'width'],
    data: ['value'],
    del: ['cite', 'datetime'],
    details: ['open'],
    img: ['alt', 'decoding', 'height', 'loading', 'src', 'width'],
    ins: ['cite', 'datetime'],
    li: ['value'],
    ol: ['reversed', 'start', 'type'],
    q: ['cite'],
    table: ['align', 'summary'],
    tbody: ['align'],
    td: ['align', 'colspan', 'headers', 'rowspan', 'valign'],
    tfoot: ['align'],
    th: ['abbr', 'align', 'colspan', 'headers', 'rowspan', 'scope', 'valign'],
    thead: ['align'],
    time: ['datetime'],
    tr: ['align']
  },
  protocols: {
    cite: ['http', 'https'],
    href: [
      'ftp', 'http', 'https', 'irc', 'ircs', 'mailto', 'sms', 'tel', 'xmpp'
    ],
    src: ['http', 'https']
  }
}

/**
 * Resolve the `sanitize` option into a schema, or nothing when it is off.
 *
 * A partial schema fills its gaps from the default, so narrowing one part does
 * not silently open up the rest.
 *
 * @param {boolean | Partial<Schema> | undefined} sanitize
 * @returns {Schema | undefined}
 */
export function normalizeSchema(sanitize) {
  if (sanitize === false) return
  if (sanitize === undefined || sanitize === true) return defaultSchema

  return {
    tagNames: sanitize.tagNames ?? defaultSchema.tagNames,
    strip: sanitize.strip ?? defaultSchema.strip,
    attributes: sanitize.attributes ?? defaultSchema.attributes,
    protocols: sanitize.protocols ?? defaultSchema.protocols
  }
}

/**
 * @typedef Result
 * @property {string} tagName
 *   Element to build, which is `div` when the one asked for is not allowed.
 * @property {Array<import('./html.js').Attribute>} attributes
 *   The attributes that survived.
 * @property {boolean} strip
 *   Whether the element and its content should be dropped entirely.
 * @property {Array<string>} messages
 *   One line per thing that was removed, for reporting on the file.
 */

/**
 * Check an element opener against a schema.
 *
 * @param {import('./html.js').Opener} opener
 * @param {Schema} schema
 * @returns {Result}
 */
export function sanitizeOpener(opener, schema) {
  /** @type {Array<string>} */
  const messages = []

  if (schema.strip.includes(opener.tagName)) {
    return {
      tagName: opener.tagName,
      attributes: [],
      strip: true,
      messages: [
        '`<' + opener.tagName + '>` is not allowed, dropping it and its content'
      ]
    }
  }

  let tagName = opener.tagName

  if (!schema.tagNames.includes(tagName)) {
    messages.push('`<' + tagName + '>` is not allowed, using `<div>` instead')
    tagName = 'div'
  }

  const allowed = [
    ...(schema.attributes['*'] ?? []),
    ...(schema.attributes[opener.tagName] ?? [])
  ]
  /** @type {Array<import('./html.js').Attribute>} */
  const attributes = []

  for (const attribute of opener.attributes) {
    const name = attribute.name.toLowerCase()

    if (!allowed.some((rule) => matches(rule, name))) {
      messages.push(
        '`' + name + '` is not allowed on `<' + opener.tagName + '>`, dropping it'
      )
      continue
    }

    if (
      schema.protocols[name] &&
      attribute.value !== undefined &&
      !allowedProtocol(attribute.value, schema.protocols[name])
    ) {
      messages.push(
        '`' + name + '` points at a protocol that is not allowed, dropping it'
      )
      continue
    }

    attributes.push({name, value: attribute.value})
  }

  return {tagName, attributes, strip: false, messages}
}

/**
 * @param {AttributeRule} rule
 * @param {string} name
 * @returns {boolean}
 */
function matches(rule, name) {
  return typeof rule === 'string' ? rule === name : rule.test(name)
}

/**
 * Whether a URL is relative, or uses one of the allowed protocols.
 *
 * Whitespace and control characters are dropped first: browsers ignore them
 * when resolving a URL, so a tab wedged into `javascript:` would otherwise
 * slip past.
 *
 * @param {string} value
 * @param {Array<string>} protocols
 * @returns {boolean}
 */
export function allowedProtocol(value, protocols) {
  const url = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)

      return code > 32 && code !== 127
    })
    .join('')
  const colon = url.indexOf(':')

  if (colon === -1) return true

  // A `:` after any of these is inside a path, query or fragment, which makes
  // the URL relative rather than absolute.
  for (const character of ['/', '?', '#']) {
    const index = url.indexOf(character)

    if (index !== -1 && index < colon) return true
  }

  return protocols.includes(url.slice(0, colon).toLowerCase())
}
