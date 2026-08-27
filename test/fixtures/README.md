# test/fixtures

## `constructs.js` — what an MDY highlighter has to know

This repo has more than one MDY grammar. `packages/mdy-site` paints the
language by hand (`src/syntax.js`), `packages/editors/vscode-mdy` carries a
TextMate grammar that `mdy-live-preview` also runs through shiki, and
`sublime-mdy` and `obsidian-mdy` carry two more. None of them is generated
from `src/parse/`, which is the only real definition of the language.

So they drifted, in opposite directions and without anyone noticing:

- the TextMate grammar had **no typography at all** — `...`, `--` and `-->`
  reached the editor as prose
- `mdy-site` knew only the **fenced** spelling of front matter
  (`+++` … `+++`), not the split-on-first-`+++` one that every example in
  the repo and the live-preview editor actually uses

Neither is anyone's fault exactly. A language change lands in `src/parse/`
and nothing tells a grammar. This file is the telling: one list of
constructs, each with the substring that must come out highlighted, asserted
by every grammar in its own vocabulary.

It checks that a construct's characters carry **some** paint, never which.
Pinning scope or class names would make this a second grammar to maintain,
and would fail on a rename that broke nothing.

## Adding a construct

Add it here first, watch both conformance tests fail, then paint it:

- `packages/mdy-site/test/conformance.test.js`
- `packages/editors/vscode-mdy/test/conformance.test.js`

## Not covered yet

`sublime-mdy` and `obsidian-mdy` are not asserted against this list. Both
lag further than the two that are — the Sublime syntax has no wiki links and
almost no emoji handling — and running a `.sublime-syntax` outside Sublime
needs an engine this repo does not have. Recorded rather than fixed, so that
"the grammars agree" is not read as covering four of them when it covers
two.
