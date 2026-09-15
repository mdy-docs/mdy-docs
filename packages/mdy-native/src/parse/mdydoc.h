/*
 * A source file, split into the documents it holds; a document, split into
 * the data at its top and the body below it.
 *
 * Two text pre-passes that happen before anything else — before the script
 * layer, and long before the parser. mdy-docs does them in src/mdy.js's
 * `parseDocuments`, and an engine has to do them in the same order and by the
 * same rules or every stage after disagrees about what a document even is.
 *
 * `mdy_data_extract` (mdydata.h) is the third of the three, and runs
 * on the body this one hands back.
 */
#ifndef MDYDOC_H
#define MDYDOC_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct { const char *text; size_t len; } mdy_chunk;

typedef struct mdy_documents mdy_documents;

/*
 * Split on a line of exactly `---` — `/^---[ \t]*$/`, trailing whitespace
 * allowed.
 *
 * A chunk holding nothing but whitespace is dropped, so a leading or trailing
 * separator and two in a row all contribute nothing. When NOTHING survives,
 * the source is ONE empty document rather than none: an empty file renders to
 * nothing instead of failing on "no document at index 0".
 */
mdy_documents *mdy_split_documents(const char *text, size_t len);

/*
 * Several sources as ONE list: each is split on its own and the documents are
 * concatenated in order — mdy-docs' `parseDocuments` over an array, which is
 * what a directory of files is.
 *
 * NOT the same as joining the sources with `---` and splitting once. The
 * "when nothing survives, ONE empty document" rule is per source, so a file
 * that is empty or all whitespace is a document here and vanishes there — and
 * a caller that counted one for it, as a walk deriving identity must, then
 * hands every document after it the wrong identity.
 *
 * `per_source`, when it is not NULL, is filled with how many documents each
 * source became — that count being the whole point of asking once instead of
 * twice. Each source's `len` is exact: a zero-length source is empty, not
 * NUL-terminated.
 */
mdy_documents *mdy_split_sources(const mdy_chunk *sources, size_t count,
                                 size_t *per_source);
size_t mdy_documents_count(const mdy_documents *docs);
mdy_chunk mdy_documents_at(const mdy_documents *docs, size_t index);
void mdy_documents_free(mdy_documents *docs);

/*
 * Take the front matter off the top of one document.
 *
 * The block opens on the first line, give or take blank ones, with a line of
 * exactly `+++` (`/^\+\+\+[ \t]*$/`), and it has to close. An opening fence
 * with no partner is left alone — it is more likely prose than a block
 * somebody forgot to finish, and guessing would swallow the rest.
 *
 * The fence is fixed here as it is in mdy.js, which takes the block off
 * before the parser sees the document; the parser's own `frontmatter_fence`
 * option is block.js's setting, for a caller that parses whole documents.
 *
 * Writes the YAML through `matter` (len 0 when there is none) and everything
 * after the closing fence through `body`. Neither is copied: both point into
 * `text`.
 */
void mdy_split_frontmatter(const char *text, size_t len,
                           mdy_chunk *matter, mdy_chunk *body);

#ifdef __cplusplus
}
#endif
#endif
