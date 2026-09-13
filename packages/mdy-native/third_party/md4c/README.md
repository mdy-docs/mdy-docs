# md4c

Martin Mitáš's CommonMark parser in C, vendored rather than depended on: two
source files, no build system, no platform binaries to prebuild — the same
reason stb is here as headers and lamassu and nisaba as source.

    src/md4c.c, md4c.h    the parser: callbacks, MD_DIALECT_GITHUB
    src/entity.c, entity.h the HTML5 entity table, which md4c hands over
                           verbatim and src/parse/markdown.c resolves
    test/*.txt             the CommonMark spec and md4c's own extension specs,
                           which scripts-build-corpus.mjs turns into the
                           corpus check-markdown runs over

Pinned at the commit in `COMMIT`. MIT; the licence is LICENSE.md, and the spec
files carry their own (CC-BY-SA 4.0) in test/LICENSE.md. Nothing else of the
upstream tree — the CMake build, md2html, the fuzzers — is used here.

## Local patches

Kept deliberately small, and listed here so that re-pinning does not drop one
silently. Anything that can be worked around from OUR side is — B47's dropped
allocation failure is heard through `debug_log` in `src/parse/markdown.c`
rather than patched here — so this list is the cases where the information is
destroyed inside the parser and nothing outside it can see what happened.

Check a patch before removing it: `grep -n "LOCAL PATCH" src/md4c.c`.

- **`md_resolve_bracket_footnote`, the `^` (B48).** The opener was expanded to
  eat the `^` BEFORE checking that the label has a definition. Both checks
  after it return false, the bracket pair then goes on to be resolved as an
  ordinary link, and an opener already moved past the `^` takes it out of that
  link's text: `[^a b]` with a matching `[^a b]: n` rendered `a b` where
  CommonMark says `^a b`. The mutation moved after the checks. Verified inert:
  it changes the tree of **none** of the 1,773 documents in
  `make corpus`, and `ext-footnotes` stays at 25/26.

- **`md_label_hash`, a trailing space (B50).** The hash of a link label did
  not strip a TRAILING run of whitespace where `md_label_cmp` does — that
  function treats the end of a label as whitespace, so `[x ]` and `[x]` are
  equal to it. The hash is consulted first, so a reference written `[x ]`
  never reached the comparison and found no definition at all: it came out as
  literal text where CommonMark and remark both give a link. The trailing run
  is no longer hashed. Verified inert the same way: **none** of the 1,774
  corpus documents' trees change.

It is the markdown front end: `.md` documents arrive as hast through it the
way `.mdy` ones do through the parser, and `make check-markdown` measures how
far its tree agrees with remark's. See docs/parser.md.
