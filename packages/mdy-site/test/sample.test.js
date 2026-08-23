import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {mdy} from 'mdy-docs/parse'
import {scope} from '../src/scope.js'
import {describe, expect, test} from 'vitest'

// The document lives in index.html, the same place the page reads it from.
const page = readFileSync(
  fileURLToPath(new URL('../language.html', import.meta.url)),
  'utf8'
)
const source = /<script type="text\/mdy" id="sample">\r?\n([\s\S]*?)<\/script>/
  .exec(page)[1]
  .replace(/\s+$/, '')
// The same two the page hands it: a request to answer, and the values a host
// puts in scope.
const request = {pane: 'the preview pane', renders: 1}
const file = mdy({script: {scope, request}, tasks: true}).processSync(source)
const html = String(file)

/**
 * Every rule in the language should be visible on the demo page, not just
 * described on it. Each assertion below names something a reader can point at.
 *
 * @param {string} what
 * @param {string | Array<string>} expected
 */
function shows(what, expected) {
  test(what, () => {
    for (const value of Array.isArray(expected) ? expected : [expected]) {
      expect(html).toContain(value)
    }
  })
}

describe('the sample parses cleanly', () => {
  test('reports nothing on the file', () => {
    expect(file.messages.map(String)).toEqual([])
  })
})

describe('1. headings', () => {
  // Every heading carries an id of its own, which is what the contents list
  // at the top of the page links to.
  shows('every level', [
    '<h1 id=',
    '<h2 id=',
    '<h3 id=',
    '<h4 id=',
    '<h5 id=',
    '<h6 id='
  ])
  shows('trailing = dropped', '<h3 id="three">Three</h3>')
  shows(
    'a Setext h1',
    '<h1 id="or-underline-a-paragraph-instead-setext-style">Or underline a ' +
      'paragraph instead, Setext style</h1>'
  )
  test('no three-dash underline anywhere on the page', () => {
    // Exactly `---` is the document separator, so the page never spells an
    // underline that way and never shows one being spelled that way.
    expect(source.split('\n').filter((line) => line.trim() === '---').length)
      .toBe(1)
    expect(html).toContain('<hr>')
  })
})

describe('2. thematic breaks', () => {
  test('all four spellings', () => {
    expect(html.match(/<hr>/g).length).toBeGreaterThanOrEqual(4)
  })
})

describe('3. paragraphs', () => {
  shows('adjacent lines joined', '<p>Adjacent lines are joined into a single paragraph.</p>')
})

describe('4. code fences', () => {
  shows('a highlighted block', [
    '<pre><code class="language-js hljs">',
    '<span class="hljs-keyword">const</span> answer = ',
    '<span class="hljs-number">42</span>',
    '<span class="hljs-string">\'as expected\'</span>'
  ])
  shows('a tilde fence holding backticks', '<pre><code>```js')
  shows('an unknown language, plain but labelled', [
    '<pre><code class="language-nosuchlanguage">',
    'its code element still says language-nosuchlanguage'
  ])
})

describe('5. elements and indentation', () => {
  shows('a bare boolean attribute', '<details open>')
  shows('an unquoted attribute', '<section id="demo"')
  shows('a quoted attribute', 'class="callout"')
  shows('a style attribute', '<table style="border: 1px solid var(--accent)')
  shows('content after the >', '<summary>An element with a boolean attribute')
  shows('nesting by indentation', ['<tr>', '<th>Written</th>'])
  shows('a void element', '<section id="demo" class="callout">\n<hr>\n</section>')
  shows('an implied div', '<div>\n<p>This paragraph is indented')
  shows(
    'two levels of implied div',
    '</p>\n<div>\n<p>And this one is indented twice'
  )
})

describe('6. lists', () => {
  shows('all three bullets in one list', '<li>a dash</li>\n<li>a star</li>\n<li>a plus</li>')
  shows('a start offset', '<ol start="7">')
  shows('both ordered markers in one list', '<li>eight, because the rest are not</li>')
  shows('a continuation line', '<li>an item with a second line')
  shows('nesting', '<ul>\n<li>nested by two columns\n<ol>')
  shows('a loose list', '<li>\n<p>loose one</p>\n</li>')
  shows('tasks in a live form', [
    '<form method="post" class="task-list-item-form">',
    '<input type="hidden" name="column" value="4">',
    '<input type="hidden" name="was" value="x">'
  ])
  shows('the box is the submit button', [
    '<button type="submit" name="next" value=" " role="checkbox"',
    '<button type="submit" name="next" value="x" role="checkbox"',
    '<span aria-hidden="true">☑</span>',
    '<span aria-hidden="true">☐</span>'
  ])
  test('there is no separate save button', () => {
    expect(html).not.toContain('task-list-item-submit')
  })
  test('the form locates the item in this very file', () => {
    const line = /name="line" value="(\d+)"/.exec(html)[1]
    const column = /name="column" value="(\d+)"/.exec(html)[1]
    const source = page.split(/\r?\n/)

    // `page` is index.html itself, and the sample sits inside it, so the line
    // is offset by where the block starts.
    const offset = source.findIndex((value) =>
      value.includes('<script type="text/mdy"')
    )

    expect(source[offset + Number(line)][Number(column) - 1]).toBe('x')
  })
  shows('tasks, checked and not', [
    '<ul class="contains-task-list">',
    'aria-checked="true" aria-label="headings, breaks, paragraphs"',
    'aria-checked="false" aria-label="whatever you add next"'
  ])
})

describe('7. tables', () => {
  shows('a caption, from the line above the table', [
    '<caption>What each marker gives.</caption>'
  ])
  shows('every alignment', [
    'text-align: left',
    'text-align: center',
    'text-align: right'
  ])
  shows('an escaped pipe', '<td style="text-align: left"><code>|</code></td>')
  shows('a table without framing pipes', '<th>Left</th>')
  shows('a padded short row', '<td>only one cell</td>\n<td></td>')
  shows('a trimmed long row', '<td>one</td>\n<td>two</td>')
  test('drops the cell past the last column', () => {
    expect(html).not.toContain('three is dropped')
  })
})

describe('8. inline markers', () => {
  shows('every marker', [
    '<strong>strong</strong>',
    '<strong>also strong</strong>',
    '<em>emphasis</em>',
    '<u>underline</u>',
    '<del>deleted</del>',
    '<mark>highlight</mark>',
    '<sup>2</sup>',
    '<sub>2</sub>',
    '<code>code</code>'
  ])
  shows('auto-closing an inner marker', '<strong>bold <em>and italic</em></strong>')
  shows('closing at the end of a paragraph', '<del>never leaks</del>')
  shows('an escaped marker', '!!literal!!')
  shows('a raw span', '<code>a ~~raw~~ span</code>')
})

describe('9. links', () => {
  shows('a bare URL', '<a href="https://github.com/syntax-tree/hast">')
  shows('an email', '<a href="mailto:hello@example.com">')
  shows('a protocol-relative URL', '<a href="//unpkg.com/mdy">')
  shows('a wiki link with a URL', '>the hast spec</a>')
  shows('a wiki link that slugifies', '<a href="getting-started">Getting Started</a>')
  shows('an anchor to a heading on the page', [
    '<a href="#headings">the first rule</a>',
    '<a href="#script">#Script</a>',
    '<a href="#mdy">back to the top</a>'
  ])
  test('every anchor on the page lands on something', () => {
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])

    expect(anchors.filter((at) => !ids.has(at))).toEqual([])
  })
  shows('a tag', '<a href="/tags/syntax-trees">#syntax-trees</a>')
  shows('a mention', '<a href="/users/wooorm">@wooorm</a>')
  test('every tag and mention is written down on res.data', () => {
    const {tags, users} = file.data.response.data

    expect(tags).toContain('syntax-trees')
    expect(users).toContain('wooorm')
  })
  test('a link to another page is tidied and written down', () => {
    const {links} = file.data.response.data

    // `[[ Getting Started ]]` on the page, which is a page of its own rather
    // than a URL or a fragment.
    expect(links).toContain('getting-started')
    expect(html).toContain('<a href="getting-started">Getting Started</a>')

    // Nothing that leaves the site and nothing that stays on this page.
    for (const link of links) {
      expect(link.startsWith('#')).toBe(false)
      expect(/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(link)).toBe(false)
      expect(link).toBe(link.toLowerCase())
    }
  })
  test('leaves a mid-word # and an email address alone', () => {
    expect(html).toContain('so a#b is left alone')
    expect(html).toContain('<a href="mailto:hello@example.com">')
  })
  shows('a footnote reference', 'data-footnote-ref')
  shows('the footnote section', [
    '<section data-footnotes class="footnotes">',
    '<h2 class="sr-only" id="footnote-label">Footnotes</h2>'
  ])
  shows('a backref', 'data-footnote-backref')
  shows('one note referenced twice', ['↩<sup>1</sup>', '↩<sup>2</sup>'])
})

describe('11. front matter', () => {
  shows('a heading read from the front matter', '<h1 id="mdy">MDY</h1>')
  shows('a value interpolated from it', 'it reads MDY')
  shows('the tagline', 'described there as markup that compiles to hast')
  test('the block itself is not rendered', () => {
    // `+++` does appear, but only where rule 10 shows the syntax in a code span.
    expect(html).not.toContain('title: MDY')
    expect(html).not.toContain('tagline: markup that')
    expect(html).not.toContain('fences: yaml')
    expect(html.startsWith('<h1 id="mdy">MDY</h1>')).toBe(true)
  })
  test('the data reaches the tree and the file', () => {
    expect(file.data.matter).toMatchObject({
      title: 'MDY',
      tagline: 'markup that compiles to hast',
      fences: 'yaml'
    })
  })

  test('the tags and users it refers to are written down beside them', () => {
    const {tags, users} = file.data.matter

    // The page writes these in its links rule, and never in the block at the
    // top: they are collected from the text as it is read.
    expect(tags).toContain('syntax-trees')
    expect(users).toContain('wooorm')

    // The block at the top names neither list. The prose below mentions them,
    // which is why this looks at the block rather than the whole file.
    const block = /^\+\+\+\n([\s\S]*?)\n\+\+\+/.exec(source)[1]

    expect(block).not.toContain('tags:')
    expect(block).not.toContain('users:')

    // Every one of them is a link in the output, and each is listed once.
    for (const tag of tags) {
      expect(html).toContain('>#' + tag + '</a>')
    }

    expect(new Set(tags).size).toBe(tags.length)
    expect(new Set(users).size).toBe(users.length)
  })
})

describe('12. script', () => {
  shows('a loop over the lines it encloses', [
    '<li>item 1</li>',
    '<li>item 2</li>',
    '<li>item 3</li>'
  ])
  shows(
    'the rule count in the intro',
    'the grammar is ' + scope.rules.length + ' rules long'
  )
  shows('interpolation with no code line', [
    'This page has ' + scope.rules.length + ' rules',
    scope.markers.length + ' inline markers',
    '42 is still the answer'
  ])
  shows('an escaped interpolation', '<code>{{ }}</code>')
  shows('table rows generated from host values', [
    '<td style="text-align: right">10</td>',
    '<td style="text-align: left">Documents and front matter</td>',
    '<td style="text-align: right">13</td>',
    '<td style="text-align: left">Comments</td>'
  ])
  shows('the taken branch of a conditional', 'This line was printed because')
  test('drops the branch not taken', () => {
    expect(html).not.toContain('only appears when the count changes')
  })
  shows('the request it was called with', [
    'the preview pane, redrawn 1 times since you loaded it'
  ])
  shows('the front matter, read off res.data', 'it reads MDY')
  test('res.doc reaches the transform, and res comes back on the file', () => {
    // The count is written into the tree by the transform rather than
    // interpolated, because at interpolation time there is no tree to count.
    const blocks = file.data.response.blocks

    expect(typeof blocks).toBe('number')
    expect(blocks).toBeGreaterThan(50)
    expect(html).toContain(
      '<p id="blocks"><em>This document holds ' + blocks + ' blocks.</em></p>'
    )
  })
  test('res.data is the block at the top of the file', () => {
    expect(file.data.response.data).toEqual(file.data.matter)
  })
  shows('a table of contents built from the tree', [
    '<nav id="toc"><ol>',
    '<a href="#headings">Headings</a>',
    '<a href="#documents-and-front-matter">Documents and front matter</a>',
    '<a href="#script">Script</a>',
    '<h2 id="headings">Headings</h2>'
  ])
  test('it holds every rule, in order and only once', () => {
    // An `ol`, because the headings carry no numbers of their own: the list
    // is where "rule 5" in the prose becomes something to count to.
    const nav = /<nav id="toc">([\s\S]*?)<\/nav>/.exec(html)[1]
    const items = [...nav.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1])

    expect(nav.startsWith('<ol>')).toBe(true)
    expect(items.length).toBe(scope.rules.length)
    expect(new Set(items).size).toBe(items.length)

    // In the order they appear, which is what makes the numbering mean
    // anything at all.
    const order = items.map((id) => html.indexOf('<h2 id="' + id + '"'))

    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.includes(-1)).toBe(false)
  })
  test('its numbering is the one the prose counts on', () => {
    // The page says "rule 5" and "rule 12" in a dozen places, and the
    // headings carry no numbers of their own, so the nth entry of the list
    // has to be the nth rule — the same order the host's own table has.
    const nav = /<nav id="toc">([\s\S]*?)<\/nav>/.exec(html)[1]
    const names = [...nav.matchAll(/<a href="#[^"]+">([^<]+)<\/a>/g)].map(
      (match) => match[1]
    )

    expect(names).toEqual(scope.rules.map((rule) => rule.name))
  })
  test('it holds the sections and nothing else', () => {
    const nav = /<nav id="toc">([\s\S]*?)<\/nav>/.exec(html)[1]

    // A heading written as an example lives inside something, and the
    // footnotes give themselves one too. Neither is a section.
    expect(html).toContain('<h2 id="underlined-with-dashes">')
    expect(nav).not.toContain('underlined-with-dashes')
    expect(html).toContain('<h2 class="sr-only" id="footnote-label">')
    expect(nav).not.toContain('footnote-label')
  })
  shows('generated elements', [
    '<span class="chip">!! makes strong</span>',
    '<span class="chip">** makes strong</span>',
    '<span class="chip">// makes em</span>'
  ])
})

describe('10. emoji', () => {
  shows('an emoticon', '😃')
  shows('a shortcode', '🚀')
  shows('a non-face emoticon', '❤️')
  shows('an escaped emoticon', ':) escapes opt out')
  test('leaves a path alone', () => {
    expect(html).toContain('a:/b')
  })
})
