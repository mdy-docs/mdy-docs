/*
 * Allocation that cannot fail, for the places that have nowhere to say so.
 *
 * Most of this engine propagates an allocation failure properly: fsx_read
 * returns NULL and the caller says "cannot read", mdy_yaml_parse returns NULL
 * and the document fails. Those are fine and are left alone.
 *
 * A handful of places cannot. `key(vm, "_id")` returns a JsValue; there is no
 * JsValue that means "the allocation failed", and `js_undefined()` is a value
 * a document may legitimately hold. So the code did the only thing it could
 * and carried on with the wrong answer: a property landed under the key
 * `undefined`, a tagName fell back to `div`, a hash was taken over a subset
 * of the object's keys. The build then reported success.
 *
 * Threading a status out of those helpers means changing every caller of a
 * function called from everywhere, to carry a condition that on any machine
 * this runs on means the process is already finished. So they allocate
 * through here instead, and the failure ends the run with one line on stderr
 * rather than a silently different site.
 *
 * The rule for which to use: if NULL reaches something that reports it and
 * stops, propagate. If NULL turns into different output, come here.
 */
#ifndef MDY_XALLOC_H
#define MDY_XALLOC_H

#include <stddef.h>

/*
 * The same policy for a failure that is not an allocation: an invariant this
 * engine has no way to report and no way to continue past. It takes the text
 * because, unlike an allocation, the reader cannot guess what happened.
 */
_Noreturn void mdy_fatal(const char *what);

void *mdy_xmalloc(size_t n);
void *mdy_xcalloc(size_t n, size_t size);
void *mdy_xrealloc(void *p, size_t n);
char *mdy_xstrdup(const char *s);

/*
 * A growable byte buffer, for this side of the boundary.
 *
 * The parser has one too (mdy_buf, internal.h) and they are deliberately NOT
 * the same type. The parser's carries an `ok` flag because a parse has a
 * caller to report to; this one cannot fail, because the engine allocates
 * through the four functions above — so an `ok` here would be a field nothing
 * could ever set.
 *
 * Two buffers, one per library, each matching its own error policy. Before
 * this there were four in the parser and three here, all the same thirteen
 * lines, and two of the three grew with an UNCHECKED realloc and wrote
 * through the result.
 *
 * `seed` is the first allocation's size; zero means 256.
 */
typedef struct { char *s; size_t len, cap, seed; } mdy_sbuf;
void mdy_sbuf_put(mdy_sbuf *b, const char *s, size_t n);
void mdy_sbuf_puts(mdy_sbuf *b, const char *s);

#endif
