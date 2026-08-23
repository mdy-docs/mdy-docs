// @vitest-environment happy-dom
import {scriptBrackets} from 'mdy-docs/parse'
import {beforeEach, describe, expect, test} from 'vitest'
import {createEditor} from '../src/editor.js'
import {blockRegions, highlightMdy} from '../src/syntax.js'

const block = [
  '%% transform((tree) => {',
  '     return tree',
  '   })',
  '= Title'
].join('\n')

/**
 * An editor wired the way the page wires it.
 *
 * @param {string} value
 */
function editor(value) {
  const host = document.createElement('div')

  document.body.append(host)

  const made = createEditor(host, {
    value,
    highlight: highlightMdy,
    regions: blockRegions,
    brackets: (source) => scriptBrackets(source.split('\n'))
  })

  return {host, editor: made, input: host.querySelector('.editor-input')}
}

/**
 * Put the caret at a line and column, both zero-based, and let the editor see.
 *
 * @param {HTMLTextAreaElement} input
 * @param {number} line
 * @param {number} column
 */
function caretAt(input, line, column) {
  const rows = input.value.split('\n')
  let at = column

  for (let index = 0; index < line; index += 1) at += rows[index].length + 1

  input.focus()
  input.setSelectionRange(at, at)
  input.dispatchEvent(new Event('focus'))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('the band down a %% block', () => {
  test('covers the block and nothing else', () => {
    const {host} = editor(block)
    const bands = host.querySelectorAll('.editor-blocks > div')

    expect(bands.length).toBe(1)
    expect(bands[0].dataset.from).toBe('0')
    // The end is exclusive, so three lines from line zero.
    expect(bands[0].dataset.to).toBe('3')
  })

  test('there is none when the brackets never balance', () => {
    const {host} = editor('%% const x = (\nprose\nmore prose')

    expect(host.querySelectorAll('.editor-blocks > div').length).toBe(0)
  })

  test('there is none for a %% that closes on its own line', () => {
    const {host} = editor('%% const x = 1\n{{ x }}')

    expect(host.querySelectorAll('.editor-blocks > div').length).toBe(0)
  })

  test('it follows the text as it is edited', () => {
    const {host, editor: made} = editor(block)

    made.value = '= Title\n' + block
    expect(host.querySelector('.editor-blocks > div').dataset.from).toBe('1')
  })
})

describe('the bracket the caret is beside', () => {
  test('is marked along with the one it pairs with', () => {
    const {host, input} = editor(block)

    // The `(` of `transform(`, which closes on the third line.
    caretAt(input, 0, 12)

    const marks = host.querySelectorAll('.editor-bracket')

    expect(marks.length).toBe(2)
    expect([marks[0].dataset.line, marks[0].dataset.column]).toEqual(['0', '12'])
    expect([marks[1].dataset.line, marks[1].dataset.column]).toEqual(['2', '4'])
  })

  test('counts a bracket just before the caret as well as just after', () => {
    const {host, input} = editor(block)

    caretAt(input, 0, 13)
    expect(host.querySelectorAll('.editor-bracket').length).toBe(2)
  })

  test('pairs a loop brace with the one on the % line below', () => {
    const {host, input} = editor('% for (const n of ns) {\n- {{ n }}\n% }')

    caretAt(input, 0, 22)

    const marks = host.querySelectorAll('.editor-bracket')

    expect(marks.length).toBe(2)
    expect([marks[1].dataset.line, marks[1].dataset.column]).toEqual(['2', '2'])
  })

  test('marks one that never closed as loose', () => {
    const {host, input} = editor('%% const x = (\nprose')

    caretAt(input, 0, 13)

    const marks = host.querySelectorAll('.editor-bracket')

    expect(marks.length).toBe(1)
    expect(marks[0].classList.contains('is-loose')).toBe(true)
  })

  test('says nothing about a bracket in prose', () => {
    const {host, input} = editor('a (paragraph) with brackets')

    caretAt(input, 0, 2)
    expect(host.querySelectorAll('.editor-bracket').length).toBe(0)
  })

  test('marks nothing while the caret is elsewhere', () => {
    const {host, input} = editor(block)

    caretAt(input, 1, 5)
    expect(host.querySelectorAll('.editor-bracket').length).toBe(0)
  })

  test('leaves a line holding a tab unmarked rather than marked wrongly', () => {
    const {host, input} = editor('%% const x = (\t[\n  1\n])')

    caretAt(input, 0, 15)
    expect(host.querySelectorAll('.editor-bracket').length).toBe(0)
  })
})
