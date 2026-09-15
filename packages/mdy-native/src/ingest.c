/* The contract is in ingest.h. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "ingest.h"

int mdy_bj_put_yaml(bj_builder *b, const mdy_yaml_node *node) {
    switch (mdy_yaml_type_of(node)) {
        case MDY_YAML_NULL:
            return bj_put_null(b);
        case MDY_YAML_BOOL:
            return bj_put_bool(b, mdy_yaml_bool(node));
        case MDY_YAML_NUMBER: {
            /*
             * An integral value goes in as an INT. YAML has one number type
             * and binjson has two, and a query written `{size: 4}` must match
             * a document that said `size: 4` — which it does not if one side
             * stored a float.
             */
            double v = mdy_yaml_number(node);
            /*
             * The range test comes BEFORE the cast, and that ordering is the
             * whole of it: `.inf` and `.nan` are legal YAML, they reach this
             * line, and `(int64_t)v` of either is undefined behaviour. It happened
             * to answer with a sentinel that failed the equality and fell
             * through to the float, which is why nothing had noticed.
             *
             * A non-finite still goes in as a FLOAT and not as null: node's
             * YAML reads `.inf` as a real Infinity and its store keeps one, so
             * this is where the two engines agree. Where they differ is what
             * the guest sees — see finite_or_null in engine_value.c.
             */
            if (v != v || v < -9.2e18 || v > 9.2e18 || v != (double)(int64_t)v)
                return bj_put_float(b, v);

            /*
             * Everything integral and in range goes in as an INT, including
             * past 2^53 — binjson's encoder decides what that becomes.
             *
             * It did not always: bj_put_int wrote BJ_TYPE_INT at any magnitude
             * while both binjson decoders refuse an INT outside the JS safe
             * range and abort the whole DECODE, so one such integer made the
             * document it was in disappear from every query — every other key
             * of that record with it, insert reporting success, nothing said.
             *
             * binjson falls back to FLOAT there now, which is what its JS
             * reference always did, so the workaround is gone and the value
             * comes back as the same NUMBER node has. Requires binjson at
             * 07a5461 or later; the engine test's big_integer_checks is what
             * says so.
             */
            return bj_put_int(b, (int64_t)v);
        }
        case MDY_YAML_STRING: {
            size_t len = 0;
            const char *s = mdy_yaml_string(node, &len);
            return bj_put_string(b, (const uint8_t *)s, (uint32_t)len);
        }
        case MDY_YAML_SEQUENCE: {
            if (bj_begin_array(b) != 0) return -1;
            for (size_t i = 0; i < mdy_yaml_count(node); i++)
                if (mdy_bj_put_yaml(b, mdy_yaml_at(node, i)) != 0) return -1;
            return bj_end_array(b);
        }
        case MDY_YAML_MAPPING: {
            if (bj_begin_object(b) != 0) return -1;
            for (size_t i = 0; i < mdy_yaml_count(node); i++) {
                size_t klen = 0;
                const char *k = mdy_yaml_key(node, i, &klen);
                if (bj_put_key(b, (const uint8_t *)k, (uint32_t)klen) != 0) return -1;
                if (mdy_bj_put_yaml(b, mdy_yaml_value(node, i)) != 0) return -1;
            }
            return bj_end_object(b);
        }
    }
    return -1;
}

/*
 * One key across the mappings being merged: the first mapping that has it,
 * which decides where it sits, and the last, with the value it holds there,
 * which decides what it holds. `value` is the key's first occurrence within
 * that last mapping.
 */
typedef struct {
    const char *key;
    size_t len;
    size_t first, last;
    const mdy_yaml_node *value;
    int used;
} MergeKey;

static size_t merge_hash(const char *s, size_t len) {
    uint64_t h = 1469598103934665603u;
    for (size_t i = 0; i < len; i++) { h ^= (unsigned char)s[i]; h *= 1099511628211u; }
    return (size_t)h;
}

/* The slot holding `key`, or the empty one it would go in. `cap` is a power of
 * two with room to spare, so the probe always ends. */
static MergeKey *merge_slot(MergeKey *slots, size_t cap, const char *key, size_t len) {
    size_t at = merge_hash(key, len) & (cap - 1);
    while (slots[at].used && !(slots[at].len == len && memcmp(slots[at].key, key, len) == 0))
        at = (at + 1) & (cap - 1);
    return &slots[at];
}

static int is_store_id(const char *k, size_t len) {
    return len == 3 && memcmp(k, "_id", 3) == 0;
}

int mdy_bj_document(bj_builder *b, const uint8_t oid[12],
                    const mdy_yaml_node *const *mappings, size_t count) {
    /*
     * The merge: for each key, the FIRST mapping that has it decides where it
     * sits and the LAST decides what it holds. One pass records both for every
     * key and a second writes them, so a record of any size merges in linear
     * time.
     *
     * `_id` is skipped in both: the store's id is the store's, a document
     * cannot declare one, and it is written below, last, where mdy-docs has it.
     */
    size_t total = 0;
    for (size_t m = 0; m < count; m++)
        if (mdy_yaml_type_of(mappings[m]) == MDY_YAML_MAPPING) total += mdy_yaml_count(mappings[m]);
    size_t cap = 16;
    while (cap < total * 2) cap *= 2;
    MergeKey *slots = calloc(cap, sizeof *slots);
    if (!slots) return -1;

    for (size_t m = 0; m < count; m++) {
        const mdy_yaml_node *map = mappings[m];
        if (mdy_yaml_type_of(map) != MDY_YAML_MAPPING) continue;
        for (size_t i = 0; i < mdy_yaml_count(map); i++) {
            size_t klen = 0;
            const char *k = mdy_yaml_key(map, i, &klen);
            if (is_store_id(k, klen)) continue;
            MergeKey *e = merge_slot(slots, cap, k, klen);
            if (!e->used) {
                *e = (MergeKey){ k, klen, m, m, mdy_yaml_value(map, i), 1 };
            } else if (m > e->last) {
                e->last = m;
                e->value = mdy_yaml_value(map, i);
            }
        }
    }

    int rc = -1;
    if (bj_begin_object(b) != 0) goto done;
    for (size_t m = 0; m < count; m++) {
        const mdy_yaml_node *map = mappings[m];
        if (mdy_yaml_type_of(map) != MDY_YAML_MAPPING) continue;
        for (size_t i = 0; i < mdy_yaml_count(map); i++) {
            size_t klen = 0;
            const char *k = mdy_yaml_key(map, i, &klen);
            if (is_store_id(k, klen)) continue;
            const MergeKey *e = merge_slot(slots, cap, k, klen);
            if (e->first < m) continue;       /* written already, where an earlier mapping had it */
            const mdy_yaml_node *value = e->last > m ? e->value : mdy_yaml_value(map, i);
            if (bj_put_key(b, (const uint8_t *)k, (uint32_t)klen) != 0) goto done;
            if (mdy_bj_put_yaml(b, value) != 0) goto done;
        }
    }

    /*
     * `_id` LAST, which is where mdy-docs has it: nisaba's JS insert adds it
     * after spreading the document, so `Object.keys` gives `[…, "_id"]`.
     * Key order is not cosmetic: a document that serialises its own record, or
     * walks its keys, produces different bytes if this differs.
     */
    if (bj_put_key(b, (const uint8_t *)"_id", 3) != 0) goto done;
    if (bj_put_oid(b, oid) != 0) goto done;
    rc = bj_end_object(b);

done:
    free(slots);
    return rc;
}

void mdy_oid_next(uint8_t out[12]) {
    static uint8_t run[5];
    static uint32_t counter;
    static int seeded;
    if (!seeded) {
        seeded = 1;
        /* Not cryptographic, and does not need to be: this makes a key unique
         * within one build, not unguessable. */
        unsigned seed = (unsigned)time(NULL) ^ (unsigned)(uintptr_t)&run;
        for (int i = 0; i < 5; i++) { seed = seed * 1103515245u + 12345u; run[i] = (uint8_t)(seed >> 16); }
        counter = seed;
    }
    uint32_t now = (uint32_t)time(NULL);
    out[0] = (uint8_t)(now >> 24); out[1] = (uint8_t)(now >> 16);
    out[2] = (uint8_t)(now >> 8);  out[3] = (uint8_t)now;
    memcpy(out + 4, run, 5);
    uint32_t c = ++counter;
    out[9]  = (uint8_t)(c >> 16); out[10] = (uint8_t)(c >> 8); out[11] = (uint8_t)c;
}
