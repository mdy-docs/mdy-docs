/*
 * Footnotes. See internal.h for the three rules that make this a
 * document-level pass rather than an inline one.
 *
 * The ids and class names here are GitHub's, which is what mdy-docs emits and
 * what anything styling the output will expect: `user-content-fn-<id>` for a
 * definition, `user-content-fnref-<id>` for the reference that points at it,
 * and `-2`, `-3` … on the second and later references to the same note.
 */
#include <stdio.h>
#include <string.h>

#include "internal.h"

mdy_footnote *mdy_footnote_find(mdy_doc *doc, const char *id, size_t len) {
    /*
     * Once there are enough notes that this scan hurts, an id -> index map
     * built alongside notes[] answers it in O(1). The map is keyed on the
     * interned id, which is the full length the definition was stored with —
     * so a hit still has to pass the exact predicate below (an id with an
     * embedded NUL is stored longer than its C-string and must not match a
     * shorter query), while a miss is a true miss: any id the scan would find
     * has strlen == len == its stored length, so it is in the map too.
     */
    if (doc->note_index) {
        /* Lookup only: every indexed id is already interned, so an id that is
         * not is a miss, and interning it would keep a copy of every unknown
         * reference for the life of the document. */
        const char *key = mdy_intern_lookup(&doc->names, id, len);
        mdy_hentry *e = key ? mdy_hindex_get(doc->note_index, key, 0) : NULL;
        if (!e) return NULL;
        mdy_footnote *n = &doc->notes[e->val];
        if (strlen(n->id) == len && memcmp(n->id, id, len) == 0) return n;
        /* the rare embedded-NUL hit: fall through to the exact scan */
    }
    for (size_t i = 0; i < doc->note_count; i++) {
        if (strlen(doc->notes[i].id) == len && memcmp(doc->notes[i].id, id, len) == 0) {
            return &doc->notes[i];
        }
    }
    return NULL;
}

int mdy_footnote_reference(mdy_doc *doc, mdy_footnote *note) {
    if (note->number == 0) {
        size_t at = (size_t)doc->next_number;
        if (at == doc->note_order_cap) {
            size_t cap = at ? at * 2 : 16;
            size_t *grown = mdy_alloc(&doc->arena, cap * sizeof *grown);
            if (at) memcpy(grown, doc->note_order, at * sizeof *grown);
            doc->note_order = grown;
            doc->note_order_cap = cap;
        }
        doc->note_order[at] = (size_t)(note - doc->notes);
        note->number = ++doc->next_number;
    }
    return ++note->refs;
}

/** `prefix` + id, and `-n` when n > 1 — the id scheme above. */
static const char *ref_id(mdy_doc *doc, const char *kind, const char *id, int n) {
    const char *prefix = doc->note_prefix ? doc->note_prefix : "user-content-";
    /* Sized to the id, not a fixed 256: a long label made the `href` (which
     * carries a leading `#`) truncate one byte earlier than the matching
     * `id`, so a back-reference pointed at an anchor that did not exist. The
     * result is arena-owned, so it is built there directly. */
    size_t cap = strlen(prefix) + strlen(kind) + strlen(id) + 24;
    char *buf = mdy_alloc(&doc->arena, cap);
    if (!buf) return "";
    if (n > 1) snprintf(buf, cap, "%s%s%s-%d", prefix, kind, id, n);
    else snprintf(buf, cap, "%s%s%s", prefix, kind, id);
    return buf;
}

void mdy_footnote_section(mdy_doc *doc, mdy_node *parent) {
    /* Every number belongs to exactly one note, so none means none referenced. */
    if (doc->next_number == 0) return;

    mdy_node *section = mdy_new_element(doc, "section", 7);
    mdy_set_bool(doc, section, "dataFootnotes", 1);
    mdy_add_class(doc, section, "footnotes");

    mdy_append(section, mdy_new_text(doc, "\n", 1));
    mdy_node *h2 = mdy_new_element(doc, "h2", 2);
    mdy_add_class(doc, h2, "sr-only");
    mdy_set_string(doc, h2, "id", "footnote-label", 14);
    mdy_append(h2, mdy_new_text(doc, "Footnotes", 9));
    mdy_append(section, h2);
    mdy_append(section, mdy_new_text(doc, "\n", 1));

    mdy_node *ol = mdy_new_element(doc, "ol", 2);
    mdy_append(ol, mdy_new_text(doc, "\n", 1));

    /*
     * In order of first reference, which is what `number` records. The bound
     * is read on every pass on purpose: a note's content is parsed below, and
     * a reference inside it numbers a note that had none, which then gets its
     * own item after the ones already numbered.
     */
    for (int want = 1; want <= doc->next_number; want++) {
        mdy_footnote *note = &doc->notes[doc->note_order[want - 1]];

        mdy_node *li = mdy_new_element(doc, "li", 2);
        /* Once: ref_id copies into the arena, and calling it for the string
         * and again for its length made two of every footnote's id. */
        const char *fn = ref_id(doc, "fn-", note->id, 1);
        mdy_set_string(doc, li, "id", fn, strlen(fn));
        mdy_append(li, mdy_new_text(doc, "\n", 1));

        mdy_node *p = mdy_new_element(doc, "p", 1);
        mdy_parse_inline(doc, p, note->content, note->content_len);

        /*
         * One backref per reference, each preceded by a space. With a single
         * reference the arrow stands alone; with more than one each carries a
         * <sup> saying which it goes back to.
         */
        for (int n = 1; n <= note->refs; n++) {
            mdy_append(p, mdy_new_text(doc, " ", 1));
            mdy_node *back = mdy_new_element(doc, "a", 1);
            char href[256];
            snprintf(href, sizeof href, "#%s", ref_id(doc, "fnref-", note->id, n));
            mdy_set_string(doc, back, "href", href, strlen(href));
            mdy_set_bool(doc, back, "dataFootnoteBackref", 1);
            mdy_set_string(doc, back, "ariaLabel", "Back to content", 15);
            mdy_add_class(doc, back, "data-footnote-backref");
            mdy_append(back, mdy_new_text(doc, "↩", 3));   /* ↩ */
            if (note->refs > 1) {
                mdy_node *sup = mdy_new_element(doc, "sup", 3);
                char num[16];
                snprintf(num, sizeof num, "%d", n);
                mdy_append(sup, mdy_new_text(doc, num, strlen(num)));
                mdy_append(back, sup);
            }
            mdy_append(p, back);
        }

        mdy_append(li, p);
        mdy_append(li, mdy_new_text(doc, "\n", 1));
        mdy_append(ol, li);
        mdy_append(ol, mdy_new_text(doc, "\n", 1));
    }

    mdy_append(section, ol);
    mdy_append(section, mdy_new_text(doc, "\n", 1));

    /*
     * The block loop has already emitted the trailing separator for whatever
     * came before, so the section slots into that gap and supplies the next
     * one — `… "\n" section "\n"`. Prepending another produced a doubled
     * newline before every footnotes section in the corpus, which is invisible
     * in a node count and the first text divergence in most documents.
     */
    if (parent->type == MDY_ELEMENT &&
        !(parent->last && parent->last->type == MDY_TEXT &&
          parent->last->text && strcmp(parent->last->text, "\n") == 0)) {
        mdy_append(parent, mdy_new_text(doc, "\n", 1));
    }
    mdy_append(parent, section);
    if (parent->type == MDY_ELEMENT) mdy_append(parent, mdy_new_text(doc, "\n", 1));
}
