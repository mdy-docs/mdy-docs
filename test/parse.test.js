import {describe, test} from 'node:test'
import {expect} from './expect.js'
import {
  defaultArrows,
  defaultResolve,
  defaultSchema,
  fromMdy,
  mdy,
  mdyToHast,
  mdyToHtml,
  parseInline,
  splitDocuments
} from '../src/parse/index.js'

describe('headings', () => {
  test('one `=` per level', () => {
    expect(mdyToHtml('= One\n\n== Two\n\n===== Five')).toBe(
      '<h1 id="one">One</h1><h2 id="two">Two</h2><h5 id="five">Five</h5>'
    )
  })

  test('drops decorative trailing `=`', () => {
    expect(mdyToHtml('=== Centred ===')).toBe('<h3 id="centred">Centred</h3>')
  })

  test('clamps past h6 and reports it', () => {
    const file = mdy().processSync('======== Deep')

    expect(String(file)).toBe('<h6 id="deep">Deep</h6>')
    expect(file.messages.map(String)).toEqual([
      '1:1-1:14: Heading level 8 is deeper than h6, clamping'
    ])
  })

  test('interrupts a paragraph', () => {
    expect(mdyToHtml('text\n= Head\nmore')).toBe(
      '<p>text</p><h1 id="head">Head</h1><p>more</p>'
    )
  })

  test('carries inline markup', () => {
    expect(mdyToHtml('== A !!bold!! head')).toBe(
      '<h2 id="a-bold-head">A <strong>bold</strong> head</h2>'
    )
  })
})

describe('paragraphs', () => {
  test('joins adjacent lines with a space', () => {
    expect(mdyToHtml('one\ntwo\nthree')).toBe('<p>one two three</p>')
  })

  test('blank lines split blocks', () => {
    expect(mdyToHtml('one\n\ntwo')).toBe('<p>one</p><p>two</p>')
  })

  test('whitespace-only lines count as blank', () => {
    expect(mdyToHtml('one\n \t \ntwo')).toBe('<p>one</p><p>two</p>')
  })

  test('ignores leading and trailing blank lines', () => {
    expect(mdyToHtml('\n\none  \n\n\n')).toBe('<p>one</p>')
  })

  test('escapes HTML in text', () => {
    expect(mdyToHtml('a < b & c')).toBe('<p>a &#x3C; b &#x26; c</p>')
  })
})

describe('inline markers', () => {
  test('a pair opens and closes', () => {
    expect(mdyToHtml('a !!b!! c')).toBe('<p>a <strong>b</strong> c</p>')
  })

  test('nests', () => {
    expect(mdyToHtml('!!a //b// c!!')).toBe(
      '<p><strong>a <em>b</em> c</strong></p>'
    )
  })

  test('closing an outer marker auto-closes inner ones', () => {
    expect(mdyToHtml('!!a //b!! c')).toBe(
      '<p><strong>a <em>b</em></strong> c</p>'
    )
  })

  test('closes everything left open at the end of a paragraph', () => {
    expect(mdyToHtml('!!a //b\n\nnext')).toBe(
      '<p><strong>a <em>b</em></strong></p><p>next</p>'
    )
  })

  test('markers do not leak across blocks', () => {
    expect(mdyToHtml('!!a\n\nb!!c')).toBe(
      '<p><strong>a</strong></p><p>b<strong>c</strong></p>'
    )
  })

  test('two sequences may share an element', () => {
    expect(mdyToHtml('a **bold** b')).toBe('<p>a <strong>bold</strong> b</p>')
    expect(mdyToHtml('**a //b** c')).toBe(
      '<p><strong>a <em>b</em></strong> c</p>'
    )
  })

  test('`**` inline does not clash with a `***` break', () => {
    expect(mdyToHtml('x\n\n***\n\ny **z** w')).toBe(
      '<p>x</p><hr><p>y <strong>z</strong> w</p>'
    )
  })

  test('covers the whole default table', () => {
    expect(
      mdyToHtml('!!s!! //e// __u__ ~~d~~ ??m?? ^^p^^ ,,b,, ``c``')
    ).toBe(
      '<p><strong>s</strong> <em>e</em> <u>u</u> <del>d</del> ' +
        '<mark>m</mark> <sup>p</sup> <sub>b</sub> <code>c</code></p>'
    )
  })

  test('code spans are raw', () => {
    expect(mdyToHtml('``!!not bold// \\``')).toBe(
      '<p><code>!!not bold// \\</code></p>'
    )
  })

  test('backslash escapes a marker', () => {
    expect(mdyToHtml('\\!!not bold\\!!')).toBe('<p>!!not bold!!</p>')
  })

  test('backslash escapes a backslash', () => {
    expect(mdyToHtml('a \\\\ b')).toBe('<p>a \\ b</p>')
  })

  test('an unpaired marker still produces an element', () => {
    expect(mdyToHtml('??x')).toBe('<p><mark>x</mark></p>')
  })

  test('honours a custom marker table', () => {
    const markers = [{sequence: '@@', tagName: 'kbd'}]

    expect(mdyToHtml('press @@esc@@ and !!stay!!', {markers})).toBe(
      '<p>press <kbd>esc</kbd> and !!stay!!</p>'
    )
  })

  test('rejects a marker table without a tag name', () => {
    expect(() => parseInline('x', {markers: [{sequence: '@@'}]})).toThrow(
      /tagName/
    )
  })
})

describe('tree', () => {
  test('produces hast with positions', () => {
    const tree = mdyToHast('== Title\n\nfirst\nsecond')

    expect(tree.type).toBe('root')
    expect(tree.children.map((node) => node.tagName)).toEqual(['h2', 'p'])
    expect(tree.children[1].position).toEqual({
      start: {line: 3, column: 1},
      end: {line: 4, column: 7}
    })
  })

  test('is inspectable and transformable before stringifying', () => {
    const html = mdy()
      .use(() => (tree) => {
        for (const node of tree.children) {
          node.properties = {...node.properties, className: ['mdy']}
        }
      })
      .processSync('hello')

    expect(String(html)).toBe('<p class="mdy">hello</p>')
  })

  test('accepts an empty document', () => {
    expect(fromMdy('')).toEqual({type: 'root', children: []})
    expect(mdyToHtml('')).toBe('')
  })
})

describe('tables', () => {
  const table = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n')

  test('header, delimiter row, body', () => {
    expect(mdyToHtml(table)).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n' +
        '<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>'
    )
  })

  test('framing pipes are optional', () => {
    expect(mdyToHtml('a | b\n- | -\n1 | 2')).toBe(mdyToHtml(table))
  })

  test('header only, no tbody', () => {
    expect(mdyToHtml('| a |\n| - |')).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n</table>'
    )
  })

  test('colons set alignment as inline style', () => {
    const html = mdyToHtml('| l | c | r |\n| :- | :-: | -: |\n| 1 | 2 | 3 |')

    expect(html).toContain('<th style="text-align: left">l</th>')
    expect(html).toContain('<th style="text-align: center">c</th>')
    expect(html).toContain('<td style="text-align: right">3</td>')
  })

  test('alignment can use the legacy attribute instead', () => {
    const html = mdyToHtml('| c |\n| :-: |', {tableAlign: 'attribute'})

    expect(html).toContain('<th align="center">c</th>')
  })

  test('pads short rows and drops extra cells', () => {
    const html = mdyToHtml('| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |')

    expect(html).toContain('<tr>\n<td>1</td>\n<td></td>\n</tr>')
    expect(html).toContain('<tr>\n<td>1</td>\n<td>2</td>\n</tr>')
    expect(html).not.toContain('<td>3</td>')
  })

  test('cells carry inline markup', () => {
    expect(mdyToHtml('| !!a!! |\n| - |')).toBe(
      '<table>\n<thead>\n<tr>\n<th><strong>a</strong></th>\n</tr>\n</thead>\n</table>'
    )
  })

  test('an escaped pipe stays inside its cell', () => {
    const html = mdyToHtml('| a \\| b | c |\n| - | - |')

    expect(html).toContain('<th>a | b</th>')
    expect(html).toContain('<th>c</th>')
  })

  test('an escaped pipe works inside a raw code span', () => {
    expect(mdyToHtml('| ``a \\| b`` |\n| - |')).toContain(
      '<th><code>a | b</code></th>'
    )
  })

  test('interrupts a paragraph', () => {
    expect(mdyToHtml('text\n| a |\n| - |')).toBe(
      '<p>text</p><table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n</table>'
    )
  })

  test('ends at a blank line', () => {
    expect(mdyToHtml('| a |\n| - |\n| 1 |\n\nafter')).toContain(
      '</table><p>after</p>'
    )
  })

  test('ends at a heading', () => {
    expect(mdyToHtml('| a |\n| - |\n| 1 |\n= Next')).toContain(
      '</table><h1 id="next">Next</h1>'
    )
  })

  test('a mismatched delimiter row is not a table', () => {
    expect(mdyToHtml('| a | b |\n| - |')).toBe('<p>| a | b | | - |</p>')
  })

  test('a dash-only line under prose underlines it instead', () => {
    expect(mdyToHtml('a\n----')).toBe('<h2 id="a">a</h2>')
  })

  test('a header without pipes is not a table', () => {
    expect(mdyToHtml('a\n| - |')).toBe('<p>a | - |</p>')
  })

  test('produces a hast table with positions', () => {
    const tree = mdyToHast(table)
    const [node] = tree.children

    expect(node.tagName).toBe('table')
    expect(node.position.start.line).toBe(1)
    expect(node.position.end.line).toBe(3)
    expect(node.children.filter((child) => child.type === 'element')).toHaveLength(2)
  })

  test('an element opener ends the table rather than joining it', () => {
    expect(mdyToHtml('| a | b |\n| - | - |\n<p>after')).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n</table><p>after</p>'
    )
  })
})

describe('table captions', () => {
  const captioned = '| Table 1. Names.\n| Name | Born |\n| ---- | ---- |\n| Ada  | 1815 |'

  test('a single-cell pipe line above a table captions it', () => {
    expect(mdyToHtml(captioned)).toContain('<caption>Table 1. Names.</caption>')
  })

  test('the caption is the first child, where HTML wants it', () => {
    const [table] = mdyToHast(captioned).children
    const elements = table.children.filter((child) => child.type === 'element')

    expect(elements.map((child) => child.tagName)).toEqual([
      'caption',
      'thead',
      'tbody'
    ])
  })

  test('captions a one-column table without eating its header', () => {
    expect(mdyToHtml('| Name |\n| ---- |\n| Ada |')).not.toContain('<caption>')
    expect(mdyToHtml('| Table 2.\n| Name |\n| ---- |\n| Ada |')).toContain(
      '<caption>Table 2.</caption>'
    )
  })

  test('the caption is inline content, escapes and all', () => {
    expect(
      mdyToHtml('| !!Table 3.!! A \\| pipe and //em//\n| a | b |\n| - | - |')
    ).toContain(
      '<caption><strong>Table 3.</strong> A | pipe and <em>em</em></caption>'
    )
  })

  test('needs framing pipes on neither side', () => {
    expect(mdyToHtml('| Table 4. |\n| a | b |\n| - | - |')).toContain(
      '<caption>Table 4.</caption>'
    )
  })

  test('a pipe line captioning nothing stays a paragraph', () => {
    expect(mdyToHtml('| not a caption\n\ntext')).toBe(
      '<p>| not a caption</p><p>text</p>'
    )
  })

  test('an empty pipe line is not a caption', () => {
    expect(mdyToHtml('|\n| a | b |\n| - | - |')).toContain('<p>|</p>')
  })

  test('only the line against the table is the caption', () => {
    const html = mdyToHtml('| One\n| Two\n| a | b |\n| - | - |')

    expect(html).toContain('<p>| One</p>')
    expect(html).toContain('<caption>Two</caption>')
  })

  test('the table position starts at the caption', () => {
    const [table] = mdyToHast(captioned).children

    expect(table.position.start.line).toBe(1)
    expect(table.position.end.line).toBe(4)
  })

  test('a row is still a row, however short', () => {
    // Ragged rows are padded, so a one-cell line inside the table is a row
    // rather than a caption; only the line above the header can be one.
    expect(mdyToHtml('| a | b |\n| - | - |\n| only one cell')).toContain(
      '<td>only one cell</td>\n<td></td>'
    )
  })
})

describe('lists', () => {
  test('bullets', () => {
    expect(mdyToHtml('- one\n- two')).toBe(
      '<ul>\n<li>one</li>\n<li>two</li>\n</ul>'
    )
  })

  test('accepts -, * and + as bullets', () => {
    expect(mdyToHtml('* one\n+ two\n- three')).toBe(
      '<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>'
    )
  })

  test('numbers, with either . or )', () => {
    expect(mdyToHtml('1. one\n2) two')).toBe(
      '<ol>\n<li>one</li>\n<li>two</li>\n</ol>'
    )
  })

  test('keeps the first number as a start offset', () => {
    expect(mdyToHtml('7. seven\n8. eight')).toContain('<ol start="7">')
    expect(mdyToHtml('1. one')).toBe('<ol>\n<li>one</li>\n</ol>')
  })

  test('numbering after the first item is ignored', () => {
    expect(mdyToHtml('1. one\n1. two\n1. three')).toBe(
      '<ol>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ol>'
    )
  })

  test('indentation nests', () => {
    expect(mdyToHtml('- one\n  - deep\n- two')).toBe(
      '<ul>\n<li>one\n<ul>\n<li>deep</li>\n</ul>\n</li>\n<li>two</li>\n</ul>'
    )
  })

  test('a tab indents like four spaces', () => {
    expect(mdyToHtml('- one\n\t- deep')).toBe(mdyToHtml('- one\n    - deep'))
  })

  test('nests lists of different kinds', () => {
    expect(mdyToHtml('- one\n  1. a\n  2. b')).toBe(
      '<ul>\n<li>one\n<ol>\n<li>a</li>\n<li>b</li>\n</ol>\n</li>\n</ul>'
    )
  })

  test('switching kind at the same depth starts a sibling list', () => {
    expect(mdyToHtml('- one\n1. two')).toBe(
      '<ul>\n<li>one</li>\n</ul><ol>\n<li>two</li>\n</ol>'
    )
  })

  test('continuation lines join the item, as in a paragraph', () => {
    expect(mdyToHtml('- one\n  still one\n- two')).toBe(
      '<ul>\n<li>one still one</li>\n<li>two</li>\n</ul>'
    )
  })

  test('a blank line between items makes the list loose', () => {
    expect(mdyToHtml('- one\n\n- two')).toBe(
      '<ul>\n<li>\n<p>one</p>\n</li>\n<li>\n<p>two</p>\n</li>\n</ul>'
    )
  })

  test('items carry inline markup', () => {
    expect(mdyToHtml('- !!bold //and italic')).toBe(
      '<ul>\n<li><strong>bold <em>and italic</em></strong></li>\n</ul>'
    )
  })

  test('an empty item is allowed', () => {
    expect(mdyToHtml('- one\n-\n- three')).toBe(
      '<ul>\n<li>one</li>\n<li></li>\n<li>three</li>\n</ul>'
    )
  })

  test('interrupts a paragraph', () => {
    expect(mdyToHtml('text\n- one')).toBe(
      '<p>text</p><ul>\n<li>one</li>\n</ul>'
    )
  })

  test('ends at a blank line followed by prose', () => {
    expect(mdyToHtml('- one\n\nafter')).toBe(
      '<ul>\n<li>one</li>\n</ul><p>after</p>'
    )
  })

  test('ends at a heading', () => {
    expect(mdyToHtml('- one\n= Next')).toBe(
      '<ul>\n<li>one</li>\n</ul><h1 id="next">Next</h1>'
    )
  })

  test('a marker needs whitespace after it', () => {
    // Not a list of anything: two dashes are an em dash.
    expect(mdyToHtml('--')).toBe('<p>—</p>')
    expect(mdyToHtml('-5 degrees')).toBe('<p>-5 degrees</p>')
    expect(mdyToHtml('1.5 apples')).toBe('<p>1.5 apples</p>')
  })

  test('a list wins over a table when a row could be either', () => {
    expect(mdyToHtml('- a | b\n- c')).toBe(
      '<ul>\n<li>a | b</li>\n<li>c</li>\n</ul>'
    )
  })

  test('produces hast with positions covering nested content', () => {
    const tree = mdyToHast('- one\n  - deep\n- two')
    const [node] = tree.children

    expect(node.tagName).toBe('ul')
    expect(node.position).toEqual({
      start: {line: 1, column: 1},
      end: {line: 3, column: 6}
    })

    const [first] = node.children.filter((child) => child.type === 'element')

    expect(first.position.end.line).toBe(2)
  })
})

describe('html elements', () => {
  test('a bare `<` is a div', () => {
    expect(mdyToHtml('<\n  hello')).toBe('<div>\n<p>hello</p>\n</div>')
  })

  test('names the element after the `<`', () => {
    expect(mdyToHtml('<section\n  hello')).toBe(
      '<section>\n<p>hello</p>\n</section>'
    )
  })

  test('space between the `<` and the name is allowed', () => {
    // The space reads like the space between the attributes behind it, so a
    // line may be written out however it sits best.
    for (const gap of [' ', '   ', '\t', ' \t ']) {
      expect(mdyToHtml('<' + gap + 'section class="note"\n  hello')).toBe(
        '<section class="note">\n<p>hello</p>\n</section>'
      )
    }
  })

  test('a `<` with nothing but space behind it is still a div', () => {
    expect(mdyToHtml('<   \n  hello')).toBe('<div>\n<p>hello</p>\n</div>')
  })

  test('space before an inline element reads the same', () => {
    expect(mdyToHtml('<  span>a !!bold!! word')).toBe(
      '<span>a <strong>bold</strong> word</span>'
    )
  })

  test('the closing `>` is optional', () => {
    expect(mdyToHtml('<section>\n  hi')).toBe(mdyToHtml('<section\n  hi'))
  })

  test('text after the `>` is inline content', () => {
    expect(mdyToHtml('<span>a !!bold!! word')).toBe(
      '<span>a <strong>bold</strong> word</span>'
    )
  })

  test('reads quoted, unquoted and boolean attributes', () => {
    expect(
      mdyToHtml('<table style="border: 1px solid red;" id=grid hidden')
    ).toBe('<table style="border: 1px solid red;" id="grid" hidden></table>')
  })

  test('reads single quoted attributes', () => {
    expect(mdyToHtml("<p title='it\"s fine'")).toBe(
      '<p title="it&#x22;s fine"></p>'
    )
  })

  test('maps attribute names onto hast properties', () => {
    const tree = mdyToHast('<time class="a b" datetime=2026-08-18')
    const [node] = tree.children

    expect(node.properties).toEqual({
      className: ['a', 'b'],
      dateTime: '2026-08-18'
    })
  })

  test('tolerates a self-closing slash', () => {
    expect(mdyToHtml('<span />done')).toBe('<span>done</span>')
  })

  test('tolerates an unterminated quote', () => {
    expect(mdyToHtml('<div class="half')).toBe('<div class="half"></div>')
  })

  test('two spaces of indent nest a child', () => {
    expect(mdyToHtml('<ul\n  <li>one\n  <li>two')).toBe(
      '<ul>\n<li>one</li>\n<li>two</li>\n</ul>'
    )
  })

  test('closes when the indentation comes back out', () => {
    expect(mdyToHtml('<aside\n  inside\nafter')).toBe(
      '<aside>\n<p>inside</p>\n</aside><p>after</p>'
    )
  })

  test('blank lines do not close an element', () => {
    expect(mdyToHtml('<aside\n\n  inside\n\nafter')).toBe(
      '<aside>\n<p>inside</p>\n</aside><p>after</p>'
    )
  })

  test('nests as deeply as it is indented', () => {
    expect(mdyToHtml('<table\n  <tr\n    <td>one')).toBe(
      '<table>\n<tr>\n<td>one</td>\n</tr>\n</table>'
    )
  })

  test('holds any other block', () => {
    expect(mdyToHtml('<article\n  == Title\n  - one\n  - two')).toBe(
      '<article>\n<h2 id="title">Title</h2>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n</article>'
    )
  })

  test('void elements take no content and say so', () => {
    const file = mdy().processSync('<hr\n  ignored')

    expect(String(file)).toBe('<hr><div>\n<p>ignored</p>\n</div>')
    expect(file.messages.map((message) => message.reason)).toEqual([
      '`<hr>` cannot have content, ignoring it'
    ])
  })

  test('a `<` anywhere but the start of a line is text', () => {
    expect(mdyToHtml('a < b')).toBe('<p>a &#x3C; b</p>')
  })

  test('carries position information', () => {
    const tree = mdyToHast('<div\n  one\n  two')
    const [node] = tree.children

    expect(node.tagName).toBe('div')
    expect(node.position).toEqual({
      start: {line: 1, column: 1},
      end: {line: 3, column: 6}
    })
  })
})

describe('indentation', () => {
  test('an indented run gets a div of its own', () => {
    expect(mdyToHtml('  hello')).toBe('<div>\n<p>hello</p>\n</div>')
  })

  test('each two columns is another div', () => {
    expect(mdyToHtml('    hello')).toBe(
      '<div>\n<div>\n<p>hello</p>\n</div>\n</div>'
    )
  })

  test('a tab counts as four columns', () => {
    expect(mdyToHtml('\thello')).toBe(mdyToHtml('    hello'))
  })

  test('splits a paragraph away from the indented lines under it', () => {
    expect(mdyToHtml('plain\n  indented\nback')).toBe(
      '<p>plain</p><div>\n<p>indented</p>\n</div><p>back</p>'
    )
  })

  test('groups a whole indented run into one div', () => {
    expect(mdyToHtml('  one\n\n  two')).toBe(
      '<div>\n<p>one</p>\n<p>two</p>\n</div>'
    )
  })

  test('list nesting stays list nesting', () => {
    expect(mdyToHtml('- one\n  - deep')).toBe(
      '<ul>\n<li>one\n<ul>\n<li>deep</li>\n</ul>\n</li>\n</ul>'
    )
  })
})

describe('sanitizing', () => {
  /** @param {string} document */
  function run(document) {
    const file = mdy().processSync(document)

    return {
      html: String(file),
      messages: file.messages.map((message) => message.reason)
    }
  }

  test('drops event handlers', () => {
    const {html, messages} = run('<img src=x onerror="alert(1)" alt=ok')

    expect(html).toBe('<img src="x" alt="ok">')
    expect(messages).toEqual(['`onerror` is not allowed on `<img>`, dropping it'])
  })

  test('drops any unlisted attribute', () => {
    expect(run('<div formaction=x').html).toBe('<div></div>')
  })

  test('allows data-* and aria-*', () => {
    expect(run('<div data-id=7 aria-label=hi id=y class=box').html).toBe(
      '<div data-id="7" aria-label="hi" id="y" class="box"></div>'
    )
  })

  test('scopes attributes to the element that may carry them', () => {
    expect(run('<td colspan=2').html).toBe('<td colspan="2"></td>')
    expect(run('<div colspan=2').html).toBe('<div></div>')
  })

  test('removes a stripped element and everything under it', () => {
    const {html, messages} = run('<script\n  alert(1)\nafter')

    expect(html).toBe('<p>after</p>')
    expect(messages).toEqual([
      '`<script>` is not allowed, dropping it and its content'
    ])
  })

  test('strips iframe and style too', () => {
    expect(run('<iframe src="https://evil"').html).toBe('')
    expect(run('<style\n  body{display:none}').html).toBe('')
  })

  test('an unknown element becomes a div and keeps its content', () => {
    const {html, messages} = run('<blink\n  content survives')

    expect(html).toBe('<div>\n<p>content survives</p>\n</div>')
    expect(messages).toEqual([
      '`<blink>` is not allowed, using `<div>` instead'
    ])
  })

  test('rejects a javascript: URL', () => {
    const {html, messages} = run('<a href="javascript:alert(1)">click')

    expect(html).toBe('<a>click</a>')
    expect(messages).toEqual([
      '`href` points at a protocol that is not allowed, dropping it'
    ])
  })

  test('rejects a URL hiding its protocol behind whitespace', () => {
    expect(run('<a href="java\tscript:alert(1)">click').html).toBe(
      '<a>click</a>'
    )
    expect(run('<a href=" JAVASCRIPT:alert(1)">click').html).toBe(
      '<a>click</a>'
    )
  })

  test('rejects a data: URL on an image', () => {
    expect(run('<img src="data:text/html,<b>hi"').html).toBe('<img>')
  })

  test('keeps allowed protocols and relative URLs', () => {
    expect(run('<a href="https://example.com">x').html).toContain(
      'href="https://example.com"'
    )
    expect(run('<a href="mailto:a@b.c">x').html).toContain('href="mailto:a@b.c"')
    expect(run('<a href="/local#frag">x').html).toContain('href="/local#frag"')
    expect(run('<a href="#top">x').html).toContain('href="#top"')
  })

  test('can be turned off', () => {
    expect(mdyToHtml('<script>alert(1)', {sanitize: false})).toBe(
      '<script>alert(1)</script>'
    )
  })

  test('takes a custom schema', () => {
    const html = mdyToHtml('<video controls src="https://x/y.mp4"', {
      sanitize: {
        tagNames: [...defaultSchema.tagNames, 'video'],
        attributes: {
          ...defaultSchema.attributes,
          video: ['controls', 'src']
        }
      }
    })

    expect(html).toBe('<video controls src="https://x/y.mp4"></video>')
  })

  test('a partial schema keeps the defaults it does not mention', () => {
    const html = mdyToHtml('<a href="javascript:x" title=t>c', {
      sanitize: {tagNames: ['a']}
    })

    expect(html).toBe('<a title="t">c</a>')
  })

  test('generated elements are never sanitized away', () => {
    expect(mdyToHtml('= Title\n\n- item', {sanitize: {tagNames: []}})).toBe(
      '<h1 id="title">Title</h1><ul>\n<li>item</li>\n</ul>'
    )
  })
})

describe('task lists', () => {
  test('renders a disabled checkbox per item', () => {
    expect(mdyToHtml('- [ ] todo\n- [x] done')).toBe(
      '<ul class="contains-task-list">\n' +
        '<li class="task-list-item"><input type="checkbox" disabled> todo</li>\n' +
        '<li class="task-list-item"><input type="checkbox" checked disabled> done</li>\n' +
        '</ul>'
    )
  })

  test('accepts an uppercase X', () => {
    expect(mdyToHtml('- [X] done')).toBe(mdyToHtml('- [x] done'))
  })

  test('mixes with plain items, which keep no class', () => {
    const html = mdyToHtml('- [ ] todo\n- plain')

    expect(html).toContain('<li>plain</li>')
    expect(html).toContain('<ul class="contains-task-list">')
  })

  test('a list with no tasks is untouched', () => {
    expect(mdyToHtml('- one')).toBe('<ul>\n<li>one</li>\n</ul>')
  })

  test('works on ordered lists', () => {
    expect(mdyToHtml('1. [x] first')).toBe(
      '<ol class="contains-task-list">\n' +
        '<li class="task-list-item"><input type="checkbox" checked disabled> first</li>\n' +
        '</ol>'
    )
  })

  test('keeps a start offset alongside the class', () => {
    expect(mdyToHtml('3. [ ] third')).toContain(
      '<ol class="contains-task-list" start="3">'
    )
  })

  test('puts the box inside the paragraph of a loose list', () => {
    expect(mdyToHtml('- [x] one\n\n- [ ] two')).toBe(
      '<ul class="contains-task-list">\n' +
        '<li class="task-list-item">\n<p><input type="checkbox" checked disabled> one</p>\n</li>\n' +
        '<li class="task-list-item">\n<p><input type="checkbox" disabled> two</p>\n</li>\n' +
        '</ul>'
    )
  })

  test('an empty task gets no trailing space', () => {
    expect(mdyToHtml('- [ ]')).toBe(
      '<ul class="contains-task-list">\n' +
        '<li class="task-list-item"><input type="checkbox" disabled></li>\n' +
        '</ul>'
    )
  })

  test('the box has to come first and be followed by whitespace', () => {
    expect(mdyToHtml('- do [ ] later')).toBe('<ul>\n<li>do [ ] later</li>\n</ul>')
    expect(mdyToHtml('- [x]done')).toBe('<ul>\n<li>[x]done</li>\n</ul>')
  })

  test('only a space or an x counts', () => {
    expect(mdyToHtml('- [z] no')).toBe('<ul>\n<li>[z] no</li>\n</ul>')
    expect(mdyToHtml('- [] no')).toBe('<ul>\n<li>[] no</li>\n</ul>')
  })

  test('item text keeps its inline markup', () => {
    expect(mdyToHtml('- [x] !!ship!! it')).toContain(
      '<input type="checkbox" checked disabled> <strong>ship</strong> it'
    )
  })

  test('continuation lines join a task item', () => {
    expect(mdyToHtml('- [ ] one\n  still one')).toContain(
      '<input type="checkbox" disabled> one still one'
    )
  })

  test('nests, marking only the lists that hold tasks', () => {
    const html = mdyToHtml('- plain\n  - [ ] nested task')

    expect(html).toBe(
      '<ul>\n<li>plain\n' +
        '<ul class="contains-task-list">\n' +
        '<li class="task-list-item"><input type="checkbox" disabled> nested task</li>\n' +
        '</ul>\n</li>\n</ul>'
    )
  })

  test('produces hast with an input element', () => {
    const tree = mdyToHast('- [x] done')
    const list = tree.children[0]
    const item = list.children.find((child) => child.type === 'element')
    const [box] = item.children

    expect(box.tagName).toBe('input')
    expect(box.properties).toEqual({
      type: 'checkbox',
      checked: true,
      disabled: true
    })
  })
})

describe('emoji', () => {
  test('replaces emoticons', () => {
    expect(mdyToHtml('hello :) and :-D')).toBe('<p>hello 😃 and 😄</p>')
  })

  test('replaces GitHub shortcodes', () => {
    expect(mdyToHtml('ship it :rocket:')).toBe('<p>ship it 🚀</p>')
  })

  test('handles the non-face emoticons', () => {
    expect(mdyToHtml('I <3 you')).toBe('<p>I ❤️ you</p>')
  })

  test('leaves an emoticon inside a word alone', () => {
    expect(mdyToHtml('no smile:)here')).toBe('<p>no smile:)here</p>')
  })

  test('leaves a `:/` inside a path alone', () => {
    expect(mdyToHtml('the path a:/b stays')).toBe('<p>the path a:/b stays</p>')
  })

  test('a URL is matched before the `//` marker sees it', () => {
    expect(mdyToHtml('see http://example.com now')).toBe(
      '<p>see <a href="http://example.com">http://example.com</a> now</p>'
    )
  })

  test('leaves a clock alone', () => {
    expect(mdyToHtml('at 12:30:45 sharp')).toBe('<p>at 12:30:45 sharp</p>')
  })

  test('ignores an unknown shortcode', () => {
    expect(mdyToHtml('a :notanemojiname: b')).toBe(
      '<p>a :notanemojiname: b</p>'
    )
  })

  test('works right after a marker', () => {
    expect(mdyToHtml('a !!:)!! b')).toBe('<p>a <strong>😃</strong> b</p>')
  })

  test('is literal inside a raw code span', () => {
    expect(mdyToHtml('``:) :rocket:`` stays')).toBe(
      '<p><code>:) :rocket:</code> stays</p>'
    )
  })

  test('can be escaped', () => {
    expect(mdyToHtml('\\:) and \\:rocket:')).toBe('<p>:) and :rocket:</p>')
  })

  test('works in headings, list items and table cells', () => {
    expect(mdyToHtml('= Done :)')).toBe('<h1 id="done-">Done 😃</h1>')
    expect(mdyToHtml('- [x] shipped :rocket:')).toContain('shipped 🚀')
    expect(mdyToHtml('| :) |\n| - |')).toContain('<th>😃</th>')
  })

  test('can be turned off entirely', () => {
    expect(mdyToHtml('hi :) :rocket:', {emoji: false})).toBe(
      '<p>hi :) :rocket:</p>'
    )
  })

  test('each half can be turned off on its own', () => {
    expect(mdyToHtml('hi :) :rocket:', {emoji: {emoticons: false}})).toBe(
      '<p>hi :) 🚀</p>'
    )
    expect(mdyToHtml('hi :) :rocket:', {emoji: {shortcodes: false}})).toBe(
      '<p>hi 😃 :rocket:</p>'
    )
  })
})

describe('ellipsis', () => {
  test('three dots become one character', () => {
    expect(mdyToHtml('Well... maybe.')).toBe('<p>Well… maybe.</p>')
  })

  test('works at either end of a run of text', () => {
    expect(mdyToHtml('...and on it went...')).toBe('<p>…and on it went…</p>')
  })

  test('takes exactly three', () => {
    expect(mdyToHtml('two .. dots')).toBe('<p>two .. dots</p>')
    expect(mdyToHtml('four .... dots')).toBe('<p>four .... dots</p>')
    expect(mdyToHtml('five ..... dots')).toBe('<p>five ..... dots</p>')
  })

  test('can be escaped, on any of the three', () => {
    expect(mdyToHtml('\\... and .\\.. and ..\\.')).toBe(
      '<p>... and ... and ...</p>'
    )
  })

  test('is literal inside a raw code span', () => {
    expect(mdyToHtml('``a ... span`` but ... here')).toBe(
      '<p><code>a ... span</code> but … here</p>'
    )
  })

  test('never reaches fenced code', () => {
    expect(mdyToHtml('```\nkeep ... these\n```')).toBe(
      '<pre><code>keep ... these\n</code></pre>'
    )
  })

  test('leaves the dots inside a URL alone', () => {
    expect(mdyToHtml('see https://example.com/a...b now')).toBe(
      '<p>see <a href="https://example.com/a...b">https://example.com/a...b</a> now</p>'
    )
  })

  test('works in headings, list items and table cells', () => {
    expect(mdyToHtml('= Wait...')).toBe('<h1 id="wait">Wait…</h1>')
    expect(mdyToHtml('- and so on...')).toContain('<li>and so on…</li>')
    expect(mdyToHtml('| a... |\n| - |')).toContain('<th>a…</th>')
  })

  test('works inside a marker span', () => {
    expect(mdyToHtml('!!hold on...!!')).toBe('<p><strong>hold on…</strong></p>')
  })

  test('can be turned off', () => {
    expect(mdyToHtml('wait... what', {ellipsis: false})).toBe(
      '<p>wait... what</p>'
    )
  })

  test('can be told to write something else', () => {
    expect(mdyToHtml('wait... what', {ellipsis: '. . .'})).toBe(
      '<p>wait. . . what</p>'
    )
  })

  test('is on for `parseInline` too', () => {
    expect(parseInline('so...')).toEqual([{type: 'text', value: 'so…'}])
  })
})

describe('em dash', () => {
  test('two dashes become one', () => {
    expect(mdyToHtml('Everything below is live -- edit it.')).toBe(
      '<p>Everything below is live — edit it.</p>'
    )
  })

  test('with or without spaces around it', () => {
    expect(mdyToHtml('word--word')).toBe('<p>word—word</p>')
  })

  test('a line of two dashes is one too, being neither of the other rules', () => {
    expect(mdyToHtml('--')).toBe('<p>—</p>')
    expect(mdyToHtml('text\n--')).toBe('<p>text —</p>')
  })

  test('exactly two: a longer run is left as the run it was written as', () => {
    expect(mdyToHtml('a --- b')).toBe('<p>a --- b</p>')
    expect(mdyToHtml('a ---- b')).toBe('<p>a ---- b</p>')
  })

  test('the dash before is checked as well as the one after', () => {
    // Else the second dash of `---` would start a match the first was
    // refused, and three dashes would come out as one and a spare.
    expect(mdyToHtml('a --- b')).not.toContain('—')
  })

  test('arrows are matched first, so an arrow keeps its head', () => {
    expect(mdyToHtml('a --> b')).toBe('<p>a → b</p>')
    expect(mdyToHtml('a <-- b')).toBe('<p>a ← b</p>')
    expect(mdyToHtml('a <--> b')).toBe('<p>a ↔ b</p>')
  })

  test('a backslash opts out', () => {
    expect(mdyToHtml('a \\-- b')).toBe('<p>a -- b</p>')
  })

  test('never inside a raw span or a fence', () => {
    expect(mdyToHtml('``a -- b``')).toBe('<p><code>a -- b</code></p>')
    expect(mdyToHtml('```\na -- b\n```', {highlight: false})).toBe(
      '<pre><code>a -- b\n</code></pre>'
    )
  })

  test('turn it off, or write something else', () => {
    expect(mdyToHtml('a -- b', {emDash: false})).toBe('<p>a -- b</p>')
    expect(mdyToHtml('a -- b', {emDash: '–'})).toBe('<p>a – b</p>')
  })

  test('a run of dashes means one thing per length', () => {
    // The table in rule 1, as the parser actually reads it.
    expect(mdyToHtml('text\n-')).toBe('<p>text</p><ul>\n<li></li>\n</ul>')
    expect(mdyToHtml('text\n--')).toBe('<p>text —</p>')
    expect(mdyToHtml('text\n---')).toBe('<p>text</p><hr>')
    expect(mdyToHtml('text\n----')).toBe('<h2 id="text">text</h2>')
    expect(mdyToHtml('text\n---', {documents: true})).toBe(
      '<article>\n<p>text</p>\n</article>'
    )
  })
})

describe('arrows', () => {
  test('replaces the dashed ones', () => {
    expect(mdyToHtml('a --> b, c <-- d, e <--> f')).toBe(
      '<p>a → b, c ← d, e ↔ f</p>'
    )
  })

  test('replaces the doubled ones', () => {
    expect(mdyToHtml('a ==> b, c <== d, e <==> f')).toBe(
      '<p>a ⇒ b, c ⇐ d, e ⇔ f</p>'
    )
  })

  test('leaves the two-character forms alone', () => {
    // `x <= 5` is a comparison and `() => {}` is a function, and neither is
    // written in a code span often enough to be replaced here.
    expect(mdyToHtml('x <= 5, y >= 2, () => {}, a -> b')).toBe(
      '<p>x &#x3C;= 5, y >= 2, () => {}, a -> b</p>'
    )
  })

  test('leaves a longer run alone', () => {
    expect(mdyToHtml('---> and <--- and <===> and <---->')).toBe(
      '<p>---> and &#x3C;--- and &#x3C;===> and &#x3C;----></p>'
    )
  })

  test('needs no space around it', () => {
    expect(mdyToHtml('a-->b')).toBe('<p>a→b</p>')
  })

  test('can be escaped', () => {
    expect(mdyToHtml('\\--> and \\<== stay')).toBe('<p>--> and &#x3C;== stay</p>')
  })

  test('is literal inside a raw code span', () => {
    expect(mdyToHtml('``a --> span`` but --> here')).toBe(
      '<p><code>a --> span</code> but → here</p>'
    )
  })

  test('never reaches fenced code', () => {
    expect(mdyToHtml('```\nkeep --> this\n```')).toBe(
      '<pre><code>keep --> this\n</code></pre>'
    )
  })

  test('works in headings, list items and table cells', () => {
    expect(mdyToHtml('= In --> out')).toBe('<h1 id="in--out">In → out</h1>')
    expect(mdyToHtml('- in --> out')).toContain('<li>in → out</li>')
    expect(mdyToHtml('| in --> out |\n| - |')).toContain('<th>in → out</th>')
  })

  test('can be turned off', () => {
    // The em dash off as well, else the head of the arrow is all that is
    // left behind and the rule under test is not the one being read.
    expect(mdyToHtml('a --> b', {arrows: false, emDash: false})).toBe(
      '<p>a --> b</p>'
    )
  })

  test('takes a table of its own, in any alphabet', () => {
    expect(mdyToHtml('a |-> b --> c', {arrows: {'|->': '↦'}, emDash: false})).toBe(
      '<p>a ↦ b --> c</p>'
    )
  })

  test('extends the default table by spreading it', () => {
    expect(
      mdyToHtml('a |-> b --> c', {arrows: {...defaultArrows, '|->': '↦'}})
    ).toBe('<p>a ↦ b → c</p>')
  })

  test('a custom sequence is hemmed in by its own characters', () => {
    expect(mdyToHtml('a |->> b', {arrows: {'|->': '↦'}})).toBe(
      '<p>a |->> b</p>'
    )
  })

  test('refuses a table entry with nothing to write', () => {
    expect(() => mdyToHtml('a', {arrows: {'-->': ''}})).toThrow(
      /Expected arrow `-->`/
    )
  })

  test('a marker is matched first, whatever the table says', () => {
    // `~~` opens a `<del>` before `~~>` is looked for, which is the reason to
    // keep a custom table clear of the marker sequences.
    expect(mdyToHtml('a ~~> b', {arrows: {'~~>': '⇝'}})).toBe(
      '<p>a <del>> b</del></p>'
    )
  })

  test('is on for `parseInline` too', () => {
    expect(parseInline('in --> out')).toEqual([
      {type: 'text', value: 'in → out'}
    ])
  })
})


describe('autolinks', () => {
  test('links a URL', () => {
    expect(mdyToHtml('see http://example.com now')).toBe(
      '<p>see <a href="http://example.com">http://example.com</a> now</p>'
    )
  })

  test('leaves trailing punctuation out of the URL', () => {
    expect(mdyToHtml('end https://x.com. done')).toBe(
      '<p>end <a href="https://x.com">https://x.com</a>. done</p>'
    )
  })

  test('keeps balanced brackets inside the URL', () => {
    expect(mdyToHtml('(https://x.com/a_(b)) done')).toBe(
      '<p>(<a href="https://x.com/a_(b)">https://x.com/a_(b)</a>) done</p>'
    )
  })

  test('links a bare email through mailto:', () => {
    expect(mdyToHtml('mail me a@b.com')).toBe(
      '<p>mail me <a href="mailto:a@b.com">a@b.com</a></p>'
    )
  })

  test('links protocol-relative and ftp URLs', () => {
    expect(mdyToHtml('//cdn.example.com/lib.js')).toContain(
      'href="//cdn.example.com/lib.js"'
    )
    expect(mdyToHtml('ftp://files.org/x')).toContain('href="ftp://files.org/x"')
  })

  test('does not link a bare domain or a filename', () => {
    expect(mdyToHtml('README.md and node.js and example.com stay')).toBe(
      '<p>README.md and node.js and example.com stay</p>'
    )
  })

  test('the URL survives the `//` marker', () => {
    expect(mdyToHtml('a https://x.com b //em// c')).toBe(
      '<p>a <a href="https://x.com">https://x.com</a> b <em>em</em> c</p>'
    )
  })

  test('nests inside markers', () => {
    expect(mdyToHtml('!!https://x.com!!')).toBe(
      '<p><strong><a href="https://x.com">https://x.com</a></strong></p>'
    )
  })

  test('is literal inside a raw code span', () => {
    expect(mdyToHtml('``https://x.com``')).toBe(
      '<p><code>https://x.com</code></p>'
    )
  })

  test('runs before emoji, so a URL keeps its punctuation', () => {
    expect(mdyToHtml('https://x.com/a:/b :)')).toBe(
      '<p><a href="https://x.com/a:/b">https://x.com/a:/b</a> 😃</p>'
    )
  })

  test('works in headings, list items and table cells', () => {
    expect(mdyToHtml('= See https://x.com')).toContain('<a href="https://x.com"')
    expect(mdyToHtml('- https://x.com')).toContain('<a href="https://x.com"')
    expect(mdyToHtml('| https://x.com |\n| - |')).toContain(
      '<a href="https://x.com"'
    )
  })

  test('leaves a hand-written link alone', () => {
    expect(mdyToHtml('<a href="https://x.com">click')).toBe(
      '<a href="https://x.com">click</a>'
    )
  })

  test('can be turned off', () => {
    expect(mdyToHtml('see https://x.com now', {autolink: false})).toBe(
      '<p>see https:<em>x.com now</em></p>'
    )
  })

  test('produces a hast anchor', () => {
    const tree = mdyToHast('https://x.com')
    const [anchor] = tree.children[0].children

    expect(anchor.tagName).toBe('a')
    expect(anchor.properties).toEqual({href: 'https://x.com'})
  })
})

describe('heading ids', () => {
  test('every heading gets one, at every level', () => {
    expect(mdyToHtml('= One\n\n=== Three Words Here')).toBe(
      '<h1 id="one">One</h1><h3 id="three-words-here">Three Words Here</h3>'
    )
  })

  test('so an anchor written by hand lands on it', () => {
    expect(mdyToHtml('= My Heading\n\n[[ jump | #my-heading ]]')).toBe(
      '<h1 id="my-heading">My Heading</h1><p><a href="#my-heading">jump</a></p>'
    )
  })

  test('an underlined heading gets one too', () => {
    expect(mdyToHtml('Underlined\n----')).toBe(
      '<h2 id="underlined">Underlined</h2>'
    )
  })

  test('the id is the text, markup taken off', () => {
    expect(mdyToHtml('= !!Bold!! and //italic//')).toBe(
      '<h1 id="bold-and-italic"><strong>Bold</strong> and <em>italic</em></h1>'
    )
  })

  test('the same heading twice is two places, so the second is numbered', () => {
    expect(mdyToHtml('== Notes\n\n== Notes\n\n== Notes')).toBe(
      '<h2 id="notes">Notes</h2><h2 id="notes-1">Notes</h2>' +
        '<h2 id="notes-2">Notes</h2>'
    )
  })

  test('a heading with no text to slug gets none', () => {
    expect(mdyToHtml('= ***')).toBe('<h1><strong>*</strong></h1>')
  })

  test('documents in a stream share one run of ids', () => {
    expect(mdyToHtml('= Intro\n\n---\n\n= Intro', {documents: true})).toBe(
      '<article>\n<h1 id="intro">Intro</h1>\n</article>' +
        '<article>\n<h1 id="intro-1">Intro</h1>\n</article>'
    )
  })

  test('a hand-written heading element is left as it was', () => {
    expect(mdyToHtml('<h2 id="mine">Written by hand')).toBe(
      '<h2 id="mine">Written by hand</h2>'
    )
    expect(mdyToHtml('<h2>No id here')).toBe('<h2>No id here</h2>')
  })

  test('the slugifier is the one `[[ label ]]` uses', () => {
    expect(mdyToHtml('= Rule 5: Elements, and Indentation!')).toBe(
      '<h1 id="rule-5-elements-and-indentation">Rule 5: Elements, and ' +
        'Indentation!</h1>'
    )
  })

  test('name them yourself with a slug of your own', () => {
    expect(
      mdyToHtml('= A Heading', {
        headingId: {slug: (text) => text.toLowerCase().replace(/\s+/g, '_')}
      })
    ).toBe('<h1 id="a_heading">A Heading</h1>')
  })

  test('false turns it off', () => {
    expect(mdyToHtml('= A Heading', {headingId: false})).toBe(
      '<h1>A Heading</h1>'
    )
  })
})

describe('setext headings', () => {
  test('underlines with = for h1 and ---- for h2', () => {
    expect(mdyToHtml('Title\n=====')).toBe('<h1 id="title">Title</h1>')
    expect(mdyToHtml('Subtitle\n----')).toBe('<h2 id="subtitle">Subtitle</h2>')
  })

  test('one = is enough, where a dash needs four', () => {
    expect(mdyToHtml('Title\n=')).toBe('<h1 id="title">Title</h1>')
    expect(mdyToHtml('Title\n----')).toBe('<h2 id="title">Title</h2>')
  })

  test('three dashes are the separator, so they are never an underline', () => {
    // Under four, the line goes back to whatever else it would have been: a
    // lone `-` is an empty list item, `--` is an em dash, `---` is a break.
    expect(mdyToHtml('Title\n-')).toBe('<p>Title</p><ul>\n<li></li>\n</ul>')
    expect(mdyToHtml('Title\n--')).toBe('<p>Title —</p>')
    expect(mdyToHtml('Title\n---')).toBe('<p>Title</p><hr>')
    expect(mdyToHtml('Title\n----')).toBe('<h2 id="title">Title</h2>')
  })

  test('the length of the underline carries no meaning past that', () => {
    expect(mdyToHtml('Title\n=')).toBe(mdyToHtml('Title\n=========='))
    expect(mdyToHtml('Title\n----')).toBe(mdyToHtml('Title\n----------'))
  })

  test('takes the whole paragraph as its content', () => {
    expect(mdyToHtml('one\ntwo\n===')).toBe('<h1 id="one-two">one two</h1>')
  })

  test('keeps inline markup', () => {
    expect(mdyToHtml('a !!bold!! title\n===')).toBe(
      '<h1 id="a-bold-title">a <strong>bold</strong> title</h1>'
    )
  })

  test('tolerates trailing whitespace', () => {
    expect(mdyToHtml('Title\n===  ')).toBe('<h1 id="title">Title</h1>')
  })

  test('ends the paragraph, so the next line starts a new block', () => {
    expect(mdyToHtml('Title\n===\nbody')).toBe('<h1 id="title">Title</h1><p>body</p>')
  })

  test('needs a paragraph above it, or it is a break', () => {
    expect(mdyToHtml('---')).toBe('<hr>')
    expect(mdyToHtml('para\n\n---')).toBe('<p>para</p><hr>')
  })

  test('beats an empty rule 1 heading', () => {
    expect(mdyToHtml('===')).toBe('<h3></h3>')
    expect(mdyToHtml('Title\n===')).toBe('<h1 id="title">Title</h1>')
  })

  test('beats an empty list item', () => {
    expect(mdyToHtml('-')).toBe('<ul>\n<li></li>\n</ul>')
    expect(mdyToHtml('----')).toBe('<hr>')
    expect(mdyToHtml('Title\n----')).toBe('<h2 id="title">Title</h2>')
  })

  test('a dashed line with content is still a list', () => {
    expect(mdyToHtml('text\n- item')).toBe(
      '<p>text</p><ul>\n<li>item</li>\n</ul>'
    )
  })

  test('does not disturb a table delimiter row', () => {
    expect(mdyToHtml('a | b\n--- | ---')).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n</table>'
    )
  })

  test('works inside an element', () => {
    expect(mdyToHtml('<section\n  Title\n  ===')).toBe(
      '<section>\n<h1 id="title">Title</h1>\n</section>'
    )
  })

  test('carries position information over both lines', () => {
    const tree = mdyToHast('Title\n=====')
    const [node] = tree.children

    expect(node.tagName).toBe('h1')
    expect(node.position).toEqual({
      start: {line: 1, column: 1},
      end: {line: 2, column: 6}
    })
  })
})

describe('thematic breaks', () => {
  test('takes -, * or _', () => {
    expect(mdyToHtml('---')).toBe('<hr>')
    expect(mdyToHtml('***')).toBe('<hr>')
    expect(mdyToHtml('___')).toBe('<hr>')
  })

  test('takes more than three', () => {
    expect(mdyToHtml('**********')).toBe('<hr>')
  })

  test('allows spaces between the characters', () => {
    expect(mdyToHtml('- - -')).toBe('<hr>')
    expect(mdyToHtml('*  *  *')).toBe('<hr>')
  })

  test('needs three of them, all the same', () => {
    expect(mdyToHtml('--')).toBe('<p>—</p>')
    expect(mdyToHtml('-*-')).toBe('<p>-*-</p>')
    expect(mdyToHtml('--- x')).toBe('<p>--- x</p>')
  })

  test('a long dashed line under a paragraph is still an underline', () => {
    expect(mdyToHtml('a\n----')).toBe('<h2 id="a">a</h2>')
    expect(mdyToHtml('a\n\n----')).toBe('<p>a</p><hr>')
  })

  test('exactly three dashes break the paragraph rather than underline it', () => {
    expect(mdyToHtml('a\n---')).toBe('<p>a</p><hr>')
  })

  test('stars and underscores under a paragraph break it', () => {
    expect(mdyToHtml('a\n***')).toBe('<p>a</p><hr>')
    expect(mdyToHtml('a\n___')).toBe('<p>a</p><hr>')
  })

  test('ends a list rather than joining an item', () => {
    expect(mdyToHtml('- item\n---\nafter')).toBe(
      '<ul>\n<li>item</li>\n</ul><hr><p>after</p>'
    )
  })

  test('ends a table', () => {
    expect(mdyToHtml('| a |\n| - |\n| 1 |\n***')).toContain('</table><hr>')
  })

  test('a lone dash is still an empty list item', () => {
    expect(mdyToHtml('-')).toBe('<ul>\n<li></li>\n</ul>')
  })

  test('the inline `__` marker is untouched', () => {
    expect(mdyToHtml('an __underlined__ word')).toBe(
      '<p>an <u>underlined</u> word</p>'
    )
  })

  test('works inside an element', () => {
    expect(mdyToHtml('<section\n  one\n\n  ---\n\n  two')).toBe(
      '<section>\n<p>one</p>\n<hr>\n<p>two</p>\n</section>'
    )
  })

  test('produces a void hast element with a position', () => {
    const tree = mdyToHast('a\n\n---')
    const node = tree.children[1]

    expect(node.tagName).toBe('hr')
    expect(node.children).toEqual([])
    expect(node.position.start.line).toBe(3)
  })
})

describe('wiki links', () => {
  test('a label alone links to its slug', () => {
    expect(mdyToHtml('see [[ Getting Started ]] now')).toBe(
      '<p>see <a href="getting-started">Getting Started</a> now</p>'
    )
  })

  test('a label and a url link to the url', () => {
    expect(mdyToHtml('[[ Docs | /docs/intro ]]')).toBe(
      '<p><a href="/docs/intro">Docs</a></p>'
    )
  })

  test('works without the spaces', () => {
    expect(mdyToHtml('[[Docs|/x]]')).toBe('<p><a href="/x">Docs</a></p>')
  })

  test('the label is inline content of its own', () => {
    expect(mdyToHtml('[[ the !!hast!! spec | /x ]]')).toBe(
      '<p><a href="/x">the <strong>hast</strong> spec</a></p>'
    )
  })

  test('does not nest an autolink inside the label', () => {
    expect(mdyToHtml('[[ https://x.com | /y ]]')).toBe(
      '<p><a href="/y">https://x.com</a></p>'
    )
  })

  test('keeps paths, dots and fragments in a slug', () => {
    expect(mdyToHtml('[[ docs/intro ]]')).toContain('href="docs/intro"')
    expect(mdyToHtml('[[ Setup#Install ]]')).toContain('href="setup#install"')
  })

  test('drops punctuation from a slug', () => {
    expect(defaultResolve("What's New?")).toBe('whats-new')
    expect(defaultResolve('  Spaced   Out  ')).toBe('spaced-out')
  })

  test('keeps letters that are not ASCII', () => {
    expect(defaultResolve('Café Münster')).toBe('café-münster')
  })

  test('an escaped pipe stays in the label', () => {
    expect(mdyToHtml('[[ a \\| b | /x ]]')).toBe(
      '<p><a href="/x">a | b</a></p>'
    )
  })

  test('an empty or unclosed link is left as text', () => {
    expect(mdyToHtml('a [[ ]] b')).toBe('<p>a [[ ]] b</p>')
    expect(mdyToHtml('a [[ unclosed b')).toBe('<p>a [[ unclosed b</p>')
  })

  test('is literal inside a raw code span', () => {
    expect(mdyToHtml('``[[ raw ]]``')).toBe('<p><code>[[ raw ]]</code></p>')
  })

  test('follows the sanitizing schema for protocols', () => {
    const file = mdy().processSync('[[ x | javascript:alert(1) ]]')

    expect(String(file)).toBe('<p><a>x</a></p>')
    expect(file.messages.map((message) => message.reason)).toEqual([
      '`[[x]]` points at a protocol that is not allowed, dropping the link'
    ])
  })

  test('allows the protocols the schema allows', () => {
    expect(mdyToHtml('[[ mail | mailto:a@b.com ]]')).toContain(
      'href="mailto:a@b.com"'
    )
  })

  test('works in headings, list items and table cells', () => {
    expect(mdyToHtml('= [[ Home ]]')).toBe('<h1 id="home"><a href="home">Home</a></h1>')
    expect(mdyToHtml('- [[ Page ]]')).toContain('<a href="page">Page</a>')
    expect(mdyToHtml('| [[ Page ]] |\n| - |')).toContain(
      '<th><a href="page">Page</a></th>'
    )
  })

  test('does not disturb a task list checkbox', () => {
    expect(mdyToHtml('- [ ] [[ Page ]]')).toContain(
      '<input type="checkbox" disabled> <a href="page">Page</a>'
    )
  })

  test('takes a custom resolver', () => {
    const html = mdyToHtml('[[ My Page ]]', {
      wikiLink: {resolve: (label) => '/wiki/' + defaultResolve(label)}
    })

    expect(html).toBe('<p><a href="/wiki/my-page">My Page</a></p>')
  })

  test('can be turned off', () => {
    expect(mdyToHtml('[[ Page ]]', {wikiLink: false})).toBe('<p>[[ Page ]]</p>')
  })

  test('produces a hast anchor', () => {
    const tree = mdyToHast('[[ Page | /p ]]')
    const [anchor] = tree.children[0].children

    expect(anchor.tagName).toBe('a')
    expect(anchor.properties).toEqual({href: '/p'})
    expect(anchor.children).toEqual([{type: 'text', value: 'Page'}])
  })
})

describe('footnotes', () => {
  const note = 'Text with a note[[ ^1 ]].\n\n[[ ^1 ]]: The note itself.'

  test('turns a reference into a numbered link', () => {
    expect(mdyToHtml(note)).toContain(
      '<sup><a href="#user-content-fn-1" id="user-content-fnref-1"' +
        ' data-footnote-ref aria-describedby="footnote-label">1</a></sup>'
    )
  })

  test('collects the notes into a labelled section at the end', () => {
    const html = mdyToHtml(note)

    expect(html).toContain('<section data-footnotes class="footnotes">')
    expect(html).toContain('<h2 class="sr-only" id="footnote-label">Footnotes</h2>')
    expect(html).toContain('<li id="user-content-fn-1">')
    expect(html.indexOf('<section')).toBeGreaterThan(html.indexOf('</p>'))
  })

  test('links back to the reference', () => {
    expect(mdyToHtml(note)).toContain(
      '<a href="#user-content-fnref-1" data-footnote-backref' +
        ' aria-label="Back to content" class="data-footnote-backref">↩</a>'
    )
  })

  test('numbers by first reference, not by definition', () => {
    const html = mdyToHtml(
      'a[[ ^b ]] then b[[ ^a ]]\n\n[[ ^a ]]: first written\n[[ ^b ]]: second written'
    )

    expect(html).toContain('>1</a></sup> then')
    expect(html.indexOf('second written')).toBeLessThan(
      html.indexOf('first written')
    )
  })

  test('a definition may come before the reference', () => {
    expect(mdyToHtml('[[ ^1 ]]: note\n\ntext[[ ^1 ]]')).toContain(
      '<li id="user-content-fn-1">'
    )
  })

  test('one note referenced twice gets a backref each', () => {
    const html = mdyToHtml('twice[[ ^x ]] again[[ ^x ]]\n\n[[ ^x ]]: shared')

    expect(html).toContain('id="user-content-fnref-x"')
    expect(html).toContain('id="user-content-fnref-x-2"')
    expect(html).toContain('↩<sup>1</sup>')
    expect(html).toContain('↩<sup>2</sup>')
    expect(html.match(/<li /g)).toHaveLength(1)
  })

  test('a reference nothing defines stays text', () => {
    expect(mdyToHtml('no definition[[ ^zz ]] here')).toBe(
      '<p>no definition[[ ^zz ]] here</p>'
    )
  })

  test('a definition nothing references is dropped', () => {
    expect(mdyToHtml('text\n\n[[ ^u ]]: never pointed at')).toBe('<p>text</p>')
  })

  test('the note carries inline markup', () => {
    expect(mdyToHtml('a[[ ^1 ]]\n\n[[ ^1 ]]: a !!bold!! note')).toContain(
      '<strong>bold</strong>'
    )
  })

  test('lines under a definition join it, indented or not', () => {
    expect(mdyToHtml('a[[ ^1 ]]\n\n[[ ^1 ]]: one\n  two\nthree')).toContain(
      '<p>one two three '
    )
  })

  test('a blank line ends the definition', () => {
    const html = mdyToHtml('a[[ ^1 ]]\n\n[[ ^1 ]]: note\n\nafter')

    expect(html).toContain('<p>after</p>')
    expect(html).not.toContain('note after')
  })

  test('sits alongside ordinary wiki links', () => {
    const html = mdyToHtml('[[ Wiki ]] and[[ ^w ]]\n\n[[ ^w ]]: both')

    expect(html).toContain('<a href="wiki">Wiki</a>')
    expect(html).toContain('data-footnote-ref')
  })

  test('is literal inside a raw code span', () => {
    expect(mdyToHtml('``[[ ^1 ]]`` raw\n\n[[ ^1 ]]: x')).toBe(
      '<p><code>[[ ^1 ]]</code> raw</p>'
    )
  })

  test('references work in headings, lists and table cells', () => {
    const source = '\n\n[[ ^1 ]]: note'

    expect(mdyToHtml('= Title[[ ^1 ]]' + source)).toContain('<h1 id="title1">Title<sup>')
    expect(mdyToHtml('- item[[ ^1 ]]' + source)).toContain('<li>item<sup>')
    expect(mdyToHtml('| a[[ ^1 ]] |\n| - |' + source)).toContain('<th>a<sup>')
  })

  test('takes a custom label and prefix', () => {
    const html = mdyToHtml(note, {
      footnotes: {label: 'Notes', prefix: 'x-'}
    })

    expect(html).toContain('<h2 class="sr-only" id="footnote-label">Notes</h2>')
    expect(html).toContain('<li id="x-fn-1">')
  })

  test('can be turned off, and a `^` label never becomes a link', () => {
    expect(mdyToHtml(note, {footnotes: false})).toBe(
      '<p>Text with a note[[ ^1 ]].</p><p>[[ ^1 ]]: The note itself.</p>'
    )
  })

  test('produces a hast section', () => {
    const tree = mdyToHast(note)
    const section = tree.children.at(-1)

    expect(section.tagName).toBe('section')
    expect(section.properties).toEqual({
      dataFootnotes: true,
      className: ['footnotes']
    })
  })
})

describe('comments', () => {
  test('a comment line leaves nothing behind', () => {
    expect(mdyToHtml('#  a note\ntext')).toBe('<p>text</p>')
  })

  test('one space is enough, so a Markdown heading is a comment', () => {
    expect(mdyToHtml('# Title\ntext')).toBe('<p>text</p>')
  })

  test('no space at all is a tag', () => {
    expect(mdyToHtml('#tag and text')).toBe(
      '<p><a href="/tags/tag">#tag</a> and text</p>'
    )
  })

  test('the gap may be spaces or tabs', () => {
    for (const gap of [' ', '  ', '     ', '\t', '\t\t', ' \t']) {
      expect(mdyToHtml('#' + gap + 'a note\ntext')).toBe('<p>text</p>')
    }
  })

  test('a comment with nothing after it is still a comment', () => {
    expect(mdyToHtml('#   \ntext')).toBe('<p>text</p>')
  })

  test('a line of nothing but `#` is a comment too', () => {
    expect(mdyToHtml('#\ntext')).toBe('<p>text</p>')
    expect(mdyToHtml('      #\ntext')).toBe('<p>text</p>')
  })

  test('a `#` against a word is a tag rather than a comment', () => {
    expect(mdyToHtml('#tag\ntext')).toBe(
      '<p><a href="/tags/tag">#tag</a> text</p>'
    )
  })

  test('comment indentation belongs to the author, not the document', () => {
    // Taken out before a column is counted, exactly as a `%` line is: an
    // indented comment opens no `<div>` and an outdented one closes nothing.
    const document = [
      '<section class="rules"',
      '#  what the rules are',
      '  - One',
      '    - a note on One',
      '  - Two'
    ]
    const expected = mdyToHtml(document.join('\n'))

    expect(expected).toBe(
      '<section class="rules">\n<ul>\n<li>One\n<ul>\n<li>a note on One</li>\n' +
        '</ul>\n</li>\n<li>Two</li>\n</ul>\n</section>'
    )

    for (const indent of [' ', '  ', '      ', '\t', '\t  ']) {
      const shifted = document.map((line) =>
        line.startsWith('#') ? indent + line : line
      )

      expect(mdyToHtml(shifted.join('\n'))).toBe(expected)
    }
  })

  test('the lines either side of a comment stay adjacent', () => {
    expect(mdyToHtml('alpha\n#  note\nbeta')).toBe('<p>alpha beta</p>')
    expect(mdyToHtml('text\n#  note\n----')).toBe('<h2 id="text">text</h2>')
  })

  test('a comment between table rows leaves the table whole', () => {
    expect(mdyToHtml('| a | b |\n| - | - |\n      #  note\n| 1 | 2 |')).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n' +
        '<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>'
    )
  })

  test('a fenced block keeps its comments', () => {
    expect(
      mdyToHtml('```py\n#  set the thing up\nx = 1\n```', {highlight: false})
    ).toBe(
      '<pre><code class="language-py">#  set the thing up\nx = 1\n</code></pre>'
    )
  })

  test('a fence inside an element keeps them too', () => {
    expect(
      mdyToHtml('<aside\n  ```py\n  #  kept\n  ```', {highlight: false})
    ).toBe('<aside>\n<pre><code class="language-py">#  kept\n</code></pre>\n</aside>')
  })

  test('an unclosed fence ends where what encloses it does', () => {
    expect(
      mdyToHtml('<aside\n  ```py\n  x = 1\n#  gone\ntail', {highlight: false})
    ).toBe(
      '<aside>\n<pre><code class="language-py">x = 1\n</code></pre>\n</aside>' +
        '<p>tail</p>'
    )
  })

  test('a backslash shows a comment rather than making one', () => {
    expect(mdyToHtml('\\#  shown')).toBe('<p>#  shown</p>')
  })

  test('code can generate a comment, and it is still a comment', () => {
    expect(
      mdyToHtml('% for (const n of [1]) {\n#  hidden {{ n }}\nkept {{ n }}\n% }', {
        script: true
      })
    ).toBe('<p>kept 1</p>')
  })

  test('positions still point at the source the comment came out of', () => {
    const tree = mdyToHast('#  note\n\n= Title')

    expect(tree.children[0].position.start.line).toBe(3)
  })
})

describe('script', () => {
  const loop = '% for (let i=0 ; i<5 ; i++) {\n- item\n% }'

  test('is off unless asked for', () => {
    expect(mdyToHtml(loop)).toContain('<p>% for (let i=0 ; i&#x3C;5 ; i++) {</p>')
  })

  test('a loop repeats the lines it encloses', () => {
    expect(mdyToHtml(loop, {script: true})).toBe(
      '<ul>\n' + '<li>item</li>\n'.repeat(5) + '</ul>'
    )
  })

  test('interpolates with mustache brackets', () => {
    expect(
      mdyToHtml('% for (const n of [1, 2]) {\n- item {{ n }}\n% }', {
        script: true
      })
    ).toBe('<ul>\n<li>item 1</li>\n<li>item 2</li>\n</ul>')
  })

  test('interpolates any expression', () => {
    expect(mdyToHtml('{{ 2 + 2 }} and {{ [1, 2].join("-") }}', {script: true})).toBe(
      '<p>4 and 1-2</p>'
    )
  })

  test('interpolates without any code line', () => {
    expect(
      mdyToHtml('Hello {{ name }}!', {script: {scope: {name: 'World'}}})
    ).toBe('<p>Hello World!</p>')
  })

  test('takes values from a scope', () => {
    const html = mdyToHtml('% for (const r of rules) {\n= {{ r }}\n% }', {
      script: {scope: {rules: ['One', 'Two']}}
    })

    expect(html).toBe('<h1 id="one">One</h1><h1 id="two">Two</h1>')
  })

  test('a conditional can emit nothing', () => {
    expect(
      mdyToHtml('% if (show) {\nvisible\n% }', {script: {scope: {show: false}}})
    ).toBe('')
  })

  test('what it prints goes through every other rule', () => {
    const html = mdyToHtml(
      '% const rows = [[1, 2]]\n| a | b |\n| - | - |\n% for (const r of rows) {\n| {{ r[0] }} | {{ r[1] }} |\n% }',
      {script: true}
    )

    expect(html).toContain('<td>1</td>\n<td>2</td>')
  })

  test('keeps indentation, so it works inside an element', () => {
    expect(
      mdyToHtml('<section\n  % for (const x of [1, 2]) {\n  <p>row {{ x }}\n  % }', {
        script: true
      })
    ).toBe('<section>\n<p>row 1</p>\n<p>row 2</p>\n</section>')
  })

  test('a code line may be indented', () => {
    expect(mdyToHtml('  % const x = 1\n{{ x }}', {script: true})).toBe(
      '<p>1</p>'
    )
  })

  test('code indentation belongs to the author, not the document', () => {
    // A `%` line is lifted out before a column is counted, so how far in it
    // sits is a matter of taste: lined up with the block it opens, or with the
    // markup it encloses, or not at all. The same document is parsed here with
    // its code wearing every indentation in turn.
    const document = [
      '<section class="rules"',
      '% const rules = ["One", "Two"]',
      '% for (const rule of rules) {',
      '  - {{ rule }}',
      '    - note',
      '% }',
      '',
      '  tail'
    ]
    const expected = mdyToHtml(document.join('\n'), {script: true})

    expect(expected).toBe(
      '<section class="rules">\n<ul>\n<li>One\n<ul>\n<li>note</li>\n</ul>\n' +
        '</li>\n<li>Two\n<ul>\n<li>note</li>\n</ul>\n</li>\n</ul>\n' +
        '<p>tail</p>\n</section>'
    )

    for (const indent of [' ', '  ', '      ', '\t', '\t  ']) {
      const shifted = document.map((line) =>
        line.startsWith('%') ? indent + line : line
      )

      expect(mdyToHtml(shifted.join('\n'), {script: true})).toBe(expected)
    }
  })

  test('an indented code line opens no block of its own', () => {
    // Indented past the level around it, any other line would be given a
    // `<div>`. Code is not content, so it is not.
    expect(
      mdyToHtml('one\n\n      % const x = 1\ntwo {{ x }}', {script: true})
    ).toBe('<p>one</p><p>two 1</p>')
  })

  test('an outdented code line closes nothing', () => {
    expect(mdyToHtml('<aside\n  one\n% ;\n  two', {script: true})).toBe(
      '<aside>\n<p>one two</p>\n</aside>'
    )
  })

  test('code between table rows leaves the table whole', () => {
    expect(
      mdyToHtml(
        '| a | b |\n| :- | -: |\n      % for (const n of [1, 2]) {\n| {{ n }} | x |\n% }',
        {script: true}
      )
    ).toBe(
      '<table>\n<thead>\n<tr>\n<th style="text-align: left">a</th>\n' +
        '<th style="text-align: right">b</th>\n</tr>\n</thead>\n<tbody>\n' +
        '<tr>\n<td style="text-align: left">1</td>\n' +
        '<td style="text-align: right">x</td>\n</tr>\n<tr>\n' +
        '<td style="text-align: left">2</td>\n' +
        '<td style="text-align: right">x</td>\n</tr>\n</tbody>\n</table>'
    )
  })

  test('a failed script takes its code away wherever it sat', () => {
    expect(
      mdyToHtml('<aside\n      % oops(\n  one\n  two', {script: true})
    ).toBe('<aside>\n<p>one two</p>\n</aside>')
  })

  test('leaves MDY escapes and code spans alone', () => {
    expect(mdyToHtml('\\!!literal\\!! and ``code``\n% ;', {script: true})).toBe(
      '<p>!!literal!! and <code>code</code></p>'
    )
  })

  test('a backslash writes a literal mustache', () => {
    expect(mdyToHtml('write \\{{ name }} to interpolate', {script: true})).toBe(
      '<p>write {{ name }} to interpolate</p>'
    )
  })

  test('leaves a dollar sign alone', () => {
    expect(mdyToHtml('a ${not} b\n% ;', {script: true})).toBe(
      '<p>a ${not} b</p>'
    )
  })

  test('a line starting with an escaped % is prose', () => {
    expect(mdyToHtml('\\% of users agree\n% ;', {script: true})).toBe(
      '<p>% of users agree</p>'
    )
  })

  test('a code line in a fence is code, not a line of the block', () => {
    // Nothing is raw to this stage: the fence has not been found yet when the
    // code runs, so a loop encloses the lines of a block as it does any other.
    expect(
      mdyToHtml(
        '```js\n% for (const n of [1, 2]) {\nconst a = {{ n }}\n% }\n```',
        {script: true, highlight: false}
      )
    ).toBe(
      '<pre><code class="language-js">const a = 1\nconst a = 2\n</code></pre>'
    )
  })

  test('an escaped code line shows itself, in a fence as in prose', () => {
    expect(
      mdyToHtml('```mdy\n\\% for (const n of ns) {\n```', {
        script: true,
        highlight: false
      })
    ).toBe('<pre><code class="language-mdy">% for (const n of ns) {\n</code></pre>')
  })

  test('two backslashes leave one, and the line is still prose', () => {
    expect(mdyToHtml('\\\\% literal', {script: true})).toBe(
      '<p>\\% literal</p>'
    )
  })

  test('reports a syntax error rather than throwing', () => {
    const file = mdy({script: true}).processSync('% for (')

    expect(file.messages).toHaveLength(1)
    expect(file.messages[0].reason).toMatch(/^Script failed:/)
  })

  test('reports a runtime error and still shows the prose', () => {
    const file = mdy({script: true}).processSync('% missing.thing\ntext')

    expect(String(file)).toBe('<p>text</p>')
    expect(file.messages[0].reason).toContain('missing is not defined')
  })

  test('a raw span is not raw to the code stage, which runs first', () => {
    // Code spans do not exist yet when the code runs, so showing the syntax
    // inside one still needs the backslash.
    expect(mdyToHtml('``{{ 1 }}`` here', {script: true})).toBe(
      '<p><code>1</code> here</p>'
    )
    expect(mdyToHtml('``\\{{ x }}`` here', {script: true})).toBe(
      '<p><code>{{ x }}</code> here</p>'
    )
  })

  test('a document with neither code nor an expression is untouched', () => {
    expect(mdyToHtml('a ${literal} ` b', {script: true})).toBe(
      '<p>a ${literal} ` b</p>'
    )
  })

  test('footnotes defined by code are still collected', () => {
    const html = mdyToHtml(
      '% for (const n of [1]) {\nref[[ ^{{ n }} ]]\n\n[[ ^{{ n }} ]]: note {{ n }}\n% }',
      {script: true}
    )

    expect(html).toContain('data-footnote-ref')
    expect(html).toContain('note 1')
  })
})

describe('script blocks', () => {
  test('a %% line runs on until its brackets come back to even', () => {
    const html = mdyToHtml(
      [
        '%% const rows = [',
        "     ['a', 'b'],",
        "     ['c', 'd']",
        '   ]',
        '% for (const row of rows) {',
        "- {{ row.join('/') }}",
        '% }'
      ].join('\n'),
      {script: true}
    )

    expect(html).toBe('<ul>\n<li>a/b</li>\n<li>c/d</li>\n</ul>')
  })

  test('curly braces count, so a function can be written as itself', () => {
    const html = mdyToHtml(
      [
        '%% transform((tree) => {',
        "     tree.children.push(h('hr'))",
        '     return tree',
        '   })',
        '= Title'
      ].join('\n'),
      {script: true}
    )

    expect(html).toBe('<h1 id="title">Title</h1><hr>')
  })

  test('an object literal survives the trip', () => {
    expect(
      mdyToHtml("%% const it = {\n     name: 'MDY'\n   }\n{{ it.name }}", {
        script: true
      })
    ).toBe('<p>MDY</p>')
  })

  test('a single % still encloses markup rather than code', () => {
    expect(mdyToHtml('% for (const n of [1, 2]) {\n- {{ n }}\n% }', {script: true}))
      .toBe('<ul>\n<li>1</li>\n<li>2</li>\n</ul>')
  })

  test('a %% line that closes on itself takes nothing with it', () => {
    expect(mdyToHtml('%% const x = 1\n{{ x }}', {script: true})).toBe('<p>1</p>')
  })

  test('an unclosed bracket takes no lines at all', () => {
    // Better a line that fails on its own than a document swallowed whole.
    expect(mdyToHtml('%% const x = (\nprose survives\nmore prose', {script: true}))
      .toBe('<p>prose survives more prose</p>')
  })

  test('a bracket inside a string is a character, not a bracket', () => {
    expect(mdyToHtml("%% const label = 'a ( b'\nstill prose", {script: true}))
      .toBe('<p>still prose</p>')
  })

  test('a bracket inside a comment is one too', () => {
    expect(
      mdyToHtml('%% const x = [1, // a ( here\n     2]\n{{ x.length }}', {
        script: true
      })
    ).toBe('<p>2</p>')
  })

  test('a template literal keeps its own braces straight', () => {
    expect(
      mdyToHtml('%% const t = `a ${1 + 1} b`\n{{ t }}', {script: true})
    ).toBe('<p>a 2 b</p>')
  })

  test('another code line ends the run, closed or not', () => {
    const file = mdy({script: true}).processSync('%% const x = (\n% const y = 1\n{{ y }}')

    expect(file.messages.length).toBe(1)
  })

  test('the lines it took up are indented to taste', () => {
    const document = [
      '<section',
      '%% const rows = [',
      "'a'",
      ']',
      '  - {{ rows[0] }}'
    ]
    const expected = mdyToHtml(document.join('\n'), {script: true})

    expect(expected).toBe('<section>\n<ul>\n<li>a</li>\n</ul>\n</section>')

    for (const indent of ['  ', '      ', '\t']) {
      const shifted = document.map((line, at) =>
        at > 0 && at < 4 ? indent + line : line
      )

      expect(mdyToHtml(shifted.join('\n'), {script: true})).toBe(expected)
    }
  })

  test('positions still point at the source behind the block', () => {
    const tree = mdyToHast('%% const x = [\n  1\n]\n\n= Title', {script: true})

    expect(tree.children[0].position.start.line).toBe(5)
  })
})

describe('req and res', () => {
  test('the document is called with a request and a response', () => {
    expect(
      mdyToHtml('{{ req.path }} and {{ typeof res }}', {
        script: {request: {path: '/posts'}}
      })
    ).toBe('<p>/posts and object</p>')
  })

  test('the request is an empty object when the host gave none', () => {
    expect(mdyToHtml('{{ JSON.stringify(req) }}', {script: true})).toBe(
      '<p>{}</p>'
    )
  })

  test('the front matter is on res.data, parsed', () => {
    expect(
      mdyToHtml('+++\ntitle: Hello\nn: 2\n+++\n= {{ res.data.title }} {{ res.data.n }}', {
        script: true
      })
    ).toBe('<h1 id="hello-2">Hello 2</h1>')
  })

  test('res.data is an object even with no front matter to fill it', () => {
    expect(
      mdyToHtml('{{ JSON.stringify(res.data) }}', {script: true})
    ).toBe('<p>{"tags":[],"users":[],"links":[]}</p>')
  })

  test('res.doc is not a tree while the body is still making one', () => {
    expect(
      mdyToHtml('%% res.seen = typeof res.doc\n{{ res.seen }}', {script: true})
    ).toBe('<p>undefined</p>')
  })

  test('res.doc is the finished tree by the time a transform runs', () => {
    expect(
      mdyToHtml(
        [
          '= Title',
          '',
          '%% transform(() => {',
          "     res.doc.children.push(h('hr'))",
          '   })'
        ].join('\n'),
        {script: true}
      )
    ).toBe('<h1 id="title">Title</h1><hr>')
  })

  test('res.doc and the argument a transform is handed are one tree', () => {
    expect(
      mdyToHtml(
        '= Title\n\n%% transform((tree) => {\n     res.same = tree === res.doc\n   })',
        {script: true}
      )
    ).toBe('<h1 id="title">Title</h1>')

    const file = mdy({script: true}).processSync(
      '= Title\n\n%% transform((tree) => {\n     res.same = tree === res.doc\n   })'
    )

    expect(file.data.response.same).toBe(true)
  })

  test('a transform that returns a new tree replaces res.doc as well', () => {
    const file = mdy({script: true}).processSync(
      [
        '= Title',
        '',
        '%% transform(() => {',
        "     return {type: 'root', children: [h('p', 'replaced')]}",
        '   })',
        '%% transform(() => {',
        "     res.saw = res.doc.children[0].tagName",
        '   })'
      ].join('\n')
    )

    expect(String(file)).toBe('<p>replaced</p>')
    expect(file.data.response.saw).toBe('p')
  })

  test('the response comes back on the file, for the host to read', () => {
    const file = mdy({script: {request: {n: 1}}}).processSync(
      '+++\ntitle: T\n+++\n%% res.status = 200\n= {{ res.data.title }}'
    )

    expect(file.data.response.data).toEqual({
      title: 'T',
      tags: [],
      users: [],
      links: []
    })
    expect(file.data.response.status).toBe(200)
    expect(file.data.response.doc.type).toBe('root')
  })

  test('there is no response on the file when code is off', () => {
    const file = mdy().processSync('= Title')

    expect(file.data.response).toBe(undefined)
  })

  test('a scope may shadow a helper but not req or res', () => {
    expect(
      mdyToHtml('{{ h }} {{ typeof req }}', {
        script: {scope: {h: 'shadowed', req: 'no'}, request: {}}
      })
    ).toBe('<p>shadowed object</p>')
  })

  test('each document in a stream answers with its own', () => {
    const file = mdy({documents: true, script: true}).processSync(
      '%% res.mine = 1\nOne\n\n---\n\n%% res.mine = 2\nTwo'
    )

    // The last one parsed is the one the file is left holding.
    expect(file.data.response.mine).toBe(2)
  })
})

describe('what a document refers to', () => {
  /**
   * @param {string} document
   * @param {object} [options]
   */
  function data(document, options) {
    return mdy({script: true, ...options}).processSync(document).data.response
      .data
  }

  test('the two lists are there whether the document named them or not', () => {
    expect(data('nothing here')).toEqual({tags: [], users: [], links: []})
  })

  test('a tag and a mention in the text are written down', () => {
    expect(data('Filed under #syntax-trees by @wooorm.')).toEqual({
      tags: ['syntax-trees'],
      users: ['wooorm'],
      links: []
    })
  })

  test('beside the front matter, when there is some', () => {
    expect(data('+++\ntitle: T\n+++\n#one by @two')).toEqual({
      title: 'T',
      tags: ['one'],
      users: ['two'],
      links: []
    })
  })

  test('a list the author wrote is added to, not replaced', () => {
    expect(
      data('+++\ntags: [written]\nusers: [me]\n+++\n#found by @you')
    ).toEqual({tags: ['written', 'found'], users: ['me', 'you'], links: []})
  })

  test('one entry each, however often it is written', () => {
    expect(data('#a #a #b by @x and @x')).toEqual({
      tags: ['a', 'b'],
      users: ['x'],
      links: []
    })
  })

  test('anything that is not a list is left exactly as it was found', () => {
    expect(data('+++\ntags: nope\n+++\n#a by @b')).toEqual({
      tags: 'nope',
      users: ['b'],
      links: []
    })
  })

  test('from a heading, a list item or a table cell, not just a paragraph', () => {
    expect(data('= #one\n\n- #two\n\n| #three |\n| --- |').tags).toEqual([
      'one',
      'two',
      'three'
    ])
  })

  test('in the order the document reaches them', () => {
    expect(data('#c then #a then #b').tags).toEqual(['c', 'a', 'b'])
  })

  test('nothing is collected for a rule that is turned off', () => {
    expect(data('#a by @b', {tags: false})).toEqual({
      tags: [],
      users: ['b'],
      links: []
    })
  })

  test('a name inside a link label is that label, not a reference', () => {
    // It is unwrapped rather than linked, so counting it would be counting
    // something the reader never sees as a tag.
    expect(data('See [[ #Script ]] and #real.')).toEqual({
      tags: ['real'],
      users: [],
      links: []
    })
  })

  test('an email is an address, so it names nobody', () => {
    expect(data('mail hello@example.com about #real').users).toEqual([])
  })

  test('a link to a page of your own is written down', () => {
    expect(data('See [[ the API | /docs/api ]].').links).toEqual(['/docs/api'])
  })

  test('a link out to the internet is nobody else\'s business', () => {
    expect(
      data('[[ hast | https://github.com/syntax-tree/hast ]] and //unpkg.com/mdy')
        .links
    ).toEqual([])
  })

  test('a link down the page is not a link to another page', () => {
    expect(data('See [[ top | #intro ]] and [[ x | #b ]].').links).toEqual([])
  })

  test('a written <a href> counts as much as a [[ … ]]', () => {
    expect(data('<a href="/docs/api">the API').links).toEqual(['/docs/api'])
  })

  test('a tag or a mention has its own list and stays out of this one', () => {
    expect(data('#tag by @user').links).toEqual([])
  })

  test('one entry each, in the order the document reaches them', () => {
    expect(
      data('[[ x | /b ]] then [[ y | /a ]] then [[ z | /b ]]').links
    ).toEqual(['/b', '/a'])
  })

  test('a list the author wrote is added to here as well', () => {
    expect(data('+++\nlinks: [/written]\n+++\n[[ x | /found ]]').links).toEqual([
      '/written',
      '/found'
    ])
  })
})

describe('page links are tidied on the way through', () => {
  /** @param {string} document */
  function href(document) {
    return /href="([^"]*)"/.exec(mdyToHtml(document))?.[1]
  }

  test('lower cased, with spaces as dashes', () => {
    expect(href('<a href="/Docs/API Reference">x')).toBe(
      '/docs/api-reference'
    )
    expect(href('[[ y | Getting Started ]]')).toBe('getting-started')
  })

  test('a label with no URL of its own was already tidy', () => {
    expect(href('[[ Getting Started ]]')).toBe('getting-started')
  })

  test('a relative step upward is still a page', () => {
    expect(href('<a href="../Up One">x')).toBe('../up-one')
  })

  test('somebody else\'s URL is left exactly as it was written', () => {
    expect(href('<a href="https://Example.com/A Path">x')).toBe(
      'https://Example.com/A Path'
    )
    expect(href('<a href="//UNPKG.com/MDY">x')).toBe('//UNPKG.com/MDY')
    expect(href('<a href="mailto:A@B.com">x')).toBe('mailto:A@B.com')
  })

  test('a fragment names an id, so its case is the id\'s', () => {
    expect(href('<a href="#Intro">x')).toBe('#Intro')
    expect(href('[[ y | #Intro ]]')).toBe('#Intro')
  })

  test('an href on anything but an <a> is left alone', () => {
    expect(mdyToHtml('<img src="/A.png"')).toBe('<img src="/A.png">')
  })

  test('an <a> with no href at all is left alone', () => {
    expect(mdyToHtml('<a>no href')).toBe('<a>no href</a>')
  })

  test('a tag link keeps the case of the name it was written with', () => {
    // `/tags/` is the host’s prefix and the name is the author’s: neither is
    // this rule’s to tidy.
    expect(href('#Syntax-Trees')).toBe('/tags/Syntax-Trees')
  })
})

describe('when a document is asked what it refers to', () => {
  /**
   * @param {string} document
   * @param {object} [options]
   */
  function data(document, options) {
    return mdy({script: true, ...options}).processSync(document).data.response
      .data
  }

  test('the lists are empty while the body runs and full by the transform', () => {
    const file = mdy({script: true}).processSync(
      [
        '%% res.early = res.data.tags.length',
        'Filed under #one and #two.',
        '%% transform(() => {',
        '     res.late = res.data.tags.length',
        '   })'
      ].join('\n')
    )

    // Same reason `res.doc` is not a tree yet: the text has not been read
    // when the body runs, and reading it is what fills these.
    expect(file.data.response.early).toBe(0)
    expect(file.data.response.late).toBe(2)
  })

  test('each document in a stream refers to its own', () => {
    const tree = mdyToHast('#one\n\n---\n\n#two', {documents: true})

    expect(tree.children.map((node) => node.data)).toEqual([undefined, undefined])
  })

  test('a document with front matter in a stream keeps its own lists', () => {
    const tree = mdyToHast(
      '+++\ntitle: One\n+++\n#one\n\n---\n\n+++\ntitle: Two\n+++\n#two',
      {documents: true}
    )

    expect(tree.children.map((node) => node.data.matter.tags)).toEqual([
      ['one'],
      ['two']
    ])
  })

  test('a document can read its own back and write with them', () => {
    expect(
      mdyToHtml(
        [
          'Filed under #mdy and #hast.',
          '',
          '%% transform(() => {',
          "     res.doc.children.push(h('p', res.data.tags.join(', ')))",
          '   })'
        ].join('\n'),
        {script: true}
      )
    ).toContain('<p>mdy, hast</p>')
  })
})

describe('script transforms', () => {
  test('runs a registered function on the finished tree', () => {
    const html = mdyToHtml(
      '% transform((tree) => {\n%   tree.children.push(h("p", "added"))\n% })\nfirst',
      {script: true}
    )

    expect(html).toBe('<p>first</p><p>added</p>')
  })

  test('a transform may return a replacement tree', () => {
    expect(
      mdyToHtml('% transform(() => ({type: "root", children: [h("b", "new")]}))\nold', {
        script: true
      })
    ).toBe('<b>new</b>')
  })

  test('runs several in the order they were registered', () => {
    const html = mdyToHtml(
      '% transform((t) => { t.children.push(h("p", "one")) })\n' +
        '% transform((t) => { t.children.push(h("p", "two")) })\n' +
        'x',
      {script: true}
    )

    expect(html).toBe('<p>x</p><p>one</p><p>two</p>')
  })

  test('sees content the code generated', () => {
    const html = mdyToHtml(
      '% for (const n of [1, 2]) {\n= Heading {{ n }}\n% }\n' +
        '% transform((tree) => {\n' +
        '%   visit(tree, "element", (node) => {\n' +
        '%     if (node.tagName === "h1") node.properties.id = slug(toText(node))\n' +
        '%   })\n' +
        '% })',
      {script: true}
    )

    expect(html).toBe('<h1 id="heading-1">Heading 1</h1><h1 id="heading-2">Heading 2</h1>')
  })

  test('sees the footnote section', () => {
    const html = mdyToHtml(
      '% transform((tree) => {\n' +
        '%   visit(tree, "element", (node) => {\n' +
        '%     if (node.tagName === "section") node.properties.dataSeen = true\n' +
        '%   })\n' +
        '% })\n' +
        'a[[ ^1 ]]\n\n[[ ^1 ]]: note',
      {script: true}
    )

    expect(html).toContain('data-seen')
  })

  test('builds a table of contents from the headings', () => {
    const document = [
      '<div id=toc',
      '',
      '% transform((tree) => {',
      '%   const items = []',
      '%   visit(tree, "element", (node) => {',
      '%     if (node.tagName !== "h2") return',
      '%     const id = slug(toText(node))',
      '%     node.properties.id = id',
      '%     items.push(h("li", h("a", {href: "#" + id}, toText(node))))',
      '%   })',
      '%   visit(tree, "element", (node) => {',
      '%     if (node.properties.id === "toc") node.children = [h("ul", items)]',
      '%   })',
      '% })',
      '',
      '== First Section',
      '',
      '== Second Section'
    ].join('\n')

    const html = mdyToHtml(document, {script: true})

    expect(html).toContain('<a href="#first-section">First Section</a>')
    expect(html).toContain('<a href="#second-section">Second Section</a>')
    expect(html).toContain('<h2 id="first-section">First Section</h2>')
  })

  test('toText strips the markup off a node', () => {
    const html = mdyToHtml(
      '% transform((tree) => {\n%   tree.children = [h("p", toText(tree))]\n% })\n' +
        '= A !!bold!! title',
      {script: true}
    )

    expect(html).toBe('<p>A bold title</p>')
  })

  test('reports a failing transform rather than throwing', () => {
    const file = mdy({script: true}).processSync(
      '% transform(() => { throw new Error("nope") })\ntext'
    )

    expect(String(file)).toBe('<p>text</p>')
    expect(file.messages[0].reason).toBe('Transform failed: nope')
  })

  test('the host scope may shadow a helper', () => {
    expect(
      mdyToHtml('{{ h }}', {script: {scope: {h: 'shadowed'}}})
    ).toBe('<p>shadowed</p>')
  })

  test('is unavailable when script is off', () => {
    expect(mdyToHtml('% transform(() => {})\ntext')).toBe(
      '<p>% transform(() => {}) text</p>'
    )
  })
})

describe('tags and mentions', () => {
  test('links a tag and a mention', () => {
    expect(mdyToHtml('filed under #markup by @wooorm')).toBe(
      '<p>filed under <a href="/tags/markup">#markup</a> by ' +
        '<a href="/users/wooorm">@wooorm</a></p>'
    )
  })

  test('takes letters, digits, underscores and hyphens after the first letter', () => {
    expect(mdyToHtml('#syntax-trees #v2 #_draft')).toContain(
      '<a href="/tags/syntax-trees">#syntax-trees</a>'
    )
  })

  test('a number is not a tag — that is how issues and invoices are written', () => {
    expect(mdyToHtml('#42')).toBe('<p>#42</p>')
    expect(mdyToHtml('Invoice #57')).toBe('<p>Invoice #57</p>')
    expect(mdyToHtml('@42')).toBe('<p>@42</p>')
  })

  test('stops before trailing punctuation', () => {
    expect(mdyToHtml('#tag. #tag- (#tag)')).toBe(
      '<p><a href="/tags/tag">#tag</a>. <a href="/tags/tag">#tag</a>- ' +
        '(<a href="/tags/tag">#tag</a>)</p>'
    )
  })

  test('has to start a word', () => {
    expect(mdyToHtml('a#b and x@y stay')).toBe('<p>a#b and x@y stay</p>')
  })

  test('leaves an email address to the autolinker', () => {
    expect(mdyToHtml('mail hello@example.com')).toBe(
      '<p>mail <a href="mailto:hello@example.com">hello@example.com</a></p>'
    )
  })

  test('leaves a URL fragment alone', () => {
    expect(mdyToHtml('see https://x.com#frag')).toBe(
      '<p>see <a href="https://x.com#frag">https://x.com#frag</a></p>'
    )
  })

  test('is literal inside a raw code span', () => {
    expect(mdyToHtml('``#raw @raw``')).toBe('<p><code>#raw @raw</code></p>')
  })

  test('can be escaped', () => {
    expect(mdyToHtml('\\#escaped and \\@escaped')).toBe(
      '<p>#escaped and @escaped</p>'
    )
  })

  test('works inside markers and other blocks', () => {
    expect(mdyToHtml('!!#bold!!')).toBe(
      '<p><strong><a href="/tags/bold">#bold</a></strong></p>'
    )
    expect(mdyToHtml('= About #mdy')).toContain('<a href="/tags/mdy">#mdy</a>')
    expect(mdyToHtml('- by @you')).toContain('<a href="/users/you">@you</a>')
  })

  test('encodes a name that needs it', () => {
    expect(mdyToHtml('#café')).toBe(
      '<p><a href="/tags/caf%C3%A9">#café</a></p>'
    )
  })

  test('takes a prefix as a plain string', () => {
    expect(mdyToHtml('#a @b', {tags: '/t/', mentions: '/u/'})).toBe(
      '<p><a href="/t/a">#a</a> <a href="/u/b">@b</a></p>'
    )
  })

  test('takes a resolver for the whole URL', () => {
    expect(
      mdyToHtml('@b', {mentions: {resolve: (n) => 'https://x.com/' + n}})
    ).toBe('<p><a href="https://x.com/b">@b</a></p>')
  })

  test('each can be turned off on its own', () => {
    expect(mdyToHtml('#a @b', {tags: false})).toBe(
      '<p>#a <a href="/users/b">@b</a></p>'
    )
    expect(mdyToHtml('#a @b', {mentions: false})).toBe(
      '<p><a href="/tags/a">#a</a> @b</p>'
    )
  })

  test('a bare # or @ is just itself', () => {
    // Not at the head of a line, where a `#` and a space is a comment.
    expect(mdyToHtml('a # and @ alone')).toBe('<p>a # and @ alone</p>')
    expect(mdyToHtml('| # | a |\n| - | - |')).toContain('<th>#</th>')
  })

  test('produces a hast anchor', () => {
    const tree = mdyToHast('#mdy')
    const [anchor] = tree.children[0].children

    expect(anchor.tagName).toBe('a')
    expect(anchor.properties).toEqual({href: '/tags/mdy'})
    expect(anchor.children).toEqual([{type: 'text', value: '#mdy'}])
  })
})

describe('multiple documents', () => {
  const stream = '= One\n\ntext\n\n---\n\n= Two\n\nmore'

  test('is off unless asked for, so `---` keeps its meanings', () => {
    expect(mdyToHtml(stream)).toBe(
      '<h1 id="one">One</h1><p>text</p><hr><h1 id="two">Two</h1><p>more</p>'
    )
    expect(mdyToHtml('Title\n----')).toBe('<h2 id="title">Title</h2>')
  })

  test('puts each document in an article', () => {
    expect(mdyToHtml(stream, {documents: true})).toBe(
      '<article>\n<h1 id="one">One</h1>\n<p>text</p>\n</article>' +
        '<article>\n<h1 id="two">Two</h1>\n<p>more</p>\n</article>'
    )
  })

  test('takes a tag name for the wrapper', () => {
    expect(mdyToHtml(stream, {documents: 'section'})).toContain('<section>')
  })

  test('can run the documents together unwrapped', () => {
    expect(mdyToHtml(stream, {documents: {wrapper: false}})).toBe(
      '<h1 id="one">One</h1><p>text</p><h1 id="two">Two</h1><p>more</p>'
    )
  })

  test('needs exactly three dashes, so breaks still work', () => {
    expect(mdyToHtml('a\n\n----\n\nb', {documents: true})).toBe(
      '<article>\n<p>a</p>\n<hr>\n<p>b</p>\n</article>'
    )
    expect(mdyToHtml('a\n\n***\n\nb', {documents: true})).toContain('<hr>')
  })

  test('an underline still underlines, being four dashes or more', () => {
    expect(mdyToHtml('Title\n----', {documents: true})).toBe(
      '<article>\n<h2 id="title">Title</h2>\n</article>'
    )
    expect(mdyToHtml('Title\n--------', {documents: true})).toContain(
      '<h2 id="title">Title</h2>'
    )
  })

  test('tolerates trailing whitespace on the separator', () => {
    expect(mdyToHtml('a\n---  \nb', {documents: true})).toBe(
      '<article>\n<p>a</p>\n</article><article>\n<p>b</p>\n</article>'
    )
  })

  test('a leading separator opens the first document', () => {
    expect(mdyToHtml('---\na\n---\nb', {documents: true})).toBe(
      '<article>\n<p>a</p>\n</article><article>\n<p>b</p>\n</article>'
    )
  })

  test('drops documents holding nothing', () => {
    expect(mdyToHtml('a\n---\n\n\n---\nb', {documents: true})).toBe(
      '<article>\n<p>a</p>\n</article><article>\n<p>b</p>\n</article>'
    )
  })

  test('a source with no separator is one document', () => {
    expect(mdyToHtml('just this', {documents: true})).toBe(
      '<article>\n<p>just this</p>\n</article>'
    )
  })

  test('keeps footnote ids unique across documents', () => {
    const html = mdyToHtml(
      'a[[ ^1 ]]\n\n[[ ^1 ]]: first\n\n---\n\nb[[ ^1 ]]\n\n[[ ^1 ]]: second',
      {documents: true}
    )

    expect(html).toContain('id="user-content-fn-1"')
    expect(html).toContain('id="user-content-1-fn-1"')
    expect(html).toContain('href="#user-content-1-fnref-1"')
  })

  test('numbers footnotes from one in each document', () => {
    const html = mdyToHtml(
      'a[[ ^x ]]\n\n[[ ^x ]]: one\n\n---\n\nb[[ ^y ]]\n\n[[ ^y ]]: two',
      {documents: true}
    )

    expect(html.match(/>1<\/a><\/sup>/g)).toHaveLength(2)
  })

  test('a script belongs to its own document', () => {
    const file = mdy({documents: true, script: true}).processSync(
      '% const x = 1\n{{ x }}\n\n---\n\n{{ typeof x }}'
    )

    expect(String(file)).toBe(
      '<article>\n<p>1</p>\n</article><article>\n<p>undefined</p>\n</article>'
    )
    expect(file.messages).toEqual([])
  })

  test('a transform only sees its own document', () => {
    const html = mdyToHtml(
      '% transform((t) => { t.children.push(h("b", "here")) })\none\n\n---\n\ntwo',
      {documents: true, script: true}
    )

    expect(html).toBe(
      '<article>\n<p>one</p>\n<b>here</b>\n</article><article>\n<p>two</p>\n</article>'
    )
  })

  test('splitDocuments returns the sources on their own', () => {
    expect(splitDocuments('a\n---\nb\n---\nc')).toEqual(['a', 'b', 'c'])
    expect(splitDocuments('only')).toEqual(['only'])
    expect(splitDocuments('')).toEqual([])
  })

  test('produces a hast root of wrappers', () => {
    const tree = mdyToHast(stream, {documents: true})

    expect(tree.type).toBe('root')
    expect(tree.children.map((node) => node.tagName)).toEqual([
      'article',
      'article'
    ])
  })
})

describe('front matter', () => {
  const document = '+++\ntitle: Hello\ntags: [a, b]\ndraft: false\n+++\n\n= Body'

  test('takes the block off the top', () => {
    expect(mdyToHtml(document)).toBe('<h1 id="body">Body</h1>')
  })

  test('puts the data on the tree', () => {
    expect(mdyToHast(document).data).toEqual({
      matter: {title: 'Hello', tags: ['a', 'b'], draft: false, users: [], links: []}
    })
  })

  test('puts the data on the file', () => {
    const file = mdy().processSync(document)

    expect(file.data.matter).toEqual({
      title: 'Hello',
      tags: ['a', 'b'],
      draft: false,
      users: [],
      links: []
    })
  })

  test('is in scope for code', () => {
    expect(
      mdyToHtml('+++\ntitle: Hello\n+++\n= {{ matter.title }}', {script: true})
    ).toBe('<h1 id="hello">Hello</h1>')
  })

  test('code may loop over it', () => {
    const html = mdyToHtml(
      '+++\ntags: [one, two]\n+++\n% for (const tag of matter.tags) {\n- {{ tag }}\n% }',
      {script: true}
    )

    expect(html).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
  })

  test('tolerates blank lines above the fence', () => {
    expect(mdyToHtml('\n\n+++\na: 1\n+++\nbody')).toBe('<p>body</p>')
  })

  test('has to be at the top', () => {
    expect(mdyToHtml('text\n\n+++\na: 1\n+++')).toBe('<p>text</p><p>+++ a: 1 +++</p>')
  })

  test('an unclosed fence is left as prose', () => {
    expect(mdyToHtml('+++\nnot closed\n\ntext')).toBe(
      '<p>+++ not closed</p><p>text</p>'
    )
  })

  test('an empty block gives the three lists and nothing else', () => {
    expect(mdyToHast('+++\n+++\nbody').data).toEqual({
      matter: {tags: [], users: [], links: []}
    })
  })

  test('reports bad YAML and keeps the content', () => {
    const file = mdy().processSync('+++\na: [1,\n+++\nbody')

    expect(String(file)).toBe('<p>body</p>')
    expect(file.messages[0].reason).toMatch(/^Front matter failed to parse:/)
  })

  test('can be turned off', () => {
    expect(mdyToHtml('+++\na: 1\n+++\nbody', {frontmatter: false})).toBe(
      '<p>+++ a: 1 +++ body</p>'
    )
  })

  test('takes a different fence', () => {
    expect(
      mdyToHast('~~~\na: 1\n~~~\nbody', {frontmatter: '~~~'}).data
    ).toEqual({matter: {a: 1, tags: [], users: [], links: []}})
  })

  test('a document without any gets no data', () => {
    expect(mdyToHast('just text').data).toBeUndefined()
  })

  describe('in a stream', () => {
    const stream =
      '+++\ntitle: One\n+++\n\n= First\n\n---\n\n+++\ntitle: Two\n+++\n\n= Second'

    test('each document has its own', () => {
      const tree = mdyToHast(stream, {documents: true})

      expect(tree.children.map((node) => node.data)).toEqual([
        {matter: {title: 'One', tags: [], users: [], links: []}},
        {matter: {title: 'Two', tags: [], users: [], links: []}}
      ])
    })

    test('the file holds the first, and all of them', () => {
      const file = mdy({documents: true}).processSync(stream)

      expect(file.data.matter).toEqual({
        title: 'One',
        tags: [],
        users: [],
        links: []
      })
      expect(file.data.documents).toEqual([
        {title: 'One', tags: [], users: [], links: []},
        {title: 'Two', tags: [], users: [], links: []}
      ])
    })

    test('each document reads its own in code', () => {
      const html = mdyToHtml(
        '+++\ntitle: One\n+++\n= {{ matter.title }}\n\n---\n\n+++\ntitle: Two\n+++\n= {{ matter.title }}',
        {documents: true, script: true}
      )

      expect(html).toBe(
        '<article>\n<h1 id="one">One</h1>\n</article><article>\n<h1 id="two">Two</h1>\n</article>'
      )
    })
  })
})

describe('code fences', () => {
  test('fences with backticks or tildes', () => {
    expect(mdyToHtml('```\ncode\n```')).toBe('<pre><code>code\n</code></pre>')
    expect(mdyToHtml('~~~\ncode\n~~~')).toBe('<pre><code>code\n</code></pre>')
  })

  test('takes the content literally', () => {
    expect(mdyToHtml('```\n= not a heading !!not bold!! | not a table\n```')).toBe(
      '<pre><code>= not a heading !!not bold!! | not a table\n</code></pre>'
    )
  })

  test('names the language on the code element', () => {
    expect(mdyToHtml('```js\nx\n```', {highlight: false})).toBe(
      '<pre><code class="language-js">x\n</code></pre>'
    )
  })

  test('uses only the first word of the info', () => {
    expect(mdyToHtml('```js title="a b"\nx\n```', {highlight: false})).toContain(
      'class="language-js"'
    )
  })

  test('has no class without an info string', () => {
    expect(mdyToHtml('```\nx\n```')).toBe('<pre><code>x\n</code></pre>')
  })

  test('keeps indentation inside the block', () => {
    expect(mdyToHtml('```\nif (x) {\n  y()\n}\n```', {highlight: false})).toBe(
      '<pre><code>if (x) {\n  y()\n}\n</code></pre>'
    )
  })

  test('takes the fence indentation off its content', () => {
    expect(
      mdyToHtml('<figure\n  ```\n  code\n    deeper\n  ```', {highlight: false})
    ).toBe('<figure>\n<pre><code>code\n  deeper\n</code></pre>\n</figure>')
  })

  test('a longer fence holds a shorter one', () => {
    expect(mdyToHtml('````\na ``` b\n````')).toBe(
      '<pre><code>a ``` b\n</code></pre>'
    )
  })

  test('a tilde fence holds backticks', () => {
    expect(mdyToHtml('~~~\n```js\n~~~')).toBe(
      '<pre><code>```js\n</code></pre>'
    )
  })

  test('an unclosed fence runs to the end', () => {
    expect(mdyToHtml('```\ncode')).toBe('<pre><code>code\n</code></pre>')
  })

  test('an empty fence is an empty block', () => {
    expect(mdyToHtml('```\n```')).toBe('<pre><code></code></pre>')
  })

  test('interrupts a paragraph', () => {
    expect(mdyToHtml('text\n```\ncode\n```')).toBe(
      '<p>text</p><pre><code>code\n</code></pre>'
    )
  })

  test('a backtick fence cannot carry backticks in its info', () => {
    // Not a fence, so it is prose, and the line under it joins the paragraph.
    expect(mdyToHtml('``` a`b\nx')).toBe('<p><code>` a`b x</code></p>')
  })

  describe('highlighting', () => {
    test('colours a known language', () => {
      const html = mdyToHtml('```js\nconst x = 1\n```')

      expect(html).toContain('class="language-js hljs"')
      expect(html).toContain('<span class="hljs-keyword">const</span>')
    })

    test('leaves an unknown language plain but labelled', () => {
      expect(mdyToHtml('```nosuchlang\nx\n```')).toBe(
        '<pre><code class="language-nosuchlang">x\n</code></pre>'
      )
    })

    test('can be turned off', () => {
      expect(mdyToHtml('```js\nconst x = 1\n```', {highlight: false})).toBe(
        '<pre><code class="language-js">const x = 1\n</code></pre>'
      )
    })

    test('takes another highlighter', () => {
      const highlight = {
        registered: () => true,
        highlight: () => ({children: [{type: 'text', value: 'swapped'}]})
      }

      expect(mdyToHtml('```js\nx\n```', {highlight})).toBe(
        '<pre><code class="language-js hljs">swapped</code></pre>'
      )
    })

    test('survives a highlighter that throws', () => {
      const highlight = {
        registered: () => true,
        highlight: () => {
          throw new Error('nope')
        }
      }

      expect(mdyToHtml('```js\nx\n```', {highlight})).toBe(
        '<pre><code class="language-js">x\n</code></pre>'
      )
    })
  })

  test('produces a hast pre and code', () => {
    const tree = mdyToHast('```js\nx\n```', {highlight: false})
    const [pre] = tree.children

    expect(pre.tagName).toBe('pre')
    expect(pre.children[0].tagName).toBe('code')
    expect(pre.children[0].properties).toEqual({className: ['language-js']})
  })
})

describe('editable tasks', () => {
  /**
   * The forms a document produces, flattened to their hidden fields.
   *
   * @param {string} document
   * @param {object} [options]
   */
  function forms(document, options = {tasks: true}) {
    /** @type {Array<Record<string, string>>} */
    const found = []

    walk(mdyToHast(document, options))

    return found

    /** @param {any} node */
    function walk(node) {
      if (node.tagName === 'form') {
        /** @type {Record<string, string>} */
        const fields = {}

        for (const child of node.children) {
          if (child.properties?.type === 'hidden') {
            fields[child.properties.name] = child.properties.value
          }
        }

        found.push(fields)
      }

      for (const child of node.children ?? []) walk(child)
    }
  }

  /**
   * What a handler would do with one: put the character where it was told.
   *
   * @param {string} source
   * @param {Record<string, string>} form
   * @param {string} next
   */
  function apply(source, form, next) {
    const lines = source.split('\n')
    const line = Number(form.line) - 1
    const column = Number(form.column) - 1

    expect(lines[line][column]).toBe(form.was)

    lines[line] =
      lines[line].slice(0, column) + next + lines[line].slice(column + 1)

    return lines.join('\n')
  }

  /**
   * What the form actually sends when clicked.
   *
   * @param {string} document
   */
  function submits(document) {
    return [...mdyToHtml(document, {tasks: true}).matchAll(
      /name="next" value="(.)"/g
    )].map((match) => match[1])
  }

  test('is off by default, leaving the checkbox disabled', () => {
    expect(mdyToHtml('- [x] done')).toContain(
      '<input type="checkbox" checked disabled>'
    )
    expect(mdyToHtml('- [x] done')).not.toContain('<form')
  })

  test('wraps the box in a form posting to the page', () => {
    const html = mdyToHtml('- [ ] feed the cat', {tasks: true})

    expect(html).toContain('<form method="post" class="task-list-item-form">')
    expect(html).not.toContain('action=')
    expect(html).not.toContain('disabled')
  })

  test('the box is itself the submit, so one click sends it', () => {
    const html = mdyToHtml('- [ ] feed the cat', {tasks: true})

    expect(html).toContain(
      '<button type="submit" name="next" value="x" role="checkbox"' +
        ' aria-checked="false" aria-label="feed the cat"' +
        ' class="task-list-item-toggle">'
    )
  })

  test('sends the character to write, which is the opposite of now', () => {
    expect(mdyToHtml('- [ ] a', {tasks: true})).toContain('name="next" value="x"')
    expect(mdyToHtml('- [x] a', {tasks: true})).toContain('name="next" value=" "')
  })

  test('shows a box even with no stylesheet', () => {
    expect(mdyToHtml('- [ ] a', {tasks: true})).toContain(
      '<span aria-hidden="true">☐</span>'
    )
    expect(mdyToHtml('- [x] a', {tasks: true})).toContain(
      '<span aria-hidden="true">☑</span>'
    )
  })

  test('carries the line and column of the state character', () => {
    expect(forms('- [ ] one\n- [x] two')).toEqual([
      {line: '1', column: '4', was: ' '},
      {line: '2', column: '4', was: 'x'}
    ])
  })

  test('the location edits the source it came from', () => {
    const source = '- [ ] one\n- [x] two'
    const next = submits(source)
    let out = source

    forms(source).forEach((form, index) => {
      out = apply(out, form, next[index])
    })

    expect(out).toBe('- [x] one\n- [ ] two')
  })

  test('locates an indented item', () => {
    const source = '<section\n  - [ ] deep'

    expect(forms(source)).toEqual([{line: '2', column: '6', was: ' '}])
    expect(apply(source, forms(source)[0], 'x')).toBe('<section\n  - [x] deep')
  })

  test('locates a nested item', () => {
    const source = '- parent\n  - [ ] child'

    expect(apply(source, forms(source)[0], 'x')).toBe('- parent\n  - [x] child')
  })

  test('locates an ordered item, whatever the number', () => {
    const source = '3. [ ] three\n4) [x] four'

    expect(forms(source)).toEqual([
      {line: '1', column: '5', was: ' '},
      {line: '2', column: '5', was: 'x'}
    ])
  })

  test('counts past front matter', () => {
    const source = '+++\ntitle: T\n+++\n\n- [ ] after matter'

    expect(forms(source)).toEqual([{line: '5', column: '4', was: ' '}])
    expect(apply(source, forms(source)[0], 'x')).toContain('- [x] after matter')
  })

  test('counts past a document separator', () => {
    const source = '- [ ] first\n\n---\n\n- [x] second'
    const found = forms(source, {tasks: true, documents: true})

    expect(found).toEqual([
      {line: '1', column: '4', was: ' '},
      {line: '5', column: '4', was: 'x'}
    ])
    expect(apply(source, found[1], ' ')).toContain('- [ ] second')
  })

  test('names the box after the item, for anyone not looking at it', () => {
    const html = mdyToHtml('- [x] !!ship!! it', {tasks: true})

    expect(html).toContain('aria-label="ship it"')
    expect(html).toContain('role="checkbox"')
    expect(html).toContain('aria-checked="true"')
  })

  test('has no separate submit button', () => {
    expect(mdyToHtml('- [ ] x', {tasks: true})).not.toContain('Save')
    expect(mdyToHtml('- [ ] x', {tasks: true}).match(/<button/g)).toHaveLength(1)
  })

  test('a real checkbox is available for pages that will wire it up', () => {
    const html = mdyToHtml('- [x] x', {tasks: {control: 'checkbox'}})

    expect(html).toContain('<input type="checkbox" name="next" value="x" checked')
    expect(html).not.toContain('<button')
  })

  test('takes an action and a method', () => {
    expect(
      mdyToHtml('- [ ] x', {tasks: {action: '/toggle', method: 'get'}})
    ).toContain('<form method="get" action="/toggle"')
  })

  test('leaves plain list items alone', () => {
    expect(mdyToHtml('- plain', {tasks: true})).toBe(
      '<ul>\n<li>plain</li>\n</ul>'
    )
  })

  test('lineOffset shifts every position', () => {
    expect(forms('- [ ] x', {tasks: true, lineOffset: 10})).toEqual([
      {line: '11', column: '4', was: ' '}
    ])
    expect(mdyToHast('a', {lineOffset: 4}).children[0].position.start.line).toBe(5)
  })
})

describe('positions through generated lines', () => {
  test('a task after a code line reports its own line', () => {
    const source = '% const who = "cat"\n\n- [ ] feed the {{ who }}'
    const tree = mdyToHast(source, {tasks: true, script: true})
    /** @type {any} */
    let form

    ;(function walk(node) {
      if (node.tagName === 'form') form ??= node
      for (const child of node.children ?? []) walk(child)
    })(tree)

    const fields = Object.fromEntries(
      form.children
        .filter((child) => child.properties?.type === 'hidden')
        .map((child) => [child.properties.name, child.properties.value])
    )

    expect(fields.line).toBe('3')
    expect(source.split('\n')[2][Number(fields.column) - 1]).toBe(fields.was)
  })

  test('a heading after code keeps its source line', () => {
    const tree = mdyToHast('% const x = 1\n% const y = 2\n= Title', {
      script: true
    })

    expect(tree.children[0].position.start.line).toBe(3)
  })

  test('lines from one loop all point at the line that wrote them', () => {
    const tree = mdyToHast('% for (const n of [1, 2, 3]) {\n= {{ n }}\n% }', {
      script: true
    })

    expect(tree.children.map((node) => node.position.start.line)).toEqual([
      2, 2, 2
    ])
  })

  test('a failed script still reports the surviving lines correctly', () => {
    const file = mdy({script: true}).processSync('% oops(\n\n= Title')

    expect(file.messages).toHaveLength(1)
    expect(mdyToHast('% oops(\n\n= Title', {script: true}).children[0].position.start.line).toBe(3)
  })
})
