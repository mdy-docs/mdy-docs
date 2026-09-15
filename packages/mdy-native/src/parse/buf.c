/*
 * The growable byte buffer every writer in this library uses. `s[len]` is
 * always NUL once anything has been put, so `s` reads as a C string as well
 * as a (pointer, length) pair.
 *
 * `seed` is the capacity of the first allocation: a caller that knows it is
 * about to write a page does not want to double from 256 to get there. Zero
 * means 256.
 *
 * `ok` is the error channel, and it is why this is not just `mdy_xmalloc`
 * (the engine's answer to the same problem): a parse has a caller to report
 * to. A buffer that could not grow stops taking bytes and says so, so nothing
 * downstream reads a truncated result believing it whole.
 */
#include <stdlib.h>
#include <string.h>

#include "internal.h"

void mdy_buf_put(mdy_buf *b, const char *s, size_t n) {
    if (!b->ok) return;
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : (b->seed ? b->seed : 256);
        while (cap < b->len + n + 1) cap *= 2;
        char *grown = realloc(b->s, cap);
        if (!grown) { b->ok = 0; return; }
        b->s = grown;
        b->cap = cap;
    }
    memcpy(b->s + b->len, s, n);
    b->len += n;
    b->s[b->len] = '\0';
}

void mdy_buf_putc(mdy_buf *b, char c) { mdy_buf_put(b, &c, 1); }
