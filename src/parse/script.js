import {h} from 'hastscript'
import {visit} from 'unist-util-visit'
import {defaultResolve} from './wiki.js'

const scriptLine = /^[ \t]*%(.*)$/
const blockLine = /^[ \t]*%%(.*)$/
const escapedLine = /^([ \t]*)\\(%)/
const quoteEnd = {single: "'", double: '"', template: '`'}
const quoteMode = {"'": 'single', '"': 'double', '`': 'template'}
const opener = '{{'
const closer = '}}'
const escapes = {'\\': '\\\\', '`': '\\`', $: '\\$'}

/**
 * @typedef Position
 * @property {number} line
 *   Zero-based line in the document.
 * @property {number} column
 *   Zero-based index into that line, as written.
 *
 * @typedef Pair
 * @property {Position} open
 * @property {Position} close
 *
 * @typedef State
 * @property {number} depth
 *   Brackets opened and not yet closed.
 * @property {Array<string>} modes
 *   What the scanner is inside of: a quote, a comment, a `${…}`.
 * @property {Array<number>} braces
 *   Braces counted inside each `${…}`, so the one closing it is known.
 *
 * @typedef Response
 * @property {unknown} data
 *   The document's front matter, parsed. Ready before a line of the
 *   document has run, because it is read off the top before anything else.
 * @property {import('hast').Root | undefined} doc
 *   The finished tree. Nothing has been parsed while the body of the code is
 *   running, so this is undefined until it is: a `transform` is where a
 *   document meets its own tree.
 *
 * @typedef Settings
 * @property {Record<string, unknown>} scope
 *   Values handed to the document as variables.
 * @property {unknown} request
 *   Handed to the document as `req`. Whatever the host is answering: a URL,
 *   a query, a session — MDY neither reads it nor cares what shape it is.
 * @property {Response} [response]
 *   Handed to the document as `res`. Made by the caller, because the tree is
 *   put on it after the code has run and before the transforms do.
 */

/**
 * Resolve the `script` option.
 *
 * Off unless asked for: this runs the document's own code, and a markup
 * processor has no business doing that to input it was merely given.
 *
 * @param {boolean | Partial<Settings> | undefined} script
 * @returns {Settings | undefined}
 */
export function normalizeScript(script) {
  if (!script) return

  const settings = script === true ? undefined : script

  return {
    scope: settings?.scope ?? {},
    request: settings?.request ?? {}
  }
}

/**
 * Whether a line is code rather than content.
 *
 * Leading space is allowed and carries no meaning: a `%` line is taken out of
 * the document before any column is counted, so how far in the author writes
 * their code is their own business and none of the markup's.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isScriptLine(line) {
  return scriptLine.test(line)
}

/**
 * Read a run of code, and say what it leaves open.
 *
 * Enough of JavaScript to know a bracket from a character that only looks like
 * one: quotes of all three kinds, and comments of both. Not regular
 * expressions — a `/` is a character here, so a pattern holding a lone bracket
 * throws the count off. That costs nothing, because a count that never comes
 * back to even takes no lines at all.
 *
 * @param {string} text
 * @param {State} state
 *   Carried from line to line: a string or a comment may span them.
 * @param {{line: number, column: number}} [at]
 *   Where `text` sits in the document. Given one, the scanner pairs the
 *   brackets up as it goes and leaves the pairs on the state.
 * @returns {void}
 */
function scan(text, state, at) {
  let index = 0

  while (index < text.length) {
    const character = text.charAt(index)
    const next = text.charAt(index + 1)
    const mode = state.modes.at(-1)

    if (mode === 'block') {
      if (character === '*' && next === '/') {
        state.modes.pop()
        index += 1
      }

      index += 1
      continue
    }

    if (mode === 'single' || mode === 'double' || mode === 'template') {
      if (character === '\\') {
        index += 2
        continue
      }

      if (character === quoteEnd[mode]) state.modes.pop()
      else if (mode === 'template' && character === '$' && next === '{') {
        state.modes.push('expression')
        state.braces.push(0)
        index += 1
      }

      index += 1
      continue
    }

    // A line comment runs to the end of whatever it was handed.
    if (character === '/' && next === '/') return

    if (character === '/' && next === '*') {
      state.modes.push('block')
      index += 2
      continue
    }

    if (quoteMode[character]) {
      state.modes.push(quoteMode[character])
      index += 1
      continue
    }

    if (character === '(' || character === '[') {
      state.depth += 1
      opened(character)
    } else if (character === ')' || character === ']') {
      if (state.depth > 0) state.depth -= 1
      closed(character === ')' ? '(' : '[')
    } else if (character === '{') {
      state.depth += 1
      if (mode === 'expression') state.braces[state.braces.length - 1] += 1
      opened(character)
    } else if (character === '}') {
      if (state.depth > 0) state.depth -= 1

      // The `}` that closes a `${` hands the line back to its template.
      if (mode === 'expression') {
        if (state.braces.at(-1) === 0) {
          state.modes.pop()
          state.braces.pop()
        } else state.braces[state.braces.length - 1] -= 1
      }

      closed('{')
    }

    index += 1
  }

  /**
   * Remember an opening bracket, when anyone asked to be told.
   *
   * @param {string} character
   */
  function opened(character) {
    if (!at || !state.stack) return

    state.stack.push({line: at.line, column: at.column + index, character})
  }

  /**
   * Close the bracket this one belongs to.
   *
   * A closer with nothing under it, or with an opener of the wrong shape under
   * it, belongs to nothing. The stack is left alone in that case, so whatever
   * is genuinely open still gets its closer.
   *
   * @param {string} wanted
   */
  function closed(wanted) {
    if (!at || !state.stack) return

    const close = {line: at.line, column: at.column + index}
    const open = state.stack.at(-1)

    if (!open || open.character !== wanted) {
      state.loose?.push(close)
      return
    }

    state.stack.pop()
    state.pairs?.push({open: {line: open.line, column: open.column}, close})
  }
}

/**
 * Whether a run of code has left anything open.
 *
 * @param {State} state
 * @returns {boolean}
 */
function open(state) {
  return state.depth > 0 || state.modes.length > 0
}

/**
 * Which lines of a document are code.
 *
 * A `%` line is one line of it, always. What it leaves open encloses the markup
 * under it, which is the whole of how a loop is written, so its brackets are
 * not counted and must not be.
 *
 * A `%%` line says the opposite — that what follows it is more code — and runs
 * on into the lines under it as far as the line that brings its brackets back
 * to even. Round, square and curly all count, so a function can be written as
 * itself:
 *
 *     %% transform((tree) => {
 *       visit(tree, 'element', (node) => {
 *         node.properties.id = slug(toText(node))
 *       })
 *     })
 *
 * Nothing is taken unless the closing line is really there. An unclosed bracket
 * leaves the `%%` line on its own, to fail as the one line it is, rather than
 * swallowing the document behind it.
 *
 * @param {Array<string>} lines
 * @returns {Array<boolean>}
 *   True wherever a line is code rather than content.
 */
export function scriptLines(lines) {
  /** @type {Array<boolean>} */
  const code = lines.map(() => false)

  for (let index = 0; index < lines.length; index += 1) {
    if (!isScriptLine(lines[index])) continue

    code[index] = true

    const block = blockLine.exec(lines[index])

    if (!block) continue

    /** @type {State} */
    const state = {depth: 0, modes: [], braces: []}

    scan(block[1], state)

    if (!open(state)) continue

    let last = index

    for (let ahead = index + 1; ahead < lines.length; ahead += 1) {
      // Another code line starts its own; this one never closed.
      if (isScriptLine(lines[ahead])) break

      scan(lines[ahead], state)

      if (!open(state)) {
        last = ahead
        break
      }
    }

    if (last === index) continue

    for (let line = index + 1; line <= last; line += 1) code[line] = true

    index = last
  }

  return code
}

/**
 * Where the brackets of a document's code pair up.
 *
 * The code lines are read as the one stream they are compiled into, so a `{`
 * on a `%` line finds the `}` on the `%` line further down and the markup
 * between them is stepped over — which is exactly the extent of the loop the
 * two of them make.
 *
 * Positions are zero-based, and a column is an index into the line as written,
 * sigil and indentation included.
 *
 * @param {Array<string>} lines
 * @returns {{pairs: Array<Pair>, loose: Array<Position>}}
 *   Every pair that closed, and every bracket that never found its partner.
 */
export function scriptBrackets(lines) {
  const code = scriptLines(lines)
  /** @type {State & {stack: Array<Position & {character: string}>, pairs: Array<Pair>, loose: Array<Position>}} */
  const state = {depth: 0, modes: [], braces: [], stack: [], pairs: [], loose: []}

  for (const [index, line] of lines.entries()) {
    if (!code[index]) continue

    const match = blockLine.exec(line) ?? scriptLine.exec(line)
    const text = match ? match[1] : line

    scan(text, state, {line: index, column: line.length - text.length})
  }

  // Whatever is still open never closed.
  for (const open of state.stack) {
    state.loose.push({line: open.line, column: open.column})
  }

  return {pairs: state.pairs, loose: state.loose}
}

/**
 * Compile a document into the program that produces its lines.
 *
 * The document becomes a run of JavaScript statements: every `%` line goes in
 * as the code it is, and every other line becomes a template literal pushed
 * onto `__out`, an array of `[line, text]` the statements declare and fill.
 *
 *     % for (const name of names) {        const __out = []
 *     - {{ name }}                 ──►     for (const name of names) {
 *     % }                                    __out.push([1, `- ${name}`])
 *                                          }
 *
 * So a `%` line that opens a block encloses the content lines under it, and
 * `{{ … }}` in content is an expression to interpolate. Only content lines
 * reach the output, so the indentation the block parser reads is the content's
 * alone: a `%` line may sit anywhere across the page — hard against the
 * margin, level with the markup it encloses, stepped in with the JavaScript
 * block it opens — without moving any of it.
 *
 * What runs the statements is somebody else's business. `expandScript` below
 * runs them here, in this process, with `new Function`; a host with a sandbox
 * of its own puts them inside that instead and hands the `__out` it gets back
 * to `scriptOutput`. Neither is privileged, and this function knows about
 * neither — which is the whole point of it being a function.
 *
 * @param {Array<string>} lines
 * @returns {{source: string, code: Array<boolean>}}
 *   The statements, and which lines of the document went in as code.
 */
export function compileScript(lines) {
  const code = scriptLines(lines)
  const body = ['const __out = []']

  for (const [index, line] of lines.entries()) {
    if (code[index]) {
      // A line a `%%` took up is code entire; a `%` or `%%` line is what it
      // wrote behind its sigil.
      const match = blockLine.exec(line) ?? scriptLine.exec(line)

      body.push(match ? match[1] : line)
    } else {
      body.push('__out.push([' + index + ', `' + compileLine(line) + '`])')
    }
  }

  return {source: body.join('\n'), code}
}

/**
 * Flatten what a program returned into lines, and where each of them came from.
 *
 * One push can still yield several lines, when what was interpolated had
 * newlines in it. They all came from the same place, and saying so is the only
 * honest answer a position can give for a line written inside a loop.
 *
 * @param {Array<[number, string]> | undefined} output
 * @returns {{lines: Array<string>, map: Array<number>}}
 */
export function scriptOutput(output) {
  /** @type {Array<string>} */
  const lines = []
  /** @type {Array<number>} */
  const map = []

  for (const [source, text] of output ?? []) {
    for (const part of String(text).split(/\r\n|\r|\n/)) {
      lines.push(part)
      map.push(source)
    }
  }

  return {lines, map}
}

/**
 * Whether a document holds anything for the script stage to do at all.
 *
 * @param {Array<string>} lines
 * @returns {boolean}
 */
export function hasScript(lines) {
  return lines.some(hasCode)
}

/**
 * Run a document's code and return the lines it produced.
 *
 * The document is compiled into a function: every `%` line goes in as the code
 * it is, and every other line becomes a template literal pushed onto the
 * output. So a `%` line that opens a block encloses the content lines under it,
 * and `{{ … }}` in content is an expression to interpolate.
 *
 *     % for (const name of names) {        for (const name of names) {
 *     - {{ name }}                 ──►       out.push(`- ${name}`)
 *     % }                                  }
 *
 * Only content lines reach the output, so the indentation the block parser
 * reads is the content's alone. A `%` line may sit anywhere across the page —
 * hard against the margin, level with the markup it encloses, stepped in with
 * the JavaScript block it opens — without moving any of it.
 *
 * Nothing here is a sandbox. The code runs with whatever the host gives it.
 *
 * A document may also register functions to run on the finished tree, before it
 * is turned into HTML. They arrive back with the lines, for the caller to apply
 * once there is a tree to apply them to.
 *
 * @param {Array<string>} lines
 * @param {Settings | undefined} settings
 * @param {import('vfile').VFile} [file]
 * Each output line remembers the line it was written on, so a position can
 * still name somewhere a person could go and edit. Lines from inside a loop all
 * point at the one line in the source that produced them, which is the only
 * honest answer.
 *
 * @returns {{lines: Array<string>, map: Array<number> | undefined, transforms: Array<Function>}}
 */
export function expandScript(lines, settings, file) {
  /** @type {Array<Function>} */
  const transforms = []

  // Documents with neither code nor an expression are left exactly as they are.
  if (!settings || !hasScript(lines)) {
    return {lines, map: undefined, transforms}
  }

  const {source, code} = compileScript(lines)

  // What the document can reach. The host's own values are merged in next, so
  // a scope may deliberately shadow any of the toolkit.
  const scope = new Map(
    Object.entries({
      transform: (fn) => void transforms.push(fn),
      visit,
      h,
      toText,
      slug: defaultResolve
    })
  )

  for (const entry of Object.entries(settings.scope)) scope.set(...entry)

  // The two the document is called with, set after the scope rather than
  // before it: a document may shadow a helper, but not the pair it is
  // answering with.
  scope.set('req', settings.request)
  scope.set('res', settings.response)

  try {
    const run = new Function(...scope.keys(), source + '\nreturn __out')
    const {lines: result, map} = scriptOutput(run(...scope.values()))

    return {lines: result, map, transforms}
  } catch (error) {
    file?.message('Script failed: ' + error.message, {
      ruleId: 'script',
      source: 'mdy'
    })

    // Show the prose rather than a blank page: half-written code is the normal
    // state of a document being edited.
    /** @type {Array<string>} */
    const result = []
    /** @type {Array<number>} */
    const map = []

    for (const [index, line] of lines.entries()) {
      if (code[index]) continue

      result.push(line)
      map.push(index)
    }

    return {lines: result, map, transforms: []}
  }
}

/**
 * All the text under a node, with the markup taken off.
 *
 * @param {import('hast').Node} node
 * @returns {string}
 */
export function toText(node) {
  if (!node) return ''
  if (node.type === 'text') return node.value
  if (node.type === 'comment' || node.type === 'doctype') return ''

  return (node.children ?? []).map((child) => toText(child)).join('')
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function hasCode(line) {
  return isScriptLine(line) || line.includes(opener) || escapedLine.test(line)
}

/**
 * Turn one content line into the body of a template literal.
 *
 * `{{ … }}` becomes an interpolation and everything else becomes text, which
 * means escaping the three characters a template literal reads: a backslash, so
 * MDY's own `\!!` escapes survive; a backtick, so code spans do; and a dollar,
 * so `${` in a document is only ever the two characters it looks like.
 *
 * A backslash before `{{` opts a line out, for documents that need to show the
 * syntax rather than use it, and a backslash before the `%` a line opens with
 * does the same for a code line. That one is taken off here rather than left to
 * the inline rules, so it comes off in a fenced block too — nothing is raw to
 * this stage, so a block showing MDY needs the escape as much as prose does.
 *
 * @param {string} value
 * @returns {string}
 */
function compileLine(value) {
  const line = value.replace(escapedLine, '$1$2')
  let result = ''
  let index = 0

  while (index < line.length) {
    const character = line.charAt(index)

    if (character === '\\' && line.startsWith(opener, index + 1)) {
      result += opener
      index += 1 + opener.length
      continue
    }

    if (line.startsWith(opener, index)) {
      const close = line.indexOf(closer, index + opener.length)

      if (close !== -1) {
        result += '${' + line.slice(index + opener.length, close) + '}'
        index = close + closer.length
        continue
      }
    }

    result += escapes[character] ?? character
    index += 1
  }

  return result
}
