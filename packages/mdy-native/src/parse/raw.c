/*
 * rehype-raw, in C: the last stage of the `.md` pipeline.
 *
 * A markdown parse leaves the HTML a document wrote as `raw` nodes — the
 * bytes, unparsed — because CommonMark says a raw `<div>` passes through and
 * says nothing about what it means. Somebody has to turn those bytes into
 * elements, and mdy-docs' somebody is `rehype-raw`, which puts the WHOLE tree
 * through an HTML5 parser. Without that stage a raw node stays one: no
 * ill-formed tag is repaired, and an unclosed one escapes its own document
 * onto the page.
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
 *     arrive one text node at a time between start tags. Writing that rule
 *     out by hand for tables is the alternative; this gets it for the same
 *     reason node does.
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
#include "lexbor/html/tree/insertion_mode.h"
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

/* ---- lexbor's allocator ---------------------------------------------------
 *
 * lexbor is given four functions that do not return NULL, for the reason
 * xalloc.h states in general: if a NULL turns into different output, or into
 * a crash, it must not be NULL.
 *
 * It was measured rather than assumed. Handing lexbor the failing allocator
 * directly — under the shim `malloc` here IS the shim's, so
 * `lexbor_memory_setup(malloc, …)` is all it takes — refuses the nth
 * allocation of a build and then segfaults on 490 of 3,747 ordinals, inside
 * lexbor. Its own error paths return a status and its callers check one; what
 * they do not do is survive a NULL from every site, and surviving one is not
 * a property upstream claims. Reading 163 files to add it to a pinned
 * dependency is the wrong shape of work, and a fork to maintain.
 *
 * `mdy_oom_exit` is the answer: it says so on stderr and exits non-zero,
 * which is what the allocation sweep's invariant asks of a run that cannot
 * produce the site. Without it the HTML parse is the one stage of a `.md`
 * document's making that the sweep cannot reach, because a refused allocation
 * there is a crash rather than a refusal.
 *
 * It is better in a real out-of-memory too: a build that cannot allocate says
 * so instead of dying in a parser's inner loop.
 */
static void *raw_malloc(size_t n) {
    void *p = malloc(n);
    if (p == NULL) mdy_oom_exit();
    return p;
}

static void *raw_realloc(void *p, size_t n) {
    void *q = realloc(p, n);
    if (q == NULL && n != 0) mdy_oom_exit();
    return q;
}

static void *raw_calloc(size_t n, size_t size) {
    void *p = calloc(n, size);
    if (p == NULL) mdy_oom_exit();
    return p;
}

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
    if (lxb_html_parse_fragment_chunk_process(r->parser, (const lxb_char_t *)s, len) != LXB_STATUS_OK)
        r->failed = 1;
}

/*
 * A text node, ESCAPED and fed to the tokenizer rather than pushed as a
 * token — which is the opposite of what hast-util-raw does, and for a reason
 * that only shows up in C.
 *
 * The tokenizer holds character data until it sees a `<`. A token pushed
 * straight at the tree while text is still sitting there JUMPS AHEAD of it:
 * `<div>` then `*foo*` from a raw value, then a `\n` of our own, came out
 * `\n\n*foo*` rather than `\n*foo*\n`. parse5 lets hast-util-raw flush its
 * tokenizer before each push (`resetTokenizer`); lexbor has no such call, so
 * nothing is pushed ahead of the queue and everything goes through it.
 *
 * `&` and `<` are the only characters that can start something, and escaping
 * them is exactly what the HTML writer does — so the tokenizer gives back the
 * bytes that went in. What it does NOT give back is `\r`, which HTML5
 * normalises to `\n`: doc.c has already done that to every source this can
 * see, so there is none to lose.
 */
/*
 * Between a <table> and its first cell, where HTML5 decides whether character
 * data belongs in the table or in front of it. See push_text: node's answer
 * comes from the token TYPE its parser is handed, and the only way to say
 * that here is to hand the tree a token and set the flag beside it — which
 * means going round the tokenizer, in the one place where that is worth the
 * ordering it costs.
 */
static int in_table_context(const lxb_html_tree_t *tree) {
    return tree->mode == lxb_html_tree_insertion_mode_in_table
        || tree->mode == lxb_html_tree_insertion_mode_in_table_text
        || tree->mode == lxb_html_tree_insertion_mode_in_table_body
        || tree->mode == lxb_html_tree_insertion_mode_in_row;
}

static void feed_text(Raw *r, const char *s, size_t len) {
    if (r->failed) return;

    if (in_table_context(r->tree)) { push_text(r, s, len); return; }

    if (len == 0) {
        /* Nothing to tokenize, and an empty text node is still a node — the
         * one thing that has to be pushed. See the local patch in in_body.c. */
        push_text(r, "", 0);
        return;
    }

    mdy_buf b = { .ok = 1, .seed = 256 };
    for (size_t i = 0; i < len; i++) {
        if (s[i] == '&') mdy_buf_put(&b, "&amp;", 5);
        else if (s[i] == '<') mdy_buf_put(&b, "&lt;", 4);
        else mdy_buf_putc(&b, s[i]);
    }
    if (!b.ok) { r->failed = 1; free(b.s); return; }
    feed(r, b.s, b.len);
    free(b.s);
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
            feed_text(r, n->text ? n->text : "", mdy_text_len(n));
            return;

        case MDY_RAW:
            feed(r, n->text ? n->text : "", mdy_text_len(n));
            return;

        case MDY_COMMENT: {
            /* Written out rather than pushed, for the same reason a tag is:
             * the tokenizer knows where a comment ends and this does not have
             * to. A `-->` inside is the author's problem on both sides. */
            mdy_buf b = { .ok = 1, .seed = 64 };
            mdy_buf_put(&b, "<!--", 4);
            if (n->text) mdy_buf_put(&b, n->text, mdy_text_len(n));
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
                               const char *value, size_t value_len,
                               int had_value, int svg) {
    const char *hast = mdy_hast_name(doc, name, name_len);

    /*
     * Inside an <svg>, property-information's SVG schema applies and not its
     * HTML one — which is what hast-util-from-parse5 switches to on the
     * namespace. The difference that reaches us is typing: `width="16"` on an
     * <img> is the NUMBER 16 and on an <svg> it is the string "16", and an
     * alert's octicon is an <svg> carrying both. Only the space-separated
     * rule survives the switch for anything this engine emits, and
     * `className` is the one that matters.
     */
    if (svg) {
        if (strcmp(hast, "className") == 0) {
            size_t k = 0;
            while (k < value_len) {
                while (k < value_len && (value[k] == ' ' || value[k] == '\t' ||
                                         value[k] == '\n' || value[k] == '\r' || value[k] == '\f')) k++;
                size_t start = k;
                while (k < value_len && !(value[k] == ' ' || value[k] == '\t' ||
                                          value[k] == '\n' || value[k] == '\r' || value[k] == '\f')) k++;
                if (k > start)
                    mdy_add_token(doc, el, hast, mdy_strdup_n(&doc->arena, value + start, k - start));
            }
            return;
        }
        mdy_set_string(doc, el, hast, value, value_len);
        return;
    }

    unsigned flags = 0;
    size_t plen = strlen(hast), lo = 0, hi = MDY_PROP_INFO_COUNT;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        const char *cand = MDY_PROP_INFO[mid].property;
        int cmp = mdy_strkey_cmp(cand, strlen(cand), hast, plen);
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
        if (existing) { existing->type = MDY_PROP_LIST; existing->list = NULL; existing->list_len = 0; existing->list_cap = 0; }

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
            if (!q) mdy_set_list(doc, el, hast);
        }
        return;
    }

    if (flags & MDY_ATTR_NUMBER) {
        /* hastscript's parsePrimitive: `Number(value)` for a non-empty value,
         * and the string kept when that is NaN. */
        if (value_len > 0) {
            double d = mdy_js_number(value, value_len);
            if (d == d) { mdy_set_number(doc, el, hast, d); return; }
        }
    }

    mdy_set_string(doc, el, hast, value, value_len);
}

static void walk_in(mdy_doc *doc, mdy_node *into, lxb_dom_node_t *n, size_t depth) {
    /*
     * lexbor imposes no nesting limit of its own, so a raw `<b><b><b>…` in a
     * `.md` file becomes a DOM as deep as the input and this recurses once per
     * level — `<b>` * 200000 overflowed the stack. Past MDY_MAX_DEPTH the
     * deeper content is dropped rather than crashing the parse; a raw fragment
     * nested that far is pathological.
     */
    if (depth > MDY_MAX_DEPTH) {
        if (!doc->raw_depth_warned) {
            doc->raw_depth_warned = 1;
            mdy_warn_inline(doc, "nesting-depth",
                            "raw HTML nested deeper than %d levels is dropped", MDY_MAX_DEPTH);
        }
        return;
    }
    for (; n != NULL; n = n->next) {
        switch (n->type) {
            case LXB_DOM_NODE_TYPE_ELEMENT: {
                size_t len = 0;
                const lxb_char_t *name =
                    lxb_dom_element_qualified_name(lxb_dom_interface_element(n), &len);
                mdy_node *el = mdy_new_element(doc, (const char *)name, len);
                if (!el) return;

                int svg = n->ns != LXB_NS_HTML;
                lxb_dom_attr_t *a = lxb_dom_element_first_attribute(lxb_dom_interface_element(n));
                for (; a != NULL; a = lxb_dom_element_next_attribute(a)) {
                    size_t an = 0, av = 0;
                    const lxb_char_t *aname = lxb_dom_attr_qualified_name(a, &an);
                    const lxb_char_t *avalue = lxb_dom_attr_value(a, &av);
                    set_from_attribute(doc, el, (const char *)aname, an,
                                       avalue ? (const char *)avalue : "", av,
                                       avalue != NULL, svg);
                }
                mdy_append(into, el);
                walk_in(doc, el, n->first_child, depth + 1);
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
 * something nobody asked for. A parse that could not be made is a document
 * that could not be read, and the caller is told.
 */
int mdy_raw_reparse(mdy_doc *doc, mdy_node *root) {
    if (!doc || !root) return 0;

    lexbor_memory_setup(raw_malloc, raw_realloc, raw_calloc, free);

    Raw r = { .doc = doc };
    r.parser = lxb_html_parser_create();
    if (r.parser == NULL) return -1;
    if (lxb_html_parser_init(r.parser) != LXB_STATUS_OK) {
        lxb_html_parser_destroy(r.parser);
        return -1;
    }

    lxb_html_document_t *html = lxb_html_document_create();
    if (html == NULL) { lxb_html_parser_destroy(r.parser); return -1; }

    /*
     * A FRAGMENT parse, in `body` context, and not a document parse — which is
     * what hast-util-raw does (`Parser.getFragmentParser()`) and is not a
     * detail. A document parse starts before `<html>`, and the modes before
     * `<body>` opens DROP a whitespace-only character token: a document whose
     * first block is `</div>` followed by a blank line lost that newline,
     * because the stray end tag opened nothing and the newline arrived while
     * the parser was still deciding where it was. In `body` context the first
     * token is already in the body.
     */
    if (lxb_html_parse_fragment_chunk_begin(r.parser, html,
                                            LXB_TAG_BODY, LXB_NS_HTML) != LXB_STATUS_OK) {
        lxb_html_document_destroy(html);
        lxb_html_parser_destroy(r.parser);
        return -1;
    }
    r.tree = r.parser->tree;

    walk_out(&r, root);

    lxb_dom_node_t *fragment = lxb_html_parse_fragment_chunk_end(r.parser);
    if (fragment == NULL) r.failed = 1;

    if (!r.failed) {
        /* Into the root that was handed in, emptied: the document's own root
         * is what every caller holds, and handing back a different node would
         * leave them pointing at the tree this replaced. */
        root->first = NULL;
        root->last = NULL;
        walk_in(doc, root, fragment->first_child, 0);
    }

    lxb_html_document_destroy(html);
    lxb_html_parser_destroy(r.parser);
    return r.failed ? -1 : 0;
}
