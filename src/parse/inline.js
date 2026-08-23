import {matchArrow, normalizeArrows} from './arrows.js'
import {matchEmDash, normalizeEmDash} from './dash.js'
import {matchEllipsis, normalizeEllipsis} from './ellipsis.js'
import {matchEmoji, normalizeEmoji} from './emoji.js'
import {findLinks, linkKind, normalizeLink} from './link.js'
import {matchReference, normalizeReference} from './reference.js'
import {allowedProtocol, normalizeSchema} from './sanitize.js'
import {normalizeWikiLink, parseWikiLink} from './wiki.js'
import {normalizeMarkers} from './markers.js'

/**
 * Turn one run of MDY inline text into hast phrasing content.
 *
 * Markers toggle. Opening a marker pushes a span; the next occurrence of that
 * same sequence closes it *and* every span opened inside it (rule 3: "any inner
 * open tags are automatically closed"). Anything still open when the text ends
 * is closed there.
 *
 * A backslash escapes the character that follows it, so `\!!bang` is literal.
 * URLs, `#tags` and `@users` become links, emoticons become emoji, and three
 * dots and `-->` become the characters they draw, none of which happens inside
 * a raw span. URLs are
 * matched first, before markers, so the `//` in `https://` is part of the
 * address rather than a run of emphasis. `[[ label | url ]]` is a link too,
 * with its label parsed as inline content of its own.
 *
 * @param {string} value
 *   Raw inline text (a paragraph's joined lines, or a heading's content).
 * @param {{markers?: ReadonlyArray<import('./markers.js').Marker>, emoji?: boolean | Partial<import('./emoji.js').Settings>, ellipsis?: boolean | string, arrows?: boolean | Record<string, string>, autolink?: boolean, wikiLink?: boolean | Partial<import('./wiki.js').Settings>, tags?: boolean | string | Partial<import('./reference.js').Setting>, mentions?: boolean | string | Partial<import('./reference.js').Setting>, sanitize?: boolean | Partial<import('./sanitize.js').Schema>, file?: import('vfile').VFile}} [options]
 * @returns {Array<import('hast').ElementContent>}
 */
export function parseInline(value, options = {}) {
  const markers = normalizeMarkers(options.markers)
  const emoji = normalizeEmoji(options.emoji)
  const ellipsis = normalizeEllipsis(options.ellipsis)
  const arrows = normalizeArrows(options.arrows)
  const emDash = normalizeEmDash(options.emDash)
  const links = options.autolink === false ? [] : findLinks(value)
  const wiki = normalizeWikiLink(options.wikiLink)
  const references = {
    tag: normalizeReference(options.tags, '/tags/'),
    mention: normalizeReference(options.mentions, '/users/')
  }
  const schema = normalizeSchema(options.sanitize)
  /** @type {Array<import('hast').ElementContent>} */
  const children = []
  /** @type {Array<{marker: import('./markers.js').Marker | null, children: Array<import('hast').ElementContent>}>} */
  const stack = [{marker: null, children}]
  let buffer = ''
  let index = 0
  let link = 0
  let atBoundary = true

  while (index < value.length) {
    const character = value.charAt(index)
    const raw = rawFrame()

    // Anything already passed cannot match any more.
    while (link < links.length && links[link].index < index) link += 1

    // Escapes work everywhere except inside a raw span, where the point is that
    // nothing is interpreted.
    if (character === '\\' && !raw && index + 1 < value.length) {
      buffer += value.charAt(index + 1)
      index += 2
      atBoundary = false
      continue
    }

    if (!raw && character === '[' && (wiki || options.footnoteState)) {
      const found = parseWikiLink(value, index)

      // `[[ ^1 ]]` is a footnote reference rather than a link. An id nothing
      // defines is left as the text it was, as Markdown leaves it.
      if (found?.label.startsWith('^') && options.footnoteState) {
        const note = options.footnoteState.reference(found.label.slice(1).trim())

        if (note) {
          flush()
          stack[stack.length - 1].children.push(note)
          index += found.length
          atBoundary = false
          continue
        }
      }

      if (found && wiki && !found.label.startsWith('^')) {
        flush()
        stack[stack.length - 1].children.push({
          type: 'element',
          tagName: 'a',
          properties: wikiProperties(found),
          // The label is content in its own right. It is parsed with links on,
          // so a URL in it survives the `//` marker, and then unwrapped: an
          // `<a>` inside an `<a>` is not a thing.
          //
          // Nothing in a label is written down either. A `#name` in there is
          // the words of this link — a fragment, most often — and it is about
          // to be unwrapped rather than linked, so counting it as a reference
          // would be counting something the reader never sees.
          children: unwrapLinks(
            parseInline(found.label, {...options, collect: undefined})
          )
        })

        index += found.length
        atBoundary = true
        continue
      }
    }

    // A URL is taken whole, before markers get a look at it.
    if (!raw && links[link]?.index === index) {
      const found = links[link]

      flush()
      stack[stack.length - 1].children.push({
        type: 'element',
        tagName: 'a',
        properties: {href: found.url},
        children: [{type: 'text', value: found.text}]
      })

      index = found.end
      link += 1
      atBoundary = true
      continue
    }

    // `#tag` and `@user`, after links: a URL fragment or an email address has
    // already been taken whole by the time this runs.
    if (!raw && (character === '#' || character === '@')) {
      const found = matchReference(value, index, references)

      if (found) {
        flush()

        // Written down as well as written out: a document is asked often
        // enough what it refers to that it should not have to be read again
        // to answer.
        options.collect?.(found.kind, found.name)

        stack[stack.length - 1].children.push({
          type: 'element',
          tagName: 'a',
          properties: {href: found.href},
          children: [{type: 'text', value: character + found.name}]
        })

        index += found.length
        atBoundary = false
        continue
      }
    }

    const marker = matchMarker(value, index)

    if (!marker) {
      // Raw spans are literal, so neither substitution below reaches inside.
      const found = raw
        ? undefined
        : matchEmoji(value, index, emoji, atBoundary)

      if (found) {
        buffer += found.emoji
        index += found.length
        atBoundary = true
        continue
      }

      // Arrows before the em dash, so `-->` keeps its head rather than
      // becoming one character and a `>`.
      const drawn = raw
        ? undefined
        : matchEllipsis(value, index, ellipsis) ??
          matchArrow(value, index, arrows) ??
          matchEmDash(value, index, emDash)

      if (drawn) {
        buffer += drawn.text
        index += drawn.length
        // Punctuation: what follows is no more at the start of a word than it
        // would be after a full stop.
        atBoundary = false
        continue
      }

      buffer += character
      index += 1
      atBoundary = /\s/.test(character)
      continue
    }

    flush()

    const depth = stack.findIndex((frame) => frame.marker === marker)

    if (depth > 0) {
      while (stack.length > depth) close()
    } else {
      stack.push({marker, children: []})
    }

    index += marker.sequence.length

    // A marker is not text, so what follows it still starts a word.
    atBoundary = true
  }

  flush()

  while (stack.length > 1) close()

  return children

  /** Innermost open raw span, if any. */
  function rawFrame() {
    for (let index = stack.length - 1; index > 0; index--) {
      if (stack[index].marker?.raw) return stack[index]
    }
  }

  /**
   * Longest marker matching at `start`. Inside a raw span only that span's own
   * sequence can match, so its contents stay literal.
   *
   * @param {string} value
   * @param {number} start
   */
  function matchMarker(value, start) {
    const raw = rawFrame()
    const candidates = raw ? [raw.marker] : markers

    return candidates.find((marker) => value.startsWith(marker.sequence, start))
  }

  /**
   * Replace any anchors in a link's label with what they said.
   *
   * @param {Array<import('hast').ElementContent>} children
   * @returns {Array<import('hast').ElementContent>}
   */
  function unwrapLinks(children) {
    return children.flatMap((child) => {
      if (child.type !== 'element') return child

      const inner = unwrapLinks(child.children)

      return child.tagName === 'a' ? inner : {...child, children: inner}
    })
  }

  /**
   * The `href` for a wiki link, dropped when it points somewhere the schema
   * refuses, exactly as it would be on a hand-written `<a>`.
   *
   * @param {import('./wiki.js').Found} found
   * @returns {import('hast').Properties}
   */
  function wikiProperties(found) {
    const written =
      found.url === undefined ? wiki.resolve(found.label) : found.url
    const protocols = schema?.protocols?.href

    if (!written) return {}

    if (protocols && !allowedProtocol(written, protocols)) {
      options.file?.message(
        '`[[' +
          found.label +
          ']]` points at a protocol that is not allowed, dropping the link',
        {ruleId: 'sanitize', source: 'mdy'}
      )

      return {}
    }

    return {href: pageLink(written)}
  }

  /**
   * Tidy a link to a page of our own, and write it down.
   *
   * Somebody else’s URL and a fragment of this page are both left as they
   * were: the first is not ours to tidy and the second names an id.
   *
   * @param {string} href
   * @returns {string}
   */
  function pageLink(href) {
    if (linkKind(href) !== 'page') return href

    const tidy = normalizeLink(href)

    options.collect?.('link', tidy)

    return tidy
  }

  function flush() {
    if (!buffer) return
    stack[stack.length - 1].children.push({type: 'text', value: buffer})
    buffer = ''
  }

  function close() {
    const frame = stack.pop()

    if (!frame?.marker) return

    stack[stack.length - 1].children.push({
      type: 'element',
      tagName: frame.marker.tagName,
      properties: {},
      children: frame.children
    })
  }
}
