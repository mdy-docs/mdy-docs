import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, test} from 'vitest'
import {embed, highlightMdy} from '../src/syntax.js'

const page = readFileSync(
  fileURLToPath(new URL('../language.html', import.meta.url)),
  'utf8'
)
const sample = /<script type="text\/mdy" id="sample">\r?\n([\s\S]*?)<\/script>/
  .exec(page)[1]
  .replace(/\s+$/, '')

/**
 * Take the paint back off, which is what the alignment rests on: the editor
 * puts this markup behind a textarea holding the source, so anything that is
 * not a tag has to still be the source, character for character.
 *
 * @param {string} html
 * @returns {string}
 */
function strip(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * @param {string} what
 * @param {string} source
 * @param {string | Array<string>} expected
 */
function paints(what, source, expected) {
  test(what, () => {
    const html = highlightMdy(source)

    for (const value of Array.isArray(expected) ? expected : [expected]) {
      expect(html).toContain(value)
    }

    expect(strip(html)).toBe(source)
  })
}

describe('the painted layer lines up with the source', () => {
  test('the whole demo document survives the round trip', () => {
    expect(strip(highlightMdy(sample))).toBe(sample)
  })

  test('one output line per source line', () => {
    expect(highlightMdy(sample).split('\n').length).toBe(
      sample.split('\n').length
    )
  })

  test('an empty document paints nothing', () => {
    expect(highlightMdy('')).toBe('')
  })

  test('blank lines are kept', () => {
    expect(highlightMdy('a\n\n\nb').split('\n').length).toBe(4)
  })

  test('markup in the source cannot become markup in the paint', () => {
    const html = highlightMdy('a <b> & "c" <script>alert(1)</script>')

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('blocks', () => {
  paints('a heading and its decoration', '=== Three ===', [
    'class="mdy-heading-mark">===',
    'class="mdy-heading">Three'
  ])
  paints('a Setext underline, under a paragraph', 'text\n----', 'mdy-heading-rule')
  test('exactly three dashes are a break, not an underline', () => {
    expect(highlightMdy('text\n---')).toContain('mdy-break')
  })
  paints('a thematic break, with none above it', '***', 'mdy-break')
  paints('a bullet', '- an item', 'class="mdy-bullet">-')
  paints('an ordered marker', '7. seven', 'class="mdy-bullet">7.')
  paints('a task, checked and not', '- [x] done\n- [ ] not', [
    'class="mdy-task checked">[x]',
    'class="mdy-task">[ ]'
  ])
  paints('an element opener', '<table class="grid" open', [
    'class="mdy-tag">table',
    'class="mdy-attr">class',
    'class="mdy-string">"grid"',
    'class="mdy-attr">open'
  ])
  paints('an opener with space after the `<`', '<   table class="grid"', [
    'class="mdy-punct">&lt;',
    'class="mdy-tag">table',
    'class="mdy-string">"grid"'
  ])
  test('the space after a `<` is kept as it was typed', () => {
    expect(strip(highlightMdy('< \ttable class="grid"'))).toBe(
      '< \ttable class="grid"'
    )
  })
  paints(
    'a caption, once a whole table proves it',
    '| Table 1.\n| a | b |\n| :- | -: |',
    'class="mdy-caption"'
  )
  test('a one-column header is not painted as a caption', () => {
    expect(highlightMdy('| a |\n| - |')).not.toContain('mdy-caption')
  })
  paints('a table, once the delimiter row proves it', '| a | b |\n| :- | -: |', [
    'class="mdy-pipe">|',
    'class="mdy-table-rule"'
  ])
  test('leaves a lone pipe in prose alone', () => {
    expect(highlightMdy('a | b')).not.toContain('mdy-pipe')
  })
})

describe('other languages, painted by lowlight', () => {
  paints('a fenced block', '```js\nconst a = 1\n```', [
    'class="mdy-fence">```',
    'class="mdy-language">js',
    'class="hljs-keyword">const'
  ])
  paints('an unknown language, left plain', '```nope\nconst a = 1\n```', [
    'class="mdy-language">nope'
  ])
  paints('a % line', '% for (const a of b) {', [
    'class="mdy-sigil">%',
    'class="hljs-keyword">for'
  ])
  paints('a % line indented to taste', '\t    % const a = 1', [
    'class="mdy-sigil">%',
    'class="hljs-keyword">const'
  ])
  paints('a %% line and the lines it takes up', '%% const a = [\n  1\n]', [
    'class="mdy-sigil">%%',
    'class="hljs-number">1'
  ])
  test('the lines a %% takes up carry no sigil of their own', () => {
    const html = highlightMdy('%% const a = [\n  1\n]')

    expect(html.match(/mdy-sigil/g).length).toBe(1)
    expect(strip(html)).toBe('%% const a = [\n  1\n]')
  })
  test('an unclosed %% leaves the prose under it alone', () => {
    expect(highlightMdy('%% const a = (\nprose')).toContain('\nprose')
  })
  paints('a comment line', '      #  a note', ['class="mdy-comment">#  a note'])
  paints('a Markdown heading, which is a comment here', '# Title', [
    'class="mdy-comment"># Title'
  ])
  test('a `#` against a word is a tag, not a comment', () => {
    expect(highlightMdy('#tag here')).not.toContain('mdy-comment')
  })
  paints('a line of nothing but `#`', '   #', ['class="mdy-comment">#'])
  test('a comment inside a fence belongs to the block', () => {
    const html = highlightMdy('```py\n#  a python comment\nx = 1\n```')

    expect(html).not.toContain('mdy-comment')
    expect(html).toContain('class="hljs-comment"')
  })
  test('a comment does not come between a paragraph and its underline', () => {
    for (const indent of ['', '  ', '      ', '\t']) {
      expect(highlightMdy('text\n' + indent + '#  a note\n----')).toContain(
        'mdy-heading-rule'
      )
    }
  })
  paints(
    'a % line inside a fence, which is code and not the block',
    '```js\n% for (const n of ns) {\nconst a = 1\n% }\n```',
    ['class="mdy-sigil">%', 'class="hljs-keyword">for']
  )
  test('a fence around code is still painted in its own language', () => {
    const html = highlightMdy('```js\n% for (const n of ns) {\nconst a = 1\n% }\n```')

    expect(html).toContain('class="hljs-keyword">const')
    expect(strip(html)).toBe('```js\n% for (const n of ns) {\nconst a = 1\n% }\n```')
  })
  test('an escaped code line in a fence stays part of the block', () => {
    expect(highlightMdy('```mdy\n\\% for (const n of ns) {\n```')).not.toContain(
      'mdy-sigil'
    )
  })
  test('a % line does not come between a paragraph and its underline', () => {
    // What a code line is indented by is the author's business, and it is not
    // markup either way: the parser lifts it out before it reads a column, so
    // the paint has to look straight through it too.
    for (const indent of ['', '  ', '      ', '\t']) {
      expect(highlightMdy('text\n' + indent + '% const a = 1\n----')).toContain(
        'mdy-heading-rule'
      )
    }
  })
  paints('an interpolation', '{{ 6 * 7 }}', [
    'class="mdy-punct">{{',
    'class="hljs-number">6'
  ])
  paints('front matter', '+++\ntitle: MDY\n+++\n\ntext', [
    'class="mdy-matter-fence">+++',
    'hljs-attr'
  ])
  test('front matter has to close to be front matter', () => {
    expect(highlightMdy('+++\ntitle: MDY')).not.toContain('mdy-matter-fence')
  })
})

describe('inline', () => {
  paints('a marker pair', '!!bold!!', 'class="mdy-strong">')
  paints('markers closing together', '!!bold //and italic!!', [
    'class="mdy-strong">',
    'class="mdy-em">'
  ])
  paints('one left open at the end of a line', '~~never closed', 'class="mdy-del">')
  paints('a raw span, holding what would be markup', '``a ~~raw~~ span``', [
    'class="mdy-code">``a ~~raw~~ span``'
  ])
  paints('an escape', '\\!!literal', 'class="mdy-escape">\\!')
  paints('a URL, taken before // could be emphasis', 'see https://a.b/c//d', [
    'class="mdy-url">https://a.b/c//d'
  ])
  paints('an email', 'hello@example.com', 'class="mdy-url">hello@example.com')
  paints('a wiki link', '[[ label | /url ]]', [
    'class="mdy-wiki">',
    'class="mdy-url"> /url '
  ])
  paints('a footnote', '[[ ^order ]]', 'class="mdy-footnote">')
  paints('a tag and a mention', '#tags and @names', [
    'class="mdy-tag-link">#tags',
    'class="mdy-mention">@names'
  ])
  paints('a shortcode', ':rocket:', 'class="mdy-emoji">:rocket:')
  paints('three dots', 'well... maybe', 'class="mdy-ellipsis">...')
  paints('an em dash', 'live -- edit it', 'class="mdy-dash">--')
  test('a longer run of dashes is left alone', () => {
    expect(highlightMdy('a --- b')).not.toContain('mdy-dash')
    expect(highlightMdy('a --> b')).not.toContain('mdy-dash')
  })
  paints('an arrow', 'in --> out', 'class="mdy-arrow">--&gt;')
  paints('a doubled arrow', 'in <==> out', 'class="mdy-arrow">&lt;==&gt;')
  test('leaves a longer run alone, as the parser does', () => {
    expect(highlightMdy('four .... dots')).not.toContain('mdy-ellipsis')
    expect(highlightMdy('longer ---> arrow')).not.toContain('mdy-arrow')
    expect(highlightMdy('x <= 5 and () => {}')).not.toContain('mdy-arrow')
  })
  test('leaves a mid-word # alone, as the parser does', () => {
    expect(highlightMdy('a#b')).not.toContain('mdy-tag-link')
  })
})

describe('the JSON pane borrows the painter', () => {
  test('JSON wears the same tokens the rest of the page does', () => {
    const html = embed('{"title": "MDY", "n": 2}', 'json')

    expect(html).toContain('class="hljs-attr">"title"')
    expect(html).toContain('class="hljs-string">"MDY"')
    expect(html).toContain('class="hljs-number">2')
  })

  test('the text survives the colouring, character for character', () => {
    const source = JSON.stringify({a: [1, 2], b: null}, undefined, 2)

    expect(strip(embed(source, 'json'))).toBe(source)
  })

  test('a language it has no grammar for is escaped, not guessed at', () => {
    expect(embed('<b> & "c"', 'nosuchlanguage')).toBe('&lt;b&gt; &amp; "c"')
  })
})
