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

**It also runs with no JavaScript runtime at all.** Phase 1b: mdy-docs' own
JavaScript in QuickJS, with lamassu and nisaba linked as C rather than loaded
as WebAssembly, building the same 93 pages the CLI produces — `diff -r` says
IDENTICAL — from a 2.0 MB binary that links no renderer and no node. The
substitution is two esbuild aliases and 260 lines of shim.

**Neither engine needs porting.** lamassu and nisaba contain zero platform
`#ifdef`s between them: lamassu is portable C, and nisaba's I/O is entirely
behind the four `bj_io` callbacks a host supplies. The whole platform-specific
surface of the native backend is 361 lines of our own host code. This is the
fact Phases 4 and 5 rest on, and it is why "five platforms" is a smaller
problem than it sounds.

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

## The backend is not a webview

The plan above put the whole application in a webview: the shell opens a
window, the browser bundle builds the site inside it. That was right about the
frontend and wrong about the backend, and the reference corpus is what proved
it — 139 articles reach page 45 and stop, the WebContent process pinned at
1146 MB, no CPU, no progress, no error.

The correction is a split, and it is the same split the repository already
makes by having two packages. **mdy-docs is a backend** — documents, queries,
rendering — and needs a JavaScript runtime, not a renderer. **mdy-web is a
frontend** — an editor, a preview — and is a web application, wherever it is
hosted. Running the build inside the process that draws the UI put a build tool
on a memory budget sized for a web page.

### Which runtime, measured

The same ingest over the reference corpus — 189 sources, 10 MB of text: parse
front matter and ```data fences, extract hashtags, compile every `%` line, then
run the MDY front end over forty bodies. Identical output from all three (189
documents, 3255 nodes), so this is the same work three ways.

| | total | peak RSS | shipped size |
| --- | --- | --- | --- |
| Node (V8) | **2.2 s** | 362 MB | ~110 MB |
| JavaScriptCore | 3.0 s | **530 MB** | 0 on macOS (system framework) |
| QuickJS | 17.2 s | **131 MB** | ~1–3 MB |

Two things fall out of that table, and the second is the one that decides.

**Yes, there are JIT runtimes to embed.** V8 through `deno_core`/`rusty_v8`,
and JavaScriptCore, which on macOS is a system framework — free, JIT, with
WebAssembly, and reachable without a webview at all. On Linux it is
libjavascriptcoregtk; on Windows there is no system JSC and V8 is the answer.

**But the JIT is where the memory went.** JavaScriptCore standalone, doing only
the ingest, peaks at 530 MB — four times QuickJS. That reframes the 1146 MB
wall: it is not mainly a `WebContent` budget being stingy, it is what this
workload costs in JSC. Embedding JSC directly would remove the cap and let it
use the gigabyte, which is not the same as fixing it.

So the trade is real and it is not the usual one. QuickJS is **8× slower and
uses a third of the memory of V8, a quarter of JSC's**. For a tool whose
failure mode has been running out of memory, that is the right side of the
trade — and it comes with a ~1–3 MB runtime instead of ~110 MB.

### What QuickJS costs, and what it does not

It runs everything. Verified, not assumed: micromark, remark, unified, hast,
rehype-stringify, yaml, lowlight and linkify all work unmodified, as do the MDY
front end, front matter, ```data fences, hashtags and the `%`-line compiler.
The only shim needed was `structuredClone`, and two of its four uses are ours.

What it cannot do is WebAssembly — which is why this design wants the engines
native rather than as WASM. lamassu, nisaba and baru-re are all C with working
native builds already, so this is a binding exercise rather than a port, and
native should beat the WASM they replace. The one thing that must be replaced
is emscripten's wrapper: the first attempt failed on
`await import("node:module")` inside `lamassu.mjs`, which is the glue, not the
engine.

That prediction held. It also has one consequence this section did not
anticipate: **`$.resize` cannot work on the native backend at all**, because
its image codecs are WebAssembly and there is no engine underneath them.
mdy-docs now says so at the point it is true. See the open questions.

The honest caveat: 8× applies to the JavaScript layer only, and it was measured
on the ingest phase. **The whole-build number turned out to depend entirely on
what the site is** — see Phase 1b for both measurements. A template-heavy set
is a wash, because that work is lamassu's and native lamassu gains back what
QuickJS gives up. A prose-heavy one is 5.9× slower, because that work is
micromark, remark, hast and the MDY front end, and all of it is JavaScript.

The hottest component is the one this estimate already named — the MDY front
end at 8.8×, our own 4,441 lines producing hast directly — and a profile of a
native corpus build has now confirmed it rather than merely predicted it. See
Phase 6.

## Architecture — one frontend, two backends, one protocol

The original shape here was "the browser bundle runs in a webview". Phase 1b
changed that: on every platform with a filesystem, the build now happens in a
native binary and the webview is only a window. The web has no such binary and
never will, so there are two backends — and the whole point of the design is
that there are two rather than five.

| target  | backend                    | shell                  |
| ------- | -------------------------- | ---------------------- |
| web     | WASM engines in a Worker   | browser                |
| macOS   | native C                   | Tauri / WKWebView      |
| Linux   | native C                   | Tauri / WebKitGTK      |
| Windows | native C                   | Tauri / WebView2       |
| iOS     | native C, as a static lib  | Tauri iOS / WKWebView  |

**The seam already exists**, which is why this is tractable. It is two esbuild
aliases: `@mdy-docs/lamassu-js` and `@mdy-docs/nisaba-db` resolve to the real
WASM packages for a browser bundle and to
[../packages/mdy-native/shims/](../packages/mdy-native/shims/) for a native
one. Everything above them — the parser, the document engine, the query
engine, the site layer — is one codebase compiled twice, and the 776 tests
cover the shared part. The same is true one layer down: file access has gone
through the nine-method provider in [../src/fs-provider.js](../src/fs-provider.js)
since long before any of this, and there are now five implementations of it
(node, memory, OPFS, Tauri, native C) with nothing above them aware of which
is present.

**A new platform is a new host, not a new port.** The 361 lines that know what
platform they are on are all ours —
[fsx.c](../packages/mdy-native/src/fsx.c) and
[nis.c](../packages/mdy-native/src/nis.c) — and they sit in exactly the places
both engines left for them: nisaba's `bj_io` callbacks, and the filesystem the
site layer has always taken as an argument. Adding Windows means writing a
second version of those two files, not touching anything above or below.

**What is missing is the protocol.** The frontend and the backend currently
talk in whatever shape each phase needed — mdy-app asks the webview for pages
through a Tauri event round trip, because in Phase 1 the webview held them.
That has to become one narrow interface, specified once and implemented twice:

```
open(root)                 → session
build()                    → { pages, messages }
outputs(path)              → bytes | null
list/read/write/remove/…   → the fs-provider nine
watch()                    → change events
```

Native, that is Tauri commands over the QuickJS host. On the web, it is a
Worker holding the WASM bundle. Above it, the editor, the file tree and the
preview are written once for five targets. See Phase 1c.

**The preview is the same iframe both ways, served differently.** Natively it
is a custom protocol, which Phase 1 already proved. On the web it is a Service
Worker — and the earlier "Service Workers are refused" finding needs reading
precisely: the refusal is specific to a custom scheme like `tauri://localhost`,
and on a real https origin registration is fine. Two implementations of "answer
a request for an output path", one consumer.

**The shell** stays [Tauri](https://tauri.app) 2.x on all four native targets:
a Rust host that opens a window on the system webview — WKWebView on macOS and
iOS, WebKitGTK on Linux, WebView2 on Windows — and exposes capabilities to it.
The earlier reason to doubt it was the webview memory ceiling, and that concern
dissolved when the build moved out of the webview.

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

Written when the webview was going to do the building. Most of it no longer
applies, and saying which is the useful part.

**Every read is an IPC call** — obsolete natively. The build reads files
through C now, not through Tauri. It is still true on the web, where the
backend is a Worker, and there the answer is unchanged: a batched read added to
the provider contract, an extension rather than a workaround.

**No `worker_threads`** — still true in both backends, and still fine. Web
Workers exist on the web; natively the host owns its own threads if it ever
wants them. The parallel-render idea survives in both, spelled differently.

**Memory** — the constraint that drove Phase 1b, and it is worth restating with
the measurement rather than the estimate. In the webview the reference corpus
died at page 45 against a 1146 MB ceiling. The native backend finishes all 93
at 593 MB peak, against node's 816 MB. Comfortable on a desktop. **Still the
binding constraint on iOS**, where 593 MB would be killed — see Phase 5.

**No File System Access API in WebKit** — irrelevant, and now doubly so. File
access goes through the provider on every platform, and natively it does not
touch the webview at all.

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

**The provider is done, and so is serving.**
[../packages/mdy-app/web/tauri-fs-provider.js](../packages/mdy-app/web/tauri-fs-provider.js)
implements the nine methods over Tauri's `fs` plugin, and the app renders a real
directory with the unmodified site layer: `examples/blog`, 16 files in, **16
pages in 399 ms**, served over `mdy://` with `static/` passing through — page,
stylesheet and script all 200.

Three things this phase turned up, none of them predicted:

- **`static/` is not in `outputs`.** renderSite returns what documents made;
  every root's `static/` is a passthrough that `buildSite` copies and
  `serveSite` reads from disk. A preview without it is a site with no
  stylesheet, so the app does what serveSite does — outputs first, then each
  root's `static/`, its own before anything it imports.
- **The image codecs were never shipped.** `src/images.js` imports @jsquash at
  module scope, so it is in every browser bundle whether or not a site calls
  `$.resize` — and Phase 0's build copied only the two engines. Worse than a
  missing file: Tauri answers unknown paths with index.html, so the fetch
  returned **200 and some HTML**, and the failure surfaced much later as
  `WebAssembly.Module doesn't parse at byte 0`. Fixed at the source, and the
  browser test now names the codecs.
- **Timers do not fire during a render.** The VM holds the event loop, so a
  `setInterval` heartbeat stops and a `setTimeout` watchdog never lands. That
  is why `src/progress.js` paints from the hooks and keeps its ticker only as a
  fallback — a decision made for Node that turns out to be load-bearing here.

**The reference corpus does not render in the webview yet.** 139 articles reach
about 40 pages and then stop, with the WebContent process at 1.1 GB and idle —
against 265–400 MB for the same build under Node. Small sites are fine; this
is a memory ceiling to investigate rather than a bug in the wiring, and it is
the same constraint the plan already expected to meet on iOS, arriving earlier
than expected.

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

### Phase 1b — the backend as a native binary ✅

A host embedding QuickJS, with lamassu and nisaba linked as C rather than
loaded as WebAssembly, running mdy-docs' own JavaScript. No renderer, no
webview, no ceiling. `structuredClone` is the one shim; the emscripten
wrappers are the one thing that must be replaced.

This supersedes the webview for BUILDING. Phases 2 and 3 — the editor, and
watching — remain a web frontend, which is what mdy-web already is; what
changes is that it talks to a backend instead of being one.

Exit: the reference corpus builds to the same 93 pages the CLI produces,
outside a browser, in a binary that does not link a renderer.

**Done. The exit criterion is met.** The reference corpus builds to the same 93
pages the CLI produces, outside a browser, in a 2 MB binary that links no
renderer — and `diff -r` against the CLI's output says IDENTICAL. So do
`examples/docs-site` (guest `import()` included) and `examples/messaging`.

Nothing in mdy-docs was forked to get there. The substitution is two esbuild
aliases; the three shims behind them are 260 lines together. `buildSite` now
writes through the fs provider rather than node:fs, so the native backend runs
the CLI's own build function instead of a copy of it.

**What it costs, on two workloads, because one number would mislead:**

|                                 | node   | native | ratio        |
| ------------------------------- | ------ | ------ | ------------ |
| reference corpus, 93 pages      | 10.6 s | 62.5 s | 5.9× slower  |
| peak RSS                        | 816 MB | 593 MB | 1.4× smaller |
| 200 templates (`make bench`)    | 305 ms | 297 ms | a wash       |
| peak RSS                        | 139 MB | 19 MB  | 7.3× smaller |
| runtime on disk                 | ~110 MB (node) | 2.0 MB | 55× smaller |

The spread between those rows is the whole finding. QuickJS has no JIT and runs
mdy-docs' JavaScript several times slower than V8; lamassu is now C rather than
WebAssembly and is faster. Which wins depends on the site. A template-heavy set
is lamassu's work and the two cancel exactly. The corpus is 145 files of
long-form prose — micromark, remark, hast, the MDY front end, JavaScript all of
it — and there QuickJS's cost shows undiluted. A `sample` of the running build
is unambiguous: every frame is `JS_CallInternal`, `js_array_flatten`,
`js_array_every`, generators. No native call appears at all.

So: **prose-heavy sites are slower here, template-heavy sites are not, and both
use a fraction of the memory.** The 8× estimate above was right about the
JavaScript layer and wrong to be read as a whole-build number in either
direction.

Memory is what this was for, and it holds on both. The webview died at page 45
of this corpus against a 1146 MB ceiling; this finishes all 93, in less space
than node, with nothing above it.

If the corpus number ever needs to come down, the profile names the target and
it is the one this document already named: the MDY front end, 4,441 lines of
our own producing hast directly, measured at 8.8×. Porting that one component
to C would not cost rehype — markdown still arrives through remark.

**The filesystem and guest `import` are both shipped.** The provider is five
POSIX calls in C behind the nine-method contract in
[../src/fs-provider.js](../src/fs-provider.js); `watch` is deliberately absent,
since a native recursive watcher is kqueue, inotify and
`ReadDirectoryChangesW` — three implementations, and Phase 3's work. Guest
`import` is `js_set_module_loader` routed out to mdy-docs' own loader, which
still reads through the provider and still enforces the package boundary.

**`$.resize` cannot work on this backend.** Its image codecs are WebAssembly,
and QuickJS has none. mdy-docs now says so at the point it is true rather than
failing as a missing `node:fs` and then again as a null tree.

**The bridge and async host calls are done.**
[../packages/mdy-native](../packages/mdy-native) links QuickJS and lamassu in
one 1.8 MB binary, and a lamassu program calls out to a function implemented in
QuickJS — which is what every `$` becomes. The async contract holds without
touching mdy-docs or the language: the native pumps QuickJS's job queue until
the promise settles and returns synchronously, so `$.find(q)` still returns
documents. Re-entrant `$.render` works, because the inner run takes its own VM
exactly as the pool does. A promise that cannot settle is reported rather than
hung on.

**nisaba runs natively too.** All of its C compiles with `cc` unchanged — the
`*_wasm.c` files included, since `EMSCRIPTEN_KEEPALIVE` is a no-op off-target
and one of them holds the regex entry points rather than mere exports. Only
`db_wasm.c` is genuinely the WASM export layer, and a native host is what
replaces it. Insert and query both work against the filter shape
`$.find({ path: … })` produces.

Its storage is the interesting part. The shipped `bjio_host(fd)` reaches into
`Module.bjioHandles`, a table of JS `FileSystemSyncAccessHandle` objects — the
browser's storage, bridged through emscripten, unreachable natively. But
`bj_io` is four callbacks, so a native host writes its own; what the JS side
calls `MemoryStorageProvider` becomes a file, which is what nisaba's on-disk
B+tree format is for anyway. And `_id` has to be minted by the host, which is
the same rule met from the other side earlier in this repository's history.

Two integration costs worth knowing before starting: lamassu and QuickJS share
the `js_` namespace and collide both in headers (`JS_TAG_STRING` is a macro in
one and an enum member in the other) and in symbols (both define `js_dtoa`), so
each engine is wrapped in its own translation unit and the archives are
pre-linked with the internal symbol localised.

### Phase 1c — one protocol, two backends

The piece that decides whether the next three phases are written once or five
times, so it comes before them.

Today the frontend and the backend talk in whatever shape each phase needed.
mdy-app asks the *webview* for pages through a Tauri event round trip, because
in Phase 1 the webview held them; mdy-native has no frontend at all and takes a
directory on argv. Neither is the interface, and writing the editor against
either would bake in the wrong one.

Specify it once — narrow, and shaped like what a document set actually is:

```
open(root)                 → session
build()                    → { pages, messages }
outputs(path)              → bytes | null
list/read/write/remove/…   → the fs-provider nine
watch()                    → change events
```

Then implement it twice. **Natively** it is Tauri commands into the QuickJS
host; `site-entry.mjs` becomes a long-lived session rather than a one-shot
build, which is mostly a matter of keeping the document set open between
requests instead of dropping it. **On the web** it is a Worker holding the
browser bundle, which Phase 0 already produces.

The preview is part of this and is the same iframe both ways: a custom protocol
natively (Phase 1 proved it), a Service Worker on the web. The Phase 1 finding
that Service Workers are refused reads precisely — the refusal is specific to a
custom scheme like `tauri://localhost`. On a real https origin, registration is
fine.

Getting this right is what makes Phases 2 and 3 one implementation for five
targets. Getting it wrong is how the web build and the desktop build become two
applications that happen to share a renderer.

Exit: the same frontend code opens a document set, builds it and serves its
preview, against both backends, with nothing above the protocol knowing which.

### Phase 2 — editing

CodeMirror, the file list, save, and the optimistic-concurrency check `mdy-web`
already implements (send the mtime you loaded; a file that moved underneath
answers with the current state rather than being clobbered). Live preview on
the debounce, as `mdy-web` does it.

Written against Phase 1c's protocol, so this is one implementation for five
targets rather than a desktop editor and a web editor that drift.

Exit: a document can be opened, edited, previewed and saved — in a browser and
in the app, from the same code — and a save that would clobber somebody else's
is refused.

### Phase 3 — watching

The rebuild path `mdy dev` already uses, driven by whichever `watch` the
protocol is sitting on. The progress display in [../src/progress.js](../src/progress.js)
already reports through hooks rather than a terminal, so an in-app progress
line is a different renderer over the same events, not new instrumentation.

Two implementations again, and this is the one place the native side is
*behind* the others. `tauriFsProvider.watch` exists (the `fs-watch` plugin);
`nativeFsProvider` has no `watch` at all, deliberately — it is optional at
every call site, and a native recursive watcher is kqueue on macOS, inotify on
Linux and `ReadDirectoryChangesW` on Windows. Three implementations, and this
is where they belong. On the web there is nothing to watch: the editor knows
what it changed.

Exit: editing a file in an external editor rebuilds the site in the app, on all
four native targets.

### Phase 4 — Linux and Windows ✅ (the backend; packaging remains)

Two jobs that used to be one: making the native backend *compile and behave*
elsewhere, and making an installable artifact. The first is the real work and
it is smaller than it looks.

**Nothing in either engine needs porting.** lamassu and nisaba contain zero
platform `#ifdef`s between them — lamassu is portable C, nisaba's I/O is behind
the four `bj_io` callbacks the host supplies. The entire platform-specific
surface is 361 lines of our own: [fsx.c](../packages/mdy-native/src/fsx.c) and
[nis.c](../packages/mdy-native/src/nis.c).

**It builds on all three, the output is byte-identical, and mdy-docs' own test
suite passes on every one.** ✅

```
success  macOS      success  Linux      success  Windows
  all 17 checks passed
  # native: 684 passed, 0 failed, 1 skipped
  fixture: identical to golden
  fixture-pkg: identical to golden
  messaging: identical to golden
```

Windows through MSYS2/mingw-w64, a 7.7 MB `mdy-native.exe`. The four blockers
below are done; what remains in this phase is packaging, not portability.

1. **QuickJS is a submodule**, built from its five core sources rather than
   linked from Homebrew. `quickjs-libc` is deliberately excluded — it is the
   `std`/`os` module layer, this host supplies its own natives, and leaving it
   out leaves out most of what would have needed porting. `gnu11` rather than
   `c11`, because `quickjs.c` uses `asm volatile` in its spin hint.
2. **`js_dtoa` is `static`** in lamassu as of 52f0bfd, so the archives link
   directly and the ld64-only `ld -r -all_load -unexported_symbol` pre-link is
   gone. Worth recording how small that turned out to be: comparing the two
   archives' symbol tables — 181 exports against 273 — `js_dtoa` was the *only*
   name they had in common, so one word was the whole fix rather than the first
   of a series.
3. **Two regex engines, which the old build was papering over.** This was not
   on the list and is the more serious of the two symbol problems. nisaba
   vendors `mdy-docs/regex-engine`; lamassu has moved to `mdy-docs/baru-re`,
   its successor — same ancestry, *different version*. Neither prefixes its
   symbols and four names collide. The old build pre-linked lamassu into one
   relocatable object, which loads every symbol unconditionally, so nisaba's
   `regexp.o` was never pulled at all and any call it made to one of those four
   resolved to **lamassu's differently versioned implementation**. Silent, and
   the wrong kind of wrong.

   They are renamed at compile time for now, which keeps each engine's calls
   inside its own engine and fails loudly if the overlap ever grows. **The real
   fix is for nisaba to use baru-re too**, so there is one regex engine in the
   binary instead of two — an API migration (baru-re 0.5.0 lets the embedder
   supply the allocator) and a task of its own.
4. **The Win32 branch.** `FindFirstFileW` for the walk, `OVERLAPPED` for
   `pread`/`pwrite`, `SetEndOfFile` for `ftruncate`,
   `FILE_FLAG_DELETE_ON_CLOSE` for the collection's backing file — which is the
   same self-deleting lifetime `mkstemp` + `unlink` gives on POSIX.

   Two decisions inside it worth keeping. **Every path crosses this boundary as
   UTF-8 and every Win32 call is the wide variant**: the narrow entry points go
   through the process code page, which cannot spell most of what the reference
   corpus is named. And **`/` stays the separator everywhere**, because Win32
   accepts it in every path it is given — so the one place a backslash can
   enter the system is `fsx_cwd`, where the OS hands one back, and it is
   translated there rather than in the twenty places it would otherwise
   surface.

**MSYS2/mingw-w64, not MSVC**, and the reason is upstream rather than
preference: Bellard's QuickJS does not build under MSVC at all, while its
Makefile has an `MSYSTEM` branch — mingw is a configuration its authors
support. Getting MSVC would mean switching to the `quickjs-ng` fork, which is a
larger decision than a build system should make on its own. It is the obvious
fallback if mingw proves unworkable, and `quickjs-ng` would also bring CMake
and its own iOS/Android CI.

**CMake is deferred**, not dropped. The Makefile reaches mingw through MSYS2,
which is enough for Phase 4; Phase 5 needs Xcode and that is where it becomes
unavoidable.

**The path semantics held.** This was the predicted risk —
[../src/imports.js](../src/imports.js) decides a module is inside its package
by *string prefix* on an absolute path, and drive letters, backslashes and a
case-insensitive filesystem all bear on that. `golden/fixture-pkg` exists to
test exactly it: a site importing a package whose layouts and JS modules
resolve against that package's directory rather than its own. It comes out
byte-identical on Windows.

What made that work is keeping `/` as the separator everywhere and translating
the one backslash the OS hands back, so nothing above the host ever sees a
Windows-shaped path. The drive letter is handled in two places and both were
found by reasoning rather than by CI: `fsx.c`'s path join, where an absolute
`rel` under a root of `/` would otherwise produce `/C:/Users/…`, and
`site-entry.mjs`, where `C:/work` would otherwise be treated as relative and
get the cwd prepended.

Not yet exercised: case-insensitivity (two spellings of one file becoming two
documents, since `path` is a natural key in nisaba) and `\\?\` long paths.
Both remain open questions.

**Five things CI found that reasoning had not.** The last two came from
porting the test suite, and only Windows could have found them.

- **glibc hides POSIX declarations under `-std=c11`** — `strdup` came back as
  an implicit declaration and `st_mtim` as an unknown field. Both compile on
  macOS, which exposes them regardless, so this was invisible on the
  development machine. `gnu11` now, which also suits mingw.
- **`npm install` runs node-gyp and fails on Windows** for want of Visual
  Studio: `@mdy-docs/nisaba-db` → `node-opfs` → `fs-ext` has a `binding.gyp`.
  Worth flagging against this document's own first stated fact — "nothing in
  the tree is native" — which was true when written and is not now. Nothing on
  the native path uses it, so CI installs with `--ignore-scripts`.
- **Line endings are build output.** `static/` is a verbatim passthrough, so a
  stylesheet checked out with CRLF is a stylesheet emitted with CRLF, and
  Windows runners default to `core.autocrlf=true`. `.gitattributes` marks
  everything whose bytes reach the output, and the output itself, as `-text`.
- **A timer that is not due yet is not "nothing left to run".** Windows' clock
  has ~15.6 ms granularity and `Sleep` can return early, so the host's event
  loop would wake from a 10 ms timer with the clock reading the same tick, fire
  nothing, and report a promise as unsettleable. A timer existing means
  progress is guaranteed, so waiting *is* progress. macOS's finer clock hid
  this completely.
- **`/C:/…` is a drive path with a spurious leading slash** — and this is the
  open question above arriving as a concrete failure. mdy-docs says "this path
  is absolute" by passing it as `fs.read('/', absolutePath)`, and
  `nodeFsProvider` joins the two before reaching the filesystem; on Windows
  that produces `/D:/…`, which names nothing, and every guest `import` failed.
  Node's own win32 `join` produces the same thing — it is not a case it was
  built for. Stripping leading slashes before a drive letter is the same rule
  `fileURLToPath` applies to `file:///C:/x`.

Then packaging: sign and notarise on macOS; AppImage or `.deb` on Linux; MSI or
NSIS on Windows. Tauri's updater plugin if updates are wanted. And a real icon
set — `packages/mdy-app/src-tauri/icons/icon.png` is a generated placeholder
that exists only because `generate_context!()` will not link without one.

CI on all three — [.github/workflows/native.yml](../.github/workflows/native.yml)
— running `make native` (17 checks, non-zero exit) and then `make check-golden`,
which builds three sites natively and compares them byte for byte against
committed output. That comparison is the real regression test: it catches a
path bug that produces *different* pages rather than an error, which would pass
every other check in the job.

The reference is **committed** rather than produced by running the node CLI
alongside. The node path loads the engines through WebAssembly, and
`lamassu.wasm`/`nisaba.wasm` are emscripten build products that are not in git
— so on a Windows runner there would be nothing to compare against, and
requiring an emscripten toolchain on three platforms to answer a question about
C is the wrong trade. A fixed reference is also the stronger check: output that
changes shows up as a diff in a pull request rather than two sides moving
together and agreeing.

`make check-determinism` runs first and proves each golden site is stable
across an mtime change, because a golden site whose output moves goes red for
something that is not a regression. `examples/docs-site` is not one of them for
exactly that reason — it renders `formatDate(p.raw.mtime)`, and a git checkout
sets mtimes to checkout time.

`fail-fast: false`, so a Windows failure cannot hide a Linux one.

**mdy-docs' own tests run against the native backend too** — 684 of the 776, on
all three platforms, from the same files `npm test` uses rather than a copy or
a rewrite. Only what `node:test`, `node:assert`, `node:fs` and friends resolve
to changes; see [../packages/mdy-native/tests-entry.mjs](../packages/mdy-native/tests-entry.mjs).
That is the strongest evidence for the claim this whole phase rests on, which
is that the backend runs mdy-docs *unchanged*.

The 91 that do not run are properties of the runtime, not gaps in the port: a
subprocess (`cli.test.js`), a `node:http` server (`serve.test.js`), OPFS, a
browser DOM, and WebAssembly for the image codecs — plus `build.test.js`, which
builds `examples/blog` at module top level and that example calls `$.resize`.

Porting the suite paid for itself four times over, and each is recorded in that
package's README: a collection with no lifetime (fixed with a GC finalizer, the
same lifetime the WASM binding gets), a rejected host call wrapped rather than
propagated (which buried a cyclic-render error under a dozen copies of its own
prefix), no `setTimeout` at all, and one test coupled to V8's exact wording of
a `ReferenceError`.

Still not in any workflow: running the suite through **WebAssembly**, which is
what `npm test` does locally. That needs an emscripten toolchain and is a
workflow of its own.

Exit: an installable artifact on each platform, and the reference corpus
building byte-identically on all three.

### Phase 5 — iOS

Tauri 2 targets iOS from the same project. This is the phase
[site-plan.md](site-plan.md) was pointing at when it said the stack should
power "an iOS note-taking/query app", and it is the reason the webview route
was chosen over a sidecar.

**Why this route exists at all**, and it is worth stating because it is the
whole justification for QuickJS over a faster engine: QuickJS is a pure
interpreter. It needs no W^X-violating JIT pages, which is exactly what makes
an embedded JavaScript engine shippable on iOS. Anything V8-based cannot go
outside a webview there. The 5.9× we pay on prose is the price of a target that
is otherwise closed.

Two small pieces of work and one real one.

Small: the backend becomes a **static library** rather than a binary — `main()`
becomes `mdy_open`/`mdy_build`, which is an afternoon. And `/tmp` is hardcoded
in [nis.c](../packages/mdy-native/src/nis.c) for the collection's backing file;
on iOS that must be the app sandbox's temp directory.

Real: **memory**. 593 MB peak on the reference corpus gets a process killed on
a phone, and no amount of porting changes that — it is a property of holding
every document's hast tree at once. This is the one place where the answer is
architectural rather than mechanical, and Phase 6 is where it lives.

Exit: the app opens a document set on a phone, and builds one sized to it.

### Phase 6 — where the time and the memory go

Two items, both measured rather than guessed, and both paying across every
target at once. Sequenced last because nothing is blocked on them — but the
iOS memory ceiling makes the first one a prerequisite for Phase 5 rather than a
nicety.

**Persist the collection.** [nis.c](../packages/mdy-native/src/nis.c) opens an
unlinked temp file, so the whole document set is ingested from scratch on every
cold start. Making it a real file keyed by mtime is the on-disk version of the
ingest memo [../src/mdy.js](../src/mdy.js) already keeps in RAM, and it turns a
cold start into an incremental one. It also caps peak memory, which is the iOS
blocker: a set that lives in a B+tree does not have to live in the heap.

The precedent is encouraging. Making `createIndex` real — it was a no-op until
Phase 1b closed — took the corpus from 68.4 s to 62.5 s and **system time from
9.1 s to 1.7 s**, because several hundred full scans per build stopped walking
the collection file.

**The MDY front end in C.** The one component where a port pays on all five
targets simultaneously: native on four, WASM on the web. This document has
named it twice as a hypothesis and the profile has now confirmed it — 4,441
lines of our own producing hast directly, measured at 8.8×, and `sample` on a
native corpus build shows every frame in `JS_CallInternal`,
`js_array_flatten`, `js_array_every` and generators, with no native call
appearing at all. That is where the 60 seconds are.

It would not cost rehype. Markdown still arrives through remark; what moves is
our own parser, which already produces hast and would keep producing it.

This is also the honest answer to "is QuickJS fast enough". On template-heavy
sites it already is — native lamassu pays for it exactly. On prose it is not,
and the fix is not a faster JavaScript engine, because the JavaScript is ours.

Exit: a cold corpus build reuses the previous ingest, and peak memory is a
function of the working set rather than the corpus.

## Open questions

- **The CodeMirror grammar.** The MDY grammar that exists is TextMate, written
  for VS Code and reused by shiki in Monaco. CodeMirror wants a Lezer grammar
  for real editing behaviour — folding, indentation, selection by node — or a
  hand-written stream mode for less. A third option is to keep shiki purely as
  a highlighter over decorations and accept that the editor does not understand
  the language it is showing. Deciding this decides how much of Phase 2 is
  editor work rather than shell work, and it is the largest unknown on the
  frontend side — as Windows path semantics is on the backend side.

- **Where the `.wasm` files come from.** ✅ for this repo's own build — Phase 0
  copies them through the package graph and throws when one is absent. Now a
  *web-only* question: the native backend has no `.wasm` at all. Whichever
  bundler the web frontend uses has to answer it again, and Vite answering it
  automatically is the reason `packages/mdy-live-preview` never had to.

- **What Windows paths mean.** The largest unknown on the backend side, and it
  is semantic rather than mechanical — see Phase 4. `imports.js` compares absolute paths by
  string prefix to enforce the package boundary, and `path` is a natural key in
  nisaba. Drive letters, backslashes, case-insensitivity and `\\?\` long paths
  all bear on both. Deciding this is a spike, not a port.

- **What `$.emit` means in an app.** In a build it writes a file. In the
  delivery runtime it has nowhere to go, which
  [messaging-plan.md](messaging-plan.md) already lists as unresolved. An app
  has the same hole and makes it more pressing: a document that emits while you
  are editing it is either an error, a preview, or a write, and the three are
  not close together.

- **Whether the CLI shares an artifact.** There are now three ways to run
  mdy-docs: `bin/mdy.js` importing `src/` under node, the browser bundle, and
  the native binary. The last two are the same source through two esbuild
  configurations, so they cannot drift; the CLI can. Folding it onto the native
  backend would make `mdy build` a 2 MB binary with no node at all — attractive,
  and it costs `worker_threads` and V8's speed on prose, which is the same
  trade Phase 6 is about. Not urgent, but it should be a decision rather than
  an accident.

- **`$.resize` on the native backend.** It cannot work: the codecs are
  WebAssembly and QuickJS has none. mdy-docs now says so where it is true, and
  `examples/blog` is the one example the native binary will not build. Three
  ways out — link a C codec (lodepng plus a resampler, which is the shape the
  rest of the stack already takes), shell out to the platform's imaging
  library, or declare resize a build-time concern that belongs to the CLI. Not
  urgent; it does become a real gap the day the app is meant to replace the
  CLI.

- **WebKitGTK version variance.** The system webview on Linux is whatever the
  distribution ships, and it varies more than the other two platforms combined.
  Worth establishing a minimum version early, from what the WASM engines and
  CodeMirror actually require, rather than discovering it from a bug report.

- **Whether the app builds or serves.** ✅ Settled: it serves. The app is a
  development environment and live updates are the point, so the whole site
  layer is in scope rather than only `openDocumentSet`. What remains is a
  performance question rather than a design one, and Phase 1b sharpened it: a
  full native build of the reference corpus is 62.5 s, which is far too slow to
  sit behind a keystroke. The answer is unchanged in shape — render the edited
  document alone for the preview and the whole site on a debounce — but the
  margin is thinner than it looked, and Phase 6's persistent collection is what
  makes an incremental rebuild the common case rather than the lucky one.
