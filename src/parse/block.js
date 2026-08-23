import {htmlVoidElements} from 'html-void-elements'
import {normalizeDocuments, splitWithLines} from './documents.js'
import {stripComments} from './comment.js'
import {closesFence, dedent, parseFence} from './fence.js'
import {createHeadingIds, normalizeHeadingId} from './heading.js'
import {highlightCode, normalizeHighlight} from './highlight.js'
import {extractMatter, normalizeFrontmatter} from './matter.js'
import {
  createFootnotes,
  definitionLine,
  findDefinitions,
  normalizeFootnotes
} from './footnote.js'
import {parseHtmlLine, toProperties} from './html.js'
import {parseInline} from './inline.js'
import {indentWidth, parseItemLine} from './list.js'
import {linkKind, normalizeLink} from './link.js'
import {collectReferences} from './reference.js'
import {normalizeSchema, sanitizeOpener} from './sanitize.js'
import {expandScript, normalizeScript, toText} from './script.js'
import {normalizeTasks, taskForm} from './task.js'
import {parseDelimiterRow, splitRow, unescapePipes} from './table.js'

const headingLine = /^(=+)[ \t]*(.*?)[ \t]*=*[ \t]*$/
// Four dashes at least. Three is the document separator, and a line that
// might be either depending on an option is a line nobody can read.
const underline = /^(?:(=+)|(-{4,}))[ \t]*$/
const thematicBreak = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/
// Elements whose children are text, never markup. `<pre>` is here for the
// same reason as the others even though HTML would read markup inside it:
// what an author puts in one is art, a transcript, or a paste, and reading a
// row of underscores as an emphasis marker is never what was meant.
const rawText = new Set(['pre', 'script', 'style', 'textarea', 'title'])
// The one line of an HTML document that names no element.
const doctypeLine = /^<!doctype\b[^>]*>?[ \t]*$/i
const leadingSpace = /^[ \t]*/
const step = 2

/**
 * @typedef Options
 * @property {ReadonlyArray<import('./markers.js').Marker>} [markers]
 *   Inline marker table (defaults to `defaultMarkers`).
 * @property {boolean} [autolink=true]
 *   Whether URLs in text become links.
 * @property {boolean | string | Partial<import('./reference.js').Setting>} [tags='/tags/']
 *   Where `#tag` links to: a prefix, or `{resolve}` to build the whole URL.
 * @property {boolean | string | Partial<import('./reference.js').Setting>} [mentions='/users/']
 *   Where `@user` links to, the same way.
 * @property {boolean | Partial<import('./task.js').Settings>} [tasks=false]
 *   Whether a task checkbox is wrapped in a form that can toggle it at the
 *   source. Off by default: the form needs somewhere to post to.
 * @property {number} [lineOffset=0]
 *   Added to every position, so they point at the file rather than at whatever
 *   slice of it was handed over.
 * @property {boolean | object} [highlight=true]
 *   Colouring for fenced code. `false` leaves it plain; a `lowlight`-like
 *   object with `registered` and `highlight` is used instead of the default.
 * @property {boolean | string | Partial<import('./matter.js').Settings>} [frontmatter=true]
 *   Whether a `+++` fenced block at the top of a document is YAML. The data
 *   lands on the tree, on the file, and in scope for code.
 * @property {boolean | string | Partial<import('./documents.js').Settings>} [documents=false]
 *   Whether a line of exactly `---` starts a new document. Each is parsed on
 *   its own and put in an `<article>`; pass a tag name to change it.
 * @property {boolean | Partial<import('./script.js').Settings>} [script=false]
 *   Whether `%` lines are run as JavaScript. Off by default: it executes the
 *   document. Pass `{scope}` to hand it variables.
 * @property {boolean | Partial<import('./footnote.js').Settings>} [footnotes=true]
 *   Whether `[[ ^id ]]` references and `[[ ^id ]]: …` definitions are collected
 *   into a footnotes section.
 * @property {boolean | Partial<import('./wiki.js').Settings>} [wikiLink=true]
 *   Whether `[[ label ]]` and `[[ label | url ]]` become links. Pass
 *   `{resolve}` to decide where a bare label points.
 * @property {boolean | Partial<import('./emoji.js').Settings>} [emoji=true]
 *   Whether `:)` and `:rocket:` become emoji. Either half can be turned off on
 *   its own with `{emoticons: false}` or `{shortcodes: false}`.
 * @property {boolean | string} [emDash=true]
 *   Whether `--` becomes an em dash. Pass a string to write something else.
 * @property {boolean | string} [ellipsis=true]
 *   Whether `...` becomes `…`. Pass a string to write that in their place
 *   instead.
 * @property {boolean | Record<string, string>} [arrows=true]
 *   Whether `-->`, `<--`, `<-->`, `==>`, `<==` and `<==>` become arrow
 *   characters. Pass a table of your own to change what is replaced.
 * @property {number} [maxHeadingDepth=6]
 *   Deeper headings are clamped to this and reported on the file.
 * @property {boolean | Partial<import('./heading.js').Settings>} [headingId=true]
 *   Whether headings are given an `id` to be linked to, so
 *   `[[ jump | #some-heading ]]` lands without a transform of your own. Pass
 *   `{slug}` to name them yourself.
 * @property {import('./heading.js').State} [headingState]
 *   Internal: the run of ids a stream's documents share, so headings on one
 *   page are unique across the whole of it.
 * @property {boolean | Partial<import('./sanitize.js').Schema>} [sanitize=true]
 *   Which elements and attributes an author may write (rule 3). `false` turns
 *   checking off; an object narrows or widens `defaultSchema`.
 * @property {'style' | 'attribute'} [tableAlign='style']
 *   How column alignment is expressed: `style="text-align: center"`, or the
 *   legacy `align="center"` attribute that GitHub and `remark-gfm` emit.
 * @property {import('vfile').VFile} [file]
 *   When given, warnings are attached to it.
 */

/**
 * Parse a source holding several documents.
 *
 * Each is parsed on its own, so a script, its transforms and its footnotes
 * belong to one document and cannot reach into the next. Footnote ids past the
 * first document are given a distinguishing prefix, since the documents share
 * one page in the end and an `id` has to be unique on it.
 *
 * @param {string} document
 * @param {Options} options
 * @param {import('./documents.js').Settings} stream
 * @returns {import('hast').Root}
 */
function fromStream(document, options, stream) {
  const footnotes = normalizeFootnotes(options.footnotes)
  const headings = normalizeHeadingId(options.headingId)
  // Documents in a stream land on one page, so their headings share one run of
  // ids rather than each starting over and colliding.
  const headingState = headings ? createHeadingIds(headings) : undefined
  /** @type {Array<import('hast').RootContent>} */
  const children = []
  /** @type {Array<unknown>} */
  const matter = []

  splitWithLines(document).forEach((part, index) => {
    const source = part.value
    /** @type {Options} */
    const settings = {
      ...options,
      documents: false,
      headingState,
      lineOffset: (options.lineOffset ?? 0) + part.line
    }

    if (footnotes && index > 0) {
      settings.footnotes = {...footnotes, prefix: footnotes.prefix + index + '-'}
    }

    const root = fromMdy(source, settings)

    matter.push(root.data?.matter)

    if (!stream.wrapper) {
      children.push(...root.children)
      return
    }

    /** @type {Array<import('hast').ElementContent>} */
    const inner = [{type: 'text', value: '\n'}]

    for (const child of root.children) {
      inner.push(child, {type: 'text', value: '\n'})
    }

    /** @type {import('hast').Element} */
    const wrapper = {
      type: 'element',
      tagName: stream.wrapper,
      properties: {},
      children: inner
    }

    if (root.data?.matter !== undefined) {
      wrapper.data = {matter: root.data.matter}
    }

    children.push(wrapper)
  })

  // Each document set this as it was parsed; the file should hold the first,
  // not whichever happened to be parsed last.
  if (options.file && matter.some((data) => data !== undefined)) {
    options.file.data = {...options.file.data, matter: matter[0], documents: matter}
  }

  return {type: 'root', children}
}

/**
 * Parse an MDY document into a hast root.
 *
 * Block grammar, in full:
 *
 * - a line of exactly `---` starts a new document, when `documents` is on
 * - a line starting with `%` is JavaScript, when `script` is on: it runs first
 *   and what it prints is parsed by every rule below, and it may register
 *   functions to run on the finished tree
 * - a line starting with one or more `=` is a heading, one level per `=`
 *   (`===` → `<h3>`); trailing `=` are decoration and dropped
 * - three or more backticks or tildes fence a block of code, which is taken
 *   literally and may name its language
 * - a line of only `=`, or four or more `-`, under a paragraph underlines it,
 *   Setext style, making it an `<h1>` or an `<h2>`
 * - three or more `-`, `*`, or `_` alone on a line is an `<hr>`
 * - `[[ ^id ]]: …` defines a footnote, collected into a section at the end
 * - a line starting with `<` opens an element: bare `<` is a `<div>`, `<table`
 *   is a `<table>`, and attributes may follow; the closing `>` is optional
 * - a line starting with `-`, `*`, `+`, `1.`, or `1)` starts a list; `[ ]` or
 *   `[x]` after the marker makes the item a task
 * - a line containing `|`, followed by a delimiter row with the same number of
 *   cells, starts a GitHub flavoured table
 * - runs of adjacent non-blank lines are joined with a space into one paragraph
 * - blank lines separate blocks and produce nothing
 *
 * Indentation is structural. Every two columns is one level of nesting: the
 * lines under an element opener are its children, and lines indented under
 * anything else get a `<div>` of their own. An element closes as soon as the
 * indentation comes back to its own level or further out.
 *
 * @param {string} document
 * @param {Options} [options]
 * @returns {import('hast').Root}
 */
export function fromMdy(document, options = {}) {
  const stream = normalizeDocuments(options.documents)

  if (stream) return fromStream(document, options, stream)

  const maxHeadingDepth = options.maxHeadingDepth ?? 6
  const tableAlign = options.tableAlign ?? 'style'
  const highlighter = normalizeHighlight(options.highlight)
  const tasks = normalizeTasks(options.tasks)
  const headings = normalizeHeadingId(options.headingId)
  const headingState =
    options.headingState ?? (headings ? createHeadingIds(headings) : undefined)
  const schema = normalizeSchema(options.sanitize)
  // Front matter comes off first: it is data rather than content, and code
  // further down is entitled to read it.
  const source = String(document).split(/\r\n|\r|\n/)
  const matter = extractMatter(
    source,
    normalizeFrontmatter(options.frontmatter),
    options.file
  )
  // Front matter is gone from the lines but not from the file, so positions
  // step over it rather than pretending it was never there.
  const lineOffset = (options.lineOffset ?? 0) + source.length - matter.lines.length
  const script = normalizeScript(options.script)
  // The data a document answers with. Front matter when it wrote some, and an
  // object either way: `tags` and `users` are always there to be asked about,
  // and a document with nothing at the top still refers to things.
  const data =
    matter.matter !== null && typeof matter.matter === 'object'
      ? matter.matter
      : {}
  // Filled as the references are parsed, which is after the code has run and
  // before the transforms do.
  const collect = collectReferences(data)
  // What the document is answering with. The data is on it before a line has
  // run, because it was read off the top first; the tree cannot be, because
  // making it is what the code is for. It is filled in below, once there is
  // one, and the transforms are the first to see it.
  /** @type {import('./script.js').Response} */
  const response = {data, doc: undefined}

  // Code runs before anything is parsed, so the rest of the grammar sees only
  // the document the code produced.
  const expansion = expandScript(
    matter.lines,
    script && {
      ...script,
      response,
      scope: {matter: data, ...script.scope}
    },
    options.file
  )
  // Comments come off after the code has run and before anything is parsed, so
  // a comment can be generated and the grammar never sees one either way.
  const stripped = stripComments(expansion.lines, expansion.map)
  const lines = stripped.lines
  const footnoteSettings = normalizeFootnotes(options.footnotes)
  const footnoteState = footnoteSettings
    ? createFootnotes(footnoteSettings, findDefinitions(lines))
    : undefined
  // Footnote state and the reference list both have to reach wherever in the
  // tree they turn up, so every inline call gets them.
  const inline = {...options, collect, footnoteState}
  const meta = lines.map((line) => {
    const space = leadingSpace.exec(line)[0]
    const content = line.slice(space.length)

    return {indent: indentWidth(space), content, blank: content === ''}
  })

  const children = parseBlocks(0, lines.length, 0)
  const notes = footnoteState?.section()

  if (notes) children.push(notes)

  /** @type {import('hast').Root} */
  let tree = {type: 'root', children}

  if (matter.matter !== undefined) {
    tree.data = {...tree.data, matter: data}

    if (options.file) {
      options.file.data = {...options.file.data, matter: data}
    }
  }

  // A response nobody can read is not one. Whatever the document put on it
  // is the host's, the way the front matter above is.
  if (script && options.file) {
    options.file.data = {...options.file.data, response}
  }

  // The tree exists now, so the document may have it back. A transform is
  // handed it as an argument as well, which is the same object.
  response.doc = tree

  // Whatever the document registered runs last, on the finished tree: it is a
  // unified transform in all but name, written inside the document itself.
  for (const transform of expansion.transforms) {
    try {
      tree = transform(tree) ?? tree
      response.doc = tree
    } catch (error) {
      options.file?.message('Transform failed: ' + error.message, {
        ruleId: 'script',
        source: 'mdy'
      })
    }
  }

  return tree

  /**
   * Give a heading an id to be linked to, when it has the text for one.
   *
   * @param {import('hast').Element} node
   * @returns {import('hast').Element}
   */
  function identify(node) {
    const id = headingState?.id(toText(node))

    if (id) node.properties = {...node.properties, id}

    return node
  }

  /**
   * Parse the lines in `[start, end)`, all of which sit at `base` columns or
   * deeper.
   *
   * @param {number} start
   * @param {number} end
   * @param {number} base
   *   Indentation of this level, in columns.
   * @returns {Array<import('hast').RootContent>}
   */
  function parseBlocks(start, end, base) {
    /** @type {Array<import('hast').RootContent>} */
    const children = []
    /** @type {Array<string>} */
    let open = []
    let openStart = 0

    for (let index = start; index < end; index++) {
      const {blank, content, indent} = meta[index]

      if (blank) {
        closeParagraph(index)
        continue
      }

      // Indented past this level with nothing to name it: an implied `<div>`.
      if (indent >= base + step) {
        closeParagraph(index)

        const stop = regionEnd(index, end, base + step)

        children.push(
          element(
            'div',
            pad(parseBlocks(index, stop, base + step)),
            index,
            stop - 1
          )
        )

        index = stop - 1
        continue
      }

      // Setext first: a line of `=` is otherwise an empty rule 1 heading, and a
      // line of `-` is otherwise an empty list item. Exactly `---` is neither:
      // it belongs to the document separator, so it falls through to the break.
      const rule = open.length ? underline.exec(content) : undefined

      if (rule) {
        const value = open.join(' ')
        const start = openStart

        open = []
        children.push(
          identify(
            element(
              rule[1] ? 'h1' : 'h2',
              parseInline(value, inline),
              start,
              index
            )
          )
        )
        continue
      }

      const fence = tryFence(index, end)

      if (fence) {
        closeParagraph(index)
        children.push(fence.node)
        index = fence.end
        continue
      }

      const definition = footnoteState
        ? definitionLine.exec(content)
        : undefined

      if (definition) {
        closeParagraph(index)
        index = defineFootnote(definition, index, end)
        continue
      }

      // A dashed line is an underline when there is something above it to
      // underline and it is long enough to be one, and a break otherwise.
      const broken = thematicBreak.test(content)
      const heading = broken ? undefined : headingLine.exec(content)
      const html = broken || heading ? undefined : tryHtml(index, end, base)
      const list =
        broken || heading || html ? undefined : tryList(index, end)
      const table =
        broken || heading || html || list
          ? undefined
          : tryTable(index, end, base)

      if (broken || heading || html || list || table) closeParagraph(index)

      if (broken) {
        children.push(element('hr', [], index, index))
        continue
      }

      if (heading) {
        const depth = Math.min(heading[1].length, maxHeadingDepth)

        if (heading[1].length > maxHeadingDepth) {
          warn(
            'Heading level ' +
              heading[1].length +
              ' is deeper than h' +
              maxHeadingDepth +
              ', clamping',
            index,
            'heading-depth'
          )
        }

        children.push(
          identify(
            element('h' + depth, parseInline(heading[2], inline), index, index)
          )
        )
        continue
      }

      if (html) {
        if (html.node) children.push(html.node)
        index = html.end
        continue
      }

      if (list) {
        children.push(...list.nodes)
        index = list.end
        continue
      }

      if (table) {
        children.push(table.node)
        index = table.end
        continue
      }

      if (!open.length) openStart = index

      open.push(content.trimEnd())
    }

    closeParagraph(end)

    return children

    /**
     * @param {number} end
     *   Index of the line that ended the run (exclusive).
     */
    function closeParagraph(end) {
      if (!open.length) return

      const value = open.join(' ')
      const start = openStart

      open = []
      children.push(element('p', parseInline(value, inline), start, end - 1))
    }
  }

  /**
   * Read a fenced code block.
   *
   * Everything up to the closing fence is content, whatever it looks like, so
   * a fence may hold headings, pipes, markers — anything. Content keeps the
   * indentation it has beyond the fence's own, and an unclosed fence runs to
   * the end of what encloses it.
   *
   * @param {number} start
   * @param {number} end
   * @returns {{node: import('hast').Element, end: number} | undefined}
   */
  function tryFence(start, end) {
    const fence = parseFence(meta[start].content)

    if (!fence) return

    const width = meta[start].indent
    /** @type {Array<string>} */
    const code = []
    let index = start + 1
    let last = start

    while (index < end) {
      if (closesFence(meta[index].content, fence.marker)) {
        last = index
        break
      }

      code.push(dedent(lines[index], width))
      last = index
      index += 1
    }

    const value = code.length ? code.join('\n') + '\n' : ''
    const {children, highlighted} = highlightCode(
      value,
      fence.language,
      highlighter
    )
    /** @type {Array<string>} */
    const classes = []

    if (fence.language) classes.push('language-' + fence.language)
    if (highlighted) classes.push('hljs')

    const code_ = element('code', children, start, last)

    if (classes.length) code_.properties = {className: classes}

    return {node: element('pre', [code_], start, last), end: last}
  }

  /**
   * Read a footnote definition and everything that runs on from it.
   *
   * The note is stored rather than placed: it belongs at the end of the
   * document, however far up it was written. Lines under it join on, indented
   * or not, the way footnotes are usually written.
   *
   * @param {RegExpExecArray} definition
   * @param {number} start
   * @param {number} end
   * @returns {number}
   *   Last line consumed.
   */
  function defineFootnote(definition, start, end) {
    const texts = [definition[2].trim()]
    let index = start

    while (index + 1 < end) {
      const next = meta[index + 1]

      // Indentation under a definition is continuation, not structure: this is
      // how notes are written, and how a list item reads its own lines too.
      if (
        next.blank ||
        definitionLine.test(next.content) ||
        headingLine.test(next.content) ||
        thematicBreak.test(next.content)
      ) {
        break
      }

      index += 1
      texts.push(next.content.trimEnd())
    }

    footnoteState.define(
      definition[1],
      parseInline(texts.join(' ').trim(), inline)
    )

    return index
  }

  /**
   * End of the run of lines indented at least `minIndent`, ignoring blank
   * lines but never ending on one.
   *
   * @param {number} start
   * @param {number} end
   * @param {number} minIndent
   * @returns {number}
   */
  function regionEnd(start, end, minIndent) {
    let index = start
    let last = start

    while (index < end) {
      const {blank, indent} = meta[index]

      if (!blank) {
        if (indent < minIndent) break

        last = index + 1
      }

      index += 1
    }

    return last
  }

  /**
   * Try to read an element opener, and everything indented under it.
   *
   * @param {number} index
   * @param {number} end
   * @param {number} base
   * @returns {{node: import('hast').RootContent | undefined, end: number} | undefined}
   */
  function tryHtml(index, end, base) {
    // A whole page has to start somewhere. The doctype is the one line of an
    // HTML document that is not an element, so it is read here rather than
    // left to become a `<div>` named after nothing. Dropped when sanitizing,
    // which is the mode for input somebody else wrote: a fragment has no
    // business declaring what kind of document it is in.
    if (doctypeLine.test(meta[index].content)) {
      return {node: schema ? undefined : {type: 'doctype'}, end: index}
    }

    const opener = parseHtmlLine(meta[index].content)

    if (!opener) return

    const clean = schema
      ? sanitizeOpener(opener, schema)
      : {tagName: opener.tagName, attributes: opener.attributes, strip: false, messages: []}

    for (const message of clean.messages) warn(message, index, 'sanitize')

    const stop = regionEnd(index + 1, end, base + step)

    // A stripped element takes its content with it: the lines are consumed so
    // they cannot reappear as a stray `<div>` further down.
    if (clean.strip) {
      return {node: undefined, end: Math.max(index, stop - 1)}
    }

    // Void elements hold nothing, so anything written for them is a mistake
    // worth pointing at rather than silently swallowing.
    if (htmlVoidElements.includes(clean.tagName)) {
      if (opener.text || stop > index + 1) {
        warn(
          '`<' + clean.tagName + '>` cannot have content, ignoring it',
          index,
          'void-element'
        )
      }

      return {
        node: element(
          clean.tagName,
          [],
          index,
          index,
          pageLinks(clean.tagName, toProperties(clean.attributes))
        ),
        end: index
      }
    }

    // Elements whose content is text and nothing else. Markup inside a
    // `<script>` is not markup, and parsing it as if it were is how a
    // stylesheet ends up with `<em>` in it. The lines come through as
    // written, minus the indentation that put them in here.
    if (rawText.has(clean.tagName)) {
      const inner = []

      for (let line = index + 1; line < stop; line += 1) {
        inner.push(dedent(lines[line], base + step))
      }

      return {
        node: element(
          clean.tagName,
          opener.text || inner.length > 0
            ? [{type: 'text', value: [opener.text, ...inner].filter(Boolean).join('\n')}]
            : [],
          index,
          Math.max(index, stop - 1),
          toProperties(clean.attributes)
        ),
        end: Math.max(index, stop - 1)
      }
    }

    /** @type {Array<import('hast').ElementContent>} */
    const children = opener.text ? parseInline(opener.text, inline) : []

    if (stop > index + 1) {
      for (const child of parseBlocks(index + 1, stop, base + step)) {
        children.push({type: 'text', value: '\n'}, child)
      }

      children.push({type: 'text', value: '\n'})
    }

    return {
      node: element(
        clean.tagName,
        children,
        index,
        Math.max(index, stop - 1),
        pageLinks(clean.tagName, toProperties(clean.attributes))
      ),
      end: Math.max(index, stop - 1)
    }
  }

  /**
   * Tidy an `<a>` that points at a page of our own, and write it down.
   *
   * A written `<a href>` is a link like any other, so it is read the way
   * `[[ … ]]` is: somebody else's URL and a fragment of this page are left as
   * they were, and a page of our own is lower cased with its spaces as dashes.
   *
   * @param {string} tagName
   * @param {import('hast').Properties} properties
   * @returns {import('hast').Properties}
   */
  function pageLinks(tagName, properties) {
    if (tagName !== 'a' || typeof properties.href !== 'string') {
      return properties
    }

    if (linkKind(properties.href) !== 'page') return properties

    const href = normalizeLink(properties.href)

    collect('link', href)

    return {...properties, href}
  }

  /**
   * Try to read a list starting at `start`.
   *
   * Items collect their own lazy continuation lines, exactly as a paragraph
   * would, and indentation inside a list means list nesting rather than the
   * `<div>` nesting it means everywhere else.
   *
   * @param {number} start
   * @param {number} end
   * @returns {{nodes: Array<import('hast').Element>, end: number} | undefined}
   */
  function tryList(start, end) {
    if (!parseItemLine(lines[start])) return

    /** @type {Array<{indent: number, ordered: boolean, start: number | undefined, texts: Array<string>, line: number, end: number}>} */
    const items = []
    let index = start
    let last = start
    let loose = false
    let blank = false

    while (index < end) {
      if (meta[index].blank) {
        blank = true
        index += 1
        continue
      }

      const line = meta[index].content

      if (headingLine.test(line) || thematicBreak.test(line)) break

      const item = parseItemLine(lines[index])

      if (item) {
        // A blank line inside the list makes the whole thing loose: every item
        // gets a paragraph rather than bare text.
        if (blank) loose = true

        items.push({...item, texts: [item.text], line: index, end: index})
      } else {
        // A blank line followed by anything other than an item ends the list.
        if (blank) break

        items.at(-1).texts.push(meta[index].content.trimEnd())
        items.at(-1).end = index
      }

      blank = false
      last = index
      index += 1
    }

    /** @type {Array<List>} */
    const roots = []
    /** @type {Array<List>} */
    const stack = []

    for (const item of items) {
      while (stack.length && item.indent < stack.at(-1).indent) stack.pop()

      // Switching between bullets and numbers at the same depth ends one list
      // and opens its sibling, rather than mixing them.
      if (
        stack.length &&
        item.indent === stack.at(-1).indent &&
        item.ordered !== stack.at(-1).ordered
      ) {
        stack.pop()
      }

      if (!stack.length || item.indent > stack.at(-1).indent) {
        const list = {
          indent: item.indent,
          ordered: item.ordered,
          start: item.start,
          entries: []
        }

        if (stack.length) stack.at(-1).entries.at(-1).children.push(list)
        else roots.push(list)

        stack.push(list)
      }

      stack.at(-1).entries.push({
        texts: item.texts,
        children: [],
        checked: item.checked,
        column: item.column,
        line: item.line,
        end: item.end
      })
    }

    return {nodes: roots.map((list) => listNode(list, loose)), end: last}
  }

  /**
   * @typedef Entry
   * @property {Array<string>} texts
   * @property {Array<List>} children
   * @property {boolean | undefined} checked
   * @property {number} column
   * @property {number} line
   * @property {number} end
   *
   * @typedef List
   * @property {number} indent
   * @property {boolean} ordered
   * @property {number | undefined} start
   * @property {Array<Entry>} entries
   */

  /**
   * @param {List} list
   * @param {boolean} loose
   *   Whether item content is wrapped in a paragraph.
   * @returns {import('hast').Element}
   */
  function listNode(list, loose) {
    const items = list.entries.map((entry) => {
      const content = parseInline(entry.texts.join(' '), inline)
      const task = typeof entry.checked === 'boolean'

      if (task) {
        // GFM renders the box as a disabled checkbox at the head of the item,
        // with a space before the text when there is any.
        if (content.length) content.unshift({type: 'text', value: ' '})

        const box = tasks
          ? taskForm(tasks, {
              checked: entry.checked,
              line: sourceLine(entry.line) + 1 + lineOffset,
              column: entry.column,
              label: toText({type: 'element', children: [...content]}).trim()
            })
          : element('input', [], entry.line, entry.line, {
              type: 'checkbox',
              checked: entry.checked,
              disabled: true
            })

        content.unshift(box)
      }

      /** @type {Array<import('hast').ElementContent>} */
      const children = loose
        ? pad([element('p', content, entry.line, entry.end)])
        : [...content]

      for (const child of entry.children) {
        if (!loose) children.push({type: 'text', value: '\n'})
        children.push(listNode(child, loose), {type: 'text', value: '\n'})
      }

      return element(
        'li',
        children,
        entry.line,
        entryEnd(entry),
        task ? {className: ['task-list-item']} : {}
      )
    })

    /** @type {import('hast').Properties} */
    const properties = {}

    if (list.entries.some((entry) => typeof entry.checked === 'boolean')) {
      properties.className = ['contains-task-list']
    }

    // `<ol>` counts from 1 on its own; only say otherwise when asked to.
    if (list.ordered && list.start !== undefined && list.start !== 1) {
      properties.start = list.start
    }

    return element(
      list.ordered ? 'ol' : 'ul',
      pad(items),
      list.entries[0].line,
      entryEnd(list.entries.at(-1)),
      properties
    )
  }

  /**
   * Last line covered by an entry, including anything nested inside it.
   *
   * @param {Entry} entry
   * @returns {number}
   */
  function entryEnd(entry) {
    return Math.max(
      entry.end,
      ...entry.children.map((child) => entryEnd(child.entries.at(-1)))
    )
  }

  /**
   * Try to read a table starting at `start`.
   *
   * Unlike a paragraph, a table needs a look-ahead: the line only turns out to
   * be a header once the next line proves to be a matching delimiter row. A
   * caption above it pushes that look-ahead one line further.
   *
   * @param {number} start
   * @param {number} end
   * @param {number} base
   * @returns {{node: import('hast').Element, end: number} | undefined}
   */
  function tryTable(start, end, base) {
    const caption = tryCaption(start, end)
    const first = caption ? start + 1 : start
    const header = splitRow(meta[first].content)

    if (!header.delimited || first + 1 >= end) return

    const alignments = parseDelimiterRow(meta[first + 1].content)

    // GFM: the delimiter row has to agree with the header on column count,
    // otherwise none of this is a table.
    if (!alignments || alignments.length !== header.cells.length) return

    // A `<caption>` is the table's first child wherever it is meant to show:
    // which side it renders on is `caption-side` in CSS, not a fact about the
    // document.
    const rows = caption ? [caption] : []

    rows.push(
      element(
        'thead',
        pad([row(header.cells, 'th', alignments, first)]),
        first,
        first
      )
    )

    let last = first + 1
    /** @type {Array<import('hast').ElementContent>} */
    const body = []

    while (last + 1 < end) {
      const {blank, content, indent} = meta[last + 1]

      if (
        blank ||
        indent >= base + step ||
        // An opener is an element everywhere else, so it ends the table here
        // rather than being read as one more row of it.
        content.startsWith('<') ||
        headingLine.test(content) ||
        thematicBreak.test(content)
      ) {
        break
      }

      last += 1
      body.push(row(splitRow(content).cells, 'td', alignments, last))
    }

    if (body.length) {
      rows.push(element('tbody', pad(body), first + 2, last))
    }

    return {node: element('table', pad(rows), start, last), end: last}
  }

  /**
   * Try to read a caption at `start`: one cell, opening with a pipe, directly
   * above a line that starts a table of its own.
   *
   * That last condition is the whole of it. A caption is written exactly the
   * way a one-column table's header is, and what tells them apart is what
   * comes next: a header has a delimiter row under it, a caption has a table.
   *
   * @param {number} start
   * @param {number} end
   * @returns {import('hast').Element | undefined}
   */
  function tryCaption(start, end) {
    const {content} = meta[start]

    if (!content.startsWith('|') || start + 2 >= end) return

    const {cells} = splitRow(content)

    if (cells.length !== 1 || !cells[0]) return

    const header = splitRow(meta[start + 1].content)
    const alignments = parseDelimiterRow(meta[start + 2].content)

    if (!header.delimited || !alignments) return
    if (alignments.length !== header.cells.length) return

    return element(
      'caption',
      parseInline(unescapePipes(cells[0]), inline),
      start,
      start
    )
  }

  /**
   * Build one `<tr>`, padding short rows and dropping cells past the last
   * column, as GFM does.
   *
   * @param {Array<string>} cells
   * @param {'th' | 'td'} tagName
   * @param {Array<'left' | 'center' | 'right' | undefined>} alignments
   * @param {number} line
   * @returns {import('hast').Element}
   */
  function row(cells, tagName, alignments, line) {
    const children = alignments.map((align, column) => {
      const properties = align
        ? tableAlign === 'attribute'
          ? {align}
          : {style: 'text-align: ' + align}
        : {}

      return element(
        tagName,
        parseInline(unescapePipes(cells[column] ?? ''), inline),
        line,
        line,
        properties
      )
    })

    return element('tr', pad(children), line, line)
  }

  /**
   * Put each child on its own line, the way `mdast-util-to-hast` lays tables
   * out, so serialised output stays readable.
   *
   * @param {Array<import('hast').ElementContent>} children
   * @returns {Array<import('hast').ElementContent>}
   */
  function pad(children) {
    /** @type {Array<import('hast').ElementContent>} */
    const result = [{type: 'text', value: '\n'}]

    for (const child of children) {
      result.push(child, {type: 'text', value: '\n'})
    }

    return result
  }

  /**
   * @param {string} tagName
   * @param {Array<import('hast').ElementContent>} children
   * @param {number} startLine
   * @param {number} endLine
   * @param {import('hast').Properties} [properties]
   * @returns {import('hast').Element}
   */
  function element(tagName, children, startLine, endLine, properties) {
    return {
      type: 'element',
      tagName,
      properties: properties ?? {},
      children,
      position: position(startLine, endLine)
    }
  }

  /**
   * @param {number} startLine
   * @param {number} endLine
   */
  function position(startLine, endLine) {
    return {
      start: {line: sourceLine(startLine) + 1 + lineOffset, column: 1},
      end: {
        line: sourceLine(endLine) + 1 + lineOffset,
        column: (lines[endLine]?.length ?? 0) + 1
      }
    }
  }

  /**
   * Which line of the source a parsed line came from. They differ once code has
   * generated lines of its own.
   *
   * @param {number} index
   * @returns {number}
   */
  function sourceLine(index) {
    return stripped.map?.[index] ?? index
  }

  /**
   * @param {string} reason
   * @param {number} line
   * @param {string} ruleId
   */
  function warn(reason, line, ruleId) {
    options.file?.message(reason, {
      place: position(line, line),
      ruleId,
      source: 'mdy'
    })
  }
}
