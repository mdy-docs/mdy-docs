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
| B14 | ~~Low~~ **fixed** | `cli.c` | `strftime("%l")` is a GNU extension: under emscripten the `--watch` timestamp vanished |
| B20 | ~~Low~~ **fixed** | parser | Silent truncation into fixed buffers: ids, headings, tables, URLs per paragraph | Portability, leaks on error paths, truncation, UB casts |
| B22 | ~~Low~~ **fixed** | `linkify.c` | `match_port` ran `strtoul` past the span, dropping a valid link |
| B25 | ~~Low~~ **fixed** | `fsx.c` | Every `opendir` failure was an empty directory: a denied subtree left the site silently |
| B23 | ~~Low~~ **fixed** | `markdown.c` | A link attribute's entity substrings were escaped a second time |
| B27 | ~~Low~~ **fixed** | `engine.c` | `wrap()` built the program with `snprintf`, whose `int` overflows past 2 GB |
| B18 | ~~Low~~ **fixed** | `watch.c` | The watcher's O(n²) scan cost 170 ms per poll on 8,000 files; a merge costs 0.1 |
| B24 | ~~Low~~ **fixed** | various | Unchecked allocations: 13 crashes and 306 builds that reported success with a *different site* |
| B26 | ~~Low~~ **fixed** | `cli.c` | The local bus marked an undeliverable message done where the remote one dead-lettered it |
| B19 | ~~Low~~ **fixed** | `cli.c` | An unknown option became the site directory, and the error blamed the entry script |
| B39 | ~~Low~~ **fixed** | `markdown.c` | An `<img>`'s attributes come out `src, title, alt`; node has `src, alt, title` |
| B40 | ~~Low~~ **fixed** | `markdown.c` | A URL was written through unencoded: `normalizeUri` was missing, not just the non-ASCII half |
| B41 | Low | wasm, `check-alloc` | The allocation sweep does not reach the wasm build, and covers one site by default |
| B42 | ~~Low~~ **fixed** | `markdown.c` | An empty link destination wrote no attribute where node writes `href=""` |
| B21 | ~~Low~~ **fixed** | engine, parser | `(int64_t)` of an infinity, before the range check — UBSan-confirmed |
| B15 | ~~Low~~ **fixed** | `cli.c` dev server | A refused publish's response is never freed: one body per refusal, forever |
| B16 | ~~Low~~ **fixed** | `http.c` | No socket timeouts: a broker that never answers hangs the build forever |
| B17 | ~~Low~~ **fixed** | `cli.c` / `httpd.c` | Dev server bound every interface, with a clock-seeded token, no request cap and a blocking write |
| B28 | ~~Low~~ **fixed** | `yaml.c` | A trailing `...` document-end marker is refused as "more than one document" |
| B29 | ~~Medium~~ **fixed** | `engine.c` natives | `$.count` is missing: a document reading it gets `undefined` |
| B30 | ~~Low~~ **part fixed** | `doc.c` | A CRLF source: the splitter normalises line endings, node keeps them |
| B31 | ~~Low~~ **fixed** | `engine.c` records | A record's keys come back in a different order, and `$.data` carries an `_id` node hides |
| B32 | ~~Medium~~ **fixed** | `fsx.c` listing | A file name containing a newline was split in two and the file disappeared |
| B33 | Medium | **mdy-docs** | The render memo serves a stale `$.count`: a rebuild after a file is added keeps the old number |
| B34 | ~~Low~~ **fixed** | `cli.c` | `mdy build` had five exits and no two freed the same things: up to 118 KB a run |
| B35 | Low | `cli.c` dev server | The publish dedupe list grows for the life of the process and is never freed |
| B36 | ~~Medium~~ **fixed** | `engine_value.c` | `.inf`/`.nan` crossed into a document as numbers; node sends `null` |
| B37 | ~~High~~ **fixed** | **binjson** encoder | A YAML integer at or above 2^53 silently drops the document's WHOLE front matter |
| B38 | ~~Low~~ **fixed** | `yaml.c` | `core_int` accumulates digits in a double: a 17-digit integer lands on the wrong one |

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
`open_dir_inner` parses them once as YAML ([engine_walk.c:855](../src/engine_walk.c#L892))
and the mapping travels beside the document in a new `ident_data`
([engine_internal.h:227](../src/engine_internal.h#L227)), merged in `mdy_engine_open` after the
document's own fields and before `path`
([engine.c:580](../src/engine.c#L616)) — which is where mdy-docs puts a
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
itself accepts it ([yaml.c:1103–1106](../src/parse/yaml.c#L1120-L1123)).

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
([engine_walk.c:920](../src/engine_walk.c#L967)) instead of counting beforehand and
re-deriving afterwards. Identity is collected per FILE while the walk runs
(`WalkedFile`, [engine_walk.c:684–690](../src/engine_walk.c#L694-L700)) and expanded
to one entry per document once the count is known
([engine_walk.c:943](../src/engine_walk.c#L990)). The two computations that had to
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
([engine.c:435](../src/engine.c#L450)), so both ways in run the same code.

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
jumps to `done:` ([engine.c:3003](../src/engine.c#L3113)) like every other
path, so `e->last_render_key` is written for it too and `render_native` parks
the tree under the key of the render that actually made it.

The other two exits went with it, which is B12 below. The index check is a
`FAIL` ([engine.c:2992](../src/engine.c#L3102)) and gives back the depth and
the `current` it had already taken; the cycle guard moved ABOVE everything
`done:` restores ([engine.c:2957](../src/engine.c#L3067)), which is what
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
([engine.c:789](../src/engine.c#L842)) — open addressing on the 24 hex
characters, built the first time a query asks and freed with the set, so it is
exactly as valid as `ids` is. `index_of_id`
([engine.c:809](../src/engine.c#L862)) is a lookup rather than a scan.

The ordering pass reads each hit's `_id` ONCE
([engine.c:870](../src/engine.c#L945)) and sorts the hits by the index it
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
([engine.c:411](../src/engine.c#L426)), so a set's data dies with the set.
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
([engine.c:2898](../src/engine.c#L3006)). `canonical_hash` grew one parameter
for it ([engine.c:2804](../src/engine.c#L2912)) — a single key left out, of
the TOP object only, since a value nested inside may legitimately be called
the same thing and is the document's own business. mdy-docs hashes
`doc.data`, which is this record before nisaba puts an id on it.

Enabling cross-set hits needed one thing more. The memo is shared by every set
in the process, and two documents with the same text and the same record still
render differently under a different element allowlist, a different task form
or different values in scope — so those go into the fingerprint beside the
record ([engine.c:2885](../src/engine.c#L2993)). mdy-docs folds in its own
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
- `parse_flow` ([yaml.c:593](../src/parse/yaml.c#L608)) — `MDY_YAML_MAX_DEPTH`
  ([mdyyaml.h:56](../src/parse/mdyyaml.h#L56)), refused with a message naming
  the line, since that is what this reader does with what it will not guess
  at. It also protects the JSON writer, the binjson encoder and the engine's
  hash, all of which walk the result.
- `js_to_tree` ([engine_value.c:228](../src/engine_value.c#L233)) — a document can build a
  sixty-thousand-deep tree in two lines of its own code. Past the limit the
  branch is dropped, which is the answer the parser gives text nested that
  deep.
- `canonical_hash` ([engine.c:2813](../src/engine.c#L2921)) — the same document
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
`write_node` ([html.c:298–379](../src/parse/html.c#L305-L386)), `mdy_clone`
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

**Fixed.** `put_quoted` ([engine_walk.c:158](../src/engine_walk.c#L159)) writes an
identity field as YAML with the value escaped the way `read_quoted` unescapes
it — `\` and `"` named, control characters as `\xNN`, and everything else
including UTF-8 through as bytes, since only what the reader would take for
something else has to be named. The walk builds identity with it
([engine_walk.c:769](../src/engine_walk.c#L793)) into a buffer that grows, which
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
([engine_walk.c:767–767](../src/engine_walk.c#L791-L791), [874](../src/engine_walk.c#L911)).
A name like `it"s.mdy` produces `name: "it"s.mdy"`, which the YAML reader
reads as `it` (see B9) — so the document's `path`, `name` and `ext` are all
truncated at the quote. Node reports `it"s.mdy`. A backslash in a name would
be read as an escape. Either escape the values or stop encoding identity as
text (see §3, *Identity as text*).

#### B9 — YAML: trailing text after a closing quote is dropped (Medium) — FIXED

**Fixed.** A quoted scalar ends at its closing quote, and what may follow on
that line is nothing, or a comment — `nothing_after`
([yaml.c:741](../src/parse/yaml.c#L756)), checked where `parse_value_from`
used to walk straight on to the next line. `title: "Hello" world` is refused
with `unexpected text after a quoted scalar` rather than coming back as
`Hello`, which is what this file says of itself: "a parser that silently
mis-reads data is worse than one that refuses it".

**The same hole was one line up, in the KEY.** `"a"x: v` came back as
`{"a": "v"}`: `key_end` skips a quoted key and then scans on for a `:`, so the
colon it measured against was not this scalar's. A quoted key now has to be
followed by spaces and then that colon
([yaml.c:891](../src/parse/yaml.c#L908)) — a comment is not one of the
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
([cli.c:1704](../src/cli.c#L1728)): 500 returns the messages to the broker,
which brings them back after a backoff, by which time a save may have fixed
the build. Routing them with no engine would have found no page of that name,
which is a different thing and settles them away — so the guard has to come
before the routing, not be folded into it. `dev_drain`, the in-process path,
does not take messages it cannot render either
([cli.c:1500](../src/cli.c#L1524)); they stay queued for the drain after the
next good build. And `mdy_engine_page_index` and `mdy_engine_document_path`
tolerate a NULL engine ([engine.c:3261](../src/engine.c#L3371)), which is the
convention `mdy_engine_count` already sets in that file.

**The dev server has a test now** — its first, which is the real reason this
went unnoticed. `test/dev.test.js` with a `check-dev` target
([Makefile:271](../Makefile#L292)) and a CI step: it spawns the binary on a
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
([images.c:169](../src/images.c#L181)) — the bounds check and the per-entry
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
there ([test/engine.c:1392](../test/engine.c#L1435)) — forty times over, and
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
([engine.c:2510](../src/engine.c#L2619)). mdy-docs can write the number in as a
literal because it builds a program per document; this wrapper is compiled once
and reused for every render of the document — that is what makes the request an
argument — so the number arrives on `$$` beside `__scope` and `__wantResponse`
([engine.c:3098](../src/engine.c#L3208)) and is read at object construction, so
`$.count` is a plain number to the document either way.

The third place is the memo, and it is the half that was not obvious. **The
size of the set is not part of any document's text or its record**, so adding a
file to a directory leaves every other document's fingerprint untouched. A
second build in the same process — which is what `mdy dev` is — would then
serve each of them the render made when the set was smaller, with `$.count`
frozen at the old number in a page that is otherwise correct and reports
nothing. So the size goes into the fingerprint beside the knobs
([engine.c:3069](../src/engine.c#L3069)), which is the same argument that
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

#### B30 — A CRLF source: the splitter normalises, node does not (Low) — FIXED for content; the rest PARKED

`acc_source` dropped a `\r` before the line ending, so a chunk's endings were
`\n` whatever the file used. It keeps the line's content the same way, but a
line that ended in `\r` is now followed by an **empty line**, which is what
mdy-docs ends up with:

| | before | after / node |
| --- | --- | --- |
| `crlf line\r\nsecond\r\n` rendered | `<p>crlf line second</p>` | `<p>crlf line</p><p>second</p>` |
| its `$.text` | `crlf line\nsecond\n` (17 bytes) | `crlf line\n\nsecond\n\n` (19) |

**Why node does that**, since nothing in `mdy.js` mentions `\r` at all:
`splitDocuments` splits on `\n` alone, so every line keeps its carriage
return; the script compiler then puts each line inside a **backtick template
literal** (`src/parse/script.js:375`), and ECMAScript normalises a `<CR>`
inside one to `<LF>`. `scriptOutput` splits the result on `/\r\n|\r|\n/` and
gets two lines where the file had one. The behaviour is a property of the
language the generated program is written in, which is what "looks accidental"
meant.

**What is parked, and why it is not a small thing.** Two cases cannot be
matched without breaking files that work. node's markers are anchored regexes
allowing only spaces and tabs after themselves —

```
DOCUMENT_SEPARATOR     = /^---[ \t]*$/
FRONT_MATTER_SEPARATOR = /^\+\+\+[ \t]*$/
```

— so `---\r` and `+++\r` match neither. On a CRLF file node therefore ignores
front matter completely, and **fails the build** on a second document:

```
mdy: document 0 failed: mdy: no document at index 1
```

Matching that would mean a Windows-authored document losing its front matter
and a multi-document one refusing to build. That is a different order of thing
from a blank line, so those two stay as they are and the divergence is now
deliberate rather than unexamined. It is node's regexes that want the `\r`, not
this engine that wants to forget it.

`crlf_checks` in `test/engine.c` pins both halves — the match and the two
places it stops. Two of its expectations were wrong when first written (a lone
`\r` is *not* a line ending on either side, and markdown eats
`JSON.stringify`'s backslashes identically in both); they were replaced with
what `node bin/mdy.js` actually prints.

#### B31 — A record's keys are in a different order (Low) — FIXED

```
$.find({})[0]   before  ["_id","name","ext","size","mtime","path"]
                after   ["path","name","ext","size","mtime","_id"]   node the same
$.data(0)       before  ["_id","name","ext","size","mtime","path"]
                after   ["path","name","ext","size","mtime"]         node the same
res.data        before  carried `_id`
                after   does not                                     node the same
```

Three changes, each matching a decision node makes for a reason:

- **`_id` last** ([ingest.c:103](../src/ingest.c#L103)), because nisaba's JS
  insert adds it after spreading the document. The merge also skips an `_id` a
  mapping tries to declare — the store's id is the store's, and writing it
  twice was reachable before.
- **`path` first** ([engine_walk.c:796](../src/engine_walk.c#L833)), because
  mdy-docs builds the record as `{ ...meta, ...parsed, path }` and re-assigning
  a key in JS leaves it where it was first written. Safe because
  `mdy_bj_document` takes a key's *place* from the first mapping that has it
  and its *value* from the last, so moving it does not change which `path`
  wins over a data file's own — checked, with a `.yaml` that declares
  `path: i-said-this` and still resolves to `note.yaml` on both engines.
- **`$.data` and `res.data` carry no store id**
  ([engine.c:955](../src/engine.c#L1053)) — the rule `wrap()`'s `__answer`
  already applied to the response, now applied where the document reads it.

Seven checks in `test/engine.c`, four in document mode and three over a
directory, where the identity is what gives the order meaning.

**And a rooting bug of my own, caught by B13's stress mode.**
`record_without_id` called `js_object_new` *before* rooting the record it was
copying — and the record arrives reachable only from the C stack, since
`record_without_id(e, document_record(e, index))` hands over a value nothing
else holds. Sixteen checks failed under `MDY_GC_STRESS` and none without it.
It took three wrong guesses (a stale build, a build-order difference, a
nondeterministic test) before noticing that `make check-engine` runs the binary
twice and the second run is the stressed one. That is the mode earning its
place inside a week of existing.

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

#### B34 — `mdy build` had five exits and no two freed the same things (Low) — FIXED

Found while leak-checking B16's change, and not B16's: the numbers below are
identical at the commit before it.

Filed as "every `$.publish` leaks its name and data", which was the 416 bytes
that showed up on `examples/messaging`. Measuring the other exits first, rather
than fixing the one, turned out to matter — **the failure paths leak the whole
engine**:

| `mdy build` … | before | after |
| --- | --- | --- |
| a site that publishes (`examples/messaging`) | 8 leaks, 416 B | 0 |
| a site that does not (`examples/blog`) | 0 | 0 |
| a directory that is not there | 787 leaks, 69,248 B | 0 |
| an entry document that is not there | 793 leaks, 70,656 B | 0 |
| a render that throws | 1,082 leaks, 118,416 B | 0 |

`cmd_build` had five exits. The engine survived two of them, `out_abs` four,
and the messages all five:

| exit | `e` | `out_abs` | `messages` |
| --- | --- | --- | --- |
| `open_dir` failed | leaked | leaked | (empty) |
| entry not found | leaked | leaked | (empty) |
| render failed | leaked | leaked | leaked |
| an output could not be written | freed | leaked | leaked |
| success | freed | freed | leaked |

So the fix is not a `free` added to one path; it is the shape §3 names under
*Long functions with several exits*, and the one `render_tree_out` was given
for B3 and B12. `cmd_build` has one exit now
([cli.c:760](../src/cli.c#L784)), `rc` carries the answer to it
([697](../src/cli.c#L721)), and the cleanup is written once — the third copy
in this file, after `mdy dev`'s ([1707](../src/cli.c#L1731)) and document
mode's, and the first that runs on every path rather than some.

Every message and exit code was compared before and after: identical.

**A note on how this was measured**, because it went wrong once. The first
before/after run reported 0 leaks at HEAD, which would have meant the leak was
mine. It was a stale binary: `git stash` restored `cli.c` within the same
second as the existing `build/mdy`, so `make` skipped the relink and the
"HEAD" measurement was of the fixed code. `rm -f build/mdy` before each build
is what the table above was produced with. This is the third time in this
review that a same-second `make` has produced a result that described a
different binary — see §3's Makefile note, where it cost a phantom FAIL and a
phantom PASS.

#### B35 — the dev server's dedupe list only grows (Low)

Found while measuring B15, and left alone deliberately: the 24 blocks that are
the same before and after that fix.

`dev_send` fingerprints each message as `name\1json` and keeps it in `d->sent`
([cli.c:1441](../src/cli.c#L1465)) so a rebuild does not re-send what it
already sent. Nothing ever removes one, and `mdy dev` has no exit path that
frees the array — it runs until it is killed. So the list grows by one entry
per distinct message for as long as the server is up, and `leaks` counts every
entry.

This is retention, not a leak: dropping an entry means re-sending its message,
which is the thing the list exists to prevent. It is on the list because
"grows without bound in a process meant to run all day" is worth someone
deciding about rather than discovering — a session that publishes a message
per save, with the data changing each time, accumulates a fingerprint per save.
A bound (keep the last N, or key on the message name and let the newest win)
changes delivery semantics, which is why it is a finding and not a fix.

#### B36 — `.inf` and `.nan` crossed into a document as numbers (Medium) — FIXED

Found by following B21 rather than by reading: the cast was undefined
behaviour, and checking what the *value* should have been turned up three
crossings where this engine and node disagreed about the page.

`.inf`, `-.inf` and `.nan` are legal YAML, and node's parser reads them as a
real `Infinity` and `NaN` — verified directly, not assumed:

```
node YAML gives: [["big","number","Infinity"],["nn","number","NaN"],["ok","number","1.5"]]
```

What crosses into a document does not. mdy-docs puts the record into the
program with `JSON.stringify`, and JSON cannot write either:
`JSON.stringify({a: Infinity})` is `{"a":null}`. So node's *store* holds an
infinity and node's *document* sees null — and this engine handed the document
the number.

| | before | node |
| --- | --- | --- |
| `{{ res.data.big }}` with `big: .inf` | `Infinity` | `null` |
| `{{ $.find({ big: 1/0 }).length }}` against that record | `1` | `0` |
| `$.node({ properties: { "data-x": 1/0 } })` as HTML | `<p data-x="inf">` | `<p>` |

Three crossings, one rule, and it is node's: **the store keeps the infinity,
null is what crosses.** `finite_or_null`
([engine_value.c:455](../src/engine_value.c#L460)) is the store-to-guest side,
and it is on the int, date and pointer decoders as well as the float — none of
those can carry a non-finite today, and a decoder that quietly starts to should
not be the thing that reintroduces this. `js_to_binjson`
([375](../src/engine_value.c#L380)) is the guest-to-store side, so a query for
an infinity asks for null and matches nothing. And a guest's non-finite tree
property is left unset ([339](../src/engine_value.c#L344)), which is the same
attribute list node produces, since a null property is one the HTML writer
leaves out.

`ingest.c` deliberately does **not** change what it stores: a non-finite still
goes in as a float, because that is what node's store holds, and matching node
means agreeing about the record as well as about the page.

What is *not* matched: node's tree has the property present-and-null where this
one has it absent. Nothing in `mdy_node` can hold a null property, and adding
`MDY_PROP_NULL` to the AST for this would be a change to the parser and the
writer for a case whose rendered output is already identical. A transform that
reads `tree.properties["data-x"]` back would see `null` there and `undefined`
here; that is the one path where they still differ, and it is written down
rather than fixed.

`nonfinite_checks` in `test/engine.c` covers all three crossings plus the
ordinary numbers around them — integer, float, negative, zero, exponent, and
the integer/float distinction a query depends on. Every expectation in it was
read off `node bin/mdy.js` on the same input; three were wrong the first time,
in the slug and the escaping rather than the number.

#### B37 — a YAML integer at or above 2^53 drops the whole front matter (High) — FIXED, in binjson

Found while regression-testing B36, and confirmed pre-existing against a
worktree at the commit before it.

```
+++
title: Fine
big: 9007199254740993
also: Fine too
+++
= {{ res.data.title }}|{{ res.data.big }}|{{ res.data.also }}

before  undefined|undefined|undefined
after   Fine|9007199254740992|Fine too        node  Fine|9007199254740992|Fine too
```

Not the one field — **the whole document**. `$.find({})` answered `0`, no query
by any field found it, and `title` and `also` are ordinary strings that went
with it. The insert returned *success* and nothing was reported anywhere.

**Where it is — and this entry first said the wrong thing.** It was filed
against `ingest.c` / nisaba, with the index named as the likely cause. That was
a guess. Reproduced against nisaba's own API — insert, find, the secondary
index, the index created before the insert as `open_documents` does — nisaba is
correct at every magnitude. Instrumenting the engine showed `nis_find`
returning **identical bytes** in both cases and the engine's own
`binjson_to_js` refusing to decode them.

The defect is one line of contract in **binjson**
([mdy-docs/binjson@e5d36e8](https://github.com/mdy-docs/binjson/commit/e5d36e8)):

- `bj_put_int` wrote `BJ_TYPE_INT` at any magnitude.
- **Both** decoders — binjson's C one and its JS reference — refuse an INT
  outside the JS safe-integer range and **abort the whole decode**
  (`BJ_ERR_INT_RANGE`, and a throw).
- The JS *encoder* cannot produce one:
  `Number.isInteger(val) && Number.isSafeInteger(val)` picks INT and every
  other number, an integer past 2^53 included, takes the FLOAT branch.

So a C producer could build a document no conformant reader would read, and
because the refusal lands on the decode rather than on the value, one integer
cost the document. `bj_put_int` now falls back to `bj_put_float`, which is the
same narrowing the reference's `setFloat64` performs, so both encoders emit
identical bytes for identical input. `bj_put_pointer` had the same asymmetry
with a different correct answer — the reference *throws* there, because a
rounded offset points elsewhere — so that one refuses.

**What this means for the engine.** Nothing. `ingest.c` is unchanged from
before B37 was filed: an integral value inside ±9.2e18 still goes in as an INT
and everything else as a FLOAT. The string workaround that was written for this
([the first fix](https://github.com/mdy-docs/mdy-docs/commit/510ac8e)) is
**removed**: with the encoder correct, the value comes back as the same
*number* node has, which is strictly better than a string that matched node's
digits but not its type. Full parity across `9007199254740992`,
`9007199254740993`, `1e17`, `0x20000000000000`, `-9007199254740992`, `1e308`,
`.inf` and `.nan`.

**Why no test could have caught it before.** Neither binjson's JS encoder nor
its WASM binding can reach `bj_put_int` with an out-of-range value — both guard
with `isSafeInteger` before the call — so it is reachable *only* from a direct C
caller, and this engine is one. binjson's regression test drives its exported C
builder for that reason; `big_integer_checks` here is the consumer-side half,
and reverting binjson's fix fails six of these checks.

#### B38 — `core_int` accumulated digits in a double (Low) — FIXED

```
big: 99999999999999999

before  100000000000000016
after   100000000000000000      node  100000000000000000
```

Different **doubles**, not one printed two ways: the nearest double to
`99999999999999999` is exactly `100000000000000000`. `core_int` built the value
a digit at a time, `v = v * 10 + (s[k] - '0')`, and seventeen roundings do not
land where one correctly-rounded conversion does.

The loop still validates; `strtod` now decides the value
([yaml.c:179](../src/parse/yaml.c#L187)) — the same call `core_float` twenty
lines below already made. Two things the fix has to not break, both of which
the old accumulation got right and a naive `strtod` on a fixed buffer would
not: leading zeros are skipped before the copy, so `0000…0001` stays short;
and a span too long for the buffer keeps the accumulated value rather than a
truncated conversion, because at five hundred significant digits the
accumulation is already the right infinity.

Hex and octal are untouched. They accumulate the same way (`v * base + d`) and
drift past 2^53 in principle, but `strtod` reads neither `0o` nor a
length-delimited hex span, node agrees with this engine on both today, and
inventing a reader for a case nothing produces is not worth the surface.

Five checks in `test/yaml.c`: the seventeen-digit value either sign, sixteen
digits (always exact), seventy digits, seventy leading zeros, and hex/octal.
Removing the conversion fails one of them, and the 440-block corpus stays
identical.

#### B39 — an `<img>`'s attributes come out in a different order (Low) — FIXED

```
$.markdown('![i](http://a?x "cap")')
before  <img src="http://a?x" title="cap" alt="i">
after   <img src="http://a?x" alt="i" title="cap">      node the same
```

`alt` is not known until the span closes — it is the children, gathered — so
it was set last. But `new_prop` replaces a repeated name **in place**, so
claiming the slot between `src` and `title` on the way in and filling it on
the way out is enough ([markdown.c:577](../src/parse/markdown.c#L677)).

Every `<img>` with a title differed before. Three checks: with a title, without
one, and an empty `alt` that still holds its place. `check-html`'s 642
documents are unchanged.

#### B40 — a URL is written through unencoded (Low) — FIXED

The entry filed this as "a non-ASCII character is not percent-encoded". That
was the symptom that showed. Held against node over 53 URL shapes, **52 of 106
cases differed** — every one of these, in an `href` and in a `src`:

```
$.markdown('[u](http://a?é)')     before  href="http://a?é"
                                  after   href="http://a?%C3%A9"     = node
[u](<a b>)                        before  href="a b"
                                  after   href="a%20b"
[u](<a[b]c>)                      before  href="a[b]c"
                                  after   href="a%5Bb%5Dc"
[u](http://a?a%)                  before  href="http://a?a%"
                                  after   href="http://a?a%25"
```

and the same for `"`, `<`, `>`, `\`, `^`, a backtick, `{`, `|`, `}`, DEL and
every control character.

**It had to be micromark's function, not an idea of one.** The fix is a port of
`normalizeUri` from `micromark-util-sanitize-uri`
([markdown.c:303](../src/parse/markdown.c#L303)), which is what
`mdast-util-to-hast` runs a destination through — and only a destination. Two
details decide whether this is that function or a guess at it:

- **An already-encoded `%XX` is left alone.** Without it `%C3%A9` in the source
  becomes `%25C3%25A9`, which is the failure the entry warned about.
- **`XX` is two ASCII ALPHANUMERICS, not two hex digits** — micromark's own
  test is `asciiAlphanumeric` ([markdown.c:289](../src/parse/markdown.c#L289)),
  so `%zz` is passed through as well. That is not obviously deliberate on their
  side. It is what the reference does, and this has to agree with the reference
  rather than with the RFC.

The safe set is micromark's `/[!#$&-;=?-Z_a-z~]/`, written out longhand
([markdown.c:281](../src/parse/markdown.c#L281)).

**One thing the port cannot copy directly.** node walks UTF-16 code units and
has a branch for surrogates; C has UTF-8 bytes and no surrogates to find. The
equivalence is not "encode each non-ASCII byte" — node read the file as UTF-8
**with replacement**, so an ill-formed byte was already U+FFFD before
`normalizeUri` saw it and comes out `%EF%BF%BD`, where encoding the byte gives
`%80`. So this decodes and re-encodes through `mdy_utf8_decode`, whose contract
is that same substitution. Measured: a raw `\x80` in a destination gives
`http://a/%EF%BF%BDb` on both sides.

**What is NOT normalized**, and is the reason the flag is on the call and not
on the attribute name: a `title` keeps its bytes, the link's text keeps its
bytes, and mdy's OWN parser (`src/parse/inline.c`) keeps them too — mdy-docs'
`src/parse/inline.js` writes `{href: found.url}` with no normalization at all,
so normalizing there would have *created* a difference. Checked on both
engines: an `.mdy` link to `http://a?é` keeps the `é` on both.

**Verification.** A differential over 53 URL shapes × link and image, against
`markdownToHast` (`uridiff`): **54/106 before, 106/106 after**. Ten checks in
`attr_entity_checks` ([test/engine.c:930](../test/engine.c#L930)), every
expectation read off mdy-docs' own `render()`. Seven of the ten fail without
the fix; the other three — an already-encoded sequence, `%zz`, and a title —
pass either way **on purpose**: they are the guards against an implementation
that encodes too much, and a fix that broke them would look like a fix.

#### B42 — an empty link destination writes no attribute (Low) — FIXED

Found while fixing B40, in the same function, and separate from it:

```
$.markdown('[u](<>)')     before  <p><a>u</a></p>
                          after   <p><a href="">u</a></p>      = node
$.markdown('![i](<>)')    before  <p><img alt="i"></p>
                          after   <p><img src="" alt="i"></p>  = node
```

`set_attribute` returned early on an empty value, which is right for a `title`
— neither engine writes an empty one — and wrong for a destination: `[u](<>)`
is a link to the current document, `normalizeUri('')` is `''`, and
mdast-util-to-hast sets it. The early return now depends on whether the
attribute is a destination, not on its name
([markdown.c:364](../src/parse/markdown.c#L364)). It showed for an inline
link, an inline image and a reference definition alike.

#### B41 — the allocation sweep does not reach everything it should (Low)

B24 built `build/mdy-af` and `make check-alloc`, which refuse the *n*th
allocation of a build and assert that the result is either the same site or a
reported failure. Two gaps are left, and both are the tool's reach rather than
a defect in the engine.

**The wasm build is not swept.** `build/mdy-af` is a native binary; the same
engine compiled by `emcc` has emscripten's allocator underneath it and its own
failure behaviour, and nothing here exercises that. The C sites B24 fixed are
shared, so the wasm build has them fixed too — what is unverified is whether
emscripten's own layer turns an exhausted heap into the same reported failure.

**`check-alloc` sweeps `fixture` only.** That is 1,809 allocations and 54
seconds, which is a target someone will actually run. It is also the smallest
corpus here, and each larger one found sites it could not reach — the fixture
has no hashtags, no `.yaml` data files and no pictures, and the blog's sweep
found eleven more sites because of it. blog (14,298) and docs-site (17,747)
were swept by hand for B24 and are clean, but they take 25 and 35 minutes, so
they are not a target and nothing re-runs them. A nightly that sweeps all three
would be the answer; a `check-alloc-all` nobody runs would not.

#### B28 — YAML: a trailing `...` is refused as a second document (Low) — FIXED

```
printf 'a: 1\n...\n' | ./build/yamlcat
before  line 2: more than one document in a stream is not supported
after   {"a":1}                                        node  {"a":1}
```

A `...` that CLOSES the one document is ordinary single-document YAML, and was
refused along with real second documents — in a data file and in `+++` front
matter alike.

What decides is whether anything of substance follows the marker, which is
what `next_content` already answers: blanks and comments do not make a
document, a mapping does
([yaml.c:1128](../src/parse/yaml.c#L1150)). The marker and whatever trails it
then leave the stream, and the line below already made the symmetric
allowance for a leading `---`.

Eight shapes compared against node's `yaml` package, all agreeing: the closing
marker, with blanks after, with a comment after, after a leading `---`, the
marker alone (`null` both sides), a plain document, and the two that must still
refuse — `a: 1\n...\nb: 2` and `a: 1\n...\n---\nb: 2`. Nine checks in
`test/yaml.c`, four of them refusals, plus the front-matter path through the
engine.

#### B30 — A CRLF source: the splitter normalises, node does not (Low) — FIXED for content; the rest PARKED

`acc_source` dropped a `\r` before the line ending, so a chunk's endings were
`\n` whatever the file used. It keeps the line's content the same way, but a
line that ended in `\r` is now followed by an **empty line**, which is what
mdy-docs ends up with:

| | before | after / node |
| --- | --- | --- |
| `crlf line\r\nsecond\r\n` rendered | `<p>crlf line second</p>` | `<p>crlf line</p><p>second</p>` |
| its `$.text` | `crlf line\nsecond\n` (17 bytes) | `crlf line\n\nsecond\n\n` (19) |

**Why node does that**, since nothing in `mdy.js` mentions `\r` at all:
`splitDocuments` splits on `\n` alone, so every line keeps its carriage
return; the script compiler then puts each line inside a **backtick template
literal** (`src/parse/script.js:375`), and ECMAScript normalises a `<CR>`
inside one to `<LF>`. `scriptOutput` splits the result on `/\r\n|\r|\n/` and
gets two lines where the file had one. The behaviour is a property of the
language the generated program is written in, which is what "looks accidental"
meant.

**What is parked, and why it is not a small thing.** Two cases cannot be
matched without breaking files that work. node's markers are anchored regexes
allowing only spaces and tabs after themselves —

```
DOCUMENT_SEPARATOR     = /^---[ \t]*$/
FRONT_MATTER_SEPARATOR = /^\+\+\+[ \t]*$/
```

— so `---\r` and `+++\r` match neither. On a CRLF file node therefore ignores
front matter completely, and **fails the build** on a second document:

```
mdy: document 0 failed: mdy: no document at index 1
```

Matching that would mean a Windows-authored document losing its front matter
and a multi-document one refusing to build. That is a different order of thing
from a blank line, so those two stay as they are and the divergence is now
deliberate rather than unexamined. It is node's regexes that want the `\r`, not
this engine that wants to forget it.

`crlf_checks` in `test/engine.c` pins both halves — the match and the two
places it stops. Two of its expectations were wrong when first written (a lone
`\r` is *not* a line ending on either side, and markdown eats
`JSON.stringify`'s backslashes identically in both); they were replaced with
what `node bin/mdy.js` actually prints.

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
([engine_walk.c:767–767](../src/engine_walk.c#L791-L791)), `path` last so that it
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
the engine's walk ([engine_walk.c:737](../src/engine_walk.c#L751)), `cli.c`'s static
copier ([636](../src/cli.c#L640)) and `watch.c`'s snapshot
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

#### B34 — `mdy build` had five exits and no two freed the same things (Low) — FIXED

Found while leak-checking B16's change, and not B16's: the numbers below are
identical at the commit before it.

Filed as "every `$.publish` leaks its name and data", which was the 416 bytes
that showed up on `examples/messaging`. Measuring the other exits first, rather
than fixing the one, turned out to matter — **the failure paths leak the whole
engine**:

| `mdy build` … | before | after |
| --- | --- | --- |
| a site that publishes (`examples/messaging`) | 8 leaks, 416 B | 0 |
| a site that does not (`examples/blog`) | 0 | 0 |
| a directory that is not there | 787 leaks, 69,248 B | 0 |
| an entry document that is not there | 793 leaks, 70,656 B | 0 |
| a render that throws | 1,082 leaks, 118,416 B | 0 |

`cmd_build` had five exits. The engine survived two of them, `out_abs` four,
and the messages all five:

| exit | `e` | `out_abs` | `messages` |
| --- | --- | --- | --- |
| `open_dir` failed | leaked | leaked | (empty) |
| entry not found | leaked | leaked | (empty) |
| render failed | leaked | leaked | leaked |
| an output could not be written | freed | leaked | leaked |
| success | freed | freed | leaked |

So the fix is not a `free` added to one path; it is the shape §3 names under
*Long functions with several exits*, and the one `render_tree_out` was given
for B3 and B12. `cmd_build` has one exit now
([cli.c:760](../src/cli.c#L784)), `rc` carries the answer to it
([697](../src/cli.c#L721)), and the cleanup is written once — the third copy
in this file, after `mdy dev`'s ([1707](../src/cli.c#L1731)) and document
mode's, and the first that runs on every path rather than some.

Every message and exit code was compared before and after: identical.

**A note on how this was measured**, because it went wrong once. The first
before/after run reported 0 leaks at HEAD, which would have meant the leak was
mine. It was a stale binary: `git stash` restored `cli.c` within the same
second as the existing `build/mdy`, so `make` skipped the relink and the
"HEAD" measurement was of the fixed code. `rm -f build/mdy` before each build
is what the table above was produced with. This is the third time in this
review that a same-second `make` has produced a result that described a
different binary — see §3's Makefile note, where it cost a phantom FAIL and a
phantom PASS.

#### B35 — the dev server's dedupe list only grows (Low)

Found while measuring B15, and left alone deliberately: the 24 blocks that are
the same before and after that fix.

`dev_send` fingerprints each message as `name\1json` and keeps it in `d->sent`
([cli.c:1441](../src/cli.c#L1465)) so a rebuild does not re-send what it
already sent. Nothing ever removes one, and `mdy dev` has no exit path that
frees the array — it runs until it is killed. So the list grows by one entry
per distinct message for as long as the server is up, and `leaks` counts every
entry.

This is retention, not a leak: dropping an entry means re-sending its message,
which is the thing the list exists to prevent. It is on the list because
"grows without bound in a process meant to run all day" is worth someone
deciding about rather than discovering — a session that publishes a message
per save, with the data changing each time, accumulates a fingerprint per save.
A bound (keep the last N, or key on the message name and let the newest win)
changes delivery semantics, which is why it is a finding and not a fix.

#### B36 — `.inf` and `.nan` crossed into a document as numbers (Medium) — FIXED

Found by following B21 rather than by reading: the cast was undefined
behaviour, and checking what the *value* should have been turned up three
crossings where this engine and node disagreed about the page.

`.inf`, `-.inf` and `.nan` are legal YAML, and node's parser reads them as a
real `Infinity` and `NaN` — verified directly, not assumed:

```
node YAML gives: [["big","number","Infinity"],["nn","number","NaN"],["ok","number","1.5"]]
```

What crosses into a document does not. mdy-docs puts the record into the
program with `JSON.stringify`, and JSON cannot write either:
`JSON.stringify({a: Infinity})` is `{"a":null}`. So node's *store* holds an
infinity and node's *document* sees null — and this engine handed the document
the number.

| | before | node |
| --- | --- | --- |
| `{{ res.data.big }}` with `big: .inf` | `Infinity` | `null` |
| `{{ $.find({ big: 1/0 }).length }}` against that record | `1` | `0` |
| `$.node({ properties: { "data-x": 1/0 } })` as HTML | `<p data-x="inf">` | `<p>` |

Three crossings, one rule, and it is node's: **the store keeps the infinity,
null is what crosses.** `finite_or_null`
([engine_value.c:455](../src/engine_value.c#L460)) is the store-to-guest side,
and it is on the int, date and pointer decoders as well as the float — none of
those can carry a non-finite today, and a decoder that quietly starts to should
not be the thing that reintroduces this. `js_to_binjson`
([375](../src/engine_value.c#L380)) is the guest-to-store side, so a query for
an infinity asks for null and matches nothing. And a guest's non-finite tree
property is left unset ([339](../src/engine_value.c#L344)), which is the same
attribute list node produces, since a null property is one the HTML writer
leaves out.

`ingest.c` deliberately does **not** change what it stores: a non-finite still
goes in as a float, because that is what node's store holds, and matching node
means agreeing about the record as well as about the page.

What is *not* matched: node's tree has the property present-and-null where this
one has it absent. Nothing in `mdy_node` can hold a null property, and adding
`MDY_PROP_NULL` to the AST for this would be a change to the parser and the
writer for a case whose rendered output is already identical. A transform that
reads `tree.properties["data-x"]` back would see `null` there and `undefined`
here; that is the one path where they still differ, and it is written down
rather than fixed.

`nonfinite_checks` in `test/engine.c` covers all three crossings plus the
ordinary numbers around them — integer, float, negative, zero, exponent, and
the integer/float distinction a query depends on. Every expectation in it was
read off `node bin/mdy.js` on the same input; three were wrong the first time,
in the slug and the escaping rather than the number.

#### B37 — a YAML integer at or above 2^53 drops the whole front matter (High) — FIXED, in binjson

Found while regression-testing B36, and confirmed pre-existing against a
worktree at the commit before it.

```
+++
title: Fine
big: 9007199254740993
also: Fine too
+++
= {{ res.data.title }}|{{ res.data.big }}|{{ res.data.also }}

before  undefined|undefined|undefined
after   Fine|9007199254740992|Fine too        node  Fine|9007199254740992|Fine too
```

Not the one field — **the whole document**. `$.find({})` answered `0`, no query
by any field found it, and `title` and `also` are ordinary strings that went
with it. The insert returned *success* and nothing was reported anywhere.

**Where it is — and this entry first said the wrong thing.** It was filed
against `ingest.c` / nisaba, with the index named as the likely cause. That was
a guess. Reproduced against nisaba's own API — insert, find, the secondary
index, the index created before the insert as `open_documents` does — nisaba is
correct at every magnitude. Instrumenting the engine showed `nis_find`
returning **identical bytes** in both cases and the engine's own
`binjson_to_js` refusing to decode them.

The defect is one line of contract in **binjson**
([mdy-docs/binjson@e5d36e8](https://github.com/mdy-docs/binjson/commit/e5d36e8)):

- `bj_put_int` wrote `BJ_TYPE_INT` at any magnitude.
- **Both** decoders — binjson's C one and its JS reference — refuse an INT
  outside the JS safe-integer range and **abort the whole decode**
  (`BJ_ERR_INT_RANGE`, and a throw).
- The JS *encoder* cannot produce one:
  `Number.isInteger(val) && Number.isSafeInteger(val)` picks INT and every
  other number, an integer past 2^53 included, takes the FLOAT branch.

So a C producer could build a document no conformant reader would read, and
because the refusal lands on the decode rather than on the value, one integer
cost the document. `bj_put_int` now falls back to `bj_put_float`, which is the
same narrowing the reference's `setFloat64` performs, so both encoders emit
identical bytes for identical input. `bj_put_pointer` had the same asymmetry
with a different correct answer — the reference *throws* there, because a
rounded offset points elsewhere — so that one refuses.

**What this means for the engine.** Nothing. `ingest.c` is unchanged from
before B37 was filed: an integral value inside ±9.2e18 still goes in as an INT
and everything else as a FLOAT. The string workaround that was written for this
([the first fix](https://github.com/mdy-docs/mdy-docs/commit/510ac8e)) is
**removed**: with the encoder correct, the value comes back as the same
*number* node has, which is strictly better than a string that matched node's
digits but not its type. Full parity across `9007199254740992`,
`9007199254740993`, `1e17`, `0x20000000000000`, `-9007199254740992`, `1e308`,
`.inf` and `.nan`.

**Why no test could have caught it before.** Neither binjson's JS encoder nor
its WASM binding can reach `bj_put_int` with an out-of-range value — both guard
with `isSafeInteger` before the call — so it is reachable *only* from a direct C
caller, and this engine is one. binjson's regression test drives its exported C
builder for that reason; `big_integer_checks` here is the consumer-side half,
and reverting binjson's fix fails six of these checks.

#### B38 — `core_int` accumulated digits in a double (Low) — FIXED

```
big: 99999999999999999

before  100000000000000016
after   100000000000000000      node  100000000000000000
```

Different **doubles**, not one printed two ways: the nearest double to
`99999999999999999` is exactly `100000000000000000`. `core_int` built the value
a digit at a time, `v = v * 10 + (s[k] - '0')`, and seventeen roundings do not
land where one correctly-rounded conversion does.

The loop still validates; `strtod` now decides the value
([yaml.c:179](../src/parse/yaml.c#L187)) — the same call `core_float` twenty
lines below already made. Two things the fix has to not break, both of which
the old accumulation got right and a naive `strtod` on a fixed buffer would
not: leading zeros are skipped before the copy, so `0000…0001` stays short;
and a span too long for the buffer keeps the accumulated value rather than a
truncated conversion, because at five hundred significant digits the
accumulation is already the right infinity.

Hex and octal are untouched. They accumulate the same way (`v * base + d`) and
drift past 2^53 in principle, but `strtod` reads neither `0o` nor a
length-delimited hex span, node agrees with this engine on both today, and
inventing a reader for a case nothing produces is not worth the surface.

Five checks in `test/yaml.c`: the seventeen-digit value either sign, sixteen
digits (always exact), seventy digits, seventy leading zeros, and hex/octal.
Removing the conversion fails one of them, and the 440-block corpus stays
identical.

#### B28 — YAML: a trailing `...` is refused as a second document (Low)

`mdy_yaml_parse` rejects any `...` line at indent 0 as "more than one document
in a stream" ([yaml.c:1099–1100](../src/parse/yaml.c#L1116-L1117)), but a `...`
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
  ([engine_value.c:85–104](../src/engine_value.c#L90-L109)) is that a value
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
  not ([engine_value.c:75](../src/engine_value.c#L80)), which enforces the rule
  instead of assuming it. **It failed twelve checks the first time it ran.**

  The fix itself is one function. `set_val` already existed, and its comment
  already explained exactly this hazard for writes — the absence of the
  matching `get_val` is *why* the four sites existed. `get_val`
  ([engine_value.c:145](../src/engine_value.c#L150)) roots the object and
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
- **~~B14 — `report()` uses `strftime("%l")`~~ FIXED, and it is worse than
  "lacks it".** `%l` is a GNU extension — space-padded rather than zero-padded
  — and `stamp_now` twenty lines away already used `%I` with a comment saying
  why. Measured under emscripten rather than assumed:

  ```
  native (macOS libc)   %l -> " 9:05:07 PM" (n=11)     %I -> "09:05:07 PM" (n=11)
  emscripten            %l -> ""            (n=0)      %I -> "09:05:07 PM" (n=11)
  ```

  It returns **0 and writes nothing**, so the `--watch` status line loses its
  timestamp entirely rather than losing a space. And a `strftime` returning 0
  leaves the buffer UNSPECIFIED — `report()` then ran
  `while (*s == ' ') s++` over it, which on any libc that does not happen to
  write a terminator is a walk through uninitialised stack.

  Both callers are one function now
  ([cli.c:1109](../src/cli.c#L1133)); the duplicate formatting is gone and
  `stamp_now` terminates `out` itself when `strftime` writes nothing. Output is
  unchanged where `%l` worked: the two spellings were compared for **all 24
  hours** and are byte-identical, since `%l`-then-strip-spaces and
  `%I`-then-strip-zero differ only in what they pad with.

  `test/dev.test.js` pins the shape. Two assertions, and the pair matters: one
  catches an empty stamp and a space-padded one, the other catches a
  zero-padded one — between them `""`, `" 9:"`, `"09:"` and `"9:"` are told
  apart. Half of it is hour-dependent and the test says so: `%I` and a
  stripped `%I` agree for 10, 11 and 12 o'clock, so the padding assertion only
  bites between 1 and 9. The emptiness assertion bites at any hour, and
  emptiness is the bug — confirmed by making `stamp_now` write nothing and
  watching the suite fail.

  `strftime` now appears once in this codebase, with a format every libc has.
- **~~B15 — Dev server leaks a refused publish's response.~~ FIXED.** The
  refusal branch never called `http_response_free`, so a broker answering a
  publish with anything but a 2xx kept its response body for the life of the
  process. That is not one leak: it is one per refused message per rebuild, in
  a server meant to run all day.

  Reproduced against a broker that accepts, registers, and answers every
  `POST /pub/*` with a 500 and a 4 KB body. Ten rebuilds, same binary but for
  `cli.c`:

  | | before | after |
  | --- | --- | --- |
  | total | 30 leaks, 47,360 B | 20 leaks, **1,280 B** |
  | from `http_request` (the refused bodies) | 12 | **0** |
  | from `dev_send` (see B35) | 24 | 24 |

  The response is zeroed at its declaration and freed on every path
  ([cli.c:1487](../src/cli.c#L1511)). The zeroing is what lets the free be
  unconditional: the encode can fail before `http_request` has touched `r` at
  all. The old expression avoided reading `r.error` in that case by testing
  `bytes` first — which is sound, since `mdy_engine_encode_json` NULLs it
  before anything else, but it is sound *somewhere else*, and a cleanup that
  depends on a contract two files away is a cleanup waiting to be wrong.

  The `mdy dev` health probe had the same shape one guard weaker —
  `if (r.status) http_response_free(&r)` left behind the body of anything whose
  status line did not parse. Also unconditional now
  ([cli.c:1999](../src/cli.c#L2023)). The other four `http_request` callers are
  fine: each either `exit`s or calls `broker_fail`, which exits.

  `check-dev` had no coverage of the `--broker` path at all — every other test
  there uses the in-process broker — which is how a missing `free` on it went
  unnoticed. There is a refusing-broker test now. It cannot assert a leak, but
  it exercises the path, which is what a deleted `free` needs in order to be
  noticed at all.
- **~~B16 — No socket timeouts~~ FIXED.** Measured before: `mdy dead` against
  a listener that accepts and says nothing was **still running after 25
  seconds**, and its recv loop's only exit was the peer closing, so it would
  have been forever. It gives up in 15s now, and says which happened.

  Three waits, all of them unbounded, and each needed a different answer.

  **connect.** There is no socket option for this; the portable way is to go
  non-blocking, start the connect, wait for writability, then ask `SO_ERROR`
  whether it actually arrived — a writable socket is not a connected one, and
  `connect_timeout` ([http.c:130](../src/http.c#L130)) is written out longhand
  to keep that straight. Reproduced with a listener whose accept queue is full,
  so its SYNs are dropped: **20s before, 5s after**.

  **recv.** `SO_RCVTIMEO` for each call, and a deadline across the whole
  exchange, because per-call timeouts do not bound the total — the same lesson
  as B17's write side, applied the first time here rather than the second.
  `recv` returning -1 on timeout is also told apart from the peer closing, so
  a broker that says nothing is not reported as one that said something
  malformed.

  **send.** The same deadline-on-the-whole-write as
  [httpd.c](../src/httpd.c#L197), for the same reason
  ([http.c:201](../src/http.c#L201)).

  Budgets: 5s to connect ([http.c:71](../src/http.c#L71)) and 15s for the
  exchange, with **`MDY_HTTP_TIMEOUT_MS`** to move the second — a broker across
  a slow link is a real thing, and a hard limit with no way out is how a fix
  becomes somebody else's outage. The dev server's poll loop is what sets the
  ceiling, since registration and heartbeats go through here.

  **The IPv6 literal**, which was the other half. `parse_url` split host from
  port on the first colon, so `http://[::1]:8080` asked the resolver for a host
  called `[`. Brackets are what tell an address's colons from a port's; they
  are handled and stripped ([http.c:176](../src/http.c#L176)), since
  `getaddrinfo` wants the address without them, and an unclosed `[` is now a
  named error rather than a strange hostname. Error messages bracket the host
  again on the way out, because `::1:8080` is not something a reader can parse.

  While in the same loop: the response is capped at 64 MiB
  ([http.c:69](../src/http.c#L69)) and `realloc`'s result is checked — it went
  straight back into `buf`, so exhaustion arrived as a write through NULL. That
  closes one line of B24, not B24.

  Tests: `url_checks` in `test/engine.c` drives the parser through
  `http_request` (IPv6 with and without a port, an ordinary host, the default
  80, an unclosed bracket, a non-http scheme), and `test/dev.test.js` runs
  `mdy dead` against a wedged broker. Both were run against the unfixed code:
  the parser test fails three ways, and the wedged-broker test hits its 30s
  kill.

  Not covered by a test: that a hung *connect* gives up at 5s. It is
  reproducible by hand, with the full-accept-queue trick above, but it needs a
  listener whose backlog behaviour differs between platforms, and a flaky test
  is worse than a stated gap.
- **~~B17 — Dev server exposure.~~ FIXED — four separate things, each with a
  test that fails without it.**

  **The bind.** It bound `0.0.0.0`, so every machine on the network could reach
  a server that rebuilds a directory on disk and, with a broker, renders
  whatever a POST tells it to. It binds `127.0.0.1` now, and `--host`
  ([cli.c:1960](../src/cli.c#L1984)) opts back in and says so on stderr when it
  does. This is a deliberate divergence: node's `server.listen(port)` binds
  everything too, but node has no delivery endpoint to reach — the bus is
  native-only. Verified with `lsof`: `127.0.0.1:45311 (LISTEN)` by default,
  `*:45312 (LISTEN)` with `--host`.

  **The token.** Four `rand()` calls seeded `time(NULL) ^ &argc`: thirty-two
  hex characters standing for at most the ~31 bits of an LCG's state, from a
  seed that is not a secret — two servers started in the same second shared a
  token. It is now `httpd_secret`
  ([httpd.c:141](../src/httpd.c#L141)), 19 bytes from `/dev/urandom` or
  `BCryptGenRandom`, and **there is no fallback**: if the OS will not supply
  randomness the server says so and serves without the bus
  ([cli.c:1976](../src/cli.c#L2000)), because a token that looks random and is
  not is worse than a refusal. `srand`/`rand` are gone from the program.

  **The request cap.** There was none: `recv` appended and the buffer doubled,
  so any peer that kept writing made this process allocate until it died — and
  `realloc`'s result was assigned unchecked, so the failure arrived as a write
  through NULL rather than as an error. Both halves are one line now, with the
  cap at 16 MiB ([httpd.c:59](../src/httpd.c#L59)) and a 413 before the close.

  **The blocking write.** One thread serves everything, so a client that asks
  for a page and stops reading stopped the watcher, the rebuilds and every
  other client with it. `SO_SNDTIMEO` alone is not the fix and this is the part
  worth writing down: **it restarts every time a send manages one byte**, so a
  paused client still held the thread for 13.7 seconds against a 5-second
  timeout. The deadline is on the whole response
  ([httpd.c:197](../src/httpd.c#L197)), and because the clock is
  `time(NULL)` the comparison has to be `>=` — with `>` the peer gets a whole
  extra round, measured at ~10s for a 5s budget. It is 3.6s now.

  Tests: `token_checks` in `test/engine.c` (hex, length, two differ, a buffer
  too small refused rather than half-filled, an even-sized buffer accepted —
  the dev server's is `char[40]`, and an API that refuses its only caller's
  buffer is an outage), and two in `test/dev.test.js` that each fail on the
  unfixed code — a 64 MiB request, where the client gets to write all of it
  without the cap, and a paused reader, where the answer takes 13.7s without
  the response deadline.
- **~~B18 — Watcher scan is O(n²)~~ FIXED.** It is a merge now
  ([watch.c:92](../src/watch.c#L92)). Both snapshots come from `fsx_list` in
  the order it sorts them — `strcmp`, and `add` appends — so one pass over the
  two finds every difference. Measured on 8,000 files with nothing changed,
  which is the every-120-ms case:

  ```
  before  169.7 ms per scan
  after     0.1 ms per scan
  ```

  The watcher polls every 120 ms, so the old scan could not keep up with
  itself: one pass cost more than the interval it was called on.

  The three cases are the three a merge has — on both sides and the size or
  mtime moved; only in `after`, so new; only in `before`, so gone — and each
  path is emitted once, which the old version needed a second lookup to be
  sure of. Five shapes were compared against the old implementation and give
  the same **set** of paths; what changed is the order, which is now sorted
  rather than after-side-then-before-side. Nothing depends on it: the caller
  prints the paths and rebuilds.
- **~~B19 — `mdy build`/`dev`/`dead` accept anything as the positional~~
  FIXED**, and the finding was wrong about node.

  ```
  before  mdy build site --draft
          entry script not found at "main.mdy" (looked among 0 document(s) under --draft)
  after   mdy: Unknown option '--draft'. To specify a positional argument starting
          with a '-', place it at the end of the command after '--', as in '-- "--draft"'
  ```

  All three ended their option loop with `else root = a`, so an unknown flag —
  or one whose value was missing — became the site directory. The command did
  fail, which is why this reads as cosmetic at first, but it failed **saying
  the wrong thing**: it blamed the entry script for not being in a directory
  the user never named. `mdy build site --out` built a directory called
  `--out`.

  Document mode in this same binary had rejected unknown options properly all
  along, with a message that names the option *and* the way out. Those are now
  the words all four commands use ([cli.c:448](../src/cli.c#L452)), together
  with its `Option '%s' argument missing` for a flag whose value ran off the
  end, and its `--` escape so a positional may still start with a dash.

  **The finding said "Document mode (and the JavaScript CLI) reject unknown
  options."** Half right: `node bin/mdy.js build site --draft` takes `--draft`
  as the directory exactly as this did, so there was no parity to restore — the
  case for the change is that a message should say what is wrong, and that one
  binary should answer four ways the same. Two places this now diverges from
  node, both deliberate: `--out` with no value makes node build to the default
  `dist` where this refuses, and node's message for an unknown option is the
  entry-script one.

  Not changed: two positionals still take the last, silently, in both engines —
  `mdy build A B` builds `B`. That is shared behaviour and a separate decision.

  Three tests in `test/dev.test.js` — the unknown option across all three
  commands, the missing value across four flags, and the valid usage plus `--`.
  Reverting fails five checks.
- **B20 — Silent truncation into fixed buffers.** FOUR FIXED, the rest were
  already fine or already gone. Each one was measured against `node
  bin/mdy.js`, which has no such limits, rather than taken from the list:

  | | limit | against node |
  | --- | --- | --- |
  | heading id | `char unique[256]` | **differed** — fixed |
  | the slug's source | `char rendered[1024]` | **differed** — fixed |
  | table columns | `starts`/`lens`/`align[64]` | **differed** — fixed |
  | URLs per paragraph | `MDY_MAX_URLS 512` | **differed** — fixed |
  | class name | `char one[128]` | same |
  | page href | `char tidy[1024]` | same |
  | footnote id | | same |
  | identity record | was 4 KB | **already gone** — `ident` grows, with B8 |

  **The id** ([block.c:345](../src/parse/block.c#L345)) was cut at 255 bytes,
  so a long heading got an id this engine invented and node did not — and a
  `[[ link ]]` written from the same text then pointed at nothing. Its slug
  came from `rendered[1024]` ([1475](../src/parse/block.c#L1475)), so past a
  kilobyte the id stopped mid-word as well. Both grow now, and both keep a
  stack buffer for the ordinary case.

  **Table columns** ([block.c:1085](../src/parse/block.c#L1085)): the 65th
  column and everything after it left the document. One `Cells` buffer per
  row, on the stack up to 64 and heap beyond — a row cannot hold more cells
  than it has bytes, so one allocation sized from the line always fits. Four
  call sites shared the ceiling and now share the buffer.

  **URLs per paragraph** ([inline.c:533](../src/parse/inline.c#L533)) was the
  ugliest: past the 512th link the rest were not merely unlinked but re-read as
  ordinary text, where the `//` in `http://` opens the emphasis that list
  exists to prevent. A 600-URL paragraph grew `<em>` nobody wrote. It grows by
  retry — a full array is the only signal `mdy_find_links` gives that it had
  more to say.

  Six checks in `test/engine.c`, plus the three shapes that were already fine
  so they stay that way. Reverting fails four. The corpora are unchanged:
  642/642 markdown documents, 440/440 YAML blocks, 14,896/14,896 linkify
  inputs, five sites byte-identical.

  The `identity records over 4 KB … can also underflow` part of this finding
  is **stale**: `ident` became a growable buffer with B8's escaping work, and
  there is no fixed identity array left to underflow.

- **~~B21 — Undefined behaviour on double→integer casts~~ FIXED — and it was
  hiding B36, which is the part that mattered.** UBSan on a document whose
  front matter says `big: .inf`, before:

  ```
  src/ingest.c:22:30: runtime error: inf is outside the range of
                      representable values of type 'long long'
  ```

  and nothing after. Five sites, not six: two of the cited lines were stale
  after the engine split, and **`yaml.c` already had the guard** —
  `if (isnan(v) || isinf(v)) { buf_put(b, "null", 4); return; }` — which is
  both the model for the others and the evidence that `null` is the answer.
  The real sites were [ingest.c:34](../src/ingest.c#L34),
  [engine_value.c:375](../src/engine_value.c#L380),
  [bjval.c](../src/bjval.c#L119), [ast.c](../src/parse/ast.c#L261) and
  [html.c](../src/parse/html.c#L210).

  The reordering is not the same change at each. Where a double becomes JSON
  text (`bjval.c`, `ast.c`) a non-finite is `null`, which is what
  `JSON.stringify` writes. Where it becomes an attribute (`html.c`) it cannot
  arrive any more — see B36 — so the test is there only so the cast is never
  reached. And in `ingest.c` the value still goes to the **store as a float**,
  because node's store holds a real Infinity; only the UB goes.

  `%g` of an infinity was the old `else` branch's answer and is why nothing had
  crashed: the cast produced a sentinel, the equality failed, and the fallback
  printed something. Harmless on x86-64 and arm64, as filed — but it was also
  the only reason the wrong *value* in B36 went unnoticed for as long as it did.

  It is the seventh copy of `v == (double)(long long)v` in this tree, spread
  across the engine and the parser, which share no private header. §2's
  un-folded duplication, again, and now with a correctness argument attached:
  five copies needed the same fix and one already had it.
- **~~B22 — `match_port` calls `strtoul` on a length-delimited slice~~
  FIXED.** A `Text` is a view and not a copy, so there need not be a non-digit
  inside `len` for `strtoul` to stop at. Digits after the span were read as
  part of the port, made it larger than 65535, and **the whole link was
  dropped** — measured, with the buffer not NUL-terminated and `99999`
  following the span:

  ```
  http://a:12345  (len 14, "99999" after)   before  links=0
                                            after   links=1  [0,14)
  http://a:99999                            both    links=0
  ```

  Five digits are read from the span now
  ([linkify.c:167](../src/parse/linkify.c#L167)), which is the count the loop
  above has already established. Two checks in `test/parse.c` — the span case
  and a port that really is too large — and fourteen port spellings added to
  `check-links`, which is 14,896 inputs agreeing with linkify-it. Reverting
  fails both checks.

  The read past the end is real by construction and is what the loop now
  avoids; I could not get AddressSanitizer to flag it, so the lost link is the
  evidence rather than a sanitiser report.
- **~~B23 — markdown link attributes ignore entity substrings~~ FIXED.**
  `set_attribute` took `a->text` whole, so the literal `&amp;` survived and the
  writer escaped it a second time:

  ```
  $.markdown('[x](http://a?b=1&amp;c=2)')
  before  href="http://a?b=1&#x26;amp;c=2"
  after   href="http://a?b=1&#x26;c=2"          node  the same
  ```

  It walks the substrings now
  ([markdown.c:354](../src/parse/markdown.c#L354)), resolving `MD_TEXT_ENTITY`
  through the table `entity()` already uses and `MD_TEXT_NULLCHAR` to U+FFFD;
  an entity the table does not have goes through as typed, which is what
  CommonMark says about `&nope;`. `entity_utf8` and `utf8_of`
  ([187](../src/parse/markdown.c#L187)) are the numeric and named halves of
  `entity()` without a `Build` to write into, which is what an attribute needs.

  **It reproduces through `$.markdown`, not through a `.md` file** — a `.md`
  linkifies the bare URL instead of parsing the link syntax — which is why the
  first four shapes tried all agreed and looked like the finding was stale.
  Five checks in `test/engine.c`; reverting fails three.

  Two differences it uncovered and did NOT fix, both present before it and
  independent of entities — see B39 and B40.
- **~~B24 — Unchecked allocations that dereference on failure~~ FIXED.** The
  list was never the hard part. The hard part was that **none of these paths
  runs unless an allocation actually fails**, so every edit would have been
  unverifiable — which is why this sat parked, and why the first thing built
  was the thing that makes them run.

  **`build/mdy-af`, and `make check-alloc`.** The engine, the parser and md4c
  compiled against an allocator that refuses the *n*th request and only that
  one ([allocfail.c](../src/allocfail.c#L7)); a force-included header does the
  renaming, so no source file knows it exists and the real build is untouched.
  `check-alloc` ([Makefile:655](../Makefile#L655)) sweeps *n* across a whole
  build of `fixture` — 1,809 of them, 54 seconds — against one invariant:

  > a run that exits 0 produced the **same site** as an uninterfered one; a run
  > that could not must say so and exit non-zero.

  Not "it does not crash". Silently dropping a page is *worse* than the crash
  it replaces, because the build reports success with files missing.

  **What the first sweep found**, against code that had been read carefully
  twice:

  | | fixture | blog | docs-site |
  | --- | --- | --- | --- |
  | allocations swept | 1,809 | 14,298 | 17,747 |
  | segfaults | 13 | 5 | 1 |
  | aborts (stb's own assert) | 0 | 2,006 | 0 |
  | **exited 0, built a different site** | **306** | **195** | **62** |
  | after | **0** | **0** | **0** |

  The blog's and docs-site's columns are what each found *after* the corpus
  before it was clean — they are additional sites, not the same ones counted
  again.

  306 of 1,809. Not one of them was a missing check — nearly every site
  *checked*, and then carried on with the wrong answer. `key()` returned an
  undefined atom, so a property landed under the name `undefined`. A `tagName`
  fell back to `"div"`. `fsx_list` said "unsorted beats nothing" and the site's
  documents built in readdir order, which reordered every `find`. A className
  list that would not join wrote `class=""` and the serialiser went on to
  succeed. `$.find` answered `[]` for a query that had *failed*, so an index
  page was written with no posts on it. Each was a deliberate decision to
  degrade, and each turned an allocation failure into a plausible-looking wrong
  build.

  **Two mechanisms, and a rule for choosing.** *If NULL reaches something that
  reports it and stops, propagate. If NULL turns into different output, it must
  not be NULL.* The second is [xalloc.h](../src/xalloc.h#L1), whose file
  comment is the argument: `key(vm, "_id")` returns a `JsValue`, there is no
  `JsValue` that means "the allocation failed", and threading a status out of
  it means changing every caller of a function called from everywhere — to
  carry a condition that on any machine this runs on means the process is
  already finished. Those allocate through
  [mdy_xmalloc](../src/xalloc.c#L18) instead and the run ends with one line.
  [mdy_fatal](../src/xalloc.c#L24) is the same policy for the failures that are
  not allocations.

  **Propagated** — the channel existed and the caller was ignoring it:
  `fsx_read`'s NULL in the walk ([engine_walk.c:807](../src/engine_walk.c#L807)),
  `fsx_stat`'s return, which was dropped entirely — the document's record then
  claimed an empty file last written in 1970
  ([engine_walk.c:784](../src/engine_walk.c#L784)),
  `fsx_list`'s in `copy_static` ([cli.c:671](../src/cli.c#L671)) and in
  [fsx_list](../src/fsx.c#L280) itself, `mdy_to_html`'s in
  [fill_tokens](../src/engine_compose.c#L304), the identity copies
  ([engine_walk.c:1028](../src/engine_walk.c#L1028)), `rewrite_imports`'
  two unchecked `strdup`s ([engine_walk.c:606](../src/engine_walk.c#L606)),
  and a failed write in `copy_static` that was simply not counted.

  **Made infallible** — no channel, and the failure was silently different
  output: the four UTF-16 conversions
  ([engine_value.c:40](../src/engine_value.c#L40),
  [key](../src/engine_value.c#L65), [d_key](../src/engine_value.c#L518)),
  `put_room` and the identity block it builds
  ([engine_walk.c:169](../src/engine_walk.c#L169)), `add_tag`
  ([engine_walk.c:345](../src/engine_walk.c#L345)), `scan_hashtags`
  ([engine_walk.c:356](../src/engine_walk.c#L356)), `cache_put`
  ([engine_walk.c:662](../src/engine_walk.c#L662)), the composition tokens
  ([engine_compose.c:95](../src/engine_compose.c#L95)), `tokenize_native`
  ([engine.c:39](../src/engine.c#L39)), the contents list and the text walk it
  uses ([collect_headings](../src/engine.c#L1677),
  [collect_text_into](../src/engine.c#L295)), `canonical_hash_deep`
  ([engine.c:3013](../src/engine.c#L3013)), `set_context_json`
  ([engine.c:703](../src/engine.c#L703)), the resize dedupe table
  ([engine.c:2230](../src/engine.c#L2230)) and `absolute`
  ([cli.c:261](../src/cli.c#L261)).

  **Three that needed a new channel.**

  `run_query_in` ([engine.c:888](../src/engine.c#L888)) is the one worth
  naming: nisaba reports an exhausted allocation properly, all the way out
  through `dc_find`'s negative return — and this **threw that away** and
  answered with an empty array. It is the only place in the engine where a
  foreign error code was dropped rather than missing, which is why it survived
  reading. `$.find`, `$.findOne`, `$.render` and `$.text` now say which
  happened. `document_record` ([engine.c:1023](../src/engine.c#L1023)) did the
  same with `{}` for a document looked up by its *own* id — never "not found",
  always a page built with no data.

  The third is the YAML parser, and it is an interface change.
  `mdy_yaml_parse` returned NULL for a malformed document *and* for an
  exhausted one, and the engine treated both as "this part had nothing" — which
  for a malformed document is right, and is what node does, and for an
  exhausted one silently drops the document's fields. So the parser gained
  **[MDY_YAML_OOM](../src/parse/mdyyaml.h#L87)**: one exact string, documented
  as a constant precisely so the caller can tell them apart, written by
  [oom()](../src/parse/yaml.c#L121) without the `line N:` every other message
  carries. The five call sites in the engine act on it and let a malformed
  document through unchanged.

  **The parser's own three.** `Buf.ok` was checked in `mdy_yaml_to_json` and
  nowhere else, so a scalar that could not grow came back **truncated** — a
  title that meant something its author did not write. Same in `html.c`, where
  a `class` list was built in a temporary buffer whose `ok` nobody read
  ([html.c:291](../src/parse/html.c#L291)). And `mdy_alloc` — B24's "sixteen
  sites in block.c" — had a contract that twenty-six of its forty-two callers
  relied on and which was **not true**: it ends the process now
  ([arena.c:22](../src/parse/arena.c#L22)), and `internal.h` says why. A
  recursive-descent parser has no way to unwind from the middle of a node.

  **stb's own answer to OOM** was `STBIW_ASSERT(p)` — `abort()`, from inside a
  vendored header, 2,006 of the blog's aborts. `STBIW_MALLOC`/`REALLOC`/`FREE`
  are the documented way to replace its allocator and are set to ours
  ([images.c:48](../src/images.c#L48)); the vendored file is not patched.

  **Verification.** The sweep is the test, and it is a property rather than a
  list — the ordinals move whenever the code does, so it cannot rot into
  sixteen assertions about line numbers. Control: putting back the single line
  `if (!v) return out.s; /* unsorted beats nothing */` brings back ordinal 49
  and *only* ordinal 49 — the `cities.json` order flip, and nothing else moves.

  Each corpus found sites the one before it could not reach: the fixture has no
  hashtags, no `.yaml` data files and no pictures, so the blog's sweep added
  another eleven; docs-site has a contents list and `$.node`, and added
  `fsx_stat`, `collect_headings`, `mdy_doc_new` and one more **heap overflow**
  — `collect_text_into` moved its capacity before knowing the allocation had
  succeeded and then returned, so the next call through wrote past the end of
  the buffer. Full sweeps after: fixture
  1,809 clean, blog 14,298 clean, docs-site 17,747 clean. Parity unchanged on
  all five sites, the whole check suite green, ASan clean over a blog build,
  `leaks --atExit` reports 0 in both document and site mode.

  On that last point, honestly: the earlier note here said `leaks` showed 2
  blocks (208 bytes) from `absolute` on any document-mode run. It reports 0
  today, in all three invocations tried — and the change to `absolute` swaps
  `strdup`/`malloc` for their infallible twins and alters nothing about what is
  freed, so **this fix cannot be what changed it**. The earlier figure was
  measured some other way and is withdrawn rather than claimed.

  Still open, and filed as **B41**: the wasm build's own allocation sites are
  not swept, because `build/mdy-af` is native. `check-alloc` sweeps `fixture`
  only — blog and docs-site were swept by hand here and take 25 and 35 minutes.

- **~~B25 — `walk` treats every `opendir` failure as an empty directory~~
  FIXED.** `return errno == ENOENT ? 0 : 0` — both branches zero. A subtree
  whose permissions kept us out simply left the site. Measured against node on
  the same tree:

  | | before | after / node |
  | --- | --- | --- |
  | a subtree with mode 000 | built a page, **exit 0**, nothing said | `cannot read <root>`, **exit 1** |
  | an unreadable `static/` | exit 0 | exit 1 (both) |
  | a *missing* directory | exit 0 | exit 0 (both) — the contract |

  node says `EACCES: permission denied, scandir …` and exits 1; this said
  nothing. Now not-there (`ENOENT`, `ENOTDIR`) is still an empty list and
  anything else is an error ([fsx.c:207](../src/fsx.c#L207)), with the Windows
  half given the same distinction — `ERROR_FILE_NOT_FOUND`,
  `ERROR_PATH_NOT_FOUND`, `ERROR_NO_MORE_FILES`, `ERROR_DIRECTORY` are empty
  and the rest are not. `fsx.h`'s contract said NULL meant allocation failure
  and now says it means the directory cannot be read.

  `copy_static` still ignores a NULL listing, and that is correct rather than
  overlooked: `static/` lives under the root, so the engine's own walk reaches
  it first and fails the build — which is why the unreadable-`static/` row
  above already exits 1 without touching that function.

  `unreadable_dir_checks` in `test/engine.c` covers the failure, the message,
  and the missing-directory contract. POSIX only, and it skips itself as root,
  where a mode of 000 stops nobody. Reverting fails two of the three.
- **~~B26 — Local-bus and remote-bus disagree on an undeliverable subject~~
  FIXED.** The same situation was finished-and-forgotten in-process and
  dead-lettered over HTTP.

  `deliver_batch` already took `is_dead` and its `target < 0` branch ignored
  it, which only showed on the local bus: `dev_deliver` guards with
  `target < 0 && !is_dead` *before* it calls, and `dev_drain` does not. So a
  subject with no page took the "dead-letter channel with no page" path
  locally and every message was marked **done**, where the remote path returns
  500 and lets the broker's retry and dead-letter policy have them.

  The guard is now one call deeper
  ([cli.c:1610](../src/cli.c#L1634)), where both paths reach it: no page and
  not the dead-letter channel means the batch is **returned**, with the same
  `[return]` line the remote path prints. `dev_deliver`'s own guard is now
  redundant and harmless.

  **Covered by two tests in `test/dev.test.js`.** It was filed as untestable
  and that was wrong: `$.publish` does validate the name at publish time, so a
  message for a page that does not exist is never made — but the case needs a
  message already *queued* when its page disappears, and a **failed delivery
  waiting on a backoff** is exactly that window. So: a handler that throws, a
  `--backoff` of two seconds, and the page deleted inside it.

  ```
  before  [dead]   handlers.a #1 no handlers.a page — kept, see `mdy dead handlers.a`
  after   [return] handlers.a (no page of that name here) — 1 message(s) returned
  ```

  The first test fails on the unfixed code by timing out — the `[return]` never
  comes. The second pins the other half, that the `.dead` channel itself still
  *finishes* rather than being returned, or a failed message would bounce
  between the two forever; it passes either way by design, because it guards
  against a wrong fix rather than testing this one.
- **~~B27 — `wrap()` assembles the document's source with `snprintf("%s…")`~~
  FIXED.** `snprintf` returns `int`, so a document over two gigabytes overflows
  it and the cast to `size_t` makes `out + o` an address nowhere near the
  buffer — AddressSanitizer's `negative-size-param` on a 3.6 GB input. The big
  pieces are `memcpy` now ([engine.c:2605](../src/engine.c#L2714)), which has
  no `int` in the path and reads more plainly besides.

  The scope lines keep `snprintf`: each is one short identifier twice, the
  reservation gives it `2*len + 32`, and its return cannot overflow an int at
  that size. It is checked anyway, because a negative there would be the same
  bug in miniature.

  Not tested at 3.6 GB — the machine would not enjoy it. What is tested is that
  nothing changed below that: `check-golden`, `check-sites` and
  `check-determinism` are byte-identical, the scope path still resolves a
  `const`, and an 8 MB document renders unchanged.

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
  ([engine_value.c:33](../src/engine_value.c#L40)); they allocate, which is what every
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
- Path normalisation: `resolve_path` ([engine_walk.c:467](../src/engine_walk.c#L473))
  and `absolute` ([cli.c:256](../src/cli.c#L257)) are the same algorithm
  written twice, both over `strtok`. **Not folded.** They are the same
  normalisation but not the same function: one joins against a base and writes
  into a caller's buffer, the other joins against the working directory and
  allocates, and only the second translates `\` to `/`. Unifying means picking
  one behaviour for both and finding a home for it — `fsx.h` is the candidate,
  since it already owns `fsx_is_absolute`. `resolve_path` has since moved, to
  [engine_walk.c:467](../src/engine_walk.c#L473), which settles where it lives
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

  There is one writer now ([engine_walk.c:232](../src/engine_walk.c#L239)) over one
  escaper ([engine_walk.c:184](../src/engine_walk.c#L191)), which `put_quoted` from
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
([2925–3234](../src/engine.c#L3035-L3344), ~300 lines) manages seven GC roots
and a `FAIL` macro that jumps to `done:`. It had three early returns that
*bypassed* `done:` — one was B3, another B12, the third silently cleared the
enclosing render's `taint` — and it has one exit now. Length is what let three
of them accumulate unnoticed, and the length is still there. `open_dir_inner`
([704–1015](../src/engine_walk.c#L714-L1082)) builds the synthetic source that
caused B1 and B2; what is left of it is B8. `mdy_parse_block` ([block.c:1267–1779](../src/parse/block.c#L1267-L1779),
480 lines) inlines the entire list grammar. `resize_in` defines a
`RESIZE_FAIL` macro and then uses it for two of its eight failures.

**Process-global state.** The memo tables ([engine.c:2732](../src/engine.c#L2840))
and `mdy_engine_rotate_memo(void)`, the nisaba slot table (`nis.c`),
`lookup_import`'s `static char path[1024]` ([1030](../src/engine.c#L1128)),
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
([1472](../src/cli.c#L1496), [1883](../src/cli.c#L1907)), and reuse the drain
loop for document mode by constructing a fake `Dev`
([1646–1679](../src/cli.c#L1670-L1703)). Five functions return pointers to
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

~~What is still true: every engine binary compiles from source in one `cc`
invocation, with no object files~~ — **also fixed, and it was the larger
half.** One object per source ([Makefile:484](../Makefile#L505)), and three
binaries that link them; `build/mdy` and `build/engine-test` share theirs,
ASan has its own because its flags differ.

| | before | after |
| --- | --- | --- |
| clean build of `mdy` + `engine-test` | 34.4s | 23.6s |
| after editing `cli.c` | 12.8s | **0.9s** |
| after editing `engine_internal.h` | 27.4s | **2.1s** |

`-MMD -MP` writes a `.d` beside each object naming every header that source
actually opened. `engine.o` depends on twenty-six, of which `ENGINE_HDRS`
named five: the rest are lamassu's, nisaba's, and the *generated*
`build/highlight_bundle.h`. So `ENGINE_HDRS` is gone — a hand-written list
that was wrong in the safe direction is still wrong, and editing
`engine_internal.h` now rebuilds exactly the four files that include it,
`fsx.h` exactly seven.

Rules are generated per source with `$(eval)` rather than found by a `vpath`
([Makefile:498](../Makefile#L526)): the sources come from four directories, two
outside this tree, and a global `vpath %.c` would also be consulted for the
parser's and the tests', which resolve by exact path and should keep doing so.
Object names are basenames, so two sources may not share one — thirty-one are
distinct today and the Makefile now `$(error)`s if that ever stops being true,
because the failure otherwise is a silent mis-link.

`make wasm` is deliberately left as one `emcc` invocation: one target, built
rarely, and emcc spends its time linking rather than compiling.

**What none of this fixes, and it took three wrong answers to isolate.** GNU
Make 3.81 — which is the one macOS ships — compares mtimes at **second**
resolution. A prerequisite written half a second after the target still reads
as up to date:

```
$ touch out; touch -r out src      # then make src 0.5s newer, same second
$ make
make: `out' is up to date.
```

Object files do not change that; the comparison is make's, not the rule's.
This has produced a wrong answer three times in this review — a FAIL from a
binary that predated the fix, a PASS from one that predated the bug, and a
leak measurement that reported clean because `git stash` restored the file
within the same second as the link, which nearly had B34 recorded as
self-inflicted. Each time the result described a different binary than the one
named.

There is nothing a Makefile can do about it, so the Makefile says so
([Makefile:60](../Makefile#L61)) — and only when a `check-` target is what was
asked for, since that is where believing a stale result costs something.
Ordinary builds stay quiet.

While here: the ASan build was never read for warnings, and had one from
`stb_image_resize2.h` that appears at `-O1` and not at `-O2`. It goes in the
`#pragma` block `images.c` already keeps for exactly this
([images.c:29](../src/images.c#L30)). A clean build of all three binaries is
silent now, not just the default one.

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
`make clean` build is silent now — and since the Makefile work in §3, so are
`build/engine-test` and `build/mdy-asan`, which had never been read for
warnings and where `-O1` shows one `-O2` does not. The unused parameter went with `column_align`;
the three `const mdy_node *` casts were added, which is what the same file
already does in six other places — the wart underneath is that `mdy_root`
returns const to callers who own the tree, and that is still there; and
`stb_image.h`'s two unused helpers are silenced by a `#pragma` around its
include in `images.c`, as narrowly as the file it is for and without editing
somebody else's header. What follows is what the warnings were.

**Warnings in a clean build.** `-Wall -Wextra` produces six: three
const-discards where the engine mutates the tree behind `mdy_root`'s `const`
([engine.c:282](../src/engine.c#L285), [1006](../src/engine.c#L1104),
[3177](../src/engine.c#L3287)), the unused parameter above, and two from stb
under `STBI_ONLY_PNG`. A non-const `mdy_root_mut` in `mdybuild.h` (or
`-Wno-unused-function` around the stb include) makes the build silent, which
is the only state in which a *new* warning is noticed.

**Error reporting has four conventions.** `0/-1` with an error buffer
(engine, fsx), `BJ_*` codes (memns, nis), `NULL` plus a static message buffer
(cli), and `fprintf(stderr)` from inside the library
([engine.c:2376](../src/engine.c#L2485), [2391](../src/engine.c#L2500)) even
though `on_message` exists for exactly that. Pick two.

**Debug switches are read in hot paths.** `getenv("MDY_MEMO_DEBUG")` runs
three times per render and `getenv("MDY_LINEMAP_DEBUG")` once per produced
line ([engine.c:2676](../src/engine.c#L2784)); read them once in
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
