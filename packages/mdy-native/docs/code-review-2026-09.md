# Code review, September 2026

A read-through of everything first-party in `packages/mdy-native` — `src/`,
`src/parse/`, `test/`, the scripts, the wasm wrapper and the Makefile — looking
for bugs, unused code, structures that have grown past their shape, and what
will make the next year of changes harder than it needs to be. Vendored code
(`third_party/md4c`, `third_party/stb`, the highlight.js fork's grammars) was
not reviewed.

Every bug listed under *Confirmed* was reproduced against `build/mdy` and, where
it makes sense, against `node bin/mdy.js` on the same input. The commands are
in the appendix so each can be re-run. Findings marked *by reading* were traced
in the code but not executed.

The baseline is good: `make check-engine` (twice, the second under
`MDY_GC_STRESS`), `check-ingest`, `check-golden`, `check-determinism`,
`check-cli` (34/34) and `check-sites` (all five sites byte-identical) all pass,
and the four sample sites build clean under AddressSanitizer. What follows is
what those checks do not reach.

## Summary

| # | Severity | Where | What |
| --- | --- | --- | --- |
| B1 | ~~High~~ **fixed** | `engine.c` directory walk | A `.yaml` file beginning with `---` desynchronised every document's identity |
| B2 | ~~High~~ **fixed** | `engine.c` directory walk | An empty or whitespace-only `.mdy` file shifted every later document's identity |
| B3 | ~~High~~ **fixed** | `engine.c` render memo | `$.render` of a `.md` document yielded an empty or *wrong* token |
| B4 | ~~High~~ **fixed** | `engine.c` querying | `$.find` was cubic in the size of the set |
| B5 | ~~Medium~~ **fixed** | `engine.c` / `nis.c` | The nisaba collection was never closed: memory grew on every rebuild |
| B6 | ~~Medium~~ **fixed** | `engine.c` render memo | The two-generation memo never hit across builds |
| B7 | ~~Medium~~ **fixed** | parser, writer, engine, YAML | Unbounded recursion: crafted input crashed the process |
| B8 | ~~Medium~~ **fixed** | `engine.c` directory walk | A file name containing `"` or `\` silently lost its identity |
| B9 | ~~Medium~~ **fixed** | `yaml.c` | Text after a closing quote was silently dropped |
| B10 | ~~Medium~~ **fixed** | `cli.c` dev server | NULL engine dereference on delivery after a failed first build |
| B11 | ~~Medium~~ **fixed** | `images.c` | TIFF header reader: 32-bit overflow → out-of-bounds read |
| B12 | ~~Medium~~ **fixed** | `engine.c` | Render-depth counter leaked on an out-of-range index |
| B13 | ~~Low~~ **fixed** | `engine.c` / `engine_value.c` | Four unrooted property reads, and a GC stress mode that could not see them |
| B14–B27 | Low | various | Portability, leaks on error paths, truncation, UB casts |
| B28 | Low | `yaml.c` | A trailing `...` document-end marker is refused as "more than one document" |
| B29 | ~~Medium~~ **fixed** | `engine.c` natives | `$.count` is missing: a document reading it gets `undefined` |
| B30 | Low | `doc.c` | A CRLF source: the splitter normalises line endings, node keeps them |
| B31 | Low | `engine.c` records | A record's keys come back in a different order, and `$.data` carries an `_id` node hides |
| B32 | ~~Medium~~ **fixed** | `fsx.c` listing | A file name containing a newline was split in two and the file disappeared |
| B33 | Medium | **mdy-docs** | The render memo serves a stale `$.count`: a rebuild after a file is added keeps the old number |

Plus: ~450 lines of dead code (§2), a set of structural liabilities (§3 — of
which the largest, `engine.c` as one 5,000-line translation unit, is now four
files and a private header), and
the maintainability items in §4 — of which the most important is that the
directory walk, the dev server and the HTTP layer had no tests that could
have caught B1–B3, B5, B6 or B10. The walk and the dev server have them now;
the HTTP layer still does not. (B1's through B7's fixes come with tests of
their own — `data_file_checks`, `blank_file_checks`, `markdown_render_checks`,
`query_order_checks`, `reopen_checks`, `memo_key_checks` and
`deep_value_checks` in `test/engine.c`, plus depth checks in `test/parse.c`
and `test/yaml.c`.)

---

## 1. Bugs

### Confirmed

#### B1 — A `.yaml` file that begins with `---` corrupts the document set (High) — FIXED

**Fixed.** A data file's bytes are no longer part of the concatenated source.
`open_dir_inner` parses them once as YAML ([engine_walk.c:855](../src/engine_walk.c#L855))
and the mapping travels beside the document in a new `ident_data`
([engine_internal.h:227](../src/engine_internal.h#L227)), merged in `mdy_engine_open` after the
document's own fields and before `path`
([engine.c:580](../src/engine.c#L580)) — which is where mdy-docs puts a
source's `meta` (`parseDocuments`, `src/mdy.js`). The file's document is now
the same placeholder every other non-MDY file gets, so a `---` or a `+++` line
among its bytes can no longer be read as document structure, and the identity
count cannot drift. A file that is unreadable YAML, or is not a mapping, warns
and keeps its raw identity exactly as `walkRawSources` does. Regression test:
`data_file_checks` ([test/engine.c:251](../test/engine.c#L251)), which fails
on the old code in all three assertions. Byte-identical to node on the repro
below, on `---`/`...`/`+++` variants, and across all five `check-sites` sites.

A side effect worth naming: a data file's `tags` now come through as the
file's own value rather than the lowercased, deduplicated hashtag list a
document body earns. That is what node does — the walk's `meta` is merged
after that list is computed — and the C engine had been diverging.

The original finding follows. Its line numbers are the file as it stood at
`6c6061a`, before the fix — some of the code they name is gone.

`open_dir_inner` builds ONE text for the whole directory, separating files with
`---` lines and wrapping a `.yaml` file's bytes in a synthetic `+++` block
(`engine.c:1629–1652`). The bytes are copied raw (line 1647).
`mdy_engine_open` then splits that text on `/^---[ \t]*$/` (`engine.c:2280`)
— so a YAML document marker inside a data file is read as a document
separator. The identity arrays (`ident_pre`/`ident_post`/`ident_is_md`) were
sized by counting one document per non-`.mdy` file (`engine.c:1654–1671`) and
are indexed by document position (`2357`, `2378`, `2419`), so every document
after that file gets the identity of its neighbour.

`---` at the top of a YAML file is a common convention, and the YAML reader
itself accepts it ([yaml.c:1103–1106](../src/parse/yaml.c#L1103-L1106)).

Repro (site with `data.yaml` = `---\ntitle: Data file`, `zed.yaml`, and a
`main.mdy` that lists `$.find({})`):

```
C:    title: Data file / +++ / ​        (main.mdy resolved to the wrong chunk)
node: - data.yaml | name=data.yaml … - main.mdy … - zed.yaml | title=Bee
```

Same mechanism, smaller effect: a line of exactly `+++` inside a `.yaml` file
closes the synthetic front matter early, and the fields after it are silently
dropped (node refuses that file with a warning and keeps its raw identity).

#### B2 — An empty `.mdy` file shifts every later identity (High) — FIXED

**Fixed.** The walk no longer joins the files into one text. Every file is its
own source and is split on its own, which is what mdy-docs' `parseDocuments`
does with an array: `mdy_split_sources`
([doc.c:173](../src/parse/doc.c#L173)) appends each source's documents to one
list and says how many each became, and the walk asks it once
([engine_walk.c:920](../src/engine_walk.c#L920)) instead of counting beforehand and
re-deriving afterwards. Identity is collected per FILE while the walk runs
(`WalkedFile`, [engine_walk.c:684–690](../src/engine_walk.c#L684-L690)) and expanded
to one entry per document once the count is known
([engine_walk.c:943](../src/engine_walk.c#L943)). The two computations that had to
agree are one computation, so there is nothing left to disagree.

The "when nothing survives, ONE empty document" rule is now applied per source
([doc.c:132](../src/parse/doc.c#L132)), which is the whole of the difference:
joined, an empty file was a blank chunk between two separators and vanished.
An empty `.mdy` is a document again, as it is under node.

Two things fell out. A file's trailing newline is its own now — the joined
text needed a `\n` folded into each separator to keep it, which is gone — and
a directory with no source files in it is a set of zero documents rather than
one empty one, which is also what node reports. `mdy_engine_open` splits and
then hands the documents to a shared `open_documents`
([engine.c:435](../src/engine.c#L435)), so both ways in run the same code.

Regression test: `blank_file_checks`
([test/engine.c:343](../test/engine.c#L343)), which fails on the old code in
all four assertions. Byte-identical to node on a directory of empty, blank,
`---`-only, multi-document and front-matter files, on the entry lookup, on
`$.text` and `$.data` indices, and across all five `check-sites` sites.

The original finding follows. Its line numbers are the file as it stood at
`84f4bd4`, before the fix.

For a `.mdy` file, the number of documents it contributes is computed by
splitting the file *on its own* (`engine.c:1670–1675`), where an empty source
is "ONE empty document" by the splitter's rule (`doc.c:111–117`). In the
concatenated text the same file is a whitespace-only chunk between two
separators, which the same rule *drops*. One identity too many is recorded,
and every document after it is off by one.

Repro (`a.mdy` empty, `main.mdy`, `zed.mdy`): the C engine renders `zed.mdy`'s
body ("hello") when asked for `main.mdy`; node lists all three correctly.

B1 and B2 were the same design flaw: identity is smuggled through the text
splitter as synthesised YAML instead of being attached to each document as
data. B1's fix took a data file's bytes out of that text; B2's took the text
apart. What is left of the class is B8 — identity is still written as YAML
source, it is just no longer at risk of being re-split.

#### B3 — `$.render` of a `.md` document returns an empty or wrong token (High) — FIXED

**Fixed.** `render_tree_out` has one exit. The markdown branch sets `out` and
jumps to `done:` ([engine.c:3003](../src/engine.c#L3003)) like every other
path, so `e->last_render_key` is written for it too and `render_native` parks
the tree under the key of the render that actually made it.

The other two exits went with it, which is B12 below. The index check is a
`FAIL` ([engine.c:2992](../src/engine.c#L2992)) and gives back the depth and
the `current` it had already taken; the cycle guard moved ABOVE everything
`done:` restores ([engine.c:2957](../src/engine.c#L2957)), which is what
earns it the right to skip the label — there is nothing yet to give back.
Before the move it silently cleared the enclosing render's `taint` on its way
out.

Regression test: `markdown_render_checks`
([test/engine.c:430](../test/engine.c#L430)). It reproduces both shapes on a
`.md` nothing has rendered yet, which matters: a SECOND render is answered
from the memo, and the memo's exit was always correct, so a test that reuses
one proves nothing. On the old engine the first assertion gives `|` and the
second `<p>layout text</p>|<p>layout text</p>`. Byte-identical to node on
direct renders, a render carrying a request, a `.md` nested inside a rendered
`.mdy`, `$.toc` over a `.md` token, inline composition and `$.text`.

The original finding follows. Its line numbers are the file as it stood at
`766c503`, before the fix.

`render_tree_out` returns early for a markdown document
(`engine.c:4820–4839`) without reaching the `done:` label, which is where
`e->last_render_key` is written (`engine.c:5031`). `render_native` then parks
the tree under that stale key (`engine.c:2267`):

- if nothing rendered before, the key is `""`, `token_at` refuses an empty id,
  and the token is never spliced — the content silently disappears;
- if something did render before, the `.md` tree is parked under the *previous*
  render's id, `held_find` returns the first entry with that id, and the page
  shows the previous render twice.

Repro:

```
main.mdy:  A: {{ $.render({ path: "a.md" }) }}  B: {{ $.render({ path: "b.md" }) }}
C:    <p>A:  B: </p>
node: <p>A: <h1 id="alpha">Alpha</h1>first body B: <h1 id="beta">Beta</h1>second body</p>

main.mdy:  L: {{ $.render({ path: "lay.mdy" }) }}  A: {{ $.render({ path: "a.md" }) }}
C:    <p>L: layout text A: layout text</p>
node: <p>L: layout text A: <h1 id="alpha">Alpha</h1>md body</p>
```

The five `check-sites` sites never render a `.md` through `$.render`
(docs-site goes through `$.markdown`), which is why this is invisible today.

#### B4 — `$.find` is O(N³) in the number of documents (High) — FIXED

**Fixed.** The set carries a map from `_id` to document index
([engine.c:789](../src/engine.c#L789)) — open addressing on the 24 hex
characters, built the first time a query asks and freed with the set, so it is
exactly as valid as `ids` is. `index_of_id`
([engine.c:809](../src/engine.c#L809)) is a lookup rather than a scan.

The ordering pass reads each hit's `_id` ONCE
([engine.c:870](../src/engine.c#L870)) and sorts the hits by the index it
resolves to, instead of walking every document position against every hit.
Two allocations per inner step went with it: the `_id` atom was being interned
again on every one of them, and the id itself converted to UTF-8 — the units
are read in place now, which also means the loop has no safe point and so
nothing in it to root.

Measured on a site of N one-line documents whose entry runs one `$.find({})`:

| N | before | after | node |
| --- | --- | --- | --- |
| 300 | 0.27 s | 0.04 s | 0.64 s |
| 600 | 1.83 s | 0.07 s | 0.72 s |
| 1,200 | 12.67 s | 0.15 s | 0.81 s |
| 2,400 | 109.30 s | 0.29 s | 1.07 s |
| 4,800 | — | 0.64 s | 1.51 s |

Every doubling used to cost seven to eight times the work. It costs two now,
and 4,800 documents is a corpus the old engine could not have finished.

Regression test: `query_order_checks`
([test/engine.c:518](../test/engine.c#L518)). It PASSES on the old engine too,
and says so — the fix changes what a query costs, not what it answers, so the
evidence for the bug is the table above and what the test guards is the new
lookup. Two hundred documents, enough for real collisions and probe runs in
the map, each numbered backwards against its own position so an answer in id
order or in `n` order would say so. Byte-identical to node on a full find, a
filtered find, `$gt`, `findOne`, no match, `withTag`, a cross-package find,
and `$.render` by document, by query and by index.

#### B5 — The nisaba collection is never closed (Medium) — FIXED

**Fixed.** `close_set` closes the collection and puts the handle back to -1
([engine.c:411](../src/engine.c#L411)), so a set's data dies with the set.
`nis_close` was finished first ([nis.c:232](../src/nis.c#L232)): it freed the
stores but never the B+trees over them, which is a tree's buffers per index
plus one for the primary store. The two open paths that could leak a tree on
failure were closed with it.

Measured with the memo rotated per cycle, as the CLI does — open+render+free
of `examples/blog` (16 files), peak RSS:

| cycle | before | after |
| --- | --- | --- |
| 1 | 6.8 MB | 5.2 MB |
| 50 | 29.1 MB | 14.2 MB |
| 100 | 43.6 MB | 14.5 MB |
| 200 | 72.1 MB | 15.6 MB |
| 400 | — | 15.8 MB |

Before, about 0.33 MB per rebuild with no sign of stopping. After, flat from
roughly cycle 250. A leak checker saw nothing either way and still does: the
memory stayed reachable from nisaba's slot table, which nothing marked free,
so only RSS showed it.

Regression test: `reopen_checks` ([test/engine.c:604](../test/engine.c#L604)).
The leak itself is not a thing a check can assert, but the other half of the
same fact is — opening a set twice on ONE engine, which could not be done at
all: the second open reached a collection that still had the first set's
`path` index and nisaba refused it with `-2`. It works now, and the second set
is the whole set. On the old engine two of its three assertions fail.

#### B6 — The memo never hits across builds (Medium) — FIXED

**Fixed.** `document_fingerprint` hashes the record without `_id`
([engine.c:2898](../src/engine.c#L2898)). `canonical_hash` grew one parameter
for it ([engine.c:2804](../src/engine.c#L2804)) — a single key left out, of
the TOP object only, since a value nested inside may legitimately be called
the same thing and is the document's own business. mdy-docs hashes
`doc.data`, which is this record before nisaba puts an id on it.

Enabling cross-set hits needed one thing more. The memo is shared by every set
in the process, and two documents with the same text and the same record still
render differently under a different element allowlist, a different task form
or different values in scope — so those go into the fingerprint beside the
record ([engine.c:2885](../src/engine.c#L2885)). mdy-docs folds in its own
equivalent, the native names a set offers, and gives the same reason. Nothing
had needed it before because `_id` was keeping every set's keys apart by
accident.

`MDY_MEMO_DEBUG=1` over consecutive rotate+open+render cycles of
`examples/blog`:

```
before              after
cycle 1:  4 hits, 34 misses    cycle 1:   4 hits, 34 misses
cycle 2:  4 hits, 34 misses    cycle 2:  34 hits,  4 misses
cycle 3:  4 hits, 34 misses    cycle 3:  34 hits,  4 misses
```

100 rebuild cycles of the same site take 2.27 s and now take 0.95 s, and peak
RSS over 400 of them is 12.9 MB where B5's fix alone left it at 15.8 — a hit
is a parse that does not happen.

Regression test: `memo_key_checks` ([test/engine.c:671](../test/engine.c#L671)).
The key is not reachable from the API but its shadow is: a composed document's
token carries the key of the render it stands for, and `$.text` hands the token
back in the text. Two builds of one source name that render the same now and
did not before; two builds under different knobs still do not, which is what
pins the second half. End to end, `mdy --watch` over a site whose `.md` is
edited and then reverted serves the edit, and then serves the original from
the generation that still held it.

#### B7 — Unbounded recursion on nested input (Medium) — FIXED

**Fixed**, but not by capping the walkers. There are thirteen of them over an
`mdy_node` tree and capping one only moves the crash to the next, so instead
the trees are built shallow enough that none of them needs a check:
`MDY_MAX_DEPTH` ([mdyast.h:107](../src/parse/mdyast.h#L107)) is stated beside
the type as a property of it, the way md4c holds its own front end to 128.
Four places enforce it, which is every way a value gets deep:

- the `<div>` chain for an indented line
  ([block.c:1316](../src/parse/block.c#L1316)) — the only construct that nests
  without the source growing with it, so the only one that could reach two
  hundred thousand from one short line. Past the limit the line is read where
  it stands, with a `nesting-depth` warning through the channel the sanitizer
  already uses. `mdy_parse_block` carries a `nesting` argument now, so two
  chains one inside the other are held against the total rather than each
  passing a check of its own.
- `parse_flow` ([yaml.c:593](../src/parse/yaml.c#L593)) — `MDY_YAML_MAX_DEPTH`
  ([mdyyaml.h:56](../src/parse/mdyyaml.h#L56)), refused with a message naming
  the line, since that is what this reader does with what it will not guess
  at. It also protects the JSON writer, the binjson encoder and the engine's
  hash, all of which walk the result.
- `js_to_tree` ([engine_value.c:228](../src/engine_value.c#L228)) — a document can build a
  sixty-thousand-deep tree in two lines of its own code. Past the limit the
  branch is dropped, which is the answer the parser gives text nested that
  deep.
- `canonical_hash` ([engine.c:2813](../src/engine.c#L2813)) — the same document
  can hand such an object to `$.render` as its request, and the memo key walks
  it. Past the limit there is NO key: hashing a marker and carrying on would
  make two different requests hash alike, and a key that cannot tell them
  apart is a render served to the wrong one. A render with no key is named by
  count instead, so two of them are two.

Nineteen crafted inputs were run before and after — deep indentation with and
without a transform, deep flow YAML in front matter and in `--data-file` and
in `--scope`, a deep `$.node` tree, a deep tree from a transform, a deep
render request, a deep find filter, a deep `$.emit` payload, a deep `$.publish`
payload, deep `$.parse` and `$.markdown` input, four thousand nested list items
and nested elements, and two hundred thousand inline `//`, `[[` and `<div>`.
Four of them segfaulted; none does now. Each either renders or refuses with a
message.

Regression tests: `test/parse.c` (a line of 400,000 spaces is read flat, and
says so once, while an ordinary indent still nests), `test/yaml.c` (200,000
`[` is refused, while `[[[1]]]` is not), and `deep_value_checks` in
`test/engine.c` ([710](../test/engine.c#L710)) — two thousand rather than sixty
thousand, because what is checked is the bound, which bites at 256 either way,
and sixty thousand nested objects built in the guest costs the suite a minute
for nothing.

The original finding follows.

Several walkers recurse per nesting level with no depth limit:
`write_node` ([html.c:298–379](../src/parse/html.c#L298-L379)), `mdy_clone`
([ast.c:132–194](../src/parse/ast.c#L132-L194)), `tree_to_js`, `js_to_tree`,
`splice_tree`, `collect_headings` in engine.c, and `parse_flow` in yaml.c. The
block parser builds the `<div>` chain for an indented line iteratively but then
every downstream pass recurses over it.

- A single line indented by 400,000 spaces (200k nested divs, a 400 KB file):
  `mdy file.mdy --html` exits 139 (segfault).
- YAML `a: ` followed by 200,000 `[`: `yamlcat` exits 139.

md4c's front end caps at 128 levels and refuses cleanly
([markdown.c:22](../src/parse/markdown.c#L22)); the rest should do the same. For
a build tool fed its own site this is low risk; for the live preview and the
wasm `document()` API, which take arbitrary typed input, it is a crash.

#### B8 — A file name containing `"` or `\` silently loses its identity (Medium) — FIXED

**Fixed.** `put_quoted` ([engine_walk.c:158](../src/engine_walk.c#L158)) writes an
identity field as YAML with the value escaped the way `read_quoted` unescapes
it — `\` and `"` named, control characters as `\xNN`, and everything else
including UTF-8 through as bytes, since only what the reader would take for
something else has to be named. The walk builds identity with it
([engine_walk.c:769](../src/engine_walk.c#L769)) into a buffer that grows, which
retires the fixed 4096-byte array as well: a long enough name and path would
have been truncated mid-mapping and lost the document its `path` entirely. I
could not construct one on macOS, where `PATH_MAX` is 1024, so that half is a
hazard removed rather than a bug reproduced.

Identity is still written out and read back, which is the part of §3's
*Identity as text* that remains. It would not need escaping at all if it were
built as values and handed to `mdy_bj_document` — that wants a way to make an
`mdy_yaml` mapping from C, which there is not.

Regression test: `odd_name_checks` ([test/engine.c:774](../test/engine.c#L774)),
guarded out on Windows, where none of these characters is legal in a file name
and so there is nothing to carry. On the old engine it reports
`slash=a.mdy|a.mdy` — the `\b` read as a backspace — and `quote=it|it`.
Byte-identical to node across `"`, `\`, a bell, an apostrophe, a semicolon,
`café-😀`, a file with no extension, a nested path, and each of `.mdy`, `.md`
(tags and all) and `.yaml` (its own `name` still winning over identity).

The original finding follows.

Identity is written as YAML text by `snprintf` with no escaping
([engine_walk.c:767–767](../src/engine_walk.c#L767-L767), [874](../src/engine_walk.c#L874)).
A name like `it"s.mdy` produces `name: "it"s.mdy"`, which the YAML reader
reads as `it` (see B9) — so the document's `path`, `name` and `ext` are all
truncated at the quote. Node reports `it"s.mdy`. A backslash in a name would
be read as an escape. Either escape the values or stop encoding identity as
text (see §3, *Identity as text*).

#### B9 — YAML: trailing text after a closing quote is dropped (Medium) — FIXED

**Fixed.** A quoted scalar ends at its closing quote, and what may follow on
that line is nothing, or a comment — `nothing_after`
([yaml.c:741](../src/parse/yaml.c#L741)), checked where `parse_value_from`
used to walk straight on to the next line. `title: "Hello" world` is refused
with `unexpected text after a quoted scalar` rather than coming back as
`Hello`, which is what this file says of itself: "a parser that silently
mis-reads data is worse than one that refuses it".

**The same hole was one line up, in the KEY.** `"a"x: v` came back as
`{"a": "v"}`: `key_end` skips a quoted key and then scans on for a `:`, so the
colon it measured against was not this scalar's. A quoted key now has to be
followed by spaces and then that colon
([yaml.c:891](../src/parse/yaml.c#L891)) — a comment is not one of the
answers there, because `key_end` already stops at a `#`.

Every case was put to node's reader as well, and it refuses all three.
Regression tests in `test/yaml.c`
([231](../test/yaml.c#L231)) cover both, the line a MULTI-line quoted scalar
closes on, and what must keep working: a comment after a quoted scalar in
either quote style, trailing space, a space before a key's colon, and a colon
inside the key itself.

The corpus harness is the evidence that this is a tightening and not a
breakage: 440/440 YAML blocks across 8.4 MB still read identically to node,
and `check-sites` is byte-identical on all five sites.

#### B10 — `mdy dev`: crash on delivery after a failed first build (Medium) — FIXED

**Reproduced, and worse than filed.** The original said "with a remote
broker… by reading; not executed". No remote broker is needed: `mdy dev` opens
an IN-PROCESS one when `--broker` is absent, which is the default, and that
sets `d.live` — so the delivery endpoint is live on every `mdy dev`. Start one
on a site that does not compile and POST a batch at `/mdy/mdy-bus` and the
process is gone: `curl` reports `http 000`, the connection closed with no
response.

**Fixed.** `dev_deliver` holds when there is no build
([cli.c:1704](../src/cli.c#L1704)): 500 returns the messages to the broker,
which brings them back after a backoff, by which time a save may have fixed
the build. Routing them with no engine would have found no page of that name,
which is a different thing and settles them away — so the guard has to come
before the routing, not be folded into it. `dev_drain`, the in-process path,
does not take messages it cannot render either
([cli.c:1500](../src/cli.c#L1500)); they stay queued for the drain after the
next good build. And `mdy_engine_page_index` and `mdy_engine_document_path`
tolerate a NULL engine ([engine.c:3261](../src/engine.c#L3261)), which is the
convention `mdy_engine_count` already sets in that file.

**The dev server has a test now** — its first, which is the real reason this
went unnoticed. `test/dev.test.js` with a `check-dev` target
([Makefile:271](../Makefile#L271)) and a CI step: it spawns the binary on a
site that does not compile, waits for the banner, POSTs a delivery, and
asserts 500, the `[hold]` line, and that the process is still running. Then it
fixes the site, waits for the rebuild and POSTs again, which is the half that
shows holding was the right answer rather than merely a survivable one. On the
old binary the first POST fails with `socket hang up`.

Native only, and not in `../../test/cli.test.js`: the in-process broker is
this binary's, and `bin/mdy.js`'s dev server has no delivery endpoint at all —
it answers 404 — so there is no shared behaviour to hold both to.

#### B11 — TIFF dimension reader: 32-bit overflow → out-of-bounds read (Medium) — FIXED

**Reproduced**: eight bytes — `II*\0` and `0xFFFFFFFE` — in a `.tif` anywhere
under a site, and `mdy` exits 139. AddressSanitizer calls it a `BUS` on an
address four gigabytes out, reached from `open_dir_inner`.

**Fixed.** The offset is the file's to choose and nothing has checked it when
the sum is taken, so every sum it takes part in is done in 64 bits
([images.c:169](../src/images.c#L169)) — the bounds check and the per-entry
offset both. `uint64_t` rather than the `size_t` the finding suggested:
`size_t` is 32 bits under emscripten, and `make wasm` is a real target, so the
promotion would wrap in exactly the same place there.

The rest of the file was read for the same shape and has none: `jpeg_size`
does its arithmetic in `size_t` bounded by `n`, `webp_size` reads fixed
offsets behind length guards, and `isobmff_size` walks with `i + 20 <= n`.

Regression test: `bad_image_checks`
([test/engine.c:858](../test/engine.c#L858)) — the wrapping offset in both
byte orders, one just past the end, a directory count that would walk entries
off it, a header cut short, an empty file, and a real PNG beside them so the
reader is not merely refusing everything. Each broken one costs the file its
size and not the build, which is what the walk already promises about a
picture it cannot decode. On the old `images.c` the test segfaults the test
binary.

Beyond the test: two hundred `.tif` files of random bytes behind a valid magic
number, clean under AddressSanitizer and all two hundred still documents. And
on a real TIFF (`sips`-converted, 200×140) this engine and node agree, which
they do not on a hand-made minimal one — node's reader wants more of a file
than the eight bytes a header needs.

#### B12 — Render depth leaks on an out-of-range index (Medium) — FIXED

**Fixed** with B3, as one change: the index check is a `FAIL` now and leaves
through `done:`, which gives back the depth, the `current` and the `taint` it
had taken. Pinned in the block that already asked for an index that is not
there ([test/engine.c:1392](../test/engine.c#L1392)) — forty times over, and
then the document that IS there still renders. On the old engine the
thirty-third of those exhausted the cycle guard and nothing rendered again.

The original finding follows. Its line numbers are the file as it stood at
`766c503`, before the fix.

`render_tree_out` increments `e->depth`, replaces `e->current` and zeroes
`e->taint` (`engine.c:4780–4805`) *before* the index check at
`engine.c:4809`, which returns without restoring any of them. Demonstrated:
40 calls to `mdy_engine_render(e, 99, …)` followed by
`mdy_engine_render(e, 0, …)` fails with "render depth exceeded (cyclic
$.render?)". `test/engine.c:1114` exercises exactly this path and cannot
notice. Move the check above the state changes.

#### B29 — `$.count` is missing from `$` (Medium) — FIXED

mdy-docs gives a document `$.count`, the number of documents in the set — it
is written into the generated program beside `$.data` and the rest
(`src/mdy.js`, `buildProgram`). The C engine binds `$` as host natives and
never sets it, so `{{ $.count }}` is `undefined` where node says `2`. Nothing
reports it: it is a missing property, not a failed call.

```
printf '= {{ $.count }}\n---\n+++\na: 1\n+++\n' > c.mdy
./build/mdy c.mdy --html      # <h1 id="undefined">undefined</h1>
node ../../bin/mdy.js c.mdy --html   # <h1 id="2">2</h1>
```

Found while fixing B2; it has nothing to do with the walk. `$.find({}).length`
is the workaround a site would have reached for, which is probably why no site
in the tree has noticed.

**Fixed, in three places rather than one.** `$` is built in the guest by
`wrap()`, and `count` is the only member of it that is not a call
([engine.c:2510](../src/engine.c#L2510)). mdy-docs can write the number in as a
literal because it builds a program per document; this wrapper is compiled once
and reused for every render of the document — that is what makes the request an
argument — so the number arrives on `$$` beside `__scope` and `__wantResponse`
([engine.c:3098](../src/engine.c#L3098)) and is read at object construction, so
`$.count` is a plain number to the document either way.

The third place is the memo, and it is the half that was not obvious. **The
size of the set is not part of any document's text or its record**, so adding a
file to a directory leaves every other document's fingerprint untouched. A
second build in the same process — which is what `mdy dev` is — would then
serve each of them the render made when the set was smaller, with `$.count`
frozen at the old number in a page that is otherwise correct and reports
nothing. So the size goes into the fingerprint beside the knobs
([engine.c:2903](../src/engine.c#L2903)), which is the same argument that
comment already makes for the element allowlist: what the ENGINE brings to a
render belongs in the key.

It costs no reuse. Two builds of `examples/blog` in one process: 48 memo hits
and 60 misses with the set size in the key, and 48 and 60 without it — the
count cannot differ between two builds of a set that did not change, which is
exactly when the memo is being asked to help.

`count_checks` in `test/engine.c` covers both halves, and each half was
confirmed to fail with only the other applied: without the binding, `= {{
$.count }}` renders `= undefined`; without the size in the key, the second
build of a three-document set renders `<h1 id="2">2</h1>`.

**mdy-docs has the second half of this bug** — see B33, which is this
measurement pointed the other way.

#### B30 — A CRLF source: the splitter normalises, node does not (Low)

`acc_source` drops a `\r` before the line ending
([doc.c:98](../src/parse/doc.c#L98)) — deliberately, so "a chunk's own line
endings are `\n` whatever the file used". node's `splitDocuments` splits on
`\n` and rejoins, so the `\r` stays in the chunk and the script layer then
makes two line breaks of it. `$.text` of a CRLF document is
`"crlf line\nsecond\n"` here and `"crlf line\n\nsecond\n\n"` there.

Reproduces in document mode with one file, so it is nothing to do with the
walk. The C behaviour is the more defensible of the two, which is why this is
filed as a divergence to decide about rather than a bug to fix: matching node
here means reproducing something that looks accidental.

#### B31 — A record's keys are in a different order (Low)

A document sees its own record as an object, and the order its keys come back
in is not node's:

```
$.find({})  C: ["_id","title","name","ext","size","mtime","path"]
         node: ["title","path","name","ext","size","mtime","_id"]
$.data(0)   C: ["_id","title","name","ext","size","mtime","path"]
         node: ["title","path","name","ext","size","mtime"]
```

Two differences. `_id` is first here and last there — and `$.data` does not
carry it at all under node, while it does here. And the identity block is
written `name, ext, size, mtime, path`
([engine_walk.c:767–767](../src/engine_walk.c#L767-L767)), `path` last so that it
wins over a data file's own; node reaches the same result with
`{ ...meta, ...parsed, path }`, where re-assigning `path` leaves it in the
position it was first written — first.

It costs nothing until a document serialises a record or walks its keys, at
which point the two engines disagree about the bytes. No site in the tree
does, which is why `check-sites` is green. Found while fixing B2; it predates
both fixes.

#### B32 — A file name with a newline in it disappears (Medium) — FIXED

**Fixed.** The listing separates on `\0` and ends with an empty entry
([fsx.h:24](../src/fsx.h#L24)), which is the one byte a file name cannot hold.
`walk` writes each path with its own terminator
([fsx.c:174](../src/fsx.c#L174)), `fsx_list`'s sort counts and splits on it
([fsx.c:253](../src/fsx.c#L253)), and all three readers became the same one
line — `for (const char *rel = listing; *rel; rel += strlen(rel) + 1)` — in
the engine's walk ([engine_walk.c:737](../src/engine_walk.c#L737)), `cli.c`'s static
copier ([636](../src/cli.c#L636)) and `watch.c`'s snapshot
([48](../src/watch.c#L48)). Each of them lost a `strchr`, a mutation of the
buffer and an empty-entry guard.

`fsx_readdir` went with it, and its one caller `fsx_rm_rf`: a test that makes
a file named this way has to be able to delete it again, and that one split on
`\n` too.

All three paths were checked end to end against node: the document set
(`new\nline.mdy` is a document with its own record), `mdy build`'s static copy
(the file is written under its real name), and `--watch` (an edit to it
rebuilds). Regression test: `odd_name_checks`
([test/engine.c:774](../test/engine.c#L774)), which now carries a newline
beside the quote, the backslash and the control character.

The original finding follows.

`fsx_list` returns the walk as one string, "one per line", and every caller
splits it on `\n` — the engine's walk, `cli.c`'s static copier and `watch.c`'s
snapshot. A file name may contain a newline on any POSIX system, and
`new\nline.mdy` becomes two entries, `new` and `line.mdy`, neither of which
exists. The file is silently not part of the site; node has it.

```
C:    [read] line.mdy … [read] new        (and no document for either)
node: - new\nline.mdy | name=new\nline.mdy
```

Found while fixing B8, and the same shape as it — a file name carried through
a text encoding that cannot hold every file name — but a different component:
this one is decided before identity is built, so escaping identity does not
reach it.

#### B33 — mdy-docs: the render memo serves a stale `$.count` (Medium)

This one is node's, not this engine's. It was found by asking what B29's fix
had to do about the memo, and then checking what mdy-docs does about it.

`buildProgram` embeds the count in the program text as a literal
(`src/mdy.js`, `count: ${count}` from `documents.length`). The render memo is
keyed on `doc.fingerprint`, which is

```js
`${setSignature}\u0000${doc.data?.path ?? doc.index}\u0000${doc.body ?? ''}\u0000${JSON.stringify(doc.data ?? null)}`
```

— the native names, the path, the body and the record. **Not the size of the
set.** So a document that reads `$.count` has a fingerprint that does not
change when the count does, and `renderMemoPrev` hands the previous build's
render back.

Two builds in one process, a file added between them:

```js
import { renderSite } from 'mdy-docs/src/build.js';
await build('two documents:');            // main.mdy emits $.html($.render({ path: "card.mdy" }))
fs.writeFileSync(dir + '/c.mdy', '= c\n'); // card.mdy is `= count is {{ $.count }}`
await build('after adding a third:');
```

```
two documents:           <h1 id="count-is-2">count is 2</h1>   (files on disk: 2)
after adding a third:    <h1 id="count-is-2">count is 2</h1>   (files on disk: 3)
```

The page is otherwise correct and nothing is reported. It needs all three of:
a long-lived process (`mdy dev`, `--watch`, or an embedder calling
`renderSite` twice), a document whose render is memoised at all — one that
emits or otherwise taints re-runs every build and so hides this — and a
document that reads `$.count`. The last is rare, which is the same reason
B29 went unnoticed here.

**This engine deliberately does not reproduce it** (B29): `e->count` is in the
fingerprint. That makes `mdy dev` a place where the two engines disagree, and
it is the one divergence in this document where the C answer is the right one
by construction rather than by accident. `check-sites` does not see it: it
builds each site once per process, where the two agree.

The fix in node is one term in one template string — the fingerprint wants
`documents.length` in it, next to `setSignature`, for the reason the comment
above `setSignature` already gives about two sets meeting in one process.

#### B28 — YAML: a trailing `...` is refused as a second document (Low)

`mdy_yaml_parse` rejects any `...` line at indent 0 as "more than one document
in a stream" ([yaml.c:1099–1100](../src/parse/yaml.c#L1099-L1100)), but a `...`
that CLOSES the one document — with nothing after it — is ordinary
single-document YAML, and the line just below already makes the symmetric
allowance for a leading `---`. So `a: 1\n...\n` is refused where node reads
`{a: 1}`, in a data file and in `+++` front matter alike. Found while fixing
B1; it is independent of the walk.

```
printf 'a: 1\n...\n' | ./build/yamlcat     # line 2: more than one document…
```

The fix is to let the marker through when `next_content` past it reaches the
end of the stream, and to stop the line walk there.

### By reading

- **~~B13 — GC rooting that works by luck.~~ FIXED, and the luck is now
  measurable.** The rule
  ([engine_value.c:85–104](../src/engine_value.c#L85-L104)) is that a value
  reachable only from the C stack must be rooted before anything allocates,
  and that building a key allocates. Four sites violated it:
  `js_object_get(e->vm, hit, key(e->vm, "_id"))` on an unrooted query result
  in `mdy_engine_entry` and `resolve_target`, on an unrooted decode in
  `lookup_import`, and `js_object_get(e->vm, document_record(e, i), key(…))`
  in `publish_native`.

  **Why they survived, and why that is the real finding.** `MDY_GC_STRESS`
  collects at every safe point — but `js_atom` of an atom that is ALREADY
  interned allocates nothing, so it is not a safe point, and every `"_id"` or
  `"path"` after the first one in a process is already interned. The stress
  mode could not reach this class of bug at all. Four unrooted reads were
  correct because the atom they asked for happened to be old.

  So the first change is to the stress mode, not to the four sites: under
  `MDY_GC_STRESS`, building a key now costs a collection whether it interns or
  not ([engine_value.c:75](../src/engine_value.c#L75)), which enforces the rule
  instead of assuming it. **It failed twelve checks the first time it ran.**

  The fix itself is one function. `set_val` already existed, and its comment
  already explained exactly this hazard for writes — the absence of the
  matching `get_val` is *why* the four sites existed. `get_val`
  ([engine_value.c:145](../src/engine_value.c#L145)) roots the object and
  builds the key after, as `set_val` does, and works for an object that is an
  rvalue at the call site because the parameter is the function's own stack
  slot. All forty-three inline-key reads across `engine.c`, `engine_value.c`
  and `engine_walk.c` were converted, so the shape is safe by construction
  rather than by audit.

  Two things checked rather than assumed. `js_object_get` allocates nothing —
  `js_object_key_lookup` only *finds* an atom — so the get is never itself a
  safe point and the whole of B13 was the key; the three reads that pass a
  pre-built key are therefore fine as they are. And each of the four sites was
  reverted alone, under the new stress mode, to confirm a test actually catches
  it. Two did not: `lookup_import` and `publish_native` could be put back
  unrooted and the suite stayed green. Both are genuine hazards —
  `document_record` builds a fresh object per call — so they were untested, not
  safe. `import_checks` is new (the engine test had *no* import coverage), and
  the publish ambiguity check now asserts the paths the message names rather
  than just the words "is ambiguous", which is the read that was unrooted. With
  those, reverting any one of the four fails the suite.
- **B14 — `report()` uses `strftime("%l")`** ([cli.c:1078](../src/cli.c#L1078))
  while `stamp_now`, twenty lines later, avoids `%l` precisely because
  emscripten and msvcrt lack it. The `--watch` status line is the one place it
  still appears.
- **B15 — Dev server leaks a refused publish's response**: the
  `r.status < 200 || r.status >= 300` branch never calls
  `http_response_free` ([cli.c:1431–1434](../src/cli.c#L1431-L1434)).
- **B16 — No socket timeouts** in `http.c` (connect, and a `recv` loop that
  runs until the peer closes, [152–159](../src/http.c#L152-L159)). A broker
  that accepts and never answers hangs `mdy build --publish`, `mdy dead` and
  the dev server's registration forever. `parse_url` also cannot take an IPv6
  literal (`http://[::1]:8080` → host `[`).
- **B17 — Dev server exposure**: it binds `0.0.0.0`
  ([cli.c:1946](../src/cli.c#L1946)) and the delivery bearer token is four
  `rand()` calls seeded from the clock ([1953](../src/cli.c#L1953),
  [2032](../src/cli.c#L2032)). The request buffer has no size cap
  ([httpd.c:255–260](../src/httpd.c#L255-L260)) and responses are written with
  a blocking `send` ([171](../src/httpd.c#L171)), so one slow LAN client stalls
  rebuilds. Binding `127.0.0.1` by default removes most of this.
- **B18 — Watcher scan is O(n²)**: `snapshot_changes` looks each file up with a
  linear `find` ([watch.c:63–91](../src/watch.c#L63-L91)) every 120 ms. Both
  snapshots come from `fsx_list`, which sorts, so a merge would be linear.
- **B19 — `mdy build`/`dev`/`dead` accept anything as the positional**: an
  unknown flag or a flag with its value missing falls into `else root = a`
  ([cli.c:668](../src/cli.c#L668), [1914](../src/cli.c#L1914),
  [440](../src/cli.c#L440)). `mdy build --draft` builds a site called
  `--draft`; `mdy build site --out` builds `--out`. Document mode (and the
  JavaScript CLI) reject unknown options.
- **B20 — Silent truncation into fixed buffers, all parity divergences with no
  warning**: heading ids over 255 bytes (`unique[256]`,
  [block.c:329](../src/parse/block.c#L329)) and heading text over 1 KB
  ([1396](../src/parse/block.c#L1396)); class names over 127 bytes
  ([549](../src/parse/block.c#L549)); attribute names over 255 (`lowered`,
  [497](../src/parse/block.c#L497), which then skips the lowercasing
  entirely); page hrefs over 1 KB, which skip normalisation *and* the
  reference collection ([530–537](../src/parse/block.c#L530-L537),
  [inline.c:707–714](../src/parse/inline.c#L707-L714)); tables with more than
  64 columns ([1074](../src/parse/block.c#L1074)); more than 512 URLs in one
  paragraph ([inline.c:160](../src/parse/inline.c#L160)); tag hrefs
  ([inline.c:458](../src/parse/inline.c#L458)), footnote ids
  ([footnote.c:33](../src/parse/footnote.c#L33)), TOC hrefs
  ([engine.c:1590](../src/engine.c#L1590)), identity records over 4 KB
  ([engine_walk.c:767](../src/engine_walk.c#L767), where a truncated `ident_len` can
  also underflow the second `snprintf`'s size). Each is unlikely alone; none
  says anything when it happens.
- **B21 — Undefined behaviour on double→integer casts** performed *before* the
  range check: [engine_value.c:305](../src/engine_value.c#L305), [ingest.c:22](../src/ingest.c#L22),
  [bjval.c:119](../src/bjval.c#L119), [html.c:210](../src/parse/html.c#L210),
  [ast.c:262](../src/parse/ast.c#L262), [yaml.c:1213](../src/parse/yaml.c#L1213).
  `.inf`/`.nan` from YAML reach `(int64_t)v` on the ingest path. Harmless on
  x86-64 and arm64 today; reorder the test.
- **B22 — `match_port` calls `strtoul` on a length-delimited slice**
  ([linkify.c:156](../src/parse/linkify.c#L156)); it reads digits past the
  slice's end, so a port like `:12345` immediately followed by digits outside
  the span is rejected where linkify-it accepts it, and on a buffer that is
  not NUL-terminated it reads past the end.
- **B23 — markdown link attributes ignore entity substrings**: `set_attribute`
  takes `a->text` whole ([markdown.c:218–221](../src/parse/markdown.c#L218-L221)),
  so `[x](http://a?b=1&amp;c=2)` keeps the literal `&amp;` and the writer
  escapes it again. The comment says "for the common case there is exactly
  one" substring; query strings are the common case where there is not.
- **B24 — Unchecked allocations that dereference on failure**: `outputs_put`,
  `collect_message`, `buf_put`, `seen_before`, `read_stdin`, `absolute` in
  cli.c; `add`/`snapshot_changes` in watch.c; the `recv` buffer in http.c
  ([155](../src/http.c#L155)); `broker_request` ([broker.c:104](../src/broker.c#L104));
  `mdy_engine_encode_json` ([engine.c:721](../src/engine.c#L721)); the fence
  body, list and paragraph joins in block.c ([1423](../src/parse/block.c#L1423),
  [1623](../src/parse/block.c#L1623), [1710](../src/parse/block.c#L1710),
  [1837](../src/parse/block.c#L1837)); `cache_put` frees the *new* array on a
  partial failure and leaves `c->dirs` dangling ([engine_walk.c:655](../src/engine_walk.c#L655)).
  The parser's stated rule is that `mdy_alloc` can fail; sixteen call sites in
  block.c never look.
- **B25 — `walk` treats every `opendir` failure as an empty directory**:
  `return errno == ENOENT ? 0 : 0` ([fsx.c:192](../src/fsx.c#L192)) — a
  permission error on a subtree silently drops it from the site.
- **B26 — Local-bus and remote-bus disagree on an undeliverable subject**:
  `dev_drain` passes `target < 0` for *any* subject with no page into the
  "dead-letter channel with no page" branch, which marks every message done
  ([cli.c:1552–1563](../src/cli.c#L1552-L1563)); `dev_deliver` returns 500 so
  the broker dead-letters them ([1719–1726](../src/cli.c#L1719-L1726)).
- **B27 — `wrap()` assembles the document's source with `snprintf("%s…")`**
  ([engine.c:2584–2587](../src/engine.c#L2584-L2587)); on a 3.6 GB input
  AddressSanitizer reports `negative-size-param` from the `int` return value
  overflowing. Pathological, but `memcpy` is also simpler.

---

## 2. Unused code

**Done**, except where a row says otherwise: 240 lines gone against 70 added,
and the default build is warning-free. What was NOT deleted is the four `fsx`
helpers `test/engine.c` actually calls — the row said they were for a suite
that is gone, and they are, but they have a caller now and the comment above
them was the thing to fix.

| Where | What | Notes |
| --- | --- | --- |
| `fsx.c`, `fsx.h` | "What the ported test suite needs": `fsx_readdir`, `fsx_mkdirp`, `fsx_rm_rf`, `fsx_mkdtemp`, `fsx_tmpdir`, plus `is_dir_path`/`remove_dir` | `fsx_remove` **deleted** — no caller anywhere. `fsx_readdir` is **static** now: its only caller is `fsx_rm_rf`, in the same file. The other four stay — `test/engine.c` calls all of them, and calling `mkdtemp` directly instead would not be portable to the Windows job. The header comment saying they back `../shims/node/` is **corrected**: that directory does not exist, and what they serve is the native tests. |
| ~~`oswin.c`, `oswin.h`~~ | `win_pread`, `win_pwrite`, `win_fsize`, `win_ftruncate`, `win_temp_file`, `win_close` | ~~Left from when nisaba's store was a temp file. No callers.~~ **Deleted** — 71 lines. |
| ~~`nis.c`~~ | `nis_close` | ~~No callers~~ — it has one now (B5), and it frees the B+trees it used to leave. Its neighbour comment and `nis.h`'s "a fresh temp file" are **corrected**: the store has been a buffer for longer than either of them said. |
| ~~`httpd.c`~~ | `httpd_query`, `httpd_kept_count`, `httpd_close` | ~~No callers (the dev loop never exits).~~ **Deleted** — 33 lines, counting the emscripten stubs that shadowed each of them. |
| ~~`Makefile`~~ | `build/libnisaba.a` | ~~Nothing links it; every engine binary recompiles all 20 nisaba sources from scratch instead.~~ **Deleted.** The recompiling is untouched and is §3's to fix; what is gone is a rule that pretended otherwise. A comment further down referred to it and now says the thing directly. |
| ~~`Makefile`, `test/doccat.c`, `test/datacat.c`~~ | Two drivers with build rules that no check target or script invokes | **Deleted**, rules and sources. `md4cprobe` is in the same state but **kept**: `docs/parser.md` names it as a manual baseline tool, which is the difference between a tool and a leftover. |
| ~~`cli.c`~~ | `is_help` | ~~Set, then `(void)is_help`.~~ **Deleted** — `canonical` already carries it. |
| ~~`engine.c`~~ | `column_align`'s `e` parameter | ~~Compiler warning in every build.~~ **Deleted**, with the argument at its one call site. |
| ~~`block.c`~~ | `(void)id_len` in `set_heading_id` | ~~The variable is only computed to be discarded.~~ **Deleted**, which took making `mdy_resolve_slug` accept a NULL `out_len` — it wrote through the pointer unconditionally, so there was no way to decline the answer. |
| ~~`block.c`~~ | `mdy_alloc(doc ? &doc->arena : NULL, …)` | ~~`doc` cannot be NULL there and `mdy_alloc(NULL)` would crash.~~ **Deleted** — the same function dereferences `doc` unconditionally three lines up. |
| ~~`engine.h`~~ | "WHAT THIS DOES NOT DO YET" | **Rewritten** to say what the engine does, since all three items were done. Same for `block.c`'s `shims/parse.js` (the script layer runs before the parser and hands it lines), `docs/cli-plan.md`'s `scripts-compare-cli.mjs` and "N/40 cases" (`check-cli` runs `cli.test.js` through `MDY_CLI`, 34 cases, and `check-dev` is beside it now), and `nis.c`/`nis.h`'s temp files and `host.c` finalizer, none of which exist — the store has been a buffer since before this review. |

**Duplicated rather than unused.** Four of the eight are folded — the ones
where the copies had drifted or the duplication was hiding something. The
other four are the same code written twice with no behavioural difference
between the copies, and folding them means choosing where a shared utility
lives, which §3 decides: `engine.c` is due to be split, and three of the four
straddle the parser/backend boundary. Doing them now is choosing that home
twice.

**Since then, the split happened** (§3) and it did not supply the home. The
four new files share `engine_internal.h`, which is private to the engine by
construction — the parser cannot see it — so the three that straddle the
parser/backend boundary are exactly as homeless as before. The one that did
move, `resolve_path`, moved to `engine_walk.c` and is still not somewhere
`cli.c` can reach.

- ~~UTF-8↔UTF-16~~ **FOLDED, and it was a bug.** `to_utf16`/`from_utf16` in
  engine.c are wrappers over `mdy_to_utf16`/`mdy_from_utf16` now
  ([engine_value.c:33](../src/engine_value.c#L33)); they allocate, which is what every
  caller here wants, and the decoding is the parser's.

  The copy did not merely accept overlong forms and surrogates. It treated any
  byte that was not ASCII or a 2- or 3-byte lead as the start of a FOUR-byte
  character and consumed four bytes without checking that the three after it
  were continuations. Measured on `text \xc0\xaf here and \xed\xa0\x80 and \x80
  end` — prose, no code involved:

  ```
  before  <p>text / here and <U+D800 as UTF-8> and <mojibake>d</p>
  node    <p>text �� here and ��� and � end</p>
  ```

  The overlong `\xc0\xaf` came out as a real `/`, which is the encoding a path
  check exists to refuse; the surrogate passed through; and the stray `\x80`
  ate the three bytes after it, which is how `and \x80 end` lost its `en`. It
  is byte-identical to node now, and astral characters still round-trip.
- Path normalisation: `resolve_path` ([engine_walk.c:467](../src/engine_walk.c#L467))
  and `absolute` ([cli.c:256](../src/cli.c#L256)) are the same algorithm
  written twice, both over `strtok`. **Not folded.** They are the same
  normalisation but not the same function: one joins against a base and writes
  into a caller's buffer, the other joins against the working directory and
  allocates, and only the second translates `\` to `/`. Unifying means picking
  one behaviour for both and finding a home for it — `fsx.h` is the candidate,
  since it already owns `fsx_is_absolute`. `resolve_path` has since moved, to
  [engine_walk.c:467](../src/engine_walk.c#L467), which settles where it lives
  in the engine and not where the shared one would.
- ASCII case-insensitive comparison, written inline at least seven times
  (`ends_with_ci`, `is_image_ext`, `ieq`, `doctype_line`, `resize_in`,
  `column_align`, `lower_ascii`). **Not folded** — the copies agree, and they
  are spread across the parser and the backend, which share no private header.
- A growable byte buffer, implemented seven times as `Buf`/`Out`
  (`cli.c`, `fsx.c`, `html.c`, `script.c`, `yaml.c`, `data.c`, `ast.c`,
  `bjval.c`) and ad hoc with `realloc` in engine.c (`fill_tokens`,
  `collect_text_into`, `put_block_scalar`, `rewrite_imports`, `flatten`,
  `open_dir_inner`) and `broker.c`. **Not folded** — the largest of the four,
  and the one most dependent on §3: a shared buffer wants a home both
  libraries can see, and engine.c's six ad-hoc ones have just gained a
  seventh in `put_room`, which is a sign the shape is wanted rather than an
  argument for adding it in the middle of a bug fix.
- ~~`is_void_element` and `is_void`: the same twenty names twice.~~ **FOLDED.**
  The two lists were identical character for character, with nothing to say if
  one ever gained a name the other did not. One `mdy_is_void_element`
  ([ast.c:16](../src/parse/ast.c#L16)), declared in `internal.h`, which
  `html.c` now includes — it is part of the same library and simply had not
  needed it before.
- `in_ranges` in `unicode.c` and `linkify.c`; UTF-8 encoding in `markdown.c`,
  `yaml.c`, `unicode.c` and `engine.c`. **Partly folded**: engine.c's copy
  went with the UTF-16 pair above, which is where it was. The other three are
  all inside the parser library and could share `mdy_utf8_encode` today.
- ~~The `tags:` YAML writer, twice~~ **FOLDED, and it was hiding a bug.** Both
  wrote a tag with `%s` inside quotes, which is B8's mistake in a quieter
  place: a document's tags are lowercased and deduplicated by writing them
  back out as YAML and reading them in again, so ONE tag containing a `"` made
  the whole generated block unparseable and the document's tags fell back to
  its raw front matter — never lowercased, never deduplicated, and nothing
  said so. `tags: [\'A"b\', Alpha, ALPHA]` gave `["A\"b","Alpha","ALPHA"]` where
  node gives `["a\"b","alpha"]`.

  There is one writer now ([engine_walk.c:232](../src/engine_walk.c#L232)) over one
  escaper ([engine_walk.c:184](../src/engine_walk.c#L184)), which `put_quoted` from
  B8's fix also uses — so everything this file emits as YAML is escaped by the
  same code. Regression test: `tag_checks`
  ([test/engine.c:939](../test/engine.c#L939)), a quote, a backslash and a tab
  in one document's tags, byte-identical to node.
- ~~`ref_id` called twice for the same string — two arena copies per
  footnote.~~ **FOLDED.** Called once, into a local.

---

## 3. Structures that have outgrown their shape

**~~`engine.c` (5,035 lines) is one translation unit doing six jobs~~ —
SPLIT.** It is four translation units and a private header now:

| file | lines | what it is |
| --- | --- | --- |
| [`engine.c`](../src/engine.c) | 3,348 | the document store, the `$` natives, rendering, the memo |
| [`engine_walk.c`](../src/engine_walk.c) | 1,102 | the directory walk, identity, the import graph |
| [`engine_value.c`](../src/engine_value.c) | 464 | the VM boundary: trees and binjson to `JsValue`s and back |
| [`engine_compose.c`](../src/engine_compose.c) | 337 | composition tokens and the trees a render parks |
| [`engine_internal.h`](../src/engine_internal.h) | 321 | `struct mdy_engine` and what the four share |

The seams are where the file's own call graph put them, which is not quite
where this paragraph guessed. Counting calls between its twenty-two
`/* ---- */` sections: *strings across the boundary* was called by fifteen
other sections and called none; *a tree, across the boundary* was called by
thirteen and called one; *composition* by eight and called none; the two walk
sections by six between them and called none. Those are the leaves, and a
leaf is what can leave without dragging a header of mutual declarations
behind it. Everything that stayed has the opposite shape — *the render memo*
calls into ten other sections, *reaching into an imported package* into nine
— so the natives, rendering and the memo are one file because splitting them
would have moved the coupling into the build instead of removing it.

Twenty-one of the twenty-two sections moved whole. The exception is *the
cache, and the recursion*, which is the walk's cache and also `open_documents`,
the store's entry point; the cache went and `open_documents` stayed.

Thirty-one functions lost `static` and are declared in the private header
instead — twelve at the VM boundary, eleven in composition, five the walk
lends out, and three the walk borrows back. That is the price: thirty-one
names that were private to one file are now visible to four. The header
groups them by owning file and says so in each block's comment, so which way
a call crosses the seam is readable without grep, but a declaration is not a
wall and nothing enforces the direction.

What the split does **not** do is shrink `struct mdy_engine`. It still has 56
fields spanning every job, and it is now in a header that three more files
include, so the number of places that can reach the memo's fields went up, not
down. The fields are grouped by job in the struct and nothing but convention
keeps `engine_walk.c` out of the render memo's. That is the next structural
item and the split did not make it easier; it made it visible.

**Long functions with several exits.** `render_tree_out`
([2925–3234](../src/engine.c#L2925-L3234), ~300 lines) manages seven GC roots
and a `FAIL` macro that jumps to `done:`. It had three early returns that
*bypassed* `done:` — one was B3, another B12, the third silently cleared the
enclosing render's `taint` — and it has one exit now. Length is what let three
of them accumulate unnoticed, and the length is still there. `open_dir_inner`
([704–1015](../src/engine_walk.c#L704-L1015)) builds the synthetic source that
caused B1 and B2; what is left of it is B8. `mdy_parse_block` ([block.c:1267–1779](../src/parse/block.c#L1267-L1779),
480 lines) inlines the entire list grammar. `resize_in` defines a
`RESIZE_FAIL` macro and then uses it for two of its eight failures.

**Process-global state.** The memo tables ([engine.c:2732](../src/engine.c#L2732))
and `mdy_engine_rotate_memo(void)`, the nisaba slot table (`nis.c`),
`lookup_import`'s `static char path[1024]` ([1030](../src/engine.c#L1030)),
`seen_sources` in cli.c, the OID statics in ingest.c. These make the engine
non-reentrant and are the reason `wasm/index.mjs` instantiates a fresh module
per call. They also make the memo shared between unrelated engines in one
process.

**Identity as text.** The walk encodes a file's identity as YAML source,
parses it back once per document, and relies on `snprintf` with no escaping to
get it there — which is B8, and is what is left of a bigger problem. It used
to concatenate every file with `---` and trust the splitter to hand the pieces
back in the order it had counted them, which is what B1 and B2 were; the files
are separate sources now and the counting is gone. Identity itself is still
text: it could be built as values and handed to `mdy_bj_document` directly,
and then there would be nothing to escape.

**The `Dev` struct and the bus code in cli.c** carry fixed-size scratch
(`done_ix[64]`, `done_list[4096]`, `char cand[3][4200]`), fake growable
arrays by passing a compound literal as the capacity
([1472](../src/cli.c#L1472), [1883](../src/cli.c#L1883)), and reuse the drain
loop for document mode by constructing a fake `Dev`
([1646–1679](../src/cli.c#L1646-L1679)). Five functions return pointers to
`static char msg[4096]`.

**The Makefile** ~~repeats the twelve-file engine source list four times~~
and ~~lists only `.c` files as prerequisites, so editing `src/engine.h` does
not rebuild `build/mdy`~~ — **both fixed** with the split, which would
otherwise have made each worse: `ENGINE_SRCS` and `ENGINE_HDRS` are written
once and used by all four rules, prerequisites included. The second half was
not cosmetic. Twice during this review a `make` that skipped a relink produced
a test result that described the previous binary — a phantom FAIL once and,
worse, a passing run of code that had not been rebuilt. A header is a
prerequisite now.

What is still true: every engine binary compiles from source in one `cc`
invocation, with no object files, so a one-line change to `cli.c` recompiles
nisaba's twenty sources — and with four engine files instead of one, that is
four more full compiles per relink rather than one incremental one.

---

## 4. Maintainability going forward

**Tests reach the parser and the renderer, not the edges.** `test/engine.c`
exercises `open`, `open_dir`, `entry`, `render`, `count`, the three callbacks
and the broker; it never calls `render_text`, `render_json`, `page_index`,
`document_path`, `set_scope_json`, `set_response`, `on_message`,
`set_split`/`sanitize`/`tasks`, `set_context_json`, `encode_json`,
`root_count`/`root_at` or `rotate_memo` — those are covered only by the 34
CLI cases, which CI runs on Linux alone. `httpd.c`, `http.c` and `watch.c`
have no test of any kind. `mdy dev` (about 900 lines across four files) has
ONE, `test/dev.test.js`, added with B10's fix and covering exactly the path
that bug was on — `test/serve.test.js` exists upstream and `docs/cli-plan.md`
names running it as Phase 5's exit criterion, and nothing still wires that up.
The
differential harnesses (`compare`, `check-html`, `check-script`,
`check-yaml`, `check-links`, `check-markdown`) depend on a corpus outside the
repository and never run in CI; `test/compare.mjs` exits 0 whatever it finds.

The most valuable single addition is a sixth `check-sites` fixture built from
the awkward cases: an empty `.mdy`, a `.yaml` starting with `---` and one
containing `+++`, a file name with a quote, a `.md` rendered through
`$.render` and another passed to `$.text`, a 70-column table, a corrupt
`.tif`, and a `$.find({})` over a few hundred documents with a time budget.

**Generated tables have no guard.** `src/toolkit.h`, `emoji_table.h`,
`props_table.h` and `schema_table.h` are generated from packages in
`node_modules`, but no make target regenerates or compares them, and the
invocation each file documents (`node scripts-generate-props.mjs ../..`) fails
with `ERR_INVALID_FILE_URL_HOST` because the scripts build a `file://` URL
from a relative path; they work only with an absolute one. (All four are
currently in sync.) A `check-generated` target that diffs generator output
against the checked-in headers would catch a `property-information` upgrade.

**~~Warnings in a clean build.~~ Fixed, with §2.** `-Wall -Wextra` on a
`make clean` build is silent now. The unused parameter went with `column_align`;
the three `const mdy_node *` casts were added, which is what the same file
already does in six other places — the wart underneath is that `mdy_root`
returns const to callers who own the tree, and that is still there; and
`stb_image.h`'s two unused helpers are silenced by a `#pragma` around its
include in `images.c`, as narrowly as the file it is for and without editing
somebody else's header. What follows is what the warnings were.

**Warnings in a clean build.** `-Wall -Wextra` produces six: three
const-discards where the engine mutates the tree behind `mdy_root`'s `const`
([engine.c:282](../src/engine.c#L282), [1006](../src/engine.c#L1006),
[3177](../src/engine.c#L3177)), the unused parameter above, and two from stb
under `STBI_ONLY_PNG`. A non-const `mdy_root_mut` in `mdybuild.h` (or
`-Wno-unused-function` around the stb include) makes the build silent, which
is the only state in which a *new* warning is noticed.

**Error reporting has four conventions.** `0/-1` with an error buffer
(engine, fsx), `BJ_*` codes (memns, nis), `NULL` plus a static message buffer
(cli), and `fprintf(stderr)` from inside the library
([engine.c:2376](../src/engine.c#L2376), [2391](../src/engine.c#L2391)) even
though `on_message` exists for exactly that. Pick two.

**Debug switches are read in hot paths.** `getenv("MDY_MEMO_DEBUG")` runs
three times per render and `getenv("MDY_LINEMAP_DEBUG")` once per produced
line ([engine.c:2676](../src/engine.c#L2676)); read them once in
`mdy_engine_new`.

**Fragile initialisers.** `bjval.c` fills `bj_visitor` positionally
([72–75](../src/bjval.c#L72-L75)) while engine.c uses designated initialisers
for the same struct; a field reorder in binjson breaks one silently.

**Comments that no longer describe the code** are listed under §2. The rest
of the commentary is unusually good — most functions say *why* and what was
measured — which is worth protecting by keeping the stale ones from
accumulating.

---

## 5. Suggested order

1. ~~B3~~, ~~B12~~, ~~B6~~ were one change: give `render_tree_out` a single
   exit and hash the record without `_id`. Both halves done.
2. ~~B1~~, ~~B2~~, ~~B8~~: stop building identity as text. The document text
   is done — the files are separate sources and the counting logic is gone —
   and identity is escaped rather than pasted. What is left of the idea is
   that identity still goes out as YAML and comes back parsed at all; building
   it as values would need a way to make an `mdy_yaml` mapping from C.
3. ~~B4~~: sort hits by a decoded index. Done.
4. ~~B5~~: call `nis_close` from `close_set` and finish `nis_close`
   (`bpt_free`). Done.
5. ~~B11~~, ~~B7~~ (a depth cap — in what BUILDS the trees, not in the
   thirteen things that walk them), ~~B9~~, ~~B10~~, ~~B29~~, B13 — each a few
   lines, except B29, which was three: the binding, the value, and the memo
   key that has to know the set's size now that a document can read it, and
   ~~B13~~, which was one function — plus the stress mode that had to be able
   to see it first.
6. Delete §2's dead code; add the `check-sites` fixture and a
   `check-generated` target; make the default build warning-free.
7. ~~Then the structural work in §3, starting with splitting engine.c along its
   existing section boundaries.~~ The split is done — four files along the
   call graph's seams rather than the section comments', and the Makefile's
   duplicated source list and missing header prerequisites with it. What is
   left of §3 is the part the split exposed rather than solved: `struct
   mdy_engine`'s 56 fields, the process-global memo and `static` buffers,
   `render_tree_out`'s length, identity as text, the `Dev` struct, and
   compiling to object files.

---

## Appendix: how the confirmed findings were reproduced

All from `packages/mdy-native` with `build/mdy` built by `make build/mdy`.

```sh
# B1 (fixed — the two now agree; before the fix the C column was wrong)
# a data file starting with ---
mkdir -p /tmp/yd && printf -- '---\ntitle: Data file\n' > /tmp/yd/data.yaml
printf 'title: Bee\n' > /tmp/yd/zed.yaml
printf '%% for (const d of $.find({})) {\n- {{ d.path }} | name={{ d.name }} | title={{ d.title ?? "" }}\n%% }\n' > /tmp/yd/main.mdy
./build/mdy /tmp/yd; node ../../bin/mdy.js /tmp/yd

# B2 (fixed — the two now agree; before the fix C printed only `hello`)
# an empty .mdy
mkdir -p /tmp/em && : > /tmp/em/a.mdy && cp /tmp/yd/main.mdy /tmp/em/
printf '+++\ntitle: Zed\n+++\nhello\n' > /tmp/em/zed.mdy
./build/mdy /tmp/em; node ../../bin/mdy.js /tmp/em

# B3 (fixed — the two now agree; before the fix C printed `<p>A:  B: </p>`)
# .md through $.render
mkdir -p /tmp/mr && printf '# Alpha\n\nfirst body\n' > /tmp/mr/a.md && printf '# Beta\n\nsecond body\n' > /tmp/mr/b.md
printf 'A: {{ $.render({ path: "a.md" }) }}\nB: {{ $.render({ path: "b.md" }) }}\n' > /tmp/mr/main.mdy
./build/mdy /tmp/mr --html; node ../../bin/mdy.js /tmp/mr --html

# B4 (fixed — 0.29 s at N = 2,400, where it was 109 s)
# $.find scaling
N=600; mkdir -p /tmp/sc/p; for i in $(seq 1 $N); do printf '+++\ntitle: %d\n+++\nbody\n' $i > /tmp/sc/p/$i.mdy; done
printf '%% const all = $.find({})\n{{ all.length }} documents\n' > /tmp/sc/main.mdy
time ./build/mdy /tmp/sc; time node ../../bin/mdy.js /tmp/sc

# B7 (fixed — both refuse cleanly now, exit 0 and exit 1)
# nesting
python3 -c "print(' '*400000 + 'x')" > /tmp/deep.mdy; ./build/mdy /tmp/deep.mdy --html >/dev/null; echo $?   # 139
python3 -c "print('a: ' + '['*200000 + ']'*200000)" | ./build/yamlcat >/dev/null; echo $?                   # 139

# B8 (fixed — both now report it"s.mdy) / B9
printf '+++\ntitle: Quoted\n+++\nhi\n' > '/tmp/yd/it"s.mdy'; ./build/mdy /tmp/yd
printf 'title: "Hello" world\n' | ./build/yamlcat                                                            # {"title":"Hello"}

# B5, B6, B12 — small C programs against engine.h (open+render+free in a loop,
# reporting ru_maxrss; MDY_MEMO_DEBUG=1 across rotate+open+render cycles;
# forty mdy_engine_render(e, 99, …) calls then mdy_engine_render(e, 0, …)).
```
