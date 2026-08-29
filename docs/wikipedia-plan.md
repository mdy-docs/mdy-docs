# mdy-wikipedia — implementation plan

A tool that takes a Wikipedia page and writes an `.mdy` document: the prose
as MDY markup, and everything the page knows *about itself* — the infobox,
the coordinates, the section outline, the images, the citations, the
Wikidata claims — lifted out into `+++` front matter as YAML, where `res.data`
can reach it.

The worked example throughout is
[Babylon](https://en.wikipedia.org/wiki/Babylon), and every sample below is
real output from a probe against the live API, not an illustration.

## Why this is an mdy tool and not a scraper

An mdy document is *prose plus data in one file*, and a Wikipedia article is
already exactly that — it just keeps the two in different places. The
infobox is a table pretending to be a record; the coordinates are a
`<span class="geo">`; the references are `<sup>`s pointing at a list at the
bottom. Rendering the page to Markdown throws all of that away and leaves
you with text. Converting it to MDY does not have to:

```mdy
+++
title: Babylon
infobox:
  built: c. 2200 BC
  location: Hillah, Babil Governorate, Iraq
+++
= {{ res.data.title }}

Founded {{ res.data.infobox.built }}, at {{ res.data.infobox.location }}.
```

That is the whole pitch. The output is a document you can *query* — put a
few hundred of them in a vault and `$.find({'infobox.type': 'Settlement'})`
works, because the infobox became a record on the way in.

## The missing half of the parser

mdy has `fromMdy` — text → hast. It has no `toMdy` — hast → text. Every
part of this tool except the Wikipedia-specific knowledge is that function,
and it is the piece worth building carefully, because:

- it is the general HTML → MDY importer, wanted by anything that ingests the
  web, not just this
- it makes MDY round-trippable, which is a real test surface:
  `toMdy(fromMdy(source))` should re-parse to the same tree, and that
  property can be run over every fixture in `test/` for free
- it is where all the correctness lives (see [escaping](#escaping-is-the-whole-job))

So `toMdy` starts life in this package, exported in its own right, and moves
into mdy-docs core the day a second importer exists — the same call that was
made for the vault layer (see [site-plan](site-plan.md#mdy-docsvault-moved-directly-into-mdy-docs)).

## Package shape

```
packages/mdy-wikipedia/
  package.json            @mdy-docs/mdy-wikipedia, bin: mdy-wikipedia
  bin/mdy-wikipedia.js    CLI
  src/index.js            wikipediaToMdy(title, options) — the one entry point
  src/fetch.js            REST/Action/Wikidata clients, User-Agent, disk cache
  src/extract.js          hast → the YAML record (infobox, figures, refs, …)
  src/clean.js            hast → hast, Wikipedia chrome removed
  src/to-mdy.js           hast → MDY source            ← the reusable half
  src/escape.js           the escaping table, alone and tested alone
  test/fixtures/          babylon.html, babylon-summary.json, babylon.wikidata.json
  test/*.test.js
  README.md
```

Wiring follows every other package here: `"mdy-docs": "file:../.."`, so the
import is the one a published package would use. The only new dependency is
`hast-util-from-html`, whose own parser (`parse5`) is already in the tree
via `rehype-raw`; `yaml` comes from the root. Nothing else.

One change is needed on the root package: `"./parse/*": "./src/parse/*"` in its
`exports`, so the lexical helpers are importable. That is not a convenience —
it is the whole design of the escaper. `escape.js` finds what to escape by
calling `matchEmoji`, `findLinks`, `parseWikiLink` and `matchReference`, the
same functions `parseInline` calls, so the two cannot disagree about where a
construct begins. Reimplementing those tables here would be a second grammar to
keep in step, and it would drift.

## The pipeline

Five stages, each a pure function of the last, so each is testable against a
committed fixture with no network.

### 1. Fetch

Given `Babylon`, `en:Babylon`, or `https://en.wikipedia.org/wiki/Babylon`,
resolve `(lang, title)` and fetch:

| Endpoint | Gives |
| --- | --- |
| `/api/rest_v1/page/html/{title}` | Parsoid HTML — 508 KB for Babylon |
| `/api/rest_v1/page/summary/{title}` | description, extract, coordinates, `pageid`, `revision`, `wikibase_item`, lead image |
| `/w/api.php?action=query&prop=categories\|langlinks` | taxonomy (opt-in) |
| `wikidata.org/wiki/Special:EntityData/{Q}.json` | typed claims (opt-in, `--wikidata`) |

**Parsoid HTML, not the Action API's `action=parse`, and not wikitext.**
Parsoid emits `<section data-mw-section-id>` wrappers, `rel="mw:WikiLink"`
on internal links, and `typeof="mw:Transclusion"` on template output — three
things the extractor needs and the other two forms do not have. Wikitext
loses worse: the Babylon infobox's `built` field is literally
`{{circa|2200 BC}}` and its area is `{{cvt|9|km2|sp=us}}`, so reading
wikitext means implementing MediaWiki's template expander. Parsoid has
already run it, and those same two fields arrive as `c. 2200 BC` and
`9 km2 (3.5 sq mi)`.

Wikimedia's API etiquette is not optional and is cheap to honour: a real
`User-Agent` naming the tool and a contact URL, one request at a time, and a
disk cache (`--cache`, default `~/.cache/mdy-wikipedia`) keyed by
`{lang}/{title}@{revision}` so iterating on the converter costs zero
requests after the first.

### 2. Parse

`hast-util-from-html` → hast. From here on it is the same tree shape the
rest of mdy-docs already manipulates, and the existing `unist-util-visit`
dependency does the walking.

### 3. Extract — before anything is thrown away

The extractor runs *first*, because most of what it wants is in the parts
step 4 deletes. It produces the front matter record.

**The infobox** is the prize. Parsoid renders it as a `<table class="infobox">`
of `<th class="infobox-label">` / `<td class="infobox-data">` pairs, broken
into groups by `<th class="infobox-header">`. Slugify the labels, nest by
the headers, and Babylon's infobox comes out as — verbatim from the probe:

```yaml
infobox:
  type: Settlement
  cultures: Sumerian, Akkadian, Amorite, Kassite, Assyrian, Chaldean,
    Achaemenid, Hellenistic, Parthian, Sasanian, Islamic Caliphates
  location: Hillah, Babil Governorate, Iraq
  region: Mesopotamia
  part-of: Babylonia
  history:
    built: c. 2200 BC
    abandoned: c. 1000 AD
  site-notes:
    area: 9 km2 (3.5 sq mi)
    archaeologists: Hormuzd Rassam, Robert Koldewey, Taha Baqir, recent Iraqi Assyriologist
    condition: Ruined
    owner: Public
  unesco-world-heritage-site:
    official-name: Babylon
    criteria: 'Cultural: (iii), (vi)'
    designated: 2019 (43rd session)
    reference-no: '278'
    region: Arab States
```

The header grouping is what makes this good rather than merely flat: without
it, `region: Mesopotamia` and the World Heritage listing's
`region: Arab States` collide on one key. Nesting resolves the collision
*and* records what each region means. Values are taken as rendered text with
`<sup class="mw-ref">` citations stripped; a value that is a list becomes a
YAML sequence; a value that parses cleanly as a number or an ISO date is
emitted as one (`--infobox-types=raw` turns that off, for anyone who wants
strings).

The rest of the record:

- `sections:` — the outline, from `<section data-mw-section-id>`:
  `{level, id, title}`. Babylon has 28, `Names` through `External links`.
- `images:` — every `<figure typeof="mw:File/Thumb">`: `{file, src, width,
  height, caption}`, caption rendered to plain text. Babylon has 26.
- `references:` — the `<ol class="mw-references">` entries, each with its
  rendered text and any external URL, keyed by the `id` the body's `<sup>`s
  point at. This is what lets the body carry real MDY footnotes rather than
  dangling numbers.
- `coordinates:` — `{lat: 32.5425, lon: 44.42111111}` from the summary,
  which is more precise and less fragile than digging the `geo` span out.
- `source:` — see [attribution](#attribution-is-a-requirement-not-a-nicety).
- `categories:`, `langlinks:`, `wikidata:` — opt-in.

**Wikidata** is worth the flag but not the default. The claims are typed
where the infobox is text — `P571` inception is
`-1894-00-00T00:00:00Z` with `precision: 9` (year), against the infobox's
`c. 2200 BC` — but they arrive as opaque ids (`P31 → Q133442`) and turning
them into `instance-of: ancient city` needs a second round trip through
`wbgetentities&props=labels` in batches of 50. Two extra requests, ~90
claims for Babylon, and a much better record. `--wikidata` it is.

### 4. Clean

The Parsoid tree is mostly not article content. The first `<p>` of Babylon's
lead section contains no prose at all — it is a `mw-empty-elt` holding a
protection-template `<meta>` and a category `<link>`. The cleaner is a
declarative list of drops and unwraps:

| Drop | Because |
| --- | --- |
| `<style>`, `<link>`, `<meta>` | template CSS and category links, inline throughout |
| `.mw-empty-elt`, `.mw-editsection` | chrome |
| `.hatnote`, `.shortdescription`, `.navbox`, `.metadata`, `.mbox`, `.sistersitebox` | navigation and banners |
| `table.infobox`, `.infobox-*` | already harvested in step 3 |
| `.reflist`, `.refbegin`, `#coordinates` | already harvested in step 3 |
| Sections `See also`/`Notes`/`References`/`Further reading`/`External links` | data now, not prose (`--keep-sections` overrides) |

| Unwrap | Because |
| --- | --- |
| `<span typeof="mw:Transclusion">`, `<span about="#mwt…">` | pure Parsoid bookkeeping around real content |
| `<span>`/`<div>` with no class, or class-only-presentational | would serialise to an MDY element for nothing |
| `<a href="./File:…">` around an `<img>` | the figure handler owns the image |

Then two rewrites. Internal links `href="./Third_Dynasty_of_Ur"` become
either `[[ label | /wiki/Third_Dynasty_of_Ur ]]` or absolute
`https://en.wikipedia.org/wiki/…`, per `--links`; a third mode, `--links=wiki`,
emits bare `[[ label ]]` so the document links into *your* vault and
`res.data.links` (language rule 9) records every one of them — the mode that
makes a Wikipedia import behave like a page you wrote. And each
`<sup class="mw-ref">` becomes an MDY footnote reference against the
`references:` record, or is dropped under `--no-refs`.

### 5. Serialise

`toMdy(tree)` — the reusable half. The mapping is direct, because MDY was
designed against the same element set:

| hast | MDY |
| --- | --- |
| `h1`…`h6` | `=` … `======` (rule 1) |
| `p` | paragraph, blank line between (rule 3) |
| `strong`/`b`, `em`/`i`, `u`, `del`/`s`, `mark`, `sup`, `sub`, `code` | `!!`, `//`, `__`, `~~`, `??`, `^^`, `,,`, `` ` `` (rule 8) |
| `ul`/`ol`/`li` | `-` / `1.`, nested by indentation (rule 6) |
| `table` | GFM pipe table, `<caption>` as the single-cell line above it (rule 7) |
| `pre > code` | fence, language from `class="language-…"` (rule 4) |
| `a` | `[[ label \| href ]]`, or the bare URL when they match (rule 9) |
| `blockquote`, `figure`, and anything else | element opener + indented body (rule 5) |
| `hr` | `***` — never `---`, which separates documents (rule 11) |

Running that over Babylon's `Names` section produces, again verbatim from
the probe:

```mdy
== Names

The spelling //Babylon// is the Latin representation of [[ Koine Greek | /wiki/Koine_Greek ]]
//Babylṓn// (Βαβυλών), derived from the native [[ Akkadian | /wiki/Akkadian_language ]]:
𒆍𒀭𒊏𒆠, romanized: //Bābilim//, [[ lit. | /wiki/Literal_translation ]] 'gate of the
[[ god(s) | /wiki/El_(deity) ]]'. The [[ cuneiform | /wiki/Cuneiform ]] spelling is
//KÁ.DIG̃IR.RA^^KI^^//, corresponding to the Sumerian phrase //Kan dig̃irak//.
```

#### Escaping is the whole job

Everything above is a table lookup. The part that is actually hard is that
MDY's inline markers are *toggles* (rule 8), so any literal `!!`, `//`,
`__`, `~~`, `??`, `^^`, `,,` or backtick in Wikipedia's text will open a
span that stays open to the end of the block. Wikipedia is full of them:
`~~` in mathematics articles, `^^` in notation, `//` in file paths and URL
examples, `__` in code identifiers. Line-initial characters are worse,
because they change the *block*: a paragraph that happens to begin `= ` is
a heading, one beginning `- ` is a list, `---` is a document separator,
`%` is script, `+++` is front matter, `|` starts a table row.

So `src/escape.js` exists on its own, with its own test file, and holds:

- the inline table, escaped with `\` (rule 8's escape), skipped inside
  raw `` `` `` spans
- the line-start table, escaped at column 0 of every emitted line — and
  re-checked after wrapping, since wrapping *creates* new line starts
- `[[`, `{{` and `\` itself
- one property test: for random text, `fromMdy(escapeAll(text))` yields a
  single paragraph whose text is exactly the input

The round-trip test (`toMdy(fromMdy(x))` re-parses to the same tree) runs
over all 36 `.mdy` files in the repo's `examples/` and `test/`, which is a
much broader net than fixtures written for this package alone.

## Attribution is a requirement, not a nicety

Wikipedia text is CC BY-SA 4.0. A tool that copies an article into a file
you might publish has to carry the attribution with it, so `source:` is
always written and never behind a flag:

```yaml
source:
  site: Wikipedia
  lang: en
  title: Babylon
  url: https://en.wikipedia.org/wiki/Babylon
  page-id: 20609622
  revision: 1369395047
  modified: 2026-08-14T18:33:29Z
  retrieved: 2026-08-29
  license: CC BY-SA 4.0
  license-url: https://creativecommons.org/licenses/by-sa/4.0/
  attribution: >-
    This document contains text from the Wikipedia article "Babylon"
    (revision 1369395047), by Wikipedia contributors, used under CC BY-SA 4.0.
```

Pinning the revision is what makes the citation checkable and re-fetching
reproducible. A layout can render `res.data.source.attribution` into a
footer in one line, which is the whole point of putting it in the data
rather than in a comment.

## CLI

```sh
mdy-wikipedia Babylon > babylon.mdy
mdy-wikipedia https://en.wikipedia.org/wiki/Babylon --out babylon.mdy --wikidata
mdy-wikipedia fr:Babylone --lang-links --out docs/babylone.mdy
mdy-wikipedia Babylon --data-only          # front matter only, no prose
mdy-wikipedia Babylon --sections=lead      # just the lead section
```

| Flag | |
| --- | --- |
| `--out <path>` | write a file (default: stdout) |
| `--lang <code>` | wiki language (default `en`, or the prefix/URL's) |
| `--wikidata` | resolve and include Wikidata claims |
| `--categories`, `--lang-links` | include those records |
| `--links=url\|path\|wiki` | how internal links are written (default `url`) |
| `--no-refs` | drop citations instead of making footnotes |
| `--sections=all\|lead\|<id>,…`, `--keep-sections` | what prose to include |
| `--data-only` | front matter only |
| `--cache <dir>`, `--no-cache`, `--refresh` | HTTP cache |
| `--json` | dump the extracted record instead of a document, for debugging |

And a library entry point, since the CLI should be a thin skin over it:

```js
import {wikipediaToMdy, toMdy} from '@mdy-docs/mdy-wikipedia'

const source = await wikipediaToMdy('Babylon', {wikidata: true})
```

## Testing

Fixtures are committed, so the whole suite runs offline: `babylon.html`
(508 KB Parsoid), its summary JSON, and its Wikidata entity. `node --test`,
matching every other package.

- `extract.test.js` — the Babylon infobox comes out with the nesting shown
  above; both `region` keys survive; 28 sections; 26 figures; coordinates
- `clean.test.js` — the `mw-empty-elt` lead paragraph is gone; no `<style>`,
  `<meta>` or `<link>` survives; the infobox table is gone from the prose
- `to-mdy.test.js` — element-by-element mapping, and the round trip over
  every existing `.mdy` in the repo
- `escape.test.js` — the property test, plus one case per marker and per
  line-start construct
- `document.test.js` — the end-to-end output *parses*: run the generated
  Babylon document back through mdy-docs and assert the front matter reaches
  `res.data` and the body renders without a warning on the file

That last one is the test that matters. The output of this tool is only
useful if it is a valid mdy document, and the only honest way to know that
is to feed it back to the parser.

## Phases

**Phase 0 — `toMdy`.** The serialiser and the escaper, tested against
hand-built trees and the round trip. No network, no Wikipedia. Exit: every
`.mdy` in `examples/` survives `toMdy(fromMdy(…))`. ✅ — see
[what phase 0 landed](#what-phase-0-landed).

**Phase 1 — fetch + clean + prose.** Babylon converts to a document whose
body is right and whose front matter holds only `source:`. Exit:
`mdy-wikipedia Babylon` renders to HTML that reads like the article. ✅ — see
[what phase 1 landed](#what-phase-1-landed).

**Phase 2 — extraction.** Infobox, sections, images, coordinates,
references-as-footnotes. Exit: the YAML above, and `res.data.infobox.built`
resolves in a template. ✅ — see [what phase 2 landed](#what-phase-2-landed).

**Phase 3 — the optional records.** Wikidata with label resolution,
categories, langlinks, `--links=wiki`. ✅ — see
[what phase 3 landed](#what-phase-3-landed).

**Phase 4 — more than one page.** `mdy-wikipedia --category "Cities in Iraq"`
or a list of titles into a directory, which is the point at which the output
is a *vault* and `$.find` over infobox fields becomes the reason the tool
exists. Rate limiting and cache reuse matter here and nowhere earlier. ✅ — see
[what phase 4 landed](#what-phase-4-landed).

## Open questions

**Does the infobox belong under `infobox:` or at the top level?** ✅ Nested —
the two `region`s settle it; see [phase 2](#what-phase-2-landed).

The reasoning, as it stood before. Nested is
safer — no key of Wikipedia's can collide with `title`, `tags`, `users` or
anything a layout expects — but `res.data.infobox.location` is wordier than
`res.data.location`, and a vault of imported pages would query the shorter
one more happily. Leaning nested, with `--flatten` for people building a
vault of one article type.

**How much of a good citation survives as a footnote?** Babylon's 65
`<cite>` elements carry structured metadata (author, title, year, ISBN,
archive URL) that the rendered text flattens. Extracting them properly means
reading `<cite class="citation">`'s microformat classes, which is a second
extractor's worth of work. Phase 2 renders them as text; a later phase can
make `references:` a list of records instead of strings, and that is a
strictly additive change to the YAML.

**Should `--links=wiki` create the pages it links to?** ✅ Yes, with the cap —
`--follow <depth>` and `--max`; see [phase 4](#what-phase-4-landed). The
reasoning, as it stood before. A vault where
`[[ Marduk ]]` resolves to nothing is half a wiki. A `--follow <depth>` that
imports linked pages too is obvious and dangerous in equal measure — Babylon
links to 1179 places. Phase 4, if at all, with a hard cap and an explicit
allowlist.

**Do tables belong in the prose or the data?** Some Wikipedia tables are
genuinely tabular data (king lists, populations by year) and would be more
useful as a `tables:` record than as pipe tables in the body. The infobox
already proves the pattern works. Deferred: it needs a heuristic for which
tables are data, and getting that wrong is worse than leaving them as prose.

## What phase 0 landed

`toMdy` and `escapeInline`, with 28 tests
([packages/mdy-wikipedia](../packages/mdy-wikipedia/README.md)). The exit
criterion is met and is a little wider than it was written: all **36** `.mdy`
documents in `examples/` *and* `test/` parse, serialise, and re-parse to the
same tree, positions aside.

Two things are worth recording, because both were found by a test rather than
by thinking, and both changed the design.

**The escaper's own escapes can create constructs.** The property test —
`parseInline(escapeInline(text))` is one run of text reading exactly `text`,
over random strings — failed 28 times in 20,000 on the first run. Every failure
was the same shape: escaping the `,,` in `:,,` writes `:\,,`, and `:\` is an
emoticon, so a colon that was innocent a moment ago opened a face. Exactly four
emoticons end in a backslash and nothing else the grammar matches contains one,
so the repair is small and provable; the point is that no amount of reading the
parser would have found it. The property test is now 5,000 random strings per
run, and there is a second belt: the result is parsed and checked, and anything
that does not read back is escaped character by character instead — a form
nothing can match, since every position in it is a backslash.

**"Write it in its own spelling" needs a guard on every construct, not just the
interesting ones.** The round trip over the repo's own documents failed on four
files, and none of the failures were in the parts that looked hard. A
`<p class="hero">` was being written as a bare paragraph, losing the class — a
paragraph is the one block with no spelling of its own, so one carrying
attributes has to be written as an element. An `<hr class="rule">` had the same
bug with the test backwards. An `<em>` written as a rule 5 element at block
level was being wrapped in a `<p>` that was never there. And an `<img>` was
being dropped entirely, because it is phrasing in HTML and MDY has no inline
element syntax to put it in — it now takes its own line, which changes the
shape but keeps the image.

That last one is the general lesson for the phases ahead. MDY cannot say
everything HTML can, and the cases where it cannot are exactly the cases
Wikipedia's markup is full of: `<span>`s around transliterations, `<sup>`
citations mid-sentence, images inside paragraphs. `toMdy` unwraps or relocates
them and puts a message on the file rather than dropping them silently, so
phase 4's cleaner can be judged by how few messages it leaves behind.

## What phase 1 landed

`mdy-wikipedia Babylon` writes a document. 63 tests, all offline: Babylon's
Parsoid HTML is committed as a fixture (gzipped — half a megabyte of machine
output nobody reads in a diff) and the fetch layer takes an injected `fetch`,
so the suite never touches the network.

The exit criterion is met, and the number that says so is the message count.
For the whole of Babylon — 508 KB of HTML, 42,000 characters of prose, 387
links, 23 figures — MDY cannot write **one** thing, a link that never had a
label. The document parses back with no warnings from mdy at all.

### Three defaults changed, all for the same kind of reason

**`--links` defaults to the full URL, not `/wiki/Babylonia`.** mdy tidies a
link to a page of your own by lower casing it (rule 9), which is right for
pages you write and wrong for Wikipedia's: `/wiki/Help:IPA/English` arrives as
`/wiki/help:ipa/english`, which is not a page. `path` is still there for a site
whose pages these really are. This was invisible until the rendered HTML was
read.

**Headings are written as headings, which needs `headingId: false`.** Parsoid
gives every heading Wikipedia's own id (`id="Names"`), and `toMdy` will only
write `==` when the id is the one the parser would produce (`names`). So every
heading in the first run came out as `<h2 id="Names"` — correct by phase 0's
rule, and useless. The importer passes `headingId: false`, which says *the ids
in this tree were not put there by a parser that assigns them*, and the
cleaner takes them off. Wikipedia's anchors are not this document's anchors.

**Inline formatting elements are stripped of their attributes.** Babylon's
transliterations are `<i lang="ar-Latn">`, and an `<i>` with an attribute
cannot be a `//` marker — markers carry nothing — so it would have to be
written in element form, which is a *line*, in the middle of a sentence. The
first run unwrapped 38 of them and lost the italics. Now the attribute goes and
the emphasis stays, which for an importer is the right way round. `<i>` and
`<b>` are renamed to `<em>` and `<strong>` on the way through, since those are
what the markers produce.

### The cleaner is a list, and it is short

Eleven drop rules, four unwrap rules, two rewrites. The distinction that earns
its keep is drop versus unwrap: a navbox is dropped because none of it is the
article, a `<span typeof="mw:Transclusion">` is unwrapped because all of it is.
Every rule counts what it took, which is what turns "is the cleaner any good?"
into a number:

```
removed: citations 161, plain 106, bookkeeping 79, chrome 32, file-links 30,
sections 20, empty 12, banners 10, hatnotes 7, end-matter 5, infobox 1,
legacy-anchors 1, media 1
```

Four articles were used to shake it out, chosen for different shapes: Babylon
(prose and figures), Ada Lovelace (quotations), Python (inline code and
lists), and List of Assyrian kings (a 453-cell table). The last one found two
things worth having. Wikipedia's tables are laid out in HTML 3.2, and `width`
on a `<th>` is rejected by mdy's sanitizer on every single row — 34 warnings —
so presentational attributes are now stripped from table elements. And a `<br>`
inside a cell cannot be written in a pipe table, because a cell is one line of
source; `toMdy` now checks that a cell's content fits on a line before choosing
pipes, and writes the table out as elements when it does not.

### What is knowingly left

- **End matter is named in English.** `See also`, `References`, `External
  links` and the rest are dropped by heading text, so on the French or German
  wiki those sections stay. MediaWiki marks the reference list itself
  (`mw:Extension/references`) and marks nothing else, and a heuristic — "a
  section with no prose paragraphs" — would take a legitimate list-shaped
  section with it. `--sections` names what to keep instead. Worth revisiting in
  phase 4, where whole categories get imported and the section names are
  whatever that wiki uses.
- **An inline `<img>` is dropped inside a link or a marker span**, because
  there is no line to put it on there. Six on the French Babylone, all flag
  icons. Reported, not silent.
- **`lang` and `dir` are lost** on the spans and `<i>`s they sit on. MDY has no
  inline element syntax, so there is nowhere for them to go; the text is the
  article and the annotation is not.

## What phase 2 landed

The infobox comes out exactly as the sample above, key for key — `history.built`
is `c. 2200 BC`, both `region`s survive, `reference-no` is still `'278'`. 83
tests, still all offline.

The exit criterion was written as "`res.data.infobox.built` resolves in a
template", and it is now a test that renders one:

```mdy
- Founded {{ res.data.infobox.history.built }} at {{ res.data.infobox.location }}
- {{ res.data.coordinates.lat }}, {{ res.data.coordinates.lon }}
- {{ res.data.sections.length }} sections; part of {{ res.data.infobox['part-of'] }}
```

```html
<li>Founded c. 2200 BC at Hillah, Babil Governorate, Iraq</li>
<li>32.5425, 44.42111111</li>
<li>19 sections; part of Babylonia</li>
```

### The bug that says why the exit criterion was worth writing that way

Rendering the document as a *template* — rather than parsing it, which is all
phase 1 checked — failed on the whole file. Not on the front matter: on one
citation, which carries the literal text `{{cite web}}` as a CS1 maintenance
note. The serialiser had written it inside a `` `` `` span, which is raw as far
as the markup is concerned, and left it alone.

But **nothing is raw to the script stage**. `{{ … }}` is read before a line of
markup is parsed (rule 12), so a code span containing it is an interpolation,
and one that is not valid JavaScript stops the document compiling. The same
goes for a fence, and for a line inside either that opens with `%`.

Both have a backslash escape that the script stage takes off again, so the fix
is small — but it is a *choice*, because with script off nothing removes those
backslashes and they would show. So `toMdy` escapes `{{` in prose always (the
inline rules take the backslash off there either way), and in raw spans and
fences only when told the document will be compiled. The importer tells it,
because a document whose data cannot be read from a template is a file with a
header rather than a document with data.

### Extraction is reading, and reading is not `textContent`

Three bugs, all of the same kind: the text of an element is not the
concatenation of the text under it.

**Collapse once, at the end.** Collapsing whitespace at every level of the walk
eats the space *between* two elements, so `Part of` slugged to `partof` and
`c. 2200 BC` came out `c.2200 BC` — the abbreviation and the year are separate
elements with a space between them that belongs to neither.

**What a reader cannot see is not part of the value.** Wikipedia puts a
machine-readable microformat beside the written date and hides it with CSS, so
Ada Lovelace's birth read `Augusta Ada Byron(1815-12-10)10 December 1815`.
Anything with `display: none` or `noprint` is skipped now.

**A `<br>` draws a break, not nothing.** `10 December 1815London, England` was
two lines of an infobox with nothing put in place of the line ending.

### What is knowingly left

- **The infobox is read through the English Wikipedia's conventions** —
  `Module:Infobox`'s `infobox-label` / `infobox-data` / `infobox-header`
  classes. The German wiki does not use them, so `de:Babylon` gets prose and no
  infobox. Everything else the extractor reads — figures, citations, the
  outline — comes from Parsoid's own markup and works anywhere. Same shape of
  limit as the English end-matter headings, and worth solving together.
- **A citation is a string, not a record.** Babylon's `<cite class="citation">`
  elements carry author, title, year and ISBN in microformat classes, and the
  note keeps only the rendered text plus any URL. That was already flagged as
  an open question, and it stays open: making `references` a list of records is
  strictly additive to the YAML when it happens.
- **`--flatten` was not built.** The open question about `infobox:` nesting
  versus the top level is answered by the region collision — nested — and the
  shorter spelling can wait for somebody building a vault of one article type.

## What phase 3 landed

`--wikidata`, `--categories` and `--lang-links`. 101 tests, still all offline:
the entity, its labels and the Action API's answer are committed beside the
Parsoid HTML, and `buildDocument` takes all three as given, so the network
stays on one side of the line and the document on the other.

### Wikidata is only worth having if you read it properly

The claims are typed where an infobox is text, which is the whole reason to
fetch them. Three things stand between that and a useful record, and each one
is a way to be quietly wrong rather than obviously broken.

**Rank.** Babylon's inception has two claims: `-1894-00-00T00:00:00Z` at year
precision, and `-2200-00-00T00:00:00Z` at millennium precision. The plan quoted
the first one as the example of Wikidata being better than the infobox. It is
*deprecated* — Wikidata keeps it to record that somebody published it — and the
live answer is `3rd millennium BC`. An importer that ignores rank writes the
superseded answer down beside the current one with nothing to tell them apart.

**Precision.** `-1894-00-00T00:00:00Z` is not the tenth of never. The zeroes are
Wikidata saying it does not know the month, so a time is written to the
precision it claims — `1815-12-10`, `1815-12`, `1815`, `1810s`,
`19th century`, `3rd millennium BC` — and never to more.

**Proportion.** 66 of Babylon's 90 statements are external identifiers, and
mixed in with the rest they bury the two dozen claims anybody came for. They go
under `identifiers`, sorted by *datatype* rather than by a list of property ids
that would need maintaining.

Labels are asked for in the wiki's own language, so `fr:Babylone --wikidata`
keys its claims `nature-de-l-élément` and `coordonnées-géographiques` — which
is what made the slugifier Unicode-aware, and incidentally turned
`encyclop-dia-britannica-online-id` into `encyclopædia-britannica-online-id` on
the English side too.

### The two small ones

`--categories` is one parameter's worth of judgement: `clshow=!hidden` at the
API is the difference between a taxonomy and a maintenance log, since Babylon
is in 53 categories and 35 of them are `All articles with unsourced statements`
and its friends.

`--lang-links` writes a map, not a list. What anybody wants from it is
`res.data.langlinks.fr`, and 115 languages as records is a page of YAML saying
almost nothing.

### The fetch layer grew up

`get` was two hard-coded kinds; it is now a resource descriptor with an
`optional` flag, because everything phase 3 adds is optional in the real sense.
A summary, a category list or a Wikidata entity that will not fetch leaves the
document poorer and still a document — saying so beats failing a whole import
over a record nobody asked for by name. The page's own HTML is the one thing
that is not optional.

### What is knowingly left

- **Qualifiers and references on statements are dropped.** `capital of` carries
  start and end dates on Wikidata, and the record keeps only the value. A
  claim's provenance is a second record's worth of structure, and the plan's
  open question about citations-as-records is the same question.
- **An entity with no label in the wiki's language or in English keeps its
  id.** Three of Babylon's values come out as `Q9253865` and the like. Asking
  for every language to find one would be an order of magnitude more data;
  falling back to the id is at least honest about what it is.
- **The English-conventions limit from phase 2 stands.** Wikidata and the
  Action API are language-neutral and work anywhere; the infobox reader and the
  end-matter headings are still the English Wikipedia's.

## What phase 4 landed

`--out-dir`, `--category`, `--from`, `--follow`, `--max`, `--delay`. 116 tests.
A category import of twenty pages takes thirty seconds, almost all of it the
politeness gap, and the second one takes none.

The exit criterion is a query, and it is a test:

```mdy
% const settlements = await $.find({ 'infobox.type': 'Settlement' })
% const iraq = await $.find({ 'infobox.location': { $regex: 'Iraq' } })
{{ settlements.length }} settlements, {{ iraq.length }} in Iraq
```

over a directory of imported articles, with a real regex over a nested infobox
field. That is the thing the four phases were for: one converted article is a
converted article, and two hundred of them are a set that answers questions
about Mesopotamian settlements.

### The naming rule is the cross-linking rule

`--out-dir` writes `third-dynasty-of-ur.mdy`, and `--links wiki` writes a link
to that page as `[[ Third Dynasty of Ur ]]`, which mdy resolves to
`third-dynasty-of-ur`. Those are the same slugifier on purpose, so a vault
cross-links itself with no index and no rewriting pass: of the twenty documents
in the Assyrian-cities import, eleven are linked to by the others, by name, and
every one of those links lands.

### The cap is on what is written, not on what is found

The first version capped discovery, which quietly made the cap useless: the
queue never held leftovers, so the run could not say what it had skipped.
Capping only what is *written* and letting the queue fill past it is what makes
this line possible, and this line is the whole value of the flag:

```
stopped at --max 5; 288 more were queued
```

288 is the number that says whether 5 was the right cap. Nothing queued is ever
fetched, so the queue costs a few hundred strings and buys the report.

### Two pages of the follow found two real gaps

`--follow 1` from Babylon reaches Mesopotamia and Akkadian language, and both
reported dozens of things MDY could not write. Neither was a limit of MDY.

**Formulas were being shredded.** Parsoid renders `<math>` to MathML — 28
elements for one line of Mesopotamia — and unwrapping it leaves
`1 + 24 60 + 51 60 2` where a formula was. Parsoid also keeps the original TeX
in `data-mw`, so a formula is now a code span holding exactly what somebody
typed. 13 messages became 0.

**Nested emphasis was being reported rather than flattened.** Akkadian language
has 32 `<i>` inside `<i>`. Markers toggle, so the inner one cannot be written —
but it also says nothing, since the emphasis is already on. Flattening it in
the cleaner is lossless and silent; reporting it 32 times was noise that hid
whatever else that page might have had to say. 32 messages became 0.

That is the pattern worth keeping: a message is a claim that something was
lost, and a message that fires thirty times for something that was not lost
makes the honest ones unreadable.

### What is knowingly left

- **No concurrency.** Serial, with a 100ms gap. Wikimedia asks for it, and the
  cache means the only slow run is the first one. There is no speed here worth
  being rude for.
- **`--follow` follows every link.** The plan wondered about an allowlist. The
  cap turned out to be the control that matters — it is the one you can reason
  about — and a filter would need a vocabulary (namespace? category? regex?)
  that nothing has yet asked for.
- **The English-conventions limit is unchanged.** A category import runs on one
  wiki at a time, so it inherits whatever that wiki's section names and infobox
  markup are; on the English wiki everything works, and elsewhere the infobox
  and the end matter are still the two things read through English conventions.
