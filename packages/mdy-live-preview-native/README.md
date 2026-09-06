# @mdy-docs/mdy-live-preview-native

[mdy-live-preview](../mdy-live-preview) with the C engine in place of the
JavaScript one. The same two panes — Monaco on the left, the rendered
document set on the right, re-rendered as you type — and the same seeded
[`examples/document-set.mdy`](../../examples/document-set.mdy), but what
renders it is [packages/mdy-native](../mdy-native) compiled to WebAssembly:
`build/mdy`, the command, run in the tab as the command line runs it.

```sh
make -C ../mdy-native wasm    # the engine, once (needs emcc)
npm install
npm run dev        # → http://localhost:8092
npm run build      # production bundle → dist/
npm run check      # drives the page in a headless Chromium, against the dev server
```

Also in the box, as before: mermaid fences drawn as diagrams, dark mode,
sync-scroll, draggable split, copy, and content persistence in
localStorage — under its own key, so this and the JavaScript demo can be
open side by side.

## One WASM module, no server

The JavaScript demo runs three WebAssembly engines beside each other —
[lamassu](https://github.com/mdy-docs/lamassu-js) for the templates,
[nisaba](https://github.com/mdy-docs/nisaba-db) for `$.find`,
[sukkal](https://github.com/mdy-docs/sukkal-msg) for the messages — with
JavaScript between them. Here the same three are linked into one C binary
along with the front end and the highlighter, and that binary is the
module. What JavaScript remains is [`native.js`](src/native.js): a file
written into the module's filesystem, `main()` called with the arguments
`mdy document.mdy --html -o out --publish` would have, the output read
back, the log parsed. Nothing here talks to a server, and nothing here
renders a document either — the C does.

The seeded document ends with a `$.publish`, so the pane under the preview
shows what it sent and what each message caused, exactly as before:

```
[send]    welcome #1
[deliver] welcome #1 → document 2
          Welcome aboard, Alice. You are message #1…
```

That pane is the command's own `--publish` log. `mdy <file> --publish`
sends what the document published to a broker inside the process — sukkal,
over a directory in memory — and delivers each message to the page it
names, printing that page's output under the `[deliver]` line; a page that
throws is refused and dead-lettered at once, and a `.dead` page, if the
set has one, renders the letter in the same pass. The wrapper in
[`mdy-native/wasm/index.mjs`](../mdy-native/wasm/index.mjs) turns those
lines into the objects the pane shows. Delete the `$.publish` line and the
pane disappears: a document that never publishes is rendered without the
flag, and never opens a broker.

## The preview pane is a string

The JavaScript demo's pane is a React subtree — the document as a hast
tree from its own processor, reconciled on each keystroke, with a mermaid
fence as a component. That was the right shape for an engine that hands
back a tree. This engine hands back HTML, the same bytes `mdy --html`
writes to a file, so the pane is that string, sanitized with DOMPurify and
set as the pane's content ([`Preview.jsx`](src/Preview.jsx)). It is the
honest shape of the bridge, and it costs two things the React port had
removed:

- **Replacement, not reconciliation.** The pane is rebuilt on each settled
  edit. Scroll position survives — the pane's scroll container is outside
  the replaced content — but a selection inside the preview does not.
- **Diagrams are a repair.** A mermaid fence arrives as
  `<pre><code class="language-mermaid">`, is found after the fact and
  replaced with its drawing. The drawings are cached by source and theme
  ([`Mermaid.jsx`](src/Mermaid.jsx)), so an edit elsewhere on the page
  re-attaches a diagram rather than re-laying it out.

What it keeps: a broken keystroke does not blank the pane — the C exits
non-zero with the error on stderr, [`useNative.js`](src/useNative.js)
keeps the last good HTML and shows the error over it — and stale renders
are dropped rather than raced. What it gains: code fences arrive already
highlighted, by highlight.js running inside the engine, so the page only
loads a stylesheet for the classes (`public/css/hljs-*.css`, highlight.js's
own github themes).

The module is compiled once and instantiated per render: the engine keeps
a little static state a process never had to reset, and a fresh instance
of a compiled module is cheap where compiling 2 MB of wasm per keystroke
would not be.

Monaco is loaded from a CDN, as upstream does, tokenized by the
[vscode-mdy](../editors/vscode-mdy) extension's own `mdy.tmLanguage.json`
through shiki and `@shikijs/monaco`. Based on
[mdy-docs/mdy-live-preview](https://github.com/mdy-docs/mdy-live-preview)
(itself a fork of
[tanabe/markdown-live-preview](https://github.com/tanabe/markdown-live-preview),
see [LICENSE](LICENSE)).
