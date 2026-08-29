import assert from 'node:assert/strict'
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {fetchPage, resolveTarget, userAgent} from '../src/fetch.js'

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
