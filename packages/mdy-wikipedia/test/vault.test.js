import assert from 'node:assert/strict'
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import test from 'node:test'
import {openDocumentSet} from 'mdy-docs'
import {fromMdy} from 'mdy-docs/parse'
import {documentPath, importVault} from '../src/vault.js'
import {babylonHtml, babylonSummary} from './fixture.js'

/**
 * A wiki of three small pages, answered from memory. Enough shape for the
 * cleaner to have something to do and for the pages to link to each other.
 */
function wiki(pages) {
  const calls = []

  return {
    calls,
    fetch(url) {
      calls.push(url)

      const title = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)).replace(
        /\.json$/,
        ''
      )
      const page = pages[title.replaceAll('_', ' ')]

      if (url.includes('/page/html/')) {
        return answer(page?.html)
      }

      if (url.includes('/page/summary/')) {
        return answer(page && JSON.stringify({titles: {normalized: title}, pageid: 1}))
      }

      return answer(undefined)
    }
  }
}

function answer(body) {
  return Promise.resolve({
    ok: body !== undefined,
    status: body === undefined ? 404 : 200,
    statusText: body === undefined ? 'Not Found' : 'OK',
    headers: {get: () => null},
    text: () => Promise.resolve(body)
  })
}

const link = (title) =>
  '<a rel="mw:WikiLink" href="./' + title.replaceAll(' ', '_') + '">' + title + '</a>'

const pages = {
  Babylon: {
    html:
      '<body><section data-mw-section-id="0"><p>A city near ' +
      link('Hillah') + ' in ' + link('Iraq') + '.</p></section></body>'
  },
  Hillah: {
    html:
      '<body><section data-mw-section-id="0"><p>A town in ' +
      link('Iraq') + '.</p></section></body>'
  },
  Iraq: {
    html: '<body><section data-mw-section-id="0"><p>A country.</p></section></body>'
  }
}

async function collect(seeds, options) {
  const out = []

  for await (const page of importVault(seeds, options)) out.push(page)

  return out
}

test('a document is named the way a wiki link points at it', () => {
  // Not a detail: with `--links wiki` a document links to `[[ babylonia ]]`,
  // and this is what makes that land on `babylonia.mdy` beside it.
  assert.equal(documentPath({lang: 'en', title: 'Babylon'}), 'babylon.mdy')
  assert.equal(documentPath({lang: 'en', title: 'Third Dynasty of Ur'}), 'third-dynasty-of-ur.mdy')
  assert.equal(documentPath({lang: 'en', title: 'Kish (Sumer)'}), 'kish-sumer.mdy')
  assert.equal(documentPath({lang: 'en', title: 'Mari, Syria'}), 'mari-syria.mdy')
})

test('several seeds become several documents', async () => {
  const {fetch} = wiki(pages)
  const out = await collect(['Babylon', 'Iraq'], {fetch, cache: false, delay: 0})

  assert.deepEqual(out.map((page) => page.path), ['babylon.mdy', 'iraq.mdy'])
  assert.match(out[0].source, /A city near/)
})

test('a page asked for twice is imported once', async () => {
  const {fetch} = wiki(pages)
  const out = await collect(['Babylon', 'Babylon', 'en:Babylon'], {
    fetch,
    cache: false,
    delay: 0
  })

  assert.equal(out.length, 1)
})

test('following imports what the documents link to', async () => {
  const {fetch} = wiki(pages)
  const out = await collect(['Babylon'], {fetch, cache: false, delay: 0, follow: 1})

  // Babylon links to Hillah and Iraq; Hillah links to Iraq, which is already
  // in hand.
  assert.deepEqual(out.map((page) => page.path), ['babylon.mdy', 'hillah.mdy', 'iraq.mdy'])
})

test('depth is a depth, not a licence', async () => {
  const {fetch} = wiki(pages)
  const out = await collect(['Babylon'], {fetch, cache: false, delay: 0, follow: 0})

  assert.deepEqual(out.map((page) => page.path), ['babylon.mdy'])
})

test('the cap is hard, and says what it stopped', async () => {
  const events = []
  const {fetch} = wiki(pages)
  const out = await collect(['Babylon'], {
    fetch,
    cache: false,
    delay: 0,
    follow: 2,
    max: 2,
    onProgress: (event) => events.push(event)
  })

  assert.equal(out.length, 2)
  assert.deepEqual(events, [{kind: 'capped', reached: 2, left: 1}])
})

test('a page that will not fetch is reported and the rest carry on', async () => {
  const {fetch} = wiki(pages)
  const out = await collect(['Babylon', 'Nowhere', 'Iraq'], {fetch, cache: false, delay: 0})

  assert.equal(out.length, 3)
  assert.equal(out[1].error.message.includes('Could not fetch'), true)
  assert.equal(out[0].error, undefined)
  assert.equal(out[2].error, undefined)
})

test('nothing to import is an error rather than an empty directory', async () => {
  const {fetch} = wiki(pages)

  await assert.rejects(collect([], {fetch, cache: false}), /Nothing to import/)
})

test('a vault answers a query across every document in it', async () => {
  // The reason the tool exists. One imported article is a converted article;
  // a directory of them is a set whose infobox fields are queryable together.
  const dir = await mkdtemp(join(tmpdir(), 'mdy-wikipedia-vault-'))
  const summary = {...babylonSummary}
  const {fetch} = {
    fetch: (url) =>
      answer(
        url.includes('/page/html/')
          ? babylonHtml
          : url.includes('/page/summary/')
            ? JSON.stringify(summary)
            : undefined
      )
  }
  const sources = []

  for await (const page of importVault(['Babylon'], {
    fetch,
    cache: false,
    delay: 0,
    images: false,
    refs: 'drop'
  })) {
    const path = join(dir, page.path)

    await mkdir(dirname(path), {recursive: true})
    await writeFile(path, page.source)
    sources.push(page.source)
  }

  const entry = [
    '+++',
    'title: Query',
    '+++',
    "% const settlements = await $.find({ 'infobox.type': 'Settlement' })",
    "% const iraq = await $.find({ 'infobox.location': { $regex: 'Iraq' } })",
    '{{ settlements.length }} settlements, {{ iraq.length }} in Iraq',
    ''
  ].join('\n')
  const set = await openDocumentSet([entry, ...sources])

  assert.match(await set.render(0), /1 settlements, 1 in Iraq/)

  // And the file really is on disk under the name a wiki link would use.
  assert.match(await readFile(join(dir, 'babylon.mdy'), 'utf8'), /^\+\+\+/)
})

test('a vault cross-links itself', async () => {
  const {fetch} = wiki(pages)
  const out = await collect(['Babylon'], {
    fetch,
    cache: false,
    delay: 0,
    follow: 1,
    links: 'wiki'
  })
  const names = new Set(out.map((page) => page.path.replace(/\.mdy$/, '')))

  for (const page of out) {
    for (const target of fromMdy(page.source).data.matter.links ?? []) {
      // Every link in this little wiki points at a page of it, so every one
      // should name a document that was written.
      assert.ok(names.has(target), page.path + ' → ' + target)
    }
  }
})
