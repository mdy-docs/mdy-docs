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

It is the markdown front end: `.md` documents arrive as hast through it the
way `.mdy` ones do through the parser, and `make check-markdown` measures how
far its tree agrees with remark's. See docs/parser.md.
