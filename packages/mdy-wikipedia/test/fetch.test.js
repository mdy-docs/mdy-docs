import assert from 'node:assert/strict'
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {fetchCategory, fetchIndexes, fetchPage, fetchWikidata, resolveTarget, userAgent} from '../src/fetch.js'
import {babylonIndexes} from './fixture.js'

/** A fetch that answers from a table and records what it was asked. */
function stub(table) {
  const calls = []

  return {
    calls,
    fetch(url, init) {
      calls.push({url, init})

      const body = table[url]

      return Promise.resolve({
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        statusText: body === undefined ? 'Not Found' : 'OK',
        text: () => Promise.resolve(body)
      })
    }
  }
}

const htmlUrl = 'https://en.wikipedia.org/api/rest_v1/page/html/Babylon'
const summaryUrl = 'https://en.wikipedia.org/api/rest_v1/page/summary/Babylon'

test('resolves a bare title, a prefix, and a URL', () => {
  assert.deepEqual(resolveTarget('Babylon'), {lang: 'en', title: 'Babylon'})
  assert.deepEqual(resolveTarget('Babylon', {lang: 'de'}), {lang: 'de', title: 'Babylon'})
  assert.deepEqual(resolveTarget('fr:Babylone'), {lang: 'fr', title: 'Babylone'})
  assert.deepEqual(resolveTarget('https://en.wikipedia.org/wiki/Babylon'), {
    lang: 'en',
    title: 'Babylon'
  })
})

test('a URL gives up its spelling: underscores, escapes, fragment, query', () => {
  assert.deepEqual(
    resolveTarget('https://de.wikipedia.org/wiki/Kish_(Sumer)?action=raw#Geschichte'),
    {lang: 'de', title: 'Kish (Sumer)'}
  )
  assert.deepEqual(resolveTarget('https://en.m.wikipedia.org/wiki/Mari%2C_Syria'), {
    lang: 'en',
    title: 'Mari, Syria'
  })
})

test('a namespace is not a language', () => {
  // `Talk:` looks exactly like a language prefix and is not one.
  assert.deepEqual(resolveTarget('Talk:Babylon'), {lang: 'en', title: 'Talk:Babylon'})
  assert.deepEqual(resolveTarget('Category:Babylon'), {lang: 'en', title: 'Category:Babylon'})
})

test('an empty target is an error, not a fetch of nothing', () => {
  assert.throws(() => resolveTarget('  '), /Expected a page title or URL/)
})

test('says who is asking, as Wikimedia requires', () => {
  assert.match(userAgent(), /^mdy-wikipedia\/\d+\.\d+\.\d+ \(https:\/\/github\.com\//)
  assert.match(userAgent({contact: 'me@example.com'}), /; me@example\.com\)$/)
})

test('fetches the HTML and the summary, with the user agent on both', async () => {
  const {fetch, calls} = stub({[htmlUrl]: '<html></html>', [summaryUrl]: '{"pageid":1}'})
  const page = await fetchPage({lang: 'en', title: 'Babylon'}, {fetch, cache: false})

  assert.equal(page.html, '<html></html>')
  assert.deepEqual(page.summary, {pageid: 1})
  assert.deepEqual(calls.map((call) => call.url), [htmlUrl, summaryUrl])

  for (const call of calls) {
    assert.equal(call.init.headers['user-agent'], userAgent())
  }
})

test('a missing summary is not fatal; missing HTML is', async () => {
  const soft = stub({[htmlUrl]: '<html></html>'})
  const page = await fetchPage({lang: 'en', title: 'Babylon'}, {fetch: soft.fetch, cache: false})

  assert.equal(page.summary, undefined)

  const hard = stub({})

  await assert.rejects(
    fetchPage({lang: 'en', title: 'Babylon'}, {fetch: hard.fetch, cache: false}),
    /Could not fetch .*404/
  )
})

test('a title is encoded for the URL and kept readable in the target', async () => {
  const url = 'https://en.wikipedia.org/api/rest_v1/page/html/Kish_(Sumer)'
  const {fetch, calls} = stub({[url]: '<html></html>'})

  await fetchPage({lang: 'en', title: 'Kish (Sumer)'}, {fetch, cache: false})

  assert.equal(calls[0].url, url)
})

test('the cache is written once and read instead of fetched', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'mdy-wikipedia-'))
  const first = stub({[htmlUrl]: '<html>one</html>', [summaryUrl]: '{"pageid":1}'})

  await fetchPage({lang: 'en', title: 'Babylon'}, {fetch: first.fetch, cache})
  assert.equal(first.calls.length, 2)

  const second = stub({[htmlUrl]: '<html>two</html>', [summaryUrl]: '{"pageid":2}'})
  const page = await fetchPage({lang: 'en', title: 'Babylon'}, {fetch: second.fetch, cache})

  assert.equal(second.calls.length, 0, 'the second run should not have fetched')
  assert.equal(page.html, '<html>one</html>')

  const refreshed = stub({[htmlUrl]: '<html>two</html>', [summaryUrl]: '{"pageid":2}'})
  const fresh = await fetchPage(
    {lang: 'en', title: 'Babylon'},
    {fetch: refreshed.fetch, cache, refresh: true}
  )

  assert.equal(fresh.html, '<html>two</html>')
  assert.equal(
    await readFile(join(cache, 'en', 'Babylon.html'), 'utf8'),
    '<html>two</html>',
    'a refresh should replace what was cached'
  )
})

test('a summary that is not JSON is reported and skipped', async () => {
  const messages = []
  const {fetch} = stub({[htmlUrl]: '<html></html>', [summaryUrl]: 'not json'})
  const page = await fetchPage(
    {lang: 'en', title: 'Babylon'},
    {fetch, cache: false, file: {message: (reason) => messages.push(reason)}}
  )

  assert.equal(page.summary, undefined)
  assert.match(messages[0], /did not parse as JSON/)
})

test('the categories and langlinks come back as a list and a map', async () => {
  const calls = []
  const fetch = (url) => {
    calls.push(url)

    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({query: {pages: [babylonIndexes]}}))
    })
  }

  const out = await fetchIndexes(
    {lang: 'en', title: 'Babylon'},
    {categories: true, langLinks: true},
    {fetch, cache: false}
  )

  assert.ok(out.categories.includes('Archaeological sites in Iraq'))
  // The `Category:` prefix is a namespace, not part of the name.
  assert.ok(!out.categories.some((name) => name.startsWith('Category:')))
  // A map, not a list: what anybody wants from this is `langlinks.fr`.
  assert.equal(out.langlinks.fr, 'Babylone')
  assert.equal(out.langlinks.ar, '\u0628\u0627\u0628\u0644')

  // Hidden maintenance categories are asked to stay behind at the API rather
  // than filtered here: Babylon is in 53 and 35 of them are upkeep.
  assert.equal(calls.length, 1)
  assert.match(calls[0], /clshow=!hidden/)
  assert.ok(out.categories.length < 25)
})

test('asking for neither index asks for nothing', async () => {
  const {fetch, calls} = stub({})

  assert.deepEqual(await fetchIndexes({lang: 'en', title: 'Babylon'}, {}, {fetch}), {})
  assert.equal(calls.length, 0)
})

test('an index that will not fetch is reported, not fatal', async () => {
  const messages = []
  const {fetch} = stub({})
  const out = await fetchIndexes(
    {lang: 'en', title: 'Babylon'},
    {categories: true},
    {fetch, cache: false, file: {message: (reason) => messages.push(reason)}}
  )

  assert.deepEqual(out, {})
  assert.match(messages[0], /Could not fetch indexes\.categories \(404\)/)
})

test('wikidata is two round trips: the entity, then the labels it names', async () => {
  const entity = {
    entities: {
      Q1: {
        id: 'Q1',
        claims: {
          P31: [
            {
              rank: 'normal',
              mainsnak: {
                snaktype: 'value',
                datatype: 'wikibase-item',
                datavalue: {type: 'wikibase-entityid', value: {id: 'Q2'}}
              }
            }
          ]
        }
      }
    }
  }
  const labels = {
    entities: {
      P31: {labels: {en: {value: 'instance of'}}},
      Q2: {labels: {en: {value: 'city-state'}}}
    }
  }
  const calls = []
  const fetch = (url) => {
    calls.push(url)

    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify(url.includes('EntityData') ? entity : labels))
    })
  }

  const out = await fetchWikidata('Q1', {lang: 'en', title: 'Babylon'}, {fetch, cache: false})

  assert.equal(out.entity.id, 'Q1')
  assert.deepEqual(out.labels, {P31: 'instance of', Q2: 'city-state'})
  assert.equal(calls.length, 2)
  assert.match(calls[0], /Special:EntityData\/Q1\.json$/)
  // Both the property and its value in one request: the API takes fifty at a
  // time and asking one at a time would be 150 requests for Babylon.
  assert.match(calls[1], /ids=P31%7CQ2/)
})

test('no wikidata id means no request', async () => {
  const {fetch, calls} = stub({})

  assert.equal(await fetchWikidata(undefined, {lang: 'en', title: 'Babylon'}, {fetch}), undefined)
  assert.equal(calls.length, 0)
})

test('a category is read to the end, articles only', async () => {
  const answers = [
    {
      query: {categorymembers: [{title: 'Assur'}, {title: 'Nineveh'}]},
      continue: {cmcontinue: 'page|02'}
    },
    {query: {categorymembers: [{title: 'Ur'}]}}
  ]
  const calls = []
  const fetch = (url) => {
    calls.push(url)

    return Promise.resolve({
      ok: true,
      status: 200,
      headers: {get: () => null},
      text: () => Promise.resolve(JSON.stringify(answers[calls.length - 1]))
    })
  }

  const titles = await fetchCategory('Ancient Assyrian cities', {lang: 'en', title: 'x'}, {
    fetch,
    delay: 0
  })

  assert.deepEqual(titles, ['Assur', 'Nineveh', 'Ur'])
  assert.equal(calls.length, 2, 'a category bigger than one page is continued')
  // A category holds its subcategories and its talk pages too, and neither is
  // something to write a document from.
  assert.match(calls[0], /cmnamespace=0/)
  assert.match(calls[0], /cmtype=page/)
  assert.match(calls[1], /cmcontinue=page%7C02/)
  // The prefix is optional, and not doubled when it is given.
  assert.match(calls[0], /cmtitle=Category%3AAncient/)
})

test('a rate limit is waited out rather than argued with', async () => {
  const messages = []
  let calls = 0
  const fetch = () => {
    calls += 1

    return Promise.resolve(
      calls === 1
        ? {ok: false, status: 429, headers: {get: (name) => (name === 'retry-after' ? '0' : null)}}
        : {ok: true, status: 200, headers: {get: () => null}, text: () => Promise.resolve('<html></html>')}
    )
  }

  const page = await fetchPage({lang: 'en', title: 'Babylon'}, {
    fetch,
    cache: false,
    delay: 0,
    file: {message: (reason) => messages.push(reason)}
  })

  assert.equal(page.html, '<html></html>')
  assert.equal(calls, 3, 'the summary is fetched too')
  assert.match(messages[0], /Wikipedia asked to wait/)
})
