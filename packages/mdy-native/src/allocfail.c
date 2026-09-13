/*
 * An allocator that fails on demand, for the tests.
 *
 * B24 is a list of allocations whose result is used without being checked.
 * Editing them is easy; knowing whether the edit is right is not, because
 * none of those paths runs unless an allocation actually fails. This makes
 * them run. Set MDY_ALLOC_FAIL_NTH=n and the nth allocation of the run --
 * and only that one -- returns NULL. Set MDY_ALLOC_COUNT=1 and it fails
 * nothing but reports, at exit, how many were asked for; that is where the
 * sweep gets its upper bound. Set MDY_ALLOC_FAIL_TRACE=1 and the refusal
 * also prints a backtrace, which is how a swept ordinal becomes a call site.
 *
 * It replaces malloc/realloc/calloc/strdup by macro, so it is a build-flag
 * change and not a call-site one: nothing in the engine knows it exists.
 * Only build/mdy-af is built this way. The #undefs below are what let the
 * definitions here reach the real functions.
 */
#include "allocfail.h"

#undef malloc
#undef realloc
#undef calloc
#undef strdup

#include <stdio.h>
#include <execinfo.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

static long af_nth = -2;   /* -2: not yet read from the environment */
static long af_seen;

static void af_report(void) {
    fprintf(stderr, "mdy-af: %ld allocations\n", af_seen);
}

static int af_should_fail(void) {
    if (af_nth == -2) {
        const char *s = getenv("MDY_ALLOC_FAIL_NTH");
        af_nth = s && *s ? strtol(s, NULL, 10) : -1;
        if (getenv("MDY_ALLOC_COUNT")) atexit(af_report);
    }
    af_seen++;
    if (af_nth < 0 || af_seen != af_nth) return 0;
    if (getenv("MDY_ALLOC_FAIL_TRACE")) {
        void *frames[160];
        int n = backtrace(frames, 160);
        fprintf(stderr, "mdy-af: refusing allocation %ld\n", af_seen);
#if defined(__APPLE__)
        /* Raw addresses plus the slide: backtrace_symbols_fd names the
         * nearest exported symbol, which for a file-static is the wrong
         * function entirely. `atos -o build/mdy-af -s <slide>` names the
         * right one, with a line number. */
        fprintf(stderr, "mdy-af: slide 0x%llx\n",
                (unsigned long long)_dyld_get_image_vmaddr_slide(0));
        for (int i = 0; i < n; i++) fprintf(stderr, "  %p\n", frames[i]);
        fflush(stderr);
#else
        fflush(stderr);
        backtrace_symbols_fd(frames, n, 2);
#endif
    }
    return 1;
}

void *mdy_af_malloc(size_t n) { return af_should_fail() ? NULL : malloc(n); }
void *mdy_af_calloc(size_t n, size_t m) { return af_should_fail() ? NULL : calloc(n, m); }
void *mdy_af_realloc(void *p, size_t n) { return af_should_fail() ? NULL : realloc(p, n); }

char *mdy_af_strdup(const char *s) {
    if (af_should_fail()) return NULL;
    size_t n = strlen(s) + 1;
    char *out = malloc(n);
    if (out) memcpy(out, s, n);
    return out;
}
