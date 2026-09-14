# What is still open

Four items, all of them structural. None was ever a *finding* — none is a bug,
and none changes what this engine produces — which is exactly why each is still
here: nothing forces them, and each costs more than it obviously returns.

Every line number below was measured against the tree at the commit that wrote
this file, not carried over from anywhere.

---

## 1. `mdy_parse_block` is 524 lines and inlines the entire list grammar

[`src/parse/block.c:1310`](../src/parse/block.c#L1310) — 524 lines, to the
closing brace at 1833.

The list grammar is not *called* from here, it is *written* here: continuation
lines, loose against tight, the marker rules, and the nesting recursion, all in
one function beside every other block construct. Lifting the list out is the
obvious shape, and the reason not to is that a block parser's constructs are
mutually recursive by nature — a list item holds blocks, which hold lists — so
the cut has to be made somewhere that does not turn one function into two that
call each other in both directions.

**What makes it worth opening**: a change to how lists parse. That is where the
length is actually felt, and it is the only time the cost of the cut is being
paid anyway.

**What would check it**: `make check-parse` over the block corpus, and
`make check-markdown` at 893/914 with its 21-line baseline unmoved.

---

## 2. `open_dir_inner` is 423 lines

[`src/engine_walk.c:686`](../src/engine_walk.c#L686) — 423 lines, to 1108.

It walks the directory, reads every file, decides what kind each is, builds a
`.md` file's synthetic front matter, parses a `.yaml` file's own mapping, builds
each file's identity, stages one big source buffer, splits it, and hands the
result to `open_documents`. That is seven jobs with one set of locals and one
`return -1` per failure — twenty-odd of them, each freeing a slightly different
subset of six allocations.

This function produced B1, B2 and B8, which is three of the highest-severity
findings this engine has had, and all three were ownership or ordering mistakes
that its length is what hid.

Two of the seven jobs have already come out of it, and the change got simpler
each time: identity is values now (`mdy_yaml_builder`, `mdyyaml.h`) rather than
YAML text assembled in place, which deleted two of the writers entirely.

**What makes it worth opening**: the next thing that changes what a walk
*collects*. The staging buffer is the seam — everything before it is per-file
and everything after it is per-document.

**What would check it**: `check-sites` over all six sites, outputs *and* build
logs; `check-golden` on four; `check-alloc`, which sweeps every allocation in a
build one at a time and is the only thing that exercises those twenty error
paths at all.

---

## 3. ~~`resize_in` uses its own failure macro for two of its eight failures~~ — DONE

`RESIZE_FAIL` covers all **seven** of its failures now (eight counted the
macro's own `return false`).

The reason it had covered two turned out to be a real one rather than
carelessness: `$.resize` reports by ANSWERING with its message rather than
throwing, so each exit has to format, release the three strings it borrowed,
hand the text back and return false — *in that order*, because five of the
messages interpolate `path` or `ext` and cannot be formatted after those are
freed. The macro did not free, so those five could not use it and open-coded
four lines each. Freeing inside it is what makes it fit every case.

Only one of the seven messages had a test. All four that a document can reach
do now, byte for byte against what node prints, in `resize_checks`.

## 4. Error reporting has four conventions

- `0/-1` with a caller-supplied error buffer — the engine, `fsx`
- `BJ_*` status codes — `memns`, `nis`
- `NULL` plus a `static` message buffer — `cli`
- `fprintf(stderr)` from inside the library —
  [`engine.c:2554`](../src/engine.c#L2554) and
  [`2569`](../src/engine.c#L2569)

Four is too many. Unifying them touches every error path in the engine, changes
no behaviour, and is checked by nothing but the parity suite — which is the same
trade as items 1 and 2.

**The fourth is not simply a defect, and this is the part worth carrying
forward**, because the obvious fix is wrong. The reasoning was:
`mdy_engine_on_message` exists for exactly this, so a library should not print.
Measured, that is wrong twice:

- `on_message` is registered in **one** place in the whole CLI
  ([`cli.c:1022`](../src/cli.c#L1022)), and that is document mode. The
  comparable messages from the directory walk
  ([`engine_walk.c:913`](../src/engine_walk.c#L913)) only fire under
  `mdy build` and `mdy dev`, neither of which registers it. Routing them
  through the callback would make them vanish exactly where they can happen.
- The text is **parity**. `mdy build` over a `.yaml` holding a sequence prints
  `mdy: list.yaml must be a YAML mapping — list.yaml keeps its raw identity, no
  parsed fields`, and `node bin/mdy.js` prints the same bytes. Going through
  `doc_message` would print `mdy: warning: … (…)` instead — a divergence
  introduced by a tidying change.

So the real change, if it is ever wanted, is to register `on_message` in build
and dev first and decide what each should print. That is a decision about the
CLI's output, not a cleanup of the library. The two highlighter `fprintf`s are
the same shape.

---

## What happened to the review

This file replaces `docs/code-review-2026-09.md`, which is retired. That
document opened 51 findings and every one of them is fixed; the four items above
are what it listed as structural and never filed as findings.

Its own numbering lives on in the code: **`B1` to `B53` in a comment refer to
its findings**, and about thirty-five files carry at least one. Almost all of
those comments say what the finding was as well as naming it — `B24 is a list of
allocations whose result is used without being checked` — so they stand on their
own. The document itself is in git at **`ce0a53f`**:

```sh
git show ce0a53f:packages/mdy-native/docs/code-review-2026-09.md
```

**Read it with care if you do.** Its line-number citations drifted: `verify.py`
checked that a citation *resolved* and that its display text matched its target,
never that the target was still the right line. B3's pointed inside `memo_key`'s
comment, and `broker.c:50`, `block.c:345` and `raw.c:368` land on `r_write`, a
`*/` and a `}`. That is the main reason it is retired rather than kept: a
reference document whose references cannot be trusted is worse than none, and
the work it described is done.
