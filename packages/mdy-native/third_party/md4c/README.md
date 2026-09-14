# md4c

Martin Mitáš's CommonMark parser in C, vendored rather than depended on: two
source files, no build system, no platform binaries to prebuild — the same
reason stb is here as headers and lamassu and nisaba as source.

    src/md4c.c, md4c.h    the parser: callbacks, MD_DIALECT_GITHUB
    src/entity.c, entity.h the HTML5 entity table, which md4c hands over
                           verbatim and src/parse/markdown.c resolves
    test/*.txt             the CommonMark spec and md4c's own extension specs,
                           which test/build-corpus.mjs turns into the
                           corpus check-markdown runs over

Vendored from **https://github.com/mdy-docs/md4c**, which is this project's
fork of `mity/md4c`, pinned at the commit in `COMMIT`. MIT; the licence is
LICENSE.md, and the spec files carry their own (CC-BY-SA 4.0) in
test/LICENSE.md. Nothing else of the upstream tree — the CMake build, md2html,
the fuzzers — is used here.

## The fork, and what is in it

There are no local patches. Anything this project needs from md4c is a COMMIT
in the fork, so `COMMIT` names a tree that is exactly what is here and a
re-pin cannot silently drop a fix. Anything that can be worked around from OUR
side still is — B47's dropped allocation failure is heard through `debug_log`
in `src/parse/markdown.c` rather than changed here — so what reaches the fork
is the cases where the information is destroyed inside the parser and nothing
outside it can see what happened.

**The standard a change has to meet.** md4c's behaviour is the default. A
commit goes in only where md4c is clearly not compliant with a specification
it follows — CommonMark, GFM, or md4c's own documented rules — and it comes
with an example in `test/` that fails without it, because that is what makes
it worth sending upstream. Where md4c has simply CHOSEN something different,
that choice stands and the divergence is recorded in
`packages/mdy-native/test/markdown-baseline.txt` instead.

That rule cost something the first time it was applied: a set of changes
aligning md4c's permissive autolinks with GFM's extended autolink was reverted
(8fdafad), because md4c's permissive autolinks are its own flags with rules
`test/spec-permissive-autolinks.txt` documents deliberately and in detail —
"more strict rules apply", "only opening brackets `(`, `{` or `[`", "only
`http://`, `https://` and `ftp://`" — each with an example asserting it. Four
corpus documents went back to differing, which is the right price.

`python3 scripts/run-tests.py` in the fork: **1030 passed, 0 failed**.

Ours so far, each a specification md4c follows rather than a difference of
opinion, and each with a test:

- **`md_resolve_bracket_footnote`: do not eat the `^` until the label
  resolves (B48).** The opener was expanded past the `^` before three checks
  that can each fail; on any of them the bracket pair goes on to be resolved
  as an ordinary link, whose text is taken from `opener->end`. `[^a b]` with a
  matching `[^a b]: n` rendered `a b` where CommonMark says `^a b`.

- **`md_label_hash`: do not hash a label's trailing whitespace (B50).**
  `md_label_cmp` treats the end of a label as whitespace, so `[x ]` and `[x]`
  are equal to it; the hash did not, so they landed in different buckets and
  the comparison was never reached. A reference written `[x ]` found no
  definition at all.

- **Strikethrough: use CommonMark's flanking rules for `~`.** md4c's own
  documentation says a run "cannot open ... if followed with a whitespace" and
  "cannot close ... if preceded with a whitespace", which is flanking; the code
  additionally demanded whitespace or punctuation BEFORE an opener, so an
  intra-word run was no delimiter at all. `H~2~O` came out literal.

- **Tables: the delimiter row must match the header's cell count.** GFM says
  so in as many words, and gives the example; md4c recognised a table anyway.

- **`<video>` out of the type 6 HTML block list.** `test/spec-addendum.txt`
  documents it as a deliberate divergence from CommonMark. It is a divergence
  in DEFAULT behaviour with no flag to turn it off, which is the one kind this
  fork does not keep.

The first two were also verified inert before they were committed: every
document in `make corpus-specs` through a tree dump with and without the
change, and zero differences beyond the case being fixed.

All of them are worth sending upstream.

It is the markdown front end: `.md` documents arrive as hast through it the
way `.mdy` ones do through the parser, and `make check-markdown` measures how
far its tree agrees with remark's. See docs/parser.md.
