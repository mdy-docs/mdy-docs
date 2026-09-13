# The GitHub Flavored Markdown spec

`spec.txt`, vendored: 672 examples of what GFM is, which
`scripts-build-corpus.mjs` turns into the `gfm` group of the corpus
`make check-markdown` runs over.

    version 0.29, 2019-04-06
    https://raw.githubusercontent.com/github/cmark-gfm/master/test/spec.txt

CC-BY-SA 4.0, which the file's own front matter states — the same licence as
the CommonMark spec and md4c's extension specs, which are vendored beside it
at `third_party/md4c/test/` under `third_party/md4c/test/LICENSE.md`.

## Why it is here rather than fetched

It was fetched once and cached in `build/`, which meant the corpus could not
be rebuilt on a machine without a network and could not be rebuilt the same
way twice — `build/` is output, and `make clean` took it. That is the whole of
why `check-markdown` had never run in CI, and why three findings this size
(B45, B46, B49) were measured by the only check that could see them and
reported to nobody.

With this the spec half of the corpus is **904 documents in 23 KB**, built
from files in this tree and byte-identical every time. `make corpus` needs a
network only for the `real` group, which is other people's documents found on
the machine and is not reproducible anywhere — see
`scripts-build-corpus.mjs` for what that group is for.

Nothing of the spec is used as expectations: the examples are INPUT, and what
each should produce is whatever mdy-docs' JavaScript produces for it. The
spec's own HTML column is not read.
