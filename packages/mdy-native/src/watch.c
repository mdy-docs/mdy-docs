/* See watch.h. */
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#  include <windows.h>
#else
#  include <time.h>
#endif

#include "fsx.h"
#include "watch.h"

/* serve.js's IGNORE: /(^|\/)(dist|node_modules|\.[^/]+)(\/|$)/ */
static int ignored(const char *rel) {
    const char *seg = rel;
    for (;;) {
        const char *end = strchr(seg, '/');
        size_t n = end ? (size_t)(end - seg) : strlen(seg);
        if (n > 0 && (seg[0] == '.' ||
                      (n == 4 && strncmp(seg, "dist", 4) == 0) ||
                      (n == 12 && strncmp(seg, "node_modules", 12) == 0))) return 1;
        if (!end) return 0;
        seg = end + 1;
    }
}

static void add(Snapshot *s, const char *path, double size, double mtime) {
    if (s->count == s->cap) {
        s->cap = s->cap ? s->cap * 2 : 64;
        s->files = realloc(s->files, s->cap * sizeof *s->files);
    }
    s->files[s->count].path = strdup(path);
    s->files[s->count].size = size;
    s->files[s->count].mtime = mtime;
    s->count++;
}

void snapshot_take(Snapshot *out, const char *root, const char *only) {
    memset(out, 0, sizeof *out);
    if (only) {
        double size = 0, mtime = 0;
        if (fsx_stat(root, only, &size, &mtime) == 0) add(out, only, size, mtime);
        return;
    }
    /* fsx_list is the walk the engine uses: dotfiles are already out. */
    char *listing = fsx_list(root, ".", NULL);
    if (!listing) return;
    for (char *rel = listing, *next; rel && *rel; rel = next) {
        char *nl = strchr(rel, '\n');
        next = nl ? nl + 1 : NULL;
        if (nl) *nl = '\0';
        if (!*rel || ignored(rel)) continue;
        double size = 0, mtime = 0;
        if (fsx_stat(root, rel, &size, &mtime) == 0) add(out, rel, size, mtime);
    }
    free(listing);
}

void snapshot_free(Snapshot *s) {
    for (size_t i = 0; i < s->count; i++) free(s->files[i].path);
    free(s->files);
    s->files = NULL;
    s->count = s->cap = 0;
}

static const WatchedFile *find(const Snapshot *s, const char *path) {
    for (size_t i = 0; i < s->count; i++) if (strcmp(s->files[i].path, path) == 0) return &s->files[i];
    return NULL;
}

char *snapshot_changes(const Snapshot *before, const Snapshot *after) {
    size_t cap = 256, len = 0;
    char *out = malloc(cap);
    int any = 0;
    const Snapshot *sides[2] = { after, before };
    for (int side = 0; side < 2; side++) {
        const Snapshot *a = sides[side], *b = sides[1 - side];
        for (size_t i = 0; i < a->count; i++) {
            const WatchedFile *f = &a->files[i];
            const WatchedFile *other = find(b, f->path);
            int changed = !other || (side == 0 && (other->size != f->size || other->mtime != f->mtime));
            if (!changed) continue;
            if (side == 1 && find(after, f->path)) continue; /* counted from the other side */
            size_t n = strlen(f->path) + 1;
            if (len + n + 1 > cap) { while (len + n + 1 > cap) cap *= 2; out = realloc(out, cap); }
            memcpy(out + len, f->path, n);
            len += n;
            any = 1;
        }
    }
    if (!any) { free(out); return NULL; }
    out[len] = '\0';
    return out;
}

void watch_sleep_ms(int ms) {
#ifdef _WIN32
    Sleep((DWORD)ms);
#else
    struct timespec ts = { ms / 1000, (long)(ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
#endif
}
