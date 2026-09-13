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

#endif
