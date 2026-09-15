/*
 * Inline parsing.
 *
 * MDY's inline model is TOGGLING, not nesting, and that is the single most
 * important thing about this file. A marker sequence opens a span; the next
 * occurrence of the same sequence closes it. There is no left-flanking /
 * right-flanking analysis, no delimiter stack, none of CommonMark's emphasis
 * machinery — which is why a C implementation of this is a few hundred lines
 * rather than a few thousand.
 *
 * The markers are all two characters, all doubled, and there are nine of them.
 * A single `*` is literal text: `a *b* c` is three words, `a **b** c` has a
 * <strong>. That is a deliberate divergence from markdown and it is what makes
 * scanning cheap — two bytes decide, with no lookbehind.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"

typedef struct {
    const char *seq;    /* two characters, always */
    const char *tag;
    int raw;            /* nothing inside is markup until the closer */
} Marker;

/*
 * defaultMarkers from ../../mdy-docs/src/parse/markers.js, in that order.
 * Longest-first does not arise: every sequence is exactly two characters and
 * none prefixes another.
 */
static const Marker MARKERS[] = {
    { "!!", "strong", 0 },
    { "**", "strong", 0 },
    { "//", "em",     0 },
    { "__", "u",      0 },
    { "~~", "del",    0 },
    { "??", "mark",   0 },
    { "^^", "sup",    0 },
    { ",,", "sub",    0 },
    { "``", "code",   1 },
};
static const size_t MARKER_COUNT = sizeof MARKERS / sizeof MARKERS[0];

static const Marker *marker_at(const char *p, size_t left) {
    if (left < 2) return NULL;
    for (size_t i = 0; i < MARKER_COUNT; i++) {
        if (p[0] == MARKERS[i].seq[0] && p[1] == MARKERS[i].seq[1]) return &MARKERS[i];
    }
    return NULL;
}

/*
 * `linkKind(href) === 'page'`.
 *
 * Three answers and only the third is ours: `#` opens a fragment on this
 * page, `//host` or a `^[a-z][a-z0-9+.-]*:` scheme is somebody else's, and
 * everything left — a path, a name, a relative step upward — is a page.
 */
int mdy_link_kind_page(const char *s, size_t len) {
    if (len == 0) return 0;
    if (s[0] == '#') return 0;
    if (len >= 2 && s[0] == '/' && s[1] == '/') return 0;
    if ((s[0] >= 'a' && s[0] <= 'z') || (s[0] >= 'A' && s[0] <= 'Z')) {
        size_t i = 1;
        while (i < len) {
            char c = s[i];
            int ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                     (c >= '0' && c <= '9') || c == '+' || c == '.' || c == '-';
            if (!ok) break;
            i++;
        }
        if (i < len && s[i] == ':') return 0;
    }
    return 1;
}

/*
 * `href.toLowerCase().replace(/\s+/g, '-')`.
 *
 * A page is a file somewhere in the end, and `Getting Started` and
 * `getting-started` should not be two of them. The lowercasing is Unicode's,
 * not ASCII's — the same rule the rest of this file uses.
 */
size_t mdy_normalize_link(const char *s, size_t len, char *out, size_t cap) {
    size_t o = 0;
    size_t i = 0;
    while (i < len && o + 8 < cap) {
        uint32_t cp;
        size_t w = mdy_utf8_decode(s + i, len - i, &cp);
        if (mdy_is_js_space(cp)) {
            /* A RUN of whitespace becomes one dash. */
            while (i < len) {
                uint32_t next;
                size_t nw = mdy_utf8_decode(s + i, len - i, &next);
                if (!mdy_is_js_space(next)) break;
                i += nw;
            }
            out[o++] = '-';
            continue;
        }
        o += mdy_utf8_encode(mdy_lower_cp(cp), out + o);
        i += w;
    }
    out[o] = '\0';
    return o;
}

/*
 * `encodeURIComponent`, which is what a tag's href is built with.
 *
 * Unreserved by that function: A-Z a-z 0-9 and `-_.!~*'()`. Everything else
 * is percent-encoded byte by byte, and since the input is already UTF-8 that
 * is exactly the encoding it wants.
 */
static size_t encode_uri_component(const char *s, size_t len, char *out, size_t cap) {
    static const char *HEX = "0123456789ABCDEF";
    size_t o = 0;
    for (size_t i = 0; i < len && o + 4 < cap; i++) {
        unsigned char c = (unsigned char)s[i];
        int plain = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                    (c >= '0' && c <= '9') || strchr("-_.!~*'()", c) != NULL;
        if (plain) { out[o++] = (char)c; continue; }
        out[o++] = '%';
        out[o++] = HEX[c >> 4];
        out[o++] = HEX[c & 15];
    }
    out[o] = '\0';
    return o;
}

/* Every character the default arrow table draws with. An arrow standing
 * against one of them is part of a longer run. */
static int is_arrow_letter(char c) {
    return c == '-' || c == '<' || c == '=' || c == '>';
}

/* ---- autolink ------------------------------------------------------------ */

/*
 * URL detection is linkify-it's, ported in src/linkify.c, and none of it is
 * here. The reasonable-looking guess — a scheme or `//host`, then bytes until
 * whitespace, then trailing punctuation trimmed — is wrong in ways nobody
 * would predict: a comma kept in one place and dropped in another, a hyphen
 * in a host's last label, a full stop ending a sentence against one inside a
 * path.
 */

/* ---- the scanner --------------------------------------------------------- */

/*
 * URL spans, found once before scanning starts.
 *
 * This is the mechanism the JavaScript uses (`findLinks`, then a check at
 * every marker) and it is not an optimisation — it is what stops the `//` in
 * `http://example.com` from opening an emphasis span. Without it a document
 * full of URLs grows emphasis it never asked for, which is exactly what
 * happened here: 200 spurious <em> across the reference corpus.
 */
#define MDY_MAX_URLS 512

typedef struct {
    size_t start, end;
    int mailto;         /* a bare email, which the href writes `mailto:` in front of */
} Span;

typedef struct {
    mdy_doc *doc;
    mdy_node *parent;    /* where finished nodes are appended */
    char *buf;           /* pending literal text */
    size_t len, cap;
    const Span *urls;    /* sorted, non-overlapping */
    size_t url_count;
    const char *text;    /* what the spans are offsets into */
    /*
     * How far a wiki link's `]]` search has already come up empty. A `[[` that
     * finds no closer fails, and so does every later `[[` before the same
     * point; remembering the boundary turns a line of N unclosed `[[` from
     * O(N^2) rescans into O(N). The search stops at a newline, which costs
     * nothing: no caller hands this text with one in it (lines are joined
     * with a space first). Monotonic: it only ever moves forward.
     */
    const char *wiki_skip;
    /*
     * Whether the next position starts a word. Tracked as STATE, not computed
     * from the previous byte, because what sets it is what the scanner just
     * did rather than what the text says: a marker or a wiki link leaves a
     * boundary behind, an em dash does not, and an ordinary character leaves
     * one only when it is whitespace. Emoticons are the only rule that reads
     * it, and getting it wrong makes faces out of the middle of URLs.
     */
    int at_boundary;
} Ctx;

/** Is `i` inside a URL that autolink will consume? */
static int inside_url(const Ctx *ctx, size_t i) {
    /*
     * The spans are sorted by start and do not overlap, so at most one can
     * contain i: the last one that begins at or before it. A binary search
     * finds that candidate — the scan this replaces was O(spans) per call and
     * called once per byte (and again per byte inside the marker-closer scan),
     * so a paragraph that was mostly URLs was quadratic.
     */
    size_t lo = 0, hi = ctx->url_count;
    while (lo < hi) {                       /* upper bound: first span past i */
        size_t mid = lo + (hi - lo) / 2;
        if (ctx->urls[mid].start <= i) lo = mid + 1;
        else hi = mid;
    }
    if (lo == 0) return 0;                  /* no span begins at or before i */
    return i < ctx->urls[lo - 1].end;       /* start <= i already; inside iff before end */
}

static void flush(Ctx *ctx) {
    if (ctx->len == 0) return;
    mdy_append(ctx->parent, mdy_new_text(ctx->doc, ctx->buf, ctx->len));
    ctx->len = 0;
}

static size_t wiki_link(Ctx *ctx, const char *p, size_t left);

/*
 * Replace every <a> in the subtree with its own children — RECURSIVELY, which
 * is what the JavaScript does: a link nested two deep inside a wiki link's
 * label is still a link inside a link, and still not a thing.
 */
static void unwrap_links(mdy_node *parent) {
    for (mdy_node *child = parent->first; child; child = child->next)
        if (child->type == MDY_ELEMENT) unwrap_links(child);

    mdy_node *first = NULL, *last = NULL;
    for (mdy_node *child = parent->first; child;) {
        mdy_node *next = child->next;
        if (child->type == MDY_ELEMENT && strcmp(child->tag, "a") == 0) {
            for (mdy_node *inner = child->first; inner;) {
                mdy_node *after = inner->next;
                inner->next = NULL;
                if (last) last->next = inner; else first = inner;
                last = inner;
                inner = after;
            }
        } else {
            child->next = NULL;
            if (last) last->next = child; else first = child;
            last = child;
        }
        child = next;
    }
    parent->first = first;
    parent->last = last;
}

/*
 * Append literal text to the pending run.
 *
 * The buffer is sized for GROWTH, not for the input's length, because several
 * rules here replace a short sequence with a longer one: `:)` is two bytes and
 * 😃 is four, `--` is two and an em dash is three. Sizing it to the input made
 * this drop whatever ran past the end — silently, which is how `ok :) yes`
 * came out as `ok 😃 ye`. Four times the input bounds every substitution in
 * this file with room to spare.
 */
static void push(Ctx *ctx, const char *s, size_t n) {
    if (ctx->len + n > ctx->cap) return;
    memcpy(ctx->buf + ctx->len, s, n);
    ctx->len += n;
}

/*
 * A typographic replacement at text[i] — an arrow (`-->`, `<==>`, …), a
 * three-dot ellipsis, or a two-dash em dash — as its UTF-8 bytes, or NULL, with
 * `*used` the source bytes it stands for. Each looks BEHIND as well as ahead so
 * a run longer than the pattern (`----`, `....`) is left as it was written.
 * Lifted out of scan's loop; leaves at_boundary the caller's to set.
 */
static const char *typographic(const char *text, size_t len, size_t i, size_t *used) {
    const char *p = text + i;
    size_t left = len - i;
    const char *drawn = NULL;
    *used = 0;
    /*
     * An arrow may not stand against another character the table DRAWS with —
     * `-`, `<`, `=`, `>` — on either side, so nothing inside `<--->` is an
     * arrow and `---->` stays four dashes and an angle. The longest sequence is
     * tried first, and when the one that fits is hemmed in, none of the shorter
     * ones is tried either: they are pieces of the same run.
     */
    if (is_arrow_letter(p[0]) && !(i > 0 && is_arrow_letter(text[i - 1]))) {
        static const struct { const char *seq; size_t len; const char *draw; } ARROWS[] = {
            { "<-->", 4, "\xe2\x86\x94" },
            { "<==>", 4, "\xe2\x87\x94" },
            { "-->",  3, "\xe2\x86\x92" },
            { "<--",  3, "\xe2\x86\x90" },
            { "==>",  3, "\xe2\x87\x92" },
            { "<==",  3, "\xe2\x87\x90" },
        };
        for (size_t a = 0; a < sizeof ARROWS / sizeof ARROWS[0]; a++) {
            if (left < ARROWS[a].len || memcmp(p, ARROWS[a].seq, ARROWS[a].len) != 0) continue;
            if (left > ARROWS[a].len && is_arrow_letter(p[ARROWS[a].len])) break;
            drawn = ARROWS[a].draw;
            *used = ARROWS[a].len;
            break;
        }
    }
    /* EXACTLY three dots. A longer run stays as it is — `108....9` is a
     * citation, not an ellipsis and a full stop. */
    if (!drawn && left >= 3 && p[0] == '.' && p[1] == '.' && p[2] == '.' &&
             !(left >= 4 && p[3] == '.') && !(i > 0 && text[i - 1] == '.')) {
        drawn = "\xe2\x80\xa6";
        *used = 3;
    }
    else if (!drawn && left >= 2 && p[0] == '-' && p[1] == '-' &&
             !(left >= 3 && p[2] == '-') && !(i > 0 && text[i - 1] == '-')) {
        drawn = "\xe2\x80\x94";
        *used = 2;
    }
    return drawn;
}

/*
 * `#tag` and `@user` at `i`, matching `[\p{L}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?`:
 * the bytes the reference takes, marker included, or 1 when there is none.
 *
 * Three parts, and each one earns its place. It must START with a letter
 * or an underscore, so `#1` in "Lost cities #1: Babylon" is not a tag —
 * numeric tags cost more than they are worth, and that heading is real. It
 * may not END with a hyphen. And something wordlike before it means this
 * is the middle of something else, so `a#b` is not one either.
 *
 * The label keeps its case: `#Tag-One` links to `/tags/Tag-One`, which is
 * easy to get wrong when almost everything else here lowercases.
 */
static size_t reference_length(const char *text, size_t len, size_t i) {
    const char *p = text + i;
    size_t left = len - i;
    if (left < 2) return 1;
    uint32_t before = 0;
    if (i > 0) {
        /* The character before, which needs its whole width — one byte back
         * into a multi-byte character is not a character. */
        size_t back = i;
        while (back > 0 && ((unsigned char)text[back - 1] & 0xC0) == 0x80) back--;
        if (back > 0) back--;
        mdy_utf8_decode(text + back, len - back, &before);
    }
    if (before && (before == '_' || mdy_is_letter_or_number_cp(before))) return 1;

    uint32_t first = 0;
    size_t fw = mdy_utf8_decode(p + 1, left - 1, &first);
    if (!(first == '_' || mdy_is_letter_cp(first))) return 1;
    size_t n = 1 + fw;
    while (n < left) {
        uint32_t cp;
        size_t w = mdy_utf8_decode(p + n, left - n, &cp);
        if (cp == '-' || cp == '_' || mdy_is_letter_or_number_cp(cp)) n += w;
        else break;
    }
    /* It may not end with a hyphen. */
    while (n > 1 && p[n - 1] == '-') n--;
    return n;
}

static size_t wiki_link_length(Ctx *ctx, const char *p, size_t left);
static void parse_inline_spans(mdy_doc *doc, mdy_node *parent, const char *text, size_t len,
                               const Span *urls, size_t url_count);

/*
 * Scan `text` into `parent`. A marker always opens, and one that never
 * closes runs to the end of the input, as inline.js has it; the closer is
 * found first so the span's inside can be scanned as a slice, one level of
 * recursion per open marker.
 */
static void scan(Ctx *ctx, const char *text, size_t len) {
    size_t i = 0;
    while (i < len) {
        const char *p = text + i;
        size_t left = len - i;

        /* An escape makes the next character literal, and consumes the
         * backslash — `a \*b\* c` is `a *b* c`. */
        if (*p == '\\' && left > 1) {
            push(ctx, p + 1, 1);
            ctx->at_boundary = 0;
            i += 2;
            continue;
        }

        /* `[[ … ]]` outranks a marker, matching the JavaScript's order — so a
         * `//` inside a wiki link's target cannot pair with one outside it. */
        if (left >= 4 && p[0] == '[' && p[1] == '[') {
            size_t n = wiki_link(ctx, p, left);
            if (n) { i += n; continue; }   /* wiki_link sets at_boundary itself */
        }

        const Marker *m = inside_url(ctx, i) ? NULL : marker_at(p, left);
        if (m) {
            /*
             * A marker ALWAYS opens, and an unclosed one runs to the end of
             * the input — `a //b` is `a <em>b</em>`, not the literal text.
             * Worth stating because the opposite is the intuitive guess.
             */
            size_t close = len;
            int found = 0;
            for (size_t j = i + 2; j + 1 < len; j++) {
                /*
                 * Neither escapes nor URL spans apply INSIDE a raw span —
                 * `if (character === '\\\\' && !raw …)` and
                 * `if (!raw && links[link]…)`. A backslash before the closing
                 * run does not hide it, which is what makes
                 * ``` ``!!not bold// \\`` ``` a code span holding a
                 * backslash rather than one that never closes.
                 */
                if (!m->raw) {
                    if (text[j] == '\\') { j++; continue; }
                    if (inside_url(ctx, j)) continue;
                    /* What the scanner takes whole, the closer search steps
                     * over whole: the `__` in `#foo__bar` closes nothing. */
                    size_t whole = 0;
                    if (text[j] == '[' && j + 1 < len && text[j + 1] == '[')
                        whole = wiki_link_length(ctx, text + j, len - j);
                    else if (text[j] == '#' || text[j] == '@')
                        whole = reference_length(text, len, j);
                    if (whole > 1) { j += whole - 1; continue; }
                }
                if (text[j] == m->seq[0] && text[j + 1] == m->seq[1]) { close = j; found = 1; break; }
            }
            {
                flush(ctx);
                mdy_node *el = mdy_new_element(ctx->doc, m->tag, strlen(m->tag));
                mdy_append(ctx->parent, el);

                const char *inner = text + i + 2;
                size_t inner_len = close - (i + 2);
                if (m->raw) {
                    /* Nothing inside is markup — that is what raw means. */
                    if (inner_len) mdy_append(el, mdy_new_text(ctx->doc, inner, inner_len));
                } else {
                    /*
                     * The URLs are the paragraph's, found once: the nested
                     * scan takes the spans inside its slice, rebased. Finding
                     * them again on the slice would find more — a scheme the
                     * marker itself stood before, which linkify refused.
                     */
                    size_t off = (size_t)(inner - ctx->text);
                    Span *sub = NULL;
                    size_t sub_count = 0;
                    for (size_t k = 0; k < ctx->url_count; k++) {
                        const Span *u = &ctx->urls[k];
                        if (u->start < off || u->end > off + inner_len) continue;
                        if (!sub) sub = mdy_alloc(&ctx->doc->arena, (ctx->url_count - k) * sizeof *sub);
                        sub[sub_count] = *u;
                        sub[sub_count].start -= off;
                        sub[sub_count].end -= off;
                        sub_count++;
                    }
                    parse_inline_spans(ctx->doc, el, inner, inner_len, sub, sub_count);
                }
                ctx->at_boundary = 1;
                i = found ? close + 2 : len;
                continue;
            }
        }

        /*
         * Emoji, then the typographic replacements, in that order — the
         * JavaScript checks emoji first and it matters: `:-->` would otherwise
         * lose its head to the arrow rule.
         *
         * Neither reaches inside a raw span, which is handled by the marker
         * branch copying that text verbatim rather than scanning it.
         */
        {
            size_t used = 0;
            const char *found = mdy_match_emoji(p, left, ctx->at_boundary, &used);
            if (found) {
                push(ctx, found, strlen(found));
                ctx->at_boundary = 1;
                i += used;
                continue;
            }
        }

        /*
         * `--` is an em dash and `---` is not: three hyphens stay literal,
         * because a run of them is a thematic break's business. That means
         * looking BEHIND as well as ahead, or the second and third hyphens of
         * a run pair up into one.
         *
         * Each of these leaves at_boundary false — what follows punctuation is
         * no more the start of a word than what follows a full stop.
         */
        {
            size_t used = 0;
            const char *drawn = typographic(text, len, i, &used);
            if (drawn) {
                push(ctx, drawn, 3);
                ctx->at_boundary = 0;
                i += used;
                continue;
            }
        }

        if ((p[0] == '#' || p[0] == '@') && left > 1) {
            size_t n = reference_length(text, len, i);
            if (n > 1) {
                flush(ctx);
                mdy_node *a = mdy_new_element(ctx->doc, "a", 1);
                /* `setting.href + encodeURIComponent(name)` — the NAME is
                 * percent-encoded, so `#café` points at `/tags/caf%C3%A9`
                 * while still reading `#café`. */
                const char *prefix = p[0] == '#' ? "/tags/" : "/users/";
                size_t hl = strlen(prefix);
                size_t cap = hl + (n - 1) * 3 + 5;   /* every byte may become %XX, and the encoder keeps four spare */
                char *href = mdy_alloc(&ctx->doc->arena, cap);
                memcpy(href, prefix, hl);
                hl += encode_uri_component(p + 1, n - 1, href + hl, cap - hl);
                mdy_set_string(ctx->doc, a, "href", href, hl);
                /* Written down as well as written out: a document is asked
                 * often enough what it refers to that it should not have to
                 * be read again to answer. */
                mdy_collect(ctx->doc, p[0] == '#' ? MDY_REF_TAG : MDY_REF_MENTION,
                            p + 1, n - 1);
                mdy_append(a, mdy_new_text(ctx->doc, p, n));
                mdy_append(ctx->parent, a);
                ctx->at_boundary = 0;
                i += n;
                continue;
            }
        }

        /* A link starts here if the pre-scan said so — one decision, made
         * once by the port, rather than the same question asked twice. */
        {
            size_t n = 0;
            int mailto = 0;
            /* The one span that could start exactly here — binary search over
             * the sorted starts, for the same reason inside_url does. */
            size_t lo = 0, hi = ctx->url_count;
            while (lo < hi) {               /* lower bound: first start >= i */
                size_t mid = lo + (hi - lo) / 2;
                if (ctx->urls[mid].start < i) lo = mid + 1;
                else hi = mid;
            }
            if (lo < ctx->url_count && ctx->urls[lo].start == i) {
                n = ctx->urls[lo].end - i;
                mailto = ctx->urls[lo].mailto;
            }
            if (n > 0) {
                flush(ctx);
                mdy_node *a = mdy_new_element(ctx->doc, "a", 1);
                /* The link SAYS what was written and POINTS at the normalised
                 * url; the two differ only for a bare email address, where
                 * linkify-it's normalize() supplies the `mailto:`. */
                if (mailto) {
                    char *href = mdy_alloc(&ctx->doc->arena, n + 8);
                    memcpy(href, "mailto:", 7);
                    memcpy(href + 7, p, n);
                    mdy_set_string(ctx->doc, a, "href", href, n + 7);
                } else
                mdy_set_string(ctx->doc, a, "href", p, n);
                mdy_append(a, mdy_new_text(ctx->doc, p, n));
                mdy_append(ctx->parent, a);
                ctx->at_boundary = 1;
                i += n;
                continue;
            }
        }

        /* Only whitespace leaves a boundary behind — `/\s/`, so a no-break
         * space does and a bracket does not; treating a bracket as one made
         * emoticons out of ordinary prose. */
        {
            uint32_t cp;
            size_t width = mdy_utf8_decode(p, left, &cp);
            ctx->at_boundary = mdy_is_js_space(cp);
            push(ctx, p, width);
            i += width;
        }
    }
    flush(ctx);
}

void mdy_parse_inline(mdy_doc *doc, mdy_node *parent, const char *text, size_t len) {
    Span stack_urls[MDY_MAX_URLS];
    Span *urls = stack_urls;
    size_t urls_cap = MDY_MAX_URLS;
    size_t url_count = 0;
    if (doc->options.autolink) {
        mdy_link stack_found[MDY_MAX_URLS];
        mdy_link *found = stack_found;
        size_t cap = MDY_MAX_URLS;
        size_t n = mdy_find_links(text, len, found, cap);
        while (n == cap) {
            size_t want = cap * 2;
            mdy_link *grown = found == stack_found ? malloc(want * sizeof *grown)
                                                   : realloc(found, want * sizeof *grown);
            if (!grown) break;
            found = grown;
            cap = want;
            n = mdy_find_links(text, len, found, cap);
        }
        if (n > urls_cap) {
            Span *grown = malloc(n * sizeof *grown);
            if (grown) { urls = grown; urls_cap = n; }
            else n = urls_cap;
        }
        for (size_t k = 0; k < n && url_count < urls_cap; k++) {
            urls[url_count].start = found[k].start;
            urls[url_count].end = found[k].end;
            urls[url_count].mailto = found[k].mailto;
            url_count++;
        }
        if (found != stack_found) free(found);
    }
    parse_inline_spans(doc, parent, text, len, urls, url_count);
    if (urls != stack_urls) free(urls);
}

/* The scan itself, over `text` with its URLs already found — the whole of a
 * paragraph, or a marker's slice with the paragraph's spans rebased. */
static void parse_inline_spans(mdy_doc *doc, mdy_node *parent, const char *text, size_t len,
                               const Span *urls, size_t url_count) {
    /* The pending-text scratch is freed when the scan is done: what it held
     * is in the arena as text nodes by then, and on the arena a scratch four
     * times the text — per paragraph, and again per nested span — outlived
     * the parse and was most of what a document cost. */
    size_t cap = len * 4 + 8;   /* see push() */
    Ctx ctx = { .doc = doc, .parent = parent, .len = 0, .cap = cap,
                .urls = urls, .url_count = url_count, .text = text, .at_boundary = 1,
                .wiki_skip = text };
    ctx.buf = malloc(cap);
    if (!ctx.buf) mdy_oom_exit();
    scan(&ctx, text, len);
    free(ctx.buf);
}

/*
 * Where a bare `[[ label ]]` points — mdy-docs' defaultResolve, which is NOT
 * slugify and the difference matters:
 *
 *     defaultResolve   lowercase, whitespace to `-`, then DELETE anything
 *                      outside [letters, numbers, - / . _ #]
 *     slugify          lowercase, then anything outside [a-z0-9] becomes `-`
 *
 * So `Umm el-Qa'ab` resolves to `umm-el-qaab` — the apostrophe vanishes rather
 * than becoming a hyphen — and `Edward R. Ayrton` keeps its full stop. Getting
 * these confused produced `umm-el-qa-ab` and `edward-r-ayrton`, which are
 * links to nowhere.
 *
 * "Letters and numbers" is Unicode-aware, and decided per CODE POINT: the loop
 * below decodes each character and classifies it with mdy_is_letter_or_number_cp,
 * so a multi-byte letter is kept whole and a multi-byte punctuation mark is
 * deleted whole. Deciding per byte would keep or drop half a character and
 * mangle every non-English label in the corpus.
 */
/* `out_len` may be NULL for a caller that only wants the string — the heading
 * ids want the length, the wiki links do not. */
const char *mdy_resolve_slug(mdy_doc *doc, const char *s, size_t len, size_t *out_len) {
    /* Lowercasing can grow a character (ẞ is one byte wider lowered), so the
     * buffer allows for it rather than assuming the output is no longer than
     * the input. */
    char *out = mdy_alloc(&doc->arena, len * 2 + 2);
    if (!out) { if (out_len) *out_len = 0; return NULL; }

    size_t o = 0;
    int was_space = 0;
    for (size_t i = 0; i < len;) {
        uint32_t cp;
        size_t width = mdy_utf8_decode(s + i, len - i, &cp);
        i += width;

        int space = mdy_is_js_space(cp);
        if (space) {
            /*
             * `\s+` becomes ONE hyphen — a run of whitespace, not "whitespace
             * with a hyphen already behind it". The two differ whenever a
             * deleted character sits between two spaces: `plain | label`
             * resolves to `plain--label`, because the replacement happens
             * before the deletion and leaves two runs, not one.
             */
            if (!was_space) out[o++] = '-';
            was_space = 1;
            continue;
        }
        was_space = 0;

        if (cp == '-' || cp == '/' || cp == '.' || cp == '_' || cp == '#' ||
            mdy_is_letter_or_number_cp(cp)) {
            o += mdy_utf8_encode(mdy_lower_cp(cp), out + o);
            continue;
        }
        /* Everything else is deleted — the WHOLE character, which decoding
         * rather than walking bytes is what guarantees. */
    }
    out[o] = '\0';
    if (out_len) *out_len = o;
    return out;
}

/*
 * The id a heading gets: its slug, made UNIQUE against the ids this document
 * has already handed out, and recorded so that the next heading sees it.
 *
 * BOTH front ends call this. Three headings called "foo" must come out
 * `foo`, `foo-1`, `foo-2`, as mdy-docs gives them: duplicate ids are invalid
 * HTML and every `#anchor` past the first points at the wrong one.
 *
 * The suffix counts the BASE id, so it is the base that is recorded rather
 * than the unique form — otherwise a document containing `foo`, `foo` and a
 * literal heading called `foo-1` would number them wrongly.
 *
 * Arena-allocated at whatever length it needs, never into a fixed buffer: an
 * id cut short is one this engine invented and node did not.
 */
const char *mdy_heading_id(mdy_doc *doc, const char *text, size_t len, size_t *out_len) {
    if (out_len) *out_len = 0;

    size_t base_len = 0;
    const char *base = mdy_resolve_slug(doc, text, len, &base_len);
    if (!base || !base_len) return NULL;

    /*
     * How many earlier headings already took this base slug — the count the
     * `-1`, `-2`, … suffix is built from. A linear scan over every prior id is
     * O(headings^2) on a document that is mostly headings, so past a threshold
     * the scan is replaced by a slug -> count index. Keyed on the INTERNED
     * slug, which groups exactly as the strcmp below does (both stop at NUL).
     */
    const char *slug_key = NULL;
    size_t taken = 0;
    if (doc->heading_index) {
        slug_key = mdy_intern(&doc->arena, &doc->names, base, strlen(base));
        mdy_hentry *e = mdy_hindex_get(doc->heading_index, slug_key, 0);
        taken = e ? e->val : 0;
    } else {
        for (size_t k = 0; k < doc->heading_count; k++)
            if (strcmp(doc->heading_ids[k], base) == 0) taken++;
    }

    const char *id = base;
    size_t id_len = base_len;
    if (taken) {
        char *unique = mdy_alloc(&doc->arena, base_len + 24);
        int n = snprintf(unique, base_len + 24, "%s-%zu", base, taken);
        if (n < 0) return NULL;
        id = unique;
        id_len = (size_t)n;
    }

    if (doc->heading_count == doc->heading_cap) {
        size_t grown = doc->heading_cap ? doc->heading_cap * 2 : 32;
        const char **next = mdy_alloc(&doc->arena, sizeof(char *) * grown);
        if (next) {
            for (size_t k = 0; k < doc->heading_count; k++) next[k] = doc->heading_ids[k];
            doc->heading_ids = next;
            doc->heading_cap = grown;
        }
    }
    int appended = 0;
    if (doc->heading_count < doc->heading_cap) {
        doc->heading_ids[doc->heading_count++] = base;
        appended = 1;
    }

    /* Keep the count index in step with the array — and build it, once from
     * the array we already have, when the scan grows long enough to bite. Both
     * only run when the append landed, so the index never disagrees with it. */
    if (appended && doc->heading_index) {
        if (!slug_key) slug_key = mdy_intern(&doc->arena, &doc->names, base, strlen(base));
        if (!mdy_hindex_put(doc, doc->heading_index, slug_key, 0, taken + 1))
            doc->heading_index = NULL;   /* an allocation failed; the scan takes over */
    } else if (appended && !doc->heading_noindex && doc->heading_count >= MDY_HINDEX_THRESHOLD) {
        mdy_hindex *ix = mdy_alloc(&doc->arena, sizeof *ix);
        if (!ix) {
            doc->heading_noindex = 1;
        } else {
            memset(ix, 0, sizeof *ix);
            int ok = 1;
            for (size_t k = 0; k < doc->heading_count && ok; k++) {
                const char *ki = mdy_intern(&doc->arena, &doc->names,
                                            doc->heading_ids[k], strlen(doc->heading_ids[k]));
                mdy_hentry *e = mdy_hindex_get(ix, ki, 0);
                ok = mdy_hindex_put(doc, ix, ki, 0, e ? e->val + 1 : 1);
            }
            if (ok) doc->heading_index = ix;
            else doc->heading_noindex = 1;   /* an allocation failed mid-build; do not thrash */
        }
    }

    if (out_len) *out_len = id_len;
    return id;
}

/* JavaScript's notion of whitespace, not C's — see mdy_trim. A label ending
 * in a no-break space is real, and an ASCII-only trim keeps it. */
static void cut(const char **s, size_t *len) { mdy_trim(s, len); }

/*
 * How many bytes the `[[ … ]]` at `p` would take, or 0 when it is left as
 * text: no `]]` before the line ends, nothing between the brackets, or a
 * footnote reference nothing defines. The closer search asks this so a
 * marker inside a link is the link's, as the scanner takes it whole.
 */
/* wiki.js's findPipe: the first `|` not escaped by a backslash, or `len`. */
static size_t find_pipe(const char *s, size_t len) {
    for (size_t j = 0; j < len; j++) {
        if (s[j] == '\\') { j++; continue; }
        if (s[j] == '|') return j;
    }
    return len;
}

static size_t wiki_link_length(Ctx *ctx, const char *p, size_t left) {
    /* A closer scan starting at or before here already failed, up to the end
     * of this line — so this one would too. See Ctx.wiki_skip. */
    if (p < ctx->wiki_skip) return 0;
    size_t close = 0;
    int found = 0;
    for (size_t j = 2; j + 1 < left; j++) {
        if (p[j] == ']' && p[j + 1] == ']') { close = j; found = 1; break; }
        /* No closer before the newline: remember it, so every `[[` up to it is
         * answered without rescanning. See Ctx.wiki_skip. */
        if (p[j] == '\n') { ctx->wiki_skip = p + j; return 0; }
    }
    if (!found) { ctx->wiki_skip = p + left; return 0; }   /* ran to the end, no closer */

    /* `[[ ]]` says nothing and links nowhere. The label is what stands
     * before the first unescaped pipe; a footnote reference is a label that
     * starts with `^`, whatever follows the pipe. */
    const char *label = p + 2;
    size_t label_len = find_pipe(label, close - 2);
    cut(&label, &label_len);
    if (label_len == 0) return 0;
    if (label[0] == '^') {
        const char *id = label + 1;
        size_t id_len = label_len - 1;
        cut(&id, &id_len);
        if (!mdy_footnote_find(ctx->doc, id, id_len)) return 0;
    }
    return close + 2;
}

/** Consume `[[ … ]]` at `p`, emitting a link. Returns bytes consumed, or 0 to
 * leave it as text. */
static size_t wiki_link(Ctx *ctx, const char *p, size_t left) {
    size_t taken = wiki_link_length(ctx, p, left);
    if (!taken) return 0;
    size_t close = taken - 2;

    const char *body = p + 2;
    size_t body_len = close - 2;
    cut(&body, &body_len);
    const char *first = body;
    size_t first_len = find_pipe(body, body_len);
    cut(&first, &first_len);
    if (first_len && first[0] == '^') {
        /*
         * A footnote reference — but only if the definition exists. Without
         * one it stays literal text, which is what the JavaScript does and
         * why definitions are collected before any of this runs.
         */
        const char *id = first + 1;
        size_t id_len = first_len - 1;
        cut(&id, &id_len);                              /* `label.slice(1).trim()` */
        mdy_footnote *note = mdy_footnote_find(ctx->doc, id, id_len);
        if (!note) return 0;
        int n = mdy_footnote_reference(ctx->doc, note);

        const char *pre = ctx->doc->note_prefix ? ctx->doc->note_prefix : "user-content-";
        /* Sized to the label: at buf[256] a long id truncated the `href` (with
         * its leading `#`) one byte earlier than the `id`, so the ref pointed
         * at an anchor that did not exist. */
        size_t cap = strlen(pre) + strlen(note->safe) + 32;
        char stackbuf[256];
        char *buf = cap <= sizeof stackbuf ? stackbuf : malloc(cap);
        if (!buf) mdy_oom_exit();
        flush(ctx);
        mdy_node *sup = mdy_new_element(ctx->doc, "sup", 3);
        mdy_node *a = mdy_new_element(ctx->doc, "a", 1);

        snprintf(buf, cap, "#%sfn-%s", pre, note->safe);
        mdy_set_string(ctx->doc, a, "href", buf, strlen(buf));
        if (n > 1) snprintf(buf, cap, "%sfnref-%s-%d", pre, note->safe, n);
        else snprintf(buf, cap, "%sfnref-%s", pre, note->safe);
        mdy_set_string(ctx->doc, a, "id", buf, strlen(buf));
        mdy_set_bool(ctx->doc, a, "dataFootnoteRef", 1);
        mdy_set_string(ctx->doc, a, "ariaDescribedBy", "footnote-label", 14);

        snprintf(buf, cap, "%d", note->number);
        mdy_append(a, mdy_new_text(ctx->doc, buf, strlen(buf)));
        mdy_append(sup, a);
        mdy_append(ctx->parent, sup);
        ctx->at_boundary = 0;
        if (buf != stackbuf) free(buf);
        return close + 2;
    }

    const char *label = body;
    size_t label_len = body_len;
    const char *target = NULL;
    size_t target_len = 0;

    for (size_t j = 0; j < body_len; j++) {
        /* `\|` is a literal pipe in the label, not the separator. A corpus of
         * citations is full of them — "…desert \| Aeon Essays" — and taking
         * the first pipe regardless made the href the whole rest of the
         * construct, which then swallowed every link after it on that line. */
        if (body[j] == '\\') { j++; continue; }
        if (body[j] != '|') continue;
        label = body;
        label_len = j;
        target = body + j + 1;
        target_len = body_len - j - 1;
        cut(&label, &label_len);
        cut(&target, &target_len);
        break;
    }
    if (label_len == 0) return 0;

    if (!target) {
        /* Resolved from the label's TEXT, which is the label with its escapes
         * taken off — `plain \| label` resolves as `plain | label` does. */
        char *plain = mdy_alloc(&ctx->doc->arena, label_len + 1);
        size_t plain_len = 0;
        for (size_t j = 0; j < label_len; j++) {
            if (label[j] == '\\' && j + 1 < label_len) j++;
            plain[plain_len++] = label[j];
        }
        plain[plain_len] = '\0';

        size_t n = 0;
        target = mdy_resolve_slug(ctx->doc, plain, plain_len, &n);
        target_len = target ? n : 0;
    }

    flush(ctx);
    mdy_node *a = mdy_new_element(ctx->doc, "a", 1);
    /* `if (!written) return {}`: a target written empty, or a label that
     * resolves to nothing, is a link with no href, not no link. */
    if (target_len == 0) target = NULL;
    /*
     * The href is dropped when it points somewhere the schema refuses,
     * exactly as it would be on a hand-written <a> — and otherwise TIDIED,
     * but only when it names a page of ours. Somebody else's URL is theirs,
     * case and all, and a fragment names an id.
     */
    if (!target) {
        /* no href */
    } else if (ctx->doc->options.sanitize &&
               !mdy_protocol_allowed("href", target, target_len)) {
        mdy_warn_inline(ctx->doc, "sanitize",
                        "`[[%.*s]]` points at a protocol that is not allowed, dropping the link",
                        (int)label_len, label);
    } else {
        if (mdy_link_kind_page(target, target_len)) {
            size_t cap = target_len * 2 + 8;      /* lowercasing may widen a character */
            char *tidy = mdy_alloc(&ctx->doc->arena, cap);
            size_t n = mdy_normalize_link(target, target_len, tidy, cap);
            mdy_set_string(ctx->doc, a, "href", tidy, n);
            mdy_collect(ctx->doc, MDY_REF_LINK, tidy, n);
        } else {
            mdy_set_string(ctx->doc, a, "href", target, target_len);
        }
    }

    /*
     * The label is content in its own right, parsed with autolink ON so a URL
     * inside it survives the `//` marker — and then UNWRAPPED, because an <a>
     * inside an <a> is not a thing. Skipping the unwrap left 150 nested links
     * across the corpus, every one of them with a plausible href, which is why
     * counting nodes found it and checking hrefs did not.
     */
    ctx->doc->ref_off++;
    mdy_parse_inline(ctx->doc, a, label, label_len);
    ctx->doc->ref_off--;
    unwrap_links(a);

    mdy_append(ctx->parent, a);
    ctx->at_boundary = 1;
    return close + 2;
}
