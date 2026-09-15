/*
 * mdy_hindex — a small open-addressing index from (interned key, tag) to a
 * size_t value. See internal.h for what it is for and why every caller keeps
 * its plain array alongside it.
 *
 * Keys are compared by pointer; the hash mixes the pointer with the tag so a
 * document index or a reference kind can share one table without colliding by
 * accident. The load factor is held under 3/4, and a grow abandons the old
 * table to the arena, which sums to O(n) over the life of the document.
 */
#include <string.h>

#include "internal.h"

/* Fibonacci hashing on the pointer, xored with a spread of the tag. */
static size_t hindex_slot(const mdy_hentry *slots, size_t cap,
                          const char *key, uint64_t tag) {
    size_t mask = cap - 1;
    uint64_t h = ((uintptr_t)key >> 4) ^ (tag * 0x9E3779B97F4A7C15ull);
    size_t i = (size_t)h & mask;
    while (slots[i].key && !(slots[i].key == key && slots[i].tag == tag))
        i = (i + 1) & mask;
    return i;
}

mdy_hentry *mdy_hindex_get(mdy_hindex *ix, const char *key, uint64_t tag) {
    if (ix->cap == 0) return NULL;
    size_t i = hindex_slot(ix->slots, ix->cap, key, tag);
    return ix->slots[i].key ? &ix->slots[i] : NULL;
}

int mdy_hindex_put(mdy_doc *doc, mdy_hindex *ix, const char *key,
                   uint64_t tag, size_t val) {
    if ((ix->count + 1) * 4 >= ix->cap * 3) {   /* keep the load under 3/4 */
        size_t ncap = ix->cap ? ix->cap * 2 : 64;
        mdy_hentry *ns = mdy_alloc(&doc->arena, ncap * sizeof *ns);
        if (!ns) return 0;                       /* caller falls back to its array */
        memset(ns, 0, ncap * sizeof *ns);
        for (size_t i = 0; i < ix->cap; i++)
            if (ix->slots[i].key)
                ns[hindex_slot(ns, ncap, ix->slots[i].key, ix->slots[i].tag)] = ix->slots[i];
        ix->slots = ns;
        ix->cap = ncap;
    }
    size_t i = hindex_slot(ix->slots, ix->cap, key, tag);
    if (!ix->slots[i].key) ix->count++;
    ix->slots[i].key = key;
    ix->slots[i].tag = tag;
    ix->slots[i].val = val;
    return 1;
}
