import assert from 'node:assert/strict'
import test from 'node:test'
import {fromHtml} from 'hast-util-from-html'
import {toText} from 'mdy-docs/parse/script.js'
import {clean} from '../src/clean.js'
import {babylonHtml, babylonTarget} from './fixture.js'

const tree = fromHtml(babylonHtml)

/** Clean the fixture with `options`, memoised per spelling of them. */
const cache = new Map()

function cleaned(options = {}) {
  const key = JSON.stringify(options)

  if (!cache.has(key)) cache.set(key, clean(tree, {...babylonTarget, ...options}))

  return cache.get(key)
}

/** Every element in a tree, flat. */
function elements(node, out = []) {
  if (node.type === 'element') out.push(node)

  for (const child of node.children ?? []) elements(child, out)

  return out
}

function tagNames(node) {
  return new Set(elements(node).map((element) => element.tagName))
}

test('the chrome is gone', () => {
  const {tree: out} = cleaned()
  const names = tagNames(out)

  for (const name of ['style', 'link', 'meta', 'section', 'span']) {
    assert.ok(!names.has(name), '`<' + name + '>` should be gone, ' + name)
  }
})

test('the citation superscripts are gone and the real ones are not', () => {
  const {tree: out, counts} = cleaned()

  assert.ok(counts.citations > 150, 'Babylon has 172 citations')
  // `KÁ.DIG̃IR.RA^KI^` and its friends are content, not references.
  assert.ok(elements(out).some((element) => element.tagName === 'sup'))
  assert.ok(!toText(out).includes('[1]'))
})

test('the parts that are data, not prose, are gone', () => {
  const {tree: out, counts} = cleaned()

  assert.equal(counts.infobox, 1)
  assert.ok(counts.hatnotes > 0)
  assert.ok(counts.banners > 0)
  assert.ok(!toText(out).includes('World Heritage Site'.repeat(2)))
})

test('the empty paragraphs Parsoid leaves behind are gone', () => {
  // Babylon's first `<p>` holds no prose at all: a protection-template
  // `<meta>` and a category `<link>`.
  const {tree: out, counts} = cleaned()

  assert.ok(counts.empty > 0)

  const first = elements(out).find((element) => element.tagName === 'p')

  assert.match(toText(first), /^Babylon/)
})

test('end matter goes, with its subsections', () => {
  const {tree: out, counts} = cleaned()
  const headings = elements(out)
    .filter((element) => /^h[1-6]$/.test(element.tagName))
    .map((element) => toText(element).trim())

  assert.ok(headings.includes('Names'))
  assert.ok(headings.includes('Cultural importance'))

  for (const gone of ['See also', 'Notes', 'References', 'Further reading', 'External links']) {
    assert.ok(!headings.includes(gone), gone + ' should be gone')
  }

  // `Sources` sits under `References` and goes with it, which is why the count
  // is of sections and not of headings.
  assert.ok(counts['end-matter'] >= 5)
})

test('--keep-sections keeps them', () => {
  const {tree: out} = cleaned({keepSections: true})
  const headings = elements(out)
    .filter((element) => /^h[1-6]$/.test(element.tagName))
    .map((element) => toText(element).trim())

  assert.ok(headings.includes('See also'))
  assert.ok(headings.includes('External links'))
})

test('--sections takes only what it names', () => {
  const {tree: out} = cleaned({sections: ['Names']})
  const headings = elements(out)
    .filter((element) => /^h[1-6]$/.test(element.tagName))
    .map((element) => toText(element).trim())

  assert.deepEqual(headings, ['Names'])
  assert.match(toText(out), /The spelling Babylon is the Latin representation/)
})

test('headings keep no id, because the document is about to name its own', () => {
  for (const heading of elements(cleaned().tree)) {
    if (!/^h[1-6]$/.test(heading.tagName)) continue

    assert.equal(heading.properties.id, undefined, toText(heading))
  }
})

test('presentational markup becomes the markup mdy has', () => {
  const names = tagNames(cleaned().tree)

  // `<i>` and `<b>` say how a thing looked; `//` and `!!` produce `<em>` and
  // `<strong>`, so that is what they become.
  assert.ok(!names.has('i'))
  assert.ok(!names.has('b'))
  assert.ok(names.has('em'))
  assert.ok(names.has('strong'))

  for (const element of elements(cleaned().tree)) {
    if (element.tagName !== 'em' && element.tagName !== 'strong') continue

    assert.deepEqual(element.properties, {}, 'a marker carries no attributes')
  }
})

test('links are written the way the mode asks', () => {
  const of = (options) =>
    elements(cleaned(options).tree)
      .filter((element) => element.tagName === 'a')
      .map((element) => element.properties.href)

  assert.ok(of().includes('https://en.wikipedia.org/wiki/Third_Dynasty_of_Ur'))
  assert.ok(of({links: 'path'}).includes('/wiki/Third_Dynasty_of_Ur'))
  assert.ok(of({links: 'wiki'}).includes('third-dynasty-of-ur'))

  // Somebody else's URL is theirs, in every mode.
  for (const options of [{}, {links: 'path'}, {links: 'wiki'}]) {
    assert.ok(
      of(options).includes('https://en.wiktionary.org/wiki/Βαβυλών'),
      JSON.stringify(options)
    )
  }
})

test('a link into this same page becomes a fragment mdy will have named', () => {
  // Babylon's own self-links are all citation back-references, and those go
  // with the citations, so this is asked of the rule rather than of the page.
  const page = fromHtml(
    '<body><section><p>' +
      '<a rel="mw:WikiLink" href="./Babylon#Ishtar_Gate">the gate</a>' +
      '<a rel="mw:WikiLink" href="./Nineveh#History">Nineveh</a>' +
      '</p></section></body>'
  )
  const hrefs = elements(clean(page, {lang: 'en', title: 'Babylon'}).tree)
    .filter((element) => element.tagName === 'a')
    .map((element) => element.properties.href)

  // Slugified the way mdy slugifies a heading, because mdy is about to name
  // that anchor and this link has to use the name it gives it.
  assert.deepEqual(hrefs, [
    '#ishtar-gate',
    'https://en.wikipedia.org/wiki/Nineveh#History'
  ])
})

test('image sources get a scheme and lose the analytics', () => {
  for (const image of elements(cleaned().tree)) {
    if (image.tagName !== 'img') continue

    assert.match(image.properties.src, /^https:/, image.properties.src)
    assert.ok(!image.properties.src.includes('utm_'), image.properties.src)
  }
})

test('the figures survive, with their captions', () => {
  const figures = elements(cleaned().tree).filter((element) => element.tagName === 'figure')

  assert.ok(figures.length > 20, 'Babylon has 23 figures once the infobox has gone')

  const captions = elements(cleaned().tree).filter(
    (element) => element.tagName === 'figcaption'
  )

  assert.equal(captions.length, figures.length)
  assert.ok(
    captions.some((caption) => /A map of Babylon/.test(toText(caption)))
  )
})

test('what was taken out is counted, so the cleaner can be judged', () => {
  const {counts} = cleaned()

  for (const name of ['chrome', 'citations', 'empty', 'infobox', 'sections', 'plain']) {
    assert.ok(counts[name] > 0, name + ' should have been counted')
  }
})
