/* The contract is in mdydoc.h. */
#include <stdlib.h>
#include <string.h>

#include "mdydoc.h"
#include "internal.h"

struct mdy_documents {
    mdy_chunk *chunks;
    size_t count;
    char *joined;      /* the chunks, rebuilt with their own newlines */
};

static int blank_run(const char *s, size_t len) {
    for (size_t i = 0; i < len; i++)
        if (s[i] != ' ' && s[i] != '\t' && s[i] != '\r' && s[i] != '\n') return 0;
    return 1;
}

/* `/^---[ \t]*$/` on a line that has already had its ending removed. */
static int is_separator(const char *s, size_t len) {
    if (len < 3 || s[0] != '-' || s[1] != '-' || s[2] != '-') return 0;
    for (size_t i = 3; i < len; i++)
        if (s[i] != ' ' && s[i] != '\t') return 0;
    return 1;
}

/* `/^\+\+\+[ \t]*$/` — the engine's fence is fixed, as mdy.js's is. */
static int is_fence(const char *s, size_t len) { return mdy_is_fence_line(s, len, "+++", 3); }

/*
 * While a list is being built a chunk is an OFFSET, not a pointer: the buffer
 * the chunks live in grows as sources are added, and a pointer taken before a
 * realloc is not the one to keep. They become pointers once, at the end.
 */
typedef struct { size_t start, len; } Span;

typedef struct {
    Span *spans;
    size_t count, cap;
    char *joined;
    size_t written, jcap;
} Acc;

static void acc_free(Acc *a) { free(a->spans); free(a->joined); }

static int acc_room(Acc *a, size_t more) {
    size_t need = a->written + more;
    if (need <= a->jcap) return 0;
    size_t want = a->jcap ? a->jcap : 64;
    while (need > want) want *= 2;
    char *grown = realloc(a->joined, want);
    if (!grown) return -1;
    a->joined = grown;
    a->jcap = want;
    return 0;
}

static int acc_span(Acc *a, size_t start, size_t len) {
    if (a->count == a->cap) {
        size_t want = a->cap ? a->cap * 2 : 4;
        Span *grown = realloc(a->spans, want * sizeof *grown);
        if (!grown) return -1;
        a->spans = grown;
        a->cap = want;
    }
    a->spans[a->count].start = start;
    a->spans[a->count].len = len;
    a->count++;
    return 0;
}

/*
 * One source's documents, appended to whatever is already there.
 *
 * `source.split('\n')` then rejoin per chunk, which is what mdy-docs does —
 * so a chunk's own line endings are `\n` whatever the file used, and the
 * boundaries land where the separators were.
 *
 * A CRLF file gets an EXTRA EMPTY LINE per line. That is not a tidy rule and
 * it is not ours — it is what mdy-docs does, and matching it is deliberate.
 *
 * Why it happens, because it is not guessable from here. `splitDocuments`
 * splits on `\n` alone, so every line keeps its `\r`. The
 * script compiler then puts each line inside a BACKTICK TEMPLATE LITERAL
 * (src/parse/script.js), and ECMAScript normalises a `<CR>` inside one to
 * `<LF>` — so `"crlf line\r"` is the string `"crlf line\n"` before anything
 * has looked at it. `scriptOutput` splits that on `/\r\n|\r|\n/` and gets two
 * lines where the file had one. Nothing in mdy.js mentions `\r` at all; the
 * behaviour is a property of the language the generated program is written in.
 *
 * So: the content keeps no `\r` (as before — a chunk's endings are `\n`), and
 * a line that ended in one is followed by an empty line. `crlf line\r\nsecond
 * \r\n` is five lines here and five there, and `$.text` is the same nineteen
 * bytes either side.
 *
 * This engine's own script layer already treats a lone `\r` as a terminator
 * (script.c) but coalesces `\r\n` into one, which is the correct reading of a
 * line ending and the reason it could not produce mdy-docs' answer by itself.
 */
static int acc_source(Acc *a, const char *text, size_t len) {
    /* Never more than `len` bytes of content: a separator line gives up at
     * least its three characters and writes one terminator back. Plus this
     * source's own terminator. */
    if (acc_room(a, len + 2) != 0) return -1;

    size_t first = a->count;
    size_t chunk_start = a->written;
    size_t line_start = 0;
    int wrote_line = 0;

    for (size_t i = 0; i <= len; i++) {
        if (i != len && text[i] != '\n') continue;
        size_t line_end = i;
        /* The `\r` leaves the content and comes back as an empty line below. */
        int had_cr = line_end > line_start && text[line_end - 1] == '\r';
        if (had_cr) line_end--;

        if (is_separator(text + line_start, line_end - line_start)) {
            if (acc_span(a, chunk_start, a->written - chunk_start) != 0) return -1;
            a->joined[a->written++] = '\0';
            chunk_start = a->written;
            wrote_line = 0;
        } else {
            if (wrote_line) a->joined[a->written++] = '\n';
            memcpy(a->joined + a->written, text + line_start, line_end - line_start);
            a->written += line_end - line_start;
            /*
             * The empty line the `\r` becomes. One byte in for one byte out —
             * the terminator replaces the carriage return — so the `len + 2`
             * this reserved still covers it.
             */
            if (had_cr) a->joined[a->written++] = '\n';
            wrote_line = 1;
        }
        line_start = i + 1;
    }
    if (acc_span(a, chunk_start, a->written - chunk_start) != 0) return -1;
    a->joined[a->written++] = '\0';

    /* Whitespace-only chunks are not documents. */
    size_t kept = first;
    for (size_t i = first; i < a->count; i++)
        if (!blank_run(a->joined + a->spans[i].start, a->spans[i].len))
            a->spans[kept++] = a->spans[i];

    /*
     * …unless nothing of THIS source survives, in which case the source is
     * ONE empty one.
     *
     * The rule is per source, and that is the whole difference between an
     * array of sources and the same files joined with `---`: joined, an empty
     * file is a blank chunk between two separators and disappears, so a walk
     * that counted one document for it and one identity handed every document
     * after it the wrong one.
     */
    if (kept == first) {
        a->spans[first].start = a->written - 1;      /* the terminator above */
        a->spans[first].len = 0;
        kept = first + 1;
    }
    a->count = kept;
    return 0;
}

static mdy_documents *acc_finish(Acc *a) {
    mdy_chunk *chunks = malloc((a->count ? a->count : 1) * sizeof *chunks);
    mdy_documents *out = calloc(1, sizeof *out);
    if (!chunks || !out) { free(chunks); free(out); acc_free(a); return NULL; }
    for (size_t i = 0; i < a->count; i++) {
        chunks[i].text = a->joined + a->spans[i].start;
        chunks[i].len = a->spans[i].len;
    }
    free(a->spans);
    out->chunks = chunks;
    out->count = a->count;
    out->joined = a->joined;
    return out;
}

mdy_documents *mdy_split_documents(const char *text, size_t len) {
    if (!text) return NULL;
    if (len == 0) len = strlen(text);

    Acc a = { 0 };
    if (acc_source(&a, text, len) != 0) { acc_free(&a); return NULL; }
    return acc_finish(&a);
}

mdy_documents *mdy_split_sources(const mdy_chunk *sources, size_t count,
                                 size_t *per_source) {
    if (count && !sources) return NULL;
    Acc a = { 0 };
    for (size_t i = 0; i < count; i++) {
        if (!sources[i].text) { acc_free(&a); return NULL; }
        size_t before = a.count;
        if (acc_source(&a, sources[i].text, sources[i].len) != 0) {
            acc_free(&a);
            return NULL;
        }
        if (per_source) per_source[i] = a.count - before;
    }
    return acc_finish(&a);
}

size_t mdy_documents_count(const mdy_documents *d) { return d ? d->count : 0; }

mdy_chunk mdy_documents_at(const mdy_documents *d, size_t i) {
    mdy_chunk none = { NULL, 0 };
    if (!d || i >= d->count) return none;
    return d->chunks[i];
}

void mdy_documents_free(mdy_documents *d) {
    if (!d) return;
    free(d->chunks);
    free(d->joined);
    free(d);
}

void mdy_split_frontmatter(const char *text, size_t len,
                           mdy_chunk *matter, mdy_chunk *body) {
    matter->text = NULL;
    matter->len = 0;
    body->text = text;
    body->len = len;
    if (!text) return;
    if (len == 0) len = strlen(text);
    body->len = len;

    /* Blank lines above the fence carry no meaning. */
    size_t i = 0;
    size_t open_start = 0, open_end = 0;
    for (;;) {
        size_t end = i;
        while (end < len && text[end] != '\n') end++;
        size_t trimmed = end;
        if (trimmed > i && text[trimmed - 1] == '\r') trimmed--;
        if (!blank_run(text + i, trimmed - i)) { open_start = i; open_end = trimmed; break; }
        if (end >= len) return;                 /* nothing but blank lines */
        i = end + 1;
    }

    if (!is_fence(text + open_start, open_end - open_start)) return;

    size_t after_open = open_end;
    while (after_open < len && text[after_open] != '\n') after_open++;
    if (after_open < len) after_open++;

    size_t at = after_open;
    while (at < len) {
        size_t end = at;
        while (end < len && text[end] != '\n') end++;
        size_t trimmed = end;
        if (trimmed > at && text[trimmed - 1] == '\r') trimmed--;
        if (is_fence(text + at, trimmed - at)) {
            matter->text = text + after_open;
            matter->len = at > after_open ? at - after_open - 1 : 0;   /* less the newline */
            size_t body_at = end < len ? end + 1 : len;
            body->text = text + body_at;
            body->len = len - body_at;
            return;
        }
        if (end >= len) break;
        at = end + 1;
    }
    /* An opening fence with no partner: the document is all body. */
}
