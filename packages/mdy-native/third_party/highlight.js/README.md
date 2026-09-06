# highlight.js, in lamassu

A fork of highlight.js and lowlight's emitter that runs in lamassu's subset of
JavaScript, so the native engine can colour fenced code exactly as mdy-docs
does — with highlight.js's own grammars, inside the JavaScript engine it
already embeds, rather than a second implementation of 37 languages in C.

    core.js            highlight.js/lib/core.js, hand-ported (see its header)
    lowlight.js        lowlight's hast emitter and createLowlight, the same way
    entry.js           what the engine calls: highlightCode(value, language)
    languages/         the 37 grammars of lowlight's `common` set, vendored
    aliases.json       what each grammar's aliases are — generated
    keyword-scopes.json  which scope wins a word listed twice — generated
    samples/           one file per grammar, for the check
    sync.mjs           vendor the grammars and regenerate the tables
    build.mjs          one script from all of it: build/highlight.lamassu.js
    check.mjs          the fork against lowlight, over real files, in both engines
    VERSION            the upstream versions this tracks

```sh
make highlight         # build/highlight.lamassu.js
make check-highlight   # what the numbers below are
node third_party/highlight.js/sync.mjs   # after upgrading highlight.js or lowlight
```

## What it is held to

`check.mjs` runs three highlighters over every file in this repository whose
extension names a grammar, plus a sample per grammar for the ones the tree
has none of, and compares the trees as canonical JSON:

```
  reference      lowlight from node_modules, under node — what mdy-docs does
  fork/node      build/highlight.lamassu.js, under node
  fork/lamassu   the same script, under lamassu's CLI

  257/257 trees from the fork under node are the reference's
  257/257 trees from the fork under lamassu are the fork's under node
```

Two comparisons because a difference has two possible homes — the port, or
the engine — and each comparison isolates one. Every rule below was found by
this harness, not by reading.

## What changed, and why

**The subset.** lamassu has no classes, getters, `for…in`, `Symbol`,
`Object.create`, `Function.prototype.bind`/`call`/`apply`,
`Array.prototype.splice`, `Object.getOwnPropertyNames`, null-prototype
objects, or `console`. Each has a stand-in in core.js, marked `lamassu:` at
the site. Keyword tables and the language registry are Maps rather than
objects, because upstream used null-prototype objects for them so that a
word like `constructor` cannot find Object.prototype, and a Map is the same
guarantee.

**One regex per rule, not one alternation per mode.** Upstream joins every
rule of a mode into a single `(a)|(b)|(c)` regex and scans with that. baru-re
compiles at most 256 character classes into one pattern, and swift's mode
alternation alone exceeds it. The fork keeps each rule's regex and asks each
for its next match, taking the earliest, ties to the earlier rule — which is
what the alternation computes. It stays linear because the answer is
memoised: a match is a fact about the string, not about where the scan
started, so the leftmost match at or after position f is the leftmost at or
after any later f' up to it. The memo is invalidated when the scan passes it
or starts again before it; the second case bit once, because matchers belong
to compiled modes and outlive a highlight call.

**Regexes are shared and grammars are lazy.** A compiled pattern costs the
engine 21 KB and the VM caps how many are alive (`JS_REGEXP_MAX_LIVE`, raised
from a stale 64 to 4096 for this). So one RegExp serves every mode and
language with the same pattern and flags — safe because every user sets
`lastIndex` before `exec` — and a grammar's definition runs on first use
rather than at registration, since running one evaluates every regex literal
in it. Aliases come from `aliases.json` so `js` resolves before its grammar
has run.

**Keyword-scope winners are a table.** When a grammar lists a word in two
scopes of one `keywords` object — `true` as keyword and as literal — upstream's
last-in-source-order wins. lamassu's `Object.keys` is hash order, a documented
deviation, so `keyword-scopes.json` records the winner for each of the 123
such collisions across 8 grammars, and the fork applies it only where an
object really holds the word twice.

**Four grammar lines are rewritten on the way in**, asserted by `sync.mjs` so
an upstream change to any of them is noticed: `var` to `const` in java and
kotlin, two `splice` calls in swift and typescript to what they meant, and one
`/\1/` literal in perl to the string it was only ever read as (V8 parses a
group-less backreference; baru-re does not).

## Upgrading

Bump highlight.js or lowlight in mdy-docs, run `sync.mjs`, run
`check-highlight`. The grammars and both tables regenerate; core.js and
lowlight.js are hand-ported, so an upstream change to either is a diff to read
against this fork. `sync.mjs` fails loudly if a rewrite no longer applies or a
keyword collision resolves two ways in one grammar.

## Where it stops

The DOM half of highlight.js — `highlightElement`, `highlightAll`, plugins —
is not here; there is no document to walk. Auto-detection (`highlightAuto`)
is, because markdown's fences use it, but a fence names its language in
mdy-docs and that is the path the engine takes. `console` output from a
grammar is swallowed: a grammar that fails to register becomes plain text,
exactly as upstream's safe mode does, and says nothing.
