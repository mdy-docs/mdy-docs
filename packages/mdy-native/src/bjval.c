/* See bjval.h. A bj_decode visitor that builds the tree it is shown. */
#include <stdlib.h>
#include <string.h>

#include "binjson.h"
#include "bjval.h"

typedef struct {
    bjv *root;
    bjv *stack[64];
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
        parent->cap = parent->cap ? parent->cap * 2 : 8;
        parent->items = realloc(parent->items, parent->cap * sizeof *parent->items);
        if (parent->type == BJV_OBJECT) parent->keys = realloc(parent->keys, parent->cap * sizeof *parent->keys);
    }
    if (parent->type == BJV_OBJECT) parent->keys[parent->count] = b->pending_key ? b->pending_key : strdup("");
    b->pending_key = NULL;
    parent->items[parent->count++] = v;
}

static void push(Builder *b, bjv *v) {
    attach(b, v);
    if (v && b->depth < 64) b->stack[b->depth++] = v;
    else b->failed = 1;
}
static void pop(Builder *b) { if (b->depth) b->depth--; }

static void on_null(void *c) { attach(c, node(BJV_NULL)); }
static void on_bool(void *c, int t) { bjv *v = node(BJV_BOOL); if (v) v->number = t ? 1 : 0; attach(c, v); }
static void on_num(void *c, double d) { bjv *v = node(BJV_NUMBER); if (v) v->number = d; attach(c, v); }
static void on_string(void *c, const uint8_t *s, uint32_t n) {
    bjv *v = node(BJV_STRING);
    if (v) { v->string = malloc(n + 1); memcpy(v->string, s, n); v->string[n] = 0; v->len = n; }
    attach(c, v);
}
static void on_binary(void *c, const uint8_t *s, uint32_t n) {
    bjv *v = node(BJV_BINARY);
    if (v) { v->bytes = malloc(n + 1); memcpy(v->bytes, s, n); v->bytes[n] = 0; v->len = n; }
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
    memcpy(b->pending_key, s, n);
    b->pending_key[n] = 0;
}
static void on_object_end(void *c) { pop(c); }

bjv *bjv_decode(const uint8_t *data, size_t len) {
    Builder b = { 0 };
    bj_visitor v = {
        on_null, on_bool, on_num, on_num, on_string, on_binary, on_oid, on_num, on_num,
        on_array_begin, on_array_end, on_object_begin, on_key, on_object_end, &b
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
