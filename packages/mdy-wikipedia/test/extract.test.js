import assert from 'node:assert/strict'
import test from 'node:test'
import {fromHtml} from 'hast-util-from-html'
import {defaultResolve} from 'mdy-docs/parse/wiki.js'
import {
  extractImages,
  extractInfobox,
  extractReferences,
  outline,
  plainText
} from '../src/extract.js'
import {babylonHtml} from './fixture.js'

const tree = fromHtml(babylonHtml)
const infobox = extractInfobox(tree)

test('the infobox comes out as the record the plan describes', () => {
  assert.equal(infobox.type, 'Settlement')
  assert.equal(infobox.location, 'Hillah, Babil Governorate, Iraq')
  assert.equal(infobox['part-of'], 'Babylonia')
  assert.equal(infobox.history.built, 'c. 2200 BC')
  assert.equal(infobox.history.abandoned, 'c. 1000 AD')
  assert.equal(infobox['site-notes'].area, '9 km2 (3.5 sq mi)')
  assert.equal(infobox['site-notes'].condition, 'Ruined')
  assert.equal(infobox['unesco-world-heritage-site']['reference-no'], '278')
})

test('the headers nest, which is what keeps both regions', () => {
  // Babylon has a region (Mesopotamia) and a World Heritage listing with a
  // region (Arab States). Flat, one silently eats the other; grouped, both
  // survive and each says which region it means.
  assert.equal(infobox.region, 'Mesopotamia')
  assert.equal(infobox['unesco-world-heritage-site'].region, 'Arab States')
})

test('a label keeps the spaces inside it', () => {
  // `Part of` must not slug to `partof`, and `c. 2200 BC` must not lose the
  // space after the abbreviation: the text between two elements is text.
  assert.ok('part-of' in infobox)
  assert.ok('reference-no' in infobox['unesco-world-heritage-site'])
  assert.equal(infobox['unesco-world-heritage-site'].criteria, 'Cultural: (iii), (vi)')
})

test('values are the strings they read as, citations and all removed', () => {
  for (const [key, value] of Object.entries(infobox)) {
    if (key === 'image') continue

    for (const item of typeof value === 'object' ? Object.values(value) : [value]) {
      assert.ok(typeof item === 'string' || Array.isArray(item), key)
      assert.ok(!String(item).includes('['), key + ' still has a citation marker')
    }
  }

  // A number that is an identifier stays one: a World Heritage reference is
  // `278`, not two hundred and seventy-eight.
  assert.equal(typeof infobox['unesco-world-heritage-site']['reference-no'], 'string')
})

test('the infobox image comes with it', () => {
  assert.match(infobox.image.src, /^https:\/\/upload\.wikimedia\.org\/.*Ishtar_Gate/)
  assert.equal(infobox.image.caption, 'Ishtar Gate')
})

test('a page with no infobox says so rather than inventing one', () => {
  assert.equal(extractInfobox(fromHtml('<body><p>Nothing here</p></body>')), undefined)
})

test('every figure is listed, with its caption and its real size', () => {
  const images = extractImages(tree)

  assert.ok(images.length > 20, 'Babylon has 25 figures')

  const map = images.find((image) => /Map_of_Babylon/.test(image.file ?? ''))

  assert.equal(map.caption, 'A map of Babylon, with major areas and modern-day villages')
  assert.equal(map.width, 8271)
  assert.equal(map.height, 11698)

  for (const image of images) {
    assert.match(image.src, /^https:/, image.src)
    assert.ok(!image.src.includes('utm_'), image.src)
  }
})

test('the citations are keyed by the id the body points at', () => {
  const references = extractReferences(tree)

  assert.ok(references.size > 130, 'Babylon has 134 citations')

  const cam = references.get('cite_note-Cam-1')

  assert.equal(cam.number, '1')
  assert.match(cam.text, /Edwards/)
  assert.match(cam.text, /Cambridge University Press/)
  assert.ok(cam.children.length, 'the note keeps its tree, so it can keep its links')

  // A second group numbers itself its own way, and Wikipedia's numbering is
  // what a reader saw on the page they came from.
  assert.ok([...references.values()].some((reference) => /^[a-z]$/.test(reference.number)))
})

test('a citation carries its URL when it has one', () => {
  const withUrls = [...extractReferences(tree).values()].filter((entry) => entry.url)

  assert.ok(withUrls.length > 20)

  for (const entry of withUrls) assert.match(entry.url, /^https?:/)
})

test('the outline is of the document, with the ids mdy will give it', () => {
  const document = fromHtml(
    '<body><h1>Babylon</h1><h2>Names</h2><h3>Old Babylonian period</h3>' +
      '<h2>Notes</h2><h2>Notes</h2></body>'
  )

  assert.deepEqual(outline(document, defaultResolve), [
    {level: 1, id: 'babylon', title: 'Babylon'},
    {level: 2, id: 'names', title: 'Names'},
    {level: 3, id: 'old-babylonian-period', title: 'Old Babylonian period'},
    {level: 2, id: 'notes', title: 'Notes'},
    // Two headings reading the same thing are two places, and mdy numbers the
    // second — so the outline has to number it the same way.
    {level: 2, id: 'notes-1', title: 'Notes'}
  ])
})

test('plainText collapses once, at the end', () => {
  const node = fromHtml(
    '<body><td><abbr>c.</abbr> 2200 BC<sup typeof="mw:Extension/ref">[1]</sup></td></body>'
  )

  assert.equal(plainText(node), 'c. 2200 BC')
})

test('what a reader cannot see is not part of a value', () => {
  // Wikipedia puts a machine-readable date beside the written one and hides
  // it, so a birth reads `(1815-12-10)10 December 1815` if you take the text
  // at face value. And a `<br>` draws a break, not nothing: without a space in
  // its place the next line runs straight on.
  const cell = fromHtml(
    '<body><td><span style="display:none">(<span class="bday">1815-12-10</span>)</span>' +
      '10 December 1815<br>London, England' +
      '<span class="noprint">[hidden]</span></td></body>'
  )

  assert.equal(plainText(cell), '10 December 1815 London, England')
})

test('zero-width typesetting does not survive into the data', () => {
  const cell = fromHtml('<body><td>Lovelace \u200b \u200b(m. 1835)\u200b</td></body>')

  assert.equal(plainText(cell), 'Lovelace (m. 1835)')
})
