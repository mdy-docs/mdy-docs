/*
 * Markdown to hast — the contract is in mdymarkdown.h.
 *
 * md4c reports a document as a stream of enter/leave callbacks, which suits
 * building a tree directly: a stack of open nodes, and every callback appends
 * to whatever is on top. No intermediate representation, and no second pass.
 *
 * The shapes here were taken from mdy-docs' own pipeline rather than derived
 * from the spec — the newline padding between block children, `language-x` on
 * a code element, the task-list classes, `start` only when it is not 1. Those
 * are remark-rehype's choices, and a port that reasons them out gets them
 * subtly wrong.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "md4c.h"
#include "entity.h"
#include "mdymarkdown.h"
#include "internal.h"

enum { STACK_MAX = 128 };

/*
 * remark-rehype's `wrap(nodes, loose)`, which is where every `\n` in the tree
 * comes from:
 *
 *   loose   a newline BEFORE the first child, between each pair, and after
 *           the last — what a <ul>, <blockquote>, <table> or a loose <li> gets
 *   tight   a newline between each pair and nowhere else — what the root gets,
 *           and what a tight <li> gets
 *
 * Getting it wrong is a difference on every document rather than an unusual
 * one: the first version padded after every block and was wrong 1389 times
 * out of 1390, all of them a single trailing newline.
 */
typedef struct {
    mdy_node *node;
    int loose;
    int children;     /* how many block children have been appended */
} Frame;

typedef struct {
    mdy_doc *doc;
    Frame stack[STACK_MAX];
    int depth;
    /* Inside a code block or raw HTML, text arrives in pieces and has to be
     * gathered before it becomes one node. */
    char *pending;
    size_t pending_len, pending_cap;
    int gathering;
    /*
     * INLINE TEXT IS COALESCED. md4c reports text in pieces — a run, an
     * entity, a soft break, another run — and the reference produces one text
     * node per run of adjacent text. So text accumulates here and becomes a
     * node only when something else has to be appended.
     */
    char *inline_text;
    size_t inline_len, inline_cap;
    /*
     * The notes, in the order they were first referenced, and how many times
     * each has been. See note_entry for why this is counted here rather than
     * read off md4c's detail structs.
     */
    struct { const char *slug; unsigned refs; } *notes;
    size_t note_count, note_cap;
    /*
     * The footnote definition being built. Its back-references are written on
     * the way OUT, and everything they need is known on the way in;
     * definitions do not nest, so one slot is the whole of it.
     */
    const char *note_slug_now;
    mdy_node *note_item;
    unsigned note_index, note_refs;
    int failed;
} Build;

static void flush_text(Build *b);

static mdy_node *top(Build *b) { return b->depth > 0 ? b->stack[b->depth - 1].node : NULL; }
static Frame *frame(Build *b) { return b->depth > 0 ? &b->stack[b->depth - 1] : NULL; }

static void push(Build *b, mdy_node *n, int loose) {
    flush_text(b);
    if (b->depth >= STACK_MAX) { b->failed = 1; return; }
    b->stack[b->depth].node = n;
    b->stack[b->depth].loose = loose;
    b->stack[b->depth].children = 0;
    b->depth++;
}

static void pop(Build *b) { flush_text(b); if (b->depth > 0) b->depth--; }

static void append(Build *b, mdy_node *n) {
    flush_text(b);
    mdy_node *parent = top(b);
    if (parent && n) mdy_append(parent, n);
}

/* Text, held until it is finished. */
static void text_out(Build *b, const char *s, size_t len) {
    if (!len) return;
    if (b->inline_len + len + 1 > b->inline_cap) {
        size_t cap = b->inline_cap ? b->inline_cap : 256;
        while (cap < b->inline_len + len + 1) cap *= 2;
        char *grown = realloc(b->inline_text, cap);
        if (!grown) { b->failed = 1; return; }
        b->inline_text = grown;
        b->inline_cap = cap;
    }
    memcpy(b->inline_text + b->inline_len, s, len);
    b->inline_len += len;
    b->inline_text[b->inline_len] = '\0';
}

/* …and written out as ONE node when anything else happens. Every append,
 * push and pop goes through this first. */
static void flush_text(Build *b) {
    if (!b->inline_len) return;
    mdy_node *n = mdy_new_text(b->doc, b->inline_text, b->inline_len);
    b->inline_len = 0;
    mdy_node *parent = top(b);
    if (parent && n) mdy_append(parent, n);
}

static void text_node(Build *b, const char *s, size_t len) {
    if (!len) return;
    text_out(b, s, len);
}

static void newline(Build *b) {
    flush_text(b);
    mdy_node *parent = top(b);
    if (!parent) return;
    /*
     * Onto the text already there, if there is any. A hast tree has no two
     * adjacent text nodes — nothing produces them and the serialiser would
     * not tell them apart — so `- hi\n  > q` has to give t("hi\n") and not
     * t("hi") t("\n"). It only arises where inline content is followed by a
     * block, which is a tight list item and nowhere else. (B44.)
     */
    if (parent->last && parent->last->type == MDY_TEXT && parent->last->text) {
        size_t n = strlen(parent->last->text);
        char *joined = mdy_alloc(&b->doc->arena, n + 2);
        memcpy(joined, parent->last->text, n);
        joined[n] = '\n';
        joined[n + 1] = '\0';
        parent->last->text = joined;
        return;
    }
    mdy_append(parent, mdy_new_text(b->doc, "\n", 1));
}

/* Before a BLOCK child goes in: a newline between siblings, and one before
 * the first when the parent is loose. */
static void before_block(Build *b) {
    Frame *f = frame(b);
    if (!f) return;
    if (f->children > 0 || f->loose) newline(b);
    f->children++;
}

/* After the last: only a loose parent gets a trailing one, and only when it
 * had something in it. */
static void close_block(Build *b) {
    Frame *f = frame(b);
    if (f && f->loose && f->children > 0) newline(b);
    pop(b);
}

/* ---- gathering verbatim text (code blocks, raw HTML) ---------------------- */

static void gather(Build *b, const char *s, size_t len) {
    if (b->pending_len + len + 1 > b->pending_cap) {
        size_t cap = b->pending_cap ? b->pending_cap : 256;
        while (cap < b->pending_len + len + 1) cap *= 2;
        char *grown = realloc(b->pending, cap);
        if (!grown) { b->failed = 1; return; }
        b->pending = grown;
        b->pending_cap = cap;
    }
    memcpy(b->pending + b->pending_len, s, len);
    b->pending_len += len;
    b->pending[b->pending_len] = '\0';
}

static void flush_gathered(Build *b) {
    if (b->pending_len) text_out(b, b->pending, b->pending_len);
    b->pending_len = 0;
}

/* ---- entities ------------------------------------------------------------- */

/* One codepoint as UTF-8, into `out`; returns how many bytes. */
/* mdytext.h's, since §2's sweep: this library had three copies of the same
 * encoder and one of them is the one the header already declares. */
#define utf8_of(cp, out) mdy_utf8_encode((uint32_t)(cp), (out))

static void put_codepoint(Build *b, unsigned cp) {
    char out[4];
    size_t n = utf8_of(cp, out);
    if (b->gathering) gather(b, out, n);
    else text_node(b, out, n);
}

/*
 * An entity's codepoints, as UTF-8 bytes, or 0 if the table does not have it.
 * The numeric and named halves of `entity()` below, without a Build to write
 * into — which is what an ATTRIBUTE needs.
 */
static size_t entity_utf8(const char *s, size_t len, char out[8]) {
    if (len >= 4 && s[1] == '#') {
        unsigned cp = 0;
        size_t i = 2;
        int hex = (s[2] == 'x' || s[2] == 'X');
        if (hex) i = 3;
        for (; i + 1 < len; i++) {
            char c = s[i];
            int d;
            if (c >= '0' && c <= '9') d = c - '0';
            else if (hex && c >= 'a' && c <= 'f') d = c - 'a' + 10;
            else if (hex && c >= 'A' && c <= 'F') d = c - 'A' + 10;
            else { cp = 0; break; }
            cp = cp * (hex ? 16u : 10u) + (unsigned)d;
        }
        if (cp == 0) cp = 0xFFFD;
        return utf8_of(cp, out);
    }
    const ENTITY *e = entity_lookup(s, len);
    if (!e) return 0;
    size_t n = utf8_of(e->codepoints[0], out);
    if (e->codepoints[1]) n += utf8_of(e->codepoints[1], out + n);
    return n;
}

/*
 * `&#1234;`, `&#x12AB;` and the named ones. md4c ships the HTML5 entity table
 * as entity.c and deliberately does not use it itself — it is encoding
 * agnostic and hands the caller the entity text verbatim — so resolving is
 * this file's job, and the table is right there.
 *
 * An entity that is not in the table is written through as it was typed,
 * which is what CommonMark says to do with `&nope;`.
 */
static void entity(Build *b, const char *s, size_t len) {
    if (len >= 4 && s[1] == '#') {
        unsigned cp = 0;
        size_t i = 2;
        int hex = (s[2] == 'x' || s[2] == 'X');
        if (hex) i = 3;
        for (; i + 1 < len; i++) {
            char c = s[i];
            int d;
            if (c >= '0' && c <= '9') d = c - '0';
            else if (hex && c >= 'a' && c <= 'f') d = c - 'a' + 10;
            else if (hex && c >= 'A' && c <= 'F') d = c - 'A' + 10;
            else { cp = 0; break; }
            cp = cp * (hex ? 16u : 10u) + (unsigned)d;
        }
        if (cp == 0) cp = 0xFFFD;          /* CommonMark: NUL becomes U+FFFD */
        put_codepoint(b, cp);
        return;
    }
    const ENTITY *e = entity_lookup(s, len);
    if (e) {
        put_codepoint(b, e->codepoints[0]);
        if (e->codepoints[1]) put_codepoint(b, e->codepoints[1]);
        return;
    }
    if (b->gathering) gather(b, s, len);
    else text_node(b, s, len);
}

/* ---- attributes ------------------------------------------------------------ */

/*
 * md4c hands an attribute as a run of SUBSTRINGS so entities can be resolved
 * in it, and this took `a->text` whole — so `[x](http://a?b=1&amp;c=2)` kept
 * the literal `&amp;` and the HTML writer escaped it again, giving
 * `href="http://a?b=1&#x26;amp;c=2"` where node has `&#x26;`. The comment here
 * said "for the common case there is exactly one"; a query string is the
 * common case where there is not. (B23.)
 *
 * The substrings are `substr_offsets[i]`..`[i+1]`, ending when the offset
 * reaches `size` (md4c.h states both invariants). An entity the table does not
 * have goes through as it was typed, which is what CommonMark says about
 * `&nope;` and what `entity()` does for text.
 */
/* ---- link destinations ------------------------------------------------------
 *
 * `normalizeUri`, from micromark-util-sanitize-uri, which is what
 * mdast-util-to-hast runs every `href` and `src` through — and only those:
 * a `title` keeps its bytes, and so does the link's text.
 *
 * Two halves, and the second is the one that makes this a port of a specific
 * function rather than "URL-encode the non-ASCII". An already-encoded `%XX`
 * is LEFT ALONE, so `%C3%A9` in the source stays `%C3%A9` instead of becoming
 * `%25C3%25A9`; a `%` that is not followed by two of those is itself encoded,
 * so a bare `?a%` becomes `?a%25`. `XX` there is two ASCII ALPHANUMERICS and
 * not two hex digits, which is micromark's own test (`asciiAlphanumeric`) and
 * means `%zz` is passed through as well. That is not obviously deliberate on
 * their side, but it is what the reference does, and this has to agree with
 * the reference rather than with the RFC.
 */
static int uri_safe(unsigned char c) {
    /* micromark's /[!#$&-;=?-Z_a-z~]/ — everything else ASCII is encoded. */
    return c == '!' || c == '#' || c == '$' ||
           (c >= '&' && c <= ';') || c == '=' ||
           (c >= '?' && c <= 'Z') || c == '_' ||
           (c >= 'a' && c <= 'z') || c == '~';
}

static int uri_alnum(unsigned char c) {
    return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

/*
 * Writes at most 3 bytes per input byte, so `out` needs 3 * len + 1.
 * Returns the length written.
 *
 * The decode-and-re-encode is not a detour: node reads the file as UTF-8 with
 * replacement, so an ill-formed byte has already become U+FFFD by the time
 * normalizeUri sees it and comes out `%EF%BF%BD`. Walking the bytes directly
 * would emit `%80` for that byte instead. mdy_utf8_decode makes the same
 * substitution, one byte at a time, which is the same answer.
 */
static size_t normalize_uri(const char *s, size_t len, char *out) {
    static const char HEX[] = "0123456789ABCDEF";
    size_t w = 0;
    for (size_t i = 0; i < len;) {
        unsigned char c = (unsigned char)s[i];

        if (c == '%' && i + 2 < len &&
            uri_alnum((unsigned char)s[i + 1]) && uri_alnum((unsigned char)s[i + 2])) {
            out[w++] = s[i]; out[w++] = s[i + 1]; out[w++] = s[i + 2];
            i += 3;
            continue;
        }

        if (c < 0x80) {
            if (uri_safe(c)) out[w++] = (char)c;
            else { out[w++] = '%'; out[w++] = HEX[c >> 4]; out[w++] = HEX[c & 15]; }
            i++;
            continue;
        }

        uint32_t cp = 0;
        size_t width = mdy_utf8_decode(s + i, len - i, &cp);
        char enc[4];
        size_t n = utf8_of(cp, enc);
        for (size_t k = 0; k < n; k++) {
            unsigned char b = (unsigned char)enc[k];
            out[w++] = '%'; out[w++] = HEX[b >> 4]; out[w++] = HEX[b & 15];
        }
        i += width ? width : 1;
    }
    return w;
}

/* The finished attribute value, normalized first when it is a destination. */
static void put_attribute(Build *b, mdy_node *el, const char *name,
                          const char *text, size_t len, int uri) {
    if (!uri) { mdy_set_string(b->doc, el, name, text, len); return; }

    char stack[512];
    char *buf = stack;
    char *heap = NULL;
    if (len * 3 + 1 > sizeof stack) {
        heap = malloc(len * 3 + 1);
        if (!heap) { b->failed = 1; return; }
        buf = heap;
    }
    size_t n = normalize_uri(text, len, buf);
    mdy_set_string(b->doc, el, name, buf, n);
    free(heap);
}

static void set_attribute(Build *b, mdy_node *el, const char *name,
                          const MD_ATTRIBUTE *a, int uri) {
    if (!a || !a->text || !a->size) {
        /*
         * An empty DESTINATION is still a destination: `[t](<>)` is a link to
         * the current document, `normalizeUri('')` is `''`, and
         * mdast-util-to-hast sets it — so node writes `href=""` where this
         * wrote no attribute at all. An empty TITLE is not set, on either
         * side, which is why this depends on `uri` and not on the name. (B42.)
         */
        if (uri) mdy_set_string(b->doc, el, name, "", 0);
        return;
    }

    /* No substrings to speak of: the whole thing, as before. */
    if (!a->substr_offsets || !a->substr_types) {
        put_attribute(b, el, name, a->text, a->size, uri);
        return;
    }

    char stack[512];
    char *buf = stack;
    size_t cap = sizeof stack, len = 0;
    char *heap = NULL;
    if (a->size + 8 > cap) {
        heap = malloc((size_t)a->size + 8);
        if (!heap) { b->failed = 1; return; }
        buf = heap;
        cap = (size_t)a->size + 8;
    }

    for (size_t i = 0; a->substr_offsets[i] < a->size; i++) {
        size_t from = a->substr_offsets[i];
        size_t to = a->substr_offsets[i + 1];
        if (to > a->size) to = a->size;
        const char *piece = a->text + from;
        size_t plen = to - from;

        char enc[8];
        size_t n = 0;
        if (a->substr_types[i] == MD_TEXT_ENTITY) n = entity_utf8(piece, plen, enc);
        else if (a->substr_types[i] == MD_TEXT_NULLCHAR) n = utf8_of(0xFFFD, enc);

        if (n) { if (len + n <= cap) { memcpy(buf + len, enc, n); len += n; } }
        else if (len + plen <= cap) { memcpy(buf + len, piece, plen); len += plen; }
    }

    put_attribute(b, el, name, buf, len, uri);
    free(heap);
}

/* ---- blocks ---------------------------------------------------------------- */

/* ---- footnotes --------------------------------------------------------------
 *
 * md4c has already done the counting. MD_FLAG_FOOTNOTES is part of
 * MD_DIALECT_GITHUB, so `[^label]` arrives as MD_SPAN_FOOTNOTE_REF carrying
 * the number the note was given (`id`, assigned in order of FIRST REFERENCE,
 * which is the order mdast-util-to-hast numbers them in too) and which
 * reference to that note this is (`ref_id`). The definitions arrive at the end
 * of the document inside MD_BLOCK_FOOTNOTE_DEF_SECTION, in the same order, and
 * only the ones something referenced — which is also what the reference does.
 * So four of the five things that have to agree are agreed already; the fifth
 * is the markup, and it is here.
 *
 * The ids are GitHub's, the same ones footnote.c writes for a `.mdy` document.
 * What differs, and why this does not call that, is the back-reference's
 * label: GFM numbers it ("Back to reference 2-3") where mdy's says "Back to
 * content".
 */

/*
 * `normalizeUri(identifier.toLowerCase())`, which is what both the reference
 * and the definition are keyed on. md4c has already collapsed and trimmed the
 * label's whitespace, which is the rest of micromark's normalizeIdentifier.
 *
 * ASCII lowercase, where JavaScript's toLowerCase is Unicode-aware. See the
 * review's B45: md4c pairs a reference with its definition by its own rules,
 * and for a label needing more than ASCII folding the two parsers stop
 * agreeing about that well before they get here.
 */
static const char *note_slug(Build *b, const MD_ATTRIBUTE *label) {
    size_t len = (label && label->text) ? label->size : 0;
    char *lower = mdy_alloc(&b->doc->arena, len + 1);
    for (size_t i = 0; i < len; i++) lower[i] = mdy_lower_ascii(label->text[i]);
    lower[len] = '\0';

    char *out = mdy_alloc(&b->doc->arena, len * 3 + 1);
    size_t n = normalize_uri(lower, len, out);
    out[n] = '\0';
    return out;
}

/*
 * The note's place in the document, made on first sight. Its position is the
 * note's NUMBER, because that is the order of first reference — which is what
 * mdast-util-to-hast's `footnoteOrder` is — and `refs` is how many times it
 * has been named, which is its `footnoteCounts`.
 *
 * Counted here rather than read off md4c's `id` and `ref_id`, because md4c
 * parses a table's cells TWICE and its own counter advances on both passes: a
 * single `[^1]` in a cell arrives carrying ref_id 2, and its definition
 * carrying ref_count 2, so the anchor would get an id nothing points at and
 * the definition would grow a second back-reference to a reference that does
 * not exist. The callback itself fires once, so counting callbacks is right
 * where trusting the numbers on them is not.
 *
 * Keyed on the slug rather than the label, because that is the identity the
 * ids are built from: two labels differing only in case are one note.
 */
static int note_entry(Build *b, const char *slug) {
    for (size_t i = 0; i < b->note_count; i++)
        if (strcmp(b->notes[i].slug, slug) == 0) return (int)i;

    if (b->note_count == b->note_cap) {
        size_t cap = b->note_cap ? b->note_cap * 2 : 8;
        void *grown = realloc(b->notes, cap * sizeof *b->notes);
        if (!grown) { b->failed = 1; return -1; }
        b->notes = grown;
        b->note_cap = cap;
    }
    b->notes[b->note_count].slug = slug;
    b->notes[b->note_count].refs = 0;
    return (int)b->note_count++;
}

/* `user-content-fn-<slug>` or `user-content-fnref-<slug>`, with `-n` on the
 * second and later references, and `lead` for the `#` an href wants. */
static const char *note_id(Build *b, const char *lead, const char *kind,
                           const char *slug, unsigned n) {
    size_t need = strlen(lead) + sizeof "user-content-" + strlen(kind) + strlen(slug) + 24;
    char *out = mdy_alloc(&b->doc->arena, need);
    if (n > 1) snprintf(out, need, "%suser-content-%s%s-%u", lead, kind, slug, n);
    else       snprintf(out, need, "%suser-content-%s%s", lead, kind, slug);
    return out;
}

static int enter_block(MD_BLOCKTYPE type, void *detail, void *ud) {
    Build *b = ud;
    if (b->failed) return -1;

    switch (type) {
        case MD_BLOCK_DOC:
            return 0;

        case MD_BLOCK_FOOTNOTE_DEF_SECTION: {
            before_block(b);
            mdy_node *section = mdy_new_element(b->doc, "section", 7);
            /*
             * An empty STRING, not a bool. `dataFootnotes` leaves
             * mdast-util-to-hast as `true`, but the `.md` pipeline puts the
             * tree through rehype-raw, and a data-* attribute has no schema
             * entry saying it is boolean: it serialises as `data-footnotes=""`
             * and parses back as `""`. A task box's `checked`, which the
             * schema DOES know, survives as `true` — which is why those two
             * lines a few cases below look different from these.
             */
            mdy_set_string(b->doc, section, "dataFootnotes", "", 0);
            mdy_add_class(b->doc, section, "footnotes");
            append(b, section);
            push(b, section, 0);

            /*
             * `h2, "\n", ol, "\n"` — written out rather than wrapped, because
             * it is neither of wrap()'s two shapes: the heading takes no
             * newline before it, as in a tight parent, and the list takes one
             * after it, as in a loose one.
             */
            before_block(b);
            mdy_node *h2 = mdy_new_element(b->doc, "h2", 2);
            mdy_add_class(b->doc, h2, "sr-only");
            mdy_set_string(b->doc, h2, "id", "footnote-label", 14);
            mdy_append(h2, mdy_new_text(b->doc, "Footnotes", 9));
            append(b, h2);

            before_block(b);
            mdy_node *ol = mdy_new_element(b->doc, "ol", 2);
            append(b, ol);
            push(b, ol, 1);
            return 0;
        }

        case MD_BLOCK_FOOTNOTE_DEF: {
            const MD_BLOCK_FOOTNOTE_DEF_DETAIL *d = detail;
            b->note_slug_now = note_slug(b, &d->label);
            int at = note_entry(b, b->note_slug_now);
            if (at < 0) return -1;
            b->note_index = (unsigned)at + 1;
            b->note_refs = b->notes[at].refs;

            before_block(b);
            mdy_node *li = mdy_new_element(b->doc, "li", 2);
            const char *id = note_id(b, "", "fn-", b->note_slug_now, 1);
            mdy_set_string(b->doc, li, "id", id, strlen(id));
            append(b, li);
            push(b, li, 1);

            /*
             * The paragraph is OURS. A definition's content is block content
             * in mdast and md4c reports it as inline text with no paragraph
             * around it, so the one the reference gives every definition is
             * supplied here.
             *
             * Pushed but NOT placed, because a definition with nothing in it
             * gets no paragraph at all — `[^1]:` is `<li>` holding the
             * back-reference and nothing else, since the reference appends
             * them to a tail <p> only when there is one. Whether there is one
             * is not known until the content has been seen, so the newline
             * this item is due goes in now (it is due either way) and the
             * paragraph is placed on the way out if it earned it.
             */
            before_block(b);
            b->note_item = li;
            mdy_node *p = mdy_new_element(b->doc, "p", 1);
            push(b, p, 0);
            return 0;
        }

        case MD_BLOCK_P: {
            before_block(b);
            mdy_node *p = mdy_new_element(b->doc, "p", 1);
            append(b, p);
            push(b, p, 0);
            return 0;
        }

        case MD_BLOCK_H: {
            const MD_BLOCK_H_DETAIL *d = detail;
            before_block(b);
            char tag[3] = { 'h', (char)('0' + d->level), '\0' };
            mdy_node *h = mdy_new_element(b->doc, tag, 2);
            append(b, h);
            push(b, h, 0);
            return 0;
        }

        case MD_BLOCK_QUOTE: {
            before_block(b);
            mdy_node *q = mdy_new_element(b->doc, "blockquote", 10);
            append(b, q);
            push(b, q, 1);
            return 0;
        }

        case MD_BLOCK_UL: {
            before_block(b);
            mdy_node *ul = mdy_new_element(b->doc, "ul", 2);
            append(b, ul);
            push(b, ul, 1);
            return 0;
        }

        case MD_BLOCK_OL: {
            const MD_BLOCK_OL_DETAIL *d = detail;
            before_block(b);
            mdy_node *ol = mdy_new_element(b->doc, "ol", 2);
            /* `<ol>` counts from 1 on its own; only say otherwise when asked. */
            if (d->start != 1) mdy_set_number(b->doc, ol, "start", (double)d->start);
            append(b, ol);
            push(b, ol, 1);
            return 0;
        }

        case MD_BLOCK_LI: {
            const MD_BLOCK_LI_DETAIL *d = detail;
            before_block(b);
            mdy_node *li = mdy_new_element(b->doc, "li", 2);
            if (d->is_task) {
                mdy_add_class(b->doc, li, "task-list-item");
                /* The list itself is marked once its first task item is seen. */
                mdy_node *list = top(b);
                if (list) {
                    int marked = 0;
                    for (mdy_prop *p = list->props; p; p = p->next)
                        if (strcmp(p->name, "className") == 0) marked = 1;
                    if (!marked) mdy_add_class(b->doc, list, "contains-task-list");
                }
            }
            append(b, li);
            /*
             * ALWAYS wrapped, tight or loose. (B44.)
             *
             * The other block parents take `wrap(nodes, loose)`, and a list
             * item does not: mdast-util-to-hast's listItem walks its children
             * and pads each one, skipping the padding only for a PARAGRAPH
             * that is tight — which it also unwraps. In a tight list md4c
             * never reports that paragraph at all and hands the inline
             * content straight over, so the skip is already done here by the
             * shape of the callbacks. What was left was the other half: every
             * child that IS a block still gets its newline before, and a
             * trailing one after the last, whether the item is tight or not.
             *
             * `- > quoted` was the shortest case — [blockquote] here against
             * [\n, blockquote, \n] there — and it is the same for a table, a
             * nested list, a fence and a heading.
             */
            push(b, li, 1);
            if (d->is_task) {
                mdy_node *box = mdy_new_element(b->doc, "input", 5);
                mdy_set_string(b->doc, box, "type", "checkbox", 8);
                if (d->task_mark != ' ') mdy_set_bool(b->doc, box, "checked", 1);
                mdy_set_bool(b->doc, box, "disabled", 1);
                append(b, box);
                /* The space between the box and the text is content: md4c
                 * consumes it with the marker, and the reference keeps it.
                 * It joins the run that follows rather than standing alone. */
                text_out(b, " ", 1);
            }
            return 0;
        }

        case MD_BLOCK_HR: {
            before_block(b);
            append(b, mdy_new_element(b->doc, "hr", 2));
            return 0;
        }

        case MD_BLOCK_CODE: {
            const MD_BLOCK_CODE_DETAIL *d = detail;
            before_block(b);
            mdy_node *pre = mdy_new_element(b->doc, "pre", 3);
            mdy_node *code = mdy_new_element(b->doc, "code", 4);
            if (d->lang.text && d->lang.size) {
                char cls[128];
                size_t n = d->lang.size < sizeof cls - 10 ? d->lang.size : sizeof cls - 10;
                memcpy(cls, "language-", 9);
                memcpy(cls + 9, d->lang.text, n);
                cls[9 + n] = '\0';
                mdy_add_class(b->doc, code, cls);
            }
            append(b, pre);
            push(b, pre, 0);
            append(b, code);
            push(b, code, 0);
            b->gathering = 1;
            return 0;
        }

        case MD_BLOCK_HTML:
            /* Raw HTML arrives as text and stays raw until something parses
             * it — which is what rehype-raw does on the JavaScript side. */
            before_block(b);
            b->gathering = 1;
            return 0;

        case MD_BLOCK_TABLE: {
            before_block(b);
            mdy_node *t = mdy_new_element(b->doc, "table", 5);
            append(b, t);
            push(b, t, 1);
            return 0;
        }
        case MD_BLOCK_THEAD: {
            before_block(b);
            mdy_node *n = mdy_new_element(b->doc, "thead", 5);
            append(b, n); push(b, n, 1);
            return 0;
        }
        case MD_BLOCK_TBODY: {
            before_block(b);
            mdy_node *n = mdy_new_element(b->doc, "tbody", 5);
            append(b, n); push(b, n, 1);
            return 0;
        }
        case MD_BLOCK_TR: {
            before_block(b);
            mdy_node *n = mdy_new_element(b->doc, "tr", 2);
            append(b, n); push(b, n, 1);
            return 0;
        }
        case MD_BLOCK_TH:
        case MD_BLOCK_TD: {
            const MD_BLOCK_TD_DETAIL *d = detail;
            mdy_node *n = mdy_new_element(b->doc, type == MD_BLOCK_TH ? "th" : "td", 2);
            if (d && d->align != MD_ALIGN_DEFAULT) {
                const char *a = d->align == MD_ALIGN_LEFT ? "left"
                              : d->align == MD_ALIGN_CENTER ? "center" : "right";
                mdy_set_string(b->doc, n, "align", a, strlen(a));
            }
            before_block(b);
            append(b, n); push(b, n, 0);
            return 0;
        }

        default:
            /* An extension this front end does not map yet — its content is
             * kept, its wrapper is not. Silently dropping the content would
             * lose text; guessing a tag would invent structure. */
            return 0;
    }
}

/*
 * Foster parenting, which is the HTML parser's rule and not markdown's.
 *
 * remark-rehype's `wrap` pads a <table>, its row groups and its rows with
 * newlines, exactly as it pads a <ul> — and this file reproduces that, which
 * is right as far as it goes. But mdy-docs' `.md` pipeline does not stop
 * there: rehypeRaw re-parses the whole tree through an HTML parser, and an
 * HTML parser may not keep character data inside a table. It FOSTER-PARENTS
 * it: every text node directly inside table/thead/tbody/tfoot/tr is taken
 * out, in document order, and placed immediately before the table.
 *
 * So `| a |` alone came out as `<table>` with eleven newlines inside it here
 * and as eleven newlines followed by `<table>` there — the same bytes in a
 * different order, which is why no byte COUNT ever caught it and why
 * check-html, comparing a serialiser against the same tree, could not.
 *
 * Cells are untouched: a <th> or <td> is where character data belongs.
 */
static int fosterable(const mdy_node *n) {
    if (n->type != MDY_ELEMENT || !n->tag) return 0;
    return strcmp(n->tag, "table") == 0 || strcmp(n->tag, "thead") == 0 ||
           strcmp(n->tag, "tbody") == 0 || strcmp(n->tag, "tfoot") == 0 ||
           strcmp(n->tag, "tr") == 0;
}

/* Collects the text out of `n`'s fosterable subtree into `out`, unlinking it. */
static void foster_collect(mdy_node *n, mdy_buf *out) {
    mdy_node *kept_first = NULL, *kept_last = NULL;
    for (mdy_node *c = n->first, *next; c; c = next) {
        next = c->next;
        c->next = NULL;
        if (c->type == MDY_TEXT) {
            if (c->text) mdy_buf_put(out, c->text, strlen(c->text));
            continue;                      /* unlinked: the arena owns it */
        }
        if (fosterable(c)) foster_collect(c, out);
        if (!kept_first) kept_first = c; else kept_last->next = c;
        kept_last = c;
    }
    n->first = kept_first;
    n->last = kept_last;
}

static void foster_parent_table(Build *b, mdy_node *parent, mdy_node *table) {
    mdy_buf text = { .ok = 1, .seed = 64 };
    foster_collect(table, &text);
    if (!text.ok) { b->failed = 1; free(text.s); return; }
    if (!text.len || !parent) { free(text.s); return; }

    /*
     * Immediately before the table, and merged with the text already there if
     * there is any — an HTML parser produces one run of character data, not
     * two adjacent ones, and a tree with two would serialise the same but
     * compare differently.
     */
    mdy_node *prev = NULL;
    for (mdy_node *c = parent->first; c && c != table; c = c->next) prev = c;
    if (prev && prev->type == MDY_TEXT && prev->text) {
        size_t n = strlen(prev->text);
        char *joined = mdy_alloc(&b->doc->arena, n + text.len + 1);
        memcpy(joined, prev->text, n);
        memcpy(joined + n, text.s, text.len);
        joined[n + text.len] = '\0';
        prev->text = joined;
    } else {
        mdy_node *node = mdy_new_text(b->doc, text.s, text.len);
        if (!node) { b->failed = 1; free(text.s); return; }
        node->next = table;
        if (prev) prev->next = node; else parent->first = node;
    }
    free(text.s);
}

static int leave_block(MD_BLOCKTYPE type, void *detail, void *ud) {
    Build *b = ud;
    (void)detail;
    if (b->failed) return -1;

    switch (type) {
        case MD_BLOCK_DOC:
            return 0;

        case MD_BLOCK_FOOTNOTE_DEF: {
            /*
             * The back-references go INSIDE the definition's last paragraph,
             * after a space — mdast-util-to-hast's footer appends them to a
             * tail <p> rather than after it, and md4c's flat content means
             * that paragraph is the one opened above.
             *
             * Unless there is none. A definition with nothing in it has no
             * tail to append to, so the reference pushes the back-references
             * onto the item itself and the leading space goes with the
             * paragraph it would have followed.
             */
            mdy_node *para = top(b);
            int placed = para && (para->first || b->inline_len > 0);
            if (placed) mdy_append(b->note_item, para);
            else pop(b);      /* the paragraph nothing went into */

            /*
             * A space before EACH, which is two rules on the reference's side
             * that come to the same thing here: the first is appended to the
             * text already there and the rest are text nodes between the
             * anchors. Text is held until something else is appended, so both
             * fall out of one text_out.
             */
            for (unsigned n = 1; n <= b->note_refs; n++) {
                if (placed || n > 1) text_out(b, " ", 1);
                mdy_node *back = mdy_new_element(b->doc, "a", 1);
                const char *href = note_id(b, "#", "fnref-", b->note_slug_now, n);
                mdy_set_string(b->doc, back, "href", href, strlen(href));
                mdy_set_string(b->doc, back, "dataFootnoteBackref", "", 0);

                /* "Back to reference <note>" — and `-n` for the second and
                 * later references to the same note, which is the numbering
                 * mdy's own footnotes do not have. */
                char label[64];
                int ln = (n > 1)
                    ? snprintf(label, sizeof label, "Back to reference %u-%u", b->note_index, n)
                    : snprintf(label, sizeof label, "Back to reference %u", b->note_index);
                if (ln < 0) { b->failed = 1; return -1; }
                mdy_set_string(b->doc, back, "ariaLabel", label, (size_t)ln);
                mdy_add_class(b->doc, back, "data-footnote-backref");

                mdy_append(back, mdy_new_text(b->doc, "↩", 3));
                /* The arrow alone on the FIRST; a <sup> saying which on the
                 * rest. Not "more than one reference exists" — the first one
                 * never carries a number even when there are five. */
                if (n > 1) {
                    mdy_node *sup = mdy_new_element(b->doc, "sup", 3);
                    char num[16];
                    int nn = snprintf(num, sizeof num, "%u", n);
                    if (nn < 0) { b->failed = 1; return -1; }
                    mdy_append(sup, mdy_new_text(b->doc, num, (size_t)nn));
                    mdy_append(back, sup);
                }
                append(b, back);
            }
            if (placed) close_block(b);   /* the paragraph */
            close_block(b);               /* the item */
            return 0;
        }

        case MD_BLOCK_FOOTNOTE_DEF_SECTION:
            close_block(b);   /* the list, with the trailing newline it is due */
            newline(b);       /* and the section's own, which wrap() has no shape for */
            pop(b);
            return 0;

        case MD_BLOCK_CODE:
            flush_gathered(b);
            b->gathering = 0;
            close_block(b);         /* code */
            close_block(b);         /* pre */
            return 0;

        case MD_BLOCK_HTML: {
            /* One raw node holding what was written — minus the newline that
             * ends the block. md4c hands the block over with its final line
             * break; remark's `html` node value has none, and the wrap above
             * supplies the separator. With both, every raw block was followed
             * by a blank line the JavaScript does not write. */
            if (b->pending_len && b->pending[b->pending_len - 1] == '\n') {
                b->pending_len--;
                if (b->pending_len && b->pending[b->pending_len - 1] == '\r') b->pending_len--;
            }
            if (b->pending_len) {
                mdy_node *raw = mdy_new_text(b->doc, b->pending, b->pending_len);
                if (raw) raw->type = MDY_RAW;
                append(b, raw);
            }
            b->pending_len = 0;
            b->gathering = 0;
            return 0;
        }

        case MD_BLOCK_TABLE: {
            /* The frame below the table is where the hoisted text goes. */
            mdy_node *table = b->stack[b->depth - 1].node;
            mdy_node *parent = b->depth >= 2 ? b->stack[b->depth - 2].node : NULL;
            close_block(b);
            foster_parent_table(b, parent, table);
            return 0;
        }

        case MD_BLOCK_P:
        case MD_BLOCK_H:
        case MD_BLOCK_QUOTE:
        case MD_BLOCK_THEAD:
        case MD_BLOCK_TBODY:
        case MD_BLOCK_TR:
        case MD_BLOCK_LI:
        case MD_BLOCK_TH:
        case MD_BLOCK_TD:
            close_block(b);
            return 0;

        case MD_BLOCK_UL:
        case MD_BLOCK_OL:
            close_block(b);
            return 0;

        case MD_BLOCK_HR:
            return 0;

        default:
            return 0;
    }
}

/* ---- spans ------------------------------------------------------------------ */

static int enter_span(MD_SPANTYPE type, void *detail, void *ud) {
    Build *b = ud;
    if (b->failed) return -1;

    switch (type) {
        case MD_SPAN_EM:     { mdy_node *n = mdy_new_element(b->doc, "em", 2); append(b, n); push(b, n, 0); return 0; }
        case MD_SPAN_STRONG: { mdy_node *n = mdy_new_element(b->doc, "strong", 6); append(b, n); push(b, n, 0); return 0; }
        case MD_SPAN_DEL:    { mdy_node *n = mdy_new_element(b->doc, "del", 3); append(b, n); push(b, n, 0); return 0; }
        case MD_SPAN_U:      { mdy_node *n = mdy_new_element(b->doc, "u", 1); append(b, n); push(b, n, 0); return 0; }
        case MD_SPAN_CODE: {
            mdy_node *n = mdy_new_element(b->doc, "code", 4);
            append(b, n); push(b, n, 0);
            b->gathering = 1;
            return 0;
        }
        case MD_SPAN_FOOTNOTE_REF: {
            /* Self-contained: md4c reports no text between enter and leave,
             * so the whole thing is built here and leave_span has nothing to
             * do with it. */
            const MD_SPAN_FOOTNOTE_REF_DETAIL *d = detail;
            const char *slug = note_slug(b, &d->label);
            int at = note_entry(b, slug);
            if (at < 0) return -1;
            unsigned index = (unsigned)at + 1;
            unsigned nth = ++b->notes[at].refs;

            mdy_node *a = mdy_new_element(b->doc, "a", 1);
            const char *href = note_id(b, "#", "fn-", slug, 1);
            mdy_set_string(b->doc, a, "href", href, strlen(href));
            const char *id = note_id(b, "", "fnref-", slug, nth);
            mdy_set_string(b->doc, a, "id", id, strlen(id));
            mdy_set_string(b->doc, a, "dataFootnoteRef", "", 0);
            /* A LIST, because hast's schema calls aria-describedby
             * space-separated and rehype-raw's parser splits it. */
            mdy_add_token(b->doc, a, "ariaDescribedBy", "footnote-label");

            /* The note's number, not its label: `[^note]` is rendered `1`. */
            char num[16];
            int n = snprintf(num, sizeof num, "%u", index);
            if (n < 0) { b->failed = 1; return -1; }
            mdy_append(a, mdy_new_text(b->doc, num, (size_t)n));

            mdy_node *sup = mdy_new_element(b->doc, "sup", 3);
            mdy_append(sup, a);
            append(b, sup);
            return 0;
        }

        case MD_SPAN_A: {
            const MD_SPAN_A_DETAIL *d = detail;
            mdy_node *a = mdy_new_element(b->doc, "a", 1);
            set_attribute(b, a, "href", &d->href, 1);
            set_attribute(b, a, "title", &d->title, 0);
            append(b, a); push(b, a, 0);
            return 0;
        }
        case MD_SPAN_IMG: {
            const MD_SPAN_IMG_DETAIL *d = detail;
            mdy_node *img = mdy_new_element(b->doc, "img", 3);
            set_attribute(b, img, "src", &d->src, 1);
            /*
             * `alt` reserved HERE, between src and title, and filled on the
             * way out once the children have been gathered. mdy-docs emits
             * `src, alt, title` and this emitted `src, title, alt`, because
             * alt is not known until the span closes — but new_prop replaces a
             * repeated name in place, so claiming the slot early is enough.
             * Every <img> with a title differed before. (B39.)
             */
            mdy_set_string(b->doc, img, "alt", "", 0);
            set_attribute(b, img, "title", &d->title, 0);
            append(b, img);
            /* An image's children are its ALT text, which is an attribute
             * rather than content — gathered, then set on the way out. */
            push(b, img, 0);
            b->gathering = 1;
            return 0;
        }
        default:
            return 0;
    }
}

static int leave_span(MD_SPANTYPE type, void *detail, void *ud) {
    Build *b = ud;
    (void)detail;
    if (b->failed) return -1;

    switch (type) {
        case MD_SPAN_CODE:
            flush_gathered(b);
            b->gathering = 0;
            pop(b);
            return 0;
        case MD_SPAN_IMG: {
            mdy_node *img = top(b);
            if (img) mdy_set_string(b->doc, img, "alt", b->pending ? b->pending : "", b->pending_len);
            b->pending_len = 0;
            b->gathering = 0;
            pop(b);
            return 0;
        }
        case MD_SPAN_EM:
        case MD_SPAN_STRONG:
        case MD_SPAN_DEL:
        case MD_SPAN_U:
        case MD_SPAN_A:
            pop(b);
            return 0;
        default:
            return 0;
    }
}

/* ---- text ------------------------------------------------------------------- */

static int text_cb(MD_TEXTTYPE type, const MD_CHAR *s, MD_SIZE size, void *ud) {
    Build *b = ud;
    if (b->failed) return -1;

    switch (type) {
        case MD_TEXT_NULLCHAR:
            put_codepoint(b, 0xFFFD);
            return 0;
        case MD_TEXT_BR:
            append(b, mdy_new_element(b->doc, "br", 2));
            return 0;
        case MD_TEXT_SOFTBR:
            /* A soft break is a newline in the text, not a node. */
            if (b->gathering) gather(b, "\n", 1); else text_node(b, "\n", 1);
            return 0;
        case MD_TEXT_ENTITY:
            entity(b, s, size);
            return 0;
        case MD_TEXT_HTML:
            /*
             * A RAW node, the way MD_BLOCK_HTML already makes one. (B46.)
             *
             * This had no case at all and fell through to `default:`, so an
             * inline tag became ordinary text and the writer escaped it:
             * `a <b>x</b>` came out `a &#x3C;b>x&#x3C;/b>` where node writes
             * the markup. The block kind was right all along, which is what
             * made it look deliberate — it is the same `.md` pipeline and the
             * same rehype-raw re-parsing both, and only one of the two was
             * being handed anything to re-parse.
             *
             * It is `.md` only, and that is not an accident of where this
             * file sits: mdy's OWN language has no inline HTML — a `<` in a
             * paragraph is a literal `<`, and a line that starts with one is
             * an element line — so the other front end escapes this and both
             * engines agree that it should.
             *
             * Gathering wins, and the case that needs it is an `<img>`'s
             * ALT: md4c reports the alt's content through this callback like
             * any other inline run, and an alt is an attribute — a string —
             * so a tag in one stays verbatim instead of becoming markup. A
             * code span never arrives here at all (md4c hands its whole body
             * over as MD_TEXT_CODE), so the guard is doing one job, not two.
             */
            if (b->gathering) { gather(b, s, size); return 0; }
            {
                mdy_node *raw = mdy_new_text(b->doc, s, size);
                if (raw) raw->type = MDY_RAW;
                append(b, raw);
            }
            return 0;
        default:
            if (b->gathering) gather(b, s, size);
            else text_node(b, s, size);
            return 0;
    }
}

/* ---- heading ids -------------------------------------------------------------
 *
 * mdy's own slugger, so a `#anchor` written in one format lands on a heading
 * written in the other. Run over the finished tree rather than during the
 * build, because a heading's id comes from all of its text and md4c reports
 * that in pieces.
 */
static void collect_text(const mdy_node *n, char *out, size_t cap, size_t *len) {
    if (n->type == MDY_TEXT && n->text) {
        size_t add = strlen(n->text);
        if (*len + add < cap) { memcpy(out + *len, n->text, add); *len += add; }
    }
    for (const mdy_node *c = n->first; c; c = c->next) collect_text(c, out, cap, len);
}

static int has_id(const mdy_node *el) {
    for (const mdy_prop *p = el->props; p; p = p->next)
        if (strcmp(p->name, "id") == 0) return 1;
    return 0;
}

/*
 * "Give every heading an id it does not already have" — mdy-docs'
 * identifyHeadings, and the second half of that sentence is load-bearing.
 * This overwrote one.
 *
 * Until footnotes there was nothing to overwrite: a heading the document wrote
 * as raw HTML is still a `raw` node here, so the only headings this pass met
 * were the ones it had just named itself. The footnotes section's `h2` is the
 * first that arrives with an id of its own — `footnote-label`, which every
 * back-reference's aria-describedby points at — and it was being handed the
 * slug of the word "Footnotes" instead.
 *
 * The other half is that the slugger is not ASKED for a name it will not use,
 * so a document with its own `## Footnotes` beside a footnotes section
 * numbers the two the same way on both engines.
 */
static void identify_headings(mdy_doc *doc, mdy_node *n) {
    for (mdy_node *c = n->first; c; c = c->next) {
        if (c->type == MDY_ELEMENT && c->tag && c->tag[0] == 'h' &&
            c->tag[1] >= '1' && c->tag[1] <= '6' && c->tag[2] == '\0' && !has_id(c)) {
            char text[1024];
            size_t len = 0;
            collect_text(c, text, sizeof text, &len);
            size_t id_len = 0;
            const char *id = mdy_resolve_slug(doc, text, len, &id_len);
            if (id && id_len) mdy_set_string(doc, c, "id", id, id_len);
        }
        identify_headings(doc, c);
    }
}

/*
 * md4c's own log, which is the only way to hear about an allocation it could
 * not make.
 *
 * md4c reports a failed malloc up its call chain — except from two of the nine
 * places that call md_end_current_block, which drop the return value, and one
 * of those is the last line of md_parse itself. That is where a document's
 * footnote definitions are registered, so a refused allocation there leaves
 * md_parse answering 0 with a tree that has no footnotes in it: `[^1]` comes
 * out as literal text, the definitions come out as prose, and the build says
 * it succeeded. A run that cannot produce the site has to SAY so (see
 * allocfail.c), and that one did not.
 *
 * md4c is vendored at a pinned upstream commit and not patched here, so this
 * listens instead: `debug_log` is a documented MD_PARSER member, and fifteen
 * of its twenty-nine messages are these two. The rest are a parse deciding
 * something — a table too sparse to be a table — or one of the callbacks below
 * having already returned -1, and neither is an allocation.
 */
static void md_log(const char *msg, void *ud) {
    Build *b = ud;
    if (!msg) return;
    if (strcmp(msg, "malloc() failed.") == 0 || strcmp(msg, "realloc() failed.") == 0)
        b->failed = 1;
}

mdy_doc *mdy_markdown_parse(const char *text, size_t len) {
    if (!text) return NULL;
    if (len == 0) len = strlen(text);

    mdy_doc *doc = mdy_doc_new();
    if (!doc) return NULL;

    Build b = {0};
    b.doc = doc;
    push(&b, doc->root, 0);

    MD_PARSER parser = {
        .abi_version = 0,
        .flags = MD_DIALECT_GITHUB,
        .enter_block = enter_block,
        .leave_block = leave_block,
        .enter_span = enter_span,
        .leave_span = leave_span,
        .text = text_cb,
        .debug_log = md_log,
    };

    int rc = md_parse(text, (MD_SIZE)len, &parser, &b);
    flush_text(&b);
    free(b.pending);
    free(b.inline_text);
    free(b.notes);
    if (rc != 0 || b.failed) { mdy_free(doc); return NULL; }

    identify_headings(doc, doc->root);
    return doc;
}
