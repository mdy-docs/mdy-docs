/* See xalloc.h for which allocations belong here and which do not. */
#include "xalloc.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * _exit rather than exit: an allocation has just failed, and the atexit
 * handlers and stream flushes that exit runs are themselves allocating code
 * paths. The one line that matters is written and flushed first.
 *
 * Exit 1 is what every other fatal error in the CLI uses. An OOM is not a
 * different KIND of failure to the caller of `mdy build` -- it is a build that
 * did not happen -- and giving it its own code would only mean a script that
 * checks for 1 stops noticing it.
 */
static void oom(void) {
    fputs("mdy: out of memory\n", stderr);
    fflush(stderr);
    _Exit(1);
}

void mdy_fatal(const char *what) {
    fprintf(stderr, "mdy: %s\n", what);
    fflush(stderr);
    _Exit(1);
}

void *mdy_xmalloc(size_t n) {
    void *p = malloc(n);
    if (!p) oom();
    return p;
}

void *mdy_xcalloc(size_t n, size_t size) {
    void *p = calloc(n, size);
    if (!p) oom();
    return p;
}

void *mdy_xrealloc(void *p, size_t n) {
    void *q = realloc(p, n);
    if (!q) oom();
    return q;
}

char *mdy_xstrdup(const char *s) {
    size_t n = strlen(s) + 1;
    char *out = mdy_xmalloc(n);
    memcpy(out, s, n);
    return out;
}

void mdy_sbuf_put(mdy_sbuf *b, const char *s, size_t n) {
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : (b->seed ? b->seed : 256);
        while (cap < b->len + n + 1) cap *= 2;
        b->s = mdy_xrealloc(b->s, cap);
        b->cap = cap;
    }
    memcpy(b->s + b->len, s, n);
    b->len += n;
    b->s[b->len] = '\0';
}

void mdy_sbuf_puts(mdy_sbuf *b, const char *s) { mdy_sbuf_put(b, s, strlen(s)); }
