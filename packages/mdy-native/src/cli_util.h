/*
 * What the command's translation units share: colour, the clock, the
 * timestamp, and a list that remembers what it has seen.
 */
#ifndef MDY_CLI_UTIL_H
#define MDY_CLI_UTIL_H
#include <stddef.h>

/*
 * Minimal ANSI colour, as bin/mdy.js does it: honours NO_COLOR and FORCE_COLOR,
 * and off when stdout is not a terminal — piped output, or a test harness
 * capturing it, never gets an escape code. main() decides.
 */
extern int cli_color;
static inline const char *esc(const char *code) { return cli_color ? code : ""; }
#define BOLD_OPEN()    esc("\x1b[1m")
#define BOLD_CLOSE()   esc("\x1b[22m")
#define DIM_OPEN()     esc("\x1b[2m")
#define DIM_CLOSE()    esc("\x1b[22m")
#define RED_OPEN()     esc("\x1b[31m")
#define RED_CLOSE()    esc("\x1b[39m")
#define GREEN_OPEN()   esc("\x1b[32m")
#define GREEN_CLOSE()  esc("\x1b[39m")
#define YELLOW_OPEN()  esc("\x1b[33m")
#define YELLOW_CLOSE() esc("\x1b[39m")
#define BLUE_OPEN()    esc("\x1b[34m")
#define BLUE_CLOSE()   esc("\x1b[39m")
#define CYAN_OPEN()    esc("\x1b[36m")
#define CYAN_CLOSE()   esc("\x1b[39m")
#define MAGENTA_OPEN() esc("\x1b[35m")
#define MAGENTA_CLOSE() esc("\x1b[39m")
/* an open/close pair, for a call that takes both */
#define BLUE   BLUE_OPEN(), BLUE_CLOSE()
#define GREEN  GREEN_OPEN(), GREEN_CLOSE()

/* Milliseconds from an arbitrary origin, for durations. */
double now_ms(void);

/*
 * "9:05:07 PM", as the JavaScript's toLocaleTimeString.
 *
 * %I and not %l. %l is a GNU extension — space-padded rather than zero-padded
 * — and emscripten's strftime does not have it: asked for "%l:%M:%S %p" it
 * returns 0 and writes nothing, so the whole stamp disappears rather than
 * losing a space. A `strftime` that returns 0 also leaves the buffer
 * UNSPECIFIED, which is why `out` is terminated here before anything reads
 * it.
 *
 * The zero %I pads with is dropped, which is what %l was reached for.
 */
void stamp_now(char *out, size_t cap);
#define TS(buf) (stamp_now(buf, sizeof buf), buf)

/* Whether `s` is already in the list, adding it when it is not. */
int seen_before(char ***list, size_t *count, size_t *cap, const char *s);

#endif
