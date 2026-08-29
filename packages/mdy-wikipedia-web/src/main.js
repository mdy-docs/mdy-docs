/**
 * Read Wikipedia as mdy.
 *
 * The article on the right is not a preview of the conversion — it *is* the
 * document, parsed in the browser by the same parser the rest of the repo
 * uses, from the source on the left. Edit the source and the article follows,
 * which is the quickest way to see what a conversion decision actually did.
 *
 * The two panes and the editor between them are `@mdy-docs/mdy-site`'s, imported
 * rather than copied: the same textarea-with-a-painted-copy, the same MDY
 * colouring, the same stylesheet. A second implementation of an editor is a
 * second implementation to keep in step.
 *
 * Script is **off**. A converted article is input this page did not write, and
 * `mdy({script})` runs it with `new Function` rather than in the sandbox — so
 * the Data tab reads `file.data.matter`, which is the front matter itself and
 * needs nothing executed to show it.
 */

import {mdy, scriptBrackets} from 'mdy-docs/parse'
import {createEditor} from '@mdy-docs/mdy-site/editor'
import {blockRegions, embed, highlightMdy} from '@mdy-docs/mdy-site/syntax'
import {setupTheme} from '@mdy-docs/mdy-site/theme'
import {followFragments, headingAnchors} from '@mdy-docs/mdy-site/anchor'
import '@mdy-docs/mdy-site/style.css'
import './reader.css'

const processor = mdy({tasks: true}).use(headingAnchors)
const wikiUrl = /^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/(.+)$/i
const views = [
  {id: 'preview', label: 'Article'},
  {id: 'data', label: 'Data'}
]

document.querySelector('#app').innerHTML = `
  <header class="bar">
    <div class="bar-title">
      <span class="glyph">MDY</span>
      <h1 id="page-title">Wikipedia as mdy</h1>
      <span class="badge" id="page-from" hidden></span>
    </div>
    <form class="bar-go" id="go">
      <input
        type="search"
        id="query"
        name="query"
        placeholder="An article, or a Wikipedia URL"
        aria-label="Article to read"
        autocomplete="off"
        spellcheck="false"
      />
      <button type="submit" class="ghost">Read</button>
      <button type="button" class="ghost" id="refresh" title="Fetch again, past the cache">Refetch</button>
    </form>
    <button type="button" class="theme" id="theme">
      <svg class="sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2v2.6M12 19.4V22M4.2 4.2l1.9 1.9M17.9 17.9l1.9 1.9M2 12h2.6M19.4 12H22M4.2 19.8l1.9-1.9M17.9 6.1l1.9-1.9" />
      </svg>
      <svg class="moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8z" />
      </svg>
    </button>
  </header>

  <nav class="shelf" aria-label="Converted articles">
    <ul id="shelf-list"></ul>
  </nav>

  <main class="playground reader">
    <section class="pane" aria-labelledby="source-heading">
      <div class="pane-head">
        <h2 id="source-heading">Source</h2>
        <div class="pane-tools">
          <span class="stat" id="stat-caret"></span>
          <span class="stat" id="stat-source"></span>
        </div>
      </div>
      <div id="editor-host"></div>
    </section>

    <section class="pane" aria-labelledby="output-heading">
      <div class="pane-head">
        <h2 id="output-heading">Output</h2>
        <div class="pane-tools">
          <div class="tabs" role="tablist" aria-label="Output view">
            ${views
              .map(
                (view, index) => `
              <button type="button" role="tab" id="tab-${view.id}"
                data-view="${view.id}" aria-controls="panel-output"
                aria-selected="${index === 0}">${view.label}</button>`
              )
              .join('')}
          </div>
        </div>
      </div>
      <div class="output" id="panel-output" role="tabpanel" aria-live="polite">
        <div class="rendered" id="rendered"></div>
        <pre class="code" id="code" hidden><code></code></pre>
      </div>
      <ul class="messages" id="messages" hidden></ul>
    </section>
  </main>
`

setupTheme(document.querySelector('#theme'), localStorage)

const rendered = document.querySelector('#rendered')
const code = document.querySelector('#code')
const codeBody = code.querySelector('code')
const messageList = document.querySelector('#messages')
const sourceStat = document.querySelector('#stat-source')
const caretStat = document.querySelector('#stat-caret')
const pageTitle = document.querySelector('#page-title')
const pageFrom = document.querySelector('#page-from')
const shelf = document.querySelector('#shelf-list')
const query = document.querySelector('#query')
const tabs = [...document.querySelectorAll('[role="tab"]')]

let view = 'preview'
let current

// What the badge says about where a document came from, which is the
// interesting part of following a link.
const from = {
  wikipedia: 'converted just now',
  vault: 'from the vault',
  memory: 'already converted'
}

const editor = createEditor(document.querySelector('#editor-host'), {
  value: '',
  highlight: highlightMdy,
  regions: blockRegions,
  brackets: (source) => scriptBrackets(source.split('\n')),
  attributes: {id: 'editor', 'aria-label': 'MDY source'},
  onInput: schedule,
  onCaret({line, column}) {
    caretStat.textContent = `Ln ${line}, Col ${column}`
  }
})

followFragments(rendered)

// A link out of the article is a link into the reader. Anything that names a
// Wikipedia article is caught here and read; anything else is left to the
// browser, opened where it will not take this page with it.
rendered.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]')

  if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return

  const match = wikiUrl.exec(link.getAttribute('href'))

  if (!match) {
    if (/^https?:/.test(link.getAttribute('href'))) link.target = '_blank'

    return
  }

  event.preventDefault()
  open(match[1] + ':' + decodeURIComponent(match[2].split('#')[0]).replaceAll('_', ' '))
})

document.querySelector('#go').addEventListener('submit', (event) => {
  event.preventDefault()

  if (query.value.trim()) open(query.value.trim())
})

document.querySelector('#refresh').addEventListener('click', () => {
  if (current) open(current.lang + ':' + current.title, {refresh: true})
})

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    view = tab.dataset.view

    for (const other of tabs) other.setAttribute('aria-selected', String(other === tab))

    render()
  })
}

addEventListener('popstate', (event) => {
  if (event.state?.page) open(event.state.page, {history: 'none'})
})

const first = new URL(location.href).searchParams.get('page')
const {opening} = await fetch('/api/pages').then((response) => response.json())

await open(first ?? opening, {history: 'replace'})
await refreshShelf()

/**
 * Show an article, fetching and converting it if this is the first time it has
 * been asked for.
 *
 * @param {string} input
 * @param {{history?: 'push' | 'replace' | 'none', refresh?: boolean}} [options]
 */
async function open(input, options = {}) {
  // Say what is being read and that it is being read. A conversion is a fetch
  // and a parse of half a megabyte, so there is a second or two here where the
  // page would otherwise be showing the last article with the wrong name on it.
  pageTitle.textContent = input.replace(/^[a-z-]{2,3}:/i, '')
  pageFrom.hidden = false
  pageFrom.textContent = 'reading…'
  pageFrom.dataset.from = 'loading'
  document.body.classList.add('is-loading')

  let page

  try {
    const response = await fetch(
      '/api/page?title=' + encodeURIComponent(input) + (options.refresh ? '&refresh=1' : '')
    )

    page = await response.json()

    if (!response.ok) throw new Error(page.error ?? response.statusText)
  } catch (error) {
    document.body.classList.remove('is-loading')
    pageFrom.textContent = 'could not be read'
    pageFrom.dataset.from = 'failed'
    showMessages([{fatal: true, reason: 'Could not read ' + input + ': ' + error.message}])

    return
  }

  document.body.classList.remove('is-loading')
  current = page
  editor.value = page.source
  pageTitle.textContent = page.title
  pageFrom.hidden = false
  pageFrom.textContent = from[page.from]
  pageFrom.dataset.from = page.from
  query.value = ''
  document.title = page.title + ' — Wikipedia as mdy'

  // The first entry is replaced rather than pushed, and it carries its state:
  // without that, going back to it arrives at a `popstate` with nothing on it
  // and the reader has no idea what to show.
  const key = page.lang + ':' + page.title

  if (options.history !== 'none') {
    history[options.history === 'replace' ? 'replaceState' : 'pushState'](
      {page: key},
      '',
      '?page=' + encodeURIComponent(key)
    )
  }

  render()
  rendered.scrollTop = 0
  await refreshShelf()
}

async function refreshShelf() {
  const {pages} = await fetch('/api/pages').then((response) => response.json())

  shelf.innerHTML = pages
    .map((page) => {
      const key = page.lang + ':' + page.title
      const here = current && key === current.lang + ':' + current.title

      return (
        `<li><button type="button" data-page="${escapeHtml(key)}"` +
        (here ? ' class="is-current" aria-current="page"' : '') +
        `>${escapeHtml(page.title)}` +
        (page.lang === 'en' ? '' : ` <span class="lang">${escapeHtml(page.lang)}</span>`) +
        '</button></li>'
      )
    })
    .join('')

  for (const button of shelf.querySelectorAll('button')) {
    button.addEventListener('click', () => open(button.dataset.page))
  }
}

let frame

function schedule() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(render)
}

function render() {
  const source = editor.value
  /** @type {import('vfile').VFile} */
  let file
  /** @type {import('hast').Root} */
  let tree

  try {
    file = processor.processSync(source)
    tree = processor.parse(source)
  } catch (error) {
    showMessages([{fatal: true, reason: error.message}])

    return
  }

  showMessages([
    ...(current?.messages ?? []).map((reason) => ({reason, kind: 'convert'})),
    ...file.messages
  ])

  const blocks = tree.children.length

  sourceStat.textContent =
    `${source.length} chars · ${blocks} block${blocks === 1 ? '' : 's'}`

  rendered.hidden = view !== 'preview'
  code.hidden = view === 'preview'

  if (view === 'preview') {
    rendered.innerHTML = blocks ? String(file) : '<p class="empty">Nothing yet.</p>'

    return
  }

  // The front matter, which is what the conversion was for. Read off the file
  // rather than out of a template, so nothing has to run for it to show.
  const data = file.data.matter

  codeBody.innerHTML =
    data === undefined
      ? '<span class="empty">No front matter.</span>'
      : embed(JSON.stringify(data, undefined, 2), 'json')
}

/** @param {Array<{fatal?: boolean | null, reason: string, line?: number | null, kind?: string}>} messages */
function showMessages(messages) {
  messageList.hidden = messages.length === 0
  messageList.innerHTML = messages
    .map(
      (message) =>
        `<li class="${message.fatal ? 'fatal' : message.kind === 'convert' ? 'convert' : 'warn'}">` +
        (message.kind === 'convert' ? '<b>conversion</b> ' : '') +
        (message.line ? `<b>line ${message.line}</b> ` : '') +
        escapeHtml(message.reason) +
        '</li>'
    )
    .join('')
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(
    /[&<>"]/g,
    (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[character]
  )
}
