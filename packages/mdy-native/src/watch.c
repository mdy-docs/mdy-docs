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
#include "xalloc.h"

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

/* A file missing from the snapshot is a file the watcher never notices
 * changing, so `mdy dev` stops rebuilding for it and says nothing. See
 * xalloc.h. */
static void add(Snapshot *s, const char *path, double size, double mtime) {
    if (s->count == s->cap) {
        s->cap = s->cap ? s->cap * 2 : 64;
        s->files = mdy_xrealloc(s->files, s->cap * sizeof *s->files);
    }
    s->files[s->count].path = mdy_xstrdup(path);
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
    for (const char *rel = listing; *rel; rel += strlen(rel) + 1) {
        if (ignored(rel)) continue;
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

/*
 * A MERGE, not two nested scans.
 *
 * Both snapshots come from fsx_list in the order it sorts them — strcmp, and
 * `add` appends — so walking the two together finds every difference in one
 * pass. Looking each file up instead is O(n²) every 120 ms, which on a site
 * of a few thousand files is the watcher's whole budget spent on strcmp.
 *
 * The three cases are the three a merge has. A path on both sides changed if
 * its size or mtime did; one only in `after` is new; one only in `before` is
 * gone. Each is emitted once.
 */
static int emit_path(char **out, size_t *cap, size_t *len, const char *path) {
    size_t n = strlen(path) + 1;
    if (*len + n + 1 > *cap) {
        size_t want = *cap;
        while (*len + n + 1 > want) want *= 2;
        char *grown = realloc(*out, want);
        if (!grown) return -1;
        *out = grown;
        *cap = want;
    }
    memcpy(*out + *len, path, n);
    *len += n;
    return 0;
}

char *snapshot_changes(const Snapshot *before, const Snapshot *after) {
    size_t cap = 256, len = 0;
    char *out = malloc(cap);
    if (!out) return NULL;
    int any = 0;

    size_t i = 0, j = 0;
    while (i < after->count || j < before->count) {
        int c;
        if (i >= after->count) c = 1;             /* only in before: gone */
        else if (j >= before->count) c = -1;      /* only in after: new */
        else c = strcmp(after->files[i].path, before->files[j].path);

        const char *path = NULL;
        if (c == 0) {
            if (after->files[i].size != before->files[j].size ||
                after->files[i].mtime != before->files[j].mtime)
                path = after->files[i].path;
            i++; j++;
        } else if (c < 0) {
            path = after->files[i].path;
            i++;
        } else {
            path = before->files[j].path;
            j++;
        }
        if (path) {
            if (emit_path(&out, &cap, &len, path) != 0) { free(out); return NULL; }
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
