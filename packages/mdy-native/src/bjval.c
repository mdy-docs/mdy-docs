/* See bjval.h. A bj_decode visitor that builds the tree it is shown. */
#include <stdio.h>
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

typedef struct { char *s; size_t len, cap; } Out;
static void put(Out *o, const char *s, size_t n) {
    if (o->len + n + 1 > o->cap) { while (o->len + n + 1 > o->cap) o->cap = o->cap ? o->cap * 2 : 256; o->s = realloc(o->s, o->cap); }
    memcpy(o->s + o->len, s, n); o->len += n; o->s[o->len] = 0;
}
static void put_string(Out *o, const char *s) {
    put(o, "\"", 1);
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        char buf[8];
        if (*p == '"' || *p == '\\') { buf[0] = '\\'; buf[1] = (char)*p; put(o, buf, 2); }
        else if (*p == '\n') put(o, "\\n", 2);
        else if (*p == '\r') put(o, "\\r", 2);
        else if (*p == '\t') put(o, "\\t", 2);
        else if (*p < 0x20) { snprintf(buf, sizeof buf, "\\u%04x", *p); put(o, buf, 6); }
        else put(o, (const char *)p, 1);
    }
    put(o, "\"", 1);
}
static void write_json(Out *o, const bjv *v) {
    char buf[40];
    switch (v->type) {
        case BJV_NULL: put(o, "null", 4); break;
        case BJV_BOOL: put(o, v->number ? "true" : "false", v->number ? 4 : 5); break;
        case BJV_NUMBER:
            if (v->number == (double)(long long)v->number && v->number < 1e15 && v->number > -1e15)
                snprintf(buf, sizeof buf, "%lld", (long long)v->number);
            else snprintf(buf, sizeof buf, "%.17g", v->number);
            put(o, buf, strlen(buf));
            break;
        case BJV_STRING: put_string(o, v->string); break;
        case BJV_BINARY:
            put(o, "[", 1);
            for (size_t i = 0; i < v->len; i++) { snprintf(buf, sizeof buf, "%s%u", i ? "," : "", v->bytes[i]); put(o, buf, strlen(buf)); }
            put(o, "]", 1);
            break;
        case BJV_ARRAY:
            put(o, "[", 1);
            for (size_t i = 0; i < v->count; i++) { if (i) put(o, ",", 1); write_json(o, v->items[i]); }
            put(o, "]", 1);
            break;
        case BJV_OBJECT:
            put(o, "{", 1);
            for (size_t i = 0; i < v->count; i++) { if (i) put(o, ",", 1); put_string(o, v->keys[i]); put(o, ":", 1); write_json(o, v->items[i]); }
            put(o, "}", 1);
            break;
    }
}
char *bjv_to_json(const bjv *v) {
    Out o = { 0 };
    if (!v) { put(&o, "null", 4); return o.s; }
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
