/* See bjval.h. A bj_decode visitor that builds the tree it is shown. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "binjson.h"
#include "bjval.h"
#include "xalloc.h"

typedef struct {
    bjv *root;
    bjv *stack[BJ_MAX_DEPTH];   /* binjson's own limit, so nothing it decodes is refused here */
    size_t depth;
    char *pending_key;       /* the key the next value in an object goes under */
    int failed;
} Builder;

static bjv *node(bjv_type t) {
    bjv *v = calloc(1, sizeof *v);
    if (v) v->type = t;
    return v;
}

static void attach(Builder *b, bjv *v) {
    if (!v) { b->failed = 1; return; }
    if (b->depth == 0) { b->root = v; return; }
    bjv *parent = b->stack[b->depth - 1];
    if (parent->count == parent->cap) {
        /* `cap` is committed only once the allocation is real: an unchecked
         * realloc left `items`/`keys` NULL for the writes below, and doubling
         * cap first would have told the next attach there was room that a
         * failed realloc never made. Failure sets `failed`, which bjv_decode
         * turns into a NULL return. */
        size_t ncap = parent->cap ? parent->cap * 2 : 8;
        /* A value that could not be attached is freed here: nothing else
         * holds it, and bjv_decode frees only what hangs off the root. */
        bjv **items = realloc(parent->items, ncap * sizeof *items);
        if (!items) { b->failed = 1; bjv_free(v); return; }
        parent->items = items;
        if (parent->type == BJV_OBJECT) {
            char **keys = realloc(parent->keys, ncap * sizeof *keys);
            if (!keys) { b->failed = 1; bjv_free(v); return; }
            parent->keys = keys;
        }
        parent->cap = ncap;
    }
    if (parent->type == BJV_OBJECT) {
        char *k = b->pending_key ? b->pending_key : strdup("");
        if (!k) { b->failed = 1; bjv_free(v); return; }
        parent->keys[parent->count] = k;
    }
    b->pending_key = NULL;
    parent->items[parent->count++] = v;
}

static void push(Builder *b, bjv *v) {
    attach(b, v);
    if (v && b->depth < BJ_MAX_DEPTH) b->stack[b->depth++] = v;
    else b->failed = 1;
}
static void pop(Builder *b) { if (b->depth) b->depth--; }

static void on_null(void *c) { attach(c, node(BJV_NULL)); }
static void on_bool(void *c, int t) { bjv *v = node(BJV_BOOL); if (v) v->number = t ? 1 : 0; attach(c, v); }
static void on_num(void *c, double d) { bjv *v = node(BJV_NUMBER); if (v) v->number = d; attach(c, v); }
static void on_string(void *c, const uint8_t *s, uint32_t n) {
    bjv *v = node(BJV_STRING);
    if (v) {
        v->string = malloc(n + 1);
        if (!v->string) { free(v); ((Builder *)c)->failed = 1; return; }
        memcpy(v->string, s, n); v->string[n] = 0; v->len = n;
    }
    attach(c, v);
}
static void on_binary(void *c, const uint8_t *s, uint32_t n) {
    bjv *v = node(BJV_BINARY);
    if (v) {
        v->bytes = malloc(n + 1);
        if (!v->bytes) { free(v); ((Builder *)c)->failed = 1; return; }
        memcpy(v->bytes, s, n); v->bytes[n] = 0; v->len = n;
    }
    attach(c, v);
}
static void on_oid(void *c, const uint8_t *b12) { on_binary(c, b12, 12); }
static void on_array_begin(void *c, uint32_t n) { (void)n; push(c, node(BJV_ARRAY)); }
static void on_array_end(void *c) { pop(c); }
static void on_object_begin(void *c, uint32_t n) { (void)n; push(c, node(BJV_OBJECT)); }
static void on_key(void *c, const uint8_t *s, uint32_t n) {
    Builder *b = c;
    free(b->pending_key);
    b->pending_key = malloc(n + 1);
    if (!b->pending_key) { b->failed = 1; return; }
    memcpy(b->pending_key, s, n);
    b->pending_key[n] = 0;
}
static void on_object_end(void *c) { pop(c); }

bjv *bjv_decode(const uint8_t *data, size_t len) {
    Builder b = { 0 };
    /*
     * By NAME, never positionally: `on_num` stands for four types, so a field
     * reordered in binjson's header — a separate repository that can change
     * under this one — would keep compiling and bind the wrong callback.
     */
    bj_visitor v = {
        .on_null = on_null, .on_bool = on_bool,
        .on_int = on_num, .on_float = on_num, .on_date = on_num, .on_pointer = on_num,
        .on_string = on_string, .on_binary = on_binary, .on_oid = on_oid,
        .on_array_begin = on_array_begin, .on_array_end = on_array_end,
        .on_object_begin = on_object_begin, .on_key = on_key, .on_object_end = on_object_end,
        .ctx = &b,
    };
    int rc = bj_decode(data, len, &v, NULL);
    free(b.pending_key);
    if (rc != 0 || b.failed || !b.root) { bjv_free(b.root); return NULL; }
    return b.root;
}

void bjv_free(bjv *v) {
    if (!v) return;
    for (size_t i = 0; i < v->count; i++) {
        bjv_free(v->items[i]);
        if (v->keys) free(v->keys[i]);
    }
    free(v->items);
    free(v->keys);
    free(v->string);
    free(v->bytes);
    free(v);
}

static void put_string(mdy_sbuf *o, const char *s) {
    mdy_sbuf_put(o, "\"", 1);
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        char buf[8];
        if (*p == '"' || *p == '\\') { buf[0] = '\\'; buf[1] = (char)*p; mdy_sbuf_put(o, buf, 2); }
        else if (*p == '\n') mdy_sbuf_put(o, "\\n", 2);
        else if (*p == '\r') mdy_sbuf_put(o, "\\r", 2);
        else if (*p == '\t') mdy_sbuf_put(o, "\\t", 2);
        else if (*p < 0x20) { snprintf(buf, sizeof buf, "\\u%04x", *p); mdy_sbuf_put(o, buf, 6); }
        else mdy_sbuf_put(o, (const char *)p, 1);
    }
    mdy_sbuf_put(o, "\"", 1);
}
static void write_json(mdy_sbuf *o, const bjv *v) {
    char buf[40];
    switch (v->type) {
        case BJV_NULL: mdy_sbuf_put(o, "null", 4); break;
        case BJV_BOOL: mdy_sbuf_put(o, v->number ? "true" : "false", v->number ? 4 : 5); break;
        case BJV_NUMBER:
            /* `null` for a non-finite, which is what JSON.stringify writes and
             * what yaml.c's json_number already did; and the range test ahead
             * of the cast, since (long long) of an infinity is undefined
             * behaviour. */
            if (v->number != v->number || v->number > 1.7976931348623157e308 ||
                v->number < -1.7976931348623157e308)
                snprintf(buf, sizeof buf, "null");
            else if (v->number < 1e15 && v->number > -1e15 &&
                     v->number == (double)(long long)v->number)
                snprintf(buf, sizeof buf, "%lld", (long long)v->number);
            else snprintf(buf, sizeof buf, "%.17g", v->number);
            mdy_sbuf_put(o, buf, strlen(buf));
            break;
        case BJV_STRING: put_string(o, v->string); break;
        case BJV_BINARY:
            mdy_sbuf_put(o, "[", 1);
            for (size_t i = 0; i < v->len; i++) { snprintf(buf, sizeof buf, "%s%u", i ? "," : "", v->bytes[i]); mdy_sbuf_put(o, buf, strlen(buf)); }
            mdy_sbuf_put(o, "]", 1);
            break;
        case BJV_ARRAY:
            mdy_sbuf_put(o, "[", 1);
            for (size_t i = 0; i < v->count; i++) { if (i) mdy_sbuf_put(o, ",", 1); write_json(o, v->items[i]); }
            mdy_sbuf_put(o, "]", 1);
            break;
        case BJV_OBJECT:
            mdy_sbuf_put(o, "{", 1);
            for (size_t i = 0; i < v->count; i++) { if (i) mdy_sbuf_put(o, ",", 1); put_string(o, v->keys[i]); mdy_sbuf_put(o, ":", 1); write_json(o, v->items[i]); }
            mdy_sbuf_put(o, "}", 1);
            break;
    }
}
char *bjv_to_json(const bjv *v) {
    mdy_sbuf o = { 0 };
    if (!v) { mdy_sbuf_put(&o, "null", 4); return o.s; }
    write_json(&o, v);
    return o.s;
}

const bjv *bjv_get(const bjv *object, const char *key) {
    if (!object || object->type != BJV_OBJECT) return NULL;
    for (size_t i = 0; i < object->count; i++)
        if (strcmp(object->keys[i], key) == 0) return object->items[i];
    return NULL;
}

double bjv_number(const bjv *object, const char *key, double fallback) {
    const bjv *v = bjv_get(object, key);
    return v && (v->type == BJV_NUMBER || v->type == BJV_BOOL) ? v->number : fallback;
}

const char *bjv_string(const bjv *object, const char *key) {
    const bjv *v = bjv_get(object, key);
    return v && v->type == BJV_STRING ? v->string : NULL;
}
