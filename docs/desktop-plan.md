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

### Phase 0 — the browser bundle becomes a build target

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

### Phase 1 — the shell and `tauriFsProvider`

A Tauri app that opens a directory chooser, renders the site it is given, and
serves the result into the webview from memory. No editing yet.

Exit: the reference corpus opens in the app and produces the same 93 pages the
CLI does.

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

- **Where the `.wasm` files come from.** Vite emits them next to the bundle;
  esbuild does not, and the WebKit check above only worked once they were
  copied by hand. Whichever bundler the app uses, this is a step that has to be
  deliberate, and a missing `.wasm` fails at runtime rather than at build time.

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

- **Whether the app builds or serves.** Rendering the whole site on every
  keystroke is what `mdy dev` does and it is 2.5 s on the reference corpus.
  In an app, rendering only the document being edited — which
  `openDocumentSet` already supports without the site layer — may be the
  better loop, with a full build on demand. That is a product decision, and it
  changes how much of the site layer the app needs at all.
