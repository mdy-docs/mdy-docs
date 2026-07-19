# mdy docs

Markdown documents with YAML front matter data and a JavaScript template layer
(`{{ … }}` / `{% … %}`). A document carries its own data and renders itself.

Files using these capabilities use the **`.mdy`** extension.

## Structure

An `.mdy` source is read in two passes:

1. **Split into documents** on bare `---` lines. Everything before the first
   `---`, between any two, and after the last is a document; a source with no
   `---` is a single document. Documents that are only whitespace are dropped.
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
5. **Render** the markdown to HTML with markdown-it.

## Template syntax

| Syntax | Meaning |
| --- | --- |
| `{{ expr }}` | append the expression's value to the output |
| `{% code %}` | run statements, append nothing (loops, `if`, `let`, …) |
| `\{{` / `\{%` | a literal `{{` / `{%` |

- **Shared scope**: a `let`/`const` in one tag is visible to every later tag.
- **Whitespace control**: a `{% %}` tag alone on its line leaves no blank
  line, so generated tables and lists stay contiguous.

## Usage

Rendering is async (the database is; the VM instantiates lazily):

```js
import { render, renderToMarkdown, parseDocuments, createProcessor } from 'mdy';

const html = await render(documentSource);           // → HTML
const md   = await renderToMarkdown(documentSource); // → generated markdown
const docs = parseDocuments(documentSource);         // → [{ data, content }, …] (sync)

// Custom markdown-it (e.g. a syntax highlighter for ```yaml blocks):
import MarkdownIt from 'markdown-it';
const { render: r } = createProcessor({
  md: new MarkdownIt({ highlight: (code, lang) => myHighlight(code, lang) }),
});
```

## CLI

```
mdy [input...] [options]

  input                 .mdy files; reads stdin if omitted or "-". Multiple
                        files form ONE document set, in order (template file
                        first, then data files)
  -o, --out <file>      write output to <file> (default: stdout)
      --html            emit HTML instead of generated markdown
      --each            render the entry template once per other document,
                        using that document's data
      --doc <index>     render document <index> of the document set (default 0)
      --emit-js         emit the compiled JavaScript of each document instead of
                        rendering (debug; combine with --doc for a single one)
  -d, --data <k=v>      add a context value (repeatable; JSON-parsed if possible)
      --data-file <f>   merge a YAML/JSON file into the context
  -w, --watch           re-render whenever an input (or --data-file) changes
  -h, --help            show help
```

```sh
mdy report.mdy                        # → generated markdown on stdout
mdy report.mdy --html -o report.html  # → HTML file
mdy report.mdy -o report.md -d env=prod --data-file overrides.yaml
mdy invoice.mdy invoice-data.mdy --each   # template × each data document
mdy report.mdy -o report.md --watch   # live re-render on save
cat report.mdy | mdy - --html         # stdin → HTML on stdout
```

- Output goes to **stdout**; pass `-o` to write a file (it won't overwrite an input).
- A non-`.mdy` input is processed but **warns** on stderr.
- Context from `--data` / `--data-file` overrides a document's own data
  (front matter and data fences).
- `--watch` keeps running: every save of any input file (or the
  `--data-file`) re-renders and rewrites the output, logging a timing line to
  stderr. A failing render reports the error and keeps watching — the
  previous output is left intact — so it pairs with an editor the way the
  web playground's live preview does. (Watches the containing directories via
  the filesystem layer below, so atomic editor saves don't drop the watch;
  not available with stdin.)

## Filesystem

Reading, writing, and watching files — for a CLI, a build tool, or a
browser app with no disk at all — is exported alongside the template
engine, not a separate concern: `mdy`'s own CLI is a real consumer of it,
not a second, hand-rolled implementation living next to it.

```js
import { nodeFsProvider, memoryFsProvider, opfsFsProvider, walkVault, walkFiles } from 'mdy';

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
safe over real binary files (images, anything).

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

Fences are located with markdown-it itself, so CommonMark rules apply — a
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

Document 0 (the entry) is rendered by default; it composes the rest via `$`. Pass
`--doc <index>` (or the `entry` argument to `render`/`renderToMarkdown`) to render
a different one. Give documents identifying attributes and both the data
selection and the template selection become queries — no document needs to
know another's position — see
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

A document set doesn't have to live in one file. Passing **multiple sources**
(CLI: several input files; library: an array of strings) concatenates their
documents into one set, so a display template can stay in its own file and be
applied to data kept elsewhere:

```sh
mdy invoice.mdy invoice-data.mdy --each
```

`--each` renders the entry document (the template) once **per other document**
in the set, with that document's front matter as its data. The template's own
front matter acts as defaults — each record overrides it, and `--data` /
`--data-file` override both — so the template still renders standalone with
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

From the library, `renderEach` returns one markdown string per record:

```js
import { renderEach, renderDocumentSet } from 'mdy';

const pages = renderEach([templateSource, dataSource]); // → string[]
```

Without `--each`, the combined set behaves exactly like a single file: the
entry document renders and can address every document — including those from
other files — through `$` (`$.documents`, `$.data(i)`, `$.render(i, data)`),
and `--doc` / the `entry` argument index into the combined set. See
[`examples/invoice.mdy`](examples/invoice.mdy) and
[`examples/invoice-data.mdy`](examples/invoice-data.mdy).

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
mdy report.mdy --emit-js           # compiled JS of every document
mdy report.mdy --emit-js --doc 1   # just document 1
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

### Playground

A browser playground ([`web/`](web/)) runs the full pipeline client-side —
both engines are WebAssembly, so documents parse, store, query, and render
entirely in the browser:

```sh
npm run web            # dev server → http://localhost:8090
npm run web:build      # production bundle → dist-web/
```

Left pane: editable source (pick an example, edits render live). Right pane:
rendered preview, generated markdown, and the compiled JS of each document.

## Test

```
npm test
```
