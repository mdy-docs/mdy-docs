import assert from 'node:assert/strict'
import test from 'node:test'
import {parseInline} from 'mdy-docs/parse'
import {toText} from 'mdy-docs/parse/script.js'
import {defaultMarkers} from 'mdy-docs/parse/markers.js'
import {escapeAll, escapeInline, escapeLineStart} from '../src/escape.js'

/** The text a run of escaped source reads back as. */
function read(source, options) {
  return toText({
    type: 'element',
    tagName: 'p',
    properties: {},
    children: parseInline(source, options)
  })
}

/** Whether escaped source reads back as text and nothing else. */
function plain(source, options) {
  return parseInline(source, options).every((node) => node.type === 'text')
}

test('escapes every marker in the table', () => {
  for (const {sequence} of defaultMarkers) {
    const value = 'a ' + sequence + ' b'
    const escaped = escapeInline(value)

    assert.equal(read(escaped), value, sequence)
    assert.ok(plain(escaped), sequence + ' left markup behind')
  }
})

test('escapes a marker written three times over', () => {
  // The trap: escaping only the first character of `///` leaves `//` behind,
  // which opens an emphasis of its own.
  assert.equal(escapeInline('///'), '\\/\\//')
  assert.equal(read('\\/\\//'), '///')
})

test('escapes the constructs that are not markers', () => {
  const cases = [
    'https://example.com/a_(b)',
    'mail team@example.com',
    '[[ a link ]]',
    '[[ a | b ]]',
    '#syntax-trees',
    '@wooorm',
    'wait...',
    'a --> b',
    'a -- b',
    ':rocket:',
    ':)',
    'back\\slash'
  ]

  for (const value of cases) {
    const escaped = escapeInline(value)

    assert.equal(read(escaped), value, value)
    assert.ok(plain(escaped), value + ' left markup behind')
  }
})

test('leaves alone what the options turn off', () => {
  assert.equal(escapeInline(':)', {emoji: false}), ':)')
  assert.equal(escapeInline('#tag', {tags: false}), '#tag')
  assert.equal(escapeInline('[[ x ]]', {wikiLink: false}), '[[ x ]]')
  assert.equal(escapeInline('a...b', {ellipsis: false}), 'a...b')
})

test('walks back the faces an escape creates', () => {
  // `:` and `,,` are both innocent; escaping the `,,` writes a backslash after
  // the colon, and `:\` is a face.
  const escaped = escapeInline(':,,')

  assert.equal(read(escaped), ':,,')
  assert.ok(plain(escaped))
})

test('escapeAll is safe for anything', () => {
  for (const value of [':\\', '=\\', '!!//__', '[[ x | y ]]', 'https://a.b']) {
    assert.equal(read(escapeAll(value)), value)
    assert.ok(plain(escapeAll(value)))
  }
})

test('escaped text reads back as itself, over random input', () => {
  // The property, run over an alphabet made entirely of the characters the
  // grammar cares about — far denser in constructs than prose ever is.
  const alphabet = [
    'a', 'b', ' ', '/', '!', '~', '^', ',', '_', '?', '*', ':', ')', '(',
    '[', ']', '|', '#', '@', '.', '-', '>', '<', '\\', '`', '=', '+', '%',
    'h', 't', 'p', 's', '1', 'D', '3', 'o'
  ]

  for (let count = 0; count < 5000; count++) {
    const length = 1 + Math.floor(Math.random() * 16)
    let value = ''

    for (let index = 0; index < length; index++) {
      value += alphabet[Math.floor(Math.random() * alphabet.length)]
    }

    const escaped = escapeInline(value)

    assert.equal(read(escaped), value, JSON.stringify(value))
    assert.ok(plain(escaped), JSON.stringify(value) + ' left markup behind')
  }
})

test('escapes the line starts the block grammar reads', () => {
  const cases = [
    '= not a heading',
    '== not a heading either',
    '---',
    '----',
    '***',
    '- not a list item',
    '1. not a list item',
    '+++',
    '% not script',
    '# not a comment',
    '| not | a table',
    '```not a fence',
    '<not an element'
  ]

  for (const value of cases) {
    assert.equal(escapeLineStart(value), '\\' + value, value)
  }
})

test('leaves prose line starts alone', () => {
  // `-5` and `1.5` are prose because a marker has to be followed by space,
  // and `--- x` is prose because the separator is exactly three dashes.
  const prose = ['A sentence.', '-5 degrees', '1.5 metres', 'a - b', '--- x', '']

  for (const value of prose) {
    assert.equal(escapeLineStart(value), value, value)
  }
})

test('keeps the indentation it found', () => {
  assert.equal(escapeLineStart('  = x'), '  \\= x')
})
