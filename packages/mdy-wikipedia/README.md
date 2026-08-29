# @mdy-docs/mdy-wikipedia

Import a Wikipedia page as an mdy document: the prose as MDY markup, and
everything the page knows about itself — the infobox, the coordinates, the
section outline, the images, the citations — lifted into `+++` front matter as
YAML, where `res.data` can reach it.

The design is [docs/wikipedia-plan.md](../../docs/wikipedia-plan.md).

> **Phases 0 and 1 of that plan.** A page fetches, cleans, and writes itself as
> a document whose front matter says where it came from. What is not built is
> extraction: the infobox, the section outline, the images and the citations are
> removed rather than turned into data, which is phase 2.

## Use

```sh
mdy-wikipedia Babylon > babylon.mdy
mdy-wikipedia https://en.wikipedia.org/wiki/Babylon --out babylon.mdy
mdy-wikipedia fr:Babylone --links wiki --sections lead --out babylone.mdy
```

```js
import {wikipediaToMdy} from '@mdy-docs/mdy-wikipedia'

const {source, counts} = await wikipediaToMdy('Babylon', {links: 'wiki'})
```

`mdy-wikipedia --help` lists the options. Two are worth knowing about here.

**`--links`** decides how an internal link is written, and the default is the
full URL rather than `/wiki/Babylonia`. That is not the obvious choice and it
is the right one: mdy tidies a link to a page of your own by lower casing it
(language rule 9), which is exactly right for pages you write and wrong for
Wikipedia's, where `/wiki/Help:IPA/English` would arrive as
`/wiki/help:ipa/english` and point at nothing. `--links path` is for a site
whose pages these really are, and `--links wiki` writes `[[ Babylonia ]]`, which
mdy records on `res.data.links` as it parses — the mode that makes a directory
of imports behave like a vault.

**Everything left out is reported**, on stderr, counted by rule:

```
removed: citations 161, plain 106, bookkeeping 79, chrome 32, file-links 30,
sections 20, empty 12, banners 10, hatnotes 7, end-matter 5, infobox 1,
legacy-anchors 1, media 1
  1× A link with no label has no spelling, dropping it
```

Those two lines are the measure of the thing. The first says what of Wikipedia's
half a megabyte was not the article; the second says what of the article MDY
could not write, and for the whole of Babylon it is one link that never had a
label.

## Attribution

Wikipedia's text is CC BY-SA 4.0, so `source` is written into every document
whatever the options say — it is a licence term, not a setting:

```yaml
source:
  site: Wikipedia
  lang: en
  title: Babylon
  url: https://en.wikipedia.org/wiki/Babylon
  page-id: 20609622
  revision: '1369395047'
  modified: 2026-08-14T18:33:29Z
  retrieved: 2026-08-29
  license: CC BY-SA 4.0
  license-url: https://creativecommons.org/licenses/by-sa/4.0/
  attribution: This document contains text from the Wikipedia article "Babylon"
    (revision 1369395047), by Wikipedia contributors, used under CC BY-SA 4.0.
```

Pinning the revision is what makes the citation checkable and re-fetching
reproducible. A layout renders `res.data.source.attribution` into a footer in
one line, which is the whole point of putting it in the data rather than in a
comment.

## What the cleaner does

Most of a Wikipedia page is not the article, so [`clean.js`](src/clean.js) is a
list rather than a program: what to drop, what to unwrap, what to rewrite.
Reading the list should be enough to know what comes out.

The distinction that matters is **drop** versus **unwrap**. Dropping takes the
element and its content; unwrapping takes the element and keeps the content. A
navbox is dropped because none of it is the article. A
`<span typeof="mw:Transclusion">` is unwrapped because all of it is — the span
is Parsoid's bookkeeping around real prose. Getting these the wrong way round is
how an importer silently loses paragraphs, so each rule says which it is and the
tests count what each one took.

One known limit: the sections dropped as end matter — See also, Notes,
References, Further reading, External links — are named in English, so on
another wiki they stay. `--sections` names what to keep instead.

## `toMdy` — hast → MDY

mdy has a front end and no back end: `fromMdy` reads MDY into hast, and nothing
wrote it back out. `toMdy` is that inverse, and it is the general HTML → MDY
importer rather than anything Wikipedia knows about — the Wikipedia parts of
this package will hand it a cleaned tree and it will write a document.

```js
import {fromMdy} from 'mdy-docs/parse'
import {toMdy} from '@mdy-docs/mdy-wikipedia/to-mdy'

toMdy(fromMdy('== Names\n\nThe spelling //Babylon// is Latin.'))
// → '== Names\n\nThe spelling //Babylon// is Latin.\n'
```

It takes the same options the document will be parsed with — a marker table
passed here is the one escaped for — plus `frontmatter` (write `tree.data.matter`
as a `+++` block, on by default), `wrap` (a column to wrap paragraphs at, off by
default), and `file` (a vfile to put messages on).

Two properties shape every decision it makes.

**A construct is written in its own spelling only when that spelling parses back
to it.** A heading gets `==` when the id the parser would give it is the id it
has, and `<h2 id="…"` when it is not. A table gets pipes when its cells hold
nothing a pipe table cannot hold, and `<table` when they do not. A paragraph
carrying a `class` is written as an element, because a paragraph is the one
block with no spelling of its own. That is what makes the round trip a test
rather than a hope:

```
toMdy(fromMdy(source)) parses to the same tree as source
```

which runs over every `.mdy` document in this repository — 36 of them, from
one-liners to the full elements torture test — as part of `npm test`.

**It writes what the grammar can say, and says so when it cannot.** MDY has no
inline element syntax: rule 5 openers are lines, so a `<span class="x">` in the
middle of a sentence has no spelling. Rather than invent one, the span is
unwrapped to its content and a message goes on the file. The same goes for an
`<em>` inside an `<em>` — markers toggle, so the inner one would close the outer
— and for a `` `` `` span holding a double backtick. An `<img>` is phrasing in
HTML but gets its own line here, because an opener is a line; that is a change
of shape, and the only alternative was dropping the image. Nothing is dropped
silently.

## `escapeInline` — text that stays text

The hard half. MDY's inline markers *toggle* (language rule 8), so a stray `//`
in a sentence does not produce a stray `//` in the output: it opens an `<em>`
that stays open to the end of the block. Wikipedia's prose is full of them —
`~~` in mathematics, `^^` in notation, `//` in file paths, `__` in identifiers.

```js
import {escapeInline} from '@mdy-docs/mdy-wikipedia/escape'

escapeInline('the // in a path')  // → 'the \\// in a path'
escapeInline('///')               // → '\\/\\//'
```

It finds the positions to escape by *asking the parser* — `matchEmoji`,
`findLinks`, `parseWikiLink`, `matchReference` and the rest are the same
functions `parseInline` calls — so it cannot drift away from the grammar it is
escaping, and a construct added to the parser is one it already knows about.

There is one way an escape can make things worse, and it is not obvious: a
backslash is itself a character the grammar reads. Four emoticons end in one —
`:\`, `:-\`, `=\`, `=-\` — so escaping the `,,` in `:,,` writes `:\,,`, and the
colon that was innocent a moment ago now opens a face. That is walked back.
Everything else the grammar matches is backslash-free, so that is the whole of
the interaction.

The contract is checked rather than argued: the result is parsed, and anything
that does not read back is escaped character by character instead — a form
nothing can match, since every position in it is a backslash. The property

```
parseInline(escapeInline(text)) is one run of text, reading exactly text
```

is asserted over random strings drawn from an alphabet of nothing but the
characters the grammar cares about, which is far denser in constructs than
prose ever is.

## Test

```sh
npm test
```
