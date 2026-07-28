# edubba — implementation plan

> An *edubba* ("tablet house") was the Sumerian scribal school: the place
> where documents were stored, copied, and taught. This one builds websites
> out of them.

A static site generator built on [mdy-docs](https://github.com/mdy-docs/mdy-docs)
— in the family of Hugo / Jekyll / Eleventy — whose first target is a
**personal blog**. But the design brief is wider: mdy is a data-driven
document system, and the same stack should power a notes app, a single-page
wiki, an iOS note-taking/query app, or a macOS reporting app. edubba is one
*consumer* of that stack, not its ceiling.

## Why mdy makes this easy

Most of an SSG's hard machinery already exists in mdy-docs as primitives —
often stronger than the incumbents' equivalents:

| SSG concept | mdy equivalent | Notes |
| --- | --- | --- |
| Content files (front matter + markdown) | `.mdy` documents (`+++` front matter, ```` ```data ```` fences, inline `#hashtags`) | hashtags give tag taxonomy for free |
| Collections / `where` clauses / taxonomies | `$.find()` against a nisaba collection | real MongoDB operators, secondary/geo/text indexes — not a template DSL |
| Layouts / partials | documents selected by query: `$.render({ layout: 'post' }, page)` | already the document-set pattern |
| Theme code runs with full host access (Hugo/11ty) | templates run sandboxed in the lamassu VM | **differentiator**: themes are safe to install |
| Dev server / watch | mdy `--watch`; the browser playground proves the whole stack runs client-side | **differentiator**: in-browser live editing is possible |

What's genuinely new is a thin orchestration layer: walk a content directory
into one document set, route pages through layout documents, compute URLs,
write files.

## Architecture: three layers

```
┌──────────────────────────────────────────────┐
│ edubba (this repo) — the Hugo-shaped part    │  config, layout routing, URLs,
│   build / serve / new commands               │  emitters (HTML, RSS, sitemap)
├──────────────────────────────────────────────┤
│ vault — "a directory of mdy files as a       │  file walk, per-doc identity,
│   living document set"                       │  computed fields, incremental
├──────────────────────────────────────────────┤  updates on change
│ mdy-docs — documents, templates, $.find,     │
│   lamassu VM (sandbox), nisaba (queries)     │
└──────────────────────────────────────────────┘
```

The **vault layer is the reusable one** — "directory of documents →
queryable set" is exactly what the notes app, wiki, and iOS app need too.
Same API, different nisaba storage provider (SSG: `MemoryStorageProvider`
per build; notes app: `NodeFSStorageProvider` / OPFS, persistent). It starts
life inside this repo and gets extracted the day a second consumer exists.

## Repo & dependency wiring

Same pattern as mdy-docs ↔ its engines: **mdy-docs is a git submodule**
(`third_party/mdy-docs`) consumed strictly through its npm package boundary
(`"mdy-docs": "file:third_party/mdy-docs"`), so every import is identical to
a future published package and the swap to npm is a one-line change. The
submodule chain is recursive (mdy-docs → lamassu-js, nisaba-db → binjson…);
setup is:

```sh
git clone --recurse-submodules https://github.com/mdy-docs/edubba.git
make -C third_party/mdy-docs/third_party/lamassu-js pkg      # needs Emscripten
third_party/mdy-docs/third_party/nisaba-db/wasm/build-wasm.sh
npm install
```

## Site conventions (v1 blog)

```
my-blog/
  site.yaml              # title, baseURL, author, params → injected as `site`
  content/
    posts/2026-07-hello.mdy
    about.mdy
  layouts/
    base.mdy             # HTML shell (mdy templates are text templates —
    post.mdy             #   emitting HTML instead of markdown is free)
    list.mdy
  static/style.css       # passthrough copy → dist/
```

A post:

```
title: Hello world
date: 2026-07-18
+++
First post, mostly about #wasm and #writing.
```

A list layout (layouts are just documents in the same set):

```
layout: list
+++
# {{ arg.site.title }}
{% for (const p of $.find({ section: 'posts', draft: { $ne: true } })
         .sort((a, b) => (a.date < b.date ? 1 : -1))) { %}
- [{{ p.title }}]({{ p.url }}) — {{ p.date }}
{% } %}
```

**Computed fields** injected into each document's data before insertion (so
queries can use them): `path`, `section` (from directory), `slug` (from
filename or front matter), `url` (permalink), `date` (front matter, else
filename prefix, else file mtime).

**Rendering model — two stages per page:**

1. page body + its layout (`$.render({ layout: … }, page)`) → markdown →
   markdown-it → HTML fragment;
2. `base.mdy` — an HTML-emitting mdy template — receives
   `{ content, page, site }` → full document → written to
   `dist/<section>/<slug>/index.html` (pretty URLs).

Tag pages: loop the union of all `tags`, `$.find({ tags: t })` per tag. RSS
and sitemap are just more mdy templates emitting XML.

## Phases

### Phase 0 — mdy-docs library surface (lands in mdy-docs)

Two small API additions the SSG needs and every future consumer benefits from:

- **`openDocumentSet(sources)` → handle**: build the nisaba set once, then
  `set.find(query)` (host-side, for routing) and `set.render(target, ctx)`
  per page — instead of today's rebuild-per-render `renderDocumentSet()`.
  Mostly a refactor: `buildDocumentSet` already is this, just unexported.
- **Source identity**: accept `[{ text, meta }]` sources whose `meta` merges
  into every contained document's data — so a document knows which file it
  came from and the vault can inject computed fields.

### Phase 1 — `edubba build` (exit: a real blog deploys)

- `site.yaml` load; vault walk of `content/` + `layouts/`; computed fields.
- One document set; per-page two-stage render; pretty-URL emission.
- Index page via `list` layout; `static/` passthrough.
- **Exit criterion: a personal blog builds to `dist/` and deploys to GitHub
  Pages.**

### Phase 2 — `edubba serve`

- Watch content/layouts/config → incremental rebuild (file-level identity
  makes "re-render only affected pages" tractable; nisaba change streams
  (`watch()`) are the natural signal), local HTTP server, live reload.

### Phase 3 — blog completeness

- Tag pages, RSS, sitemap, 404; drafts & future-dated posts; pagination;
  summaries; `edubba new post <title>`.

### Phase 4 — the parts Hugo can't do

- **Themes as npm packages** ✅ — safe to install because templates are
  sandboxed in the VM. A theme is a directory of `layouts/` + `static/`,
  the same shape as a site minus `content/`, referenced from `site.yaml`'s
  `theme:` (a package name, resolved by walking `node_modules` up from the
  site root — deliberately not through `require.resolve`/`import.meta.resolve`,
  since a theme has no JS entry point to run; or a relative/absolute path).
  Precedence, layouts and static both: site overrides theme overrides the
  Phase 3 built-ins (404/rss/sitemap/robots). See `src/theme.js` and the
  `examples/theme-mono` + `examples/themed-blog` pair.
- **Build-time search index** ✅ — via nisaba's real text index
  (`createIndex({ text: 'text' })`, `$text` smoke-queried at build time), but
  honestly scoped: nisaba doesn't run in the browser yet (no storage
  provider today can load a prebuilt index from a static HTTP host — a real
  gap in nisaba-db, out of scope for edubba to fix), so what actually ships
  is a compact `search-index.json` (title/excerpt/tags/deduped words per
  page) plus a small dependency-free browser-side widget that tokenizes the
  visitor's query the same way and ranks by word overlap. Unconditional,
  like `sitemap.xml` — not a template, since its shape is a contract with
  the widget reading it. See `src/search.js` and
  `examples/blog/static/search.js`.
- **In-browser editing/preview** ✅ — the whole stack is wasm, confirmed by
  building mdy-docs' own playground (`third_party/mdy-docs/web/`) for the
  browser before starting: both engines bundle via Vite with zero
  wasm-specific config. What made the SSG itself (not just single-document
  rendering) client-side was pulling the vault's file access behind a
  provider — `nodeFsProvider` (real filesystem, the
  unchanged CLI default) or `memoryFsProvider` (an in-memory
  `Map<path, text>`, held by reference — an editor mutating it and calling
  `renderSite()` again is the whole live-reload story, no separate watch
  mechanism needed). `renderSite()` itself needed no changes: it was
  already fs-free (openVault does all the reading). `web/` is the actual
  editor — a 3-pane UI (files / textarea / live preview) seeded from
  `examples/blog`, rebuilding on every keystroke (debounced) against a
  `srcdoc` iframe. A `srcdoc` iframe has no real origin, so three things a
  real server provides are shimmed at preview-injection time only (never
  in the shipped files): `static/style.css` inlined as `<style>`, the
  search widget's `fetch('/search-index.json')` intercepted to already-
  built JSON, and internal `<a href>` clicks `postMessage`d to the parent
  to switch the previewed page (real navigation would just 404). Themes
  are NOT available here — `theme.js` always reads the real filesystem (a
  real `node_modules` to walk is inherent to what "theme" means) and isn't
  fs-provider-pluggable; harmless as long as a browser-edited `site.yaml`
  never sets `theme:` (and if it does, the resulting error is caught and
  shown, not a crash). One build-time-only gotcha surfaced along the way:
  Rollup statically validates every *static* named import against a
  browser-externalized Node builtin's export list (`import { join } from
  'node:path'` fails the whole build even if never called) — fixed by
  making all such imports lazy (`await import(...)`) in `fs-provider.js`,
  `theme.js`, and `build.js`.
- **Vault extraction** ✅ — done ahead of the plan's own stated rule
  ("gets extracted the day a second consumer exists"): there still isn't a
  second real consumer, so this was extracted on the premise that the
  boundary was already clean and worth defining explicitly rather than
  guessing at later, at the cost of being genuinely speculative — if a real
  second consumer's needs turn out to not fit this API, it's small enough
  to revisit without much sunk cost. `packages/vault` (published locally as
  `@mdy-docs/vault`, consumed by edubba the same `file:` way mdy-docs and
  nisaba-db already are — not yet a separate git repo/submodule, since
  that's a bigger, harder-to-reverse step better taken once a second
  consumer actually justifies it) holds exactly the generic
  "directory of documents → queryable set" primitive: `fs-provider.js`
  (moved verbatim, unchanged) and a new `walkVault(root, options)` that
  walks `*.mdy` files into `{ text, meta: { path, mtime } }` sources —
  bare file identity, nothing SSG-shaped. Computed URLs, sections, slugs,
  dates, draft/future filtering, title/summary derivation, layout-name
  derivation all stayed in edubba's own `src/vault.js`, now a thin
  blog-specific layer on top — the whole point of the split. edubba is the
  package's one real consumer today, dogfooding the exact boundary a
  second consumer would use.

## Open questions

- ~~Plain `.md` interop~~ — resolved, and turned out to need more care
  than the original framing ("body-only, front matter via a sibling
  ```data fence or filename conventions") suggested. The actual risk
  wasn't just `---` vs. mdy's document separator — it was that ANY of
  mdy's structural syntax (`---`, `+++`, `{{ }}`/`{% %}`, ` ```data `
  fences) is also everyday markdown or prose, and a fenced code sample
  routinely contains `}}`/`%}` as plain text. Escaping-based workarounds
  investigated and rejected as fragile (a code block with a stray `}}`
  could still misparse). The robust fix: `.md` files never touch mdy's
  parser at all — no `+++`/`---`/`{{ }}` interpretation, ever, by
  construction, not by escaping. Front matter is unconditionally empty
  (no override mechanism); computed fields fall back exactly as they
  would for a front-matter-less `.mdy` file; inline `#hashtags` still
  work via mdy-docs' standalone `extractTags`, which is safe to call
  without the full parse. `src/vault.js`'s file-level comment has the
  full reasoning. Also added along the way, same request, same
  reasoning: `.yaml`/`.yml` content files as pure data records (parsed
  YAML, no body, no page — `$.find({ kind: 'data', ... })` only).
  `@mdy-docs/vault`'s `list()`/`walkVault()` gained an `extensions`
  option (default `['.mdy']`) to support this.
- Date/timezone normalization (YAML dates → JSON strings across the VM
  boundary — pick one canonical form early).
- ~~Theme packaging format~~ — resolved: see Phase 4.
- ~~Incremental build granularity~~ — resolved: see below. `edubba serve`
  now genuinely does per-output incremental rebuilds, not "rebuild all
  pages, reuse the parsed set" — the plan's own original, more modest
  instinct turned out to underestimate what was tractable once actually
  pushed on.

### Incremental build ✅

Shipped as two pieces, one in each repo, because the actual instrumentation
point belongs in mdy-docs — edubba can't see inside a template's own
`$.find` call without it.

**mdy-docs**: `openDocumentSet(sources, { onQuery })` — `onQuery({ query,
docIndex })` fires for *every* query the set ever runs, template-level
(`$.find`/`$.findOne`/`$.withTag`/`$.render`-by-query, from inside the VM)
and host-level (`find`/`findOne`/`render`-by-query called on the returned
handle) alike, because both paths already shared one function (`hostFind`)
before this — the hook just taps that existing chokepoint. `docIndex` is
whichever document is currently rendering (`null` for a host-level call),
threaded through naturally since natives are rebuilt fresh per `runDoc`
call. mdy itself has no opinion on what an embedder does with the record —
pure instrumentation, opt-in, a no-op by default.

**edubba** (`src/incremental.js` + `src/build.js`'s `renderSite`): the
actual difficulty isn't a template edit cascading — that's the *easy*
case, since a changed file's own text is trivially detectable (a string
compare) and forces unconditional re-render, which naturally produces
fresh recorded dependencies for next time. The hard case is the classic
incremental-view-maintenance "phantom dependency" problem: a **new**
document that was never in some *unedited* query's old result set still
changes that query's result — e.g. adding `content/posts/new-post.mdy`
should make it show up in `list.mdy`'s `$.find`-free, host-computed
`posts` list (an aggregate output, invalidated by ANY page add/remove —
cheap, no query tracking needed for that) — but also, if some OTHER
layout runs its OWN internal `$.find({ tags: {...} })` (post.mdy's
"related posts" in `examples/blog`, a **real** feature added specifically
to prove and test this, not a toy fixture), that filter's result changes
too, with no file of its own edubba could watch. Recording *only* which
documents a query returned wouldn't catch this (the new document was
never in the old result); recording the query's own filter, then
re-running just the *distinct* filters (bounded by how many aggregating
layouts a site has, not how many pages) against the fresh document set
and diffing the match set by each matched document's stable identity
(`kind:path`/`kind:layout` — nisaba's own `_id` isn't stable across a
fresh `openDocumentSet()` call) does.

Per output file, cached: its file dependencies (own content + resolved
layout chain + `site.yaml`, since site title/baseURL touch nearly
everything) and the distinct query filters its render actually performed.
An output is reused verbatim when every file dependency's text is
byte-identical *and* every recorded filter's freshly re-evaluated match
set is unchanged; otherwise it's actually re-rendered, which records fresh
dependencies for the next round. `edubba serve` threads the cache from one
rebuild to the next (only on a *successful* build — a broken save doesn't
corrupt tracking) and reports `(N reused, M rebuilt)`. `edubba
build`/`buildSite`/the browser editor never pass a previous cache, so
every output is unconditionally "changed" — a normal full build, zero
behavior change there.

### Recursive folder watch (Node + browser/OPFS) ✅

Lives in `@mdy-docs/vault` (`packages/vault/src/fs-provider.js`), not
mdy-docs itself or edubba — it's a file-system-abstraction concern, exactly
this package's existing domain (`list`/`read`/`mtime`, now also
`write`/`remove`/`watch`), not a template/query concern. mdy-docs' own
`bin/mdy.js --watch` stays as-is: it watches a fixed, explicitly-named list
of files (plus their containing dirs, non-recursively) via one `fs.watch`
per file — a deliberately narrower tool for a single-document CLI session,
not the "watch a whole tree, including files that don't exist yet" ask this
was.

`write`/`remove`/`watch` are optional per provider — a consumer checks
before calling (`fs.watch?.(...)`):

- **`nodeFsProvider`**: `watch(root, callback)` is one native
  `fs.watch(root, { recursive: true })` — the same call edubba's own
  `serve.js` already made directly; now available to any consumer of the
  package, not just edubba. `write`/`remove` wrap `fs/promises`
  (`writeFile`, creating parent dirs; `rm`, tolerating a missing path).
- **`memoryFsProvider`**: `write`/`remove` mutate the `Map` directly. No
  `watch()` — nothing outside the same JS heap can change the Map, so
  there's nothing to detect; this is *why* the browser editor (Phase 4,
  above) never needed a watch mechanism — the same code path that mutates
  already knows to re-render.
- **`opfsFsProvider`** (new): the browser's origin-private file system — a
  real, persistent filesystem scoped to the page's origin, no user-facing
  picker, `root` a path *within* OPFS so multiple vaults can share one
  origin. This is the piece that makes `watch()` actually meaningful in a
  browser: unlike the in-memory editor, OPFS survives a reload and is
  shared across tabs/workers on the same origin, so there's a real external
  writer to watch *for*. `watch()` prefers the native
  [`FileSystemObserver`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemObserver)
  API (`observe(handle, { recursive: true })`) where it exists — as of this
  writing, Chrome/Edge 133+ and some Opera builds only (~22% global share
  per caniuse's `mdn-api_filesystemobserver`), still marked experimental,
  spec not finalized (`github.com/whatwg/fs/pull/165`) — and falls back to
  polling (`watchByPolling`, also exported standalone, pure and unit-tested
  against a fake provider with no browser needed) everywhere else,
  including Firefox and Safari/iOS Safari, which have zero native support
  today. Same `{ close() }` shape regardless of which path ran.

Verified against a real, unmocked browser: `packages/vault/test/opfs-provider.test.js`
drives headless Chromium via Playwright (already present for this repo's
own manual browser checks; now a declared `devDependency` of
`packages/vault`) — a tiny local HTTP server serves `fs-provider.js`
un-bundled (it's plain ESM, browser-safe as written), the page
`import()`s it directly, and the test asserts `list`/`read`/`write`/
`remove`/`mtime` against real OPFS (including that two `root`s stay
isolated) and that a `write()` after `watch()` starts produces a real
`FileSystemObserver` callback — not a simulation of one. Both tests skip
cleanly, rather than fail, wherever Playwright or a Chromium binary aren't
available.

**Wired into `web/`'s editor** ✅, as a write-through layer under the
existing `memoryFsProvider(files)` rather than a replacement for it —
`renderSite` still reads the synchronous in-memory `files` Map every
consumer here already assumes; OPFS sits underneath it. On boot,
`hydrateFromOpfs()` replaces the bundled `examples/blog` seed with real
saved content if OPFS already has any (first-ever visit: the seed is
written through to OPFS instead); every edit (`editor` input, new-file,
delete) marks its path dirty, and `persistDirty()` mirrors dirty paths to
OPFS after each render settles — best-effort, swallowing failures, since a
persistence hiccup should degrade to "this edit won't survive a reload,"
not a broken editor. `opfs.watch(OPFS_ROOT, onOpfsChange, {extensions:
null})` folds in another tab's write live, skipping the path currently open
in *this* tab's editor to avoid clobbering active typing (no real-time
merge — a file open in two tabs at once diverges until you switch away and
back in one). See `web/main.js`'s file-level comment for the full shape,
and the `#storage-status` badge next to the file list ("saved in this
browser · live across tabs" vs. "not saved (in-memory only)" when OPFS
isn't available).

Verified against the actual built bundle, not just unit tests: a Playwright
script drove two real tabs (`chromium`, one `BrowserContext` so they share
an origin) against `dist-web/` served by `vite preview` — tab A edited
`content/about.mdy`, a full page reload still showed the edit, a brand-new
tab B loaded with that same edit already present, and tab B creating
`content/from-tab-b.mdy` showed up in tab A's file list within ~250ms with
*no* reload — the live cross-tab path, not just persistence.

### Every file, queryable — kind: 'file' ✅

Before this, nisaba only ever saw four things: `.mdy`/`.md`/`.yaml`/`.yml`
content files (as `kind: 'page'`/`'data'`) and layout files (`kind:
'layout'`). mdy-docs itself adds no metadata of its own — `buildDocumentSet`
just spreads a source's `meta` onto its parsed data and inserts that
verbatim (`third_party/mdy-docs/src/mdy.js`'s `{...doc.data, ...meta}` /
`insertOne`); any identity is 100% whatever the embedder computes.
Everything else — `static/` (images, fonts, CSS/JS), site.yaml, and (a real
gap this surfaced) any file under `content/` with an extension edubba
doesn't recognize — was invisible to the whole pipeline: not rendered, not
queryable, and for that last case, not even copied to `dist/` (only
`static/` is). It just silently vanished from a build.

Fixed at two layers, same split as everything else in this project — the
generic file-identity primitive in `@mdy-docs/vault`, the SSG-specific
policy in edubba:

- **`@mdy-docs/vault`**: `size(root, relPath)` alongside the existing
  `mtime()` on all three providers, and a new `walkFiles(root, options)` —
  deliberately not `walkVault`: it never calls `read()`, so it's safe over
  real binary files. Returns `{ path, name, ext, size, mtime }` per file,
  defaulting to *every* file, any extension (the opposite of `walkVault`'s
  `['.mdy']` default — the point here is usually "all of them").
- **edubba** (`src/vault.js`'s `openVault`): after building layout/page/data
  sources exactly as before, walks the *entire* site root and gives every
  file not already claimed by one of those a `{ kind: 'file', path, name,
  ext, size, mtime }` record — `$.find({ kind: 'file', ext: '.png' })` now
  genuinely works from inside a template. `dist/`, `node_modules/`, and
  dotfiles/dot-directories are excluded (`NON_SOURCE`, the same convention
  `serve.js`'s watcher already used) so a previous build's own output is
  never indexed as if it were input. A draft/future-excluded or empty
  content file now falls through to a `kind: 'file'` record too, instead of
  vanishing entirely — still not a page, but still findable.

One real incremental-cache interaction this surfaced: a `kind: 'file'`
record is never a `fileDep` of anything (nothing "resolves" a file the way
a page resolves its layout chain) — a query finding it is its *only*
dependency link, so replacing `static/logo.png` with a same-path,
different-content image wouldn't change a query's *matched set* (same path
→ same identity) and a cached output surfacing its `size`/`mtime` would go
stale. Fixed by folding `size`+`mtime` into `stableKey` specifically for
`kind: 'file'` documents (`src/incremental.js`) — pages/data/layouts keep
their plain `kind:path` identity unchanged, since their own text changing
is already caught by the ordinary fileDep check.

Verified end-to-end, not just at the `openVault` level: a real `renderSite`
test with an in-memory site whose `layouts/page.mdy` does
`$.find({ kind: 'file', ext: '.png' })` and prints each match's `size`
actually renders the right bytes-count in the output HTML
(`test/fs-provider.test.js`), and a second incremental-render test proves
the staleness fix specifically — edit `static/logo.png`'s bytes in place,
same path, and the output that queried it is correctly rebuilt with the new
size, not incorrectly reused (`test/incremental-render.test.js`).

### Image dimensions and $.resize ✅

Two more `kind: 'file'` pieces, both grounded in a real question: does
mdy-docs track file metadata (it doesn't — see above), and can a template
actually *transform* an image, not just find it. Verified by hand before
committing to either dependency (see below), not assumed:

- **Dimensions**: `image-size` (pure JS, zero dependencies, reads only a
  file's header — no full decode) gives every recognized image extension
  (`IMAGE_EXTENSIONS`, `src/vault.js`) real `width`/`height` on its
  `kind: 'file'` record. Best-effort — a corrupt or unsupported file just
  keeps its record without them, not a build failure.
- **`$.resize(fileDoc, { width, height })`** — callable from template code,
  exactly the ask: `$.findOne({ kind: 'file', path: ... })` to get a
  document, `$.resize` to get back `{ path, url, width, height }` for a
  resized copy, one of width/height alone preserving aspect ratio. The
  resized image is a **build output only** — written into `dist/`
  alongside the HTML (and served the same way by `edubba serve`), never
  back into `content/`/`static/` on disk.

This needed a genuinely new mechanism, not just a new function, because a
template calling out to *anything* embedder-supplied didn't exist before:
mdy-docs' VM natives (`find`/`findOne`/`render`) were hardcoded in
`buildDocumentSet`. Fixed at the source, same repo split as `onQuery`:

- **mdy-docs**: `openDocumentSet(sources, { natives })` — extra
  `{ name: fn }` entries merged into every render's host natives AND wired
  as `$.<name>(...)` in the generated VM program (`buildProgram`'s
  `extraNativeNames`). Generic, no image-specific (or any-specific)
  knowledge in mdy-docs itself — same "hook, not policy" shape as
  `onQuery`. Verified with 6 new mdy-docs tests (a custom native, an async
  one that genuinely suspends the VM via Asyncify and resumes, args/return
  crossing the VM boundary JSON round-tripped, coexistence with
  find/findOne/render, and a clear rejection for an invalid native name)
  before writing a single line of edubba-side image code.
- **`@mdy-docs/vault`**: `readBinary`/`writeBinary` alongside the existing
  text `read`/`write` on all three providers — `read()` would silently
  corrupt real binary content by decoding it as UTF-8. `memoryFsProvider`'s
  Map may now hold either a string or a `Uint8Array` per path;
  `read`/`readBinary` convert either way, so a caller never has to know
  which one a given entry holds.
- **edubba** (`src/images.js`): the actual codec work — decode, resize,
  re-encode. **WASM codecs (`@jsquash/*`), not `sharp`** — the one real
  fork in this feature, decided by the user rather than defaulted: `sharp`
  is faster and more mature, but it's a native addon (libvips), Node/CLI-
  only forever, a third permanent "not in the browser editor" gap alongside
  themes. `@jsquash/png` + `@jsquash/resize` run the same code path in
  Node and browser — the same reasoning that put lamassu/nisaba in this
  stack. Confirmed for real, not assumed: a real decode → resize → encode
  round-trip against a genuine 8-bit RGBA PNG (a hand-rolled minimal PNG
  encoder — `test/png-fixture.js` — since a naive "smallest possible PNG"
  test fixture from the wild turned out to use a bit-depth/color-type
  jsquash's decoder rejected; real photos/screenshots are essentially
  always plain 8-bit RGBA truecolor, so that's what the fixture makes too).
  **PNG only for now** — `@jsquash/jpeg` wraps mozjpeg through an
  Emscripten-style module init that doesn't share PNG/resize's
  wasm-bindgen init shape; wiring it is another `CODECS` entry, not a
  design change, but real work, out of scope for this first cut.
  One more thing discovered the hard way: jsquash's own default
  self-init does `fetch(new URL(..., import.meta.url))`, which works fine
  in a browser but Node's `fetch` flatly doesn't support `file://` URLs —
  `images.js` reads each codec's `.wasm` bytes itself via `node:fs` and
  inits explicitly, Node-only (the browser path is untouched, and — a
  pleasant surprise — `npm run web:build` bundled all four jsquash `.wasm`
  assets correctly with zero config, meaning the browser's own default
  self-init path is very likely to just work there too; not yet verified
  end-to-end in an actual browser, since the editor has no way to get a
  binary image into its vault yet — see below).
- **build.js**: a resize call is a *side effect* of rendering (like a
  query, but one that produces bytes instead of just narrowing a result
  set) — `renderSite` now also returns `binaryOutputs: Map<path,
  Uint8Array>`, threaded through the same `currentQueries`-style mutable
  "whichever output is rendering right now" pointer
  (`currentBinaryOutputs`), written to `dist/` by `buildSite` and served by
  `serve.js` the same way HTML outputs are. Because the input is always a
  document obtained via `$.find`/`$.findOne`, a resize call automatically
  inherits the `kind: 'file'` staleness protection above — no separate
  tracking needed. One real gap this surfaced in the incremental cache: an
  output that gets *reused* (skipped entirely — see `buildOutput`) never
  re-runs its `$.resize` call that round, so without carrying the bytes
  forward the image would just vanish from the build the moment its page
  stopped needing a rebuild. Fixed via `binaryDeps: string[]` per cached
  output entry (`src/incremental.js`), carrying the actual bytes from
  `oldCache.binaryOutputs` into the new build's `binaryOutputs` on reuse —
  proven by a dedicated incremental test, not just inferred from the code.

What this does *not* do yet: wire image upload/editing into `web/`'s
browser editor (it still has no way to get a real binary file into its
in-memory vault at all) — a separate, larger UI decision than "make the
primitive exist," consistent with how OPFS persistence (above) was scoped.

### Metadata sidecars for non-document files ✅

A `kind: 'file'` record (above) carries file identity, but nothing
hand-authored — no license, no source, no caption. For that: drop
`<name>.<ext>.mdy` next to any file with no document shape of its own
(`static/logo.png` → `static/logo.png.mdy`) and its front matter merges
straight into the binary file's `kind: 'file'` record; its body is a real
mdy template, renderable via `$.render({ kind: 'file', path: ... })` —
exactly a page's own `$.render({ kind: 'page', ... })`, just addressed by
a different `kind`. A gallery layout can therefore do
`$.findOne({ kind: 'file', path: 'static/logo.png' })` for `.license`/
`.source`/`.width`/`.height` to build a thumbnail, and separately
`$.render({ kind: 'file', path: 'static/logo.png' })` for a rendered
caption — the metadata and the prose live in one file but are two
different, independently useful queries, matching how the user described
the feature.

The sidecar is explicitly **not** independently addressable — no page, not
`$.find`-able by its own path — which took real care to get right, not
just a filter at the end:

- Detection has to happen *before* the ordinary content walk runs, and
  over the *whole* vault, not just `content/` — the file being captioned
  might be in `static/` (no document walk touches it at all today) just as
  easily as `content/`. `openVault` now calls `walkFiles(root)` once up
  front (previously only at the very end) specifically to build the
  "does `<path>.mdy` have a same-named sibling?" answer before deciding
  what any `.mdy` file even is. A `.mdy` with no such sibling is
  unaffected — still an ordinary content page, exactly as before (a real
  regression risk if detection ran too eagerly or too late).
- Parsing reuses `parseMdyFile` verbatim (front matter + a live template
  body, `` ```data `` fences, the works) — no new parser, no new render
  path; a sidecar's caption gets $.find/$.render for free the same way a
  page's body does, purely by being pushed into `sources` the same shape.
  (`parseMdyFile`'s error message no longer hardcodes a `content/` prefix,
  since it's now called for sidecars anywhere in the vault too.)
- A malformed sidecar (bad front matter, an unterminated data fence)
  degrades to a `console.warn` and a plain `kind: 'file'` record — not a
  build failure. The underlying file is fine regardless of a typo in its
  caption; treating it like a broken page (hard failure) would be a
  disproportionate failure mode for what's meant to be additive metadata.
- **Incremental staleness, a second time over**: editing *only* the
  caption (the binary itself untouched) doesn't change the file's own
  `size`/`mtime` at all, so the existing `kind: 'file'` stableKey fix
  (above) wouldn't catch it on its own. `stableKey` now also folds in the
  sidecar's own `metaMtime`/`metaSize` when one exists. Both, not mtime
  alone: `memoryFsProvider` (every test, the browser editor) has no real
  mtimes — always "now" — so `metaSize` is what actually makes this
  deterministic there; a real filesystem's mtime is belt-and-suspenders on
  top. Proven both ways: a precise unit test on `stableKey` itself
  (`test/incremental.test.js`, no filesystem involved, fully deterministic)
  and a real two-build `renderSite` test confirming a layout that reads a
  sidecar's field actually rebuilds when only the sidecar changes
  (`test/incremental-render.test.js`).

### A real example — and three real bugs it found ✅

`examples/blog` now has a genuine binary asset:
[static/logo.png](../examples/blog/static/logo.png) (a small, procedurally
generated "clay tablet" icon — no external image tool involved, same
from-scratch PNG-encoder approach as the test fixtures) with a real
[metadata sidecar](../examples/blog/static/logo.png.mdy), used from
[content/about.mdy](../examples/blog/content/about.mdy) to show a
`$.resize` thumbnail, a `$.render`ed caption, and `$.findOne` license/
source — exactly the shape described above, not a synthetic snippet.
Building it for real (not just asserting against fixtures) surfaced three
bugs that no unit test had caught, because none of the unit tests happened
to combine "a real static/ image" with "a real build/serve/browser-editor
run" the way an actual site does:

- **URL mismatch**: `buildSite`/`serve.js` already flatten `static/`'s
  contents straight to the dist root (`static/logo.png` → `/logo.png`,
  same as `style.css`/`search.js`) — but `images.js`'s resize output kept
  the source's `static/` prefix, landing at `/static/logo-120x84.png`, a
  URL nothing else in the site actually uses. Fixed by stripping a leading
  `static/` from the output path the same way (`STATIC_PREFIX`,
  `images.js`) — a source path outside `static/` is untouched, no
  established flattening convention applies to it.
- **Sidecar leaking as a static asset**: `buildSite`'s static copy is a
  blanket `cp(staticDir, outDir, { recursive: true })` with no idea what a
  sidecar is — `logo.png.mdy` was landing in `dist/` as a raw, publicly
  fetchable text file, directly contradicting "I don't want these files
  individually accessed." Fixed with `fs.cp`'s own `filter` option
  (excluding `.mdy`) in `buildSite`, and the equivalent exclusion in
  `serve.js`'s `readStatic` for the live dev server — a `.mdy` was never a
  sensible static asset in the first place, sidecars or not.
- **Browser editor build failure**: `web/main.js` seeds every example file
  through `import.meta.glob(..., { query: '?raw' })` — correct for text,
  but it silently corrupts real binary content, so `logo.png`'s bytes
  arrived mangled and `$.resize` failed outright (`no known width/height`)
  — the whole site failed to build in the browser editor the moment it had
  one real image anywhere in it. Fixed by splitting the glob in two
  (`?raw` for text, `?url` + a `fetch().arrayBuffer()` for
  `BINARY_EXTENSIONS`) and doing the same split through OPFS persistence
  (`readBinary`/`writeBinary`, keyed off the same extension check) so a
  round-trip through browser storage doesn't re-corrupt it either. A
  second, related gap: even with correct bytes, the `srcdoc` preview
  iframe has no real origin, so `<img src="/logo-120x84.png">` couldn't
  actually load there — the same class of problem `style.css`/
  `search-index.json` already needed shimming for, just never hit before
  because the editor had never had a real image to preview. Fixed by
  extending `preparePreviewHtml` to rewrite `<img src>` into a `data:` URL
  resolved from either a `$.resize` output or a flattened `static/` file.

None of these were hypothetical — each was caught by actually running the
example through all three real paths (`edubba build`, `edubba serve`, the
built browser bundle via Playwright), not by writing a test that assumed
the mechanism worked. The moral, consistent with `post.mdy`'s "More like
this" and the `.md` tags bug earlier in this project: a synthetic
unit-test fixture proves the code does what the test expects; only a real
feature, built and actually run, proves the code does what a user needs.

## Toward a script-defined site

mdy-docs' actual goal, per its own maintainer, isn't "the engine edubba
happens to use" — it's a platform: one `.mdy` document as a whole tool's
entry point, defining its own conventions (a blog's `posts/` folder isn't
special to mdy-docs, it's a convention the *script* chooses), not
conventions hardcoded into a JS package like edubba. Worth asking
concretely: what's actually missing for the blog example above to be
expressible as one script, not `src/build.js` + `src/vault.js`?

Most of it already works. Per-page composition, tag grouping, pagination
chunking, sorting — all plain JS-subset code inside `{% %}`, operating on
`$.find()` results; edubba's own tag/pagination logic in `build.js` is
already just array/Map code a script could do identically today.
Rendering another document with overridden context is `$.render(target,
data)`, already there.

Three things were genuinely missing:

1. **Multi-output emission** — a template could only ever *return* one
   value from its own render; a whole site is N output files from one
   entry point. **Built** ✅: `$.emit(path, content)` +
   `options.onEmit({ path, content, docIndex })`, a *fixed* mdy-docs
   native (same tier as find/findOne/render — every consumer gets it,
   unlike `options.natives`' embedder-defined ones), because "produce a
   named output" is generic to any mdy-docs tool, not edubba-specific —
   mdy has no opinion on what onEmit does with the pair, same "hook, not
   policy" shape as `onQuery`. Wired into edubba's `renderSite` with the
   exact same pattern already built for `$.resize`'s binary outputs
   (`currentEmittedOutputs`, a per-render mutable pointer;
   `emittedDeps`/`emittedOutputs` in the incremental cache, carried
   forward on reuse for the identical reason binaryDeps needed it — a
   reused output never re-runs render(), so never re-emits). Proven with
   a real (not synthetic) case: one content document computing a tag
   index via `$.find` + `.filter()` and `$.emit`ting it — a feature
   edubba's own `build.js` does in host JS today, done here entirely in
   template code instead (`test/fs-provider.test.js`), plus the
   analogous reuse-survives-caching test
   (`test/incremental-render.test.js`).
2. **Raw file access** — a script can't ask "what's under `content/`?" or
   read a file's raw text; `openDocumentSet(sources)` only ever sees what
   the *host* already walked (edubba's `vault.js`, computing
   url/section/slug from path *before* any template runs). Without this,
   "posts folder is a script convention" is impossible — the convention
   is baked in before the script executes. **Not built.**
3. **Dynamic document registration** — nisaba's collection is populated
   once, host-side, before rendering starts; a script can't parse a file
   and register it as a queryable document with its own computed fields.
   Would need something like `$.insert(text, meta)`, with real ordering
   implications (a later `$.find` in the same run needs to see it).
   **Not built.**

\#2 and \#3 are a materially bigger trust-boundary decision than anything
shipped so far — lamassu's sandbox exists specifically to run
untrusted-ish template code *safely*; raw filesystem read access is a
different risk profile than querying a pre-populated in-memory set, even
scoped to the vault root via `@mdy-docs/vault`'s existing traversal-safe
providers. Deliberately deferred, not forgotten: `$.emit` was the
highest-value, lowest-risk piece, and useful even without the other two
(a script can already reorganize per-page/tag/pagination logic into
itself, still fed by host-walked documents). The full "one script *is*
the site, posts folder included" version waits on that bigger call.

### #2 and #3 turned out to be unnecessary, not just deferred ✅

Reconsidered: #2 (raw file access) and #3 (dynamic document registration)
were only assumed necessary because edubba's own `vault.js` *interprets*
every file (section/slug/url/date, host JS) before insertion. Drop that
interpretation — insert every file with nothing but `path`/`name`/`ext`/
`size`/`mtime` (+ front matter for `.mdy` files, which mdy's own parser
already extracts as part of the file *format*, not an edubba convention)
— and a script has everything it needs from `$.find` alone. No raw FS
access, no dynamic insertion; the "posts folder" convention becomes a
`path`-prefix check in ordinary template JS.

Two things confirmed empirically before relying on them, not assumed:

```
regex literals + string ops (no `new` needed):  "2026-07 | posts"  ✅
new Date() / new RegExp() / new Map():           SyntaxError — 'new' is
                                                  not supported (no classes
                                                  or constructors)        ✅ (confirms the one real constraint)
```

Regex literals, `.split`/`.slice`/`.match`, plain object literals (`{}`)
all work with no `new` — enough to derive `slug`/`date` from `path`
entirely in template code. `new Date()`/`new Map()`/`new RegExp()` are
genuinely blocked (a parse-time SyntaxError, not a runtime restriction) —
the one real constraint, and not actually a gap: dates already have to be
plain sortable `YYYY-MM-DD` *strings* to survive the VM boundary and sort
correctly (`normalizeDate`'s own long-standing reasoning), so `today`
arriving as a string in the script's context and ordinary string
comparison (`date > today`) covers it; `{}` covers grouping without `Map`.

**Built**: `src/script-site.js`'s `renderScriptSite(root, options)` — a
small, deliberately separate function from `renderSite` (no incremental
cache, no drafts/future filtering, no themes, no `$.resize` — a parallel
minimal execution model to validate the primitive, not a replacement for
edubba's own build):

1. Walk the *whole* root (`@mdy-docs/vault`'s `walkFiles`, the same
   `dist`/`node_modules`/dotfile exclusions as edubba's own vault.js).
2. For each file: `.mdy` gets its real text (so mdy's own parser extracts
   front matter and compiles a live template body); everything else gets
   the same zero-width-space placeholder edubba's own `kind: 'file'`
   fallback already uses — never read as text, safe for real binary
   content. Meta is *only* `{ path, name, ext, size, mtime }` — no
   section, no slug, no url, no kind.
3. One designated document (`options.entry`, default `main.mdy`) is
   `.render()`ed once, with `onEmit` collecting everything it (or
   anything it `$.render`s) produces.

Proven with a real site on real disk, not a synthetic fixture:
[examples/scripted-blog](../examples/scripted-blog) — two real posts,
one real layout, and `main.mdy` doing the *entire* interpretation:
finds documents whose `path` starts with `content/posts/`, derives
`date`/`slug` from the filename via a regex literal, decides which
layout wraps them, groups by `tags` into a plain object, and `$.emit`s
both the posts and a tag index — verified via `test/script-site.test.js`
running the actual example directory through `renderScriptSite`, not a
mock. `main.mdy`'s own file-level prose explains the model for a human
reading the source, since — unlike edubba's own blog — the *interesting*
code here is the thing being demonstrated, not incidental to a feature.

### @mdy-docs/vault moved directly into mdy-docs ✅

The follow-through on "should some of what we built live in mdy-docs":
checking rather than guessing surfaced a concrete, existing asymmetry —
mdy-docs' own CLI (`bin/mdy.js`) had **zero dependency on
`@mdy-docs/vault`**, hand-rolling its own `readFileSync`/`fs.watch`
instead — a real, working, but *weaker* duplicate of exactly what the
vault package already did (non-recursive, file-scoped watching vs. a
shared recursive primitive). And `src/script-site.js`
(`renderScriptSite`, above) turned out to contain **zero edubba-specific
code** — it was sitting in edubba's `src/` only because that's where it
got built, not because it belonged there. Both were the same underlying
problem: "getting files into the document set" is generic to *any*
mdy-docs tool, not particular to edubba, so keeping it in a separate
edubba-owned package was the wrong boundary — exactly what the vault
package's own README had flagged as an open question from the day it was
extracted ("if a real second consumer's needs turn out to not fit this
API, small enough to revisit").

Moved, not rewritten: `packages/vault/src/{fs-provider,vault}.js` →
`third_party/mdy-docs/src/{fs-provider,vault}.js`, re-exported from
mdy-docs' own `index.js` (`nodeFsProvider`, `memoryFsProvider`,
`opfsFsProvider`, `watchByPolling`, `walkVault`, `walkFiles`) alongside
the template/query engine — one package, one `npm install`, for a new
tool to get both. Its test suite (`fs-provider.test.js`, `vault.test.js`,
`opfs-provider.test.js` — including the real headless-Chromium OPFS
tests) moved verbatim into mdy-docs' own `test/`, `playwright` added as
mdy-docs' own devDependency; all 156 mdy-docs tests pass in the new
location, unchanged behavior, including the real browser ones.

`bin/mdy.js` rebuilt on top of it directly: `readSources`/`loadContext`
now go through `nodeFsProvider().read(dirname(p), basename(p))` instead
of `readFileSync`, and `--watch` now sets up `nodeFsProvider().watch(dir,
callback)` per containing directory instead of raw `fs.watch` — same
filename-filtering logic, same debounce, same "editors save atomically,
watch the directory not the file" reasoning, just no longer a second
implementation of it. (`writeFileSync` for `-o`, and `readFileSync(0)`
for stdin, stay direct — neither is "getting a file into the document
set", the vault layer's actual job.) Verified for real, not just via the
existing automated `--watch` tests (which do all pass, unchanged): a live
background `mdy --watch` process, a real file edit mid-run, confirmed the
new output.

edubba side: `packages/vault/` deleted outright, `@mdy-docs/vault` dropped
from `package.json` (`mdy-docs` already covers it), all 11 import sites
(7 `src/`/`web/` files + 4 test files) repointed to `import { ... } from
'mdy-docs'`. Full edubba suite (156 tests) and `web:build` both still
pass unchanged — the move is invisible from edubba's side except the
import source, exactly the point.

### `renderScriptSite`/`examples/scripted-blog` retired — folded into the CLI's own directory-input mode ✅

The script-defined-site model above was proven as a **separate** function
(`renderScriptSite`, its own demo directory, its own test file) precisely
because it needed proving — a parallel, minimal execution model, deliberately
not wired into anything real yet. Once `bin/mdy.js` grew a directory `path`
mode that does exactly this (walk the directory, resolve an entry by path,
render it, collect `$.emit`) as an everyday, first-class CLI capability —
not a demo of the idea but *the* way `mdy <directory>` works — the standalone
function had nothing left to prove and no caller left but the CLI itself.

Retired, not reimplemented: `src/site/script-site.js` deleted;
`walkRawSources` (the walk-into-raw-`{ text, meta }`-sources half — genuinely
generic, no more "script-site" specific than `walkFiles`/`walkVault` are)
moved into `src/vault.js` alongside them and re-exported from `index.js`
there instead. `bin/mdy.js`'s directory mode now calls `walkRawSources` +
`openDocumentSet` directly — the entry-resolution logic (`data.path` lookup
*after* splitting, not against the pre-split file list — the bug the
original `renderScriptSite` had before anything depended on it) lives inline
as `findEntryIndex`, shared between the normal render path and `--emit-js`.
`examples/scripted-blog` and `test/script-site.test.js` deleted; their
unit-level coverage (raw identity, `.mdy`-only real text, `dist`/
`node_modules`/dotfile exclusion) moved to `test/vault.test.js` alongside
`walkFiles`'/`walkVault`'s own; the end-to-end "real site on real disk"
coverage is now exactly what `test/cli.test.js`'s directory-input tests
already exercise through `bin/mdy.js` itself, so it wasn't duplicated.

### `renderScriptSite` un-retired — `mdy build`/`serve` (and examples/blog itself) now run on it too ✅

The retirement above was correct for what was true at the time: `bin/mdy.js`
was the only real caller, so a separate function had nothing left to prove.
That stopped being true the moment `renderSite` (`src/site/build.js`) — the
conventional content/layouts/site.yaml engine `mdy build`/`mdy serve` and
the browser playground all go through — needed the SAME "walk root raw,
resolve an entry by path, render it, collect `$.emit`" logic too, so a
script-defined site could be built/served through the exact same commands
and functions as a conventional one, no separate code path for the caller
to know about. Two real consumers (`bin/mdy.js`'s own directory mode,
`renderSite`'s dispatch) again justified pulling it back out into its own
module (`src/site/script-site.js`, recreated) rather than duplicating the
walk-plus-entry-resolution logic in both places — `bin/mdy.js`'s directory
mode now calls it directly too, so the CLI's `findEntryIndex` inlining from
the retirement above stayed only for `--emit-js` (a debug path that compiles
without rendering, so it can't reuse `renderScriptSite` itself).

`renderSite`'s dispatch is a one-line question asked before anything else:
does `root` have an entry document (`main.mdy`, or `options.entry`)? If so,
render it as a script-defined site and return early — same `{ site, pages,
layouts, outputs, binaryOutputs, theme, cache, stats }` shape either way, so
`buildSite`/`serveSite` needed zero changes to work on either kind of site.
`pages`/`layouts`/`site`/`theme` are empty/null for a script-defined site
(there's no host-computed page list to report — only the script itself knows
what it built); `cache` is a fresh, inert one every call, because a script's
output has no incremental-reuse story (yet) — every build/rebuild walks the
whole directory and reruns the entry from scratch (`stats.reused` is always
empty). `drafts`/`future` (the CLI's own flags) thread through as plain
context booleans (`{ drafts, future }`) for the script to interpret itself,
not filtered by the host — consistent with the "no hidden convention"
premise: even lifecycle filtering is the script's own call, not baked in.

**Real host-dependent primitives, not just find/render/emit.** Rebuilding
examples/blog as a genuine script-defined site (see below) surfaced four
things a template genuinely cannot do itself, none of them policy: `$.resize`
(WASM image codecs — already existed for conventional mode, just needed its
`fileDoc.kind !== 'file'` check relaxed to accept a raw script-mode document
too, which carries no `kind` at all), `$.tokenize` (the search widget's real
word-list algorithm, already existed in `search.js`), `$.rfc822` (RSS
pubDate — the lamassu VM forbids `new Date()`), and `$.markdown` (CommonMark
→ HTML — markdown-it, newly exposed; a script assembling a page's markdown
from `$.render` calls has no other way to turn the final result into HTML
before handing it to an HTML-emitting base layout). `walkRawSources` also
gained `width`/`height` for recognized image extensions (image-size,
header-only) — real file identity, not interpretation, but `$.resize` needs
it and raw mode had never computed it.

**examples/blog rebuilt as the flagship script-defined site.** Full output
parity with the conventional version it replaced: 3 posts (2 `.mdy` + 1
`.md`) + an about page (itself querying a `.yaml` data record) + tag pages
+ a tags index, a homepage, `404.html`, `feed.xml`, `sitemap.xml`,
`robots.txt`, `search-index.json`, and a `$.resize`d image thumbnail — all
of it decided by `examples/blog/main.mdy` alone (front matter as `site`
config; date/slug/url derived from each `posts/*` filename or its own front
matter; tag grouping via a plain object; RSS/sitemap/robots via their own
small layout files, `layouts/{rss,sitemap,robots,404}.mdy`, replacing what
were host-side `DEFAULT_LAYOUTS` string constants in the conventional
path). `layouts/post.mdy`'s "related posts" query changed from the layout
re-running `$.find({ kind: 'page', section: 'posts', tags: {...} })` itself
(meaningless in raw mode — nothing has `kind`/`section`) to receiving an
already-computed `related` array as context — the entry does ALL the
interpretation, a layout is purely a shell now, even more so than before.

**`.md`/`.yaml` support corrected, not dropped.** First pass here concluded
these had "no honest equivalent" in raw mode and left them out — wrong, and
caught by the user pointing out plain .md/.yaml files should still be
ingestible and searchable, same as conventional mode. The actual constraint
is narrower than "raw mode can't give a file real text": `openDocumentSet`
always compiles a source's `text` as an mdy template, so a `.md`/`.yaml`
file's real content can't go through `text` the way `.mdy`'s does — but
`walkRawSources` can still interpret the file FORMAT itself (same reasoning
as `.mdy`'s own front-matter extraction — "the file format's job, not a
site-building convention") without ever handing that content to the
compiler. Fixed in `walkRawSources` (`src/vault.js`): a `.md` file keeps
`text` as the placeholder (never compiled — a stray `---`/`{{ }}` in real
prose must not be reinterpreted, the same risk conventional mode's own
vault.js already documents) but gets its real text in `meta.body` instead,
directly `$.find`/`$.findOne`-able, plus inline `#hashtag`s extracted into
`meta.tags` (`extractTags`, already exported, no VM involved). A
`.yaml`/`.yml` file is parsed and its fields merged into `meta` directly —
pure data, no body — with only `path` structurally reserved; `name`/`ext`/
`size`/`mtime` are fallback DEFAULTS, not a mask, after an embarrassing
first cut protected `name` unconditionally and silently ate a data record's
own `name: Ada Lovelace` field behind the file's basename identity instead
— a non-mapping or unparseable YAML degrades to an identity-only record
(a warning, not a build failure — a whole-directory walk can't assume
every stray `.yaml` under the root is even meant to be a data record).
`examples/blog/main.mdy` now includes `posts/2026-07-05-plain-markdown.md`
in its post list (`raw.ext === '.md' ? raw.body : $.render(...)` — no
`$.render` needed for a file that was never compiled) and `about.mdy`
queries `author.yaml` directly, restoring the exact two demonstrations
(both real page counts, tag census, and search-index coverage back to
their original numbers).

Fallout, fixed rather than left broken: `test/build.test.js` (~20 tests),
`test/serve.test.js` (its main block), and `test/site-vault.test.js`'s
`openVault`-against-examples/blog tests all assumed the old content/layouts/
site.yaml shape. The first two now assert the script-defined site's actual
behavior (including a rewritten incremental test — no reuse, full rebuild,
by design); `site-vault.test.js`'s `openVault` tests got their own synthetic
conventional fixture (`vaultDir()`, a pattern the file already used
elsewhere) since `openVault` itself is still real, load-bearing code for
themed-blog/theme-mono, just no longer exercised via examples/blog.
`web/main.js`'s playground (glob-seeded from examples/blog) needed its own
updates: `pickInitialFile()` now opens `main.mdy` when present instead of
assuming a `content/` prefix, the "new file" starter templates dropped the
`content/`-specific one, and the file-level comment documents the "edit this
page" button's new limitation (always disabled for a script-defined site,
since `pages` is always empty) — verified end-to-end in a real headless
Chromium session (build, drafts toggle, live edit, rebuild), not just unit
tests.

### The conventional content/layouts/site.yaml pipeline removed entirely ✅

The checkpoint above kept both models side by side — script-defined sites
folded into `mdy build`/`serve`, the conventional pipeline left running for
themed-blog/theme-mono. Asked directly ("nothing of that built-in convention
should exist"), and confirmed: not "both, script-defined preferred" but
script-defined as the *only* way a site works, themes dropped rather than
reinvented for script mode (no existing precedent to build one on, and
inventing a new feature under an already-large removal wasn't the ask).

Deleted outright: `src/site/theme.js` (`resolveThemeDir`/`loadTheme`),
`src/site/defaults.js` (`DEFAULT_LAYOUTS` — 404/rss/sitemap/robots as JS
string constants, now just `layouts/{404,rss,sitemap,robots}.mdy` files any
script can $.render), `src/site/config.js` (`loadSite`, site.yaml parsing),
`src/site/incremental.js` (`createCache`/`filterKey`/`setsEqual`/
`stableKey` — the whole per-output file-dep/query-dep cache; a
script-defined site was already documented as having no incremental
reuse, so nothing needed it once the conventional path was gone),
`examples/theme-mono`, `examples/themed-blog`, and `mdy new post` (scaffolds
`content/posts/<date>-<slug>.mdy` — a pure content/posts/ convention with
nothing left to scaffold for). `src/site/vault.js` shrank from openVault
plus all its computed-field/draft-filtering/`.md`/`.yaml`/`kind:'file'`/
sidecar machinery down to three surviving pure functions (`slugify`,
`normalizeDate`, `rfc822` — still used by script-site.js); `src/site/
search.js` shrank to just `tokenize` (`buildSearchIndex`'s host-side batch
indexing over openVault's pages/bodies had no more caller). `build.js`
itself shrank from ~550 lines (openVault wiring, theme/default-layout
injection, the whole `buildOutput`/incremental-cache engine, resolveLayout,
pagination, tag/homepage/404/rss/sitemap/robots/search-index generation) to
~65: `renderSite` is now just "resolve root/entry, call renderScriptSite,
reshape the result" — `resolveLayout` went with it (no more `layout:` front
matter or section-name convention to resolve against); `urlToOutFile`
survived as a generic string utility, still harmless to keep. `serve.js`
lost its `theme`/`cache` threading (a `firstRun` boolean replaced the
`cache === undefined` first-build check).

Fallout across the test suite (318 → 234 tests — the difference being
exactly the conventional-only coverage that no longer applied, not lost
coverage of anything still real): `test/theme.test.js`, `test/
incremental.test.js`, `test/incremental-render.test.js` deleted outright
(nothing left to test). `test/search.test.js` kept only its `tokenize`
tests. `test/site-vault.test.js` shrank to the three surviving pure-function
tests (openVault's own extensive `.md`/`.yaml`/`kind:'file'`/sidecar
coverage went with the function). `test/build.test.js` lost its
`resolveLayout` test and entire theme block, and its `$.resize` fixture
(previously a synthetic *conventional* site — `layouts/`+`content/`+
`site.yaml`) became a synthetic script-defined one (a bare `main.mdy`
calling `$.resize` and `$.emit`ting the result) — same property proved
(a real, correctly-sized thumbnail lands in `binaryOutputs`, the source is
untouched), different fixture shape. `test/serve.test.js` lost its themed-
site block. A file that had escaped every prior sweep, `test/
site-memory-build.test.js` (renderSite-over-`memoryFsProvider` — the
browser playground's own foundation), surfaced only when the full suite
ran: every one of its five tests used `kind:'file'`/`content/posts/`/
`site.yaml` fixtures and failed outright once `renderSite` stopped
recognizing them; rewritten as script-defined-site fixtures (a bare
`main.mdy` per test, same properties proved — in-memory zero-disk-I/O
rendering, live-edit-reflected-on-next-render, raw-file `$.find`, `$.resize`,
`$.emit`-driven aggregate pages) rather than deleted, since "renderSite
works entirely in memory" is still exactly the property the playground
depends on. `test/cli.test.js` lost its three `mdy new post` tests and its
`layout:`-front-matter-error test (no more mechanism to error about);
gained one `mdy build --entry` test in their place.

The moral, consistent with this file's own "real bugs a real example finds"
theme: `test/site-memory-build.test.js` wasn't found by reasoning about
what depends on what — it was found by actually running the full suite
after the "done" pieces looked done, the same lesson as `post.mdy`'s "More
like this" and the `.md` tags bug much earlier in this project.

### Importing another mdy project — `{% import %}` ✅

Hugo/Jekyll-style themes let a site pull in someone else's `layouts/` +
`static/` — removed outright along with the rest of the conventional
pipeline (above), on the reasoning that themes-as-a-concept needed host
convention to exist. Asked directly whether importing should come back, the
answer was narrower and better: not themes specifically, and not a host
convention — a script importing another mdy project, the same way JS code
imports a package, entirely from `main.mdy` itself:

```
{% import style from "../blog-style-x" %}
{% const page = style.render({ path: "layouts/base.mdy" }, { content: html }) %}
```

`style` is a plain object — `{ render, find, findOne, resize }`, the exact
shape `openDocumentSet` itself returns (plus `resize`, images.js's one
native whose behavior depends on which directory its source file lives in)
— NOT a merged pool of every file from every package. `"../blog-style-x"`
is walked and compiled into its OWN document set, so its own internal
`$.find`/`$.render` calls keep working exactly as if it were rendered
standalone (its `"layouts/base.mdy"` doesn't collide with the importer's
own file of the same name, and neither package has to know ahead of time
that it's importable). The importer reaches in explicitly, through
`style`'s own methods.

**Why `import` can't be real JS.** Every `{% %}` block is spliced directly
into a compiled function body (`compileTemplateSource`/`buildProgram`) —
and a real ES `import` statement is only legal at a module's top level, not
inside a function. So `{% import name from "spec" %}` is parsed by mdy's
own compiler, the same way `extractDataBlocks` already pulls ```data```
fences out before the rest of the template compiles — `src/site/
imports.js`'s `extractImports` scans for the shape (nothing else in the
same tag — mixing an import with other code isn't recognized, and
`import`/`from` would surface as a JS syntax error if it reached the VM),
and rewrites it to a plain object literal the VM can actually run:
`$.__importRender`/`__importFind`/`__importFindOne`/`__importResize`, four
generic natives (not import-specific — any native gets `(docIndex,
docData)` appended after the template's own args now, a small mdy.js change
useful beyond imports too) that dispatch by the literal spec string plus
which document is calling, resolved against a table `buildImportGraph`
builds upfront.

**Resolving the graph.** `buildImportGraph(absDir, ctx)` walks `absDir`,
extracts every file's imports, resolves each spec relative to the
DECLARING file's own directory (`ancestors`/`ctx.cache`, not the whole
site's root), and recurses — transitively, so an imported package can
import its own dependencies too. Two real bugs surfaced building this,
both instructive:

- **False-positive cycle detection.** The first version tracked "currently
  resolving" as one flat `Set<absDir>` shared across the whole graph. Two
  *different* files in the *same* package importing the *same* third
  package (a normal "diamond", not a cycle) both start resolving it before
  either finishes — the second call saw the first's still-in-progress
  entry and threw "cycle detected". Fixed by threading an explicit
  ANCESTOR CHAIN as a recursion parameter (the path from the root down to
  whoever is calling) instead of a flat "anyone, anywhere" set — a real
  cycle (A → B → A) has `absDir` reappear in ITS OWN chain; a diamond does
  not, and dedupes via `ctx.cache` instead, which is a separate concern
  from cycle detection and has to be checked separately from it.
- **`node:path` doesn't exist in the browser.** Resolving a spec needs
  dirname/join/resolve — reached for real `node:path`, which works
  everywhere renderScriptSite runs from disk, but web/'s in-browser
  playground bundles through Vite, which externalizes `node:path` to a
  non-functional stub (nothing calls it there normally — nodeFsProvider
  only imports it lazily, inside methods the browser path never calls).
  Surfaced as "join is not a function" in the actual bundle, past the point
  unit tests alone would catch it (mdy.js/vault.js's own tests all run
  under Node). Fixed with three small hand-rolled POSIX-only path
  functions in imports.js instead of importing the real module — this
  project has no Windows-path handling anywhere else either, so plain
  string math is both correct and portable here in a way the real module
  isn't.

**Making the browser playground work at all.** memoryFsProvider was
"there is only ever one vault" by design — every method took a `root` and
ignored it. Imports need more than one root even in memory (the seed
*and* whatever it imports), so `root` now means something: `/` (or `.`/``)
still means "the whole flat map, no prefix" (every existing caller keeps
working unchanged), and any OTHER root is a namespace prefix into the same
Map. web/main.js seeds `examples/blog-style-x` under a `"blog-style-x/"`
prefix accordingly. This also uncovered that `preparePreviewHtml`/
`resolveImageBytes` (the srcdoc-iframe-has-no-real-origin workarounds —
inlining `static/style.css`, `static/search.js`, and image bytes) hardcoded
the `static/` lookup to the site's own root — fixed by having `doRender`
capture `renderSite`'s new `roots` return value (every resolved import,
root's own last) and searching all of them, root's own first, same
precedence buildSite's static/ copy order and serve.js's readStatic give a
real disk build.

**The demo.** `examples/blog-style-x` is `layouts/base.mdy` (the outer HTML
shell — head/nav/search-widget/footer) plus `static/` (style.css,
search.js, logo.png + its sidecar) — the "skin" — extracted out of
`examples/blog`, which now imports it. Swapping styles is swapping which
directory `main.mdy`'s one `import` line points at; nothing else in the
site's own content/URL/tag logic changes. `about.mdy` needed its own
`{% import %}` too (imports aren't inherited — each document that wants
one declares it) to reach `style.resize`/`style.findOne`/`style.render`
for its logo thumbnail and metadata sidecar, previously plain
`$.resize`/`$.findOne`/`$.render` against files that lived in the same
root. build.js's static/ passthrough and serve.js's static lookup both
walk every root in the import graph now, not just the site's own, with the
site's own winning any filename collision (Hugo/Jekyll's "site overrides
theme", same precedence, no host convention needed to get it).

### JS modules in templates — `await import("./lib.js")` ✅

`{% import %}` (above) imports another mdy *package*. The other obvious
import — a plain JS module, for shared template logic that isn't a
document — became possible when lamassu-js exposed the engine's host
module loader (`js_set_module_loader`/`js_eval_module`, already in the C
API as "phase 7", now bridged through wasm_api.c to the npm wrapper as
`createLamassu({ loadModule, canonicalizeModule })` + `evalModule` +
guest-side dynamic `import()`).

```
{% const util = await import("./lib/util.js") %}
{{ util.slugify(self.title) }}
```

How the pieces line up, host-side to guest-side:

- **wasm_api.c / index.js (lamassu-js).** The loader rides the same
  Asyncify suspension as `__hostcall`: a guest `import` suspends the whole
  wasm execution while the embedder's async `lamassuLoadModule(specifier,
  referrer)` fetches source; a synchronous `lamassuCanonicalizeModule`
  maps raw specifier → registry identity first. Same non-reentrancy
  caution as natives.
- **mdy.js.** `buildProgram`'s IIFE became `await (async () => { … })()`
  — the engine resolves top-level await into the completion value
  (verified before committing to the shape), so `await` is now legal
  anywhere in template code. It had to: `import()` is an expression but
  its result is a promise, and a real `import` statement remains
  impossible (function body, not module top level — same reasoning as
  `{% import %}`'s tag rewrite). `openDocumentSet` grew
  `options.loadModule`/`options.canonicalizeModule`, called with
  `(docIndex, docData)` appended — the same contract `options.natives`
  already uses, and for the same reason: a template's own import (referrer
  `""`) resolves relative to the FILE that wrote it.
- **imports.js.** `buildImportGraph` wires the vault-backed loader per
  document set: the canonicalizer makes every specifier an absolute vault
  path (so `./util.js` from two directories is two modules, one file
  reached two ways is one), and the loader reads through the set's own
  `fs` — `.js`/`.mjs` only, and only INSIDE the package's own directory,
  mirroring the package-import design (an imported package's templates
  load their own modules through their own set's loader; nothing reaches
  across roots).
- **vm.js.** The subtle one: the engine's module registry caches evaluated
  modules per canonical specifier for the VM instance's lifetime, and
  runProgram's instances are POOLED — without care, a watch-mode rebuild
  after editing a `.js` module would be served the stale cached copy by
  whichever pooled instance loaded it first. `runProgram` tracks whether
  the eval's loader ever fired and resets the instance before returning it
  to the pool. The common no-modules render keeps its warm instance;
  correctness costs only the renders that actually imported something.
  `test/imports.test.js` pins this with an edit-between-renders test.
