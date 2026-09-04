# Desktop — implementation plan

> A native application on macOS, Linux and Windows, in the region of 6–9 MB,
> with no bundled JavaScript runtime and no rewrite. The stack already runs in
> a browser; what is missing is a window and a filesystem.

The premise is not "port mdy-docs to a desktop app". It is that mdy-docs is
already a browser program that has only ever been asked to run under Node. Every
dependency is pure JavaScript or WebAssembly, the site layer takes its
filesystem as an argument, and `fs-provider.js` says in its own comments that a
browser consumer was the reason. A desktop app is a shell around what exists.

## What is already true

Measured, not assumed. These are the facts the rest of the plan rests on, and
each is cheap to re-check if it stops being true.

**Nothing in the tree is native.** No `.node` binaries and no `binding.gyp`
anywhere in `node_modules` — every dependency is pure JavaScript or WASM. There
is nothing to compile per platform and nothing to keep in step with a Node ABI.

**The site layer needs no filesystem.** The 139-article corpus in
mdy-wikipedia-web — 192 files, 12.3 MB — was loaded into a `Map` and rendered
through `memoryFsProvider`:

```
renderSite with NO filesystem: 10544 ms, 93 outputs
identical to the disk build:   93/93
```

Byte-identical to the ordinary disk build, at the same speed, with
`../style-antiquity` resolved through the virtual provider. The import graph,
`$.find`, nested renders across sets — all of it is provider-clean already.

**It bundles small.** The whole public API — site layer, document engine, the
MDY front end, remark/rehype/unified, yaml, lowlight — through esbuild for the
browser: **858 KB raw, 264 KB gzipped**, in 127 ms.

**Serving from memory works in the browser.** A Service Worker holding a `Map`
of outputs, an `<iframe>` pointed at it, a link clicked, and a real navigation
to `/site/uruk/` — the same shape [../src/serve.js](../src/serve.js) uses from
Node, with no HTTP server and no Rust. Verified in WebKit over `http://`; see
Phase 1 for the part that is not yet verified.

**It runs in WebKit.** That bundle, plus `lamassu.wasm` (1008 KB) and
`nisaba.wasm` (571 KB), loaded in WebKit — the same JavaScriptCore as WKWebView
— rendering a two-document set with a cross-package import through
`memoryFsProvider`. Correct output, no page errors. Safari has been the
development browser for `mdy-live-preview` all along, so Asyncify in JSC was
never really in doubt; this confirms the *site* layer, which that demo does not
exercise.

## Why not Electron, a bundled runtime, or C

**Electron** ships Chromium and Node: 100–150 MB, and the Chromium update
treadmill becomes ours. It buys one engine on every platform, which is a real
benefit, and it is the fallback if the webview route founders.

**A bundled runtime as a sidecar** — Node, Bun or Deno alongside the shell —
costs 50–110 MB, which lands within sight of Electron while adding a process
boundary. It is worth it only for something the webview cannot do, and so far
nothing qualifies.

**A C rewrite** would mean giving up hast and rehype, which are the tree model
both front ends agree on and the reason `$.parse`, `$.markdown` and `$.render`
all return the same kind of thing. The hard parts — a JavaScript engine, a
regex engine, a database, a broker — are already C, roughly 79,600 lines of it;
mdy-docs' own JavaScript is about 9,600. Porting that middle layer would buy a
single binary and cost the ecosystem the tree model came from. Not now, and
possibly never.

The webview route is the only one that is small, keeps hast, and reaches iOS.

## Architecture — a window, a provider, and the bundle you already have

Three pieces, and only the middle one is new.

**The shell** is [Tauri](https://tauri.app) 2.x: a Rust host that opens a
window on the system webview and exposes capabilities to it. WKWebView on
macOS, WebKitGTK on Linux, WebView2 on Windows. Little Rust beyond
configuration and the `fs` plugin.

**`tauriFsProvider`** is the new code, and it is small. The provider contract in
[../src/fs-provider.js](../src/fs-provider.js) is nine methods —
`list`, `read`, `readBinary`, `mtime`, `size`, `write`, `writeBinary`,
`remove`, and `watch`, the last already optional at every call site
(`fs.watch?.(…)`). Tauri's `fs` and `fs-watch` plugins supply all of them.
Expect 100–150 lines.

**The application** is the existing browser bundle, running in the webview,
calling `renderSite(root, { fs: tauriFsProvider() })`. Everything above the
provider is untouched.

Two things follow from this that are worth stating plainly. The webview *is*
the JavaScript runtime, so there is nothing to ship one. And Tauri 2's
capability system makes the shell declare which paths the frontend may touch —
the same posture lamassu takes toward template code, one layer out.

## The editor is CodeMirror

`mdy-web` uses Monaco with shiki, and Monaco is 3–5 MB — the single largest
line item in the bundle and the difference between roughly 9–14 MB and roughly
6–9 MB. CodeMirror 6 is around 500 KB and starts faster, which matters more in
a webview than it does on a page a user has already committed to loading.

It has to be supported regardless: the same editor is wanted on the web, and
carrying two is carrying two.

The cost is the grammar. Highlighting today comes from
`packages/editors/vscode-mdy/syntaxes/mdy.tmLanguage.json`, a TextMate grammar
that shiki feeds to Monaco, and TextMate is not what CodeMirror wants. See the
open questions.

## What the webview costs

**Every read is an IPC call.** A build of the reference corpus reads 192 files;
at roughly 0.1–1 ms per Tauri round trip that is 50–200 ms of overhead on a
cold build. The ingest memo in [../src/mdy.js](../src/mdy.js) means a rebuild
re-reads but does not re-parse, so the recurring cost is smaller than the first.
If it bites, the answer is a batched read added to the provider contract — an
extension, not a workaround.

**No `worker_threads`.** Web Workers exist and each can hold its own WASM
instance, so the parallel-render idea survives; it is spelled differently.

**Memory.** The reference corpus peaked at 265–400 MB of heap under Node.
Comfortable on a desktop. It is the binding constraint on iOS, not here.

**No File System Access API in WebKit.** Irrelevant, because file access goes
through the shell on every platform anyway — which means one code path rather
than a Chromium one and a WebKit one.

## Phases

### Phase 0 — the browser bundle becomes a build target ✅

A checked-in browser build of `index.js`, and a test that renders a document
set through `memoryFsProvider` in headless WebKit. Playwright is already a dev
dependency and already has the WebKit binary.

The work is not proving it — that is done, see *What is already true* — but
making it a thing CI notices when it breaks. A stray static `import` of a Node
builtin is the failure mode this catches, and the lazy dynamic imports in
[../src/build.js](../src/build.js), [../src/serve.js](../src/serve.js) and
[../src/fs-provider.js](../src/fs-provider.js) exist because someone has hit it
before.

Exit: `npm run build:browser` emits a bundle plus its `.wasm` files, and a test
asserts it renders correctly under WebKit.

**Done.** [../scripts/build-browser.mjs](../scripts/build-browser.mjs) bundles
`index.js` to `dist/browser/` — 858 KB, node builtins external — and copies the
engines beside it; [../test/browser/render.test.js](../test/browser/render.test.js)
renders a two-root document set in WebKit and checks the artifact is complete.
`npm run build:browser` and `npm run test:browser`, the latter kept out of
`npm test` so the main suite still needs no browser.

Four things the implementation settled that the plan had left implicit:

- **esbuild was never a declared dependency.** It resolved from
  `node_modules` transitively and would have vanished on a clean install. Now
  in `devDependencies`, where anything a build step calls belongs.
- **The wasm copy fails loudly at build time.** This was an open question below
  — a missing `.wasm` fails at runtime, in a fetch, inside a webview. The build
  resolves each engine through the package graph rather than by hardcoded path
  and throws if a package that should carry one does not, so the failure moved
  to where it can be read.
- **`dist/browser/` needs no ignore rule.** `.gitignore`'s bare `dist` already
  covers it, which is why the output goes there rather than to `dist-browser/`.
- **The test has teeth, and that was checked rather than assumed.** Adding a
  static `import … from 'node:fs'` to [../src/compose.js](../src/compose.js)
  fails it; removing it passes. A browser test that cannot fail is worse than
  none, because it reads as coverage.

It also emits `manifest.json` next to the bundle — what ships and how big —
so a packaging step does not have to re-derive it.

### Phase 1 — the shell, `tauriFsProvider`, and serving

A Tauri app that opens a directory chooser, renders the site it is given, and
**serves** it into a preview that can be navigated like a website. No editing
yet, but the serving is not deferred: the app is a development environment, and
watching a change appear is the thing it is for.

Serving from memory is what [../src/serve.js](../src/serve.js) already does —
render to a `Map`, answer requests out of it, never touch `dist/`. The question
is where that `Map` lives when there is no HTTP server, and there are three
answers:

- **A Service Worker in the webview.** ❌ Ruled out, and cheaply. The model
  itself works — verified in WebKit, a served page and a real navigation to
  `/site/uruk/`, see *What is already true* — but not under Tauri's own origin.
  A shell that does nothing but call `navigator.serviceWorker.register`
  reported:

  ```
  origin: tauri://localhost
  result: REFUSED — TypeError: serviceWorker.register() must be called with a
          script URL whose protocol is either HTTP or HTTPS
  ```

  This is not a Tauri setting that can be changed. `use_https_scheme` in
  tauri-utils' config affects **Windows and Android only**; macOS and Linux
  always serve the app from `<scheme>://localhost`, and WKWebView will not
  register a worker on a custom scheme. Note the trap: under `tauri dev` the
  frontend is served from a localhost HTTP dev server, where registration
  *succeeds* — so this question cannot be answered in dev mode, only by
  running the built binary.
- **A custom protocol handler in Rust.** ✅ The route. Rust answers `mdy://`
  and the `<iframe>` navigates it normally, which is the one thing `srcdoc`
  cannot do. Two shapes, and the second is better than the plan first assumed:
  the webview can *push* every output over IPC after each build — simple, but
  about 4 MB per rebuild and the outputs then exist twice — or the handler can
  be asynchronous (`register_asynchronous_uri_scheme_protocol`) and ask the
  webview for one page at a time. A reader navigates to one page at a time, so
  that is roughly one round trip per navigation rather than 93 per rebuild, and
  the outputs stay in JavaScript where they were built.
- **`srcdoc` or a blob URL.** Simplest, and wrong: no navigation between pages,
  and relative URLs for `static/` assets have nothing to resolve against.

So the shell owns the protocol and the webview owns the outputs. Start with the
asynchronous handler; fall back to pushing the whole map only if per-request
latency proves worse than the copy.

Exit: the reference corpus opens in the app, produces the same 93 pages the CLI
does, and the preview can be navigated from the index to an article and back.

**Serving is done.** [../packages/mdy-app](../packages/mdy-app) registers
`mdy://` with an asynchronous handler that asks the webview per request, and a
link inside a served page reaches another served page — verified by the second
request arriving, since the preview is cross-origin from the shell and its DOM
is deliberately out of reach. What remains of this phase is `tauriFsProvider`
and rendering a real directory, which changes only where the outputs come from.

Two costs the plan had not accounted for, both cheap once known: `event.listen`
needs a capability (`core:default`), and the shell cannot inspect its own
preview — a live reload will have to be a `postMessage` or a reassigned `src`,
not a reach into the document.

### Phase 2 — editing

CodeMirror, the file list, save, and the optimistic-concurrency check `mdy-web`
already implements (send the mtime you loaded; a file that moved underneath
answers with the current state rather than being clobbered). Live preview on
the debounce, as `mdy-web` does it.

Exit: a document can be opened, edited, previewed and saved, and a save that
would clobber somebody else's is refused.

### Phase 3 — watching

`tauriFsProvider.watch` via the `fs-watch` plugin, wired to the same rebuild
path `mdy dev` uses. The progress display in [../src/progress.js](../src/progress.js)
already reports through hooks rather than a terminal, so an in-app progress
line is a different renderer over the same events, not new instrumentation.

Exit: editing a file in an external editor rebuilds the site in the app.

### Phase 4 — three platforms

Build, sign and notarise on macOS; AppImage or `.deb` on Linux; MSI or NSIS on
Windows. Tauri's updater plugin if updates are wanted.

This is also where Windows path handling finally has to exist. It does not
today — [../src/imports.js](../src/imports.js) does POSIX string maths on
purpose and says so — and no amount of packaging substitutes for writing it.
Doing it here rather than earlier is a choice about sequencing, not a claim
that the shell fixes it.

Exit: an installable artifact on each platform, with the reference corpus
building correctly on Windows.

### Phase 5 — the same shell on iOS

Tauri 2 targets iOS and Android from the same project. This is the phase
[site-plan.md](site-plan.md) was pointing at when it said the stack should
power "an iOS note-taking/query app", and it is the reason the webview route
was chosen over a sidecar.

Exit: the app opens a document set on a phone. Memory is the thing to watch.

## Open questions

- **The CodeMirror grammar.** The MDY grammar that exists is TextMate, written
  for VS Code and reused by shiki in Monaco. CodeMirror wants a Lezer grammar
  for real editing behaviour — folding, indentation, selection by node — or a
  hand-written stream mode for less. A third option is to keep shiki purely as
  a highlighter over decorations and accept that the editor does not understand
  the language it is showing. Deciding this decides how much of Phase 2 is
  editor work rather than shell work, and it is the largest unknown in the plan.

- **Where the `.wasm` files come from.** ✅ for this repo's own build — Phase 0
  copies them through the package graph and throws when one is absent. Still
  open for the *app*: whichever bundler the shell uses has to answer it again,
  and Vite answering it automatically is the reason
  `packages/mdy-live-preview` never had to.

- **What `$.emit` means in an app.** In a build it writes a file. In the
  delivery runtime it has nowhere to go, which
  [messaging-plan.md](messaging-plan.md) already lists as unresolved. An app
  has the same hole and makes it more pressing: a document that emits while you
  are editing it is either an error, a preview, or a write, and the three are
  not close together.

- **Whether the CLI shares the bundle.** `bin/mdy.js` could keep importing
  `src/` under Node, or could run the same browser bundle. Sharing means one
  artifact to test; not sharing means the CLI keeps `worker_threads` and real
  filesystem throughput. This does not have to be decided to start, but it
  should be decided before the two drift.

- **WebKitGTK version variance.** The system webview on Linux is whatever the
  distribution ships, and it varies more than the other two platforms combined.
  Worth establishing a minimum version early, from what the WASM engines and
  CodeMirror actually require, rather than discovering it from a bug report.

- **Whether the app builds or serves.** ✅ Settled: it serves. The app is a
  development environment and live updates are the point, so the whole site
  layer is in scope rather than only `openDocumentSet`. What remains is a
  performance question rather than a design one — a full render is 2.5 s on the
  reference corpus, so if that proves too slow to sit behind a keystroke, the
  answer is to render the edited document alone for the preview and the whole
  site on a debounce, not to serve less.
