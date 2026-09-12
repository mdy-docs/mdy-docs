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
| B3 | High | `engine.c` render memo | `$.render` of a `.md` document yields an empty or *wrong* token |
| B4 | High | `engine.c` querying | `$.find` is cubic in the size of the set |
| B5 | Medium | `engine.c` / `nis.c` | The nisaba collection is never closed: memory grows on every rebuild |
| B6 | Medium | `engine.c` render memo | The two-generation memo never hits across builds |
| B7 | Medium | parser, writer, engine, YAML | Unbounded recursion: crafted input crashes the process |
| B8 | Medium | `engine.c` directory walk | A file name containing `"` or `\` silently loses its identity |
| B9 | Medium | `yaml.c` | Text after a closing quote is silently dropped |
| B10 | Medium | `cli.c` dev server | NULL engine dereference on delivery after a failed first build |
| B11 | Medium | `images.c` | TIFF header reader: 32-bit overflow → out-of-bounds read |
| B12 | Medium | `engine.c` | Render-depth counter leaks on an out-of-range index |
| B13–B27 | Low | various | Rooting fragility, portability, leaks on error paths, truncation, UB casts |
| B28 | Low | `yaml.c` | A trailing `...` document-end marker is refused as "more than one document" |
| B29 | Medium | `engine.c` natives | `$.count` is missing: a document reading it gets `undefined` |
| B30 | Low | `doc.c` | A CRLF source: the splitter normalises line endings, node keeps them |
| B31 | Low | `engine.c` records | A record's keys come back in a different order, and `$.data` carries an `_id` node hides |

Plus: ~450 lines of dead code (§2), a set of structural liabilities (§3), and
the maintainability items in §4 — of which the most important is that the
directory walk, the dev server and the HTTP layer have no tests that could
have caught B1–B3, B5, B6 or B10. (B1's and B2's fixes come with the first
two of those — `data_file_checks` and `blank_file_checks` in `test/engine.c`.)

---

## 1. Bugs

### Confirmed

#### B1 — A `.yaml` file that begins with `---` corrupts the document set (High) — FIXED

**Fixed.** A data file's bytes are no longer part of the concatenated source.
`open_dir_inner` parses them once as YAML ([engine.c:1723](../src/engine.c#L1723))
and the mapping travels beside the document in a new `ident_data`
([engine.c:204](../src/engine.c#L204)), merged in `mdy_engine_open` after the
document's own fields and before `path`
([engine.c:2532](../src/engine.c#L2532)) — which is where mdy-docs puts a
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
itself accepts it ([yaml.c:1060–1063](../src/parse/yaml.c#L1060-L1063)).

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
([engine.c:1787](../src/engine.c#L1787)) instead of counting beforehand and
re-deriving afterwards. Identity is collected per FILE while the walk runs
(`WalkedFile`, [engine.c:1552–1558](../src/engine.c#L1552-L1558)) and expanded
to one entry per document once the count is known
([engine.c:1810](../src/engine.c#L1810)). The two computations that had to
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
([engine.c:2387](../src/engine.c#L2387)), so both ways in run the same code.

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

#### B3 — `$.render` of a `.md` document returns an empty or wrong token (High)

`render_tree_out` returns early for a markdown document
([engine.c:4817–4840](../src/engine.c#L4817-L4840)) without reaching the
`done:` label, which is where `e->last_render_key` is written
([5032](../src/engine.c#L5032)). `render_native` then parks the tree under
that stale key ([2267](../src/engine.c#L2267)):

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

#### B4 — `$.find` is O(N³) in the number of documents (High)

`run_query_in` restores document order with a doubly nested loop — for every
document position, every hit — and each inner step calls `index_of_id`, which
itself formats and compares hex ids across the *whole* set
([engine.c:2766–2775](../src/engine.c#L2766-L2775),
[2717–2729](../src/engine.c#L2717-L2729)). It also converts each hit's `_id`
to UTF-8 with a fresh allocation on every one of those inner steps.

Measured on a site of N one-line documents whose entry runs one `$.find({})`:

| N | C engine | node |
| --- | --- | --- |
| 300 | 0.31 s | 1.30 s |
| 600 | 2.14 s | 0.90 s |

Doubling N cost 7×; at N = 2,000 a single `$.find({})` takes over a minute.
Decoding each hit's `_id` once and sorting hits by index (or bucketing by a
hash map from oid to index) makes this O(N log N).

#### B5 — The nisaba collection is never closed (Medium)

`nis_close` has no callers anywhere in the package; `close_set`
([engine.c:2362–2371](../src/engine.c#L2362-L2371)) and `mdy_engine_free` free
everything except the collection handle. Every `mdy_engine_new`+`open_dir`
leaks the primary store, the `path` index store and a slot in the global
table. `mdy dev` and `--watch` create a fresh engine per rebuild, so memory
grows with every save.

Measured with the memo rotated per cycle, as the CLI does: 200
open+render+free cycles of `examples/blog` (16 files) took the process from
5 MB to 71 MB — about 0.33 MB per rebuild for a tiny site, proportional to
the site's data.

`nis_close` also leaves `bpt` trees unfreed (it frees the stores but never
calls `bpt_free` on `s->tree` or `s->index_trees[i]`), so closing it will
need finishing too.

#### B6 — The memo never hits across builds (Medium)

The memo is documented as keeping two generations so "a rebuild may reuse the
build before it" ([engine.h:193–200](../src/engine.h#L193-L200)). The key is
`document_fingerprint`, which hashes the document's *record* as returned from
nisaba ([engine.c:4713–4725](../src/engine.c#L4713-L4725)) — and the record
includes `_id`, a fresh ObjectId minted at every open
([2542](../src/engine.c#L2542)). Two builds of the same unchanged site never
share a key.

Measured with `MDY_MEMO_DEBUG=1` over three consecutive rotate+open+render
cycles of `examples/blog`: every cycle reports the same `4 hits, 34 misses,
30 kept`. Zero cross-generation hits. Skip `_id` (and only `_id`) when hashing
the record, and the rebuild path gets what the design promised.

#### B7 — Unbounded recursion on nested input (Medium)

Several walkers recurse per nesting level with no depth limit:
`write_node` ([html.c:308–389](../src/parse/html.c#L308-L389)), `mdy_clone`
([ast.c:121–183](../src/parse/ast.c#L121-L183)), `tree_to_js`, `js_to_tree`,
`splice_tree`, `collect_headings` in engine.c, and `parse_flow`
([yaml.c:585–695](../src/parse/yaml.c#L585-L695)). The block parser builds the
`<div>` chain for an indented line iteratively but then every downstream pass
recurses over it.

- A single line indented by 400,000 spaces (200k nested divs, a 400 KB file):
  `mdy file.mdy --html` exits 139 (segfault).
- YAML `a: ` followed by 200,000 `[`: `yamlcat` exits 139.

md4c's front end caps at 128 levels and refuses cleanly
([markdown.c:22](../src/parse/markdown.c#L22)); the rest should do the same. For
a build tool fed its own site this is low risk; for the live preview and the
wasm `document()` API, which take arbitrary typed input, it is a crash.

#### B8 — A file name containing `"` or `\` silently loses its identity (Medium)

Identity is written as YAML text by `snprintf` with no escaping
([engine.c:1639–1641](../src/engine.c#L1639-L1641), [1742](../src/engine.c#L1742)).
A name like `it"s.mdy` produces `name: "it"s.mdy"`, which the YAML reader
reads as `it` (see B9) — so the document's `path`, `name` and `ext` are all
truncated at the quote. Node reports `it"s.mdy`. A backslash in a name would
be read as an escape. Either escape the values or stop encoding identity as
text (see §3, *Identity as text*).

#### B9 — YAML: trailing text after a closing quote is dropped (Medium)

After `read_quoted` returns, `parse_value_from` advances to the next line
without checking what followed the quote
([yaml.c:786–791](../src/parse/yaml.c#L786-L791)). `title: "Hello" world`
parses as `Hello`; `name: "it"s.mdy"` as `it`. The file's own contract is
"where a construct is not supported it says so … a parser that silently
mis-reads data is worse than one that refuses it" — this is the one place it
guesses.

#### B10 — `mdy dev --broker <url>`: crash on delivery after a failed first build (Medium)

`cmd_dev` deliberately keeps serving when the first build fails
([cli.c:1922](../src/cli.c#L1922)), leaving `d.engine == NULL`
([1833–1837](../src/cli.c#L1833-L1837)). With a remote broker the registration
still happens, and the first delivery reaches `dev_deliver`, which calls
`mdy_engine_page_index(d->engine, …)` and `mdy_engine_document_path` on the
NULL engine ([1696](../src/cli.c#L1696), [1567](../src/cli.c#L1567)). By
reading; not executed against a broker.

#### B11 — TIFF dimension reader: 32-bit overflow → out-of-bounds read (Medium)

`tiff_size` checks `off + 2 > n` with `off` a `uint32_t`
([images.c:142–148](../src/images.c#L142-L148)); `off = 0xFFFFFFFE` wraps the
sum to 0, passes the check, and `le16(b + off)` reads 4 GB past the buffer.
The same wrap is in `e = off + 2 + i * 12`. A corrupt or crafted `.tif`
anywhere in a walked directory crashes the build. Promote to `size_t` before
adding.

#### B12 — Render depth leaks on an out-of-range index (Medium)

`render_tree_out` increments `e->depth`, replaces `e->current` and zeroes
`e->taint` ([engine.c:4768–4799](../src/engine.c#L4768-L4799)) *before* the
index check at [4803–4806](../src/engine.c#L4803-L4806), which returns without
restoring any of them. Demonstrated: 40 calls to `mdy_engine_render(e, 99, …)`
followed by `mdy_engine_render(e, 0, …)` fails with "render depth exceeded
(cyclic $.render?)". `test/engine.c:1114` exercises exactly this path and
cannot notice. Move the check above the state changes.

#### B29 — `$.count` is missing from `$` (Medium)

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
([engine.c:1639–1641](../src/engine.c#L1639-L1641)), `path` last so that it
wins over a data file's own; node reaches the same result with
`{ ...meta, ...parsed, path }`, where re-assigning `path` leaves it in the
position it was first written — first.

It costs nothing until a document serialises a record or walks its keys, at
which point the two engines disagree about the bytes. No site in the tree
does, which is why `check-sites` is green. Found while fixing B2; it predates
both fixes.

#### B28 — YAML: a trailing `...` is refused as a second document (Low)

`mdy_yaml_parse` rejects any `...` line at indent 0 as "more than one document
in a stream" ([yaml.c:1056–1057](../src/parse/yaml.c#L1056-L1057)), but a `...`
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

- **B13 — GC rooting that works by luck.** The file's own rule (lines 268–287)
  is that a value reachable only from the C stack must be rooted before
  anything allocates, and that building a key allocates. Four sites violate
  it: `js_object_get(e->vm, hit, key(e->vm, "_id"))` on an unrooted query
  result in `mdy_engine_entry` ([1982](../src/engine.c#L1982)) and
  `resolve_target` ([2228](../src/engine.c#L2228)), on an unrooted decode in
  `lookup_import` ([2930](../src/engine.c#L2930)), and
  `js_object_get(e->vm, document_record(e, i), key(…))` in `publish_native`
  ([3712–3713](../src/engine.c#L3712-L3713)). They survive `MDY_GC_STRESS`
  only because the atom is already interned by the time they run. Root the
  value or build the key first.
- **B14 — `report()` uses `strftime("%l")`** ([cli.c:1082](../src/cli.c#L1082))
  while `stamp_now`, twenty lines later, avoids `%l` precisely because
  emscripten and msvcrt lack it. The `--watch` status line is the one place it
  still appears.
- **B15 — Dev server leaks a refused publish's response**: the
  `r.status < 200 || r.status >= 300` branch never calls
  `http_response_free` ([cli.c:1436–1439](../src/cli.c#L1436-L1439)).
- **B16 — No socket timeouts** in `http.c` (connect, and a `recv` loop that
  runs until the peer closes, [152–159](../src/http.c#L152-L159)). A broker
  that accepts and never answers hangs `mdy build --publish`, `mdy dead` and
  the dev server's registration forever. `parse_url` also cannot take an IPv6
  literal (`http://[::1]:8080` → host `[`).
- **B17 — Dev server exposure**: it binds `0.0.0.0`
  ([cli.c:1927](../src/cli.c#L1927)) and the delivery bearer token is four
  `rand()` calls seeded from the clock ([1934](../src/cli.c#L1934),
  [2013](../src/cli.c#L2013)). The request buffer has no size cap
  ([httpd.c:278–283](../src/httpd.c#L278-L283)) and responses are written with
  a blocking `send` ([188](../src/httpd.c#L188)), so one slow LAN client stalls
  rebuilds. Binding `127.0.0.1` by default removes most of this.
- **B18 — Watcher scan is O(n²)**: `snapshot_changes` looks each file up with a
  linear `find` ([watch.c:66–94](../src/watch.c#L66-L94)) every 120 ms. Both
  snapshots come from `fsx_list`, which sorts, so a merge would be linear.
- **B19 — `mdy build`/`dev`/`dead` accept anything as the positional**: an
  unknown flag or a flag with its value missing falls into `else root = a`
  ([cli.c:672](../src/cli.c#L672), [1895](../src/cli.c#L1895),
  [440](../src/cli.c#L440)). `mdy build --draft` builds a site called
  `--draft`; `mdy build site --out` builds `--out`. Document mode (and the
  JavaScript CLI) reject unknown options.
- **B20 — Silent truncation into fixed buffers, all parity divergences with no
  warning**: heading ids over 255 bytes (`unique[256]`,
  [block.c:330](../src/parse/block.c#L330)) and heading text over 1 KB
  ([1378](../src/parse/block.c#L1378)); class names over 127 bytes
  ([551](../src/parse/block.c#L551)); attribute names over 255 (`lowered`,
  [499](../src/parse/block.c#L499), which then skips the lowercasing
  entirely); page hrefs over 1 KB, which skip normalisation *and* the
  reference collection ([532–539](../src/parse/block.c#L532-L539),
  [inline.c:707–714](../src/parse/inline.c#L707-L714)); tables with more than
  64 columns ([1087](../src/parse/block.c#L1087)); more than 512 URLs in one
  paragraph ([inline.c:160](../src/parse/inline.c#L160)); tag hrefs
  ([inline.c:458](../src/parse/inline.c#L458)), footnote ids
  ([footnote.c:33](../src/parse/footnote.c#L33)), TOC hrefs
  ([engine.c:3472](../src/engine.c#L3472)), identity records over 4 KB
  ([engine.c:1638](../src/engine.c#L1638), where a truncated `ident_len` can
  also underflow the second `snprintf`'s size). Each is unlikely alone; none
  says anything when it happens.
- **B21 — Undefined behaviour on double→integer casts** performed *before* the
  range check: [engine.c:511](../src/engine.c#L511), [ingest.c:22](../src/ingest.c#L22),
  [bjval.c:119](../src/bjval.c#L119), [html.c:220](../src/parse/html.c#L220),
  [ast.c:251](../src/parse/ast.c#L251), [yaml.c:1170](../src/parse/yaml.c#L1170).
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
  `mdy_engine_encode_json` ([engine.c:2673](../src/engine.c#L2673)); the fence
  body, list and paragraph joins in block.c ([1405](../src/parse/block.c#L1405),
  [1605](../src/parse/block.c#L1605), [1691](../src/parse/block.c#L1691),
  [1818](../src/parse/block.c#L1818)); `cache_put` frees the *new* array on a
  partial failure and leaves `c->dirs` dangling ([engine.c:1521](../src/engine.c#L1521)).
  The parser's stated rule is that `mdy_alloc` can fail; sixteen call sites in
  block.c never look.
- **B25 — `walk` treats every `opendir` failure as an empty directory**:
  `return errno == ENOENT ? 0 : 0` ([fsx.c:190](../src/fsx.c#L190)) — a
  permission error on a subtree silently drops it from the site.
- **B26 — Local-bus and remote-bus disagree on an undeliverable subject**:
  `dev_drain` passes `target < 0` for *any* subject with no page into the
  "dead-letter channel with no page" branch, which marks every message done
  ([cli.c:1555–1566](../src/cli.c#L1555-L1566)); `dev_deliver` returns 500 so
  the broker dead-letters them ([1700–1707](../src/cli.c#L1700-L1707)).
- **B27 — `wrap()` assembles the document's source with `snprintf("%s…")`**
  ([engine.c:4466–4469](../src/engine.c#L4466-L4469)); on a 3.6 GB input
  AddressSanitizer reports `negative-size-param` from the `int` return value
  overflowing. Pathological, but `memcpy` is also simpler.

---

## 2. Unused code

| Where | What | Notes |
| --- | --- | --- |
| [fsx.c:395–589](../src/fsx.c#L395-L589), [fsx.h:60–86](../src/fsx.h#L60-L86) | "What the ported test suite needs": `fsx_readdir`, `fsx_mkdirp`, `fsx_rm_rf`, `fsx_mkdtemp`, `fsx_tmpdir`, plus `is_dir_path`/`remove_dir` | The suite it served is gone (README, "that binary is gone"). `fsx_readdir` and `fsx_remove` have no callers at all; the other four are used only by `test/engine.c`, which could use `mkdtemp` directly. ~200 lines including the Win32 halves. The header still cites `../shims/fs.js` and `../shims/node/`, which do not exist. |
| [oswin.c:32–85](../src/oswin.c#L32-L85), `oswin.h` | `win_pread`, `win_pwrite`, `win_fsize`, `win_ftruncate`, `win_temp_file`, `win_close` | Left from when nisaba's store was a temp file. No callers. |
| [nis.c:213–225](../src/nis.c#L213-L225) | `nis_close` | No callers — see B5; this one should gain a caller rather than be deleted. Its neighbour comment (43–55) describes a `host.c` finalizer and per-collection temp files, neither of which exists; `nis.h:543–546` says the same. |
| [httpd.c](../src/httpd.c) | `httpd_query`, `httpd_kept_count`, `httpd_close` | No callers (the dev loop never exits). |
| [Makefile:128–134](../Makefile#L128-L134) | `build/libnisaba.a` | Nothing links it; every engine binary recompiles all 20 nisaba sources from scratch instead. The stale `build/libnisaba.a`, `build/mdy-build`, `build/mdy-build-asan` in the build tree are its fossils. |
| [Makefile:245–246](../Makefile#L245-L246) and [249–250](../Makefile#L249-L250), `test/doccat.c`, `test/datacat.c` | Two drivers with build rules that no check target or script invokes | `md4cprobe` is in the same state but is at least mentioned in `docs/parser.md` as a manual baseline tool. |
| [cli.c:1183–1208](../src/cli.c#L1183-L1208) | `is_help` | Set, then `(void)is_help`. |
| [engine.c:3277](../src/engine.c#L3277) | `column_align`'s `e` parameter | Compiler warning in every build. |
| [block.c:333](../src/parse/block.c#L333) | `(void)id_len` in `set_heading_id` | The variable is only computed to be discarded. |
| [block.c:1605](../src/parse/block.c#L1605) | `mdy_alloc(doc ? &doc->arena : NULL, …)` | `doc` cannot be NULL there and `mdy_alloc(NULL)` would crash. |
| [engine.h:22–30](../src/engine.h#L22-L30) | "WHAT THIS DOES NOT DO YET" | All three items are done; the list now misleads. Same for [block.c:1973](../src/parse/block.c#L1973) (`shims/parse.js`) and [docs/cli-plan.md:116–125](cli-plan.md) (`scripts-compare-cli.mjs`, "N/40 cases" — neither exists; `check-cli` runs `cli.test.js` directly, 34 cases). |

**Duplicated rather than unused**, and worth folding:

- UTF-8↔UTF-16: `to_utf16`/`from_utf16` in engine.c
  ([222–262](../src/engine.c#L222-L262)) duplicate `mdy_to_utf16`/`mdy_from_utf16`
  from `mdytext.h` — with *different* behaviour (the engine's decoder accepts
  overlong forms and surrogates the parser's rejects), so the same bytes cross
  the boundary two ways depending on the path.
- Path normalisation: `resolve_path` ([engine.c:1333](../src/engine.c#L1333))
  and `absolute` ([cli.c:256](../src/cli.c#L256)) are the same algorithm
  written twice, both over `strtok`.
- ASCII case-insensitive comparison, written inline at least seven times
  (`ends_with_ci`, `is_image_ext`, `ieq`, `doctype_line`, `resize_in`,
  `column_align`, `lower_ascii`).
- A growable byte buffer, implemented seven times as `Buf`/`Out`
  (`cli.c`, `fsx.c`, `html.c`, `script.c`, `yaml.c`, `data.c`, `ast.c`,
  `bjval.c`) and ad hoc with `realloc` in engine.c (`fill_tokens`,
  `collect_text_into`, `put_block_scalar`, `rewrite_imports`, `flatten`,
  `open_dir_inner`) and `broker.c`.
- `is_void_element` ([block.c:836](../src/parse/block.c#L836)) and `is_void`
  ([html.c:202](../src/parse/html.c#L202)): the same twenty names twice.
- `in_ranges` in `unicode.c` and `linkify.c`; UTF-8 encoding in `markdown.c`,
  `yaml.c`, `unicode.c` and `engine.c`.
- The `tags:` YAML writer, twice (`put_tags_from_text`, `put_document_tags`).
- `ref_id` called twice for the same string
  ([footnote.c:67–68](../src/parse/footnote.c#L67-L68)) — two arena copies per
  footnote.

---

## 3. Structures that have outgrown their shape

**`engine.c` (5,035 lines) is one translation unit doing six jobs**: the VM
boundary, the document store, the directory walk and import graph,
composition (tokens/splicing), the twenty `$` natives, and the render memo.
`struct mdy_engine` has ~50 fields spanning all of them. Three of the high
bugs above live in the seams between these jobs. Natural splits already exist
in the file's own section comments: the walk (`open_dir_inner`,
`rewrite_imports`, identity), the natives, composition, and the memo could each
be a file with a small internal header.

**Long functions with several exits.** `render_tree_out`
([4742–5046](../src/engine.c#L4742-L5046), ~300 lines) manages seven GC roots,
a `FAIL` macro that jumps to `done:`, and three early returns that *bypass*
`done:` — one of which is B3 and another B12. `open_dir_inner`
([1572–1882](../src/engine.c#L1572-L1882)) builds the synthetic source that
caused B1 and B2; what is left of it is B8. `mdy_parse_block` ([block.c:1280–1760](../src/parse/block.c#L1280-L1760),
480 lines) inlines the entire list grammar. `resize_in` defines a
`RESIZE_FAIL` macro and then uses it for two of its eight failures.

**Process-global state.** The memo tables ([engine.c:4614](../src/engine.c#L4614))
and `mdy_engine_rotate_memo(void)`, the nisaba slot table (`nis.c`),
`lookup_import`'s `static char path[1024]` ([2912](../src/engine.c#L2912)),
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
([1477](../src/cli.c#L1477), [1864](../src/cli.c#L1864)), and reuse the drain
loop for document mode by constructing a fake `Dev`
([1649–1682](../src/cli.c#L1649-L1682)). Five functions return pointers to
`static char msg[4096]`.

**The Makefile** repeats the twelve-file engine source list four times
(`build/mdy`, `build/engine-test`, `build/mdy-asan`, `ENGINE_SRCS`), compiles
every engine binary from source in one `cc` invocation (no object files: a
one-line change to `cli.c` recompiles nisaba), and lists only `.c` files as
prerequisites, so editing `src/engine.h` does not rebuild `build/mdy`.

---

## 4. Maintainability going forward

**Tests reach the parser and the renderer, not the edges.** `test/engine.c`
exercises `open`, `open_dir`, `entry`, `render`, `count`, the three callbacks
and the broker; it never calls `render_text`, `render_json`, `page_index`,
`document_path`, `set_scope_json`, `set_response`, `on_message`,
`set_split`/`sanitize`/`tasks`, `set_context_json`, `encode_json`,
`root_count`/`root_at` or `rotate_memo` — those are covered only by the 34
CLI cases, which CI runs on Linux alone. `httpd.c`, `http.c` and `watch.c`
have no test of any kind; `mdy dev` (about 900 lines across four files) has
none — `test/serve.test.js` exists upstream and `docs/cli-plan.md` names
running it as Phase 5's exit criterion, but nothing wires it up. The
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

**Warnings in a clean build.** `-Wall -Wextra` produces six: three
const-discards where the engine mutates the tree behind `mdy_root`'s `const`
([engine.c:2267](../src/engine.c#L2267), [2888](../src/engine.c#L2888),
[4995](../src/engine.c#L4995)), the unused parameter above, and two from stb
under `STBI_ONLY_PNG`. A non-const `mdy_root_mut` in `mdybuild.h` (or
`-Wno-unused-function` around the stb include) makes the build silent, which
is the only state in which a *new* warning is noticed.

**Error reporting has four conventions.** `0/-1` with an error buffer
(engine, fsx), `BJ_*` codes (memns, nis), `NULL` plus a static message buffer
(cli), and `fprintf(stderr)` from inside the library
([engine.c:4258](../src/engine.c#L4258), [4273](../src/engine.c#L4273)) even
though `on_message` exists for exactly that. Pick two.

**Debug switches are read in hot paths.** `getenv("MDY_MEMO_DEBUG")` runs
three times per render and `getenv("MDY_LINEMAP_DEBUG")` once per produced
line ([engine.c:4558](../src/engine.c#L4558)); read them once in
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

1. B3, B12 and B6 are one change: give `render_tree_out` a single exit and
   hash the record without `_id`. Small, high value, easy to test.
2. ~~B1~~, ~~B2~~, B8: stop building identity as text. Done as far as the
   document text goes — the files are separate sources and the counting logic
   is gone. B8 is what remains: identity is still YAML written by `snprintf`,
   and the fix is to build it as values rather than escape it.
3. B4: sort hits by a decoded index. One function.
4. B5: call `nis_close` from `close_set` and finish `nis_close` (`bpt_free`).
5. B11, B7 (a depth cap in the walkers), B9, B10, B13 — each a few lines.
6. Delete §2's dead code; add the `check-sites` fixture and a
   `check-generated` target; make the default build warning-free.
7. Then the structural work in §3, starting with splitting engine.c along its
   existing section boundaries.

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

# B3 — .md through $.render
mkdir -p /tmp/mr && printf '# Alpha\n\nfirst body\n' > /tmp/mr/a.md && printf '# Beta\n\nsecond body\n' > /tmp/mr/b.md
printf 'A: {{ $.render({ path: "a.md" }) }}\nB: {{ $.render({ path: "b.md" }) }}\n' > /tmp/mr/main.mdy
./build/mdy /tmp/mr --html; node ../../bin/mdy.js /tmp/mr --html

# B4 — $.find scaling (N = 300, 600)
N=600; mkdir -p /tmp/sc/p; for i in $(seq 1 $N); do printf '+++\ntitle: %d\n+++\nbody\n' $i > /tmp/sc/p/$i.mdy; done
printf '%% const all = $.find({})\n{{ all.length }} documents\n' > /tmp/sc/main.mdy
time ./build/mdy /tmp/sc; time node ../../bin/mdy.js /tmp/sc

# B7 — nesting
python3 -c "print(' '*400000 + 'x')" > /tmp/deep.mdy; ./build/mdy /tmp/deep.mdy --html >/dev/null; echo $?   # 139
python3 -c "print('a: ' + '['*200000 + ']'*200000)" | ./build/yamlcat >/dev/null; echo $?                   # 139

# B8 / B9
printf '+++\ntitle: Quoted\n+++\nhi\n' > '/tmp/yd/it"s.mdy'; ./build/mdy /tmp/yd
printf 'title: "Hello" world\n' | ./build/yamlcat                                                            # {"title":"Hello"}

# B5, B6, B12 — small C programs against engine.h (open+render+free in a loop,
# reporting ru_maxrss; MDY_MEMO_DEBUG=1 across rotate+open+render cycles;
# forty mdy_engine_render(e, 99, …) calls then mdy_engine_render(e, 0, …)).
```
