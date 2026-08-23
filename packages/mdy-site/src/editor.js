/**
 * A source editor built out of a textarea.
 *
 * The textarea stays the thing you type into — it keeps the caret, the native
 * undo stack, spellcheck, IME, and every shortcut the platform has — and it is
 * made transparent so that a painted copy of the same text shows through from
 * behind it. A gutter beside them numbers the lines. The three scroll as one,
 * which is the whole trick: identical metrics, one scroll position.
 */

const indent = '  '
const leading = /^[ \t]*/

/**
 * @typedef Options
 * @property {string} [value]
 *   Text to start with.
 * @property {(source: string) => string} highlight
 *   Paints source into HTML with one output line per source line.
 * @property {() => void} [onInput]
 *   Called after the text changes, however it changed.
 * @property {(position: {line: number, column: number}) => void} [onCaret]
 *   Called when the caret moves.
 * @property {(source: string) => Array<{from: number, to: number}>} [regions]
 *   Runs of lines to band together, both ends inclusive and zero-based.
 * @property {(source: string) => {pairs: Array<Pair>, loose: Array<Position>}} [brackets]
 *   Where the brackets pair up, so the caret can point at the partner of the
 *   one it is beside.
 * @property {Record<string, string>} [attributes]
 *   Put on the textarea, so the caller keeps hold of its id and labelling.
 */

/**
 * @typedef Position
 * @property {number} line
 * @property {number} column
 *
 * @typedef Pair
 * @property {Position} open
 * @property {Position} close
 */

/**
 * Build an editor inside `host`.
 *
 * @param {HTMLElement} host
 * @param {Options} options
 */
export function createEditor(host, options) {
  const {highlight, onInput, onCaret, regions, brackets, attributes = {}} =
    options

  host.classList.add('editor')
  host.innerHTML = `
    <div class="editor-gutter" aria-hidden="true"></div>
    <div class="editor-frame">
      <div class="editor-current" aria-hidden="true"></div>
      <div class="editor-blocks" aria-hidden="true"></div>
      <div class="editor-brackets" aria-hidden="true"></div>
      <pre class="editor-paint" aria-hidden="true"><code></code></pre>
      <span class="editor-ruler" aria-hidden="true">0000000000</span>
      <textarea class="editor-input" wrap="off" spellcheck="false"
        autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
    </div>
  `

  const gutter = host.querySelector('.editor-gutter')
  const paint = host.querySelector('.editor-paint')
  const painted = paint.querySelector('code')
  const current = host.querySelector('.editor-current')
  const blocks = host.querySelector('.editor-blocks')
  const pairs = host.querySelector('.editor-brackets')
  const ruler = host.querySelector('.editor-ruler')
  const input = host.querySelector('.editor-input')
  /** @type {{pairs: Array<Pair>, loose: Array<Position>}} */
  let matched = {pairs: [], loose: []}

  for (const [name, value] of Object.entries(attributes)) {
    input.setAttribute(name, value)
  }

  let numbered = 0
  let frame = 0
  let metrics = measure()

  input.value = options.value ?? ''
  input.setSelectionRange(0, 0)
  draw()

  input.addEventListener('input', () => {
    schedule()
    onInput?.()
  })

  input.addEventListener('scroll', sync)
  input.addEventListener('keydown', keydown)
  input.addEventListener('focus', caret)
  input.addEventListener('blur', caret)

  window.addEventListener('resize', () => {
    metrics = measure()
    place()
  })

  // The caret moves for reasons no event on the textarea covers, like a drag
  // that ends outside it, so the document is the one to ask.
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === input) caret()
  })

  return {
    get value() {
      return input.value
    },
    set value(next) {
      if (next === input.value) return

      // Writing to a textarea sends the caret to the end, and this is how a
      // task box edits the line it sits on: keep the selection where it was.
      const {selectionStart: start, selectionEnd: end} = input

      input.value = next
      input.setSelectionRange(
        Math.min(start, next.length),
        Math.min(end, next.length)
      )
      draw()
    },
    focus() {
      input.focus()
    },
    refresh: draw,
    input
  }

  /* --------------------------------------------------------- drawing -- */

  function schedule() {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(draw)
  }

  function draw() {
    cancelAnimationFrame(frame)

    const source = input.value
    const count = source.split('\n').length

    // A trailing newline of its own keeps the last line's box in the painted
    // layer, so a document that ends in a blank line still lines up.
    metrics = measure()
    painted.innerHTML = highlight(source) + '\n'

    if (count !== numbered) {
      let numbers = ''

      for (let line = 1; line <= count; line += 1) {
        numbers += '<span>' + line + '</span>'
      }

      gutter.innerHTML = numbers
      numbered = count
    }

    matched = brackets?.(source) ?? {pairs: [], loose: []}
    band(source)
    sync()
    caret()
  }

  /**
   * Draw a band down each run of lines the caller called a region. They are
   * laid out like the current-line band: outside the scrolling layers, moved
   * by hand.
   *
   * @param {string} source
   */
  function band(source) {
    const found = regions?.(source) ?? []
    let markup = ''

    for (const {from, to} of found) {
      markup +=
        '<div data-from="' + from + '" data-to="' + (to + 1) + '"></div>'
    }

    blocks.innerHTML = markup
    place()
  }

  function sync() {
    paint.scrollTop = input.scrollTop
    paint.scrollLeft = input.scrollLeft
    gutter.scrollTop = input.scrollTop
    place()
  }

  /* ----------------------------------------------------------- caret -- */

  function caret() {
    const before = input.value.slice(0, input.selectionStart)
    const rows = before.split('\n')
    const line = rows.length
    const active = document.activeElement === input

    host.classList.toggle('is-focused', active)

    const marked = gutter.querySelector('.is-current')
    const wanted = active ? gutter.children[line - 1] : undefined

    if (marked !== wanted) {
      marked?.classList.remove('is-current')
      wanted?.classList.add('is-current')
    }

    place(line)
    point(line - 1, rows[rows.length - 1].length, active)
    onCaret?.({line, column: rows[rows.length - 1].length + 1})
  }

  /**
   * Outline the bracket the caret is beside and the one it pairs with.
   *
   * Either side counts, the way an editor usually has it: the caret is beside
   * a bracket when one sits immediately before it or immediately after.
   *
   * @param {number} line
   *   Zero-based.
   * @param {number} column
   *   Zero-based index of the caret within the line.
   * @param {boolean} active
   */
  function point(line, column, active) {
    pairs.innerHTML = ''

    if (!active || !brackets) return

    const found = matched.pairs.find(
      (pair) =>
        beside(pair.open, line, column) || beside(pair.close, line, column)
    )

    if (found) {
      const open = mark(found.open, '')
      const close = mark(found.close, '')

      // Both or neither: half a pair points at nothing in particular.
      if (open && close) pairs.innerHTML = open + close

      place()
      return
    }

    // Nothing pairs with it, which is worth saying: an unclosed bracket is why
    // a `%%` block stops where it does.
    const alone = matched.loose.find((at) => beside(at, line, column))

    if (alone) pairs.innerHTML = mark(alone, ' is-loose')

    place()
  }

  /**
   * @param {Position} at
   * @param {number} line
   * @param {number} column
   * @returns {boolean}
   */
  function beside(at, line, column) {
    return at.line === line && (at.column === column || at.column === column - 1)
  }

  /**
   * One bracket's box. A tab makes a column no longer a count of characters,
   * so a line holding one before the bracket is left unmarked rather than
   * marked in the wrong place.
   *
   * @param {Position} at
   * @param {string} extra
   * @returns {string}
   */
  function mark(at, extra) {
    const line = input.value.split('\n')[at.line] ?? ''

    if (line.slice(0, at.column).includes('\t')) return ''

    return (
      '<span class="editor-bracket' +
      extra +
      '" data-line="' +
      at.line +
      '" data-column="' +
      at.column +
      '"></span>'
    )
  }

  /**
   * Put the current-line band where the caret is. It sits outside the
   * scrolling layers, so it is moved by hand rather than scrolled.
   *
   * @param {number} [line]
   */
  function place(line) {
    if (line !== undefined) current.dataset.line = String(line)

    const at = Number(current.dataset.line ?? 1)
    const {height, top, left, width} = metrics

    current.style.height = height + 'px'
    current.style.transform =
      'translateY(' + ((at - 1) * height + top - input.scrollTop) + 'px)'

    for (const band of blocks.children) {
      const from = Number(band.dataset.from)

      band.style.height = (Number(band.dataset.to) - from) * height + 'px'
      band.style.transform =
        'translateY(' + (from * height + top - input.scrollTop) + 'px)'
    }

    for (const bracket of pairs.children) {
      bracket.style.width = width + 'px'
      bracket.style.height = height + 'px'
      bracket.style.transform =
        'translate(' +
        (Number(bracket.dataset.column) * width + left - input.scrollLeft) +
        'px, ' +
        (Number(bracket.dataset.line) * height + top - input.scrollTop) +
        'px)'
    }
  }

  /**
   * Read the metrics the band is placed with. Both come from the stylesheet,
   * so they are read back rather than written down twice.
   */
  function measure() {
    const style = getComputedStyle(input)

    return {
      height: parseFloat(style.lineHeight) || 20,
      top: parseFloat(style.paddingTop) || 0,
      left: parseFloat(style.paddingLeft) || 0,
      // Ten characters of the pane's own font, divided back down. One would
      // round badly at this size; ten does not.
      width: ruler.getBoundingClientRect().width / 10
    }
  }

  /* --------------------------------------------------------- editing -- */

  /** @param {KeyboardEvent} event */
  function keydown(event) {
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      tab(event.shiftKey)
      return
    }

    // Indentation is structural in MDY, so a new line almost always wants the
    // one above it to say where it starts.
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey) {
      const start = input.selectionStart

      if (start !== input.selectionEnd) return

      const from = input.value.lastIndexOf('\n', start - 1) + 1
      const width = leading.exec(input.value.slice(from, start))[0]

      if (!width) return

      event.preventDefault()
      insert('\n' + width)
    }
  }

  /**
   * Indent or outdent: the selected lines when there are several or when
   * shifted, and otherwise just the next stop.
   *
   * @param {boolean} back
   */
  function tab(back) {
    const {selectionStart: start, selectionEnd: end, value} = input
    const from = value.lastIndexOf('\n', start - 1) + 1
    const lines = value.slice(from, end).split('\n')

    if (!back && lines.length === 1) {
      insert(indent)
      return
    }

    let first = 0
    let removed = 0

    const shifted = lines.map((line, index) => {
      if (!back) {
        if (index === 0) first = indent.length
        else removed += indent.length
        return indent + line
      }

      const width = leading.exec(line)[0]
      const take = Math.min(width.length, indent.length)

      if (index === 0) first = -take
      else removed -= take

      return line.slice(take)
    })

    input.setSelectionRange(from, end)
    insert(shifted.join('\n'))
    input.setSelectionRange(
      Math.max(from, start + first),
      Math.max(from, end + first + removed)
    )
    schedule()
  }

  /**
   * Type text as the user would, so the platform's own undo keeps working.
   *
   * @param {string} text
   */
  function insert(text) {
    if (!document.execCommand?.('insertText', false, text)) {
      const {selectionStart: start, selectionEnd: end} = input

      input.setRangeText(text, start, end, 'end')
      input.dispatchEvent(new Event('input', {bubbles: true}))
    }
  }
}
