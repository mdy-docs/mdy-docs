/*
 * Building the tree, and writing it out as JSON.
 *
 * The JSON is not a convenience: it is how this implementation is checked
 * against the JavaScript one. A 4,441-line parser cannot be ported by reading
 * it — it is ported by producing the same tree for a real corpus, document by
 * document, and diffing. Key order is fixed here and matched on the JS side by
 * test/compare.mjs so the diff is byte for byte.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"

int mdy_is_void_element(const char *tag) {
    static const char *const VOID[] = {
        "area", "base", "basefont", "bgsound", "br", "col", "command", "embed",
        "frame", "hr", "image", "img", "input", "keygen", "link", "meta",
        "param", "source", "track", "wbr",
    };
    for (size_t i = 0; i < sizeof VOID / sizeof VOID[0]; i++)
        if (strcmp(VOID[i], tag) == 0) return 1;
    return 0;
}

/* ---- building ------------------------------------------------------------ */

static mdy_node *new_node(mdy_doc *doc, mdy_node_type type) {
    mdy_node *n = mdy_alloc(&doc->arena, sizeof *n);
    if (!n) return NULL;
    memset(n, 0, sizeof *n);
    n->type = type;
    return n;
}

mdy_node *mdy_new_element(mdy_doc *doc, const char *tag, size_t tag_len) {
    mdy_node *n = new_node(doc, MDY_ELEMENT);
    if (n) n->tag = mdy_intern(&doc->arena, &doc->names, tag, tag_len);
    return n;
}

mdy_node *mdy_new_text(mdy_doc *doc, const char *text, size_t len) {
    mdy_node *n = new_node(doc, MDY_TEXT);
    if (n) { n->text = mdy_strdup_n(&doc->arena, text, len); n->text_len = len; }
    return n;
}

void mdy_append(mdy_node *parent, mdy_node *child) {
    if (!parent || !child) return;
    if (parent->last) parent->last->next = child;
    else parent->first = child;
    parent->last = child;
}

/*
 * A name -> property map for an element that has grown MANY properties.
 *
 * `properties` is an OBJECT, so a repeated name replaces rather than appends,
 * and new_prop has to find any existing property of the same name. A linear
 * scan of the list is O(n) per insert, so building an element with n distinct
 * properties is O(n^2) — a raw `<div a1 a2 … a60000>` took 18 seconds. Past a
 * threshold the element grows an open-addressing index instead, keyed on the
 * INTERNED name pointer (unique per distinct name), which makes the lookup
 * O(1) as the JavaScript's object is. Below the threshold no index is built,
 * so the common few-property element pays nothing but one NULL pointer.
 *
 * Arena-allocated and never freed individually; a grow abandons the old table,
 * which sums to O(n) like mdy_add_token's list.
 */
typedef struct mdy_pindex {
    mdy_prop **slots;   /* open addressing; cap is a power of two */
    size_t cap;
    size_t count;
} mdy_pindex;

static size_t pindex_slot(mdy_prop **slots, size_t cap, const char *interned) {
    size_t mask = cap - 1;
    size_t h = ((uintptr_t)interned >> 4) & mask;
    while (slots[h] && slots[h]->name != interned) h = (h + 1) & mask;
    return h;
}

static void pindex_put(mdy_doc *doc, mdy_pindex *px, mdy_prop *p) {
    if ((px->count + 1) * 4 >= px->cap * 3) {   /* keep the load under 3/4 */
        size_t ncap = px->cap ? px->cap * 2 : 64;
        mdy_prop **ns = mdy_alloc(&doc->arena, ncap * sizeof *ns);
        if (!ns) return;
        memset(ns, 0, ncap * sizeof *ns);
        for (size_t i = 0; i < px->cap; i++)
            if (px->slots[i]) ns[pindex_slot(ns, ncap, px->slots[i]->name)] = px->slots[i];
        px->slots = ns;
        px->cap = ncap;
    }
    px->slots[pindex_slot(px->slots, px->cap, p->name)] = p;
    px->count++;
}

/* The element's property with this interned name, or NULL. `*scanned` is how
 * many properties the list walk passed, for the caller that decides when the
 * list is long enough to index. */
static mdy_prop *find_interned(const mdy_node *el, const char *interned, size_t *scanned) {
    if (el->pindex) return el->pindex->slots[pindex_slot(el->pindex->slots, el->pindex->cap, interned)];
    size_t n = 0;
    for (mdy_prop *q = el->props; q; q = q->next, n++)
        if (q->name == interned) { if (scanned) *scanned = n; return q; }
    if (scanned) *scanned = n;
    return NULL;
}

/* The element's property of this name, or NULL when it has none — through
 * the index when the element has one, and without interning a name no
 * property has ever had. */
static mdy_prop *find_prop(mdy_doc *doc, const mdy_node *el, const char *name) {
    const char *interned = mdy_intern_lookup(&doc->names, name, strlen(name));
    return interned ? find_interned(el, interned, NULL) : NULL;
}

static mdy_prop *new_prop(mdy_doc *doc, mdy_node *el, const char *name) {
    const char *interned = mdy_intern(&doc->arena, &doc->names, name, strlen(name));

    /* An existing property of this name is reused (its value replaced). */
    size_t scanned = 0;
    mdy_prop *q = find_interned(el, interned, &scanned);
    if (q) { q->list = NULL; q->list_len = 0; q->list_cap = 0; return q; }

    /* Long enough that the scan hurts: index this element from here on. */
    if (!el->pindex && scanned >= MDY_HINDEX_THRESHOLD) {
        mdy_pindex *px = mdy_alloc(&doc->arena, sizeof *px);
        memset(px, 0, sizeof *px);
        for (mdy_prop *r = el->props; r; r = r->next) pindex_put(doc, px, r);
        el->pindex = px;
    }

    mdy_prop *p = mdy_alloc(&doc->arena, sizeof *p);
    memset(p, 0, sizeof *p);
    p->name = interned;
    if (el->props_tail) el->props_tail->next = p;
    else el->props = p;
    el->props_tail = p;
    if (el->pindex) pindex_put(doc, el->pindex, p);
    return p;
}

void mdy_set_string(mdy_doc *doc, mdy_node *el, const char *name, const char *value, size_t value_len) {
    mdy_prop *p = new_prop(doc, el, name);
    if (!p) return;
    p->type = MDY_PROP_STRING;
    p->as.string = mdy_strdup_n(&doc->arena, value, value_len);
}

void mdy_set_number(mdy_doc *doc, mdy_node *el, const char *name, double value) {
    mdy_prop *p = new_prop(doc, el, name);
    if (!p) return;
    p->type = MDY_PROP_NUMBER;
    p->as.number = value;
}

void mdy_set_bool(mdy_doc *doc, mdy_node *el, const char *name, int value) {
    mdy_prop *p = new_prop(doc, el, name);
    if (!p) return;
    p->type = MDY_PROP_BOOL;
    p->as.boolean = value;
}

/*
 * A space-separated property is a LIST in hast, and it is appended to rather
 * than replaced — an element can pick up classes from more than one rule.
 * `className` is one; so is `ariaDescribedBy`, which hast's schema also calls
 * space-separated: rehype-raw hands back `["footnote-label"]` for
 * `aria-describedby="footnote-label"`, not the string.
 */
void mdy_set_list(mdy_doc *doc, mdy_node *el, const char *name) {
    mdy_prop *p = find_prop(doc, el, name);
    if (!p) p = new_prop(doc, el, name);
    p->type = MDY_PROP_LIST;
    p->list = NULL;
    p->list_len = 0;
    p->list_cap = 0;
}

void mdy_add_token(mdy_doc *doc, mdy_node *el, const char *name, const char *token) {
    mdy_prop *p = find_prop(doc, el, name);
    if (!p) p = new_prop(doc, el, name);
    /*
     * A token list — whether the property is new, or a same-named non-list
     * value being turned into one. Appending without setting the type left a
     * STRING property carrying a `list` its readers would never look at, since
     * they branch on `type` first. New properties arrive as STRING (enum 0), so
     * this initialises them too.
     */
    if (p->type != MDY_PROP_LIST) { p->type = MDY_PROP_LIST; p->list = NULL; p->list_len = 0; p->list_cap = 0; }
    if (p->list_len == p->list_cap) {
        /*
         * Amortised doubling. The arena never frees, so reallocating the whole
         * list on every token made k tokens cost O(k^2) arena memory — a raw
         * `<div class="a a a …">` with 150k words reached ~8 GB and an OOM
         * exit. Doubling leaves the abandoned arrays summing to O(k) instead.
         */
        size_t cap = p->list_cap ? p->list_cap * 2 : 4;
        const char **grown = mdy_alloc(&doc->arena, sizeof(char *) * cap);
        if (!grown) return;
        for (size_t i = 0; i < p->list_len; i++) grown[i] = p->list[i];
        p->list = grown;
        p->list_cap = cap;
    }
    p->list[p->list_len++] = mdy_strdup_n(&doc->arena, token, strlen(token));
}

void mdy_add_class(mdy_doc *doc, mdy_node *el, const char *class_name) {
    mdy_add_token(doc, el, "className", class_name);
}

/*
 * A deep copy of `node` into `into`'s arena — structure, properties, text and
 * positions, sharing nothing with the original.
 *
 * A tree that is placed in two documents needs this. Nodes are linked, not
 * reference-counted: appending one moves it, so a tree spliced a second time
 * would arrive empty and take its whitespace with it. In JavaScript the same
 * hast node can simply be referenced twice and serialise the same both times;
 * this is what that costs in C.
 */
mdy_node *mdy_clone(mdy_doc *into, const mdy_node *node) {
    if (!into || !node) return NULL;

    mdy_node *copy = NULL;
    if (node->type == MDY_TEXT) {
        copy = mdy_new_text(into, node->text ? node->text : "", mdy_text_len(node));
    } else if (node->type == MDY_ELEMENT) {
        copy = mdy_new_element(into, node->tag ? node->tag : "div",
                               node->tag ? strlen(node->tag) : 3);
    } else {
        /* A root, or anything else that carries only children. */
        copy = mdy_alloc(&into->arena, sizeof *copy);
        if (!copy) return NULL;
        memset(copy, 0, sizeof *copy);
        copy->type = node->type;
        if (node->text) { copy->text_len = mdy_text_len(node); copy->text = mdy_strdup_n(&into->arena, node->text, copy->text_len); }
    }
    if (!copy) return NULL;

    /* Properties in order, since the order is what the emitter writes. */
    for (const mdy_prop *p = node->props; p; p = p->next) {
        switch (p->type) {
        case MDY_PROP_STRING:
            mdy_set_string(into, copy, p->name, p->as.string ? p->as.string : "",
                           p->as.string ? strlen(p->as.string) : 0);
            break;
        case MDY_PROP_NUMBER:
            mdy_set_number(into, copy, p->name, p->as.number);
            break;
        case MDY_PROP_BOOL:
            mdy_set_bool(into, copy, p->name, p->as.boolean);
            break;
        case MDY_PROP_LIST: {
            mdy_prop *q = new_prop(into, copy, p->name);
            if (!q) break;
            q->type = MDY_PROP_LIST;
            q->list_len = 0;
            q->list = NULL;
            q->list_cap = 0;
            if (p->list_len) {
                const char **items = mdy_alloc(&into->arena, sizeof(char *) * p->list_len);
                if (!items) break;
                for (size_t i = 0; i < p->list_len; i++)
                    items[i] = mdy_strdup_n(&into->arena, p->list[i], strlen(p->list[i]));
                q->list = items;
                q->list_len = p->list_len;
                q->list_cap = p->list_len;
            }
            break;
        }
        }
    }

    copy->line = node->line;
    copy->column = node->column;
    copy->end_line = node->end_line;
    copy->end_column = node->end_column;

    for (const mdy_node *c = node->first; c; c = c->next) {
        mdy_node *child = mdy_clone(into, c);
        if (child) mdy_append(copy, child);
    }
    return copy;
}

/**
 * Drop whatever classes an element has.
 *
 * Properties are an OBJECT, so a second `class=` on the same tag replaces the
 * first rather than adding to it — `<i ClassName="a" CLASS="b">` is `["b"]`.
 * The append in mdy_add_class is for the parser's own classes, where more than
 * one rule can contribute; a repeated attribute is not that case.
 */
void mdy_clear_class(mdy_doc *doc, mdy_node *el) {
    mdy_prop *q = find_prop(doc, el, "className");
    if (q) { q->list = NULL; q->list_len = 0; q->list_cap = 0; }
}

/* ---- a growable output buffer -------------------------------------------- */

/*
 * The JSON writer's growable buffer. Its writers return an `int` rather than
 * carrying the sticky `ok` flag internal.h's buffer uses: the call sites here
 * propagate that return directly, and `ok` says the same thing one adapter away.
 */
typedef struct { char *s; size_t len, cap; int positions; } Out;

static int out_put(Out *o, const char *s, size_t n) {
    mdy_buf b = { .s = o->s, .len = o->len, .cap = o->cap, .seed = 4096, .ok = 1 };
    mdy_buf_put(&b, s, n);
    o->s = b.s; o->len = b.len; o->cap = b.cap;
    return b.ok ? 0 : -1;
}
static int out_str(Out *o, const char *s) { return out_put(o, s, strlen(s)); }

/*
 * A JSON string, escaped the way JSON.stringify escapes: the seven short
 * forms, \u00XX for the other control characters, and everything else —
 * including all of UTF-8 — passed through as its own bytes. Matching this
 * exactly is what lets the comparison be a byte diff.
 */
/* By explicit length, so a text node's embedded NUL is escaped as \u0000
 * rather than ending the string one byte in. */
static int out_json_string_n(Out *o, const char *s, size_t len) {
    if (out_put(o, "\"", 1) < 0) return -1;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  if (out_put(o, "\\\"", 2) < 0) return -1; break;
            case '\\': if (out_put(o, "\\\\", 2) < 0) return -1; break;
            case '\b': if (out_put(o, "\\b", 2) < 0) return -1; break;
            case '\f': if (out_put(o, "\\f", 2) < 0) return -1; break;
            case '\n': if (out_put(o, "\\n", 2) < 0) return -1; break;
            case '\r': if (out_put(o, "\\r", 2) < 0) return -1; break;
            case '\t': if (out_put(o, "\\t", 2) < 0) return -1; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof buf, "\\u%04x", c);
                    if (out_str(o, buf) < 0) return -1;
                } else if (out_put(o, (const char *)&s[i], 1) < 0) return -1;
        }
    }
    return out_put(o, "\"", 1);
}
/* For interned names and property strings, which never carry a NUL. */
static int out_json_string(Out *o, const char *s) {
    return out_json_string_n(o, s, strlen(s));
}

/** A number the way JSON.stringify writes one: an integer with no `.0`. */
static int out_number(Out *o, double v) {
    char buf[40];
    /* JSON cannot write an infinity or a NaN, so `null` — JSON.stringify's
     * answer, and yaml.c's json_number's. */
    if (v != v || v > 1.7976931348623157e308 || v < -1.7976931348623157e308)
        snprintf(buf, sizeof buf, "null");
    else mdy_format_number(buf, sizeof buf, v);
    return out_str(o, buf);
}

void mdy_format_number(char *out, size_t cap, double v) {
    /* Range test BEFORE the cast: `(long long)v` is undefined outside the
     * type's range. */
    if (v > -9.2e18 && v < 9.2e18 && v == (double)(long long)v) {
        snprintf(out, cap, "%lld", (long long)v);
        return;
    }
    for (int digits = 15; digits <= 17; digits++) {
        snprintf(out, cap, "%.*g", digits, v);
        if (strtod(out, NULL) == v) return;
    }
}

double mdy_js_number(const char *s, size_t len) {
    mdy_trim(&s, &len);
    if (len == 0) return 0;                          /* Number('') is 0 */
    char small[64];
    if (len >= sizeof small) return NAN;             /* longer than any number */
    memcpy(small, s, len);
    small[len] = '\0';
    const char *t = small;
    int neg = 0;
    if (*t == '+' || *t == '-') { neg = *t == '-'; t++; }
    if (strcmp(t, "Infinity") == 0) return neg ? -INFINITY : INFINITY;
    if (t[0] == '0' && (t[1] == 'x' || t[1] == 'X' || t[1] == 'o' || t[1] == 'O' ||
                        t[1] == 'b' || t[1] == 'B')) {
        if (t != small) return NAN;                  /* no sign on a prefixed literal */
        int base = (t[1] == 'x' || t[1] == 'X') ? 16 : (t[1] == 'o' || t[1] == 'O') ? 8 : 2;
        if (!t[2]) return NAN;
        double v = 0;
        for (const char *d = t + 2; *d; d++) {
            int digit = (*d >= '0' && *d <= '9') ? *d - '0'
                      : (*d >= 'a' && *d <= 'f') ? *d - 'a' + 10
                      : (*d >= 'A' && *d <= 'F') ? *d - 'A' + 10 : 99;
            if (digit >= base) return NAN;
            v = v * base + digit;
        }
        return v;
    }
    /* A decimal literal: digits, an optional point and fraction, an optional
     * exponent — and nothing strtod admits beyond that (hex, inf, nan). */
    const char *d = t;
    size_t digits = 0;
    while (*d >= '0' && *d <= '9') { d++; digits++; }
    if (*d == '.') { d++; while (*d >= '0' && *d <= '9') { d++; digits++; } }
    if (digits == 0) return NAN;
    if (*d == 'e' || *d == 'E') {
        d++;
        if (*d == '+' || *d == '-') d++;
        if (!(*d >= '0' && *d <= '9')) return NAN;
        while (*d >= '0' && *d <= '9') d++;
    }
    if (*d) return NAN;
    return strtod(small, NULL);
}

static int emit(Out *o, const mdy_node *n) {
    switch (n->type) {
        case MDY_TEXT:
            if (out_str(o, "{\"type\":\"text\",\"value\":") < 0) return -1;
            if (out_json_string_n(o, n->text ? n->text : "", mdy_text_len(n)) < 0) return -1;
            return out_put(o, "}", 1);

        case MDY_DOCTYPE:
            return out_str(o, "{\"type\":\"doctype\"}");

        /* Neither is produced by this parser — see mdy_node_type — but the
         * tree model can hold them, so the emitter has to be able to write
         * them or a tree that round-trips through JSON would lose them. */
        case MDY_COMMENT:
            if (out_str(o, "{\"type\":\"comment\",\"value\":") < 0) return -1;
            if (out_json_string_n(o, n->text ? n->text : "", mdy_text_len(n)) < 0) return -1;
            return out_put(o, "}", 1);

        case MDY_RAW:
            if (out_str(o, "{\"type\":\"raw\",\"value\":") < 0) return -1;
            if (out_json_string_n(o, n->text ? n->text : "", mdy_text_len(n)) < 0) return -1;
            return out_put(o, "}", 1);

        case MDY_ROOT:
            if (out_str(o, "{\"type\":\"root\",\"children\":[") < 0) return -1;
            break;

        case MDY_ELEMENT:
            if (out_str(o, "{\"type\":\"element\",\"tagName\":") < 0) return -1;
            if (out_json_string(o, n->tag) < 0) return -1;
            if (out_str(o, ",\"properties\":{") < 0) return -1;
            for (const mdy_prop *p = n->props; p; p = p->next) {
                if (p != n->props && out_put(o, ",", 1) < 0) return -1;
                if (out_json_string(o, p->name) < 0) return -1;
                if (out_put(o, ":", 1) < 0) return -1;
                switch (p->type) {
                    case MDY_PROP_STRING: if (out_json_string(o, p->as.string) < 0) return -1; break;
                    case MDY_PROP_NUMBER: if (out_number(o, p->as.number) < 0) return -1; break;
                    case MDY_PROP_BOOL:   if (out_str(o, p->as.boolean ? "true" : "false") < 0) return -1; break;
                    case MDY_PROP_LIST:
                        if (out_put(o, "[", 1) < 0) return -1;
                        for (size_t i = 0; i < p->list_len; i++) {
                            if (i && out_put(o, ",", 1) < 0) return -1;
                            if (out_json_string(o, p->list[i]) < 0) return -1;
                        }
                        if (out_put(o, "]", 1) < 0) return -1;
                        break;
                }
            }
            if (out_str(o, "},\"children\":[") < 0) return -1;
            break;
    }

    for (const mdy_node *c = n->first; c; c = c->next) {
        if (c != n->first && out_put(o, ",", 1) < 0) return -1;
        if (emit(o, c) < 0) return -1;
    }
    if (out_put(o, "]", 1) < 0) return -1;

    /*
     * The unist position, LAST — which is where JSON.stringify puts it, since
     * hast builds the node before attaching one. Only block elements have it;
     * a zero line means none.
     */
    if (o->positions && n->line) {
        char buf[128];
        snprintf(buf, sizeof buf,
                 ",\"position\":{\"start\":{\"line\":%u,\"column\":%u},"
                 "\"end\":{\"line\":%u,\"column\":%u}}",
                 n->line, n->column, n->end_line, n->end_column);
        if (out_str(o, buf) < 0) return -1;
    }
    return out_put(o, "}", 1);
}

char *mdy_to_json(const mdy_node *node) {
    Out o = { .positions = 1 };
    if (!node || emit(&o, node) < 0) { free(o.s); return NULL; }
    return o.s ? o.s : calloc(1, 1);
}

/** The same, without positions — structure alone. */
char *mdy_to_json_bare(const mdy_node *node) {
    Out o = { 0 };
    if (!node || emit(&o, node) < 0) { free(o.s); return NULL; }
    return o.s ? o.s : calloc(1, 1);
}
