/*
 * Shared internals. Nothing here is public — see mdyast.h.
 */
#ifndef MDYAST_INTERNAL_H
#define MDYAST_INTERNAL_H

#include <stddef.h>
#include <stdint.h>

#include "mdyast.h"

/* ---- the arena ----------------------------------------------------------- */

/*
 * A bump allocator, and the reason the tree has no ownership rules at all: a
 * node, its text, its property names and its property values all live here,
 * and mdy_free drops the whole thing in one call.
 *
 * This is not only tidiness. The JavaScript builds 285k nodes for the
 * reference corpus, each a separate heap object with its own properties
 * object; that allocation traffic is a real share of what the port is trying
 * to remove, and an arena is how a C implementation actually wins rather than
 * reproducing the same cost with different syntax.
 */
typedef struct mdy_block {
    struct mdy_block *next;
    size_t used;
    size_t size;
    char data[];
} mdy_block;

typedef struct {
    mdy_block *head;
    size_t total;
} mdy_arena;

/*
 * A growable byte buffer. See buf.c — four files had the same one.
 *
 * Declare with the capacity the first write should ask for and `ok` set:
 *
 *     mdy_buf b = { .ok = 1, .seed = 8192 };
 *
 * and check `b.ok` before believing `b.s`. Zero-initialising it and setting
 * `ok` is also fine; the seed then defaults.
 */
typedef struct { char *s; size_t len, cap, seed; int ok; } mdy_buf;
void mdy_buf_put(mdy_buf *b, const char *s, size_t n);
void mdy_buf_putc(mdy_buf *b, char c);

/* Report an exhausted allocator and end the process. _Exit rather than exit
 * because the handlers exit runs are themselves allocating code. */
_Noreturn void mdy_oom_exit(void);

/*
 * Arena allocation, which does not return NULL.
 *
 * That was always the CONTRACT -- twenty-six of the forty-two call sites in
 * this library do not check, because a recursive-descent parser has no way to
 * unwind from the middle of a node -- but it was not true, and an exhausted
 * arena returned NULL into all of them. The sixteen that did check were no
 * better off: they returned NULL to a caller that carried on, so the parse
 * finished with nodes silently missing and the document was written out as
 * though that were what it said.
 *
 * So the contract is enforced instead of assumed: a block that cannot be
 * allocated ends the process with one line on stderr. Everything in this
 * library is reached from a parse that has nowhere to put an out-of-memory,
 * and a caller that could do something useful with one does not exist.
 */
void *mdy_alloc(mdy_arena *arena, size_t size);
char *mdy_strdup_n(mdy_arena *arena, const char *s, size_t len);
void mdy_arena_free(mdy_arena *arena);

/* ---- interning ----------------------------------------------------------- */

/*
 * Tag and property names are a closed vocabulary — 32 and 19 respectively
 * across the whole reference corpus — so they are interned to a single
 * pointer each. Comparing tags becomes a pointer compare, and the emitter
 * never copies a name.
 */
typedef struct mdy_interned {
    struct mdy_interned *next;
    size_t len;
    char text[];
} mdy_interned;

typedef struct {
    mdy_interned *buckets[128];
} mdy_intern_table;

const char *mdy_intern(mdy_arena *arena, mdy_intern_table *table, const char *s, size_t len);

/* ---- footnotes ----------------------------------------------------------- */

/*
 * `[[ ^id ]]` references and `[[ ^id ]]: text` definitions.
 *
 * Three rules make this a document-level pass rather than an inline rule, and
 * each was established by asking the JavaScript rather than by reading it:
 *
 *   - A reference with no definition stays literal text. So definitions have
 *     to be collected before any inline parsing runs.
 *   - Numbering follows the order of FIRST REFERENCE, not the order of
 *     definition — `[[ ^b ]]` referenced first is footnote 1 — and the list at
 *     the end is in that order too.
 *   - A definition nothing references is dropped entirely, and a document with
 *     no referenced footnotes gets no section at all.
 */
typedef struct {
    const char *id;         /* interned */
    const char *content;    /* arena-owned, the text after the colon */
    size_t content_len;
    int number;             /* 1-based, assigned at first reference; 0 = unreferenced */
    int refs;               /* how many references have been seen */
} mdy_footnote;

/* The definition for `id`, or NULL. */
mdy_footnote *mdy_footnote_find(mdy_doc *doc, const char *id, size_t len);

/* Record one reference, assigning the footnote's number if this is the first.
 * Returns which reference this is, 1-based — the suffix on its id. */
int mdy_footnote_reference(mdy_doc *doc, mdy_footnote *note);

/* Append the `<section>` of collected footnotes, if any were referenced. */
void mdy_footnote_section(mdy_doc *doc, mdy_node *parent);

/* ---- the document -------------------------------------------------------- */

struct mdy_doc {
    mdy_arena arena;
    mdy_intern_table names;
    mdy_node *root;
    mdy_options options;

    mdy_footnote *notes;
    size_t note_count, note_cap;
    int next_number;
    /*
     * The prefix a footnote's ids are built on. `user-content-` for the first
     * document, `user-content-<n>-` for the nth in a stream — two documents on
     * one page must not both own `#user-content-fn-1`.
     */
    const char *note_prefix;

    /* Every heading id already used, so a repeat gets `-1`, `-2`, … — see the
     * heading rule in block.c. Shared across a stream's documents on purpose:
     * two articles on one page must not both own `#introduction`. */
    const char **heading_ids;
    size_t heading_count, heading_cap;

    /* Warnings, in the order they were raised. */
    mdy_message *messages;
    size_t message_count, message_cap;

    /* One per document, in order — see mdy_frontmatter. */
    mdy_frontmatter *matter;
    size_t matter_count, matter_cap;

    /* Written down while the tree is built — see mdy_reference. */
    mdy_reference *refs;
    size_t ref_count, ref_cap;
    uint32_t ref_document;   /* which document the parser is inside */
    int ref_off;             /* >0 while parsing text that is not a reference's — a wiki label */
};

/* Note a `#tag`, an `@mention` or a link to a page of ours. Names go in as
 * written, in order, and only once each. */
void mdy_collect(mdy_doc *doc, mdy_ref_kind kind, const char *name, size_t len);

/* `linkKind(href) === 'page'` — not a fragment, not somebody else's URL. */
int mdy_link_kind_page(const char *s, size_t len);

/* `href.toLowerCase().replace(/\s+/g, '-')`, for a page of ours. */
size_t mdy_normalize_link(const char *s, size_t len, char *out, size_t cap);



/* ---- building ------------------------------------------------------------ */

/* The tree builders are PUBLIC — anything that takes a tree apart and puts it
 * back needs them, not only the parser. See mdybuild.h. */
#include "mdybuild.h"
void mdy_clear_class(mdy_doc *doc, mdy_node *el);

/* ---- attributes and the schema ------------------------------------------- */

const char *mdy_hast_name(mdy_doc *doc, const char *name, size_t len);

/* ` name="value"`, the way the HTML writer spells it. raw.c uses it to build
 * a start tag for the HTML parser. */
void mdy_html_write_attribute(mdy_buf *b, const mdy_prop *p);

/*
 * rehype-raw: the tree through an HTML5 parser, so a `raw` node becomes real
 * elements and what a document got wrong is repaired. Rebuilds `root` in
 * place. 0, or -1 when the parse could not be made — which is a document that
 * could not be read, NOT a reason to keep the tree that went in. See raw.c.
 * (B49.)
 */
int mdy_raw_reparse(mdy_doc *doc, mdy_node *root);
int mdy_tag_allowed(const char *tag);
int mdy_tag_stripped(const char *tag);
int mdy_attr_allowed(const char *tag, const char *name, size_t len);
int mdy_protocol_allowed(const char *attr, const char *value, size_t len);
int mdy_protocol_allowed_n(const char *attr, size_t attr_len,
                           const char *value, size_t len);

/* ---- Unicode (src/unicode.c) --------------------------------------------- */

/* One character in, one out. `\p{L}` or `\p{N}` — the question
 * defaultResolve asks of every character — and the simple lowercase mapping,
 * which is what String.prototype.toLowerCase uses. Both read baru-re's
 * generated UCD tables rather than approximating them. */
int mdy_is_letter_or_number_cp(uint32_t cp);

/* Unicode case, UTF-8 and the UTF-16 boundary are PUBLIC — an embedder needs
 * the same answers the parser does, and a host that lowercases only ASCII
 * disagrees with JavaScript the moment a document is not in English. */
#include "mdytext.h"

/* Where a bare `[[ label ]]` points — mdy-docs' defaultResolve. Headings use
 * it too, so a heading and a link written from the same text agree; it is NOT
 * `slugify`, which hyphenates what this deletes. */
const char *mdy_resolve_slug(mdy_doc *doc, const char *s, size_t len, size_t *out_len);

/* A heading's id: the slug above, made unique against this document's other
 * headings and recorded. Both front ends call it; see inline.c. (B52.) */
const char *mdy_heading_id(mdy_doc *doc, const char *text, size_t len, size_t *out_len);

/* ---- links (src/linkify.c) ----------------------------------------------- */

/* One autolinked span, as byte offsets into the text. */
typedef struct {
    size_t start, end;
    /* linkify-it's `normalize()` puts `mailto:` in front of a bare email —
     * `match.url` and `match.text` differ for exactly that one case, and the
     * <a> takes the url while its label takes the text. */
    int mailto;
} mdy_link;

/*
 * Every URL in `text`, in order — a port of linkify-it, which is what mdy-docs
 * uses. Returns how many were written. See src/linkify.c for what "port"
 * covers and why it is not a set of heuristics.
 */
size_t mdy_find_links(const char *text, size_t len, mdy_link *out, size_t max);

/* ---- emoji (src/emoji.c) -------------------------------------------------- */

/*
 * An emoji at `p`, or NULL. `at_boundary` says whether this position starts a
 * word — the run began here, whitespace preceded it, or a marker was just
 * consumed — which emoticons require and shortcodes do not.
 */
const char *mdy_match_emoji(const char *p, size_t left, int at_boundary, size_t *consumed);

/* ---- the stages ---------------------------------------------------------- */

/* One line of the source, already measured. The block parser works on these
 * rather than on raw text, because indentation is structural in MDY and every
 * rule needs the width before it needs the content. */
typedef struct {
    const char *text;   /* not NUL terminated — use len */
    size_t len;
    size_t indent;      /* columns of leading space, tabs counted as 2 */
    size_t indent_chars; /* the CHARACTERS that indentation took — a task's column counts these */
    int blank;
    uint32_t number;    /* 1-based line number in the original file */
    /* The whole line's length in UTF-16 units, indentation included — what a
     * position's end column is measured in. Kept from before the indent was
     * stripped, because that is the only point it is still known. */
    uint32_t units;
} mdy_line;

/* An element with no closing tag and no children — the same twenty names the
 * block parser needs to stop at and the writer needs to close. It was this
 * list twice, character for character, with nothing to say if one of them
 * ever gained a name the other did not. */
int mdy_is_void_element(const char *tag);

/* Raise a warning against one source line, with the same span a block element
 * on that line would carry. `fmt` is printf's. */
void mdy_warn(mdy_doc *doc, const mdy_line *lines, size_t line, const char *rule,
              const char *fmt, ...);

/* The same with no place — the inline parser has no line to point at, and
 * neither does the JavaScript when it raises these. */
void mdy_warn_inline(mdy_doc *doc, const char *rule, const char *fmt, ...);

/* Give a block element its unist position: from the first of its lines to the
 * end of the last. */
void mdy_set_position(mdy_node *node, const mdy_line *lines, size_t from, size_t to);

/*
 * Parse a run of lines as blocks into `parent`.
 *
 * `base` is the column this run sits at, and it has to be passed rather than
 * inferred: a line further in than `base` is a block of its own and gets a
 * <div>. At the root that is 0 — so a document whose FIRST line is indented
 * still gets a div — while inside an element it is that element's children's
 * own indentation, or every child would get one. Inferring it from the first
 * line gets the root case wrong; inferring it from the parent gets the element
 * case wrong.
 */
/* `nesting` is how many levels of tree `parent` already sits under — see
 * MDY_MAX_DEPTH in mdyast.h. Zero at the root, one more per level added. */
void mdy_parse_block(mdy_doc *doc, mdy_node *parent, const mdy_line *lines, size_t count,
                     size_t base, size_t nesting);

/* Parse inline content into `parent`. The one entry point the block parser
 * uses, so everything textual goes through the same rules. */
void mdy_parse_inline(mdy_doc *doc, mdy_node *parent, const char *text, size_t len);

#endif
