/*
 * rehype-raw, in C: the last stage of the `.md` pipeline.
 *
 * A markdown parse leaves the HTML a document wrote as `raw` nodes — the
 * bytes, unparsed — because CommonMark says a raw `<div>` passes through and
 * says nothing about what it means. Somebody has to turn those bytes into
 * elements, and mdy-docs' somebody is `rehype-raw`, which puts the WHOLE tree
 * through an HTML5 parser. There was no such stage here, so a raw node stayed
 * one: no ill-formed tag was ever repaired and an unclosed one escaped its own
 * document onto the page. (B49.)
 *
 * NOT SERIALISE-AND-REPARSE, which is the obvious shape and the wrong one.
 * Measured over the corpus, serialising this tree to HTML and parsing it back
 * disagrees with rehype-raw on 373 of 869 real documents and on eleven of
 * twelve table shapes. rehype-raw does not serialise the tree: it drives
 * parse5's TREE CONSTRUCTION, pushing what it already has as tokens and
 * sending only a `raw` value through the tokenizer. Two things follow, and
 * neither survives a round trip through bytes:
 *
 *   - Text is never re-tokenized, so an empty text node stays one and a `<`
 *     that was text stays text.
 *   - A table's whitespace is FOSTER-PARENTED out. HTML5 lets whitespace sit
 *     in a table, but the rule collects a RUN of character tokens, and these
 *     arrive one text node at a time between start tags. §4 wrote that rule
 *     out by hand for tables; this gets it for the same reason node does.
 *
 * So this pushes into lexbor's construction dispatcher, which is the same
 * layer of the same algorithm as parse5's `_processToken`.
 *
 * WHAT IS PUSHED AND WHAT IS FED. Text and comments are pushed as tokens,
 * because that is the half that has to bypass the tokenizer. A start tag is
 * WRITTEN OUT and fed to the tokenizer instead of pushed, which parse5 cannot
 * do and lexbor can: the tokenizer then interns the attribute names, sets the
 * last-start-tag that RAWTEXT needs, and switches its own state — all of which
 * hast-util-raw has to reach into parse5 and do by hand. The bytes it reads
 * are the HTML writer's, so an attribute is spelled in exactly one place in
 * this library.
 */
#include <stdlib.h>
#include <string.h>

#include "lexbor/html/html.h"
#include "lexbor/html/tree.h"
#include "lexbor/html/token.h"
#include "lexbor/dom/dom.h"

#include "internal.h"
#include "props_table.h"

typedef struct {
    mdy_doc *doc;
    lxb_html_parser_t *parser;
    lxb_html_tree_t *tree;
    int failed;
} Raw;

/* ---- out: the tree we have, into the parser ------------------------------ */

/* The dispatcher answers false when the token must be re-dispatched — a mode
 * change that reprocesses it — which is the loop lexbor's own tokenizer
 * callback runs. */
static void push(Raw *r, lxb_html_token_t *t) {
    if (r->failed) return;
    while (lxb_html_tree_construction_dispatcher(r->tree, t) == false) { }
    if (r->tree->status != LXB_STATUS_OK) r->failed = 1;
}

/*
 * A text node, as a character token — and NEVER as a whitespace one, which is
 * the whole of why a table's newlines end up in front of it rather than
 * inside it.
 *
 * HTML5 keeps whitespace in a table and foster-parents anything else. parse5
 * decides which by the token's TYPE, and hast-util-raw only ever sends
 * `CHARACTER`, never `WHITESPACE_CHARACTER` — so every text node a markdown
 * tree puts inside a table is treated as non-whitespace and hoisted out.
 * lexbor decides by looking at the characters, so it is spec-correct and
 * keeps them. Node's answer is the one this has to produce, so the flag that
 * decision hangs on is set here to say what parse5's token type would have
 * said.
 *
 * `have_non_ws` matters only while the in-table-text mode is collecting, and
 * that mode clears it on entry (in_table.c), so setting it for text anywhere
 * else changes nothing.
 */
static void push_text(Raw *r, const char *s, size_t len) {
    lxb_html_token_t t = { 0 };
    t.tag_id = LXB_TAG__TEXT;
    t.type = LXB_HTML_TOKEN_TYPE_OPEN;
    t.text_start = (const lxb_char_t *)s;
    t.text_end = (const lxb_char_t *)s + len;
    t.begin = t.text_start;
    t.end = t.text_end;
    push(r, &t);
    if (!r->failed) r->tree->pending_table.have_non_ws = true;
}

static void feed(Raw *r, const char *s, size_t len) {
    if (r->failed || len == 0) return;
    if (lxb_html_parse_chunk_process(r->parser, (const lxb_char_t *)s, len) != LXB_STATUS_OK)
        r->failed = 1;
}

static void walk_out(Raw *r, const mdy_node *n);

static void children_out(Raw *r, const mdy_node *n) {
    for (const mdy_node *c = n->first; c && !r->failed; c = c->next) walk_out(r, c);
}

static void walk_out(Raw *r, const mdy_node *n) {
    switch (n->type) {
        case MDY_ROOT:
            children_out(r, n);
            return;

        case MDY_TEXT:
            push_text(r, n->text ? n->text : "", n->text ? strlen(n->text) : 0);
            return;

        case MDY_RAW:
            feed(r, n->text ? n->text : "", n->text ? strlen(n->text) : 0);
            return;

        case MDY_COMMENT: {
            /* Written out rather than pushed, for the same reason a tag is:
             * the tokenizer knows where a comment ends and this does not have
             * to. A `-->` inside is the author's problem on both sides. */
            mdy_buf b = { .ok = 1, .seed = 64 };
            mdy_buf_put(&b, "<!--", 4);
            if (n->text) mdy_buf_put(&b, n->text, strlen(n->text));
            mdy_buf_put(&b, "-->", 3);
            if (b.ok) feed(r, b.s, b.len); else r->failed = 1;
            free(b.s);
            return;
        }

        case MDY_ELEMENT: {
            if (!n->tag) return;
            mdy_buf b = { .ok = 1, .seed = 256 };
            mdy_buf_put(&b, "<", 1);
            mdy_buf_put(&b, n->tag, strlen(n->tag));
            for (const mdy_prop *p = n->props; p; p = p->next) {
                size_t before = b.len;
                mdy_buf_put(&b, " ", 1);
                size_t mark = b.len;
                mdy_html_write_attribute(&b, p);
                if (b.len == mark && b.s) { b.len = before; b.s[b.len] = '\0'; }
            }
            mdy_buf_put(&b, ">", 1);
            if (b.ok) feed(r, b.s, b.len); else r->failed = 1;
            free(b.s);

            children_out(r, n);

            /* A void element has no end tag, and writing one is a parse error
             * the parser would then have to recover from. */
            if (!mdy_is_void_element(n->tag)) {
                mdy_buf e = { .ok = 1, .seed = 64 };
                mdy_buf_put(&e, "</", 2);
                mdy_buf_put(&e, n->tag, strlen(n->tag));
                mdy_buf_put(&e, ">", 1);
                if (e.ok) feed(r, e.s, e.len); else r->failed = 1;
                free(e.s);
            }
            return;
        }

        default:
            /* A doctype in a fragment is dropped by the parser anyway. */
            return;
    }
}

/* ---- in: the parser's DOM, back into a tree ------------------------------ */

/*
 * The value an attribute read off the parse becomes.
 *
 * `class="a b"` is the LIST ["a","b"] in hast and `colspan="2"` is the number
 * 2, because `property-information` says those properties are space-separated
 * and numeric — the same table the writer consults going the other way, which
 * is why props_table.h now carries both flags. An attribute with no value is
 * the boolean `true` when the schema knows it as one and the empty string
 * when it does not.
 */
static void set_from_attribute(mdy_doc *doc, mdy_node *el,
                               const char *name, size_t name_len,
                               const char *value, size_t value_len, int had_value) {
    const char *hast = mdy_hast_name(doc, name, name_len);

    unsigned flags = 0;
    size_t plen = strlen(hast), lo = 0, hi = MDY_PROP_INFO_COUNT;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        const char *cand = MDY_PROP_INFO[mid].property;
        size_t clen = strlen(cand);
        size_t n = clen < plen ? clen : plen;
        int cmp = memcmp(cand, hast, n);
        if (cmp == 0) cmp = clen < plen ? -1 : (clen > plen ? 1 : 0);
        if (cmp == 0) { flags = MDY_PROP_INFO[mid].flags; break; }
        if (cmp < 0) lo = mid + 1; else hi = mid;
    }

    if (flags & MDY_ATTR_BOOLEAN) { mdy_set_bool(doc, el, hast, 1); return; }

    if (!had_value) { mdy_set_string(doc, el, hast, "", 0); return; }

    if (flags & (MDY_ATTR_SPACES | MDY_ATTR_COMMAS)) {
        /* A list, and an EMPTY value is an empty list rather than a list
         * holding one empty string. */
        mdy_prop *existing = NULL;
        for (mdy_prop *q = el->props; q; q = q->next)
            if (strcmp(q->name, hast) == 0) { existing = q; break; }
        if (existing) { existing->type = MDY_PROP_LIST; existing->list = NULL; existing->list_len = 0; }

        size_t k = 0;
        int any = 0;
        while (k < value_len) {
            if (flags & MDY_ATTR_COMMAS) {
                while (k < value_len && (value[k] == ' ' || value[k] == '\t')) k++;
                size_t start = k;
                while (k < value_len && value[k] != ',') k++;
                size_t end = k;
                while (end > start && (value[end - 1] == ' ' || value[end - 1] == '\t')) end--;
                if (end > start) {
                    char *one = mdy_strdup_n(&doc->arena, value + start, end - start);
                    mdy_add_token(doc, el, hast, one);
                    any = 1;
                }
                if (k < value_len) k++;   /* the comma */
            } else {
                while (k < value_len && (value[k] == ' ' || value[k] == '\t' ||
                                         value[k] == '\n' || value[k] == '\r' || value[k] == '\f')) k++;
                size_t start = k;
                while (k < value_len && !(value[k] == ' ' || value[k] == '\t' ||
                                          value[k] == '\n' || value[k] == '\r' || value[k] == '\f')) k++;
                if (k > start) {
                    char *one = mdy_strdup_n(&doc->arena, value + start, k - start);
                    mdy_add_token(doc, el, hast, one);
                    any = 1;
                }
            }
        }
        if (!any) {
            /* Nothing in it: an empty list, which is what the property is. */
            mdy_prop *q = NULL;
            for (mdy_prop *w = el->props; w; w = w->next) if (strcmp(w->name, hast) == 0) { q = w; break; }
            if (!q) { mdy_set_string(doc, el, hast, "", 0); }
        }
        return;
    }

    if (flags & MDY_ATTR_NUMBER) {
        /* `Number(value)` — and NaN keeps the string, which is what
         * property-information's consumers do with one that is not a number. */
        char small[64];
        if (value_len < sizeof small) {
            memcpy(small, value, value_len);
            small[value_len] = '\0';
            char *end = NULL;
            double d = strtod(small, &end);
            while (end && (*end == ' ' || *end == '\t')) end++;
            if (value_len > 0 && end && *end == '\0') { mdy_set_number(doc, el, hast, d); return; }
        }
    }

    mdy_set_string(doc, el, hast, value, value_len);
}

static void walk_in(mdy_doc *doc, mdy_node *into, lxb_dom_node_t *n) {
    for (; n != NULL; n = n->next) {
        switch (n->type) {
            case LXB_DOM_NODE_TYPE_ELEMENT: {
                size_t len = 0;
                const lxb_char_t *name =
                    lxb_dom_element_qualified_name(lxb_dom_interface_element(n), &len);
                mdy_node *el = mdy_new_element(doc, (const char *)name, len);
                if (!el) return;

                lxb_dom_attr_t *a = lxb_dom_element_first_attribute(lxb_dom_interface_element(n));
                for (; a != NULL; a = lxb_dom_element_next_attribute(a)) {
                    size_t an = 0, av = 0;
                    const lxb_char_t *aname = lxb_dom_attr_qualified_name(a, &an);
                    const lxb_char_t *avalue = lxb_dom_attr_value(a, &av);
                    set_from_attribute(doc, el, (const char *)aname, an,
                                       avalue ? (const char *)avalue : "", av,
                                       avalue != NULL);
                }
                mdy_append(into, el);
                walk_in(doc, el, n->first_child);
                break;
            }
            case LXB_DOM_NODE_TYPE_TEXT: {
                size_t len = 0;
                const lxb_char_t *t = lxb_dom_node_text_content(n, &len);
                mdy_node *tn = mdy_new_text(doc, t ? (const char *)t : "", len);
                if (tn) mdy_append(into, tn);
                break;
            }
            case LXB_DOM_NODE_TYPE_COMMENT: {
                size_t len = 0;
                const lxb_char_t *t = lxb_dom_node_text_content(n, &len);
                mdy_node *cn = mdy_new_text(doc, t ? (const char *)t : "", len);
                if (cn) { cn->type = MDY_COMMENT; mdy_append(into, cn); }
                break;
            }
            default:
                break;
        }
    }
}

/* ---- the pass ------------------------------------------------------------ */

/*
 * THERE IS NO FALLBACK, and that is the point worth stating.
 *
 * The obvious shape for a pass like this is "if the parse fails, keep the
 * tree we had" — and it is wrong here for the reason allocfail.c exists: the
 * tree we had is a DIFFERENT SITE, with raw nodes where the answer has
 * elements, and a build that quietly produced it would exit 0 having written
 * something nobody asked for. 453 of the allocation sweep's ordinals said so
 * the first time this was run. A parse that could not be made is a document
 * that could not be read, and the caller is told.
 */
int mdy_raw_reparse(mdy_doc *doc, mdy_node *root) {
    if (!doc || !root) return 0;

    /*
     * NOT `lexbor_memory_setup(malloc, realloc, calloc, free)`, which would
     * put lexbor's allocations under the failing allocator — the shim renames
     * those four here — and is the obvious thing to want.
     *
     * Measured: it works, and lexbor cannot take it. Refusing the nth
     * allocation across a build of fixture-awkward then segfaults on 490 of
     * 3,747 ordinals, inside lexbor rather than here. Its own error paths
     * return a status and its callers check one; what they do not do is
     * survive a NULL from every allocation site, which is a property upstream
     * has not claimed and this project cannot add to a pinned dependency.
     *
     * So the HTML parse is the one stage of a `.md` document's making that
     * check-alloc does not reach, and that is a gap rather than a decision.
     * It is B51.
     */

    Raw r = { .doc = doc };
    r.parser = lxb_html_parser_create();
    if (r.parser == NULL) return -1;
    if (lxb_html_parser_init(r.parser) != LXB_STATUS_OK) {
        lxb_html_parser_destroy(r.parser);
        return -1;
    }

    lxb_html_document_t *html = lxb_html_parse_chunk_begin(r.parser);
    if (html == NULL) { lxb_html_parser_destroy(r.parser); return -1; }
    r.tree = r.parser->tree;

    walk_out(&r, root);

    if (lxb_html_parse_chunk_end(r.parser) != LXB_STATUS_OK) r.failed = 1;

    lxb_html_body_element_t *body = r.failed ? NULL : lxb_html_document_body_element(html);
    if (body == NULL) r.failed = 1;

    if (!r.failed) {
        /* Into the root that was handed in, emptied: the document's own root
         * is what every caller holds, and handing back a different node would
         * leave them pointing at the tree this replaced. */
        root->first = NULL;
        root->last = NULL;
        walk_in(doc, root, lxb_dom_interface_node(body)->first_child);
    }

    lxb_html_document_destroy(html);
    lxb_html_parser_destroy(r.parser);
    return r.failed ? -1 : 0;
}
