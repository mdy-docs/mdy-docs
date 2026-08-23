import {defaultArrows, defaultMarkers, mdy, scriptBrackets} from 'mdy-docs/parse'
import {enhanceTasks} from 'mdy-docs/tasks'
import {followFragments, headingAnchors} from './anchor.js'
import {draftKey} from './draft.js'
import {createEditor} from './editor.js'
import {scope} from './scope.js'
import {blockRegions, embed, highlightMdy} from './syntax.js'
import {setupTheme} from './theme.js'
import './style.css'

// The document lives in index.html, so the page ships with its own content.
const sample = document
  .querySelector('#sample')
  .textContent // Only the newline the opening tag introduces, so a first line
  .replace(/^\r?\n/, '') // that begins indented would still begin indented.
  .replace(/\s+$/, '')

const storageKey = draftKey(localStorage, sample)

// What the document is answering. One object, kept and counted up rather than
// made fresh, so a document can watch its own request change as you type.
const request = {pane: 'the preview pane', renders: 0}

// The playground runs what you type, which is the point of showing the script
// rule. A page that processes input it did not write should leave `script`
// off.
const processor = mdy({
  script: {scope, request},
  tasks: true
}).use(headingAnchors)

const views = [
  {id: 'preview', label: 'Preview'},
  {id: 'json', label: 'JSON'}
]

document.querySelector('#app').innerHTML = `
  <header class="hero">
    <button type="button" class="theme" id="theme">
      <svg class="sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2v2.6M12 19.4V22M4.2 4.2l1.9 1.9M17.9 17.9l1.9 1.9M2 12h2.6M19.4 12H22M4.2 19.8l1.9-1.9M17.9 6.1l1.9-1.9" />
      </svg>
      <svg class="moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8z" />
      </svg>
    </button>

    <div class="hero-inner">
      <p class="eyebrow">documents · data · sandboxed templates · sites</p>
      <h1>Write <span class="glyph">MDY</span>.<br />Get a document that renders itself.</h1>
      <p class="lede">
        MDY is the markup language behind mdy-docs: five block rules, a
        toggling inline syntax, and a script stage, parsed straight to
        <a href="https://github.com/syntax-tree/hast">hast</a>. Everything
        below is one document carrying its own data and rendering itself —
        including the contents list, which it builds from its own tree.
      </p>
      <pre class="snippet"><code>npm install mdy-docs

import {mdy} from 'mdy-docs/parse'

mdy().processSync('== Hello //there//').toString()
<span class="comment">// → &lt;h2&gt;Hello &lt;em&gt;there&lt;/em&gt;&lt;/h2&gt;</span></code></pre>
      <ul class="cheatsheet">
        <li><code>=</code> … <code>======</code><span>heading, h1–h6</span></li>
        <li><code>===</code> <code>----</code><span>underline, h1–h2</span></li>
        <li><code>***</code><span>rule</span></li>
        <li><code>⏎⏎</code><span>new paragraph</span></li>
        <li><code>&lt;</code> <code>&lt;table</code><span>element</span></li>
        <li><code>␣␣</code><span>nest, or wrap in a div</span></li>
        <li><code>-</code> <code>*</code> <code>1.</code><span>list</span></li>
        <li><code>- [x]</code><span>task</span></li>
        <li><code>| … |</code><span>table</span></li>
        <li><code>https://…</code><span>link</span></li>
        <li><code>[[ text | url ]]</code><span>written link</span></li>
        <li><code>[[ ^1 ]]</code><span>footnote</span></li>
        <li><code>:)</code> <code>:rocket:</code><span>emoji</span></li>
        <li><code>...</code><span>ellipsis</span></li>
        ${Object.entries(defaultArrows)
          .map(
            ([sequence, character]) =>
              `<li><code>${sequence.replace(/</g, '&lt;')}</code><span>${character}</span></li>`
          )
          .join('')}
        <li><code>% js</code><span>script</span></li>
        <li><code>{{ expr }}</code><span>interpolate</span></li>
        <li><code>\\</code><span>escape</span></li>
        ${defaultMarkers
          .map(
            (marker) =>
              `<li><code>${marker.sequence}</code><span>${marker.label}</span></li>`
          )
          .join('')}
      </ul>
    </div>
  </header>

  <main class="playground">
    <section class="pane" aria-labelledby="source-heading">
      <div class="pane-head">
        <h2 id="source-heading">Source</h2>
        <div class="pane-tools">
          <span class="stat" id="stat-caret"></span>
          <span class="stat" id="stat-source"></span>
          <button type="button" class="ghost" id="reset">Reset</button>
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
              <button
                type="button"
                role="tab"
                id="tab-${view.id}"
                data-view="${view.id}"
                aria-controls="panel-output"
                aria-selected="${index === 0}"
              >${view.label}</button>`
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

  <footer class="foot">
    <p>
      The language and its parser are <code>src/parse</code>; this page and the
      landing page are <code>packages/mdy-site</code>, which is not shipped with
      the <code>mdy-docs</code> package.
    </p>
  </footer>
`

setupTheme(document.querySelector('#theme'), localStorage)

const rendered = document.querySelector('#rendered')
const code = document.querySelector('#code')
const codeBody = code.querySelector('code')
const messageList = document.querySelector('#messages')
const sourceStat = document.querySelector('#stat-source')
const caretStat = document.querySelector('#stat-caret')
const tabs = [...document.querySelectorAll('[role="tab"]')]

let view = 'preview'

// The editor paints MDY behind a plain textarea, so what you type is still a
// textarea: same caret, same undo, same shortcuts.
const editor = createEditor(document.querySelector('#editor-host'), {
  value: localStorage.getItem(storageKey) ?? sample,
  highlight: highlightMdy,
  regions: blockRegions,
  brackets: (source) => scriptBrackets(source.split('\n')),
  attributes: {id: 'editor', 'aria-label': 'MDY source'},
  onInput() {
    localStorage.setItem(storageKey, editor.value)
    schedule()
  },
  onCaret({line, column}) {
    caretStat.textContent = `Ln ${line}, Col ${column}`
  }
})

render()

// Fragment links point inside the preview pane, which scrolls on its own.
followFragments(rendered)

document.querySelector('#reset').addEventListener('click', () => {
  editor.value = sample
  localStorage.removeItem(storageKey)
  editor.focus()
  render()
})

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    view = tab.dataset.view

    for (const other of tabs) {
      other.setAttribute('aria-selected', String(other === tab))
    }

    render()
  })
}

// The forms work without any of this — they post to the page and it reloads.
// Here there is no server to post to, so the editor plays the part of one: the
// change is written into the source, which is exactly what a handler would do
// to the file. If the coordinates were wrong, this would visibly write to the
// wrong place.
enhanceTasks(rendered, {
  async submit(detail) {
    const lines = editor.value.split('\n')
    const index = detail.line - 1
    const column = detail.column - 1

    if (lines[index]?.[column] !== detail.was) {
      throw new Error('The source moved on — reload to catch up')
    }

    lines[index] =
      lines[index].slice(0, column) + detail.next + lines[index].slice(column + 1)

    editor.value = lines.join('\n')
    localStorage.setItem(storageKey, editor.value)
    schedule()

    return true
  },
  messages: {pending: 'Editing the source…', ok: 'Edited the source'}
})

let frame

function schedule() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(render)
}

function render() {
  const document_ = editor.value

  // One more time round, which is the one thing on the request that moves.
  request.renders += 1
  /** @type {import('vfile').VFile} */
  let file
  /** @type {import('hast').Root} */
  let tree

  try {
    file = processor.processSync(document_)
    tree = processor.parse(document_)
  } catch (error) {
    showMessages([{fatal: true, reason: error.message}])
    return
  }

  showMessages(file.messages)

  const blocks = tree.children.length

  sourceStat.textContent =
    `${document_.length} chars · ` +
    `${blocks} block${blocks === 1 ? '' : 's'}`

  rendered.hidden = view !== 'preview'
  code.hidden = view === 'preview'

  if (view === 'preview') {
    rendered.innerHTML = String(file)
    if (!blocks) rendered.innerHTML = '<p class="empty">Nothing yet.</p>'
    return
  }

  // What the document answered with, which is the front matter at the top of
  // the editor: edit the `+++` block and this follows.
  const data = file.data.response?.data

  codeBody.innerHTML =
    data === undefined
      ? '<span class="empty">No front matter, so nothing on res.data.</span>'
      : embed(JSON.stringify(data, undefined, 2), 'json')
}

/** @param {Array<{fatal?: boolean | null, reason: string, line?: number | null}>} messages */
function showMessages(messages) {
  messageList.hidden = messages.length === 0
  messageList.innerHTML = messages
    .map(
      (message) =>
        `<li class="${message.fatal ? 'fatal' : 'warn'}">` +
        (message.line ? `<b>line ${message.line}</b> ` : '') +
        escapeHtml(message.reason) +
        '</li>'
    )
    .join('')
}

/** @param {string} value */
/** @param {string} value */
function escapeHtml(value) {
  return value.replace(
    /[&<>"]/g,
    (character) =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[character]
  )
}
