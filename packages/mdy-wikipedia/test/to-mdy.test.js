import assert from 'node:assert/strict'
import {globSync, readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {fromMdy} from 'mdy-docs/parse'
import {toMdy} from '../src/to-mdy.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))

/** A tree without its positions, which say where source was and not what it is. */
function shape(tree) {
  return JSON.parse(
    JSON.stringify(tree, (key, value) => (key === 'position' ? undefined : value))
  )
}

/** Source → tree → source → tree. The second tree has to be the first. */
function roundTrip(source, options) {
  const first = fromMdy(source, options)
  const written = toMdy(first, options)

  assert.deepEqual(shape(fromMdy(written, options)), shape(first), written)

  return written
}

test('headings', () => {
  assert.equal(toMdy(fromMdy('= Title')), '= Title\n')
  assert.equal(toMdy(fromMdy('=== Deep ===')), '=== Deep\n')
  // A Setext underline is an `h1`/`h2` like any other on the way back out.
  assert.equal(toMdy(fromMdy('Title\n=====')), '= Title\n')
})

test('a heading whose id is not the one it would be given stays an element', () => {
  const written = toMdy(fromMdy('<h2 id="elsewhere">Names'))

  assert.equal(written, '<h2 id="elsewhere">Names\n')
  roundTrip('<h2 id="elsewhere">Names')
})

test('repeated headings keep their numbering', () => {
  roundTrip('== Notes\n\n== Notes\n\n== Notes')
})

test('inline markers', () => {
  assert.equal(toMdy(fromMdy('!!bold!!')), '!!bold!!\n')
  assert.equal(toMdy(fromMdy('//em//')), '//em//\n')
  assert.equal(toMdy(fromMdy('a ??mark?? and ,,sub,, and ^^sup^^')),
    'a ??mark?? and ,,sub,, and ^^sup^^\n')
  // `**` and `!!` are both `<strong>`; one spelling is chosen and kept.
  assert.equal(toMdy(fromMdy('**bold**')), '!!bold!!\n')
})

test('a raw code span stays raw', () => {
  roundTrip('``!!not bold!!``')
})

test('links', () => {
  assert.equal(toMdy(fromMdy('[[ Getting Started ]]')), '[[ Getting Started ]]\n')
  assert.equal(toMdy(fromMdy('[[ the API | /docs/api ]]')), '[[ the API | /docs/api ]]\n')
  assert.equal(toMdy(fromMdy('see https://example.com/docs')), 'see https://example.com/docs\n')
  assert.equal(toMdy(fromMdy('filed under #syntax-trees by @wooorm')),
    'filed under #syntax-trees by @wooorm\n')
})

test('lists', () => {
  roundTrip('- one\n- two\n  1. nested\n  2. and back\n- three')
  roundTrip('- [x] shipped\n- [ ] not yet')
  roundTrip('3. three\n4. four')
})

test('tables', () => {
  const written = roundTrip('| A | B |\n| :--- | ---: |\n| 1 | 2 |')

  assert.equal(written, '| A | B |\n| :--- | ---: |\n| 1 | 2 |\n')
})

test('a table caption is the line above it', () => {
  roundTrip('| The caption\n| A | B |\n| --- | --- |\n| 1 | 2 |')
})

test('a pipe in a cell survives', () => {
  roundTrip('| A |\n| --- |\n| a \\| b |')
})

test('fenced code, with and without a language', () => {
  roundTrip('```js\nconst answer = 6 * 7\n```')
  roundTrip('```\nplain\n```')
  // A fence long enough to hold the backticks inside it.
  roundTrip('````\n```\n````')
})

test('a thematic break is written `***`, never `---`', () => {
  // `---` is the document separator (rule 11), so a break must not be spelled
  // with a line whose meaning changes when that option is on.
  assert.equal(toMdy(fromMdy('***')), '***\n')
  assert.equal(toMdy(fromMdy('___')), '***\n')
})

test('elements and their indentation', () => {
  roundTrip('<blockquote\n  Quoted.')
  roundTrip('<figure\n  ```js\n  go()\n  ```')
  roundTrip('<div class="note">Inline content')
  roundTrip('<img src="a.png" alt="A"')
})

test('an element with attributes keeps them, in the names they were written with', () => {
  assert.equal(toMdy(fromMdy('<p class="hero">Hi')), '<p class="hero">Hi\n')
  assert.equal(toMdy(fromMdy('<hr class="rule"')), '<hr class="rule"\n')
})

test('front matter is written back', () => {
  const written = toMdy(fromMdy('+++\ntitle: Hello\n+++\n= Body'))

  assert.match(written, /^\+\+\+\ntitle: Hello\n/)
  assert.match(written, /\+\+\+\n= Body\n$/)
})

test('text that looks like markup comes back as text', () => {
  for (const value of [
    'The // in a path',
    'A ~~ tilde pair',
    '= not a heading',
    '- not a list',
    '| not a table',
    'wait... really?',
    'mail me at a@b.com'
  ]) {
    const first = fromMdy(value)
    const written = toMdy(first)

    assert.deepEqual(shape(fromMdy(written)), shape(first), written)
  }
})

test('what has no spelling is reported rather than dropped in silence', () => {
  const messages = []
  const file = {message: (reason) => messages.push(reason)}
  const tree = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'p',
        properties: {},
        children: [
          {type: 'text', value: 'a '},
          {
            type: 'element',
            tagName: 'span',
            properties: {className: ['x']},
            children: [{type: 'text', value: 'span'}]
          }
        ]
      }
    ]
  }

  assert.equal(toMdy(tree, {file}), 'a span\n')
  assert.equal(messages.length, 1)
  assert.match(messages[0], /`<span>` inside a line has no spelling/)
})

test('every mdy document in the repo survives the round trip', () => {
  const files = globSync(['examples/**/*.mdy', 'test/**/*.mdy'], {cwd: root})

  assert.ok(files.length > 20, 'expected the repo to have documents to check')

  for (const file of files) {
    const source = readFileSync(root + file, 'utf8')
    const first = fromMdy(source)
    const written = toMdy(first)

    assert.deepEqual(shape(fromMdy(written)), shape(first), file)
  }
})
