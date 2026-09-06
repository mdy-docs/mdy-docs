# The MDY front end, in C

`src/parse`: YAML, a document's script layer to JavaScript, its text to a hast
tree, markdown to the same tree, and the tree back out as HTML.

It began as an investigation in a repository of its own
(github.com/mdy-docs/parse) — *what would it take to parse MDY natively, and
what would it be worth?* — answered with running code rather than an estimate,
and grew into the whole front end. It lives here now because nothing else uses
it. It is checked against mdy-docs' own parser over a real corpus, document by
document, and that harness is as much the point as the parser is; the second
half of this file is how it works inside, and the last is the rule for
changing it.

## Why

mdy-docs parses MDY into [hast](https://github.com/syntax-tree/hast), and
everything downstream works on that tree: rehype plugins, the query engine, a
template's `$.render`. **hast is the extension point, and that is why the
native backend embeds a JavaScript engine at all.** Moving the parse into C
does not remove the extension point. It removes the largest single cost in
front of it.

That cost was measured, not guessed. Profiling a native corpus build
(this package, before the port) put every frame in `JS_CallInternal`,
`js_array_flatten`, `js_array_every` and generators — the JavaScript layer,
with no native call appearing at all. The MDY front end is 4,441 lines of that
JavaScript and was measured at **8.8× slower under QuickJS than under V8**, the
worst ratio of any component.

## What the numbers say

The reference corpus: 87 Wikipedia-derived documents, 6.5 MB of text.

```
  JavaScript (node/V8) :  2030 ms   284872 nodes
  C                    :   163 ms   284175 nodes  (100% of them)
```

**12.5× faster, doing the same amount of work.** An earlier cut of this said
23×, and that number was flattered: it implemented 62% of the language, so it
was building 62% of the tree. This one builds the whole tree, and the honest
ratio is half of what the partial one advertised — which is worth recording,
because a benchmark against an incomplete implementation is a benchmark against
nothing.

The comparison that actually matters is against QuickJS, not V8. mdy-docs'
front end was measured at 8.8× slower under QuickJS, so a native backend that
parses in C rather than in its embedded JavaScript engine is looking at roughly
two orders of magnitude on this stage.

## How close is the tree?

`make compare` builds both and diffs them:

```
  87/87 documents byte-identical
  284872 nodes against the JavaScript's 284872
  87/87 documents with identical text
  20681 of the JavaScript's 20681 unist positions
  10514/10514 URL inputs agree with linkify-it exactly
```

**Every document, every node, every position.** The corpus is 87 Wikipedia
articles, 6.5 MB, and `make compare` diffs both implementations document by
document.

Whole-document equality is a hard bar for a 70 KB Wikipedia article — one rule
missing anywhere makes the whole document differ.

The last of them took a fix on the JavaScript side rather than this one:
mdy-docs numbered footnotes in the order the PARSER met them, and a paragraph
followed directly by a list has the list built first — so a reader saw markers
run 30 31 32 … 27 28 29. Numbering now happens once the tree is built, which is
the only place reading order exists. Fixed upstream; this never replicated it.

## URLs are linkify-it, ported

Every URL boundary is linkify-it's, because none of them is a rule anyone
guesses. `make check-links` runs both implementations over every line of the
corpus that could hold a link plus 48 edge cases aimed at the conditional
alternatives in its path grammar:

```
  10514/10514 inputs agree (100.0%)
```

See [src/parse/linkify.c](../src/parse/linkify.c) for what the port covers and, more usefully,
why compiling linkify's own regexes was tried first and abandoned.

## What it does today

Verified against mdy-docs' own parser, document by document
(`make compare`) — that is the only way a 4,441-line parser gets ported safely,
and the harness is as much the point as the parser is.

| | |
| --- | --- |
| **Block** | documents (`---` → `<article>`), front matter, headings with slugged and de-duplicated ids, Setext underlining, thematic breaks, fenced code, paragraphs with line joining, the `<element` syntax, pipe tables with alignment |
| **Indentation** | structural, as MDY means it: a line further in than its run is a block of its own in a `<div>`, nesting as it goes; an element opener takes its indented lines as children; a list item absorbs its continuation |
| **Lists** | bullet and ordered, nested lists, continuation lines, and `[ ]`/`[x]` task items with their checkbox and list classes |
| **Inline** | the nine toggling markers, backslash escapes, raw spans, autolink (schemes and protocol-relative `//host`), wiki links, footnote references, `#tag` and `@user`, em dash, ellipsis, the six arrows |
| **Footnotes** | references, definitions, numbering by first reference, the collected `<section>` with per-reference backrefs |
| **Sanitisation** | the element allowlist, per-element attribute allowlists, and the `href`/`src` protocol check |
| **Attributes** | hast property naming (`class` → `className`, `colspan` → `colSpan`, `data-x` → `dataX`), with `className` as a list |
| **Emoji** | `:rocket:` and `:)`, from tables generated out of the same `gemoji` and `emoticon` packages mdy-docs imports — 2,235 entries, with the boundary rules that keep `12:30:45` and `http://x` from becoming faces |
| **Positions** | unist `{line, column}` on block elements, columns in UTF-16 units, `line_offset` honoured |
| **Unicode** | UTF-8 throughout, decoded strictly; `\p{L}`, `\p{N}` and case mapping from baru-re's generated UCD tables rather than approximated; a UTF-16 conversion for the JavaScript boundary, astral characters and all |
| **Tree** | the three node types the corpus produces, arena-allocated, with interned tag and property names |

**Still missing:**

- **Syntax highlighting** in fenced code — and deliberately, not for now.
  mdy-docs uses lowlight, and highlighting is a *decoration* of a tree that is
  already correct: it replaces a `<code>` element's single text node with a run
  of `<span class="hljs-…">`. That is exactly the shape of thing to do
  afterwards, in the lamassu VM, on the tree this produces. Reimplementing
  lowlight in C would be a large piece of work to move a stage that does not
  need to move.
- **`%` script lines**, which run JavaScript. That is the document engine's job
  rather than the parser's, and it needs a JS engine — which is exactly what
  the host embedding this already has.
- The last handful of nodes per tag, which the harness names precisely and
  which is what `make compare --first` is for.

## Building and checking it

The Makefile builds `src/parse` into `build/libmdyparse.a` and links it into
the engine. Its checks:

```sh
make check-parse     # the C checks, no node needed
make compare         # diff the PARSER against mdy-docs' JavaScript over a corpus
make check-html      # diff the WRITER against hast-util-to-html
make check-script    # diff the SCRIPT layer against compileScript
make check-yaml      # read every YAML block the site holds, and compare
make check-links     # diff the URL matching against linkify-it
make corpus          # assemble the borrowed markdown corpus
make check-markdown  # diff the MARKDOWN front end against remark over it
make bench           # how long each takes on the same input
```

`check-parse` is what CI runs. The rest need node and a corpus: mdy-docs is
this repository, and `CORPUS`, `SITE` and `THEME` default to the site next to
it, which is where every number in this file was measured.

The parser itself has no dependency but the tables it reads: md4c, vendored at
`third_party/md4c`, and baru-re's generated Unicode data, taken from the copy
lamassu already carries (`ucd.h`, and nothing else of it). No platform
`#ifdef`s, no libc beyond `malloc`/`free`/`str*`/`snprintf`, and it is built
`-std=c11 -Wshadow` rather than this package's gnu11 to keep it that way.

## Using it

```c
#include "mdyast.h"

mdy_options options;
mdy_options_default(&options);
options.documents = 1;

mdy_doc *doc = mdy_parse(text, len, &options);
char *json = mdy_to_json(mdy_root(doc));   /* or walk mdy_root(doc) yourself */
free(json);
mdy_free(doc);                             /* frees every node at once */
```

The whole tree lives in one arena, so there is no per-node ownership anywhere
and `mdy_free` is the only cleanup.

JSON is the emitter that exists because it is what the comparison harness
needs. The engine (`src/engine.c`) does not use it: it walks the tree and
builds lamassu values directly, and the tree is deliberately independent of
either.

## The data a document declares

```c
#include "mdydata.h"

mdy_data *data = mdy_data_extract(body, len);
for (size_t i = 0; i < mdy_data_count(data); i++)
    mdy_yaml_parse(mdy_data_at(data, i)->source, ...);   /* merged over front matter */
const char *without = mdy_data_body(data, &len);         /* what the script compiles */
mdy_data_free(data);
```

A ` ```data ` fence is YAML the document declares in its body, merged over its
front matter. It comes out before a line of the document's code runs, which is
what makes the fences order-independent — code may reference data declared
anywhere, even below it.

The subtlety is fence STATE, not pattern matching: a ` ```data ` shown inside a
longer outer fence is an example, and only a scanner that knows it is already
inside one can tell. Its info must be exactly `data`, so ` ```data foo ` stays
display content.

**The site contains no data fences at all** — 189 files, none — so the
corpus proves nothing here and `test/data.c`'s twelve constructed cases are
the whole of the coverage. Every expectation came from mdy-docs'
`extractDataBlocks`, which locates them with a real CommonMark parse.

## YAML

```c
#include "mdyyaml.h"

char error[256];
mdy_yaml *doc = mdy_yaml_parse(text, len, error, sizeof error);
if (!doc) fprintf(stderr, "%s\n", error);   /* `line 12: what went wrong` */
const mdy_yaml_node *title = mdy_yaml_get(mdy_yaml_root(doc), "title");
mdy_yaml_free(doc);
```

For a document's front matter, its ` ```data ` fences, and the `.yaml` files a
site is built from. **YAML 1.2, core schema — correct rather than compatible.**
Where an implementation and the specification disagree this follows the
specification, and where a construct is not supported it says so with an error
naming the line rather than guessing. A parser that silently mis-reads data is
worse than one that refuses it: the data is what a site is built from.

The one that decides real files here is `Yes`. YAML 1.1 made it a boolean; 1.2's
core schema does not, and this corpus has `public-access: Yes` meaning the word.

It reads block mappings and sequences (including a sequence at its key's own
indent and the compact `- key: value` form), plain, single- and double-quoted
scalars that fold across lines, literal and folded block scalars with chomping
and explicit indentation, nested flow collections spanning lines, and comments.
It refuses anchors, aliases, merge keys, tags, explicit keys, multiple
documents and directives — none of which appears in the 179 YAML blocks
surveyed before a line was written, and each of which is a feature to add
rather than a corner to guess at.

```
make check-yaml   179/179 blocks read identically, 4.9 MB
```

`test/yaml.c` covers the language itself, construct by construct, and every
refusal with the line it names.

Two bugs were found by testing rather than by reading. A **mutation fuzz** —
2,000 truncated and corrupted inputs through an AddressSanitizer build — found
a block scalar with no content failing to advance the line cursor, which is not
a wrong value but an unbounded loop. And a **duplicate key** was quietly
replacing rather than failing, which the specification calls an error.

## The script layer: a document to JavaScript

```c
#include "mdyscript.h"

mdy_script *script = mdy_script_compile(text, len);
size_t n = 0;
const char *statements = mdy_script_source(script, &n);   /* hand to a sandbox */
mdy_script_free(script);
```

A document's `%` and `%%` lines are JavaScript and its content lines are
template literals, so a document compiles to the one run of statements that
produces its lines:

```
% for (const name of names) {        const __out = []
- {{ name }}                 ──►     for (const name of names) {
% }                                    __out.push([1, `- ${name}`])
                                     }
```

A port of mdy-docs' `src/parse/script.js` (the JavaScript one, two directories up). **What runs the statements is
somebody else's business** — this produces source and knows about no engine,
which is what lets a host compile a document ONCE and call the result per
render, because the statements never mention the request.

`make check-script` holds it against the original: 145/145 documents, 14 MB of
JavaScript, byte-identical, plus the `code` map that says which lines went in
as code. `test/script.c` covers what a corpus does not — a brace inside a
string, inside a comment, inside a `${}`; a `%%` that never closes; an escaped
sigil; CRLF — and every expectation there was taken from `compileScript`
rather than reasoned out. A difference at this stage is not a different tree,
it is different behaviour.

`scriptBrackets` is not ported: it pairs brackets up for an editor to fold and
highlight, which is tooling rather than compilation.

## Markdown: vendored, and a corpus to check it against

mdy-docs speaks two markup languages. `.md` goes through a second front end —
`remarkParse → remarkGfm → remarkAlert → remarkRehype → rehypeRaw` — and stops
at the tree, so a `.md` document arrives as hast exactly as an `.mdy` one
does.

[md4c](https://github.com/mity/md4c) is vendored at `third_party/md4c` (MIT,
CommonMark-compliant, callback-based rather than AST-based, which suits
building a tree directly). `MD_DIALECT_GITHUB` covers permissive autolinks,
tables, strikethrough, task lists, admonitions and **footnotes**.

**The corpus came first, deliberately.** Every other C stage here is
trustworthy because it is diffed against the JavaScript over real input, and a
markdown front end had nothing to be diffed against: the site contains
zero `.md` files. So one is borrowed — `make corpus`:

```
  commonmark    652   spec 0.31.2      (CC-BY-SA 4.0, via third_party/md4c)
  ext-*         213   md4c's own extension specs, 16 of them
  gfm            39   spec 0.29        (CC-BY-SA 4.0, github/cmark-gfm)
  real          486   documents found on this machine

  1390 documents, 13.2 MB → build/corpus/
```

Three kinds of source because they fail differently. **Spec examples** are
dense in the corners a hand-written parser gets wrong — lazy continuation,
link reference definitions, HTML blocks, tight and loose lists. **Extension
specs** are where md4c and remark-gfm may simply disagree, which is worth
knowing. **Real documents** are neither: long, mundane, and full of what no
spec example bothers with. The GFM spec contributes only 39 because it is a
superset of CommonMark and the rest deduplicate.

Nothing is committed — the corpus is build output, and the spec files stay
inside md4c's own vendored copy with their licence.

Two baselines are established before a line of the front end is written:

```
make check-markdown   1390 documents, 290051 hast nodes in 10.9 s, remark
                      refusing none — the reference to be measured against
build/md4cprobe       md4c reads 1390/1390: 68591 blocks, 42286 spans,
                      483296 text runs, 12.2 MB of text, refusing none
```

`make check-markdown` compares TREES, not HTML: what a `.md` document becomes
is a tree that composition and `transform` then work on, and two pipelines
agreeing on HTML while disagreeing on the tree is a difference nobody sees
until a transform runs.

### Where the mapping has got to

```
792/1390 trees identical (57.0%)
  commonmark   500/652     ext-tables      1/12
  gfm           19/39      ext-tasklists   2/5
  real         112/486     ext-footnotes   8/26
```

`src/parse/markdown.c` turns md4c's callbacks into `mdy_node`s directly — a stack of
open nodes, no intermediate representation. **Not** into lamassu bytecode: a
`.md` document has no program (`body: format === 'md' ? null : …` in mdy-docs),
so there would be nothing to run, and bytecode that rebuilds a constant tree is
strictly worse than the tree.

Three rules moved that number a long way, and each was found by the harness
rather than by reading:

- **remark-rehype's `wrap`** is where every `\n` in the tree comes from — one
  before the first child, between each pair, and after the last for a *loose*
  parent; between only for the root and a tight `<li>`. Padding after every
  block instead was wrong on 1,389 of 1,390 documents, all of them a single
  trailing newline. 0.1% → 43%.
- **Text is coalesced.** md4c reports a run, an entity, a soft break and
  another run separately; the reference produces one text node per run of
  adjacent text.
- **Entities resolve.** md4c is encoding-agnostic and hands over `&copy;`
  verbatim; it ships the HTML5 table as `entity.c` for exactly this.

What remains is characterised rather than mysterious. `ext-tables` is
`rehype-raw`: it round-trips the tree through an HTML5 parser, and HTML5's
foster-parenting rule hoists a table's whitespace out in front of it. Matching
that means either an HTML5 parser in C (lexbor) doing the same round trip — the
writer for it already exists here — or a deliberate divergence.

## The other direction: hast to HTML

```c
#include "mdyhtml.h"

char *html = mdy_to_html(mdy_root(doc), NULL);   /* NULL: mdy-docs' own settings */
free(html);
```

A port of [`hast-util-to-html`](https://github.com/syntax-tree/hast-util-to-html),
which is what mdy-docs writes its pages with — through `rehype-stringify`, with
`allowDangerousHtml: true` and every other option at its default.

**It shares nothing with the parser but the tree type.** The parser reads text
and produces a tree; `src/parse/html.c` reads a tree and produces text; neither needs
the other. `test/html.c` proves it: every case there builds its tree from
plain C structs, with no arena, no document and no source text anywhere — 24
checks and not one of them parses anything.

`make check-html` is the differential harness, and it is careful about what it
is measuring. Comparing two whole pipelines would blame the writer for a
parser difference, so the SAME TREE goes through both: the C parses, emits its
tree as JSON, and writes its own HTML; node reads that JSON and writes HTML
from it with the original. A difference has nowhere else to have come from. A
second pass then compares end to end, which is the number an embedder cares
about. Both run over every document twice, sanitised and not.

```
290/290 trees written identically — the same tree through both writers
290/290 documents identical end to end, over 26 MB of HTML
```

Three options are deliberately absent, and `src/parse/mdyhtml.h` says so at
length: `omitOptionalTags` (off in mdy-docs, and the largest part of the
original), the SVG schema, and `<template>`'s `content`. Each is a refusal to
guess rather than an oversight.

## Notes

**Every exported symbol is `mdy_`-prefixed, deliberately.** Two C projects
already in this family export unprefixed names like `compile_into` and
`vm_execute_internal`, and linking both into one binary silently bound one
library's calls to the other's differently versioned implementation. A prefix
is cheap; finding that is not.

**One dependency**, and only for its tables: baru-re supplies the generated UCD
data for `\p{L}`, `\p{N}` and simple lowercase, read from lamassu's copy
(`third_party/lamassu-js/third_party/baru-re/include/ucd.h`) so there is one
baru-re in the tree rather than two that could drift. Referenced directly
rather than through its property lookup, so the linker keeps 8 KB of it rather
than 619 KB. Nothing else — see *Building and checking it* above.

## How it works

The above is what it is and why. This is the inside.

### The shape of the problem

The tree was measured before anything was written, across the whole reference
corpus:

```
 3 node types      root, element, text
32 tag names       a, sup, p, li, em, td, img, figure, tr, br, h2-h4, …
19 property names  href, id, className, dataFootnoteRef, src, width, …
```

That is a much smaller thing than hast in general — no comments, no doctypes,
no raw nodes — and it is what makes a C implementation tractable rather than a
research project. Two consequences run through the whole design:

- **A closed vocabulary can be interned.** Tag and property names become one
  pointer each, so comparing a tag is a pointer compare and the emitter never
  copies a name.
- **A closed node model can be a plain struct.** No polymorphism, no visitor
  indirection, three cases in every switch.

### Where the time goes

Also measured first, by turning options off one at a time:

```
2012 ms   everything on (the real configuration)
1240 ms   block structure only, no inline at all
```

So block structure is 62% and inline the other 38%, and within each the cost is
spread thin — no single rule is more than a tenth. **There is no hot spot to
move.** A port has to cover the whole front end to be worth anything, which is
the main thing this measurement settled.

### The arena

`src/parse/arena.c`. A bump allocator: nodes, text, property names and property
values all live in it, and `mdy_free` drops the whole thing in one call.

This is not only about tidiness. The JavaScript builds 285k nodes for the
reference corpus, each a separate heap object with its own properties object,
and that allocation traffic is a real share of what the port is trying to
remove. An arena is how a C implementation actually wins rather than
reproducing the same cost in a different language.

### The stages

**Lines first** (`src/parse/block.c`). Indentation is structural in MDY — every two
columns is one level — so the source is split into a measured line array before
any rule runs. Every rule needs the width before it needs the content, and
measuring once is cheaper than measuring per rule.

**Block rules** consume runs of lines, at a **column** passed in rather than
inferred. That parameter carries the one rule everything else hangs off:
indentation is structural, so a line further in than its run is a block of its
own. At the root the column is 0 — a document whose first line is indented
opens with a `<div>` — while inside an element it is that element's children's
own indentation, or every child would get one. Inferring it from the first line
gets the root case wrong; inferring it from the parent gets the element case
wrong, and a first attempt that inferred it made 755 divs where the JavaScript
makes 40.

Three constructs claim indentation before that rule sees it: an element opener
takes its indented lines as children, a list item absorbs its continuation
lines, and a paragraph stops at any change of column. What is left over is a
div.

 The one subtlety worth knowing is that
block children of an *element* are separated by newline text nodes (`"\n" p
"\n" p "\n"`) and block children of the *root* are not. That asymmetry is the
JavaScript's, it is what makes stringified HTML come out one block per line
inside a container, and getting it wrong is the difference between an identical
tree and a nearly identical one.

**Inline** (`src/parse/inline.c`). MDY's inline model is **toggling, not nesting**,
and that is the single most important thing about this stage. A marker sequence
opens a span; the next occurrence of the same sequence closes it. There is no
left-flanking/right-flanking analysis, no delimiter stack, none of CommonMark's
emphasis machinery. All nine markers are exactly two characters and none
prefixes another, so two bytes decide with no lookbehind — a single `*` is
literal text, and `a *b* c` is three words.

A marker only opens if its closer appears later, which is what makes an
unmatched `**` come out as two asterisks rather than swallowing the rest of the
line.

### Footnotes are a document pass

`src/parse/footnote.c`, and the reason it is not an inline rule is worth stating: a
`[[ ^id ]]` becomes a footnote only if a definition exists somewhere in the
same document, so definitions are collected out of the line stream before any
parsing runs. Three rules follow from asking the JavaScript rather than reading
it:

- Numbering is by order of **first reference**, not of definition, and the list
  at the end is in that order too.
- A second reference to the same note gets id `…-2`, and the definition grows a
  second backref carrying a `<sup>` that says which.
- A definition nothing references is dropped, and a document with no referenced
  footnotes gets no section at all.

### Sanitisation is not optional

`src/parse/attrs.c`. It is easy to read the schema as a safety feature that could be
skipped for a first cut, and that is wrong: `<td scope="col">` produces no
`scope` in the tree, because `scope` is allowed on `<th>` and not on `<td>`.
Skipping the check does not produce "slightly more" tree — it produces a
different one.

### Text is UTF-8, and the questions are about characters

`src/parse/unicode.c`. UTF-8 everywhere — the source, the tree's text, the JSON —
with no conversion unless something asks for one.

That is safe for the same reason it is fast: **UTF-8 is self-synchronising**.
No byte of a multi-byte character can be mistaken for ASCII, so every rule that
scans for `|`, `-`, `[[` or a marker can walk bytes and be right, and most of
this parser does.

What cannot walk bytes is anything asking a question *about* a character — is
it a letter, what is its lowercase, should it be deleted. Each of the three
places that did was a bug:

- "Non-ASCII is a letter" kept en dashes in URLs, because `\p{L}` says they are
  not.
- A hand-written lowercase table covering Latin-1 and Latin Extended-A left `Ń`
  and `Ḫ` uppercase.
- Deleting a character by advancing one byte left the other two behind —
  mojibake in a URL, and invisible to anything counting nodes.

So the classification and case tables are **not ours**. They are baru-re's
generated UCD data, reached directly (`ucd_gc_Letter_ranges`,
`ucd_gc_Number_ranges`, `UCD_SIMPLE_LOWERCASE`) rather than through
`lookup_unicode_property`, which would pull in every property Unicode has: 8 KB
against 619 KB.

Decoding is strict, because a lenient decoder is how one bad byte shifts every
offset after it. Overlong forms, surrogates encoded as three bytes, and
anything above U+10FFFF are all ill-formed, and each is one byte consumed and
one U+FFFD — never a resynchronisation that eats what follows.

#### The UTF-16 boundary

A boundary, not a representation. Every JavaScript engine — QuickJS, lamassu,
V8 — holds strings as UTF-16, so a tree built here crosses that conversion on
its way into one, and unist positions are counted in those units rather than in
characters or bytes.

The corpus has 1,351 astral characters in it, all Sumerian cuneiform, and each
is **one code point and two UTF-16 units**. Anything that conflates those
counts is wrong on exactly those characters, which is why they are what the
tests use — along with an unpaired surrogate, which cannot be encoded at all
and becomes U+FFFD rather than failing the document.

### URLs

`src/parse/linkify.c` — a port of linkify-it, which is what mdy-docs uses.

**Why a port and not a heuristic.** Five of the eight documents that once
differed came down to URL boundaries, and each time the hand-rolled rule was
"close": a trailing comma kept in one place and dropped in another, a hyphen in
a host's last label, a full stop ending a sentence versus one inside a path.
Those are not rules anyone guesses.

**Why not its regexes.** The obvious route is to compile linkify's own patterns
with baru-re, which lamassu already links and which speaks the dialect they
need. It does not work, and it is worth writing down why so nobody spends the
afternoon: the patterns inline the Unicode classes rather than using `\p{...}`,
so `http_validator` alone is 31 KB and wants ~460 character classes against
baru-re's `MAX_CLASSES` of 256. Raising that limit segfaults. Measured, then
reverted.

That inlining is also what makes the C port *small*. Those 31 KB are `Z`, `P`
and `Cc` written out longhand; here they are three table lookups, and what is
left is the grammar — a few hundred lines.

**What it covers** is what `new LinkifyIt()` does with no options, which is
what mdy-docs constructs. The most useful thing to know about that default is
that **`fuzzyLink` is false**: a bare `example.com` is not a link, which takes
the TLD list out of everything except fuzzy email.

The path grammar is where the boundaries live, and its alternatives are
conditional on purpose: `,` and `;` continue a path only when something
follows, `.` only when what follows is neither another dot nor the end, `!` and
`?` only when not doubled. That is what leaves the full stop out of
"see http://example.com." while keeping the comma inside "http://x.com/a,b".

`make check-links` diffs the two implementations over every line of the corpus
that could hold a link, plus edge cases aimed at each conditional alternative.
It reports 10514/10514.

### Positions

unist positions, on block elements only — inline ones do not carry them, nor
does the root, nor the synthesised `<article>` and footnotes `<section>`, which
come from no source line.

Two details decide whether they are right. **Columns are UTF-16 units**, so
`a 𒀀 b` ends at column 7 rather than 6: the cuneiform sign is one character and
two units, and a position that counted characters would point at the wrong
place in every editor. And **columns are measured from the start of the line
including its indentation**, which is why an indented block still *starts* at
column 1 and ends past its own indent.

`mdy_to_json_bare` omits them. That exists because most of the smoke checks are
about what the tree IS, and threading a position through every expectation
would bury the thing being tested.

### Emoji

`src/parse/emoji.c`, over a table generated by `scripts-generate-emoji.mjs` from the
same `gemoji` and `emoticon` packages mdy-docs imports. Data copied by hand is
data that drifts; regenerating after an upgrade is one command.

The matching is the interesting half, and both rules exist to stop false
positives a naive scan produces constantly. A shortcode must be a name gemoji
knows — that is what keeps `12:30:45` from being one, and why this corpus's
`:text:` and `:cts:` stay as they are. An emoticon must stand on its own:
something must have ended before it, and a letter or number must not follow.

`at_boundary` is **tracked state**, not computed from the previous byte, because
what sets it is what the scanner just did: a marker or a wiki link leaves a
boundary, an em dash does not, and an ordinary character leaves one only when
it is whitespace. Computing it from the text — treating `(` or `[` as a
boundary too — made faces out of ordinary prose and cost two documents' worth
of agreement before it was noticed.

The generator emits **three-digit octal escapes, not hex**. A C hex escape is
greedy, so `\x22D` is one invalid escape rather than `"` followed by `D` — and
`:"D` is a real emoticon.

### What is not here, on purpose

**Syntax highlighting.** It is a decoration of a tree that is already correct —
a `<code>` element's single text node becomes a run of `<span class="hljs-…">`
— so it is the clearest example of a stage that does not need to be in C at
all. The parse produces the tree; the VM can decorate it afterwards.

That division is worth stating generally, because it is the argument for the
whole port: **hast is the extension point, and moving the parse does not move
it.** Anything that reads a finished tree and returns another one stays where
it is.

### Emitting

`mdy_to_json` writes the tree with a fixed key order and JSON.stringify's exact
escaping. That precision is the point: it is what lets `test/compare.mjs` diff
the two implementations byte for byte.

A host embedding this would want a different emitter — QuickJS objects built
directly, or binjson for a WASM path — and the tree is deliberately independent
of all of them. JSON exists because verification needs it.

### Verification

`test/compare.mjs` is as much the point as the parser. A
4,441-line parser is not ported by reading it; it is ported by producing the
same tree for a real corpus, document by document, and diffing. The harness
canonicalises both sides identically, groups first-differences by shape so the
report names causes rather than instances, and `--first` prints one in full.

It reports **node-level agreement** alongside whole-document equality, because
the latter is the right bar eventually and a useless signal now: one
unimplemented construct anywhere in a 70 KB article makes the document differ,
so a partial implementation reads 0% however far along it is.

## Working on it

**Measure against the JavaScript, do not read it and translate.** `make
compare` diffs both implementations over a real corpus and groups the first
differences by shape; `--first` shows one in full. Pick the most frequent
shape, implement it, watch the number move. That loop is how every rule in
`src/parse` was written.

**Never write an expectation you have not asked the JavaScript for.** This
went wrong three times and each cost real work:

- "An unclosed marker is text" — it is not; it opens a span that runs to the
  end. The wrong expectation went into a test, the C had the same wrong idea,
  the test passed, and 199 spurious `<em>` sat in the corpus until a histogram
  found them.
- "A single-column table is a degenerate table" — it is a paragraph, and `:-:`
  in it is an emoticon.
- "Non-ASCII is a letter" — an en dash is not, and `\p{L}` says so.

Getting a construct's exact output is a question for the JavaScript, asked
directly, from this directory:

```sh
node --input-type=module -e "
import { fromMdy } from '../../src/parse/block.js';
console.log(JSON.stringify(fromMdy('= Title', { script: false }), null, 1));
"
```

That is faster and more reliable than reading 37 KB of `block.js`.

Conventions:

- **Every exported symbol is `mdy_`-prefixed.** Not style: two C libraries in
  this binary already export unprefixed names, and linking both silently bound
  one's calls to the other's implementation — see the Makefile's note on the
  two regex engines.
- **No dependencies and no platform `#ifdef`s.** It builds anywhere C11 does,
  and the Makefile builds it `-std=c11 -Wshadow` so that stays checkable.
- **The arena owns everything.** Allocating outside it introduces the first
  ownership rule in the parser — do not.
- **The generated tables are regenerated, not edited.** `scripts-generate-emoji.mjs`,
  `scripts-generate-props.mjs` and `scripts-generate-schema.mjs` read the same
  packages and modules mdy-docs does; each says how to run it.
- Comments say *why*, and record what was measured or what went wrong.
