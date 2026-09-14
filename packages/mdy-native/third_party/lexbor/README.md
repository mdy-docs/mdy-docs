# lexbor

Alexander Borisov's HTML5 engine, vendored rather than depended on: source
only, no build system, the same reason md4c and stb are here.

    source/lexbor/html     the tokenizer and tree construction — the reason
                           this is here at all
    source/lexbor/dom      the node types it builds into
    source/lexbor/core     memory pools, strings, hashes, arrays
    source/lexbor/tag      the tag name table
    source/lexbor/ns       namespaces (HTML, SVG, MathML)
    source/lexbor/ports    one file: malloc, realloc, calloc, free

Pinned at the commit in `COMMIT` (3.1.0). Apache-2.0; the licence is LICENSE.
`make check-parse` runs `test/lexbor.c` against it.

## Why

`.md` documents go through remark's pipeline on the JavaScript side, and its
last stage is `rehype-raw`: the tree goes through an HTML5 parser, which turns
raw HTML into real elements and repairs what the document got wrong. There was
no such stage here, so a `raw` node stayed a `raw` node — see **B49** in
docs/code-review-2026-09.md for what that cost, of which the sharpest is that
an unclosed `<div>` in one document reached the next one on the page.

It is a parser rather than a tag matcher because the rules that matter are
tree construction's, not the tokenizer's: closing what a document left open,
un-crossing `<b>x</i>`, splitting a paragraph around a block, hoisting a stray
element out of a table. `test/lexbor.c` pins three of those, and they are the
three B49 measured against node by hand.

## What was left behind

Only the modules `html` needs. `css`, `selectors`, `style`, `url`, `utils`,
`engine` and `punycode` are not here; neither are `encoding` and `unicode`,
which are 17 MB of generated tables between them and which the HTML parser
does not reference — this engine reads UTF-8 and nothing else, so there is
nothing to detect or convert.

Of `ports`, one file: `posix/lexbor/core/memory.c`, which is four wrappers
round malloc and has no `#include` of anything platform-specific. Its
`windows_nt` counterpart is byte-identical, so there is no second copy and no
conditional in the Makefile — which keeps the property src/parse has, that the
only files here knowing what an operating system is are src/fsx.c and
src/nis.c.

Upstream's own test suite is not vendored. md4c's is, because
`test/build-corpus.mjs` turns its spec files into the corpus that
`check-markdown` runs over; lexbor's would be testing lexbor, which upstream
already does.

## Local patches

One. `grep -rn "LOCAL PATCH" source/` finds it; see third_party/md4c/README.md
for when patching a pinned dependency is the right answer and when it is not.

- **`in_body.c`, an empty text token (B53).** A character token with nothing
  in it inserted no text node. lexbor is right about that for anything its own
  tokenizer produces — reaching there with a zero length means the token held
  only NULs — but `src/parse/raw.c` pushes tokens directly, the way
  hast-util-raw pushes them into parse5, and parse5 inserts the node. An empty
  ```` ``` ```` fence is `<pre><code>` holding `text("")` on that side and held
  nothing on this one. The drop now happens only when the token was NOT empty
  to begin with, which is the NUL case and leaves it alone.

## Warnings

Compiled with `-Wno-unused-parameter -Wno-shadow -Wno-sign-compare` and
nothing else relaxed: 138, 44 and 1 of them respectively under the flags
src/parse is built with. The suppressions are on these objects alone, so a new
warning in first-party code still stands out. Vendored source is not edited to
silence a warning.
