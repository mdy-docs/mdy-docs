# mdy docs

Documents in the **MDY** markup language, with YAML front matter data and a
JavaScript layer on `%` and `%%` lines. A document carries its own data and
renders itself.

Files using these capabilities use the **`.mdy`** extension. On top of the
document engine, mdy-docs also ships a static site generator: every site is
a **script-defined site** — one entry document decides everything itself
(URLs, layouts, tags, feeds, a search index) via `$.find`/`$.render`/
`$.emit`, no host-side content/layouts/site.yaml convention — built
entirely on the primitives below; see [Static sites](#static-sites).

`.md` files are supported too, as CommonMark, and they are a genuinely
different thing rather than a dialect: they go through their own front end
and arrive as the same kind of tree. See [Two front ends, one
tree](#two-front-ends-one-tree).

## Structure

An `.mdy` source is read in two passes:

1. **Split into documents** on bare `---` lines. Everything before the first
   `---`, between any two, and after the last is a document; a source with no
   `---` is a single document. Documents that are only whitespace are dropped
   (but an empty or all-whitespace source is a single empty document, so an
   empty file renders to nothing rather than erroring).
2. **Split each document on its first bare `+++` line.** The text before `+++`
   is YAML front matter (parsed into a data object); the text after it is the
   MDY body. A document with no `+++` is all body.
3. **Extract ` ```data ` fences from the body.** Each is parsed as YAML and
   merged into the document's data (front matter first, later fences win);
   inline `#hashtags` union into `data.tags`. Details below.

```
title: Report            ← YAML front matter
author: Grace Hopper
+++                      ← front matter separator
= {{ res.data.title }}   ← MDY body
By {{ res.data.author }}.
---                      ← document separator
title: Appendix          ← the next document begins
+++
…
```

## Pipeline

1. **Parse** — split the source into documents and, for each, its front matter
   data and MDY body (as above).
2. **Store** — every document's data is inserted into an in-memory
   [nisaba](https://github.com/mdy-docs/nisaba-db) collection, so documents
   can query the set MongoDB-style (`$.find`).
3. **Compile** — the body's `%` and `%%` lines become a single JavaScript
   statement sequence (mdy's own `compileScript`), so all of a document's code
   shares one scope.
4. **Run** it inside the [lamassu](https://github.com/mdy-docs/lamassu-js)
   VM — a sandboxed JavaScript-subset engine in WebAssembly — with the
   caller's request bound as `req` and the document's own answer as `res`,
   producing the lines of MDY the document wrote. Document code has no host
   access.
5. **Parse those lines** with mdy's own parser, which produces
   [hast](https://github.com/syntax-tree/hast) — an HTML syntax tree — and
   splices in every nested render. That is the last change of representation
   there is; writing HTML out of the tree is one function at the end, and
   swapping it is how mdy targets React instead.

## Two front ends, one tree

`.mdy` goes through mdy's parser. `.md` goes through remark (CommonMark, GFM,
GitHub alerts, and rehype-raw for the document's own inline HTML). Both stop
at hast, and everything after that point — composition, `transform`, `$.toc`,
the HTML writer, the React target — sees one kind of thing.

The consequence worth knowing about is containment. A document's tree is
complete before it is composed into anything, so **there is no such thing as
an unclosed element to escape it**: an author's malformed tag reaches the end
of the document it was written in and stops. Pages used to be built by
concatenating every layout's text into one string and parsing it once at the
end, where one `<div` with nothing under it could wrap two documents that
never mentioned it.

## Script syntax

| Syntax | Meaning |
| --- | --- |
| `% code` | one line of JavaScript; what it leaves open encloses the markup under it |
| `%% code` | JavaScript that runs on into the lines under it until its brackets come back to even |
| `{{ expr }}` | interpolate the expression into the line |
| `\%` / `\{{` | a literal `%` at the start of a line, a literal `{{` |

```
% for (const m of $.find({ role: 'member' })) {
- !!{{ m.name }}!! — {{ m.role }}
% }
```

- **Indentation is the markup's, never the code's.** A `%` line is lifted out
  before a single column is counted, so it can sit anywhere across the page —
  hard against the margin, level with the markup it encloses, stepped in with
  the JavaScript block it opens — without moving any of it. It also leaves no
  blank line behind, so generated tables and lists stay contiguous.
- **`%` does not count its own brackets**, deliberately: a `%` line that opens
  a `{` encloses the *markup* under it, which is the whole of how a loop is
  written. `%%` says the opposite — that what follows it is more code — and is
  what lets a callback be written as itself:

  ```
  %% transform((tree) => {
    visit(tree, 'h1', (node) => {
      node.properties.className = ['title']
    })
  })
  ```

  Nothing is taken unless the closing line is really there: an unclosed
  bracket leaves the `%%` line on its own, to fail as the one line it is,
  rather than swallowing the document behind it.
- **Shared scope**: a `let`/`const` on one code line is visible to every later
  one. `$`, `req`, `res` and `transform` are the layer's reserved names.
- **`req` is what the caller asked with; `res` is what the document answers
  with** — two separate objects, never merged. `res.data` holds the document's
  own front matter and data fences: `{{ res.data.title }}`,
  `% for (const m of res.data.members) {`. `req` holds exactly the data handed
  to this render — `$.render(target, data)`'s second argument, the CLI's
  `-d`/`--data-file`, a `renderEach` record — and is `{}` when nothing was
  passed, so an entry document's `{{ req.title }}` is honestly `undefined`
  even though the document declares a `title:`. Defaulting is the document's
  own explicit choice: `{{ req.title ?? res.data.title }}`. A key that isn't a
  valid identifier is `req["the key"]`.
- **`res.doc` is the finished tree**, and it cannot be ready before the code
  runs — making it is what the code is for. It is `undefined` until a
  `transform` gets it, which is where a document meets its own tree.
- **Missing data is graceful by construction**: property access on an object
  never throws for an absent key, so optional data reads as `undefined` and
  falls back explicitly: `{{ req.age ?? 'unknown' }}`,
  `{{ (res.data.skills ?? []).join(', ') }}` (ternaries and `?.` work too).
  `{{ req.missing }}` alone renders the string `undefined` — write the
  fallback when you don't want that. There is no forgiving name resolution
  beyond that: `{{ req.missing.prop }}` is a real `TypeError`, and a bare
  identifier the document never declared (`{{ title }}`) is a real
  `ReferenceError` that fails the render.

The toolkit a document is handed alongside `$` — `transform`, `visit`, `h`,
`toText`, `slug` — is the same four names mdy's own runner provides, written
as guest code here because a helper that takes a callback cannot be a host
call across the VM boundary.

## Elements and indentation

MDY has no closing tags. A line starting with `<` opens an element, and
everything indented two columns past it is its content; the end of the indent
is the end of the element.

```
< section class="team"
  == The team

  - !!Ada Lovelace!! — analyst
```

```html
<section class="team">
<h2 id="the-team">The team</h2>
<ul>
<li><strong>Ada Lovelace</strong> — analyst</li>
</ul>
</section>
```

This is a rule of the grammar rather than a rewrite over the top of one: the
parser opens a node and closes it, so an element that runs off the end of the
file ends there and nowhere else. Void elements (`<hr`, `<br`, `<img`) hold
nothing; raw-text elements (`<pre`, `<script`, `<style`, `<textarea`, `<title`)
keep their body exactly as written; `<!doctype html>` is the one line of a
document that names no element, so a whole HTML page is expressible.

A nested `$.render` needs no indent argument, because there is no column to
compute: at the point its result lands the parser knows exactly which element
is open, and the returned subtree becomes its child.

```
< section class="roster-cards"
  % for (const m of res.data.members) {
  < article class="card"
    {{ $.render({ template: 'card' }, m) }}
  % }
```

The whole grammar — thirteen rules, all of it — is [docs/language.md](docs/language.md).
See [`examples/elements.mdy`](examples/elements.mdy).

## Usage

Rendering is async (the database is; the VM instantiates lazily):

```js
import { render, openDocumentSet, parseDocuments, createProcessor } from 'mdy-docs';

const html = await render(documentSource);      // → HTML
const docs = parseDocuments(documentSource);    // → [{ data, content, format }, …] (sync)

// One set, many renders, and the tree as well as the HTML:
const set  = await openDocumentSet(documentSource);
const tree = await set.renderTree(0);           // → hast
const text = await set.renderText(0);           // → the text the document's code wrote

// The two front ends, without a document set around either:
import { fromMdy, markdownToHast } from 'mdy-docs';

// A plugin on the finished tree (e.g. a different syntax highlighter):
import rehypeHighlight from 'rehype-highlight';
const { render: r } = createProcessor({
  rehypePlugins: [rehypeHighlight],   // run on the finished tree
  compiler: undefined,                // what turns that tree into output
});
```

There is nothing left to configure on the way IN — both front ends produce
hast directly, so what used to be a remark pipeline with a raw-HTML repair
step in the middle is now a parse and nothing else. What remains configurable
is what happens to the finished tree, and `compiler` is how mdy targets
something other than an HTML string without a second implementation of
anything above it. A compiler's return value passes through uncoerced, so
`render` resolves to whatever it produces;
[`@mdy-docs/react`](packages/mdy-react/) is this option and little else.

`renderText` is the other half of a render: the text a document's code
actually wrote, byte for byte. That is what an `.mdy` file producing an RSS
feed or a robots.txt genuinely means, and it is what the CLI prints by
default.

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
                        in the document's own code (see Static sites). The
                        entry defaults to main.mdy; --entry picks another
                        file.
  -o, --out <file>      write output to <file> (default: stdout); if <file>
                        is an existing directory, $.emit output is written
                        under it instead (see Static sites)
      --html            emit the finished document as HTML, instead of the
                        text its own code wrote (which is what an .mdy file
                        producing a feed or a robots.txt actually means)
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
mdy dev [site-dir] [--port <n>] [--drafts] [--future] [--entry <path>]
      dev server for a site: watch, rebuild, live reload
```

```sh
mdy report.mdy                        # → the text the document wrote, on stdout
mdy report.mdy --html -o report.html  # → HTML file
mdy report.mdy -o report.mdy -d env=prod --data-file overrides.yaml
mdy report.mdy -o report.mdy --watch  # live re-render on save
cat report.mdy | mdy - --html         # stdin → HTML on stdout
mdy ./my-site                         # scan the dir, render main.mdy
mdy ./my-site --entry other.mdy -o dist   # write $.emit output

mdy build ./my-blog --out ./dist      # build a site
mdy dev ./my-blog                     # dev server at http://localhost:4321
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
top in `src/format.js`, not baked into the generic walk itself.

## Front matter

A document's front matter is the YAML before its first bare `+++` line. It must
be a mapping; to group values, nest them:

```
report:
  title: "Invoice #42"
  owner: Grace Hopper
+++
= {{ res.data.report.title }}
```

- **No `+++`** ⇒ the whole document is body with no data (plain markup just
  works).
- **A leading `+++`** (nothing before it) ⇒ an empty front matter block, i.e.
  no data.
- **A trailing `+++`** (nothing after it) ⇒ a data-only document with an empty
  body — handy for data files (see below).

Everything after `+++` is the body, verbatim — blank lines there are fine and
are preserved.

## Data fences

Data can also be declared inline in the body: every ` ```data ` fence is
parsed as YAML, merged into the document's data, and stripped from the output.
All other fences (` ```yaml `, ` ```js `, …) are left alone and render as
normal code blocks.

````
= {{ res.data.report.title }}

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
- Fences are collected at parse time, **before** a line of the document's own
  code runs, so they are order-independent — the code may reference data
  declared anywhere, even below it. See
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
- Code fences, inline code spans, `%` and `%%` code lines, and `{{ }}`
  contents are skipped.
- `\#fred` opts out.

Because the scan runs on the raw body, tags are **static** metadata:
a tag generated at render time (`#{{ topic }}`) doesn't count, and a
document's tags are known without rendering it — which is what lets `$` query
them across a document set (`$.withTag`, below). One consequence of feeding
`data.tags`: the `tags` front matter key has reserved meaning and must be a
list (or a single string). The key is only present when a document actually
has tags.

The scanner is exported as `extractTags(body)` for standalone use, and
[`examples/hashtags.mdy`](examples/hashtags.mdy) shows an entry document
composing its siblings by tag.

mdy's parser also collects tags — and mentions, and links — as it parses,
onto `res.data.tags` / `.users` / `.links`, and turns each one into a link.
That is a different question with a different answer: this scan says what the
*file* says, before anything has run, which is what `$.withTag` needs to
answer a query without rendering every document in the set to find out; the
parser's says what the *rendered* document says. Both use the same grammar.

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
| `$.render(target, data?)` | run the document `target` with `data` as its `req` (its own data stays separate, on its `res.data`), and return a token standing for its finished **tree**. `target` is a `$.find`/`$.findOne` result (rendered by identity, no re-query — `$.render($.findOne({ template: 'card' }), m)`), an index, or a query object as shorthand for its first match. There is no `indent`: the parser knows which element is open where the token lands, so there is no column to compute |
| `$.text(target, data?)` | the same render as the text its code wrote, byte for byte — for a document that deliberately is not markup (a feed, a robots.txt) |
| `$.withTag(tag)` | shorthand for `$.find({ tags: tag })` (see Hashtags) |
| `$.emit(path, content)` | produce a named output as a side effect of this render — see `openDocumentSet`'s `onEmit` below; a no-op if the embedder didn't ask for it |
| `$.data(i)` | document `i`'s data (positional) |
| `$.documents` | `[{ index, data }, …]` (positional) |
| `$.count` | number of documents |
| `$.parse(mdy)` | MDY text → a [hast](https://github.com/syntax-tree/hast) tree (plain JSON), through the same front end the document itself came from |
| `$.markdown(md)` | markdown text → a token for its tree, through the OTHER front end — a `.md` file's body, or any markdown a document is holding |
| `$.node(tree)` | a tree the document built itself — with `h`, or in a module it imported — as a token to splice |
| `$.html(treeOrToken)` | a tree (or a token) written out as HTML text |
| `$.table(rows, align?)` | 2-D array → a token for a table, first row as the header: `$.table([['name', 'age'], ...$.find().map((m) => [m.name, m.age])])`. Cells are parsed as MDY inline content, so `!!bold!!`, `` ``code`` `` and links survive; `align` is an optional per-column array — `['left', 'center', 'right']` or initials `['l', 'c', 'r']` |
| `$.toc()` | with no argument: drops a placeholder that is replaced, at the end of the render, with a nested link list of **this document's** final headings — including generated ones, and after any `transform`; the anchors are the ids the parser gave those headings. `$.toc(mdyOrTree)` instead returns `[{ depth, text, slug }]` entries to render however you like (e.g. `$.toc($.render(1))` for a cross-document TOC) |
| `transform(fn)` | not on `$` — one of the four names a document is handed directly. Installs a `(tree) => tree` over the document's finished hast (return a new node, or change it in place and return nothing). It runs **inside the sandbox** after the code finishes, with the tree also on `res.doc`, and what it leaves is what gets written |

Document 0 (the entry) is rendered by default; it composes the rest via `$`.
From the library, the `entry` argument to `render` (or
`openDocumentSet(...).render(target, data)`) renders a different one — the
CLI always renders document 0 (a file's first document, or a directory
input's `main.mdy`/`--entry`). Give documents identifying attributes and
both the data selection and the template selection become queries — no
document needs to know another's position — see
[`examples/document-set.mdy`](examples/document-set.mdy):

```
title: Team Roster
+++
= {{ res.data.title }}

% for (const m of $.find({ role: 'member' })) {
{{ $.render({ template: 'member-card' }, m) }}
% }
---
template: member-card
+++
=== {{ req.name }}
- Age: {{ req.age }}
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

- A bare `---` line always **splits documents**, so use `***`, `___` or
  `----` for a thematic break (`<hr>`). That is also why an underline starts
  at four dashes: one is a list item, two are an em dash, three are this.
- The first bare `+++` line **ends the front matter**, so a document should
  not contain a lone `+++` line (fence it in a code block if you need one
  literally).

## One template, many data documents

A document set doesn't have to live in one file. From the library, passing
**multiple sources** (an array of strings) concatenates their documents into
one set, so a display template can stay in its own file and be applied to
data kept elsewhere — the CLI itself takes a single input (see CLI, above),
so this is a library-level feature; a directory input's entry can reach the
same result by placing the data alongside it and `$.find`ing it directly.

```js
import { renderEach, renderDocumentSet } from 'mdy-docs';

const pages = renderEach([templateSource, dataSource]); // → string[], one per data document
```

`renderEach` renders the entry document (the template) once **per other
document** in the set, with that document's front matter (merged with
`extraContext`, which wins) arriving as the template's `req`. The template's
own front matter is its `res.data`, so sample-data defaults are the
template's explicit `{{ req.x ?? res.data.x }}` — written that way, it still
renders standalone (empty `req`) with its sample data. A data file is just
`---`-separated documents, each ending in a trailing `+++` so it is
data-only with an empty body:

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

`renderDocumentSet`/`render` behave exactly like a single
file: the entry document renders and can address every document — including
those from other sources — through `$` (`$.documents`, `$.data(i)`,
`$.render(i, data)`), and the `entry` argument indexes into the combined set.
See [`examples/invoice.mdy`](examples/invoice.mdy) and
[`examples/invoice-data.mdy`](examples/invoice-data.mdy) (run together via
`renderEach([...])` from a script, or each individually via the CLI).

See [`examples/`](examples/) for runnable documents and
[`test/mdy.test.js`](test/mdy.test.js) for behavior.

## Compiled JavaScript (debugging)

Each document body is compiled to a statement sequence: a `%` or `%%` line
goes in as the code it is, and every other line becomes a template literal
pushed onto `__out` — an array of `[sourceLine, text]` pairs the statements
declare and fill. Every output line therefore remembers the line it was
written on, which is the only honest answer a position can give for a line
written inside a loop. The statements reference data through the two bindings
the executor declares first — `req` and `res` — plain property access, so
there is no `with`, no per-key bindings, and no special name resolution.

```
% for (const name of names) {        const __out = []
- {{ name }}                 ──►     for (const name of names) {
% }                                    __out.push([1, `- ${name}`])
                                     }
```

That source is available three ways:

```js
import { compileTemplateSource, compileTemplate } from 'mdy-docs';

const src = compileTemplateSource(body); // the statement sequence
const gen = compileTemplate(body);       // gen.source === src
```

```sh
mdy report.mdy --emit-js             # compiled JS of every document in the file
mdy mysite --emit-js                 # compiled JS of just the entry document (main.mdy/--entry)
```

`compileTemplate` runs the statements in the **host** runtime via
`new Function` — a debug path, deliberately simple and **not sandboxed**. The
real pipeline never uses it: `render` assembles a self-contained program per
render (the two bindings, the `$` helper, the toolkit, and the compiled
statements) and evaluates it inside the lamassu VM. `$` calls that need the
host (`find`/`findOne`/`render`/`emit`/…) are **async host natives**
(lamassu's `__hostcall`): the VM execution suspends while the host answers —
a nisaba query, or a nested render on another pooled VM instance — and
resumes with the result. See `buildProgram` in [src/mdy.js](src/mdy.js) and
[src/vm.js](src/vm.js).

Splitting compiling from running is what lets the parser be a dependency at
all: `compileScript(lines)` (in [src/parse/script.js](src/parse/script.js))
emits the program and knows nothing about who runs it. mdy's own runner uses
`new Function`; mdy-docs puts the same statements inside lamassu and hands
the `__out` it gets back to `scriptOutput`.

## Security

Documents rendered through `render` / the CLI execute inside the lamassu VM:
a JavaScript-subset interpreter compiled to WebAssembly, with no host runtime
access (`typeof process` and `typeof Function` are `undefined` in document
code) and the engine's own bounded CPU/memory/stack. Document code can reach
exactly two things: its own data, and the `$` document-set API.

The exception is `compileTemplate()`, which executes in the host via
`new Function` for debugging — never feed it untrusted documents.

Markup is a separate question from code. mdy's parser has a sanitizer of its
own, on by default, which checks every element an author writes against a
schema; mdy-docs turns it **off**, because these are the author's own files
and a site's own layout has every right to a `<script>` tag. Rendering
documents somebody else wrote means turning it back on — see
[docs/language.md](docs/language.md#sanitizing) — or sanitizing the finished
tree, which is what [`@mdy-docs/react`](packages/mdy-react/)'s own `sanitize`
option does.

## Static sites

A static site generator — in the family of Hugo / Jekyll / Eleventy — built
entirely on the primitives above, with one governing idea: every site is a
**script-defined site**. There's no host-side content/layouts/site.yaml
convention deciding what a path means — one entry document (`main.mdy` by
default) does ALL of that itself, in template code, via `$.find`/`$.render`/
`$.emit`. `mdy build`/`mdy dev` (see CLI, above) and the whole
implementation live in [`src/`](src/); the design brief and
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
  inline `#hashtag`s extracted into `meta.tags`. `$.render`ing one takes it
  through the markdown front end and gives back a tree, exactly as for an
  `.mdy` file; nothing downstream can tell which it was.
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
each gets, tag grouping, pagination, drafts/future filtering — plus three
small, genuinely host-dependent natives no amount of script JS could
replace: `$.resize` (image codecs, `src/images.js`), `$.tokenize` (the
search widget's word-list algorithm, `src/search.js`) and `$.rfc822` (RSS
pubDate — the lamassu VM forbids `new Date()`). None of these three carry
any policy of their own — the script decides everything, these just do the
host-only work underneath. A fourth used to live here, `$.markdown`, and
does not: Markdown stopped being something a site turns into HTML text and
became one of the two front ends every document set has.

`$.emit(path, content)`'s outputs are written under `-o` (CLI) or to
`dist/`/served in memory (`mdy build`/`serve`). A token in `content` becomes
HTML on the way out, because a file is a string and that is the shape it can
hold — so `$.emit(url, $.render(page))` writes the page, and
`$.emit("feed.xml", $.text(feed))` writes text that was never markup. The
entry's own output is the same either way, though a whole-site build
discards it (nothing writes it anywhere) since every real output comes from
`$.emit`.
One trade-off: no incremental-rebuild reuse — every build/rebuild walks the
whole directory and reruns the entry from scratch (see
[`src/script-site.js`](src/script-site.js)).

A script can also **import another mdy project** — a style/theme package,
or anything else — the same way JS code imports a package, entirely from
its own code, no host convention involved:

```
% import style from "../blog-style-x"
% $.emit(url, style.render({ path: "layouts/base.mdy" }, { content: page }))
```

`style` is `{ render, find, findOne, resize }` — the exact shape
`openDocumentSet` itself returns — bound to `"../blog-style-x"`'s OWN
document set, walked and compiled independently so its internal
`$.find`/`$.render` calls work exactly as if it were rendered standalone.
There's no merged pool of every file from every package; the importer
reaches in explicitly through `style`'s own methods. See
[`src/imports.js`](src/imports.js) and
[docs/site-plan.md](docs/site-plan.md)'s "Importing another mdy project"
section for the full design (including why `import` is parsed by mdy's own
compiler rather than being real JS, and how imports resolve transitively).

A script can also import a **real ES module** — a plain `.js` file living
in the same package — with the standard dynamic-import expression:

```
% const util = await import("./lib/util.js")
{{ util.slugify(res.data.title) }}
```

The module runs inside the same sandboxed VM (it's instantiated by the
engine's own module system — lamassu-js's host module loader — not the
host runtime), may use static `import` internally for its own
dependencies, and resolves relative to the file that wrote the import.
Modules can't reach outside their package's directory. Documents may use
`await` anywhere, not just here — every compiled document runs in an
async context. A module is also a good place to build a tree: hast is plain
JSON, so a helper that used to concatenate a string of HTML returns nodes
instead and the document splices them with `$.node` — see
[examples/docs-site/lib/html.js](examples/docs-site/lib/html.js).

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
mdy dev examples/blog              # dev server, watch, live reload
mdy examples/blog                    # plain CLI: same walk, same entry
```

`renderSite`/`buildSite`/`serveSite` all resolve `root`'s entry document the
same way `mdy <directory>` does (see CLI, above) — one primitive, one
implementation, whichever way you call it.

**Web editor** ([`packages/mdy-web`](packages/mdy-web/)): the `mdy dev`
loop with the browser as the editor — edit any source file as raw text
(with the vscode extension's syntax highlighting), live-preview unsaved
changes, upload assets, and rebuild on every web save. See its
[README](packages/mdy-web/README.md).

**Live preview demo**
([`packages/mdy-live-preview`](packages/mdy-live-preview/)): a two-pane
Monaco editor + rendered preview, the whole engine running client-side as
WebAssembly, seeded with `examples/document-set.mdy` — `npm run
live-preview`. Its preview pane renders through `@mdy-docs/react`, which is
what a document set looks like as a live React subtree: edits patch the tree
instead of rebuilding it, mermaid fences are components, and a template error
shows in a bar above the last good render rather than replacing it.

**React** ([`packages/mdy-react`](packages/mdy-react/)): `<Mdy source={…} />`
— documents as React elements rather than an HTML string. Not a second
implementation: both front ends end at hast either way, so React is the last
step swapped (`rehype-stringify` out, `hast-util-to-jsx-runtime` in) and
everything before it is shared verbatim — its tests assert tree-equivalence
with the HTML target on the example documents. What that buys is
reconciliation instead of `dangerouslySetInnerHTML`, and fenced blocks that
*are* components (a highlighter, a diagram) instead of markup patched up
afterwards. The static site generator stays on the string path, where it
belongs. See its [README](packages/mdy-react/README.md).

## Development

mdy runs on two WASM/C engines, both vendored as git submodules while their
APIs are still being shaped:

- [lamassu-js](https://github.com/mdy-docs/lamassu-js) — the sandboxed
  JavaScript-subset engine that runs a document's own code. Dependency
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
git clone --recurse-submodules https://github.com/mdy-docs/mdy-docs.git
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
