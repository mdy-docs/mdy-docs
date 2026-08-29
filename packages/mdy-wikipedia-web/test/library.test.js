import assert from 'node:assert/strict'
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {createLibrary} from '../src/server.js'

/** A wiki of two pages that counts what it was asked for. */
function wiki() {
  const calls = []
  const page = (title, links) =>
    '<body><section data-mw-section-id="0"><p>About ' + title + '. ' +
    links
      .map((name) => '<a rel="mw:WikiLink" href="./' + name.replaceAll(' ', '_') + '">' + name + '</a>')
      .join(' ') +
    '</p></section></body>'
  const pages = {
    Babylon: page('Babylon', ['Hillah']),
    Hillah: page('Hillah', [])
  }

  return {
    calls,
    fetch(url) {
      calls.push(url)

      const title = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)).replaceAll('_', ' ')
      const body = url.includes('/page/html/')
        ? pages[title]
        : url.includes('/page/summary/')
          ? JSON.stringify({titles: {normalized: title}, pageid: 1})
          : undefined

      return Promise.resolve({
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        statusText: 'OK',
        headers: {get: () => null},
        text: () => Promise.resolve(body)
      })
    }
  }
}

const convert = (fetch) => ({fetch, cache: false, delay: 0, images: false, refs: 'drop'})

test('a page is fetched once and remembered', async () => {
  const {fetch, calls} = wiki()
  const library = createLibrary({convert: convert(fetch)})

  const first = await library.load('Babylon')
  const second = await library.load('Babylon')

  assert.equal(first.from, 'wikipedia')
  assert.equal(second.from, 'memory')
  assert.equal(second.source, first.source)
  assert.equal(calls.length, 2, 'the html and the summary, once each')
})

test('--refresh goes back to Wikipedia', async () => {
  const {fetch, calls} = wiki()
  const library = createLibrary({convert: convert(fetch)})

  await library.load('Babylon')
  const again = await library.load('Babylon', {refresh: true})

  assert.equal(again.from, 'wikipedia')
  assert.equal(calls.length, 4)
})

test('links are written as URLs, which is what a click can act on', async () => {
  // A `[[ hillah ]]` link has lost the title it came from, and `/wiki/hillah`
  // has been lower cased by mdy's own link rule. Only the full URL still says
  // which article a link points at, so the reader forces that mode.
  const {fetch} = wiki()
  const library = createLibrary({convert: {...convert(fetch), links: 'wiki'}})
  const page = await library.load('Babylon')

  assert.match(page.source, /https:\/\/en\.wikipedia\.org\/wiki\/Hillah/)
})

test('a vault is read before Wikipedia is asked', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'mdy-wikipedia-web-'))
  const {fetch, calls} = wiki()

  await mkdir(join(vault, 'en'), {recursive: true})
  await writeFile(join(vault, 'en', 'babylon.mdy'), '+++\ntitle: Babylon\n+++\n= Kept\n')

  const library = createLibrary({vault, convert: convert(fetch)})
  const page = await library.load('Babylon')

  assert.equal(page.from, 'vault')
  assert.match(page.source, /= Kept/)
  assert.equal(calls.length, 0, 'nothing should have been fetched')
})

test('a vault is written to, so the next session starts with it', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'mdy-wikipedia-web-'))
  const {fetch} = wiki()
  const library = createLibrary({vault, convert: convert(fetch)})

  await library.load('Babylon')

  const written = await readFile(join(vault, 'en', 'babylon.mdy'), 'utf8')

  assert.match(written, /^\+\+\+/)
  assert.match(written, /About Babylon/)
})

test('the shelf holds what the vault had and what this session has read', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'mdy-wikipedia-web-'))
  const {fetch} = wiki()

  await mkdir(join(vault, 'en'), {recursive: true})
  await writeFile(join(vault, 'en', 'assur.mdy'), '= Assur\n')

  const library = createLibrary({vault, convert: convert(fetch)})

  assert.deepEqual(
    (await library.list()).map((page) => page.title),
    ['Assur']
  )

  await library.load('Hillah')

  assert.deepEqual(
    (await library.list()).map((page) => page.title),
    ['Assur', 'Hillah']
  )
})

test('a page that will not fetch reports rather than caching a failure', async () => {
  const {fetch} = wiki()
  const library = createLibrary({convert: convert(fetch)})

  await assert.rejects(library.load('Nowhere'), /Could not fetch/)
  assert.deepEqual(await library.list(), [])
})
