# @mdy-docs/mdy-live-preview

A two-pane live [mdy](../..) editor demo: Monaco on the left, the rendered
document on the right, re-rendered as you type — the whole engine (template
VM, query engine) running client-side as WebAssembly.

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
copy, PDF export, and content persistence in localStorage.

Based on [mdy-docs/mdy-live-preview](https://github.com/mdy-docs/mdy-live-preview)
(itself a fork of [tanabe/markdown-live-preview](https://github.com/tanabe/markdown-live-preview),
see [LICENSE](LICENSE)), ported to the current engine: `mdy-docs` is a
`file:` link to this repo, `render()` is async and raced by version so a
fast typist can't outrun it, and mermaid fences are lifted from the
engine's ordinary code-block output after sanitization. Monaco is loaded
from a CDN (as upstream does) and html2pdf from a CDN `<script>` — the rest
is bundled locally by Vite.

Monaco's tokenization comes from the
[vscode-mdy](../editors/vscode-mdy) extension's own `mdy.tmLanguage.json`
TextMate grammar — shiki executes it (pure-JS regex engine, no wasm) and
`@shikijs/monaco` adapts it to Monaco's tokenizer, with dark-plus /
light-plus following the theme toggle. One grammar, every editor.
