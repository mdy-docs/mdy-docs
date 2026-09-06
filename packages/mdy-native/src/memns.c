/* See memns.h. */
#include <stdlib.h>
#include <string.h>

#include "memns.h"

typedef struct {
    char *name;         /* NULL once removed or renamed away */
    uint8_t *data;
    uint64_t len, cap;
    int refs;           /* ios open on it */
} MemFile;

typedef struct {
    MemFile **files;    /* every file with bytes, named or not */
    size_t count, cap;
} MemDir;

/* ---- one file as a bj_io ------------------------------------------------ */

static uint64_t mf_size(void *ctx) { return ((MemFile *)ctx)->len; }

static int64_t mf_read(void *ctx, uint64_t off, uint8_t *buf, uint32_t len) {
    MemFile *f = ctx;
    if (off >= f->len) return 0;
    uint64_t n = f->len - off;
    if (n > len) n = len;
    memcpy(buf, f->data + off, (size_t)n);
    return (int64_t)n;
}

static int mf_reserve(MemFile *f, uint64_t want) {
    if (want <= f->cap) return BJ_OK;
    uint64_t cap = f->cap ? f->cap : 4096;
    while (cap < want) cap *= 2;
    uint8_t *grown = realloc(f->data, (size_t)cap);
    if (!grown) return BJ_ERR_OOM;
    f->data = grown;
    f->cap = cap;
    return BJ_OK;
}

static int32_t mf_write(void *ctx, uint64_t off, const uint8_t *buf, uint32_t len) {
    MemFile *f = ctx;
    int e = mf_reserve(f, off + len);
    if (e) return e;
    /* a write past the end reads back as zeros in between, as a file does */
    if (off > f->len) memset(f->data + f->len, 0, (size_t)(off - f->len));
    if (len) memcpy(f->data + off, buf, len);
    if (off + len > f->len) f->len = off + len;
    return BJ_OK;
}

static int32_t mf_truncate(void *ctx, uint64_t len) {
    MemFile *f = ctx;
    int e = mf_reserve(f, len);
    if (e) return e;
    if (len > f->len) memset(f->data + f->len, 0, (size_t)(len - f->len));
    f->len = len;
    return BJ_OK;
}

static void mf_free(MemFile *f) {
    free(f->name);
    free(f->data);
    free(f);
}

/* ---- the directory ------------------------------------------------------ */

static MemFile *find(MemDir *d, const char *name, uint32_t len) {
    for (size_t i = 0; i < d->count; i++) {
        MemFile *f = d->files[i];
        if (f->name && strlen(f->name) == len && memcmp(f->name, name, len) == 0) return f;
    }
    return NULL;
}

/* Drop a file nothing names and nothing holds open. */
static void sweep(MemDir *d) {
    size_t kept = 0;
    for (size_t i = 0; i < d->count; i++) {
        MemFile *f = d->files[i];
        if (!f->name && f->refs == 0) mf_free(f);
        else d->files[kept++] = f;
    }
    d->count = kept;
}

static int32_t md_open(void *ctx, const char *name, uint32_t name_len, uint32_t flags, bj_io *out) {
    MemDir *d = ctx;
    if (name_len == 0 || memchr(name, '/', name_len) || memchr(name, '\0', name_len)) return BJ_ERR_RANGE;
    MemFile *f = find(d, name, name_len);
    if (f && (flags & BJ_NS_EXCL)) return BJ_ERR_STATE;
    if (!f) {
        if (!(flags & BJ_NS_CREATE)) return BJ_ERR_STATE;
        if (d->count == d->cap) {
            size_t cap = d->cap ? d->cap * 2 : 16;
            MemFile **grown = realloc(d->files, cap * sizeof *grown);
            if (!grown) return BJ_ERR_OOM;
            d->files = grown;
            d->cap = cap;
        }
        f = calloc(1, sizeof *f);
        if (!f) return BJ_ERR_OOM;
        f->name = malloc(name_len + 1);
        if (!f->name) { free(f); return BJ_ERR_OOM; }
        memcpy(f->name, name, name_len);
        f->name[name_len] = 0;
        d->files[d->count++] = f;
    }
    if (flags & BJ_NS_TRUNC) f->len = 0;
    f->refs++;
    bj_io io = {
        .ctx = f,
        .size = mf_size,
        .read = mf_read,
        .write = mf_write,
        .truncate = mf_truncate,
        .sync = NULL,       /* memory: written is durable, for what that is worth here */
        .close = NULL,      /* the namespace owns the file; see md_close */
    };
    *out = io;
    return BJ_OK;
}

static int32_t md_close(void *ctx, bj_io *io) {
    MemDir *d = ctx;
    MemFile *f = io->ctx;
    if (!f) return BJ_OK;
    if (f->refs > 0) f->refs--;
    io->ctx = NULL;
    sweep(d);
    return BJ_OK;
}

static int32_t md_remove(void *ctx, const char *name, uint32_t name_len) {
    MemDir *d = ctx;
    MemFile *f = find(d, name, name_len);
    if (!f) return BJ_ERR_STATE;
    free(f->name);
    f->name = NULL;
    sweep(d);
    return BJ_OK;
}

/* Nothing to make durable; the store calls this unconditionally after a
 * rename, so it must exist. */
static int32_t md_sync(void *ctx) { (void)ctx; return BJ_OK; }

int memns_open(bj_ns *out) {
    MemDir *d = calloc(1, sizeof *d);
    if (!d) return BJ_ERR_OOM;
    bj_ns ns = { d, md_open, md_close, md_remove, md_sync };
    *out = ns;
    return BJ_OK;
}

void memns_free(bj_ns *ns) {
    MemDir *d = ns ? ns->ctx : NULL;
    if (!d) return;
    for (size_t i = 0; i < d->count; i++) mf_free(d->files[i]);
    free(d->files);
    free(d);
    ns->ctx = NULL;
}

int memns_listing(void *ctx, char **out, size_t *out_len, int *owned) {
    MemDir *d = ctx;
    size_t total = 1;
    for (size_t i = 0; i < d->count; i++) if (d->files[i]->name) total += strlen(d->files[i]->name) + 1;
    char *buf = malloc(total);
    if (!buf) return BJ_ERR_OOM;
    size_t len = 0;
    for (size_t i = 0; i < d->count; i++) {
        const char *name = d->files[i]->name;
        if (!name) continue;
        size_t n = strlen(name) + 1;
        memcpy(buf + len, name, n);
        len += n;
    }
    *out = buf;
    *out_len = len;
    *owned = 1;
    return BJ_OK;
}

int32_t memns_adopt(void *ctx, const char *from, uint32_t from_len, const char *to, uint32_t to_len) {
    MemDir *d = ctx;
    MemFile *src = find(d, from, from_len);
    if (!src) return BJ_ERR_STATE;
    char *name = malloc(to_len + 1);
    if (!name) return BJ_ERR_OOM;
    memcpy(name, to, to_len);
    name[to_len] = 0;
    MemFile *old = find(d, to, to_len);
    if (old && old != src) { free(old->name); old->name = NULL; }
    free(src->name);
    src->name = name;
    sweep(d);
    return BJ_OK;
}
