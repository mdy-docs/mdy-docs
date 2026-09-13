/*
 * An allocator that fails on demand. See allocfail.c.
 *
 * Force-included by the build (never by a source file) for build/mdy-af only.
 * The system headers come first on purpose: the macros below must not be in
 * scope when <stdlib.h> and <string.h> declare the functions they rename.
 */
#ifndef MDY_ALLOCFAIL_H
#define MDY_ALLOCFAIL_H

#include <stdlib.h>
#include <string.h>

void *mdy_af_malloc(size_t n);
void *mdy_af_calloc(size_t n, size_t m);
void *mdy_af_realloc(void *p, size_t n);
char *mdy_af_strdup(const char *s);

#define malloc  mdy_af_malloc
#define calloc  mdy_af_calloc
#define realloc mdy_af_realloc
#define strdup  mdy_af_strdup

#endif
