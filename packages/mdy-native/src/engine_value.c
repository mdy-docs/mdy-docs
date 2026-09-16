/*
 * The VM boundary: values in and out of lamassu.
 *
 * Strings (UTF-8 here, UTF-16 there), trees (hast as objects and back), and a
 * query filter or its answer as binjson. Nothing in this file knows what a
 * document is or what a render does — it is called by every other part of the
 * engine and calls none of them.
 */
#include "engine_internal.h"
#include "xalloc.h"

/* ---- strings across the boundary ------------------------------------------- */

/*
 * The UTF-16 boundary, which is what lamassu's strings are.
 *
 * The conversion is the PARSER's — mdy_to_utf16 and mdy_from_utf16, over
 * mdy_utf8_decode — so the same bytes mean the same thing whichever way they
 * entered the process. This file had a second pair of its own, and they were
 * not the same function: they took any byte that was not an ASCII one or a
 * 2- or 3-byte lead as the start of a FOUR-byte character and consumed four
 * bytes without checking that the three after it were continuations. So
 * `\xc0\xaf` — an overlong `/`, the encoding a path check is meant to refuse —
 * came out as a real `/`; a surrogate spelled in UTF-8 came out unchanged;
 * and a single stray `\x80` in a paragraph ate the three bytes after it, which
 * is how `and \x80 end` came back as `and <mojibake>d`. node replaces each
 * ill-formed byte with U+FFFD and leaves the rest of the line alone, and so
 * does mdy_utf8_decode.
 *
 * Both wrappers still allocate, which is what every caller here wants; the
 * parser's take a buffer because its callers have one.
 *
 * They allocate through xalloc.h, and the reason is the whole of that file:
 * a string that fails to convert has no way to say so from here. `str` used
 * to return js_undefined() and `key` an undefined ATOM, so an allocation
 * failure did not stop a build -- it moved a property to a different name and
 * let the build finish, reporting success. See xalloc.h.
 */
uint16_t *to_utf16(const char *in, size_t len, size_t *out_len) {
    /* Never more than one unit per byte: a character that is two units is at
     * least four bytes, and an ill-formed one is one byte and one U+FFFD. */
    uint16_t *out = mdy_xmalloc((len + 1) * sizeof *out);
    *out_len = mdy_to_utf16(in, len, out, len + 1);
    return out;
}

char *from_utf16(const uint16_t *u, size_t len) {
    /* Never more than three bytes per unit: a surrogate pair is two units and
     * four bytes, and a lone surrogate is one unit and a three-byte U+FFFD. */
    char *out = mdy_xmalloc(len * 3 + 1);
    size_t n = mdy_from_utf16(u, len, out, len * 3);
    out[n] = '\0';
    return out;
}

JsValue str(JsVm *vm, const char *s, size_t len) {
    size_t n = 0;
    uint16_t *u = to_utf16(s, len, &n);
    JsValue v = js_string_new(vm, u, n);
    free(u);
    return v;
}

JsValue key(JsVm *vm, const char *s) {
    /*
     * Building a key is a safe point — that is the rule below, and it is why
     * set_val builds its key INSIDE, after the value is rooted. But js_atom of
     * an atom that is ALREADY interned allocates nothing, so the VM's own
     * gc_stress never collects here, and every "_id"/"path" after the first
     * one in a process is already interned. So a read of an UNROOTED object
     * is correct only for as long as the atom it asks for happens to be old,
     * which is a hole that does not show until the day it does.
     *
     * So under MDY_GC_STRESS a key costs a collection whether it interns or
     * not, and the rule is enforced rather than assumed. It found twelve
     * failures the first time it ran. Cost: check-engine goes from 0.9s to
     * 1.3s, under a flag no build uses.
     */
    static int stress = -1;
    if (stress < 0) stress = getenv("MDY_GC_STRESS") != NULL;
    if (stress) js_gc_collect(vm);
    size_t n = 0;
    uint16_t *u = to_utf16(s, strlen(s), &n);
    JsValue v = js_atom(vm, u, n);
    free(u);
    return v;
}

/*
 * A property set and an array push that ROOT what they are handed.
 *
 * js_object_set takes a garbage-collection safe point before it writes, and
 * its contract is that the caller has rooted the object, the key and the
 * value. A value this file has just built is reachable only from the C stack,
 * which the collector does not scan — so a collection at that safe point frees
 * it, the map keeps a dangling pointer, and the cell is handed to the next
 * string that asks for one. The property then silently becomes a DIFFERENT
 * one, with no crash and no error.
 *
 * That is not hypothetical: `link-titles` in a 642-key record came back with
 * `guraeans` gone and `hajj` present twice, so one link in a 93-page site
 * pointed at the wrong place. It reproduced only in a build long enough to
 * collect part-way through decoding a record.
 *
 * The key is built INSIDE, after the value is rooted, because building it
 * allocates too — a key made first, in the caller's argument list, can be
 * collected while the value beside it is still being built.
 */
void set_val(mdy_engine *e, JsValue obj, const char *name, JsValue v) {
    js_gc_protect(e->vm, &obj);
    js_gc_protect(e->vm, &v);
    JsValue k = key(e->vm, name);
    js_gc_protect(e->vm, &k);
    /* A set the VM could not make is a property missing from a record or a
     * tree, and a page written without it. There is no channel back from a
     * void setter, so it ends the run. See xalloc.h. */
    if (!js_object_set(e->vm, obj, k, v)) mdy_fatal("the VM could not set a property");
    js_gc_unprotect(e->vm, &k);
    js_gc_unprotect(e->vm, &v);
    js_gc_unprotect(e->vm, &obj);
}

/*
 * ...and the read, which has the same hazard from the other side.
 *
 * `js_object_get(e->vm, thing, key(e->vm, "path"))` is wrong whenever `thing`
 * is reachable only from the C stack: C does not say which argument is
 * evaluated first, and building the key is a safe point, so the object can be
 * collected before the get it was an argument to. It survives when the atom
 * is already interned, which is nearly always — which is why such a bug
 * hides. Every read in the engine goes through here.
 *
 * Rooting the object here — and building the key after, as set_val does —
 * makes the whole shape safe by construction, including for an object that is
 * an rvalue at the call site (`get_val(e, document_record(e, i), "path")`):
 * the parameter is this function's own stack slot, and its address is what the
 * collector is given.
 *
 * The value comes back unrooted, as js_object_get's did — but it is a PROPERTY
 * of `obj`, so the collector reaches it through `obj` for as long as `obj`
 * itself is reachable. That is why the tree walk can read `children` and
 * recurse through it without rooting anything: the root of that walk is rooted
 * by its caller and everything below is reachable from it. A caller that keeps
 * a read value after the object it came from may have gone is the case that
 * needs js_gc_protect of its own.
 *
 * js_object_get allocates nothing (a hash lookup, and js_object_key_lookup
 * only FINDS an atom), so the get is not itself a safe point. The key is the
 * whole of the hazard.
 */
JsValue get_val(mdy_engine *e, JsValue obj, const char *name) {
    js_gc_protect(e->vm, &obj);
    JsValue k = key(e->vm, name);
    js_gc_protect(e->vm, &k);
    JsValue v = js_object_get(e->vm, obj, k);
    js_gc_unprotect(e->vm, &k);
    js_gc_unprotect(e->vm, &obj);
    return v;
}

void push_item(mdy_engine *e, JsValue array, JsValue v) {
    js_gc_protect(e->vm, &array);
    js_gc_protect(e->vm, &v);
    if (!js_array_push(e->vm, array, v)) mdy_fatal("the VM could not append to an array");
    js_gc_unprotect(e->vm, &v);
    js_gc_unprotect(e->vm, &array);
}


/* ---- a tree, across the boundary --------------------------------------------
 *
 * `transform((tree) => …)` is the one place a document's own code sees the
 * tree, so the tree has to reach the guest and come back. mdy-docs sends it as
 * JSON in both directions; here it is built as VALUES, which is what
 * js_array_new and js_object_new made possible.
 *
 * The shape is hast's, exactly as the JSON was: every node has a `type`, an
 * element has `tagName`, `properties` and `children`, and a text node has a
 * `value`. A transform written against one works against the other.
 */

JsValue tree_to_js(mdy_engine *e, const mdy_node *n);

static JsValue children_to_js(mdy_engine *e, const mdy_node *n) {
    JsValue array = js_array_new(e->ctx, 0);
    js_gc_protect(e->vm, &array);
    for (const mdy_node *c = n->first; c; c = c->next) {
        JsValue child = tree_to_js(e, c);
        js_gc_protect(e->vm, &child);
        push_item(e, array, child);
        js_gc_unprotect(e->vm, &child);
    }
    js_gc_unprotect(e->vm, &array);
    return array;
}

JsValue tree_to_js(mdy_engine *e, const mdy_node *n) {
    JsValue o = js_object_new(e->ctx);
    js_gc_protect(e->vm, &o);

    switch (n->type) {
        case MDY_TEXT:
        case MDY_RAW:
        case MDY_COMMENT: {
            const char *type = n->type == MDY_TEXT ? "text"
                             : n->type == MDY_RAW ? "raw" : "comment";
            set_val(e, o, "type", str(e->vm, type, strlen(type)));
            const char *v = n->text ? n->text : "";
            set_val(e, o, "value", str(e->vm, v, strlen(v)));
            break;
        }
        case MDY_DOCTYPE:
            set_val(e, o, "type", str(e->vm, "doctype", 7));
            break;
        case MDY_ROOT:
            set_val(e, o, "type", str(e->vm, "root", 4));
            set_val(e, o, "children", children_to_js(e, n));
            break;
        case MDY_ELEMENT: {
            set_val(e, o, "type", str(e->vm, "element", 7));
            set_val(e, o, "tagName", str(e->vm, n->tag, strlen(n->tag)));
            JsValue props = js_object_new(e->ctx);
            js_gc_protect(e->vm, &props);
            for (const mdy_prop *p = n->props; p; p = p->next) {
                JsValue v;
                switch (p->type) {
                    case MDY_PROP_STRING: v = str(e->vm, p->as.string, strlen(p->as.string)); break;
                    case MDY_PROP_NUMBER: v = js_number(p->as.number); break;
                    case MDY_PROP_BOOL:   v = js_bool(p->as.boolean != 0); break;
                    case MDY_PROP_LIST: {
                        v = js_array_new(e->ctx, (uint32_t)p->list_len);
                        js_gc_protect(e->vm, &v);
                        for (size_t i = 0; i < p->list_len; i++)
                            push_item(e, v, str(e->vm, p->list[i], strlen(p->list[i])));
                        js_gc_unprotect(e->vm, &v);
                        break;
                    }
                    default: v = js_undefined();
                }
                set_val(e, props, p->name, v);
            }
            set_val(e, o, "properties", props);
            js_gc_unprotect(e->vm, &props);
            set_val(e, o, "children", children_to_js(e, n));
            break;
        }
    }

    js_gc_unprotect(e->vm, &o);
    return o;
}

/* The string a JS value holds, as UTF-8. Caller frees. NULL when it is not a
 * string — which for a `type` or a `tagName` means the guest handed back
 * something that is not a node. */
char *js_string_utf8(JsValue v) {
    return js_string_utf8_n(v, NULL);
}

char *js_string_utf8_n(JsValue v, size_t *len) {
    size_t ulen = 0;
    const uint16_t *u = js_string_units(v, &ulen);
    if (!u) return NULL;
    char *out = mdy_xmalloc(ulen * 3 + 1);
    size_t n = mdy_from_utf16(u, ulen, out, ulen * 3);
    out[n] = '\0';
    if (len) *len = n;
    return out;
}

/*
 * A tree the guest built, as C nodes — `$.node`, and what a transform hands
 * back. `depth` is counted for the reason MDY_MAX_DEPTH exists: a document
 * can write a fifty-thousand-deep tree in three lines of its own code, and
 * everything that walks the result afterwards recurses over it. Past the
 * limit the branch is dropped, which is the answer the parser gives text
 * nested that deep.
 */
/*
 * One conversion's walk: the objects on the path down from the root, so a
 * node that is its own ancestor is refused rather than descended for ever,
 * and how many nodes have been made, so a tree that names one subtree from
 * many places — legal, and exponential in its depth — stops at a budget.
 * Both are what JSON.stringify would do with the same value, give or take
 * the budget.
 */
typedef struct {
    JsValue path[MDY_MAX_DEPTH];
    size_t nodes;
} Walk;

static mdy_node *js_to_tree_at(mdy_engine *e, mdy_doc *doc, JsValue v, size_t depth, Walk *w);

mdy_node *js_to_tree(mdy_engine *e, mdy_doc *doc, JsValue v) {
    Walk w = { .nodes = 0 };
    e->compose.tree_fault = NULL;
    return js_to_tree_at(e, doc, v, 0, &w);
}

static void js_children_to_tree_at(mdy_engine *e, mdy_doc *doc, mdy_node *parent,
                                   JsValue kids, size_t depth, Walk *w) {
    if (!js_is_array(kids)) return;
    uint32_t n = js_array_length(kids);
    for (uint32_t i = 0; i < n && !e->compose.tree_fault; i++) {
        mdy_node *child = js_to_tree_at(e, doc, js_array_get(kids, i), depth, w);
        if (child) mdy_append(parent, child);
    }
}

void js_children_to_tree(mdy_engine *e, mdy_doc *doc, mdy_node *parent, JsValue kids) {
    Walk w = { .nodes = 0 };
    e->compose.tree_fault = NULL;
    js_children_to_tree_at(e, doc, parent, kids, 1, &w);
}

static mdy_node *js_to_tree_at(mdy_engine *e, mdy_doc *doc, JsValue v, size_t depth, Walk *w) {
    if (e->compose.tree_fault) return NULL;
    if (depth >= MDY_MAX_DEPTH) return NULL;
    if (!js_is_object(v)) return NULL;
    for (size_t i = 0; i < depth; i++) {
        if (js_same_value(w->path[i], v)) {
            e->compose.tree_fault = "mdy: the tree refers to itself: a node is its own ancestor";
            return NULL;
        }
    }
    if (++w->nodes > MDY_TREE_NODES_MAX) {
        e->compose.tree_fault = "mdy: the tree has more nodes than this engine will convert";
        return NULL;
    }
    w->path[depth] = v;

    char *type = js_string_utf8(get_val(e, v, "type"));
    if (!type) return NULL;

    mdy_node *out = NULL;
    if (strcmp(type, "text") == 0 || strcmp(type, "raw") == 0 || strcmp(type, "comment") == 0) {
        char *value = js_string_utf8(get_val(e, v, "value"));
        out = mdy_new_text(doc, value ? value : "", value ? strlen(value) : 0);
        if (out) out->type = strcmp(type, "raw") == 0 ? MDY_RAW
                           : strcmp(type, "comment") == 0 ? MDY_COMMENT : MDY_TEXT;
        free(value);
    } else if (strcmp(type, "doctype") == 0) {
        out = mdy_new_text(doc, "", 0);
        if (out) out->type = MDY_DOCTYPE;
    } else if (strcmp(type, "root") == 0) {
        out = mdy_new_text(doc, "", 0);
        if (out) {
            out->type = MDY_ROOT;
            out->text = NULL;
            js_children_to_tree_at(e, doc, out, get_val(e, v, "children"), depth + 1, w);
        }
    } else if (strcmp(type, "element") == 0) {
        char *tag = js_string_utf8(get_val(e, v, "tagName"));
        out = mdy_new_element(doc, tag ? tag : "div", tag ? strlen(tag) : 3);
        free(tag);
        if (out) {
            /*
             * Properties come back by NAME, and the names a guest may have
             * added are not known in advance — so this walks whatever is
             * there rather than a fixed list. `className` is the one that is
             * an array; everything else is a string, a number or a boolean.
             */
            JsValue props = get_val(e, v, "properties");
            if (js_is_object(props)) {
                for (size_t i = 0; i < js_object_size(props); i++) {
                    JsValue name = js_object_key_at(props, i);
                    char *pname = js_string_utf8(name);
                    if (!pname) continue;
                    JsValue pv = js_object_get(e->vm, props, name);
                    if (js_is_array(pv)) {
                        uint32_t n = js_array_length(pv);
                        for (uint32_t k = 0; k < n; k++) {
                            char *item = js_string_utf8(js_array_get(pv, k));
                            if (item && strcmp(pname, "className") == 0) mdy_add_class(doc, out, item);
                            free(item);
                        }
                    } else if (js_is_number(pv)) {
                        /* An infinity or a NaN is null under mdy-docs, and a
                         * null property is one the HTML writer leaves out — so
                         * it is left unset here, which is the same attribute
                         * list — never `data-x="inf"`. */
                        double pn = js_get_number(pv);
                        if (pn == pn && pn <= 1.7976931348623157e308 && pn >= -1.7976931348623157e308)
                            mdy_set_number(doc, out, pname, pn);
                    } else if (js_is_bool(pv)) {
                        mdy_set_bool(doc, out, pname, js_get_bool(pv));
                    } else {
                        char *sv = js_string_utf8(pv);
                        if (sv) mdy_set_string(doc, out, pname, sv, strlen(sv));
                        free(sv);
                    }
                    free(pname);
                }
            }
            js_children_to_tree_at(e, doc, out, get_val(e, v, "children"), depth + 1, w);
        }
    }

    free(type);
    return out;
}


/* ---- a JS value as binjson, for a query filter ------------------------------ */

int js_to_binjson(mdy_engine *e, bj_builder *b, JsValue v) {
    if (js_is_null(v) || js_is_undefined(v)) return bj_put_null(b);
    if (js_is_bool(v)) return bj_put_bool(b, js_get_bool(v));
    if (js_is_number(v)) {
        double d = js_get_number(v);
        /*
         * Non-finite FIRST, for two reasons. It is what mdy-docs sends —
         * `$.find({ big: 1/0 })` is stringified to `{"big":null}`, so it asks
         * the store for null and matches nothing. Asking for the infinity
         * instead matches a record that holds one. And `(int64_t)d` of an
         * infinity or a NaN is undefined behaviour, so the range test has to
         * come before the cast rather than after it.
         */
        if (d != d || d > 1.7976931348623157e308 || d < -1.7976931348623157e308)
            return bj_put_null(b);
        if (d >= -9.2e18 && d <= 9.2e18 && d == (double)(int64_t)d)
            return bj_put_int(b, (int64_t)d);
        return bj_put_float(b, d);
    }
    if (js_is_string(v)) {
        /* At its own length: a NUL inside a JavaScript string is a character
         * of it, and the store holds strings by length too. */
        size_t n = 0;
        char *s = js_string_utf8_n(v, &n);
        if (!s) return -1;
        int rc = bj_put_string(b, (const uint8_t *)s, (uint32_t)n);
        free(s);
        return rc;
    }
    if (js_is_array(v)) {
        if (bj_begin_array(b) != 0) return -1;
        uint32_t n = js_array_length(v);
        for (uint32_t i = 0; i < n; i++)
            if (js_to_binjson(e, b, js_array_get(v, i)) != 0) return -1;
        return bj_end_array(b);
    }
    if (js_is_object(v)) {
        if (bj_begin_object(b) != 0) return -1;
        size_t n = js_object_size(v);
        for (size_t i = 0; i < n; i++) {
            JsValue k = js_object_key_at(v, i);
            size_t klen = 0;
            char *name = js_string_utf8_n(k, &klen);
            if (!name) continue;
            int rc = bj_put_key(b, (const uint8_t *)name, (uint32_t)klen);
            free(name);
            if (rc != 0) return -1;
            if (js_to_binjson(e, b, js_object_get(e->vm, v, k)) != 0) return -1;
        }
        return bj_end_object(b);
    }
    return bj_put_null(b);
}

/* ---- binjson back as JS values ----------------------------------------------
 *
 * The decoder is a visitor, so this keeps a stack of the containers it is
 * inside and hangs each finished value on whichever is on top.
 */
/* binjson's own nesting limit, so a document the store holds always decodes. */
enum { BJ_STACK_MAX = 1000 };

typedef struct {
    mdy_engine *e;
    JsValue stack[BJ_STACK_MAX];
    char *keys[BJ_STACK_MAX];
    int depth;
    JsValue result;
    int have_result;
    int failed;       /* nesting past BJ_STACK_MAX: the whole decode is rejected */
} Decode;

static void decode_put(Decode *d, JsValue v) {
    if (d->failed) return;
    if (d->depth == 0) { d->result = v; d->have_result = 1; return; }
    JsValue parent = d->stack[d->depth - 1];
    if (js_is_array(parent)) {
        push_item(d->e, parent, v);
    } else {
        char *k = d->keys[d->depth - 1];
        if (k) {
            set_val(d->e, parent, k, v);
            free(k);
            d->keys[d->depth - 1] = NULL;
        }
    }
}

/*
 * A number the guest can hold, or null.
 *
 * This is the crossing mdy-docs makes with JSON.stringify, and JSON has no
 * way to write infinity or a NaN: `JSON.stringify({a: Infinity})` is
 * `{"a":null}`. A store CAN hold one — `big: .inf` in front matter is legal
 * YAML and node's parser reads it as a real Infinity — so the two engines
 * agreed about the record and disagreed about what the document saw:
 * `{{ res.data.big }}` rendered `Infinity` here and `null` there.
 *
 * Infinity is what the store keeps, on both sides. null is what crosses.
 */
static JsValue finite_or_null(double v) {
    return (v != v || v > 1.7976931348623157e308 || v < -1.7976931348623157e308)
               ? js_null() : js_number(v);
}

static void d_null(void *ctx) { decode_put(ctx, js_null()); }
static void d_bool(void *ctx, int t) { decode_put(ctx, js_bool(t != 0)); }
static void d_int(void *ctx, double v) { decode_put(ctx, finite_or_null(v)); }
static void d_float(void *ctx, double v) { decode_put(ctx, finite_or_null(v)); }
static void d_date(void *ctx, double v) { decode_put(ctx, finite_or_null(v)); }
static void d_pointer(void *ctx, double v) { decode_put(ctx, finite_or_null(v)); }
static void d_string(void *ctx, const uint8_t *s, uint32_t n) {
    Decode *d = ctx;
    decode_put(d, str(d->e->vm, (const char *)s, n));
}
static void d_binary(void *ctx, const uint8_t *s, uint32_t n) {
    (void)s; (void)n;
    decode_put(ctx, js_null());
}
/* `_id` is an OID, and a document set's own key: guest code has no use for
 * the bytes, and a string of them is the shape mdy-docs hands over. */
static void d_oid(void *ctx, const uint8_t *b) {
    Decode *d = ctx;
    char hex[OID_HEX_LEN + 1];
    static const char *H = "0123456789abcdef";
    for (int i = 0; i < 12; i++) { hex[i * 2] = H[b[i] >> 4]; hex[i * 2 + 1] = H[b[i] & 15]; }
    hex[OID_HEX_LEN] = '\0';
    decode_put(d, str(d->e->vm, hex, OID_HEX_LEN));
}
/*
 * A container under construction is rooted through ITS SLOT ON THE STACK, not
 * through a local.
 *
 * js_gc_protect records an ADDRESS and the collector dereferences it later; a
 * local's address is dead the moment the callback returns, so protecting `&a`
 * here left the root table pointing into a reused stack frame. Nothing went
 * wrong until a collection happened to land mid-decode, and then the GC read
 * whatever was in that slot and tried to mark it — a crash whose cause is
 * nowhere near where it lands. `Decode` lives for the whole decode, so its
 * slots are the addresses that are actually valid to hand out.
 */
/*
 * A `begin` past the stack limit does NOT just get dropped: its matching `end`
 * would still pop, closing a real parent early and folding every later value
 * into the wrong container — a silently different record. So the whole decode
 * is failed here (as bjval.c's push does) and every callback becomes a no-op
 * from this point, leaving the stack frozen for the unwind in binjson_to_js to
 * release. A store value nested past 64 is already corrupt; rejecting it beats
 * decoding it wrong.
 */
static void d_array_begin(void *ctx, uint32_t count) {
    Decode *d = ctx;
    if (d->failed) return;
    if (d->depth >= BJ_STACK_MAX) { d->failed = 1; return; }
    d->stack[d->depth] = js_array_new(d->e->ctx, count);
    js_gc_protect(d->e->vm, &d->stack[d->depth]);
    d->keys[d->depth] = NULL;
    d->depth++;
}
static void d_object_begin(void *ctx, uint32_t count) {
    Decode *d = ctx;
    (void)count;
    if (d->failed) return;
    if (d->depth >= BJ_STACK_MAX) { d->failed = 1; return; }
    d->stack[d->depth] = js_object_new(d->e->ctx);
    js_gc_protect(d->e->vm, &d->stack[d->depth]);
    d->keys[d->depth] = NULL;
    d->depth++;
}
static void d_key(void *ctx, const uint8_t *s, uint32_t n) {
    Decode *d = ctx;
    if (d->failed) return;
    if (d->depth == 0) return;
    free(d->keys[d->depth - 1]);
    char *k = mdy_xmalloc(n + 1);
    memcpy(k, s, n);
    k[n] = '\0';
    d->keys[d->depth - 1] = k;
}
static void d_end(void *ctx) {
    Decode *d = ctx;
    if (d->failed) return;
    if (d->depth == 0) return;
    int at = --d->depth;
    free(d->keys[at]);
    d->keys[at] = NULL;
    /* Still rooted through its slot while decode_put allocates into the
     * parent: unprotecting first would let the finished value be collected by
     * the very push meant to keep it. */
    decode_put(d, d->stack[at]);
    js_gc_unprotect(d->e->vm, &d->stack[at]);
}

JsValue binjson_to_js(mdy_engine *e, const uint8_t *bytes, size_t len, size_t *consumed) {
    Decode d = {0};
    d.e = e;
    d.result = js_undefined();
    bj_visitor v = {
        .on_null = d_null, .on_bool = d_bool, .on_int = d_int, .on_float = d_float,
        .on_string = d_string, .on_binary = d_binary, .on_oid = d_oid, .on_date = d_date,
        .on_pointer = d_pointer, .on_array_begin = d_array_begin, .on_array_end = d_end,
        .on_object_begin = d_object_begin, .on_key = d_key, .on_object_end = d_end,
        .ctx = &d,
    };
    /* The finished value is a root too — a container completing puts it here
     * while the decode is still allocating. */
    js_gc_protect(e->vm, &d.result);
    int rc = bj_decode(bytes, len, &v, consumed);
    /*
     * A container is protected through its stack slot by d_array_begin /
     * d_object_begin and unprotected by the matching d_end. A truncated or
     * corrupt value aborts the decode with a begin that never got its end, so
     * those slots — and the key strings under them — are still live here. A
     * clean decode has already unwound to depth 0, so this loop runs only on
     * the abort path; leaving it out would keep the root table pointing into
     * this frame after it returns, and leak the keys.
     */
    while (d.depth > 0) {
        int at = --d.depth;
        free(d.keys[at]);
        js_gc_unprotect(e->vm, &d.stack[at]);
    }
    js_gc_unprotect(e->vm, &d.result);
    return (rc == 0 && !d.failed) ? d.result : js_undefined();
}
