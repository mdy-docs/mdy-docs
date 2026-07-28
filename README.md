# mdy docs

Markdown documents with YAML front matter data and a JavaScript template layer
(`{{ … }}` / `{% … %}`). A document carries its own data and renders itself.

Files using these capabilities use the **`.mdy`** extension. On top of the
document engine, mdy-docs also ships a static site generator: every site is
a **script-defined site** — one entry document decides everything itself
(URLs, layouts, tags, feeds, a search index) via `$.find`/`$.render`/
`$.emit`, no host-side content/layouts/site.yaml convention — built
entirely on the primitives below; see [Static sites](#static-sites).

## Structure

An `.mdy` source is read in two passes:

1. **Split into documents** on bare `---` lines. Everything before the first
   `---`, between any two, and after the last is a document; a source with no
   `---` is a single document. Documents that are only whitespace are dropped
   (but an empty or all-whitespace source is a single empty document, so an
   empty file renders to nothing rather than erroring).
2. **Split each document on its first bare `+++` line.** The text before `+++`
   is YAML front matter (parsed into a data object); the text after it is the
   markdown body — the template. A document with no `+++` is all body.
3. **Extract ` ```data ` fences from the body.** Each is parsed as YAML and
   merged into the document's data (front matter first, later fences win);
   inline `#hashtags` union into `data.tags`. Details below.

```
title: Report          ← YAML front matter
author: Grace Hopper
+++                     ← front matter separator
# {{ title }}          ← markdown body (the template)
By {{ author }}.
---                     ← document separator
title: Appendix        ← the next document begins
+++
…
```

## Pipeline

1. **Parse** — split the source into documents and, for each, its front matter
   data and markdown template (as above).
2. **Store** — every document's data is inserted into an in-memory
   [nisaba](https://github.com/mdy-docs/nisaba-db) collection, so templates
   can query the document set MongoDB-style (`$.find`).
3. **Compile** — the body becomes a single JavaScript statement sequence, so
   all template tags share one scope.
4. **Run** the compiled template inside the
   [lamassu](https://github.com/mdy-docs/lamassu-js) VM — a sandboxed
   JavaScript-subset engine in WebAssembly — with the document's data bound as
   identifiers, producing markdown. Template code has no host access.
5. **Render** the markdown to HTML with the unified pipeline
   (remark-parse → remark-gfm → remark-rehype → rehype-raw → rehype-stringify).

## Template syntax

| Syntax | Meaning |
| --- | --- |
| `{{ expr }}` | append the expression's value to the output |
| `{% code %}` | run statements, append nothing (loops, `if`, `let`, …) |
| `\{{` / `\{%` | a literal `{{` / `{%` |

- **Shared scope**: a `let`/`const` in one tag is visible to every later tag.
- **Missing data is graceful**: an identifier the context doesn't carry
  reads as `undefined` instead of throwing — so a shared template can
  reference optional properties and fall back explicitly:
  `{{ age ?? 'unknown' }}`, `{{ (skills ?? []).join(', ') }}` (ternaries
  and `?.` work too). Only bare-identifier resolution is forgiving;
  `{{ missing.prop }}` is still a real `TypeError`, and every other error
  still fails the render. `{{ missing }}` alone renders the string
  `undefined` — write the fallback when you don't want that. (Under the
  hood the executor re-runs a document whose render hit
  `ReferenceError: x is not defined` with `x` bound to `undefined`;
  templates are deterministic — the VM has no clock or randomness — so
  the replay is exact.)
- **Whitespace control**: a `{% %}` tag alone on its line leaves no blank
  line, so generated tables and lists stay contiguous.

## Usage

Rendering is async (the database is; the VM instantiates lazily):

```js
import { render, renderToMarkdown, parseDocuments, createProcessor } from 'mdy';

const html = await render(documentSource);           // → HTML
const md   = await renderToMarkdown(documentSource); // → generated markdown
const docs = parseDocuments(documentSource);         // → [{ data, content }, …] (sync)

// Custom plugins (e.g. a syntax highlighter for ```yaml blocks):
import rehypeHighlight from 'rehype-highlight';
const { render: r } = createProcessor({
  remarkPlugins: [],                    // run on the markdown (mdast) side
  rehypePlugins: [rehypeHighlight],     // run on the HTML (hast) side
});
```

## CLI

```
mdy [path] [options]

  path                   A .mdy file, a directory, or "-"/omitted for stdin.
                        A FILE renders just that file — its own `---`-split
                        documents, the first is the entry — with no access
                        to any other file.
                        A DIRECTORY is scanned in full: every file under it
                        is inserted as a raw document (path/name/ext/size/
                        mtime, plus front matter for .mdy files), so the
                        entry document's $/$.find/$.render reach any of them
                        — it alone decides what any file/path means (which
                        are "posts", what URL/layout each gets, …), entirely
                        in template code (see Static sites). The entry
                        defaults to main.mdy; --entry picks another file.
  -o, --out <file>      write output to <file> (default: stdout); if <file>
                        is an existing directory, $.emit output is written
                        under it instead (see Static sites)
      --html            emit HTML instead of generated markdown
      --entry <path>    directory input only: the entry document's path,
                        relative to the directory (default: main.mdy)
      --emit-js         emit the compiled JavaScript instead of rendering
                        (debug): every document for a file input, just the
                        entry document for a directory input
  -d, --data <k=v>      add a context value (repeatable; JSON-parsed if possible)
      --data-file <f>   merge a YAML/JSON file into the context
  -w, --watch           re-render on any relevant change (the file, or for a
                        directory input any file under it, plus --data-file)
  -h, --help            show help

mdy build [site-dir] [--out <dir>] [--drafts] [--future] [--entry <path>]
      render a whole site (see Static sites, below)
mdy serve [site-dir] [--port <n>] [--drafts] [--future] [--entry <path>]
      dev server for a site: watch, rebuild, live reload
```

```sh
mdy report.mdy                        # → generated markdown on stdout
mdy report.mdy --html -o report.html  # → HTML file
mdy report.mdy -o report.md -d env=prod --data-file overrides.yaml
mdy report.mdy -o report.md --watch   # live re-render on save
cat report.mdy | mdy - --html         # stdin → HTML on stdout
mdy ./my-site                         # scan the dir, render main.mdy
mdy ./my-site --entry other.mdy -o dist   # write $.emit output

mdy build ./my-blog --out ./dist      # build a site
mdy serve ./my-blog                   # dev server at http://localhost:4321
```

- Output goes to **stdout**; pass `-o` to write a file (it won't overwrite the input).
- A non-`.mdy` file input is processed but **warns** on stderr.
- A directory input is walked with `walkRawSources` (raw identity only, see
  Filesystem/Static sites below) and its entry (`main.mdy`, or `--entry`)
  is the one document that decides what any other file/path means. A
  document with no `$.emit` calls just renders to stdout/`-o` as always;
  `$.emit` output is written under `-o` only when it's an existing
  directory, otherwise it's just listed on stderr.
- Context from `--data` / `--data-file` overrides a document's own data
  (front matter and data fences).
- `--watch` keeps running: every save of any input file (or the
  `--data-file`) re-renders and rewrites the output, logging a timing line to
  stderr. A failing render reports the error and keeps watching — the
  previous output is left intact — so it pairs with an editor the way
  mdy-web's live preview does. (Watches the containing directories via
  the filesystem layer below, so atomic editor saves don't drop the watch;
  not available with stdin.)

## Filesystem

Reading, writing, and watching files — for a CLI, a build tool, or a
browser app with no disk at all — is exported alongside the template
engine, not a separate concern: `mdy`'s own CLI is a real consumer of it,
not a second, hand-rolled implementation living next to it.

```js
import { nodeFsProvider, memoryFsProvider, opfsFsProvider, walkVault, walkFiles, walkRawSources } from 'mdy';

const sources = await walkVault('/path/to/docs'); // → openDocumentSet-ready { text, meta } sources
```

Three providers, one interface (`list`/`read`/`readBinary`/`mtime`/`size`,
plus `write`/`writeBinary`/`remove`/`watch` where it makes sense), so code
written against one runs unchanged against any of them:

- **`nodeFsProvider()`** — the real filesystem (the CLI's own default).
  `watch(root, callback)` is one native, recursive `fs.watch` for a whole
  tree — no separate polling or manual recursion needed.
- **`memoryFsProvider(files)`** — a `Map<path, string | Uint8Array>` held
  by reference, for a consumer with no disk (a browser app). No `watch()`:
  nothing outside the same JS heap can change it.
- **`opfsFsProvider()`** — the browser's real, persistent origin-private
  filesystem. `watch()` uses the native
  [`FileSystemObserver`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemObserver)
  API where available, polling (`watchByPolling`, also exported standalone)
  everywhere else.

`walkVault(root, options)` turns a directory into `openDocumentSet`-ready
sources — file identity only (`path`, `mtime`), no interpretation of what
a path *means* (a blog wants a URL from it; a wiki wants a page title;
that's the embedder's business). `walkFiles(root, options)` is the
non-document counterpart: every file, any extension, identity only
(`path`, `name`, `ext`, `size`, `mtime`) — content is never read, so it's
safe over real binary files (images, anything). `walkRawSources(root,
options)` combines the two for "a whole directory IS the document set":
every file gets `walkFiles`' identity, but `.mdy` files also carry their
real text (so mdy's own parser extracts front matter and a live template
body) — nothing else is ever read as text. This is what a directory `path`
argument to the CLI uses (see CLI, above): one entry document, `$.find`ing
and `$.render`ing its way through every other file, with no host-side
interpretation of what any path means layered on first.

The static site generator (below) is the first real consumer of this
layer's path-*interpretation* — URLs, sections, dates, drafts — layered on
top in `src/site/vault.js`, not baked into the generic walk itself.

## Front matter

A document's front matter is the YAML before its first bare `+++` line. It must
be a mapping; to group values, nest them:

```
report:
  title: "Invoice #42"
  owner: Grace Hopper
+++
# {{ report.title }}
```

- **No `+++`** ⇒ the whole document is body with no data (plain markdown just
  works).
- **A leading `+++`** (nothing before it) ⇒ an empty front matter block, i.e.
  no data.
- **A trailing `+++`** (nothing after it) ⇒ a data-only document with an empty
  body — handy for data files (see below).

Everything after `+++` is the body, verbatim — it's plain markdown, so blank
lines there are fine and are preserved (markdown ignores leading ones at render
time anyway).

## Data fences

Data can also be declared inline in the body: every ` ```data ` fence is
parsed as YAML, merged into the document's data, and stripped from the output.
All other fences (` ```yaml `, ` ```js `, …) are left alone and render as
normal code blocks.

````
# {{ report.title }}

```data
report:
  title: "Invoice #42"
```
````

- Each fence must be a **YAML mapping**; an empty fence contributes nothing.
- Merging is shallow, later keys win: front matter first, then each fence in
  document order (`--data` / `--data-file` still override everything).
- A `tags:` key in a fence unions with declared and inline tags (see
  Hashtags).
- Fences are collected at parse time, **before** the template runs, so they
  are order-independent — template code may reference data declared anywhere,
  even below it. See
  [`examples/order-independent.mdy`](examples/order-independent.mdy).

Fences are located with a real markdown parser (remark), so CommonMark rules
apply — a
` ```data ` example shown inside a longer outer fence (like the one above) is
display, not data.

## Hashtags

Twitter-style `#tags` written in the body feed the document's data:

```
This note is about topic #fred, filed under #budget-2026.
```

At parse time the **raw body** is scanned and the tags land in `data.tags`,
unioned with any `tags:` list declared in front matter or a ` ```data ` fence
(a single string is one tag). Tags are lowercased and deduped — `#Fred` and `#fred` are the same tag —
and the body text is untouched, so the tag renders as ordinary text, just like
on Twitter.

What counts as a tag: `#` preceded by whitespace (or line start), then a
letter, then letters/digits/`_`/`-`. This is chosen so markdown stays
unambiguous:

- `# heading` is a heading (space after `#`), never a tag.
- `#42` (issue-number style) has no letter — not a tag.
- `page#top` (URL fragment) has no preceding whitespace — not a tag.
- Code fences, inline code spans, and `{{ }}` / `{% %}` tag contents are
  skipped.
- `\#fred` opts out (markdown's own escape; it renders as `#fred`).

Because the scan runs on the raw template body, tags are **static** metadata:
a tag generated at render time (`#{{ topic }}`) doesn't count, and a
document's tags are known without rendering it — which is what lets `$` query
them across a document set (`$.withTag`, below). One consequence of feeding
`data.tags`: the `tags` front matter key has reserved meaning and must be a
list (or a single string). The key is only present when a document actually
has tags.

The scanner is exported as `extractTags(body)` for standalone use, and
[`examples/hashtags.mdy`](examples/hashtags.mdy) shows an entry document
composing its siblings by tag.

## Multiple documents in one file

Bare `---` lines split a file into documents (the splitting rules are in
[Structure](#structure)). Documents are **anonymous and positional**: the
first is document 0. Each is a standard mdy unit (front matter + template
body), exactly as if it were a separate file.

The set's data lives in a [nisaba](https://github.com/mdy-docs/nisaba-db)
collection, and templates get a `$` helper that queries it **by data
attributes**, MongoDB-style:

| Call | Result |
| --- | --- |
| `$.find(query)` | data of the documents matching `query`, in document order (full Mongo operators: `{ age: { $gt: 35 } }`, array-contains, …) |
| `$.findOne(query)` | first match, or `null` |
| `$.render(target, data)` | run the document matching `target` (a query — or an index) with `data` overriding its own; returns markdown |
| `$.withTag(tag)` | shorthand for `$.find({ tags: tag })` (see Hashtags) |
| `$.emit(path, content)` | produce a named output as a side effect of this render — see `openDocumentSet`'s `onEmit` below; a no-op if the embedder didn't ask for it |
| `$.data(i)` | document `i`'s data (positional) |
| `$.documents` | `[{ index, data }, …]` (positional) |
| `$.count` | number of documents |
| `$.parse(markdown)` | markdown → [mdast](https://github.com/syntax-tree/mdast) syntax tree (plain JSON), in the render pipeline's own dialect — walk another document's rendered output (`$.parse($.render(target))`), build a TOC from its headings, … |
| `$.stringify(tree)` | mdast syntax tree → markdown — the inverse of `$.parse`, so a template can assemble or rewrite a tree and turn it back into markdown |
| `$.table(rows, align?)` | 2-D array → GFM table markdown, first row as the header: `$.table([['name', 'age'], ...$.find().map((m) => [m.name, m.age])])`. Serialized by the same remark-gfm pipeline as everything else, so columns are padded, pipes in cells escaped, and inline markdown (`**bold**`, links) kept. `align` is an optional per-column array — `['left', 'center', 'right']` or initials `['l', 'c', 'r']` |
| `$.toc()` | with no argument: drops a placeholder that is replaced, at the end of the render, with a nested link list of **this document's** final headings — including generated ones, and after any `$.transform`; anchors match the heading `id`s the HTML pipeline emits. `$.toc(markdownOrTree)` instead returns `[{ depth, text, slug }]` entries to render however you like (e.g. `$.toc($.render(1))` for a cross-document TOC) |
| `$.transform = fn` | not a call — an assignment: install a `(tree) => tree` transform over the document's final mdast (return a new node, or mutate in place and return nothing). It runs **inside the sandbox** after the template finishes, and the resulting tree feeds straight into the HTML pipeline with no re-stringification |

Document 0 (the entry) is rendered by default; it composes the rest via `$`.
From the library, the `entry` argument to `render`/`renderToMarkdown` (or
`openDocumentSet(...).render(target, data)`) renders a different one — the
CLI always renders document 0 (a file's first document, or a directory
input's `main.mdy`/`--entry`). Give documents identifying attributes and
both the data selection and the template selection become queries — no
document needs to know another's position — see
[`examples/document-set.mdy`](examples/document-set.mdy):

```
title: Team Roster
+++
# {{ title }}

{% for (const m of $.find({ role: 'member' })) { %}
{{ $.render({ template: 'member-card' }, m) }}
{% } %}
---
template: member-card
+++
### {{ name }}
- Age: {{ age }}
---
role: member
name: Alice
age: 30
+++
```

The entry finds every `role: member` document and renders the
`template: member-card` document once per match, with the member's data. The
last document is data-only (a trailing `+++`). Adding another member is
appending another data document — nothing else changes.

Two structural lines to watch for inside a body:

- A bare `---` line always **splits documents**, so use `***` or `___` for a
  thematic break (`<hr>`).
- The first bare `+++` line **ends the front matter**, so a plain-markdown
  document should not contain a lone `+++` line (fence it in a code block if you
  need one literally).

## One template, many data documents

A document set doesn't have to live in one file. From the library, passing
**multiple sources** (an array of strings) concatenates their documents into
one set, so a display template can stay in its own file and be applied to
data kept elsewhere — the CLI itself takes a single input (see CLI, above),
so this is a library-level feature; a directory input's entry can reach the
same result by placing the data alongside it and `$.find`ing it directly.

```js
import { renderEach, renderDocumentSet } from 'mdy';

const pages = renderEach([templateSource, dataSource]); // → string[], one per data document
```

`renderEach` renders the entry document (the template) once **per other
document** in the set, with that document's front matter as its data. The
template's own front matter acts as defaults — each record overrides it, and
`extraContext` overrides both — so the template still renders standalone with
its sample data. A data file is just `---`-separated documents, each ending in
a trailing `+++` so it is data-only with an empty body:

```
report: { title: "Invoice #57", owner: Ada Lovelace }
items:
  - { name: Sprocket, qty: 2, price: 12.00 }
+++
---
report: { title: "Invoice #58", owner: Alan Turing }
items:
  - { name: Cog, qty: 10, price: 1.10 }
+++
```

`renderDocumentSet`/`render`/`renderToMarkdown` behave exactly like a single
file: the entry document renders and can address every document — including
those from other sources — through `$` (`$.documents`, `$.data(i)`,
`$.render(i, data)`), and the `entry` argument indexes into the combined set.
See [`examples/invoice.mdy`](examples/invoice.mdy) and
[`examples/invoice-data.mdy`](examples/invoice-data.mdy) (run together via
`renderEach([...])` from a script, or each individually via the CLI).

See [`examples/`](examples/) for runnable documents and
[`test/mdy.test.js`](test/mdy.test.js) for behavior.

## Compiled JavaScript (debugging)

Each document body is transpiled to a statement sequence: literal text becomes
`__out += "…"`, `{{ expr }}` becomes `__out += (expr)`, and `{% code %}` is
inserted verbatim. The statements reference data as bare identifiers; the
executor prepends `let` bindings for the context keys (`contextBindings`) —
there is no `with`, so only keys that are valid identifiers become bindings
(others stay reachable as `__ctx["the key"]`).

That source is available three ways:

```js
import { compileTemplateSource, compileTemplate, contextBindings } from 'mdy';

const src = compileTemplateSource(body); // the statement sequence
const gen = compileTemplate(body);       // gen.source === src
```

```sh
mdy report.mdy --emit-js             # compiled JS of every document in the file
mdy mysite --emit-js                 # compiled JS of just the entry document (main.mdy/--entry)
```

`compileTemplate` runs the statements in the **host** runtime via
`new Function` — a debug path, deliberately simple and **not sandboxed**. The
real pipeline never uses it: `render`/`renderToMarkdown` assemble a
self-contained program per render (context JSON + bindings + `$` helper +
compiled statements) and evaluate it inside the lamassu VM. `$` calls that
need the host (`find`/`findOne`/`render`) are **async host natives**
(lamassu's `__hostcall`): the VM execution suspends while the host answers —
a nisaba query, or a nested render on another pooled VM instance — and
resumes with the result. See `buildProgram` in [src/mdy.js](src/mdy.js) and
[src/vm.js](src/vm.js).

## Security

Documents rendered through `render` / `renderToMarkdown` / the CLI execute
inside the lamassu VM: a JavaScript-subset interpreter compiled to
WebAssembly, with no host runtime access (`typeof process` and
`typeof Function` are `undefined` in template code) and the engine's own
bounded CPU/memory/stack. Template code can reach exactly two things: its
document data, and the `$` document-set API.

The exception is `compileTemplate()`, which executes in the host via
`new Function` for debugging — never feed it untrusted documents.

## Static sites

A static site generator — in the family of Hugo / Jekyll / Eleventy — built
entirely on the primitives above, with one governing idea: every site is a
**script-defined site**. There's no host-side content/layouts/site.yaml
convention deciding what a path means — one entry document (`main.mdy` by
default) does ALL of that itself, in template code, via `$.find`/`$.render`/
`$.emit`. `mdy build`/`mdy serve` (see CLI, above) and the whole
implementation live in [`src/site/`](src/site/); the design brief and
phased history — including how this replaced an earlier conventional
content/layouts/site.yaml pipeline — are in
[docs/site-plan.md](docs/site-plan.md).

A site directory is just `walkRawSources(root)` (`src/vault.js`) fed into
`openDocumentSet`: every file gets its raw identity (`path`/`name`/`ext`/
`size`/`mtime`) plus whatever its own file FORMAT means — the same "the
format's job, not a convention" reasoning as `.mdy`'s own front matter:

- **`.mdy`** — real text, front matter + a live template body, exactly like
  any other document.
- **`.md`** — real text lands in `meta.body` (never compiled as a template
  — a bare `---`/`{{ }}` in real prose must not be reinterpreted), plus
  inline `#hashtag`s extracted into `meta.tags`.
- **`.yaml`/`.yml`** — parsed as a YAML mapping, its own fields merged
  directly into `meta` (pure data, no body) — only `path` is reserved;
  `name`/`ext`/`size`/`mtime` are fallback defaults, not a mask, so a
  record's own `name`/`size` field isn't shadowed by the file's. A
  non-mapping or unparseable file just degrades to an identity-only record
  (a warning, not a failure).
- **anything else** — raw identity only; a recognized image extension also
  gets `width`/`height` (header-only, via `image-size`), so `$.resize`
  (below) has what it needs with no `kind: 'file'` convention layered on.

One entry document (`main.mdy`, or `--entry`/`options.entry`) then renders,
via `$.find`/`$.render`/`$.emit` — which files are "posts", what URL/layout
each gets, tag grouping, pagination, drafts/future filtering — plus four
small, genuinely host-dependent natives no amount of template JS could
replace: `$.resize` (image codecs, `src/site/images.js`), `$.tokenize` (the
search widget's word-list algorithm, `src/site/search.js`), `$.rfc822` (RSS
pubDate — the lamassu VM forbids `new Date()`), and `$.markdown` (CommonMark
→ HTML, since a script assembling markdown from `$.render` calls has no
other way to turn the result into HTML before an HTML-emitting layout).
None of these four carry any policy of their own — the script decides
everything, these just do the host-only work underneath. `$.emit`'s
outputs are written under `-o` (CLI) or to `dist/`/served in memory (`mdy
build`/`serve`); the entry's own return value is the same generated
markdown any `$.render` produces, though a whole-site build discards it
(nothing writes it anywhere) since every real output comes from `$.emit`.
One trade-off: no incremental-rebuild reuse — every build/rebuild walks the
whole directory and reruns the entry from scratch (see
[`src/site/script-site.js`](src/site/script-site.js)).

A script can also **import another mdy project** — a style/theme package,
or anything else — the same way JS code imports a package, entirely from
its own code, no host convention involved:

```
{% import style from "../blog-style-x" %}
{% const page = style.render({ path: "layouts/base.mdy" }, { content: html }) %}
```

`style` is `{ render, find, findOne, resize }` — the exact shape
`openDocumentSet` itself returns — bound to `"../blog-style-x"`'s OWN
document set, walked and compiled independently so its internal
`$.find`/`$.render` calls work exactly as if it were rendered standalone.
There's no merged pool of every file from every package; the importer
reaches in explicitly through `style`'s own methods. See
[`src/site/imports.js`](src/site/imports.js) and
[docs/site-plan.md](docs/site-plan.md)'s "Importing another mdy project"
section for the full design (including why `import` is parsed by mdy's own
compiler rather than being real JS, and how imports resolve transitively).

A script can also import a **real ES module** — a plain `.js` file living
in the same package — with the standard dynamic-import expression:

```
{% const util = await import("./lib/util.js") %}
{{ util.slugify(title) }}
```

The module runs inside the same sandboxed VM (it's instantiated by the
engine's own module system — lamassu-js's host module loader — not the
host runtime), may use static `import` internally for its own
dependencies, and resolves relative to the file that wrote the import.
Modules can't reach outside their package's directory. Templates may use
`await` anywhere, not just here — every compiled template runs in an
async context.

**[examples/blog](examples/blog)** is a full instance of this — posts
(`.mdy` *and* `.md`), tags, an RSS feed, sitemap, robots.txt, a search
index, and an `about` page with a resized image and a `.yaml` data record
queried directly — entirely defined by
[examples/blog/main.mdy](examples/blog/main.mdy) plus its `layouts/*.mdy`
shells, importing its look (the base HTML shell, CSS, search widget,
`logo.png`) from **[examples/blog-style-x](examples/blog-style-x)** — swap
that one `import` line for a different package and only the look changes.
Run it identically three ways:

```sh
mdy build examples/blog --out dist   # → dist/
mdy serve examples/blog              # dev server, watch, live reload
mdy examples/blog                    # plain CLI: same walk, same entry
```

`renderSite`/`buildSite`/`serveSite` all resolve `root`'s entry document the
same way `mdy <directory>` does (see CLI, above) — one primitive, one
implementation, whichever way you call it.

**Web editor** ([`packages/mdy-web`](packages/mdy-web/)): the `mdy serve`
loop with the browser as the editor — edit any source file as raw text
(with the vscode extension's syntax highlighting), live-preview unsaved
changes, upload assets, and rebuild on every web save. See its
[README](packages/mdy-web/README.md).

**Live preview demo**
([`packages/mdy-live-preview`](packages/mdy-live-preview/)): a two-pane
Monaco editor + rendered preview, the whole engine running client-side as
WebAssembly, seeded with `examples/document-set.mdy` — `npm run
live-preview`.

## Development

mdy runs on two WASM/C engines, both vendored as git submodules while their
APIs are still being shaped:

- [lamassu-js](https://github.com/mdy-docs/lamassu-js) — the sandboxed
  JavaScript-subset engine that runs template code. Dependency
  `@mdy-docs/lamassu-js`.
- [nisaba-db](https://github.com/mdy-docs/nisaba-db) — the
  MongoDB-driver-shaped embedded document database behind `$.find`.
  Dependency `@mdy-docs/nisaba-db`.

In both cases mdy consumes the engine **only through its npm package
boundary**: the dependency is a `file:` link to the submodule's package
directory, so every import is identical to the published package. When an
API settles, the swap back is mechanical — remove that submodule and point
the dependency at the published version; no code changes.

```sh
git clone --recurse-submodules https://github.com/belteshazzar/mdy-docs.git
make -C third_party/lamassu-js pkg      # build the template engine (needs Emscripten)
third_party/nisaba-db/wasm/build-wasm.sh  # build the database (needs emcc on PATH)
npm install
npm test
```

(The `file:` dependencies also act as a guard: mdy can't be published to npm
until they are switched back to published versions.)

### Web editor

The browser-based site editor lives at
[`packages/mdy-web`](packages/mdy-web/) — its own package, consuming the
engine strictly through the `mdy-docs` package boundary:

```sh
npm run mdy-web        # serve + web-edit examples/blog → http://localhost:3000/__edit
```

## Test

```
npm test
```
