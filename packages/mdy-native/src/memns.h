/*
 * A directory in memory, for sukkal's store.
 *
 * sukkal's store reaches the world through a bj_ns — open, close, remove,
 * sync a name — and three hooks: a clock, a listing and an atomic rename.
 * Its POSIX shell backs those with a directory descriptor and openat,
 * which is what kept the in-process broker off Windows and out of the
 * wasm build. This backs them with a table of growable buffers instead.
 * Nothing here touches a filesystem, so it links everywhere the engine
 * does; what it gives up is durability, which a dev run never asked for,
 * and which is exactly what the JavaScript's memory provider gives up.
 *
 * A file's bytes outlive its name: remove and rename take effect on the
 * table at once, and an io still open on the old file keeps the old
 * bytes until it is closed, as an unlinked file does on POSIX. Compaction
 * closes everything before it renames, so this is belt and braces, but a
 * store is the wrong place to be surprised.
 */
#ifndef MDY_MEMNS_H
#define MDY_MEMNS_H

#include <stddef.h>
#include <stdint.h>

#include "bjns.h"

/* An empty directory. BJ_OK, or BJ_ERR_OOM. */
int memns_open(bj_ns *out);
/* Free it and every file in it, open or not. */
void memns_free(bj_ns *ns);

/* The three hooks, in the shapes bjm_store_set_listing and
 * bjm_store_set_adopt take. `ctx` is the namespace's own ns->ctx. */
int memns_listing(void *ctx, char **out, size_t *out_len, int *owned);
int32_t memns_adopt(void *ctx, const char *from, uint32_t from_len,
                    const char *to, uint32_t to_len);

#endif
