/*
 * The nisaba side. Includes nisaba's headers and nothing else.
 *
 * Storage is ours to supply: nisaba's shipped bjio_host(fd) reaches into
 * Module.bjioHandles, a table of JS FileSystemSyncAccessHandle objects, which
 * is the browser's storage bridged through emscripten. bj_io is four
 * callbacks, so this is a buffer in memory — see Store below for why it is
 * not a temp file.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "binjson.h"
#include "bjio.h"
#include "bplustree.h"
#include "db.h"
#include "nis.h"

#define MAX_INDEXES 4

typedef struct Store Store;

typedef struct {
    /*
     * The store is a POINTER, and that is not incidental. `bj_io.ctx` is kept
     * by the B+tree for the tree's whole life, so it must not be an address
     * INSIDE this table — the table is realloc'd when it grows, and every
     * collection opened before a growth would then read and write through a
     * dangling pointer. A separately allocated store does not move.
     */
    Store *store;
    bpt *tree;
    dc_collection *coll;
    /* One store + tree per secondary index — each index is its own B+tree. */
    Store *index_stores[MAX_INDEXES];
    bpt *index_trees[MAX_INDEXES];
    int indexes;
    int used;
} Slot;

/*
 * The slot table GROWS rather than being capped. It was eight, which was fine
 * for a build — one document set per package — and wrong the moment mdy-docs'
 * own test suite ran here: it opens a set per test, hundreds of them, and the
 * ninth failed with "could not open a collection".
 *
 * Growing alone would have moved the failure to the file-descriptor limit
 * when a collection was a temp file and an index another; it is a buffer now
 * (see Store below), so the only thing a slot costs is the memory in it. What
 * gives it back is nis_close, which the engine calls when it closes a set.
 */
static Slot *g_slots;
static int g_slot_count;

/*
 * A collection's backing store: a growable buffer, NOT a file.
 *
 * The four bj_io callbacks are this file's entire platform surface, which is
 * the reason nisaba itself needs no porting — and it is equally the reason
 * storage does not have to be a file at all. It was one: a temp file that
 * "lives exactly as long as its handle, which is the lifetime
 * MemoryStorageProvider promises on the JS side". That is a memory store
 * described as a file, so this is the same lifetime with the detour removed.
 *
 * The detour was not free. Every read and write went through the kernel, and
 * a 93-page build spent ELEVEN of its seventeen seconds in system time —
 * more than its own computation. It also cost a file descriptor per
 * collection plus one per index, and hardcoded /tmp, which is not writable
 * on iOS.
 *
 * A persistent store is still exactly four callbacks away when Phase 6 wants
 * one. That is what the vtable is for.
 */
struct Store {
    uint8_t *bytes;
    uint64_t len;   /* the "file" length — what io_size reports */
    uint64_t cap;
};

static Store *store_new(void) { return calloc(1, sizeof(Store)); }

static void store_free(Store *m) {
    if (!m) return;
    free(m->bytes);
    free(m);
}

/*
 * Room for `need` bytes. New space is ZEROED, and that is not tidiness: a
 * B+tree writes a node, then later reads a region it has not written, and a
 * file would have given it zeroes there. Uninitialised heap would give it the
 * previous collection's bytes.
 */
static int store_reserve(Store *m, uint64_t need) {
    if (need <= m->cap) return 0;
    uint64_t want = m->cap ? m->cap : 65536;
    while (want < need) want *= 2;
    uint8_t *grown = realloc(m->bytes, (size_t)want);
    if (!grown) return -1;
    memset(grown + m->cap, 0, (size_t)(want - m->cap));
    m->bytes = grown;
    m->cap = want;
    return 0;
}

static uint64_t io_size(void *ctx) { return ((Store *)ctx)->len; }

static int64_t io_read(void *ctx, uint64_t off, uint8_t *buf, uint32_t len) {
    Store *m = ctx;
    if (off >= m->len) return 0;              /* past the end: no bytes, as pread */
    uint64_t left = m->len - off;
    uint32_t n = left < len ? (uint32_t)left : len;
    memcpy(buf, m->bytes + off, n);
    return (int64_t)n;                        /* a SHORT read is allowed, as pread */
}

static int32_t io_write(void *ctx, uint64_t off, const uint8_t *buf, uint32_t len) {
    Store *m = ctx;
    uint64_t need = off + len;
    if (need < off) return -1;                /* overflow */
    if (store_reserve(m, need) != 0) return -1;
    /* A write past the end leaves a hole, which a file reads back as zeroes. */
    if (off > m->len) memset(m->bytes + m->len, 0, (size_t)(off - m->len));
    memcpy(m->bytes + off, buf, len);
    if (need > m->len) m->len = need;
    return 0;
}

static int32_t io_truncate(void *ctx, uint64_t len) {
    Store *m = ctx;
    if (len > m->len) {                       /* growing: the new space is zeroes */
        if (store_reserve(m, len) != 0) return -1;
        memset(m->bytes + m->len, 0, (size_t)(len - m->len));
    }
    m->len = len;
    return 0;
}

int nis_open(void) {
    int slot = -1;
    for (int i = 0; i < g_slot_count; i++) if (!g_slots[i].used) { slot = i; break; }
    if (slot < 0) {
        int grown = g_slot_count ? g_slot_count * 2 : 16;
        Slot *next = realloc(g_slots, (size_t)grown * sizeof *next);
        if (!next) return -1;
        memset(next + g_slot_count, 0, (size_t)(grown - g_slot_count) * sizeof *next);
        g_slots = next;
        slot = g_slot_count;
        g_slot_count = grown;
    }

    Store *store = store_new();
    if (!store) return -1;

    g_slots[slot].store = store;
    bj_io io = { .ctx = store, .size = io_size, .read = io_read,
                 .write = io_write, .truncate = io_truncate };
    g_slots[slot].tree = bpt_create(&io, 64);
    if (!g_slots[slot].tree) { store_free(store); g_slots[slot].store = NULL; return -1; }
    g_slots[slot].coll = dc_collection_open(g_slots[slot].tree);
    if (!g_slots[slot].coll) {
        bpt_free(g_slots[slot].tree);
        store_free(store);
        g_slots[slot].tree = NULL;
        g_slots[slot].store = NULL;
        return -1;
    }
    g_slots[slot].used = 1;
    return slot;
}

static Slot *slot_of(int handle) {
    if (handle < 0 || handle >= g_slot_count || !g_slots[handle].used) return NULL;
    return &g_slots[handle];
}

int nis_insert(int handle, const uint8_t *doc, uint32_t len) {
    Slot *s = slot_of(handle);
    if (!s) return -1;
    return dc_insert_one(s->coll, doc, len) < 0 ? -1 : 0;
}

int nis_find(int handle, const uint8_t *filter, uint32_t filter_len, uint8_t **out, size_t *out_len) {
    Slot *s = slot_of(handle);
    if (!s) return -1;
    *out = NULL; *out_len = 0;
    return dc_find(s->coll, filter, filter_len, NULL, out, out_len) < 0 ? -1 : 0;
}

int nis_create_index(int handle, const char *name, const uint8_t *fields, uint32_t fields_len,
                     int unique, int sparse) {
    Slot *s = slot_of(handle);
    if (!s || s->indexes >= MAX_INDEXES) return -1;

    int n = s->indexes;
    s->index_stores[n] = store_new();
    if (!s->index_stores[n]) return -1;

    bj_io io = { .ctx = s->index_stores[n], .size = io_size, .read = io_read,
                 .write = io_write, .truncate = io_truncate };
    s->index_trees[n] = bpt_create(&io, 64);
    if (!s->index_trees[n]) { store_free(s->index_stores[n]); s->index_stores[n] = NULL; return -1; }

    /* add_index rather than attach_index: this one is new, so nisaba
     * backfills it from the documents already inserted. attach_index is for
     * reopening a collection whose index file already holds the postings. */
    int rc = dc_collection_add_index(s->coll, name, (int)strlen(name), s->index_trees[n],
                                     fields, fields_len, unique, sparse, NULL, 0);
    if (rc != 0) {
        bpt_free(s->index_trees[n]);
        store_free(s->index_stores[n]);
        s->index_trees[n] = NULL;
        s->index_stores[n] = NULL;
        return rc;
    }
    s->indexes++;
    return 0;
}

/*
 * Everything the collection is, in the order it was built.
 *
 * The collection first, since its index descriptors name the trees. Then the
 * TREES, which nisaba never owned: bpt_create made each one over a bj_io of
 * ours and dc_collection_add_index only borrowed it, so dc_collection_free
 * leaves them — that is a B+tree's buffers per index plus one for the primary
 * store. Then the stores the trees read and wrote through, and the slot goes
 * back in the pool.
 */
void nis_close(int handle) {
    Slot *s = slot_of(handle);
    if (!s) return;
    dc_collection_free(s->coll);
    s->coll = NULL;
    for (int i = 0; i < s->indexes; i++) {
        bpt_free(s->index_trees[i]);
        store_free(s->index_stores[i]);
        s->index_trees[i] = NULL;
        s->index_stores[i] = NULL;
    }
    bpt_free(s->tree);
    s->tree = NULL;
    store_free(s->store);
    s->store = NULL;
    s->indexes = 0;
    s->used = 0;
}
