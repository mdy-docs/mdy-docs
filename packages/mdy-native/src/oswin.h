/*
 * The Windows half of the two files that know what platform this is.
 *
 * fsx.c and nis.c are the whole platform-specific surface of the backend —
 * lamassu has no #ifdefs at all, and nisaba's I/O is behind its four bj_io
 * callbacks. Rather than braid two operating systems through both files, the
 * POSIX calls they want are declared once here and implemented over Win32
 * below, so the callers stay in one shape.
 *
 * PATHS ARE UTF-8 AT THIS BOUNDARY, always. Win32's narrow (…A) entry points
 * go through the process code page, which mangles every path the reference
 * corpus cares about; the wide (…W) ones take UTF-16. So each function below
 * converts, and the ANSI variants are never called. That is the single most
 * important thing about this file: a name with an em dash or a cuneiform sign
 * in it works, and would not if these were the A functions.
 */
#ifndef MDY_OSWIN_H
#define MDY_OSWIN_H

#ifdef _WIN32

#include <stdint.h>
#include <stddef.h>

/* UTF-8 -> UTF-16, allocated. Caller frees with free(). NULL on failure. */
wchar_t *win_widen(const char *utf8);

/* UTF-16 -> UTF-8, allocated. Caller frees with free(). NULL on failure. */
char *win_narrow(const wchar_t *w);

/* mkdir -p on a file's parent, taking a UTF-8 path. 0 on success. */
int win_ensure_parent(const char *utf8_path);

#endif /* _WIN32 */
#endif
