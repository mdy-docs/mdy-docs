/**
 * Colour MDY source for the editor.
 *
 * The parser in `packages/mdy` builds a tree; this only has to paint text, so
 * it walks the source line by line with the same lexical rules and emits
 * spans. Where a line hands its content to another language — a fenced block,
 * a `%` line, front matter, a `{{ }}` expression — the text goes through
 * lowlight, so those regions carry highlight.js's own classes and the
 * stylesheet colours them once for both this pane and the preview.
 */

import {common, createLowlight} from 'lowlight'
import {defaultArrows, defaultMarkers, scriptLines} from 'mdy-docs/parse'

const lowlight = createLowlight(common)

const fenceOpener = /^(`{3,}|~{3,})[ \t]*(.*)$/
const scriptLine = /^([ \t]*)(%%?)(.*)$/
const commentLine = /^([ \t]*)(#(?:[ \t].*)?)$/
const blockOpener = /^[ \t]*%%/
const headingLine = /^(=+)([ \t]*)(.*?)([ \t]*=*[ \t]*)$/
const underline = /^(?:=+|-{4,})[ \t]*$/
const thematicBreak = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const itemLine = /^(?:([-*+])|(\d{1,9})[.)])(?:([ \t]+)(.*))?$/
const taskBox = /^(\[)([ xX])(\])(.*)$/
const delimiterCell = /^(:?)-+(:?)$/
const tagName = /^[A-Za-z][A-Za-z0-9-]*/
const attributeName = /^[A-Za-z_:][A-Za-z0-9._:-]*/
const url = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)[^\s<>"'`]+/i
const protocolRelative = /^\/\/[\w-]+(?:\.[\w-]+)+(?:\/[^\s<>"'`]*)?/
const email = /^[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/
const reference = /^([#@])([\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?)/u
const shortcode = /^:([a-z0-9_+-]+):/i
const dots = '...'
const dashes = '--'

// Longest first, and the alphabet they are drawn with: the two things the
// parser's own arrow table is sorted and measured by.
const arrows = Object.keys(defaultArrows).sort((a, b) => b.length - a.length)
const letters = new Set(arrows.flatMap((sequence) => [...sequence]))
const word = /[\p{L}\p{N}_]/u

// Longest first, so a sequence that begins with another still wins.
const markers = [...defaultMarkers].sort(
  (a, b) => b.sequence.length - a.sequence.length
)

/**
 * Paint a whole document.
 *
 * Returns HTML with one output line per source line, so the gutter's numbers
 * and the caret in the textarea over it stay on the same rows.
 *
 * @param {string} source
 * @returns {string}
 */
export function highlightMdy(source) {
  const lines = source.split('\n')
  // Where the code is. A `%%` line runs on into the lines under it until its
  // brackets come back to even, so which lines are code is not something a
  // single line can answer — the parser works it out for the whole document
  // and the paint asks it the same question.
  const code = scriptLines(lines)
  /** @type {Array<string>} */
  const out = []
  let index = matter(lines, out)
  // `----` underlines the paragraph above it and breaks when there is none, so
  // painting it needs to know what came before. Exactly `---` always breaks:
  // that spelling belongs to the document separator.
  let paragraph = false
  let tableUntil = -1

  while (index < lines.length) {
    const line = lines[index]
    const indent = /^[ \t]*/.exec(line)[0]
    const content = line.slice(indent.length)

    if (!content) {
      out.push('')
      paragraph = false
      tableUntil = -1
      index += 1
      continue
    }

    // Code is looked for first, because the script stage runs over the whole
    // document before any of this: code is JavaScript wherever it is written, a
    // fenced block included.
    //
    // The indent is kept as the author typed it and then let alone. The parser
    // lifts these lines out before it counts a single column, so code neither
    // sits in the markup nor interrupts it — hence `paragraph` and `tableUntil`
    // carrying over, the line under a paragraph still being under it with code
    // in between.
    if (code[index]) {
      const script = scriptLine.exec(line)

      // A line a `%%` took up has no sigil of its own: it is code and nothing
      // else, so it is painted as the JavaScript it is.
      out.push(script ? codeLine(script) : embed(line, 'javascript'))
      index += 1
      continue
    }

    const fence = fenceOpener.exec(content)

    if (fence && !(fence[1].startsWith('`') && fence[2].includes('`'))) {
      index = fenced(lines, index, indent, fence, code, out)
      paragraph = false
      tableUntil = -1
      continue
    }

    const note = commentLine.exec(line)

    // Comments are looked for after the fences and before everything else,
    // which is the order the parser takes them in: `# ` opens a comment in
    // half the languages a block might hold, so inside one it is code and not
    // a comment at all. Outside, it leaves nothing behind — hence `paragraph`
    // and `tableUntil` carrying over, as they do across a `%` line.
    if (note) {
      out.push(note[1] + span('mdy-comment', note[2]))
      index += 1
      continue
    }

    if (index <= tableUntil) {
      out.push(indent + tableRow(content))
      index += 1
      continue
    }

    // A caption is a row's shape with a table under it rather than a delimiter
    // row, so it is painted as the table furniture it turns into.
    if (isCaption(lines, index)) {
      out.push(indent + wrap('mdy-caption', tableRow(content)))
      index += 1
      continue
    }

    const extent = tableExtent(lines, index)

    if (extent !== undefined) {
      tableUntil = extent
      out.push(indent + tableRow(content))
      index += 1
      continue
    }

    if (paragraph && underline.test(content)) {
      out.push(indent + span('mdy-heading-rule', content))
      paragraph = false
      index += 1
      continue
    }

    if (thematicBreak.test(content)) {
      out.push(indent + span('mdy-break', content))
      paragraph = false
      index += 1
      continue
    }

    const heading = headingLine.exec(content)

    if (heading) {
      out.push(
        indent +
          span('mdy-heading-mark', heading[1]) +
          heading[2] +
          wrap('mdy-heading', inline(heading[3])) +
          span('mdy-heading-mark', heading[4])
      )
      paragraph = false
      index += 1
      continue
    }

    const item = itemLine.exec(content)

    if (item) {
      out.push(indent + listItem(item))
      paragraph = false
      index += 1
      continue
    }

    if (content.startsWith('<')) {
      out.push(indent + opener(content))
      paragraph = false
      index += 1
      continue
    }

    out.push(indent + inline(content))
    paragraph = true
    index += 1
  }

  return out.join('\n')
}

/**
 * How far each `%%` block reaches.
 *
 * Only the ones that took a line with them: a `%%` that closed on itself is a
 * code line like any other and has no extent to show.
 *
 * @param {string} source
 * @returns {Array<{from: number, to: number}>}
 *   Zero-based line numbers, both ends inclusive.
 */
export function blockRegions(source) {
  const lines = source.split('\n')
  const code = scriptLines(lines)
  /** @type {Array<{from: number, to: number}>} */
  const regions = []

  for (let index = 0; index < lines.length; index += 1) {
    if (!blockOpener.test(lines[index])) continue

    let last = index

    // A line the block took up is code without being a code line itself.
    while (
      last + 1 < lines.length &&
      code[last + 1] &&
      !scriptLine.test(lines[last + 1])
    ) {
      last += 1
    }

    if (last > index) regions.push({from: index, to: last})

    index = last
  }

  return regions
}

/* ------------------------------------------------------------- blocks -- */

/**
 * Paint front matter, if the document opens with it, and say where the rest
 * of the document starts.
 *
 * @param {Array<string>} lines
 * @param {Array<string>} out
 * @returns {number}
 */
function matter(lines, out) {
  /*
   * Two spellings, both real, in two different layers.
   *
   * The LANGUAGE takes a fenced block: `+++`, YAML, `+++` (docs/language.md
   * §11, extractMatter in src/parse/matter.js). A DOCUMENT SET splits each
   * document on its first bare `+++` instead, everything above it being the
   * YAML (the README, parseDocument in src/mdy.js) — which is how every
   * example in the repo and the live-preview editor writes it.
   *
   * Which one a line opens is decided by the first line: `+++` at the top
   * can only be the fenced form, and it has to close or it is prose. A
   * document that opens with anything else is the split form, and its
   * separator is the first bare `+++` there is.
   */
  let start = 0
  while (start < lines.length && !lines[start].trim()) start += 1

  if (lines[start]?.trim() === '+++') {
    let end = start + 1
    while (end < lines.length && lines[end].trim() !== '+++') end += 1
    if (end >= lines.length) return 0

    for (let index = 0; index < start; index += 1) out.push('')
    out.push(span('mdy-matter-fence', lines[start]))
    if (end > start + 1) {
      out.push(embed(lines.slice(start + 1, end).join('\n'), 'yaml'))
    }
    out.push(span('mdy-matter-fence', lines[end]))
    return end + 1
  }

  const separator = lines.findIndex((line) => /^\+\+\+[ \t]*$/.test(line))
  if (separator === -1) return 0

  out.push(embed(lines.slice(0, separator).join('\n'), 'yaml'))
  out.push(span('mdy-matter-fence', lines[separator]))
  return separator + 1
}


/**
 * Paint a fenced block, opener to closer, and say which line to read next.
 *
 * The body is coloured in runs rather than line by line: highlight.js needs
 * as much of the block at once as it can have to know a string from a comment.
 * A `%` line is what breaks a run, because it is not part of the block at all
 * — code runs over the document before a fence has been found, so a loop can
 * enclose the lines of a code block exactly as it encloses markup.
 *
 * @param {Array<string>} lines
 * @param {number} index
 * @param {string} indent
 * @param {RegExpExecArray} fence
 * @param {Array<boolean>} code
 *   Which lines are code, worked out over the whole document.
 * @param {Array<string>} out
 * @returns {number}
 */
function fenced(lines, index, indent, fence, code, out) {
  const [, marker, info] = fence
  const language = info.trim().split(/\s+/)[0] ?? ''

  out.push(
    indent +
      span('mdy-fence', marker) +
      (info ? span('mdy-language', fence[0].slice(marker.length)) : '')
  )

  let end = index + 1

  while (end < lines.length && !closes(lines[end], marker)) end += 1

  let run = index + 1

  for (let line = run; line <= end; line += 1) {
    if (line < end && !code[line]) continue

    if (line > run) out.push(embed(lines.slice(run, line).join('\n'), language))

    if (line < end) {
      const script = scriptLine.exec(lines[line])

      out.push(script ? codeLine(script) : embed(lines[line], 'javascript'))
    }

    run = line + 1
  }

  if (end < lines.length) out.push(span('mdy-fence', lines[end]))

  return end + 1
}

/**
 * Paint one `%` or `%%` line: the sigil it opens with, then JavaScript.
 *
 * @param {RegExpExecArray} script
 * @returns {string}
 */
function codeLine(script) {
  return (
    script[1] + span('mdy-sigil', script[2]) + embed(script[3], 'javascript')
  )
}

/**
 * Whether a line closes a fence: the same character, at least as many.
 *
 * @param {string} line
 * @param {string} marker
 * @returns {boolean}
 */
function closes(line, marker) {
  const trimmed = line.trim()

  return (
    trimmed.length >= marker.length &&
    [...trimmed].every((character) => character === marker[0])
  )
}

/**
 * How far a table starting on `index` runs, or nothing if no table does.
 *
 * A row only turns out to be a header once the next line proves to be a
 * delimiter row with the same number of columns, which is GitHub's rule and
 * the one `block.js` follows.
 *
 * @param {Array<string>} lines
 * @param {number} index
 * @returns {number | undefined}
 */
function tableExtent(lines, index) {
  const header = cells(lines[index])

  if (!header.delimited || index + 1 >= lines.length) return

  const delimiter = cells(lines[index + 1])

  if (
    !delimiter.delimited ||
    delimiter.values.length !== header.values.length ||
    !delimiter.values.every((cell) => delimiterCell.test(cell.trim()))
  ) {
    return
  }

  let end = index + 1

  while (end + 1 < lines.length) {
    const next = lines[end + 1]

    if (!next.trim() || headingLine.test(next) || thematicBreak.test(next)) break

    end += 1
  }

  return end
}

/**
 * Whether the line at `index` captions the table under it: one cell, opening
 * with a pipe, with a whole table on the next line rather than the delimiter
 * row a header would have.
 *
 * @param {Array<string>} lines
 * @param {number} index
 * @returns {boolean}
 */
function isCaption(lines, index) {
  const content = lines[index].trimStart()

  if (!content.startsWith('|')) return false

  const {values} = cells(content)

  if (values.length !== 1 || !values[0].trim()) return false

  return tableExtent(lines, index + 1) !== undefined
}

/**
 * Split a row on unescaped pipes, dropping the optional framing ones.
 *
 * @param {string} line
 * @returns {{values: Array<string>, delimited: boolean}}
 */
function cells(line) {
  const value = line.trim()
  /** @type {Array<string>} */
  const values = []
  let cell = ''
  let index = 0
  let delimited = false

  while (index < value.length) {
    const character = value.charAt(index)

    if (character === '\\' && index + 1 < value.length) {
      cell += value.slice(index, index + 2)
      index += 2
      continue
    }

    if (character === '|') {
      values.push(cell)
      cell = ''
      delimited = true
      index += 1
      continue
    }

    cell += character
    index += 1
  }

  values.push(cell)

  if (delimited) {
    if (!values[0].trim()) values.shift()
    if (values.length && !values[values.length - 1].trim()) values.pop()
  }

  return {values, delimited}
}

/**
 * Paint one row: pipes as punctuation, cells as inline content — except in a
 * delimiter row, where the dashes and colons are the syntax.
 *
 * @param {string} content
 * @returns {string}
 */
function tableRow(content) {
  const delimiter = cells(content).values.every((cell) =>
    delimiterCell.test(cell.trim())
  )
  let out = ''
  let cell = ''

  const flush = () => {
    if (!cell) return
    out += delimiter ? span('mdy-table-rule', cell) : inline(cell)
    cell = ''
  }

  for (let index = 0; index < content.length; index += 1) {
    const character = content.charAt(index)

    if (character === '\\' && index + 1 < content.length) {
      cell += content.slice(index, index + 2)
      index += 1
      continue
    }

    if (character === '|') {
      flush()
      out += span('mdy-pipe', '|')
      continue
    }

    cell += character
  }

  flush()

  return out
}

/**
 * Paint a list marker, its checkbox if it has one, and the rest of the line.
 *
 * @param {RegExpExecArray} item
 * @returns {string}
 */
function listItem(item) {
  const [, bullet, number, space, text] = item
  const marker = bullet ?? number + item[0].charAt(number.length)
  let out = span('mdy-bullet', marker) + (space ?? '')

  if (text === undefined) return out

  const task = taskBox.exec(text)

  if (task) {
    return (
      out +
      span('mdy-task' + (task[2] === ' ' ? '' : ' checked'), task[1] + task[2] + task[3]) +
      inline(task[4])
    )
  }

  return out + inline(text)
}

/**
 * Paint an element opener: `<`, the tag, its attributes, and whatever a `>`
 * leaves behind as content.
 *
 * @param {string} content
 * @returns {string}
 */
function opener(content) {
  // Space after the `<` is the author's, not the grammar's: it is kept as
  // typed and the tag is looked for behind it, which is what the parser does.
  let start = 1

  while (content.charAt(start) === ' ' || content.charAt(start) === '\t') {
    start += 1
  }

  const tag = tagName.exec(content.slice(start))
  let index = start + (tag ? tag[0].length : 0)
  let out =
    span('mdy-punct', '<') +
    content.slice(1, start) +
    (tag ? span('mdy-tag', tag[0]) : '')

  while (index < content.length) {
    const character = content.charAt(index)

    if (character === ' ' || character === '\t') {
      out += character
      index += 1
      continue
    }

    if (character === '>' || (character === '/' && content.charAt(index + 1) === '>')) {
      const width = character === '>' ? 1 : 2

      return (
        out +
        span('mdy-punct', content.slice(index, index + width)) +
        inline(content.slice(index + width))
      )
    }

    const name = attributeName.exec(content.slice(index))

    if (!name) {
      out += escapeHtml(content.charAt(index))
      index += 1
      continue
    }

    out += span('mdy-attr', name[0])
    index += name[0].length

    if (content.charAt(index) !== '=') continue

    out += span('mdy-punct', '=')
    index += 1

    const quote = content.charAt(index)

    if (quote === '"' || quote === "'") {
      const end = content.indexOf(quote, index + 1)
      const stop = end === -1 ? content.length : end + 1

      out += span('mdy-string', content.slice(index, stop))
      index = stop
      continue
    }

    const value = /^[^\s>]*/.exec(content.slice(index))[0]

    out += span('mdy-string', value)
    index += value.length
  }

  return out
}

/* ------------------------------------------------------------- inline -- */

/**
 * Paint the inline layer of a run of content.
 *
 * Markers toggle rather than nest, and closing one closes whatever opened
 * inside it, so the open ones are a stack: the same rule the parser follows,
 * which is what keeps `!!bold //and italic!!` looking the way it renders.
 *
 * @param {string} value
 * @returns {string}
 */
function inline(value) {
  /** @type {Array<{sequence: string}>} */
  const open = []
  let out = ''
  let index = 0

  while (index < value.length) {
    const rest = value.slice(index)
    const character = value.charAt(index)

    if (character === '\\' && index + 1 < value.length) {
      out += span('mdy-escape', value.slice(index, index + 2))
      index += 2
      continue
    }

    if (rest.startsWith('{{')) {
      const end = rest.indexOf('}}', 2)
      const stop = end === -1 ? value.length : index + end + 2

      out +=
        span('mdy-punct', '{{') +
        embed(value.slice(index + 2, end === -1 ? value.length : index + end), 'javascript') +
        (end === -1 ? '' : span('mdy-punct', '}}'))
      index = stop
      continue
    }

    if (rest.startsWith('[[')) {
      const end = rest.indexOf(']]', 2)

      if (end !== -1) {
        out += wiki(rest.slice(2, end))
        index += end + 2
        continue
      }
    }

    const boundary = index === 0 || !word.test(value.charAt(index - 1))
    const address =
      boundary &&
      (url.exec(rest) ?? protocolRelative.exec(rest) ?? email.exec(rest))

    if (address) {
      out += span('mdy-url', address[0])
      index += address[0].length
      continue
    }

    if (boundary) {
      const named = reference.exec(rest)

      if (named) {
        out += span(named[1] === '#' ? 'mdy-tag-link' : 'mdy-mention', named[0])
        index += named[0].length
        continue
      }

      const emoji = shortcode.exec(rest)

      if (emoji) {
        out += span('mdy-emoji', emoji[0])
        index += emoji[0].length
        continue
      }
    }

    const marker = markers.find((candidate) => rest.startsWith(candidate.sequence))

    if (marker) {
      const at = open.findLastIndex((entry) => entry.sequence === marker.sequence)

      if (at === -1) {
        // A raw span takes everything up to its own closer literally, so there
        // is nothing inside it to look for.
        if (marker.raw) {
          const end = rest.indexOf(marker.sequence, marker.sequence.length)
          const stop = end === -1 ? value.length : index + end + marker.sequence.length

          out += span('mdy-' + marker.tagName, value.slice(index, stop))
          index = stop
          continue
        }

        open.push(marker)
        out +=
          '<span class="mdy-' +
          marker.tagName +
          '">' +
          span('mdy-punct', marker.sequence)
      } else {
        while (open.length - 1 > at) {
          open.pop()
          out += '</span>'
        }

        open.pop()
        out += span('mdy-punct', marker.sequence) + '</span>'
      }

      index += marker.sequence.length
      continue
    }

    // What the parser leaves as the character it draws rather than the
    // characters it was typed with. Markers have already had their look, as
    // they do there.
    const drawn = substitution(value, index)

    if (drawn) {
      out += span(drawn.className, drawn.text)
      index += drawn.text.length
      continue
    }

    out += escapeHtml(character)
    index += 1
  }

  return out + '</span>'.repeat(open.length)
}

/**
 * An ellipsis, an arrow or an em dash at `index`, under the same rules the
 * parser reads them by: exactly three dots, an arrow that stands against none
 * of the characters its table is drawn with, and exactly two dashes.
 *
 * @param {string} value
 * @param {number} index
 * @returns {{text: string, className: string} | undefined}
 */
function substitution(value, index) {
  if (
    value.startsWith(dots, index) &&
    value.charAt(index - 1) !== '.' &&
    value.charAt(index + dots.length) !== '.'
  ) {
    return {text: dots, className: 'mdy-ellipsis'}
  }

  if (!letters.has(value.charAt(index)) || letters.has(value.charAt(index - 1))) {
    return
  }

  const arrow = arrows.find((sequence) => value.startsWith(sequence, index))

  if (arrow && !letters.has(value.charAt(index + arrow.length))) {
    return {text: arrow, className: 'mdy-arrow'}
  }

  // After the arrows, so `-->` keeps its head. A longer run of dashes is one
  // of the three line rules and not this one, so it is left alone.
  if (
    value.startsWith(dashes, index) &&
    value.charAt(index - 1) !== '-' &&
    value.charAt(index + dashes.length) !== '-'
  ) {
    return {text: dashes, className: 'mdy-dash'}
  }
}

/**
 * Paint the inside of a `[[ … ]]` link: a label, an optional target, and a
 * leading `^` that makes it a footnote instead.
 *
 * @param {string} body
 * @returns {string}
 */
function wiki(body) {
  const split = body.indexOf('|')
  const label = split === -1 ? body : body.slice(0, split)
  const target = split === -1 ? '' : body.slice(split + 1)
  const footnote = label.trim().startsWith('^')
  const name = footnote ? 'mdy-footnote' : 'mdy-wiki'

  return (
    span('mdy-punct', '[[') +
    span(name, label) +
    (split === -1
      ? ''
      : span('mdy-punct', '|') + span('mdy-url', target)) +
    span('mdy-punct', ']]')
  )
}

/* ------------------------------------------------------------ helpers -- */

/**
 * Hand a run of another language to lowlight, and serialise what comes back.
 *
 * Exported as well, because the page's JSON pane is another run of another
 * language and should wear the same tokens the rest of the page does.
 *
 * @param {string} value
 * @param {string} language
 * @returns {string}
 */
export function embed(value, language) {
  if (!value || !language || !lowlight.registered(language)) {
    return escapeHtml(value)
  }

  try {
    return toHtml(lowlight.highlight(language, value).children)
  } catch {
    return escapeHtml(value)
  }
}

/**
 * Serialise the spans lowlight builds. It only ever emits `span` elements
 * with a class and text, which is why this is allowed to be this small.
 *
 * @param {Array<import('hast').ElementContent>} nodes
 * @returns {string}
 */
function toHtml(nodes) {
  let out = ''

  for (const node of nodes) {
    if (node.type === 'text') {
      out += escapeHtml(node.value)
    } else if (node.type === 'element') {
      const classes = node.properties?.className ?? []

      out += wrap([classes].flat().join(' '), toHtml(node.children))
    }
  }

  return out
}

/**
 * Wrap plain text, escaping it on the way.
 *
 * @param {string} className
 * @param {string} value
 * @returns {string}
 */
function span(className, value) {
  return wrap(className, escapeHtml(value))
}

/**
 * Wrap markup that is already painted.
 *
 * @param {string} className
 * @param {string} markup
 * @returns {string}
 */
function wrap(className, markup) {
  if (!markup) return ''

  return '<span class="' + className + '">' + markup + '</span>'
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(
    /[&<>]/g,
    (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[character]
  )
}
