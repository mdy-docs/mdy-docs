#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#  include <windows.h>
#else
#  include <sys/time.h>
#endif

#include "cli_util.h"
#include "xalloc.h"

int cli_color;

double now_ms(void) {
#ifdef _WIN32
    return (double)GetTickCount64();
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (double)tv.tv_sec * 1000.0 + (double)tv.tv_usec / 1000.0;
#endif
}

void stamp_now(char *out, size_t cap) {
    if (!cap) return;
    time_t t = time(NULL);
    if (strftime(out, cap, "%I:%M:%S %p", localtime(&t)) == 0) { out[0] = '\0'; return; }
    if (out[0] == '0') memmove(out, out + 1, strlen(out));
}

int seen_before(char ***list, size_t *count, size_t *cap, const char *s) {
    for (size_t i = 0; i < *count; i++) if (strcmp((*list)[i], s) == 0) return 1;
    if (*count == *cap) { *cap = *cap ? *cap * 2 : 32; *list = mdy_xrealloc(*list, *cap * sizeof **list); }
    (*list)[(*count)++] = mdy_xstrdup(s);
    return 0;
}
