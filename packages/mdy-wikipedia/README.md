# @mdy-docs/mdy-wikipedia

Import a Wikipedia page as an mdy document: the prose as MDY markup, and
everything the page knows about itself — the infobox, the coordinates, the
section outline, the images, the citations — lifted into `+++` front matter as
YAML, where `res.data` can reach it.

The design is [docs/wikipedia-plan.md](../../docs/wikipedia-plan.md).

> **Phase 0 of that plan.** What is built is `toMdy`, the serialiser, and
> `escapeInline`, the escaper it rests on. There is no fetching, no extraction
> and no CLI yet — those are phases 1 to 4.

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
