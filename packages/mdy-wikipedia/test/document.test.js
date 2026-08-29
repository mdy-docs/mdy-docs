import assert from 'node:assert/strict'
import test from 'node:test'
import {renderDocumentSet} from 'mdy-docs'
import {fromMdy} from 'mdy-docs/parse'
import {toText} from 'mdy-docs/parse/script.js'
import {buildDocument} from '../src/index.js'
import {babylonHtml, babylonSummary, babylonTarget} from './fixture.js'

const page = {html: babylonHtml, summary: babylonSummary, target: babylonTarget}
const now = new Date('2026-08-29T00:00:00Z')
const built = buildDocument(page, {now})

/** Parse a document the way anything consuming it would, and keep the file. */
function parse(source) {
  const messages = []
  const file = {message: (reason) => (messages.push(String(reason)), {})}

  return {tree: fromMdy(source, {file}), messages}
}

function elements(node, out = []) {
  if (node.type === 'element') out.push(node)

  for (const child of node.children ?? []) elements(child, out)

  return out
}

test('the document parses, with nothing to say about it', () => {
  // The test that matters. The output of this tool is only useful if it is a
  // valid mdy document, and the only honest way to know is to feed it back.
  const {messages} = parse(built.source)

  assert.deepEqual(messages, [])
})

test('the front matter reaches res.data', () => {
  const {tree} = parse(built.source)
  const {matter} = tree.data

  assert.equal(matter.title, 'Babylon')
  assert.equal(matter.description, 'Ancient Mesopotamian city in Iraq')
  assert.equal(matter.source.site, 'Wikipedia')
  assert.equal(matter.source.lang, 'en')
  assert.equal(matter.source.url, 'https://en.wikipedia.org/wiki/Babylon')
  assert.equal(matter.source['page-id'], 20609622)
})

test('the attribution is written whatever the options say', () => {
  // Wikipedia is CC BY-SA 4.0, so this is a requirement and not a setting.
  for (const options of [{now}, {now, title: false}, {now, links: 'wiki'}]) {
    const {source} = buildDocument(page, options)
    const {matter} = parse(source).tree.data

    assert.equal(matter.source.license, 'CC BY-SA 4.0')
    assert.equal(
      matter.source['license-url'],
      'https://creativecommons.org/licenses/by-sa/4.0/'
    )
    assert.match(matter.source.attribution, /Wikipedia article "Babylon"/)
    assert.match(matter.source.attribution, /CC BY-SA 4\.0\.$/)
  }
})

test('the revision is pinned, which is what makes the citation checkable', () => {
  const {matter} = parse(built.source).tree.data

  assert.equal(String(matter.source.revision), String(babylonSummary.revision))
  assert.match(matter.source.attribution, new RegExp('revision ' + babylonSummary.revision))
  assert.equal(matter.source.retrieved, '2026-08-29')
  assert.equal(matter.source.modified, babylonSummary.timestamp)
})

test('the body is the article', () => {
  const {tree} = parse(built.source)
  const text = toText(tree).replace(/\s+/g, ' ')

  // `toText` runs blocks together, so the `<h1>` sits against the lead.
  assert.match(text, /^BabylonBabylon \(.*\) was an ancient city located on the lower Euphrates/)
  assert.match(text, /gate of the god/)
  assert.match(text, /UNESCO recognized Babylon as a World Heritage Site in 2019/)
  assert.ok(text.length > 40000, 'the article is about 42,000 characters of prose')
})

test('the headings come out as headings, with ids of mdy own making', () => {
  const {tree} = parse(built.source)
  const headings = elements(tree)
    .filter((element) => /^h[1-6]$/.test(element.tagName))
    .map((element) => [element.tagName, element.properties.id])

  assert.deepEqual(headings[0], ['h1', 'babylon'])
  assert.ok(headings.some(([tag, id]) => tag === 'h2' && id === 'names'))
  assert.ok(headings.some(([tag, id]) => tag === 'h3' && id === 'excavations'))
  assert.ok(headings.length > 15)
})

test('the markup survives the trip', () => {
  const {tree} = parse(built.source)
  const names = new Map()

  for (const element of elements(tree)) {
    names.set(element.tagName, (names.get(element.tagName) ?? 0) + 1)
  }

  assert.ok(names.get('a') > 300, 'Babylon links out a great deal')
  assert.ok(names.get('p') > 60)
  assert.ok(names.get('em') > 20, 'transliterations are italic')
  assert.ok(names.get('figure') > 20)
  assert.equal(names.get('figcaption'), names.get('figure'))
  assert.ok(names.get('img') > 20)
})

test('--no-title leaves the heading out and the field in', () => {
  const {source} = buildDocument(page, {now, title: false})
  const {tree} = parse(source)

  assert.equal(tree.data.matter.title, 'Babylon')
  assert.equal(
    elements(tree).filter((element) => element.tagName === 'h1').length,
    0
  )
})

test('--links wiki writes links into a vault of your own', () => {
  const {source} = buildDocument(page, {now, links: 'wiki'})
  const {tree} = parse(source)
  const hrefs = elements(tree)
    .filter((element) => element.tagName === 'a')
    .map((element) => element.properties.href)

  assert.ok(hrefs.includes('third-dynasty-of-ur'))

  // mdy writes down every link to a page of your own as it parses, which is
  // what makes a directory of imports a vault rather than a pile of files.
  assert.ok(tree.data.matter.links.includes('third-dynasty-of-ur'))
})

test('a page with no summary still builds, and still says where it came from', () => {
  const {source} = buildDocument({...page, summary: undefined}, {now})
  const {tree, messages} = parse(source)

  assert.deepEqual(messages, [])
  assert.equal(tree.data.matter.title, 'Babylon')
  assert.equal(tree.data.matter.source.url, 'https://en.wikipedia.org/wiki/Babylon')
  assert.equal(tree.data.matter.source.revision, undefined)
  assert.match(tree.data.matter.source.attribution, /by Wikipedia contributors/)
})

test('no prose is lost between the cleaned page and the document', () => {
  const {tree} = parse(built.source)
  const words = (value) => value.replace(/\s+/g, ' ').trim().split(' ').length

  // Not a character comparison: the serialiser is allowed to move whitespace
  // about. It is not allowed to lose sentences.
  assert.ok(words(toText(tree)) > 6000, 'Babylon runs to about 6,500 words')
})

test('the extracted data is in the front matter', () => {
  const {matter} = parse(built.source).tree.data

  assert.equal(matter.infobox.history.built, 'c. 2200 BC')
  assert.equal(matter.infobox.location, 'Hillah, Babil Governorate, Iraq')
  assert.deepEqual(matter.coordinates, {lat: 32.5425, lon: 44.42111111})
  assert.ok(matter.images.length > 20)
  assert.deepEqual(matter.sections[0], {level: 2, id: 'names', title: 'Names'})
})

test('the outline names anchors that are in the document', () => {
  const {tree} = parse(built.source)
  const ids = new Set(
    elements(tree)
      .filter((element) => /^h[1-6]$/.test(element.tagName))
      .map((element) => element.properties.id)
  )

  for (const section of tree.data.matter.sections) {
    assert.ok(ids.has(section.id), section.id + ' should be a heading in the document')
  }
})

test('the citations become footnotes the body points at', () => {
  const {tree} = parse(built.source)
  const notes = elements(tree).find(
    (element) => element.tagName === 'section' && element.properties.dataFootnotes
  )

  assert.ok(notes, 'mdy should have built a footnotes section')

  const items = elements(notes).filter((element) => element.tagName === 'li')

  assert.ok(items.length > 120, 'Babylon cites 134 sources')

  // The note keeps the citation tree, so a citation that linked somewhere
  // still does.
  assert.ok(
    elements(notes).some(
      (element) => element.tagName === 'a' && /^https?:/.test(String(element.properties.href))
    )
  )
})

test('only the citations the body reaches become notes', () => {
  const {tree} = parse(built.source)
  const references = elements(tree).filter(
    (element) => element.tagName === 'a' && element.properties.dataFootnoteRef !== undefined
  )
  const notes = new Set(
    elements(tree)
      .filter((element) => element.tagName === 'li' && String(element.properties.id ?? '').startsWith('user-content-fn-'))
      .map((element) => '#' + element.properties.id)
  )

  assert.ok(references.length > 100)

  // A note nothing points at would be a dangling paragraph, and a reference
  // pointing at no note would be a dangling number.
  for (const reference of references) {
    assert.ok(notes.has(String(reference.properties.href)), String(reference.properties.href))
  }
})

test('--refs data puts them in the front matter instead', () => {
  const {source} = buildDocument(page, {now, refs: 'data'})
  const {tree, messages} = parse(source)

  assert.deepEqual(messages, [])
  assert.ok(tree.data.matter.references.length > 130)
  assert.match(tree.data.matter.references[0].text, /\S/)
  assert.equal(
    elements(tree).filter(
      (element) => element.tagName === 'section' && element.properties.dataFootnotes
    ).length,
    0
  )
})

test('--refs drop takes them out altogether', () => {
  const {source} = buildDocument(page, {now, refs: 'drop'})
  const {tree} = parse(source)

  assert.equal(tree.data.matter.references, undefined)
  assert.ok(!source.includes('[[ ^'))
})

test('the parts of the record can be turned off', () => {
  const {source} = buildDocument(page, {now, infobox: false, images: false})
  const {matter} = parse(source).tree.data

  assert.equal(matter.infobox, undefined)
  assert.equal(matter.images, undefined)
  assert.ok(matter.sections.length > 0, 'the outline is of the document, not of the page')
})

test('the document compiles as a template and the data resolves', async () => {
  // The exit criterion for extraction. Front matter that cannot be read from a
  // template is a file with a header, not a document with data.
  const facts = [
    '== Facts',
    '',
    '- Founded {{ res.data.infobox.history.built }} at {{ res.data.infobox.location }}',
    '- {{ res.data.coordinates.lat }}, {{ res.data.coordinates.lon }}',
    "- {{ res.data.sections.length }} sections; part of {{ res.data.infobox['part-of'] }}",
    ''
  ].join('\n')
  const html = await renderDocumentSet(built.source.trimEnd() + '\n\n' + facts)

  assert.match(html, /Founded c\. 2200 BC at Hillah, Babil Governorate, Iraq/)
  assert.match(html, /32\.5425, 44\.42111111/)
  assert.match(html, /19 sections; part of Babylonia/)
})

test('a page that says `{{cite web}}` still compiles', async () => {
  // The script stage reads `{{ … }}` before a line of markup is parsed, so
  // nothing is raw to it — not a code span, not a fence. One of Babylon's
  // citations carries the literal text `{{cite web}}`, which is enough to stop
  // the whole document compiling if it goes in unescaped.
  assert.ok(built.source.includes('\\{{cite web}}'))

  const html = await renderDocumentSet(built.source)

  assert.match(html, /\{\{cite web\}\}/)
})
