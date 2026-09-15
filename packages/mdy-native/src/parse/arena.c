/*
 * The arena and the intern table. See internal.h for why both exist.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"

#define MDY_BLOCK_MIN (64 * 1024)

void mdy_oom_exit(void) {
    fputs("mdy: out of memory\n", stderr);
    fflush(stderr);
    _Exit(1);
}

void *mdy_alloc(mdy_arena *arena, size_t size) {
    size = (size + 15) & ~(size_t)15;   /* 16-byte aligned, enough for anything here */

    if (!arena->head || arena->head->size - arena->head->used < size) {
        size_t block = MDY_BLOCK_MIN;
        while (block < size + sizeof(mdy_block)) block *= 2;
        mdy_block *next = malloc(block);
        /* See internal.h: this does not return NULL. */
        if (!next) mdy_oom_exit();
        next->next = arena->head;
        next->used = 0;
        next->size = block - sizeof(mdy_block);
        arena->head = next;
        arena->total += block;
    }

    void *p = arena->head->data + arena->head->used;
    arena->head->used += size;
    return p;
}

char *mdy_strdup_n(mdy_arena *arena, const char *s, size_t len) {
    char *out = mdy_alloc(arena, len + 1);
    if (len) memcpy(out, s, len);
    out[len] = '\0';
    return out;
}

void mdy_arena_free(mdy_arena *arena) {
    for (mdy_block *b = arena->head; b;) {
        mdy_block *next = b->next;
        free(b);
        b = next;
    }
    arena->head = NULL;
    arena->total = 0;
}

/* FNV-1a. Masked to the table size at each use, so a grow needs no rehash. */
static uint32_t hash_of(const char *s, size_t len) {
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < len; i++) { h ^= (unsigned char)s[i]; h *= 16777619u; }
    return h;
}

enum { INTERN_BUCKETS_MIN = 128 };

static mdy_interned *intern_find(const mdy_intern_table *table, uint32_t hash,
                                 const char *s, size_t len) {
    if (!table->buckets) return NULL;
    for (mdy_interned *e = table->buckets[hash & table->mask]; e; e = e->next)
        if (e->hash == hash && e->len == len && memcmp(e->text, s, len) == 0) return e;
    return NULL;
}

/* Double the bucket count and relink every entry. The load is held at one
 * entry per bucket, so a chain stays a handful long at any size. */
static void intern_grow(mdy_arena *arena, mdy_intern_table *table) {
    size_t old = table->buckets ? table->mask + 1 : 0;
    size_t cap = old ? old * 2 : INTERN_BUCKETS_MIN;
    mdy_interned **buckets = mdy_alloc(arena, cap * sizeof *buckets);
    memset(buckets, 0, cap * sizeof *buckets);
    for (size_t i = 0; i < old; i++) {
        for (mdy_interned *e = table->buckets[i]; e;) {
            mdy_interned *next = e->next;
            size_t at = e->hash & (cap - 1);
            e->next = buckets[at];
            buckets[at] = e;
            e = next;
        }
    }
    table->buckets = buckets;
    table->mask = cap - 1;
}

const char *mdy_intern(mdy_arena *arena, mdy_intern_table *table, const char *s, size_t len) {
    uint32_t hash = hash_of(s, len);
    mdy_interned *found = intern_find(table, hash, s, len);
    if (found) return found->text;

    if (!table->buckets || table->count > table->mask) intern_grow(arena, table);
    mdy_interned *entry = mdy_alloc(arena, sizeof *entry + len + 1);
    entry->hash = hash;
    entry->len = len;
    if (len) memcpy(entry->text, s, len);
    entry->text[len] = '\0';
    entry->next = table->buckets[hash & table->mask];
    table->buckets[hash & table->mask] = entry;
    table->count++;
    return entry->text;
}

const char *mdy_intern_lookup(const mdy_intern_table *table, const char *s, size_t len) {
    mdy_interned *found = intern_find(table, hash_of(s, len), s, len);
    return found ? found->text : NULL;
}
