/*
 * YAML 1.2, core schema — the contract and the boundaries are in
 * mdyyaml.h.
 *
 * A line-oriented block parser with a recursive descent for flow collections,
 * which is the shape the language actually has: indentation decides structure,
 * and only inside `[` or `{` does that stop being true.
 *
 * It depends on nothing else here. Front matter is data, and a YAML reader has
 * no business knowing what a hast tree is.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "internal.h"
#include "mdytext.h"
#include "mdyyaml.h"

/* ---- allocation ------------------------------------------------------------
 *
 * One arena for the whole document, so freeing is one call and no node owns
 * anything. A 2.3 MB file of image metadata makes a lot of small nodes.
 */
typedef struct Chunk { struct Chunk *next; size_t used, cap; char data[]; } Chunk;

typedef struct { Chunk *head; } Arena;

static void *arena_alloc(Arena *a, size_t n) {
    n = (n + 15) & ~(size_t)15;
    if (!a->head || a->head->used + n > a->head->cap) {
        size_t cap = n > 65536 ? n : 65536;
        Chunk *c = malloc(sizeof *c + cap);
        if (!c) return NULL;
        c->next = a->head;
        c->used = 0;
        c->cap = cap;
        a->head = c;
    }
    void *p = a->head->data + a->head->used;
    a->head->used += n;
    return p;
}

static void arena_free(Arena *a) {
    for (Chunk *c = a->head; c;) { Chunk *next = c->next; free(c); c = next; }
    a->head = NULL;
}

/* ---- the tree --------------------------------------------------------------- */

typedef struct { const char *key; size_t key_len; mdy_yaml_node *value; } Pair;

struct mdy_yaml_node {
    mdy_yaml_type type;
    union {
        struct { const char *s; size_t len; } string;
        double number;
        int boolean;
        struct { mdy_yaml_node **items; size_t count; } seq;
        struct { Pair *pairs; size_t count; } map;
    } as;
};

struct mdy_yaml {
    Arena arena;
    mdy_yaml_node *root;
};

/* ---- lines ------------------------------------------------------------------ */

typedef struct {
    const char *s;      /* after the indentation */
    size_t len;
    size_t indent;      /* spaces before it */
    int tab;            /* a tab followed the spaces: an error where the line
                         * is structure, content inside a block scalar */
    const char *raw;    /* including the indentation, for block scalars */
    size_t raw_len;
    int blank;          /* nothing but whitespace */
} Line;

typedef struct {
    Line *lines;
    size_t count, at;
    /* A text ending in a newline splits to one more line than it has, and that
     * phantom is not a blank line — it decides how many newlines a `|+` block
     * scalar keeps. */
    int trailing_newline;
    Arena *arena;
    char *error;
    size_t error_len;
    int failed;
    size_t depth;       /* open block collections; capped at MDY_YAML_MAX_DEPTH */
} P;

static void fail(P *p, size_t line, const char *what) {
    if (p->failed) return;                 /* the first one is the useful one */
    p->failed = 1;
    if (p->error && p->error_len)
        snprintf(p->error, p->error_len, "line %zu: %s", line + 1, what);
}

/* An allocation failure, which is not a fault in the document and so is not
 * given a line. See MDY_YAML_OOM in mdyyaml.h. */
static void oom(P *p) {
    if (p->failed) return;
    p->failed = 1;
    if (p->error && p->error_len) snprintf(p->error, p->error_len, "%s", MDY_YAML_OOM);
}

static int is_space(char c) { return c == ' ' || c == '\t'; }

/* A comment starts at a `#` that begins the line or follows whitespace — which
 * is why `a#b` is a value and not a value with a comment. */
static size_t comment_at(const char *s, size_t len) {
    for (size_t i = 0; i < len; i++) {
        if (s[i] != '#') continue;
        if (i == 0 || is_space(s[i - 1])) return i;
    }
    return len;
}

/* ---- scalar resolution (the core schema) ------------------------------------ */

static int matches(const char *s, size_t len, const char *want) {
    return strlen(want) == len && memcmp(s, want, len) == 0;
}

/* `[-+]?[0-9]+`, `0o[0-7]+`, `0x[0-9a-fA-F]+` — the sign belongs to the
 * decimal form alone; `-0x1A` is a string. */
static int core_int(const char *s, size_t len, double *out) {
    if (len == 0) return 0;
    size_t i = 0;
    int neg = 0;
    if (s[0] == '-' || s[0] == '+') { neg = s[0] == '-'; i = 1; }
    if (i == 0 && i + 2 < len && s[i] == '0' && (s[i + 1] == 'o' || s[i + 1] == 'x')) {
        int base = s[i + 1] == 'o' ? 8 : 16;
        double v = 0;
        for (size_t k = i + 2; k < len; k++) {
            int d;
            char c = s[k];
            if (c >= '0' && c <= '9') d = c - '0';
            else if (base == 16 && c >= 'a' && c <= 'f') d = c - 'a' + 10;
            else if (base == 16 && c >= 'A' && c <= 'F') d = c - 'A' + 10;
            else return 0;
            if (d >= base) return 0;
            v = v * base + d;
        }
        *out = neg ? -v : v;
        return 1;
    }
    if (i >= len) return 0;
    /*
     * The loop validates; `strtod` decides the value.
     *
     * `v * 10 + digit` rounds once per digit, and seventeen of those do not
     * land where one correctly-rounded conversion does:
     * `99999999999999999` accumulated to 100000000000000016 where node — and
     * strtod — answer 100000000000000000, which is the nearest double. Both
     * are integers a document can plausibly carry (an id, a timestamp in
     * nanoseconds), and the first seventeen significant digits are where it
     * starts to show.
     *
     * Leading zeros are skipped before the copy so `0000…0001` stays short,
     * and a span too long for `tmp` keeps the accumulated value rather than a
     * truncated conversion: at five hundred significant digits the accumulation
     * is already the right infinity, and a truncated strtod would not be.
     * core_float below does the same thing with a smaller buffer.
     */
    double v = 0;
    size_t zeros = i;
    while (zeros < len && s[zeros] == '0') zeros++;
    for (size_t k = i; k < len; k++) {
        if (s[k] < '0' || s[k] > '9') return 0;
        v = v * 10 + (s[k] - '0');
    }
    char tmp[512];
    size_t digits = len - zeros;
    if (digits > 0 && digits < sizeof tmp) {
        memcpy(tmp, s + zeros, digits);
        tmp[digits] = '\0';
        v = strtod(tmp, NULL);
    }
    *out = neg ? -v : v;
    return 1;
}

/* `[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`, `.inf`, `.nan` */
static int core_float(const char *s, size_t len, double *out) {
    if (len == 0) return 0;
    size_t i = 0;
    int neg = 0;
    if (s[0] == '-' || s[0] == '+') { neg = s[0] == '-'; i = 1; }

    if (matches(s + i, len - i, ".inf") || matches(s + i, len - i, ".Inf") ||
        matches(s + i, len - i, ".INF")) {
        *out = neg ? -INFINITY : INFINITY;
        return 1;
    }
    if (i == 0 && (matches(s, len, ".nan") || matches(s, len, ".NaN") || matches(s, len, ".NAN"))) {
        *out = NAN;
        return 1;
    }

    size_t digits = 0, start = i;
    while (i < len && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
    if (i < len && s[i] == '.') {
        i++;
        while (i < len && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
    }
    if (digits == 0) return 0;
    if (i < len && (s[i] == 'e' || s[i] == 'E')) {
        i++;
        if (i < len && (s[i] == '-' || s[i] == '+')) i++;
        size_t ed = 0;
        while (i < len && s[i] >= '0' && s[i] <= '9') { i++; ed++; }
        if (ed == 0) return 0;
    }
    if (i != len) return 0;

    /*
     * The WHOLE span, not a truncated prefix. Truncating drops the tail, and
     * the tail can be the exponent: `1.` + 65 zeros + `e3` came back as 1.0
     * rather than 1000. core_int keeps its accumulated value for the same
     * reason; a float must hand strtod every digit, so a span longer than the
     * stack buffer is copied to a heap one. On OOM, refuse rather than
     * mis-read (return 0 — the scalar stays a string).
     */
    char stackbuf[64];
    size_t span = len - start;
    char *tmp = span < sizeof stackbuf ? stackbuf : malloc(span + 1);
    if (!tmp) return 0;
    memcpy(tmp, s + start, span);
    tmp[span] = '\0';
    double r = strtod(tmp, NULL);
    if (tmp != stackbuf) free(tmp);
    *out = neg ? -r : r;
    return 1;
}

static mdy_yaml_node *new_node(P *p, mdy_yaml_type type) {
    mdy_yaml_node *n = arena_alloc(p->arena, sizeof *n);
    if (!n) { oom(p); return NULL; }
    memset(n, 0, sizeof *n);
    n->type = type;
    return n;
}

static mdy_yaml_node *new_string(P *p, const char *s, size_t len) {
    mdy_yaml_node *n = new_node(p, MDY_YAML_STRING);
    if (!n) return NULL;
    char *copy = arena_alloc(p->arena, len + 1);
    if (!copy) { oom(p); return NULL; }
    memcpy(copy, s, len);
    copy[len] = '\0';
    n->as.string.s = copy;
    n->as.string.len = len;
    return n;
}

/* A PLAIN scalar, resolved. Quoted scalars never come here: they are strings
 * whatever they spell. */
static mdy_yaml_node *resolve(P *p, const char *s, size_t len) {
    double v;
    if (len == 0 || matches(s, len, "~") || matches(s, len, "null") ||
        matches(s, len, "Null") || matches(s, len, "NULL"))
        return new_node(p, MDY_YAML_NULL);

    if (matches(s, len, "true") || matches(s, len, "True") || matches(s, len, "TRUE")) {
        mdy_yaml_node *n = new_node(p, MDY_YAML_BOOL);
        if (n) n->as.boolean = 1;
        return n;
    }
    if (matches(s, len, "false") || matches(s, len, "False") || matches(s, len, "FALSE")) {
        mdy_yaml_node *n = new_node(p, MDY_YAML_BOOL);
        if (n) n->as.boolean = 0;
        return n;
    }
    if (core_int(s, len, &v) || core_float(s, len, &v)) {
        mdy_yaml_node *n = new_node(p, MDY_YAML_NUMBER);
        if (n) n->as.number = v;
        return n;
    }
    return new_string(p, s, len);
}

/* ---- quoted scalars ---------------------------------------------------------
 *
 * Both kinds may run across lines, and a line break inside one FOLDS: it
 * becomes a space, and a blank line becomes a newline instead. That is the
 * same rule plain scalars follow, and it is why a 2 MB file of wrapped prose
 * reads back as the sentences somebody wrote.
 */

static void fold_break(mdy_buf *out, size_t breaks) {
    /* One break is a space; every break after the first is kept as itself. */
    if (breaks == 0) return;
    if (breaks == 1) mdy_buf_putc(out, ' ');
    else for (size_t i = 1; i < breaks; i++) mdy_buf_putc(out, '\n');
}

/** `\x41`, `é`, `\U0001F600` — written back out as UTF-8. */
static void put_codepoint(mdy_buf *out, unsigned cp) {
    char enc[4];
    size_t n = mdy_utf8_encode((uint32_t)cp, enc);
    mdy_buf_put(out, enc, n);
}

static int hex_digits(const char *s, size_t len, size_t n, unsigned *out) {
    if (len < n) return 0;
    unsigned v = 0;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        int d;
        if (c >= '0' && c <= '9') d = c - '0';
        else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
        else return 0;
        v = v * 16 + (unsigned)d;
    }
    *out = v;
    return 1;
}

/*
 * A quoted scalar starting at `line[from]`. Returns the line it ended on
 * through `end_line`, and where it ended on that line through `end_col`.
 */
static mdy_yaml_node *read_quoted(P *p, size_t line, size_t from, char quote,
                                  size_t *end_line, size_t *end_col) {
    mdy_buf out = { .ok = 1, .seed = 128 };
    size_t li = line;
    size_t i = from + 1;                 /* past the opening quote */
    size_t breaks = 0;
    int closed = 0;

    while (li < p->count) {
        const Line *l = &p->lines[li];
        while (i < l->len) {
            char c = l->s[i];
            if (quote == '\'') {
                if (c == '\'') {
                    if (i + 1 < l->len && l->s[i + 1] == '\'') { /* '' is one ' */
                        if (breaks) { fold_break(&out, breaks); breaks = 0; }
                        mdy_buf_putc(&out, '\'');
                        i += 2;
                        continue;
                    }
                    i++;
                    closed = 1;
                    break;
                }
            } else {
                /*
                 * A `\` at the end of a line is an ESCAPED LINE BREAK: it
                 * suppresses the fold entirely, so the next line joins with
                 * nothing between. Without it a URL broken across two lines
                 * comes back with a backslash and a space in the middle of it.
                 */
                if (c == '\\' && i + 1 == l->len) {
                    if (breaks) { fold_break(&out, breaks); breaks = 0; }
                    li++;
                    if (li >= p->count) { fail(p, line, "unterminated double-quoted scalar"); free(out.s); return NULL; }
                    i = 0;
                    /* The next line's own indentation is not content. */
                    while (i < p->lines[li].len && is_space(p->lines[li].s[i])) i++;
                    l = &p->lines[li];
                    continue;
                }
                if (c == '\\' && i + 1 < l->len) {
                    if (breaks) { fold_break(&out, breaks); breaks = 0; }
                    char e = l->s[i + 1];
                    i += 2;
                    unsigned cp = 0;
                    switch (e) {
                        case 'n': mdy_buf_putc(&out, '\n'); break;
                        case 't': mdy_buf_putc(&out, '\t'); break;
                        case 'r': mdy_buf_putc(&out, '\r'); break;
                        case 'b': mdy_buf_putc(&out, '\b'); break;
                        case 'f': mdy_buf_putc(&out, '\f'); break;
                        case '0': mdy_buf_putc(&out, '\0'); break;
                        case 'a': mdy_buf_putc(&out, '\a'); break;
                        case 'v': mdy_buf_putc(&out, '\v'); break;
                        case 'e': mdy_buf_putc(&out, 0x1B); break;
                        case '/': mdy_buf_putc(&out, '/'); break;
                        case '\\': mdy_buf_putc(&out, '\\'); break;
                        case '"': mdy_buf_putc(&out, '"'); break;
                        case ' ': mdy_buf_putc(&out, ' '); break;
                        case 'N': put_codepoint(&out, 0x85); break;
                        case '_': put_codepoint(&out, 0xA0); break;
                        case 'L': put_codepoint(&out, 0x2028); break;
                        case 'P': put_codepoint(&out, 0x2029); break;
                        case 'x': if (!hex_digits(l->s + i, l->len - i, 2, &cp)) {
                                      fail(p, li, "bad \\x escape"); free(out.s); return NULL;
                                  } i += 2; put_codepoint(&out, cp); break;
                        case 'u': if (!hex_digits(l->s + i, l->len - i, 4, &cp)) {
                                      fail(p, li, "bad \\u escape"); free(out.s); return NULL;
                                  }
                                  i += 4;
                                  /* A surrogate pair is one character, written
                                   * as two escapes; a surrogate alone is not a
                                   * character at all and becomes U+FFFD. */
                                  if (cp >= 0xD800 && cp <= 0xDBFF) {
                                      uint32_t low = 0;
                                      if (l->len - i >= 6 && l->s[i] == '\\' && l->s[i + 1] == 'u' &&
                                          hex_digits(l->s + i + 2, l->len - i - 2, 4, &low) &&
                                          low >= 0xDC00 && low <= 0xDFFF) {
                                          cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                                          i += 6;
                                      } else cp = 0xFFFD;
                                  } else if (cp >= 0xDC00 && cp <= 0xDFFF) cp = 0xFFFD;
                                  put_codepoint(&out, cp); break;
                        case 'U': if (!hex_digits(l->s + i, l->len - i, 8, &cp) || cp > 0x10FFFF ||
                                      (cp >= 0xD800 && cp <= 0xDFFF)) {
                                      fail(p, li, "bad \\U escape"); free(out.s); return NULL;
                                  } i += 8; put_codepoint(&out, cp); break;
                        default:
                            fail(p, li, "unknown escape in a double-quoted scalar");
                            free(out.s);
                            return NULL;
                    }
                    continue;
                }
                if (c == '"') { i++; closed = 1; break; }
            }
            if (breaks) { fold_break(&out, breaks); breaks = 0; }
            mdy_buf_putc(&out, c);
            i++;
        }
        if (closed) break;

        /* The line ended without a closing quote: fold and continue. */
        breaks++;
        li++;
        if (li >= p->count) break;
        i = 0;
        /* Leading and trailing whitespace around a fold is dropped. */
        while (out.len && out.s[out.len - 1] == ' ') out.s[--out.len] = '\0';
    }

    if (!closed) {
        fail(p, line, quote == '\'' ? "unterminated single-quoted scalar"
                                    : "unterminated double-quoted scalar");
        free(out.s);
        return NULL;
    }

    /* `out.ok` is the whole point of the flag: a buf_put that could not grow
     * would leave the scalar silently TRUNCATED, and a truncated title is a
     * document that means something its author did not write. */
    if (!out.ok) { oom(p); free(out.s); return NULL; }

    mdy_yaml_node *n = new_string(p, out.s ? out.s : "", out.len);
    free(out.s);
    *end_line = li;
    *end_col = i;
    return n;
}

/* ---- block scalars ----------------------------------------------------------
 *
 * `|` keeps the line breaks it was written with; `>` folds them into spaces,
 * except around a blank line or a line indented further than the block, which
 * keep theirs. The chomping indicator decides the tail: `-` strips every
 * trailing newline, `+` keeps them all, and the default clips to one.
 */
static mdy_yaml_node *read_block_scalar(P *p, const char *header, size_t header_len,
                                        size_t parent_indent) {
    int folded = header[0] == '>';
    int chomp = 0;                        /* -1 strip, 0 clip, +1 keep */
    size_t explicit_indent = 0;

    for (size_t i = 1; i < header_len; i++) {
        char c = header[i];
        if (c == '-') chomp = -1;
        else if (c == '+') chomp = 1;
        else if (c >= '1' && c <= '9') explicit_indent = (size_t)(c - '0');
        else if (is_space(c)) break;
        else { fail(p, p->at, "bad block scalar header"); return NULL; }
    }

    size_t first = p->at + 1;
    size_t content_indent = explicit_indent ? parent_indent + explicit_indent : 0;

    if (!content_indent) {
        /* Auto-detected from the first non-empty line. */
        for (size_t i = first; i < p->count; i++) {
            if (p->lines[i].blank) continue;
            if (p->lines[i].indent <= parent_indent) break;
            content_indent = p->lines[i].indent;
            break;
        }
    }
    if (!content_indent) {
        /*
         * No content at all — `k: >` with nothing indented under it. The
         * cursor still has to move past the header, and forgetting that is
         * not a wrong value but an unbounded loop: the caller re-reads the
         * same key forever. A mutation fuzz found it in 400 inputs.
         */
        p->at = first;
        return new_string(p, "", 0);
    }

    mdy_buf out = { .ok = 1, .seed = 128 };
    size_t i = first;
    size_t pending_breaks = 0;
    int wrote_any = 0;
    int last_was_more_indented = 0;

    for (; i < p->count; i++) {
        const Line *l = &p->lines[i];
        if (l->blank) { pending_breaks++; continue; }
        if (l->indent < content_indent) break;

        /* The line, with the block's own indentation removed and any extra
         * kept — which is what makes a folded block able to hold a listing. */
        const char *s = l->raw + content_indent;
        size_t n = l->raw_len - content_indent;
        int more_indented = l->indent > content_indent;

        if (!wrote_any) {
            pending_breaks = 0;           /* leading blank lines are not content */
        } else if (!folded || more_indented || last_was_more_indented || pending_breaks) {
            /* Literal keeps every break. Folded keeps them around a blank line
             * and around a more-indented line, and folds only between two
             * ordinary ones. */
            size_t breaks = pending_breaks + 1;
            if (folded && !more_indented && !last_was_more_indented) {
                for (size_t k = 1; k < breaks; k++) mdy_buf_putc(&out, '\n');
            } else {
                for (size_t k = 0; k < breaks; k++) mdy_buf_putc(&out, '\n');
            }
            pending_breaks = 0;
        } else {
            mdy_buf_putc(&out, ' ');
        }

        mdy_buf_put(&out, s, n);
        wrote_any = 1;
        last_was_more_indented = more_indented;
    }

    p->at = i;

    /* The tail. `pending_breaks` counts the blank lines after the content, and
     * the content's own last line contributes one more. */
    if (wrote_any) {
        /* The phantom line the document's own final newline produced is not
         * one of the block's trailing blank lines. */
        if (i >= p->count && p->trailing_newline && pending_breaks) pending_breaks--;
        if (chomp > 0) for (size_t k = 0; k <= pending_breaks; k++) mdy_buf_putc(&out, '\n');
        else if (chomp == 0) mdy_buf_putc(&out, '\n');
    }

    if (!out.ok) { oom(p); free(out.s); return NULL; }

    mdy_yaml_node *node = new_string(p, out.s ? out.s : "", out.len);
    free(out.s);
    return node;
}

/* ---- flow collections --------------------------------------------------------
 *
 * Inside `[` or `{`, indentation stops deciding anything, so this is an
 * ordinary recursive descent over a cursor that walks off the end of one line
 * onto the next.
 */
typedef struct { P *p; size_t line, col; } Cur;

static void cur_skip(Cur *c) {
    for (;;) {
        const Line *l = &c->p->lines[c->line];
        while (c->col < l->len && is_space(l->s[c->col])) c->col++;
        if (c->col < l->len && l->s[c->col] == '#' &&
            (c->col == 0 || is_space(l->s[c->col - 1]))) c->col = l->len;
        if (c->col < l->len) return;
        if (c->line + 1 >= c->p->count) return;
        c->line++;
        c->col = 0;
    }
}

static int cur_at(Cur *c, char want) {
    const Line *l = &c->p->lines[c->line];
    return c->col < l->len && l->s[c->col] == want;
}

static mdy_yaml_node *parse_flow(Cur *c);

/* A plain scalar inside a flow collection ends at `,`, `]`, `}` or `: `. */
static mdy_yaml_node *flow_plain(Cur *c) {
    const Line *l = &c->p->lines[c->line];
    size_t start = c->col;
    size_t end = start;
    while (c->col < l->len) {
        char ch = l->s[c->col];
        if (ch == ',' || ch == ']' || ch == '}') break;
        if (ch == ':' && (c->col + 1 >= l->len || is_space(l->s[c->col + 1]) ||
                          l->s[c->col + 1] == ',' || l->s[c->col + 1] == ']' ||
                          l->s[c->col + 1] == '}')) break;
        if (ch == '#' && c->col > start && is_space(l->s[c->col - 1])) break;
        c->col++;
        if (!is_space(ch)) end = c->col;
    }
    return resolve(c->p, l->s + start, end - start);
}

static mdy_yaml_node *flow_scalar(Cur *c) {
    const Line *l = &c->p->lines[c->line];
    char ch = l->s[c->col];
    if (ch == '"' || ch == '\'') {
        size_t end_line = 0, end_col = 0;
        mdy_yaml_node *n = read_quoted(c->p, c->line, c->col, ch, &end_line, &end_col);
        c->line = end_line;
        c->col = end_col;
        return n;
    }
    if (ch == '&' || ch == '*' || ch == '!') {
        fail(c->p, c->line, ch == '!' ? "tags are not supported"
                                      : "anchors and aliases are not supported");
        return NULL;
    }
    return flow_plain(c);
}

/* `depth` is how many flow collections are open around this point — see
 * MDY_YAML_MAX_DEPTH. Carried as an argument rather than on the cursor
 * because this branch has four ways out and a counter would have to be given
 * back on each of them. */
static mdy_yaml_node *parse_flow_at(Cur *c, size_t depth);

static mdy_yaml_node *parse_flow(Cur *c) { return parse_flow_at(c, 0); }

static mdy_yaml_node *parse_flow_at(Cur *c, size_t depth) {
    cur_skip(c);
    if (c->p->failed) return NULL;

    if (cur_at(c, '[') || cur_at(c, '{')) {
        int is_map = cur_at(c, '{');
        char close = is_map ? '}' : ']';
        if (depth >= MDY_YAML_MAX_DEPTH) {
            fail(c->p, c->line, "nested deeper than this reads");
            return NULL;
        }
        c->col++;

        mdy_yaml_node *node = new_node(c->p, is_map ? MDY_YAML_MAPPING : MDY_YAML_SEQUENCE);
        if (!node) return NULL;

        /* Collected loosely and copied into the arena once the count is known. */
        size_t cap = 8, count = 0;
        mdy_yaml_node **items = NULL;
        Pair *pairs = NULL;
        if (is_map) pairs = malloc(cap * sizeof *pairs);
        else items = malloc(cap * sizeof *items);
        if ((is_map && !pairs) || (!is_map && !items)) { oom(c->p); return NULL; }

        for (;;) {
            cur_skip(c);
            if (c->p->failed) goto flow_fail;
            if (cur_at(c, close)) { c->col++; break; }
            if (c->col >= c->p->lines[c->line].len) {
                fail(c->p, c->line, is_map ? "unterminated flow mapping"
                                           : "unterminated flow sequence");
                goto flow_fail;
            }

            if (count == cap) {
                cap *= 2;
                void *grown = is_map ? (void *)realloc(pairs, cap * sizeof *pairs)
                                     : (void *)realloc(items, cap * sizeof *items);
                if (!grown) { oom(c->p); goto flow_fail; }
                if (is_map) pairs = grown; else items = grown;
            }

            if (is_map) {
                mdy_yaml_node *k = flow_scalar(c);
                if (!k) goto flow_fail;
                cur_skip(c);
                if (!cur_at(c, ':')) { fail(c->p, c->line, "expected `:` in a flow mapping"); goto flow_fail; }
                c->col++;
                cur_skip(c);
                mdy_yaml_node *v;
                if (cur_at(c, ',') || cur_at(c, close)) v = new_node(c->p, MDY_YAML_NULL);
                else v = parse_flow_at(c, depth + 1);
                if (!v) goto flow_fail;
                size_t klen = 0;
                const char *ks = mdy_yaml_string(k, &klen);
                if (!ks) {
                    /* A non-string key is written as it resolved, which is what
                     * JSON does with an object key too. */
                    char tmp[64];
                    int n = 0;
                    if (k->type == MDY_YAML_NUMBER) n = snprintf(tmp, sizeof tmp, "%g", k->as.number);
                    else if (k->type == MDY_YAML_BOOL) n = snprintf(tmp, sizeof tmp, "%s", k->as.boolean ? "true" : "false");
                    else n = snprintf(tmp, sizeof tmp, "null");
                    mdy_yaml_node *s = new_string(c->p, tmp, (size_t)n);
                    if (!s) goto flow_fail;
                    ks = s->as.string.s;
                    klen = s->as.string.len;
                }
                pairs[count].key = ks;
                pairs[count].key_len = klen;
                pairs[count].value = v;
            } else {
                mdy_yaml_node *v = parse_flow_at(c, depth + 1);
                if (!v) goto flow_fail;
                items[count] = v;
            }
            count++;

            cur_skip(c);
            if (cur_at(c, ',')) { c->col++; continue; }
            if (cur_at(c, close)) { c->col++; break; }
            if (c->col >= c->p->lines[c->line].len) {
                fail(c->p, c->line, is_map ? "unterminated flow mapping"
                                           : "unterminated flow sequence");
            } else {
                fail(c->p, c->line, "expected `,` or a closing bracket in a flow collection");
            }
            goto flow_fail;
        }

        if (is_map) {
            Pair *out = arena_alloc(c->p->arena, (count ? count : 1) * sizeof *out);
            if (!out) { oom(c->p); goto flow_fail; }
            memcpy(out, pairs, count * sizeof *out);
            node->as.map.pairs = out;
            node->as.map.count = count;
            free(pairs);
        } else {
            mdy_yaml_node **out = arena_alloc(c->p->arena, (count ? count : 1) * sizeof *out);
            if (!out) { oom(c->p); goto flow_fail; }
            memcpy(out, items, count * sizeof *out);
            node->as.seq.items = out;
            node->as.seq.count = count;
            free(items);
        }
        return node;

    flow_fail:
        free(pairs);
        free(items);
        return NULL;
    }

    return flow_scalar(c);
}

/* ---- block structure --------------------------------------------------------- */

static mdy_yaml_node *parse_block(P *p, size_t indent);

/** The next line that is neither blank nor only a comment, or count. */
static int nothing_after(const Line *l, size_t from);

static size_t next_content(P *p, size_t from) {
    while (from < p->count) {
        const Line *l = &p->lines[from];
        if (!l->blank && !(l->len && l->s[0] == '#')) {
            /* A tab may not be indentation — the spec is explicit, and the
             * failure it otherwise causes is a structure that silently changes
             * shape. Inside a block scalar the same bytes are content, which
             * is why the line is refused here, where it is read as structure,
             * and not when it was split. */
            if (l->tab) { fail(p, from, "a tab cannot be used for indentation"); return p->count; }
            return from;
        }
        from++;
    }
    return p->count;
}

/* `---` or `...` alone on a line at column 0, trailing whitespace allowed. */
static int marker_line(const Line *l, const char *marker) {
    if (l->indent != 0 || l->len < 3 || memcmp(l->s, marker, 3) != 0) return 0;
    if (l->len == 3) return 1;
    if (!is_space(l->s[3])) return 0;
    return memcmp(marker, "...", 3) != 0 || nothing_after(l, 3);
}

/** A `- ` item, or a bare `-`. */
static int is_seq_item(const Line *l) {
    return l->len && l->s[0] == '-' && (l->len == 1 || is_space(l->s[1]));
}

/*
 * Where a mapping key ends: the `:` that is followed by whitespace or ends the
 * line, skipping over anything quoted or bracketed. Returns 0 when the line
 * does not open a mapping — `a:b` is a plain scalar, not a key.
 */
/*
 * A quoted scalar ENDS at its closing quote, and what may follow on that line
 * is nothing, or a comment. Accepting `title: "Hello" world` as `Hello` drops
 * `world` on the floor, and `name: "it"s.mdy"` becomes `it` — which is what
 * this file says it will not do: "a parser that silently mis-reads data is
 * worse than one that refuses it". node's reader refuses both.
 */
static int nothing_after(const Line *l, size_t from) {
    while (from < l->len && is_space(l->s[from])) from++;
    return from >= l->len || l->s[from] == '#';
}

/* The same question between a quoted KEY and the `:` it was measured against,
 * where a comment is not one of the answers — `key_end` stops at a `#`. */
static int spaces_between(const Line *l, size_t from, size_t to) {
    for (; from < to && from < l->len; from++) if (!is_space(l->s[from])) return 0;
    return 1;
}

static size_t key_end(const Line *l) {
    size_t i = 0;
    int depth = 0;
    if (l->len && (l->s[0] == '"' || l->s[0] == '\'')) {
        char q = l->s[0];
        i = 1;
        while (i < l->len) {
            if (q == '\'' && l->s[i] == '\'' && i + 1 < l->len && l->s[i + 1] == '\'') { i += 2; continue; }
            if (q == '"' && l->s[i] == '\\') { i += 2; continue; }
            if (l->s[i] == q) { i++; break; }
            i++;
        }
    }
    for (; i < l->len; i++) {
        char c = l->s[i];
        if (c == '[' || c == '{') depth++;
        else if (c == ']' || c == '}') { if (depth) depth--; }
        else if (c == '#' && i && is_space(l->s[i - 1])) return 0;
        else if (c == ':' && depth == 0 && (i + 1 == l->len || is_space(l->s[i + 1])))
            return i;
    }
    return 0;
}

/*
 * A value written after `key:` or `- `, which may be a flow collection, a
 * block scalar header, a quoted scalar, or a plain one — and any of the last
 * three may run on to the lines below.
 */
/* Whether plain-scalar text holds a `: ` or ends in `:`, which is what the
 * grammar reads as a mapping's key rather than as text. */
static int holds_key(const char *s, size_t len) {
    if (len && s[len - 1] == ':') return 1;
    for (size_t i = 0; i + 1 < len; i++)
        if (s[i] == ':' && is_space(s[i + 1])) return 1;
    return 0;
}

static mdy_yaml_node *parse_value_from(P *p, size_t line, size_t col, size_t indent) {
    const Line *l = &p->lines[line];
    while (col < l->len && is_space(l->s[col])) col++;

    size_t end = comment_at(l->s, l->len);
    if (col >= end) {
        /* Nothing on this line: the value is whatever is indented below it, or
         * a sequence at this key's own indent. */
        p->at = line + 1;
        size_t next = next_content(p, p->at);
        if (next >= p->count) return new_node(p, MDY_YAML_NULL);
        const Line *n = &p->lines[next];
        if (n->indent > indent || (is_seq_item(n) && n->indent == indent)) {
            p->at = next;
            return parse_block(p, n->indent);
        }
        return new_node(p, MDY_YAML_NULL);
    }

    char c = l->s[col];

    if (c == '|' || c == '>') {
        p->at = line;
        return read_block_scalar(p, l->s + col, end - col, indent);
    }

    if (c == '&' || c == '*') { fail(p, line, "anchors and aliases are not supported"); return NULL; }
    if (c == '!') { fail(p, line, "tags are not supported"); return NULL; }

    if (c == '[' || c == '{') {
        Cur cur = { p, line, col };
        mdy_yaml_node *n = parse_flow(&cur);
        if (n && !nothing_after(&p->lines[cur.line], cur.col)) {
            fail(p, cur.line, "unexpected text after a flow collection");
            return NULL;
        }
        p->at = cur.line + 1;
        return n;
    }

    if (c == '"' || c == '\'') {
        size_t end_line = 0, end_col = 0;
        mdy_yaml_node *n = read_quoted(p, line, col, c, &end_line, &end_col);
        if (!n) return NULL;
        if (!nothing_after(&p->lines[end_line], end_col)) {
            fail(p, end_line, "unexpected text after a quoted scalar");
            return NULL;
        }
        p->at = end_line + 1;
        return n;
    }

    /*
     * A plain scalar, which continues onto any following line that is indented
     * past the key and does not itself open something. Line breaks fold: one
     * becomes a space, and a blank line becomes a newline.
     */
    mdy_buf out = { .ok = 1, .seed = 128 };
    size_t stop = end;
    while (stop > col && is_space(l->s[stop - 1])) stop--;
    /* `a: b: c` is not a value of `b: c`: a plain scalar cannot hold what
     * would start a mapping, and every YAML reader refuses it. */
    if (holds_key(l->s + col, stop - col)) {
        fail(p, line, "a plain scalar cannot contain `: `");
        free(out.s);
        return NULL;
    }
    mdy_buf_put(&out, l->s + col, stop - col);

    size_t i = line + 1;
    size_t breaks = 0;
    for (; i < p->count; i++) {
        const Line *cont = &p->lines[i];
        if (cont->blank) { breaks++; continue; }
        if (cont->indent <= indent) break;
        if (is_seq_item(cont) || key_end(cont)) break;
        if (cont->tab) { fail(p, i, "a tab cannot be used for indentation"); free(out.s); return NULL; }
        size_t cend = comment_at(cont->s, cont->len);
        while (cend > 0 && is_space(cont->s[cend - 1])) cend--;
        if (cend == 0) { breaks++; continue; }
        if (holds_key(cont->s, cend)) {
            fail(p, i, "a plain scalar cannot contain `: `");
            free(out.s);
            return NULL;
        }
        fold_break(&out, breaks + 1);
        breaks = 0;
        mdy_buf_put(&out, cont->s, cend);
    }
    p->at = i - breaks;

    if (!out.ok) { oom(p); free(out.s); return NULL; }

    mdy_yaml_node *n = resolve(p, out.s ? out.s : "", out.len);
    free(out.s);
    return n;
}

/*
 * The keys a block mapping has taken, for the duplicate check. A mapping of up
 * to KEYS_SCAN keys is scanned, which is every front matter there is; past
 * that it gets a hash set, so a record file of any size is checked in linear
 * time. A slot holds an index into the mapping's pairs plus one, and zero is
 * empty; indices rather than pointers because the pairs array is reallocated
 * as it grows.
 */
enum { KEYS_SCAN = 16 };

typedef struct { size_t *slots; size_t cap; } KeySet;

static size_t key_hash(const char *s, size_t len) {
    uint64_t h = 1469598103934665603u;
    for (size_t i = 0; i < len; i++) { h ^= (unsigned char)s[i]; h *= 1099511628211u; }
    return (size_t)h;
}

/*
 * Whether `key` is one of pairs[0..count), and when it is not, record it as
 * pairs[count], which the caller writes before the next call. 1 when taken,
 * 0 when new, -1 when the set could not be allocated.
 */
static int key_taken(KeySet *set, const Pair *pairs, size_t count,
                     const char *key, size_t len) {
    if (count < KEYS_SCAN) {
        for (size_t k = 0; k < count; k++)
            if (pairs[k].key_len == len && memcmp(pairs[k].key, key, len) == 0) return 1;
        return 0;
    }
    if ((count + 1) * 2 > set->cap) {             /* at most half full */
        size_t cap = set->cap ? set->cap * 2 : 64;
        while ((count + 1) * 2 > cap) cap *= 2;
        size_t *slots = calloc(cap, sizeof *slots);
        if (!slots) return -1;
        for (size_t k = 0; k < count; k++) {
            size_t at = key_hash(pairs[k].key, pairs[k].key_len) & (cap - 1);
            while (slots[at]) at = (at + 1) & (cap - 1);
            slots[at] = k + 1;
        }
        free(set->slots);
        set->slots = slots;
        set->cap = cap;
    }
    size_t mask = set->cap - 1;
    size_t at = key_hash(key, len) & mask;
    for (; set->slots[at]; at = (at + 1) & mask) {
        const Pair *taken = &pairs[set->slots[at] - 1];
        if (taken->key_len == len && memcmp(taken->key, key, len) == 0) return 1;
    }
    set->slots[at] = count + 1;
    return 0;
}

static mdy_yaml_node *parse_mapping(P *p, size_t indent) {
    mdy_yaml_node *node = new_node(p, MDY_YAML_MAPPING);
    if (!node) return NULL;

    size_t cap = 8, count = 0;
    Pair *pairs = malloc(cap * sizeof *pairs);
    if (!pairs) { oom(p); return NULL; }
    KeySet keys = { NULL, 0 };

    for (;;) {
        size_t at = next_content(p, p->at);
        if (at >= p->count) break;
        const Line *l = &p->lines[at];
        if (l->indent != indent) break;
        if (is_seq_item(l)) break;

        size_t ke = key_end(l);
        if (!ke) { fail(p, at, "expected `key: value`"); goto map_fail; }
        if (l->s[0] == '?') { fail(p, at, "explicit keys are not supported"); goto map_fail; }

        /* The key, which may be quoted. */
        const char *ks;
        size_t klen;
        mdy_yaml_node *kn = NULL;
        if (l->s[0] == '"' || l->s[0] == '\'') {
            size_t el = 0, ec = 0;
            kn = read_quoted(p, at, 0, l->s[0], &el, &ec);
            if (!kn) goto map_fail;
            /* `"a"x: v` measured its key against a `:` that is not this
             * scalar's — the same guess, one line up from the value. */
            if (el != at || !spaces_between(l, ec, ke)) {
                fail(p, at, "unexpected text after a quoted key");
                goto map_fail;
            }
            ks = kn->as.string.s;
            klen = kn->as.string.len;
        } else {
            size_t kend = ke;
            while (kend > 0 && is_space(l->s[kend - 1])) kend--;
            if (kend >= 2 && l->s[0] == '<' && l->s[1] == '<') {
                fail(p, at, "merge keys are not supported");
                goto map_fail;
            }
            kn = new_string(p, l->s, kend);
            if (!kn) goto map_fail;
            ks = kn->as.string.s;
            klen = kn->as.string.len;
        }

        p->at = at;
        mdy_yaml_node *v = parse_value_from(p, at, ke + 1, indent);
        if (!v) goto map_fail;

        if (count == cap) {
            cap *= 2;
            Pair *grown = realloc(pairs, cap * sizeof *pairs);
            if (!grown) { oom(p); goto map_fail; }
            pairs = grown;
        }
        /*
         * "It is an error for two equal keys to appear in the same mapping."
         * The specification is explicit, and the alternative — quietly keeping
         * one of them — is a document that means something its author did not
         * write.
         */
        int taken = key_taken(&keys, pairs, count, ks, klen);
        if (taken < 0) { oom(p); goto map_fail; }
        if (taken) { fail(p, at, "duplicate key in a mapping"); goto map_fail; }
        pairs[count].key = ks;
        pairs[count].key_len = klen;
        pairs[count].value = v;
        count++;
    }

    {
        Pair *out = arena_alloc(p->arena, (count ? count : 1) * sizeof *out);
        if (!out) { oom(p); goto map_fail; }
        memcpy(out, pairs, count * sizeof *out);
        node->as.map.pairs = out;
        node->as.map.count = count;
    }
    free(keys.slots);
    free(pairs);
    return node;

map_fail:
    free(keys.slots);
    free(pairs);
    return NULL;
}

static mdy_yaml_node *parse_sequence(P *p, size_t indent) {
    mdy_yaml_node *node = new_node(p, MDY_YAML_SEQUENCE);
    if (!node) return NULL;

    size_t cap = 8, count = 0;
    mdy_yaml_node **items = malloc(cap * sizeof *items);
    if (!items) { oom(p); return NULL; }

    for (;;) {
        size_t at = next_content(p, p->at);
        if (at >= p->count) break;
        Line *l = &p->lines[at];
        if (l->indent != indent || !is_seq_item(l)) break;

        size_t after = 1;
        while (after < l->len && is_space(l->s[after])) after++;
        size_t rest = comment_at(l->s, l->len);

        mdy_yaml_node *v;
        if (after >= rest) {
            /* `-` alone: the item is what is indented below it. */
            p->at = at + 1;
            size_t next = next_content(p, p->at);
            if (next < p->count && p->lines[next].indent > indent) {
                p->at = next;
                v = parse_block(p, p->lines[next].indent);
            } else {
                v = new_node(p, MDY_YAML_NULL);
            }
        } else {
            /*
             * `- key: value` and `- - x` are the compact forms: the rest of the
             * line is a block of its own, starting at the column the content
             * does. Rewriting the line in place is exactly that statement — the
             * dash is consumed and what follows stands on its own.
             */
            Line saved = *l;
            l->s += after;
            l->len -= after;
            l->indent += after;
            l->raw = l->s;
            l->raw_len = l->len;
            p->at = at;
            v = parse_block(p, l->indent);
            *l = saved;
        }
        if (!v) goto seq_fail;

        if (count == cap) {
            cap *= 2;
            mdy_yaml_node **grown = realloc(items, cap * sizeof *items);
            if (!grown) { oom(p); goto seq_fail; }
            items = grown;
        }
        items[count++] = v;
    }

    {
        mdy_yaml_node **out = arena_alloc(p->arena, (count ? count : 1) * sizeof *out);
        if (!out) { oom(p); goto seq_fail; }
        memcpy(out, items, count * sizeof *out);
        node->as.seq.items = out;
        node->as.seq.count = count;
    }
    free(items);
    return node;

seq_fail:
    free(items);
    return NULL;
}

static mdy_yaml_node *parse_block(P *p, size_t indent) {
    size_t at = next_content(p, p->at);
    if (at >= p->count) return new_node(p, MDY_YAML_NULL);
    p->at = at;

    /*
     * Bound the block recursion as parse_flow_at bounds the flow recursion.
     * Every nesting step re-enters here — an indented value, a `- ` item, and
     * the compact `- - x` / `- key:` forms parse_sequence rewrites into a
     * block of their own — so this is the one place a depth cap belongs.
     * Without it the flow guard (MDY_YAML_MAX_DEPTH) never saw block nesting,
     * because block structure has no brackets to count, and `- ` * 400000
     * (two bytes per level) overflowed the stack. The serializer json_node
     * recurses over the same tree, so a cap here bounds it too.
     */
    if (p->depth >= MDY_YAML_MAX_DEPTH) {
        fail(p, at, "nested deeper than this reads");
        return NULL;
    }
    p->depth++;

    const Line *l = &p->lines[at];
    mdy_yaml_node *result;
    if (is_seq_item(l)) result = parse_sequence(p, indent);
    else if (key_end(l)) result = parse_mapping(p, indent);
    /* A bare scalar: its continuation lines must sit deeper than the
     * collection it is in, and parse_sequence has already rewritten an
     * item's line to sit one column past the marker, so the bound is one
     * less than that line's own indent. */
    else result = parse_value_from(p, at, 0, indent == 0 ? 0 : indent - 1);

    p->depth--;
    return result;
}

/* ---- the stream --------------------------------------------------------------- */

/* A line ends at `\n`, and a `\r` before it is part of the ending, not the
 * content — the reading YAML and the `yaml` package both give a CRLF file. */
static Line *split_lines(const char *text, size_t len, size_t *count) {
    size_t n = 1;
    for (size_t i = 0; i < len; i++) if (text[i] == '\n') n++;
    Line *lines = malloc(sizeof *lines * n);
    if (!lines) return NULL;

    size_t out = 0, start = 0;
    for (size_t i = 0; i <= len; i++) {
        if (i != len && text[i] != '\n') continue;
        size_t end = i;
        if (end > start && text[end - 1] == '\r') end--;

        Line *l = &lines[out++];
        l->raw = text + start;
        l->raw_len = end - start;

        size_t k = 0;
        while (k < l->raw_len && l->raw[k] == ' ') k++;
        l->tab = k < l->raw_len && l->raw[k] == '\t';
        l->indent = k;
        l->s = l->raw + k;
        l->len = l->raw_len - k;

        l->blank = 1;
        for (size_t j = 0; j < l->len; j++)
            if (!is_space(l->s[j])) { l->blank = 0; break; }

        start = i + 1;
    }
    *count = out;
    return lines;
}

mdy_yaml *mdy_yaml_parse(const char *text, size_t len, char *error, size_t error_len) {
    if (error && error_len) error[0] = '\0';
    if (!text) return NULL;
    if (len == 0) len = strlen(text);

    mdy_yaml *doc = calloc(1, sizeof *doc);
    /* Before there is a P to fail: the caller still has to be able to tell
     * this apart from a malformed document. */
    if (!doc) {
        if (error && error_len) snprintf(error, error_len, "%s", MDY_YAML_OOM);
        return NULL;
    }

    P p = {0};
    p.arena = &doc->arena;
    p.error = error;
    p.error_len = error_len;
    p.trailing_newline = len > 0 && text[len - 1] == '\n';
    p.lines = split_lines(text, len, &p.count);
    if (!p.lines) { oom(&p); free(doc); return NULL; }

    /*
     * Directives and document markers: one document per stream here.
     *
     * A `...` that CLOSES the one document is ordinary single-document YAML:
     * `a: 1\n...\n` is `{a: 1}`, in a data file and in `+++` front matter
     * alike. It closes the document when nothing of substance follows it, which
     * is what `next_content` answers: blanks and comments after the marker are
     * fine, anything else is the second document this does not support. The
     * line below already made the symmetric allowance for a leading `---`.
     */
    size_t ends_at = p.count;
    for (size_t i = 0; i < p.count && !p.failed; i++) {
        const Line *l = &p.lines[i];
        if (l->indent == 0 && l->len && l->s[0] == '%')
            fail(&p, i, "directives are not supported");
        if (marker_line(l, "---") && i > 0)
            fail(&p, i, "more than one document in a stream is not supported");
        if (marker_line(l, "...")) {
            if (next_content(&p, i + 1) < p.count)
                fail(&p, i, "more than one document in a stream is not supported");
            else { ends_at = i; break; }
        }
    }
    /* The marker and the blank lines after it are not the document's. */
    if (!p.failed) p.count = ends_at;

    /* A leading `---` opening the one document is fine; content on the same
     * line as the marker is a form this does not read, and says so rather
     * than reading the marker as the content's first word. */
    if (!p.failed && p.count && marker_line(&p.lines[0], "---")) {
        if (!nothing_after(&p.lines[0], 3))
            fail(&p, 0, "content on the document marker's line is not supported");
        p.at = 1;
    }

    if (!p.failed) doc->root = parse_block(&p, 0);

    if (!p.failed && doc->root) {
        /* Anything left over means the structure did not describe the file. */
        size_t at = next_content(&p, p.at);
        if (at < p.count) fail(&p, at, "unexpected content after the document");
    }

    free(p.lines);
    if (p.failed || !doc->root) { arena_free(&doc->arena); free(doc); return NULL; }
    return doc;
}

const mdy_yaml_node *mdy_yaml_root(const mdy_yaml *doc) { return doc ? doc->root : NULL; }

void mdy_yaml_free(mdy_yaml *doc) {
    if (!doc) return;
    arena_free(&doc->arena);
    free(doc);
}

mdy_yaml_type mdy_yaml_type_of(const mdy_yaml_node *n) { return n ? n->type : MDY_YAML_NULL; }

const char *mdy_yaml_string(const mdy_yaml_node *n, size_t *len) {
    if (!n || n->type != MDY_YAML_STRING) return NULL;
    if (len) *len = n->as.string.len;
    return n->as.string.s;
}

double mdy_yaml_number(const mdy_yaml_node *n) {
    return n && n->type == MDY_YAML_NUMBER ? n->as.number : 0;
}

int mdy_yaml_bool(const mdy_yaml_node *n) {
    return n && n->type == MDY_YAML_BOOL ? n->as.boolean : 0;
}

size_t mdy_yaml_count(const mdy_yaml_node *n) {
    if (!n) return 0;
    if (n->type == MDY_YAML_SEQUENCE) return n->as.seq.count;
    if (n->type == MDY_YAML_MAPPING) return n->as.map.count;
    return 0;
}

const mdy_yaml_node *mdy_yaml_at(const mdy_yaml_node *n, size_t i) {
    if (!n || n->type != MDY_YAML_SEQUENCE || i >= n->as.seq.count) return NULL;
    return n->as.seq.items[i];
}

const char *mdy_yaml_key(const mdy_yaml_node *n, size_t i, size_t *len) {
    if (!n || n->type != MDY_YAML_MAPPING || i >= n->as.map.count) return NULL;
    if (len) *len = n->as.map.pairs[i].key_len;
    return n->as.map.pairs[i].key;
}

const mdy_yaml_node *mdy_yaml_value(const mdy_yaml_node *n, size_t i) {
    if (!n || n->type != MDY_YAML_MAPPING || i >= n->as.map.count) return NULL;
    return n->as.map.pairs[i].value;
}

const mdy_yaml_node *mdy_yaml_get(const mdy_yaml_node *n, const char *k) {
    if (!n || n->type != MDY_YAML_MAPPING || !k) return NULL;
    size_t len = strlen(k);
    for (size_t i = 0; i < n->as.map.count; i++)
        if (n->as.map.pairs[i].key_len == len && memcmp(n->as.map.pairs[i].key, k, len) == 0)
            return n->as.map.pairs[i].value;
    return NULL;
}

/* ---- JSON, for the comparison harness ----------------------------------------- */

static void json_string(mdy_buf *b, const char *s, size_t len) {
    mdy_buf_putc(b, '"');
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  mdy_buf_put(b, "\\\"", 2); break;
            case '\\': mdy_buf_put(b, "\\\\", 2); break;
            case '\b': mdy_buf_put(b, "\\b", 2); break;
            case '\f': mdy_buf_put(b, "\\f", 2); break;
            case '\n': mdy_buf_put(b, "\\n", 2); break;
            case '\r': mdy_buf_put(b, "\\r", 2); break;
            case '\t': mdy_buf_put(b, "\\t", 2); break;
            default:
                if (c < 0x20) { char tmp[8]; snprintf(tmp, sizeof tmp, "\\u%04x", c); mdy_buf_put(b, tmp, 6); }
                else mdy_buf_putc(b, (char)c);
        }
    }
    mdy_buf_putc(b, '"');
}

/*
 * `JSON.stringify` writes an integral double without a fraction, has no way to
 * write an infinity or a NaN — both become `null` — and otherwise writes the
 * SHORTEST decimal that reads back as the same double.
 *
 * That last one is not a detail: `%.17g` turns 26.185 into 26.184999999999999,
 * which is the same number and a different file. The shortest form is found by
 * asking for fewer digits and checking the answer still round-trips, which is
 * what a full Grisu implementation computes directly and what this arrives at
 * in at most three tries.
 */
static void json_number(mdy_buf *b, double v) {
    if (isnan(v) || isinf(v)) { mdy_buf_put(b, "null", 4); return; }
    char tmp[40];
    /* Range test BEFORE the cast: `(long long)v` is undefined for a v outside
     * long long's range, so the `< 9.2e18` guards must short-circuit ahead of
     * it (ast.c and html.c order it this way too). */
    if (v > -9.2e18 && v < 9.2e18 && v == (double)(long long)v) {
        snprintf(tmp, sizeof tmp, "%lld", (long long)v);
    } else {
        for (int digits = 15; digits <= 17; digits++) {
            snprintf(tmp, sizeof tmp, "%.*g", digits, v);
            if (strtod(tmp, NULL) == v) break;
        }
    }
    mdy_buf_put(b, tmp, strlen(tmp));
}

static void json_node(mdy_buf *b, const mdy_yaml_node *n) {
    if (!n) { mdy_buf_put(b, "null", 4); return; }
    switch (n->type) {
        case MDY_YAML_NULL: mdy_buf_put(b, "null", 4); return;
        case MDY_YAML_BOOL: mdy_buf_put(b, n->as.boolean ? "true" : "false", n->as.boolean ? 4 : 5); return;
        case MDY_YAML_NUMBER: json_number(b, n->as.number); return;
        case MDY_YAML_STRING: json_string(b, n->as.string.s, n->as.string.len); return;
        case MDY_YAML_SEQUENCE:
            mdy_buf_putc(b, '[');
            for (size_t i = 0; i < n->as.seq.count; i++) {
                if (i) mdy_buf_putc(b, ',');
                json_node(b, n->as.seq.items[i]);
            }
            mdy_buf_putc(b, ']');
            return;
        case MDY_YAML_MAPPING:
            mdy_buf_putc(b, '{');
            for (size_t i = 0; i < n->as.map.count; i++) {
                if (i) mdy_buf_putc(b, ',');
                json_string(b, n->as.map.pairs[i].key, n->as.map.pairs[i].key_len);
                mdy_buf_putc(b, ':');
                json_node(b, n->as.map.pairs[i].value);
            }
            mdy_buf_putc(b, '}');
            return;
    }
}

char *mdy_yaml_to_json(const mdy_yaml_node *n) {
    mdy_buf b = { .ok = 1, .seed = 128 };
    mdy_buf_put(&b, "", 0);
    json_node(&b, n);
    if (!b.ok) { free(b.s); return NULL; }
    return b.s;
}

/* ---- building one from C ----------------------------------------------------
 *
 * See mdyyaml.h for why this exists. The arena cannot grow an allocation in
 * place, so the pairs accumulate in a malloc'd array and are copied into the
 * arena once, when the mapping is made — which is also the only point at
 * which the count is known.
 */
struct mdy_yaml_builder {
    mdy_yaml *doc;
    Pair *pairs;
    size_t count, cap;
    int failed;        /* sticky: one refused allocation loses the document */
};

mdy_yaml_builder *mdy_yaml_builder_new(void) {
    mdy_yaml_builder *b = calloc(1, sizeof *b);
    if (!b) return NULL;
    b->doc = calloc(1, sizeof *b->doc);
    if (!b->doc) { free(b); return NULL; }
    return b;
}

void mdy_yaml_builder_free(mdy_yaml_builder *b) {
    if (!b) return;
    mdy_yaml_free(b->doc);
    free(b->pairs);
    free(b);
}

/* A NUL-terminated copy of `n` bytes, in the document's arena. */
static const char *build_bytes(mdy_yaml_builder *b, const char *s, size_t n) {
    char *copy = arena_alloc(&b->doc->arena, n + 1);
    if (!copy) { b->failed = 1; return NULL; }
    if (n) memcpy(copy, s, n);
    copy[n] = '\0';
    return copy;
}

static mdy_yaml_node *build_node(mdy_yaml_builder *b, mdy_yaml_type type) {
    mdy_yaml_node *n = arena_alloc(&b->doc->arena, sizeof *n);
    if (!n) { b->failed = 1; return NULL; }
    memset(n, 0, sizeof *n);
    n->type = type;
    return n;
}

/* One key/value onto the open mapping. `value` NULL means a put that already
 * failed, and is passed through rather than checked at five call sites. */
static int build_put(mdy_yaml_builder *b, const char *key, mdy_yaml_node *value) {
    if (!b || b->failed || !value || !key) { if (b) b->failed = 1; return 0; }
    if (b->count == b->cap) {
        size_t want = b->cap ? b->cap * 2 : 8;
        Pair *grown = realloc(b->pairs, want * sizeof *grown);
        if (!grown) { b->failed = 1; return 0; }
        b->pairs = grown;
        b->cap = want;
    }
    size_t klen = strlen(key);
    const char *kc = build_bytes(b, key, klen);
    if (!kc) return 0;
    b->pairs[b->count].key = kc;
    b->pairs[b->count].key_len = klen;
    b->pairs[b->count].value = value;
    b->count++;
    return 1;
}

int mdy_yaml_put_string(mdy_yaml_builder *b, const char *key, const char *value, size_t len) {
    if (!b || b->failed) { if (b) b->failed = 1; return 0; }
    if (!value) return mdy_yaml_put_null(b, key);
    if (len == 0) len = strlen(value);
    mdy_yaml_node *n = build_node(b, MDY_YAML_STRING);
    if (!n) return 0;
    const char *copy = build_bytes(b, value, len);
    if (!copy) return 0;
    n->as.string.s = copy;
    n->as.string.len = len;
    return build_put(b, key, n);
}

int mdy_yaml_put_number(mdy_yaml_builder *b, const char *key, double value) {
    if (!b || b->failed) { if (b) b->failed = 1; return 0; }
    mdy_yaml_node *n = build_node(b, MDY_YAML_NUMBER);
    if (!n) return 0;
    n->as.number = value;
    return build_put(b, key, n);
}

int mdy_yaml_put_bool(mdy_yaml_builder *b, const char *key, int value) {
    if (!b || b->failed) { if (b) b->failed = 1; return 0; }
    mdy_yaml_node *n = build_node(b, MDY_YAML_BOOL);
    if (!n) return 0;
    n->as.boolean = value ? 1 : 0;
    return build_put(b, key, n);
}

int mdy_yaml_put_null(mdy_yaml_builder *b, const char *key) {
    if (!b || b->failed) { if (b) b->failed = 1; return 0; }
    mdy_yaml_node *n = build_node(b, MDY_YAML_NULL);
    if (!n) return 0;
    return build_put(b, key, n);
}

int mdy_yaml_put_strings(mdy_yaml_builder *b, const char *key,
                         const char *const *values, size_t count) {
    if (!b || b->failed) { if (b) b->failed = 1; return 0; }
    mdy_yaml_node *seq = build_node(b, MDY_YAML_SEQUENCE);
    if (!seq) return 0;
    mdy_yaml_node **items = arena_alloc(&b->doc->arena,
                                        (count ? count : 1) * sizeof *items);
    if (!items) { b->failed = 1; return 0; }
    for (size_t i = 0; i < count; i++) {
        mdy_yaml_node *s = build_node(b, MDY_YAML_STRING);
        if (!s) return 0;
        size_t len = values[i] ? strlen(values[i]) : 0;
        const char *copy = build_bytes(b, values[i] ? values[i] : "", len);
        if (!copy) return 0;
        s->as.string.s = copy;
        s->as.string.len = len;
        items[i] = s;
    }
    seq->as.seq.items = items;
    seq->as.seq.count = count;
    return build_put(b, key, seq);
}

mdy_yaml *mdy_yaml_builder_done(mdy_yaml_builder *b) {
    if (!b) return NULL;
    if (b->failed) { mdy_yaml_builder_free(b); return NULL; }
    mdy_yaml_node *root = build_node(b, MDY_YAML_MAPPING);
    if (!root) { mdy_yaml_builder_free(b); return NULL; }
    Pair *pairs = arena_alloc(&b->doc->arena, (b->count ? b->count : 1) * sizeof *pairs);
    if (!pairs) { mdy_yaml_builder_free(b); return NULL; }
    if (b->count) memcpy(pairs, b->pairs, b->count * sizeof *pairs);
    root->as.map.pairs = pairs;
    root->as.map.count = b->count;
    b->doc->root = root;
    mdy_yaml *doc = b->doc;
    b->doc = NULL;              /* handed over, not freed with the builder */
    mdy_yaml_builder_free(b);
    return doc;
}

/* ---- copying one ------------------------------------------------------------ */

static mdy_yaml_node *clone_node(Arena *a, const mdy_yaml_node *src, int depth) {
    if (!src || depth > MDY_YAML_MAX_DEPTH) return NULL;
    mdy_yaml_node *n = arena_alloc(a, sizeof *n);
    if (!n) return NULL;
    memset(n, 0, sizeof *n);
    n->type = src->type;
    switch (src->type) {
        case MDY_YAML_STRING: {
            char *copy = arena_alloc(a, src->as.string.len + 1);
            if (!copy) return NULL;
            if (src->as.string.len) memcpy(copy, src->as.string.s, src->as.string.len);
            copy[src->as.string.len] = '\0';
            n->as.string.s = copy;
            n->as.string.len = src->as.string.len;
            break;
        }
        case MDY_YAML_NUMBER: n->as.number = src->as.number; break;
        case MDY_YAML_BOOL:   n->as.boolean = src->as.boolean; break;
        case MDY_YAML_SEQUENCE: {
            size_t count = src->as.seq.count;
            mdy_yaml_node **items = arena_alloc(a, (count ? count : 1) * sizeof *items);
            if (!items) return NULL;
            for (size_t i = 0; i < count; i++) {
                items[i] = clone_node(a, src->as.seq.items[i], depth + 1);
                if (!items[i]) return NULL;
            }
            n->as.seq.items = items;
            n->as.seq.count = count;
            break;
        }
        case MDY_YAML_MAPPING: {
            size_t count = src->as.map.count;
            Pair *pairs = arena_alloc(a, (count ? count : 1) * sizeof *pairs);
            if (!pairs) return NULL;
            for (size_t i = 0; i < count; i++) {
                size_t klen = src->as.map.pairs[i].key_len;
                char *kc = arena_alloc(a, klen + 1);
                if (!kc) return NULL;
                if (klen) memcpy(kc, src->as.map.pairs[i].key, klen);
                kc[klen] = '\0';
                pairs[i].key = kc;
                pairs[i].key_len = klen;
                pairs[i].value = clone_node(a, src->as.map.pairs[i].value, depth + 1);
                if (!pairs[i].value) return NULL;
            }
            n->as.map.pairs = pairs;
            n->as.map.count = count;
            break;
        }
        case MDY_YAML_NULL: break;
    }
    return n;
}

mdy_yaml *mdy_yaml_clone(const mdy_yaml *src) {
    if (!src) return NULL;
    mdy_yaml *doc = calloc(1, sizeof *doc);
    if (!doc) return NULL;
    if (src->root) {
        doc->root = clone_node(&doc->arena, src->root, 0);
        if (!doc->root) { mdy_yaml_free(doc); return NULL; }
    }
    return doc;
}
