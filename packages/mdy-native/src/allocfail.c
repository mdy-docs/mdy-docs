/*
 * An allocator that fails on demand, for the tests.
 *
 * An allocation whose result is used unchecked is easy to fix and hard to
 * KNOW you have fixed, because none of those paths runs unless an allocation
 * actually fails. This makes
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
#include <signal.h>
#if !defined(_WIN32)
#include <unistd.h>
#endif
#if !defined(__EMSCRIPTEN__)
#include <execinfo.h>
#endif
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

static long af_nth = -2;   /* -2: not yet read from the environment */
static long af_seen;

static void af_report(void) {
    fprintf(stderr, "mdy-af: %ld allocations\n", af_seen);
}

#if !defined(_WIN32)
/*
 * The same count, for a process that does not exit on its own.
 *
 * `mdy dev` runs until it is killed, so atexit never fires and the sweep has
 * no way to learn how many allocations a startup makes -- which is the number
 * it has to sweep to. SIGTERM reports and stops.
 *
 * write() and not fprintf(): this is a signal handler, and the only functions
 * safe in one are the async-signal-safe list. The number is formatted by hand
 * for the same reason.
 */
static void af_report_signal(int sig) {
    (void)sig;
    char buf[64] = "mdy-af: ";
    size_t at = 8;
    char digits[24];
    int n = 0;
    long v = af_seen;
    if (v == 0) digits[n++] = '0';
    while (v > 0) { digits[n++] = (char)('0' + v % 10); v /= 10; }
    while (n > 0) buf[at++] = digits[--n];
    const char *tail = " allocations\n";
    for (const char *p = tail; *p; p++) buf[at++] = *p;
    ssize_t ignored = write(2, buf, at);
    (void)ignored;
    _Exit(0);
}
#endif

/*
 * Armed from OUTSIDE the process, for the wasm build.
 *
 * emscripten's getenv reads its own ENV object and not the host's
 * environment, so the env vars below reach a native run and nothing else.
 * These two are exported from the wasm module instead (see check-alloc-wasm),
 * and are what the sweep there calls between builds.
 */
void mdy_af_arm(long nth) { af_nth = nth; af_seen = 0; }
long mdy_af_total(void) { return af_seen; }

static int af_should_fail(void) {
    if (af_nth == -2) {
        const char *s = getenv("MDY_ALLOC_FAIL_NTH");
        af_nth = s && *s ? strtol(s, NULL, 10) : -1;
        if (getenv("MDY_ALLOC_COUNT")) {
            atexit(af_report);
#if !defined(_WIN32)
            signal(SIGTERM, af_report_signal);
#endif
        }
    }
    af_seen++;
    if (af_nth < 0 || af_seen != af_nth) return 0;
#if !defined(__EMSCRIPTEN__)
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
#endif
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
