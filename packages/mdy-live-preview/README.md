# @mdy-docs/mdy-live-preview

A two-pane live [mdy](../..) editor demo: Monaco on the left, the rendered
document on the right, re-rendered as you type — the whole stack (template
VM, query engine, message broker) running client-side as WebAssembly.

The editor is seeded with
[`examples/document-set.mdy`](../../examples/document-set.mdy): a document
SET in one file — an entry document that finds every `role: member` record
with `$.find` and renders a shared `member-card` template once per match.
Edit a member's data, add a new `---`-separated member document, or change
the card template, and the preview recomposes live.

```sh
npm install
npm run dev        # → http://localhost:8091
npm run build      # production bundle → dist/
```

Also in the box: mermaid fences rendered as diagrams, dark mode (editor,
preview css, and diagrams switch together), sync-scroll, draggable split,
copy, and content persistence in localStorage.

## Three WASM engines, no server

[lamassu](https://github.com/mdy-docs/lamassu-js) runs the templates,
[nisaba](https://github.com/mdy-docs/nisaba-db) answers `$.find`, and
[sukkal](https://github.com/mdy-docs/sukkal-msg) — since it learned to
compile to WebAssembly — is the message broker. Nothing here talks to a
server.

The seeded document ends with a `$.publish`, so the pane under the preview
shows what it sent and what each message caused:

```
[send]    welcome #1
[deliver] welcome #1
          Welcome aboard, Alice. You are message #1…
```

`$.render(name, data)` calls a page now; `$.publish(name, data)` is the same
call queued and delivered later, and the page it names renders with the
message bound as `req`. Nothing subscribes — a page is addressable because
it exists, by its path, or by `messageName` in its front matter when (as
here) the whole set is one editor pane with no paths in it.

What that demonstrates is not that messaging also works in a browser. It is
that publishing has no transport in it: the routing table a native `sukkal
serve` answers over HTTP is the one being called here, by name, in process.
Delete the `$.publish` line and the pane disappears — a document that never
publishes never opens a broker.

## The preview pane is React

The app is a React app, and the right-hand pane renders through
[`@mdy-docs/react`](../mdy-react/) — the document is a React subtree, not an
HTML string. [`Preview.jsx`](src/Preview.jsx) is the whole of it.

That is not a stylistic choice; it is what the preview pane needed. The old
build did `output.innerHTML = DOMPurify.sanitize(html)` on every change and
then repaired the DOM it had just built: a pass to rewrite
`pre > code.language-mermaid` into `pre.mermaid`, a debounced sweep to render
every diagram in the pane, and a version counter so a slow diagram couldn't
paint over a newer one. All three existed because the pane was destroyed and
rebuilt on each keystroke.

What replaced them:

- **Reconciliation instead of replacement.** Editing the title patches the
  `<h1>`'s text node — the same DOM elements survive the edit, so scroll
  position, focus and selection inside the preview do too.
- **A mermaid fence *is* a component** ([`Mermaid.jsx`](src/Mermaid.jsx)),
  reached by overriding `pre` and reading the hast `node`. It re-renders when
  its own source or the theme changes, and not when something else on the page
  does. No sweep, no version counter — React keeps the instance alive.
- **A broken keystroke no longer blanks the pane.** `useMdy` keeps the last
  good render and reports the error, so the app shows an error bar over dimmed
  but readable output instead of replacing the document with a stack trace.
- **Sanitization moved a stage earlier.** `sanitize: true` cleans the tree
  before it becomes elements, replacing DOMPurify's parse-clean-reparse of the
  HTML string. The schema is mdy-aware: HTML containers keep their classes and
  alert icons survive, which a stock schema silently eats.

Based on [mdy-docs/mdy-live-preview](https://github.com/mdy-docs/mdy-live-preview)
(itself a fork of [tanabe/markdown-live-preview](https://github.com/tanabe/markdown-live-preview),
see [LICENSE](LICENSE)), ported to the current engine: `mdy-docs` is a `file:`
link to this repo and `render()` is async, so stale renders are dropped rather
than raced. Monaco is loaded from a CDN (as upstream does) and stays
imperative — it owns its own buffer, and [`Editor.jsx`](src/Editor.jsx) just
creates and disposes it. The rest is bundled locally by Vite.

Note for anyone copying the Vite config: `resolve.dedupe: ['react',
'react-dom']` is required, not optional. `@mdy-docs/react` is a `file:` link
carrying its own React in devDependencies, and two copies of React means every
hook throws.

Monaco's tokenization comes from the
[vscode-mdy](../editors/vscode-mdy) extension's own `mdy.tmLanguage.json`
TextMate grammar — shiki executes it (pure-JS regex engine, no wasm) and
`@shikijs/monaco` adapts it to Monaco's tokenizer, with dark-plus /
light-plus following the theme toggle. One grammar, every editor.
