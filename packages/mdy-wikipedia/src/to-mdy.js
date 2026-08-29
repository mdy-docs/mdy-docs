/**
 * hast → MDY: the inverse of `fromMdy`.
 *
 * mdy has a front end and no back end. This is the back end, and it is the
 * general HTML → MDY importer rather than anything Wikipedia knows about —
 * the Wikipedia parts of this package hand it a cleaned tree and it writes a
 * document. It lives here until a second importer wants it, at which point it
 * belongs in mdy-docs proper.
 *
 * Two properties shape every decision below.
 *
 * **It writes what the grammar can say, and says so when it cannot.** MDY has
 * no inline element syntax: rule 5 openers are lines, so a `<span class="x">`
 * in the middle of a sentence has no spelling. Rather than invent one, the
 * span is unwrapped to its content and a message goes on the file. The same
 * goes for an `<em>` inside an `<em>` (markers toggle, so the inner one would
 * close the outer) and for a `` `` `` span containing a double backtick.
 * Everything dropped is reported; nothing is dropped silently.
 *
 * **A construct is written in its own spelling only when that spelling parses
 * back to it.** A heading gets `==` when the id the parser would give it is
 * the id it has, and `<h2 id="…"` when it is not. A table gets pipes when its
 * cells hold nothing a pipe table cannot hold, and `<table` when they do not.
 * That is what makes `toMdy(fromMdy(source))` a test rather than a hope.
 */

import {html as htmlInfo} from 'property-information'
import {defaultMarkers, normalizeMarkers} from 'mdy-docs/parse/markers.js'
import {defaultResolve, normalizeWikiLink} from 'mdy-docs/parse/wiki.js'
import {matchReference, normalizeReference} from 'mdy-docs/parse/reference.js'
import {findLinks} from 'mdy-docs/parse/link.js'
import {toText} from 'mdy-docs/parse/script.js'
import {stringify as stringifyYaml} from 'yaml'
import {escapeInline, escapeLineStart} from './escape.js'

// Elements the parser reads as text and never as markup (block.js's own set).
const rawText = new Set(['pre', 'script', 'style', 'textarea', 'title'])
const headings = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const voidElements = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
])
const step = '  '

/**
 * Serialise a hast tree as MDY source.
 *
 * @param {import('hast').Root | import('hast').Element} tree
 * @param {object} [options]
 *   Parse options, so the serialiser writes what *this* document will be read
 *   with — a marker table passed here is the one escaped for — plus:
 *   `frontmatter` (write `tree.data.matter` as a `+++` block, on by default),
 *   `wrap` (column to wrap paragraphs at, off by default), and `file` (a vfile
 *   to put messages on).
 * @returns {string}
 */
export function toMdy(tree, options = {}) {
  const context = {
    options,
    markers: markerTable(options),
    wiki: normalizeWikiLink(options.wikiLink),
    references: {
      tag: normalizeReference(options.tags, '/tags/'),
      mention: normalizeReference(options.mentions, '/users/')
    },
    headingIds: options.headingId === false ? undefined : headingState(options),
    wrap: Number(options.wrap) || 0,
    // Whether the document will be compiled as a template. It changes what a
    // *raw* span and a fence have to escape: nothing is raw to the script
    // stage, so `{{` and a leading `%` mean something in a code block too.
    // Off by default, because with script off those escapes would show.
    script: options.script === true,
    file: options.file
  }

  const lines = blocks(children(tree), context)
  const notes = tree.data?.footnotes ?? []

  for (const note of notes) {
    const text = inline(note.children ?? [], context).trim()

    if (!text) continue

    if (lines.length) lines.push('')

    // One line each: a definition may run on over indented lines, but a note
    // that fits on one is a note nobody has to count columns to read.
    lines.push(escapeLineStart('[[ ^' + noteId(note.id) + ' ]]: ' + text))
  }

  const body = lines.join('\n')
  const matter =
    options.frontmatter === false ? undefined : tree.data?.matter

  if (!matter || !Object.keys(matter).length) return body ? body + '\n' : ''

  const yaml = stringifyYaml(matter).trimEnd()

  return '+++\n' + yaml + '\n+++\n' + (body ? body + '\n' : '')
}

/* ------------------------------------------------------------------ blocks */

/**
 * Serialise a run of block-level content into lines, with a blank line
 * between each block.
 *
 * @param {Array<import('hast').RootContent>} nodes
 * @param {object} context
 * @returns {Array<string>}
 */
function blocks(nodes, context) {
  /** @type {Array<string>} */
  const lines = []

  for (const chunk of chunks(nodes, context)) {
    if (lines.length) lines.push('')
    lines.push(...chunk)
  }

  return lines
}

/**
 * One array of lines per block. Whitespace-only text between blocks is the
 * layout `pad()` put there and carries nothing, so it goes; text with words in
 * it at block level is a paragraph that lost its `<p>`, so it stays.
 *
 * @param {Array<import('hast').RootContent>} nodes
 * @param {object} context
 * @returns {Array<Array<string>>}
 */
function chunks(nodes, context) {
  /** @type {Array<Array<string>>} */
  const out = []
  /** @type {Array<import('hast').ElementContent>} */
  let run = []

  const flush = () => {
    if (!run.length) return

    // Phrasing elements standing on their own at block level are elements, not
    // a paragraph: `<em>…` on its own line is an `<em>` beside its siblings
    // (rule 5), and wrapping it in a `<p>` on the way out would invent one.
    // A run with words in it is a paragraph, which is what it looks like.
    if (run.every((node) => node.type === 'element')) {
      for (const node of run) out.push(element(node, context))
      run = []
      return
    }

    const text = paragraph(run, context)

    if (text.length) out.push(text)
    run = []
  }

  for (const node of nodes) {
    if (node.type === 'text' && !node.value.trim()) continue

    if (node.type === 'comment') {
      flush()
      // Rule 13: a comment is a whole line and leaves nothing behind.
      out.push(node.value.split('\n').map((line) => '# ' + line.trim()))
      continue
    }

    if (node.type === 'doctype') {
      flush()
      out.push(['<!doctype html>'])
      continue
    }

    if (node.type === 'element' && !phrasing(node)) {
      flush()
      out.push(block(node, context))
      continue
    }

    run.push(node)
  }

  flush()

  return out
}

/**
 * @param {import('hast').Element} node
 * @param {object} context
 * @returns {Array<string>}
 */
function block(node, context) {
  const {tagName} = node

  // A paragraph is the one block with no spelling of its own — it is what a
  // run of lines *is* — so one carrying attributes has to be written out.
  if (tagName === 'p') {
    return Object.keys(node.properties ?? {}).length
      ? element(node, context)
      : paragraph(node.children, context)
  }
  if (tagName === 'hr') return breakLine(node, context)
  if (headings.has(tagName)) return heading(node, context)
  if (tagName === 'pre') return fence(node, context) ?? element(node, context)
  if (tagName === 'ul' || tagName === 'ol') {
    return list(node, context, '') ?? element(node, context)
  }
  if (tagName === 'table') return table(node, context) ?? element(node, context)

  return element(node, context)
}

/**
 * `***`, never `---`: three dashes is the document separator (rule 11), and a
 * break that changes meaning with an option is not one worth writing.
 *
 * @param {import('hast').Element} node
 * @param {object} context
 * @returns {Array<string>}
 */
function breakLine(node, context) {
  if (Object.keys(node.properties ?? {}).length) return element(node, context)

  return ['***']
}

/**
 * @param {Array<import('hast').ElementContent>} nodes
 * @param {object} context
 * @returns {Array<string>}
 */
function paragraph(nodes, context) {
  const text = inline(nodes, context).trim()

  if (!text) return []

  return wrapLines(text, context).map(escapeLineStart)
}

/**
 * A heading in its own spelling when that spelling parses back to it.
 *
 * The parser gives every `=` heading an id slugified from its text (rule 1),
 * so a heading whose id says something else — or which has none, having been
 * written as an element in the first place — has to stay an element, or the
 * round trip would quietly rename it.
 *
 * @param {import('hast').Element} node
 * @param {object} context
 * @returns {Array<string>}
 */
function heading(node, context) {
  const depth = Number(node.tagName.slice(1))
  const properties = node.properties ?? {}
  const keys = Object.keys(properties)
  const content = inline(node.children, context).trim()

  if (keys.length && (keys.length > 1 || keys[0] !== 'id')) {
    return element(node, context)
  }

  const expected = context.headingIds?.peek(toText(node))

  if (properties.id !== expected) return element(node, context)

  context.headingIds?.take(toText(node))

  // `=` decorates, so a heading ending in one would lose it to the trailing-`=`
  // rule; the element form says it without ambiguity.
  if (content.endsWith('=')) return element(node, context)

  return ['='.repeat(depth) + (content ? ' ' + content : '')]
}

/**
 * A `<pre>` holding one `<code>` is a fence (rule 4). Anything else in a
 * `<pre>` is not something a fence can hold, and falls back to an element.
 *
 * @param {import('hast').Element} node
 * @param {object} context
 * @returns {Array<string> | undefined}
 */
function fence(node, context) {
  const kids = node.children.filter(
    (child) => child.type !== 'text' || child.value.trim()
  )

  if (kids.length !== 1) return
  if (kids[0].type !== 'element' || kids[0].tagName !== 'code') return
  if (Object.keys(node.properties ?? {}).length) return

  const code = kids[0]
  const classes = code.properties?.className ?? []
  const other = Object.keys(code.properties ?? {}).filter(
    (key) => key !== 'className'
  )

  if (other.length) return

  // `language-x` names the language; `hljs` is the highlighter's own mark and
  // comes back on its own when the fence is read again.
  const language = classes
    .filter((name) => name.startsWith('language-'))
    .map((name) => name.slice('language-'.length))
  const rest = classes.filter(
    (name) => !name.startsWith('language-') && name !== 'hljs'
  )

  if (rest.length || language.length > 1) return

  const value = toText(code)
  const body = value.endsWith('\n') ? value.slice(0, -1) : value
  // Longer than the longest run inside, so the block holds whatever it holds.
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length))
  const marker = '`'.repeat(longest + 1)

  const lines = value ? body.split('\n').map((line) => escapeRaw(line, context)) : []

  return [marker + (language[0] ?? ''), ...lines, marker]
}

/**
 * A list, when every item holds something a list item can hold.
 *
 * @param {import('hast').Element} node
 * @param {object} context
 * @param {string} indent
 * @returns {Array<string> | undefined}
 */
function list(node, context, indent) {
  const ordered = node.tagName === 'ol'
  const properties = node.properties ?? {}
  const classes = properties.className ?? []
  const start = properties.start
  const extra = Object.keys(properties).filter(
    (key) => key !== 'className' && key !== 'start'
  )

  if (extra.length) return
  if (classes.some((name) => name !== 'contains-task-list')) return
  if (start !== undefined && (typeof start !== 'number' || start < 1)) return

  /** @type {Array<string>} */
  const lines = []
  let number = typeof start === 'number' ? start : 1

  for (const item of node.children) {
    if (item.type === 'text' && !item.value.trim()) continue
    if (item.type !== 'element' || item.tagName !== 'li') return

    const rendered = listItem(item, context, indent, ordered, number)

    if (!rendered) return

    lines.push(...rendered)
    number += 1
  }

  return lines.length ? lines : undefined
}

/**
 * @param {import('hast').Element} item
 * @param {object} context
 * @param {string} indent
 * @param {boolean} ordered
 * @param {number} number
 * @returns {Array<string> | undefined}
 */
function listItem(item, context, indent, ordered, number) {
  const classes = item.properties?.className ?? []
  const extra = Object.keys(item.properties ?? {}).filter(
    (key) => key !== 'className'
  )

  if (extra.length) return
  if (classes.some((name) => name !== 'task-list-item')) return

  /** @type {Array<import('hast').ElementContent>} */
  const content = []
  /** @type {Array<import('hast').Element>} */
  const nested = []
  let box = ''
  let loose

  for (const child of item.children) {
    if (child.type === 'text' && !child.value.trim()) continue

    if (child.type === 'element' && (child.tagName === 'ul' || child.tagName === 'ol')) {
      nested.push(child)
      continue
    }

    // Nesting a list under a paragraph is more than the marker can say.
    if (nested.length) return

    if (child.type === 'element' && child.tagName === 'input') {
      const properties = child.properties ?? {}

      if (
        properties.type !== 'checkbox' ||
        properties.disabled !== true ||
        Object.keys(properties).length !== 3
      ) {
        return
      }

      box = properties.checked ? '[x] ' : '[ ] '
      continue
    }

    if (child.type === 'element' && child.tagName === 'p' && !loose && !content.length) {
      loose = true
      content.push(...child.children)
      continue
    }

    if (!phrasing(child)) return

    content.push(child)
  }

  const marker = indent + (ordered ? number + '.' : '-')
  const text = inline(content, context).trim()
  const head = marker + (box || text ? ' ' + box + text : '')
  /** @type {Array<string>} */
  const lines = [head]

  for (const child of nested) {
    const rendered = list(child, context, indent + step)

    if (!rendered) return

    lines.push(...rendered)
  }

  return lines
}

/**
 * A pipe table (rule 7), when the shape is one pipes can describe: an optional
 * caption, one header row, and body rows whose cells hold phrasing content.
 *
 * @param {import('hast').Element} node
 * @param {object} context
 * @returns {Array<string> | undefined}
 */
function table(node, context) {
  if (Object.keys(node.properties ?? {}).length) return

  /** @type {import('hast').Element | undefined} */
  let caption
  /** @type {Array<import('hast').Element>} */
  let head = []
  /** @type {Array<import('hast').Element>} */
  let body = []

  for (const child of node.children) {
    if (child.type === 'text' && !child.value.trim()) continue
    if (child.type !== 'element') return

    if (child.tagName === 'caption' && !caption && !head.length) {
      caption = child
      continue
    }

    if (child.tagName === 'thead' && !head.length) {
      head = rows(child)
      if (!head) return
      continue
    }

    if (child.tagName === 'tbody' && !body.length) {
      body = rows(child)
      if (!body) return
      continue
    }

    return
  }

  if (head?.length !== 1) return

  const header = cells(head[0], 'th', context)

  if (!header) return

  /** @type {Array<Array<string>>} */
  const rest = []

  for (const row of body ?? []) {
    const line = cells(row, 'td', context)

    if (!line || line.cells.length !== header.cells.length) return

    rest.push(line.cells)
  }

  const delimiter = header.aligns.map((align) =>
    align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---'
  )
  /** @type {Array<string>} */
  const lines = []

  // A caption is one cell on the line above (rule 7), which is exactly how a
  // one-column header is written — what tells them apart is the table under it.
  if (caption) {
    lines.push('| ' + cellText(caption.children, context))
  }

  lines.push(row(header.cells), row(delimiter))

  for (const line of rest) lines.push(row(line))

  return lines
}

/**
 * @param {import('hast').Element} node
 * @returns {Array<import('hast').Element> | undefined}
 */
function rows(node) {
  if (Object.keys(node.properties ?? {}).length) return

  /** @type {Array<import('hast').Element>} */
  const out = []

  for (const child of node.children) {
    if (child.type === 'text' && !child.value.trim()) continue
    if (child.type !== 'element' || child.tagName !== 'tr') return
    if (Object.keys(child.properties ?? {}).length) return

    out.push(child)
  }

  return out
}

/**
 * @param {import('hast').Element} node
 * @param {'th' | 'td'} tagName
 * @param {object} context
 * @returns {{cells: Array<string>, aligns: Array<string | undefined>} | undefined}
 */
function cells(node, tagName, context) {
  /** @type {Array<string>} */
  const out = []
  /** @type {Array<string | undefined>} */
  const aligns = []

  for (const child of node.children) {
    if (child.type === 'text' && !child.value.trim()) continue
    if (child.type !== 'element' || child.tagName !== tagName) return

    const align = alignment(child.properties ?? {})

    if (align === false) return
    // A cell is one line of the source, so it can hold only what fits on one.
    // A `<br>` or a list inside it is why the whole table gets written out as
    // elements instead — Wikipedia's king lists are full of both.
    if (!child.children.every(inlineOnly)) return

    aligns.push(align)
    out.push(cellText(child.children, context))
  }

  return {cells: out, aligns}
}

/**
 * Whether a node and everything under it can sit on one line.
 *
 * @param {import('hast').ElementContent} node
 * @returns {boolean}
 */
function inlineOnly(node) {
  if (node.type === 'text') return true
  if (node.type !== 'element') return false

  return phrasing(node) && node.children.every(inlineOnly)
}

/**
 * The alignment a cell carries, in either spelling the parser emits; `false`
 * when it carries something else, which a pipe table cannot say.
 *
 * @param {import('hast').Properties} properties
 * @returns {string | undefined | false}
 */
function alignment(properties) {
  const keys = Object.keys(properties)

  if (!keys.length) return undefined
  if (keys.length > 1) return false

  if (keys[0] === 'align') {
    return ['left', 'center', 'right'].includes(properties.align)
      ? properties.align
      : false
  }

  if (keys[0] === 'style') {
    const match = /^text-align:\s*(left|center|right)$/.exec(String(properties.style))

    return match ? match[1] : false
  }

  return false
}

/**
 * Cell content, with every pipe escaped — including the one in
 * `[[ label | url ]]`, which `unescapePipes` puts back before the cell is read
 * as inline content.
 *
 * @param {Array<import('hast').ElementContent>} nodes
 * @param {object} context
 * @returns {string}
 */
function cellText(nodes, context) {
  return inline(nodes, context).trim().replaceAll('|', '\\|')
}

/**
 * @param {Array<string>} values
 * @returns {string}
 */
function row(values) {
  return '| ' + values.join(' | ') + ' |'
}

/**
 * An element in rule 5's spelling: the opener on its own line, its content
 * indented under it.
 *
 * Content that is only inline goes on the opener line, because that is the
 * form the parser reads back as inline children with no line breaks between
 * them. Block content is indented, which is the form that reads back as the
 * `\n`-padded children it came from.
 *
 * @param {import('hast').Element} node
 * @param {object} context
 * @returns {Array<string>}
 */
function element(node, context) {
  const opener = '<' + node.tagName + attributes(node.properties ?? {})

  if (voidElements.has(node.tagName)) {
    if (node.children.length) {
      warn(context, '`<' + node.tagName + '>` cannot have content, dropping it')
    }

    return [opener]
  }

  if (rawText.has(node.tagName)) {
    const value = toText(node)

    return value ? [opener, ...value.split('\n').map((line) => step + line)] : [opener]
  }

  /** @type {Array<import('hast').ElementContent>} */
  const lead = []
  let index = 0

  while (index < node.children.length) {
    const child = node.children[index]

    if (child.type === 'text' && !child.value.trim() && !lead.length) break
    if (child.type === 'element' && !phrasing(child)) break
    if (child.type === 'comment' || child.type === 'doctype') break

    lead.push(child)
    index += 1
  }

  const text = inline(lead, context).trim()
  const rest = blocks(node.children.slice(index), context)

  return [
    opener + (text ? '>' + text : ''),
    ...rest.map((line) => (line ? step + line : ''))
  ]
}

/**
 * hast properties back into attributes, under the names they were written
 * with: `className` is `class` again, `htmlFor` is `for`.
 *
 * @param {import('hast').Properties} properties
 * @returns {string}
 */
function attributes(properties) {
  let out = ''

  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null || value === false) continue

    const info = htmlInfo.property[key]
    const name = info?.attribute ?? key

    if (value === true) {
      out += ' ' + name
      continue
    }

    const written = Array.isArray(value)
      ? value.join(info?.commaSeparated ? ', ' : ' ')
      : String(value)

    out += ' ' + name + '="' + written.replaceAll('"', '&quot;') + '"'
  }

  return out
}

/* ------------------------------------------------------------------ inline */

/**
 * @param {Array<import('hast').ElementContent>} nodes
 * @param {object} context
 * @param {Array<string>} [open]
 *   Marker sequences already open around this run, so a nested toggle of the
 *   same marker can be spotted rather than silently closing its parent.
 * @returns {string}
 */
function inline(nodes, context, open = []) {
  let out = ''

  for (const node of nodes) {
    if (node.type === 'text') {
      out += escapeInline(node.value, context.options)
      continue
    }

    if (node.type === 'comment') {
      warn(context, 'A comment inside a line has no spelling, dropping it')
      continue
    }

    if (node.type !== 'element') continue

    out += phrase(node, context, open)
  }

  return out
}

/**
 * @param {import('hast').Element} node
 * @param {object} context
 * @param {Array<string>} open
 * @returns {string}
 */
function phrase(node, context, open) {
  // A footnote reference is the one construct with no shape of its own in
  // hast: mdy *generates* the `<sup><a>` for it, so recognising that output
  // would be recognising an implementation. A node says it is one instead, and
  // the tree carries the notes — see `footnotes` in the options.
  const marked = node.data?.footnote

  if (marked !== undefined) return '[[ ^' + noteId(marked) + ' ]]'

  const properties = node.properties ?? {}
  const marker = Object.keys(properties).length
    ? undefined
    : context.markers.find((entry) => entry.tagName === node.tagName)

  if (marker && !open.includes(marker.sequence)) {
    if (marker.raw) {
      const value = toText(node)

      if (value.includes(marker.sequence)) {
        warn(
          context,
          'A raw `' + marker.sequence + '` span cannot hold `' +
            marker.sequence + '`, writing it as text'
        )

        return escapeInline(value, context.options)
      }

      return marker.sequence + escapeRaw(value, context) + marker.sequence
    }

    return (
      marker.sequence +
      inline(node.children, context, [...open, marker.sequence]) +
      marker.sequence
    )
  }

  if (marker) {
    warn(
      context,
      '`<' + node.tagName + '>` inside another one cannot be written with ' +
        'toggling markers, unwrapping it'
    )

    return inline(node.children, context, open)
  }

  if (node.tagName === 'a') return anchor(node, context, open)

  if (node.tagName === 'br') {
    warn(context, '`<br>` inside a line has no spelling, dropping it')

    return ''
  }

  warn(
    context,
    '`<' + node.tagName + '>` inside a line has no spelling, unwrapping it'
  )

  return inline(node.children, context, open)
}

/**
 * A link in the shortest spelling that reads back as itself: a bare URL, a
 * `#tag` or `@user`, `[[ label ]]`, or `[[ label | url ]]`.
 *
 * @param {import('hast').Element} node
 * @param {object} context
 * @param {Array<string>} open
 * @returns {string}
 */
function anchor(node, context, open) {
  const properties = node.properties ?? {}
  const keys = Object.keys(properties)
  const href = properties.href
  const text = toText(node)

  if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'href')) {
    warn(context, 'A link with attributes has no inline spelling, unwrapping it')

    return inline(node.children, context, open)
  }

  // A bare URL, when the linkifier would find exactly this link in exactly
  // this text (rule 9).
  if (typeof href === 'string' && text === href) {
    const found = findLinks(text)

    if (found.length === 1 && found[0].index === 0 && found[0].end === text.length) {
      if (found[0].url === href) return text
    }
  }

  // `#tag` and `@user`, which write themselves — asked of the same matcher the
  // parser asks, so where a tag points is settled in one place.
  if (text.startsWith('#') || text.startsWith('@')) {
    const found = matchReference(text, 0, context.references)

    if (found && found.length === text.length && found.href === href) return text
  }

  const label = inline(node.children, context, open)
    .replaceAll(']', '\\]')
    .replaceAll('|', '\\|')

  // A link with nothing in it. Wikipedia's `[1]`-style external links are
  // exactly this — the number is drawn by a stylesheet, so the anchor really is
  // empty — and the URL is the whole of what they say. Written bare, it is
  // both the label and the link.
  if (!label.trim()) {
    if (typeof href === 'string' && /^(https?:)?\/\//.test(href)) {
      return escapeInline(href, context.options) === href ? href : '[[ ' + href + ' | ' + href + ' ]]'
    }

    warn(context, 'A link with no label has no spelling, dropping it')

    return ''
  }

  if (href === undefined) return '[[ ' + label + ' ]]'
  if (typeof href !== 'string') return '[[ ' + label + ' ]]'

  // Without a `|`, the label is slugified into the href — so the short form is
  // only right when that lands on the href this link already has.
  if (context.wiki && pageHref(context.wiki.resolve(text)) === href) {
    return '[[ ' + label + ' ]]'
  }

  return '[[ ' + label + ' | ' + href + ' ]]'
}

/**
 * What the parser does to an `href` on the way in: a link to a page of our own
 * is lower cased with its spaces as dashes, and anything else is left alone.
 *
 * @param {string} href
 * @returns {string}
 */
function pageHref(href) {
  if (!href) return href
  if (href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return href
  }

  return href.toLowerCase().replace(/\s+/g, '-')
}

/* ------------------------------------------------------------------- parts */

/**
 * Wrap a paragraph, or leave it on one line.
 *
 * Lines of a paragraph are joined with a space when read back (rule 3), so
 * breaking on single spaces is exact. Every line is checked against the block
 * grammar afterwards, because wrapping is what *makes* new line starts.
 *
 * @param {string} text
 * @param {object} context
 * @returns {Array<string>}
 */
function wrapLines(text, context) {
  if (!context.wrap) return [text]

  /** @type {Array<string>} */
  const lines = []
  let line = ''

  for (const word of atoms(text)) {
    if (!line) {
      line = word
      continue
    }

    if (line.length + 1 + word.length > context.wrap) {
      lines.push(line)
      line = word
      continue
    }

    line += ' ' + word
  }

  if (line) lines.push(line)

  return lines
}

/**
 * Break a line into the pieces a wrap may fall between.
 *
 * Spaces, except the ones inside `[[ label | url ]]`, where a break would be
 * legal — lines are rejoined with a space (rule 3) — but would leave the URL
 * of a link split across two lines of source for somebody to read.
 *
 * @param {string} text
 * @returns {Array<string>}
 */
function atoms(text) {
  /** @type {Array<string>} */
  const out = []
  let index = 0
  let word = ''

  while (index < text.length) {
    if (text.startsWith('[[', index)) {
      const close = text.indexOf(']]', index)

      if (close !== -1) {
        word += text.slice(index, close + 2)
        index = close + 2
        continue
      }
    }

    if (text.charAt(index) === ' ') {
      if (word) out.push(word)
      word = ''
      index += 1
      continue
    }

    word += text.charAt(index)
    index += 1
  }

  if (word) out.push(word)

  return out
}

/**
 * Whether a node can sit inside a line.
 *
 * Block-level elements have their own lines, and so do the void ones — an
 * `<img>` is phrasing in HTML, but MDY writes elements as openers and an
 * opener is a line, so an image in the middle of a sentence gets its own.
 * That is a change of shape, and it is the only one available: the
 * alternative is dropping the image, since it has no children to unwrap to.
 *
 * @param {import('hast').ElementContent} node
 * @returns {boolean}
 */
function phrasing(node) {
  if (node.type === 'text') return true
  if (node.type !== 'element') return false

  return !blockLevel.has(node.tagName) && !voidElements.has(node.tagName)
}

const blockLevel = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'col', 'colgroup',
  'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
])

/**
 * The marker table, longest sequence first and with each tag name claimed by
 * one spelling — `!!` and `**` are both `<strong>`, and the first wins.
 *
 * @param {object} options
 * @returns {Array<object>}
 */
function markerTable(options) {
  const table = normalizeMarkers(options.markers ?? defaultMarkers)
  const seen = new Set()

  return table.filter((marker) => {
    if (seen.has(marker.tagName)) return false

    seen.add(marker.tagName)

    return true
  })
}

/**
 * The parser's heading ids, mirrored — with a `peek`, because whether a
 * heading can be written with `=` at all depends on the id it would get.
 *
 * @param {object} options
 * @returns {{peek: (text: string) => string | undefined, take: (text: string) => void}}
 */
function headingState(options) {
  const slug =
    typeof options.headingId === 'object' && options.headingId?.slug
      ? options.headingId.slug
      : defaultResolve
  /** @type {Set<string>} */
  const used = new Set()

  return {peek, take}

  function peek(text) {
    const base = slug(text)

    if (!base) return

    let candidate = base
    let count = 0

    while (used.has(candidate)) candidate = base + '-' + ++count

    return candidate
  }

  function take(text) {
    const id = peek(text)

    if (id) used.add(id)
  }
}

/**
 * Escape what the script stage reads, in content the *markup* treats as raw.
 *
 * A fence and a `` `` `` span hold whatever they hold as far as the parser is
 * concerned, but the script stage runs before the parser and nothing is raw to
 * it: a code sample containing `{{ … }}` is an interpolation, and one whose
 * line opens with `%` is a statement. Both have a backslash escape that the
 * script stage takes off again, so the reader sees what was written.
 *
 * Only when the document is going to be compiled. With script off these
 * escapes are not removed by anything and would show, which is why `toMdy`
 * leaves them out unless it is told.
 *
 * @param {string} value
 * @param {object} context
 * @returns {string}
 */
function escapeRaw(value, context) {
  if (!context.script) return value

  return value.replaceAll('{{', '\\{{').replace(/^([ \t]*)%/, '$1\\%')
}

/**
 * A footnote id that survives being written down.
 *
 * `[[ ^id ]]` runs to the first `]]` and splits on the first `|`, and neither
 * can be escaped inside one, so an id is reduced to what cannot break it.
 *
 * @param {string | number} value
 * @returns {string}
 */
function noteId(value) {
  return String(value).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '')
}

/**
 * @param {import('hast').Root | import('hast').Element} tree
 * @returns {Array<import('hast').RootContent>}
 */
function children(tree) {
  return tree.type === 'root' || tree.type === 'element' ? tree.children : []
}

/**
 * @param {object} context
 * @param {string} message
 */
function warn(context, message) {
  context.file?.message(message, {ruleId: 'to-mdy', source: 'mdy-wikipedia'})
}
