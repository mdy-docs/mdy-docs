/*
 * See oswin.h. Nothing in here is interesting except that it is all wide-char.
 */
#ifdef _WIN32

#include <stdlib.h>
#include <string.h>
#include <windows.h>

#include "oswin.h"

wchar_t *win_widen(const char *utf8) {
    if (!utf8) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *w = malloc((size_t)n * sizeof *w);
    if (!w) return NULL;
    if (MultiByteToWideChar(CP_UTF8, 0, utf8, -1, w, n) <= 0) { free(w); return NULL; }
    return w;
}

char *win_narrow(const wchar_t *w) {
    if (!w) return NULL;
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return NULL;
    char *s = malloc((size_t)n);
    if (!s) return NULL;
    if (WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL) <= 0) { free(s); return NULL; }
    return s;
}

int win_ensure_parent(const char *utf8_path) {
    char *copy = strdup(utf8_path);
    if (!copy) return -1;
    char *cut = strrchr(copy, '/');
    if (!cut) { free(copy); return 0; }
    *cut = '\0';

    int rc = 0;
    for (char *p = copy + 1; *p && rc == 0; p++) {
        if (*p != '/') continue;
        *p = '\0';
        wchar_t *w = win_widen(copy);
        if (w) {
            if (!CreateDirectoryW(w, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) rc = -1;
            free(w);
        }
        *p = '/';
    }
    if (rc == 0) {
        wchar_t *w = win_widen(copy);
        if (w) {
            if (!CreateDirectoryW(w, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) rc = -1;
            free(w);
        } else rc = -1;
    }
    free(copy);
    return rc;
}

#endif /* _WIN32 */
