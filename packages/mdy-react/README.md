# @mdy-docs/react

mdy documents as React elements.

```jsx
import { Mdy } from '@mdy-docs/react';

<Mdy source={source} data={{ title: 'Q3' }} />
```

## What this is (and what it is not)

It is one compiler swap, not a second implementation of mdy.

mdy's pipeline — HTML containers → remark-parse → remark-gfm → GitHub alerts →
remark-rehype → rehype-raw → heading ids — ends at hast, a plain tree. Turning
that tree into an HTML string is one compiler (`rehype-stringify`); turning it
into React elements is another (`hast-util-to-jsx-runtime`). This package
supplies the second one and changes nothing else, so the two targets cannot
drift: a fix to alerts or containers lands in both at once, and the test suite
asserts byte-equivalence against the string target on real example documents.

The document engine itself — splitting, front matter, the lamassu VM, nisaba
queries, `$.find`/`$.render`/`$.emit` — is not involved. It never touched a DOM,
so there was nothing in it to port.

**The static site generator should keep using `mdy-docs` directly.** It writes
files; strings are the right output there. This package is for documents that
live inside a React tree.

## Why bother — reconciliation

Rendering to an HTML string in a React app means `dangerouslySetInnerHTML`,
which replaces the whole subtree on every change and then needs imperative
repair afterwards: re-run the highlighter, re-render the diagrams, re-attach the
copy buttons. Scroll position, focus, and any state inside the output are lost
on each keystroke.

An element tree is reconciled instead. Editing one word patches one text node.
Everything else — including component state inside the document, an open
`<details>`, a rendered diagram — stays where it was.

## API

### `<Mdy source … />`

Renders the document, unwrapped — no container element, so your layout and CSS
decide the box.

| prop | meaning |
| --- | --- |
| `source` | mdy source: a string, or an array forming one document set |
| `data` | the entry document's `arg` (its own front matter stays `self`) |
| `entry` | which document in the set to render (default `0`) |
| `components` | tag name → React component |
| `sanitize` | `false` (default), `true`, or a schema — see below |
| `remarkPlugins` / `rehypePlugins` | extra pipeline plugins |
| `fallback` | shown until the first render resolves |
| `errorFallback` | `(error) => node`, shown when the *first* render fails |
| `onError` | called on every failed render |

### `useMdy(source, options)` → `{ element, error, pending }`

The same thing without the component, for when you want to place the error and
loading states yourself. Options are `<Mdy>`'s, minus the three display props.

Rendering is asynchronous — the template layer runs in a WASM VM — and the hook
is built for the live-editor case:

- **The last good render stays on screen.** A keystroke that leaves the document
  mid-sentence sets `error` and leaves `element` alone, so the preview does not
  strobe between content and a stack trace while you type. Put the message in an
  error bar via `onError`, over output that is still readable.
- **Stale renders are dropped.** Only the newest render is ever committed.
- **`pending` is advisory** — for a spinner or a dimmed pane. It never blanks
  the output.

Inline object props (`data={{…}}`, `components={{…}}`) are compared by value, so
they do not rebuild the processor on every render. Plugin arrays are compared one
level deep: keep those as module-level constants.

### `createReactProcessor(options)`

The processor behind both, mirroring `mdy-docs`' `createProcessor`. Same shape —
`render`, `renderMarkdown`, `renderTree`, `renderToMarkdown` — with the first
three resolving to React elements. Reuse one across many renders.

### `renderToReact(source, data, options)`

One-shot `source → Promise<ReactElement>`.

## Components

Where the real leverage is. Every tag the pipeline emits can be replaced:

```jsx
const components = {
  code: CodeBlock,     // Shiki, or a mermaid diagram for ```mermaid
  a: Link,             // your router's link
  img: Image,          // lazy loading, lightbox
};

<Mdy source={source} components={components} />
```

Components get the usual props plus `node`, the hast node, unless you pass
`passNode: false`. This is what replaces the render-then-repair pattern: a
fenced block *is* the highlighter component, with its own lifecycle, rather than
markup you go back and fix up after the fact.

## Sanitization

`sanitize` defaults to `false`, matching `mdy-docs`' own HTML output. That is
right when you author the documents and wrong when your users do.

Raw HTML is a first-class mdy feature, not an edge case: HTML containers are
*source syntax* that expands to raw tags, and alert boxes compile to a `<div>`
wrapping an inline `<svg>`. A stock sanitize schema allows none of that — it
does not error, it silently emits `class=""` and drops the icon. So `sanitize:
true` applies `mdySanitizeSchema`, the standard schema widened exactly as far as
mdy's own output requires and no further. Pass your own schema object to
replace it.

Two things the React target gives you before any schema is consulted, both
covered by tests: React refuses to emit string event handlers (`onclick="…"` in
raw HTML is dropped), and it rewrites `javascript:` URLs into an inert throw. It
does **not** stop a raw `<script>`, which renders verbatim and runs. Unsanitized
output here is safer than on the string path, and still not safe.

One deliberate deviation in `mdySanitizeSchema`: `clobberPrefix` is `''`. The
stock schema rewrites every `id` to `user-content-<id>`, which breaks every
anchor `$.toc()` generates, since the two sides use the same slugger. Anchors win
because a table of contents that silently stops working is a bug you ship
without noticing, while DOM clobbering needs an attacker-authored document. If
yours are attacker-authored, put the prefix back.

## Notes

- **Table alignment.** `tableCellAlignToStyle` defaults to `false` here, unlike
  `hast-util-to-jsx-runtime`'s own default, so aligned cells get `align="right"`
  exactly as the string target emits — a stylesheet that works against one
  target works against the other. Set it `true` for the modern inline style.
- React 18 or later, as a peer dependency.

## Tests

```sh
npm test
```
