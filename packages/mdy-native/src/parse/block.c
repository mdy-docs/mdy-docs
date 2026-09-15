/*
 * The block grammar, and the entry point.
 *
 * Measured before written: on the reference corpus, block structure is 62% of
 * the front end's time and inline the other 38%, with no single rule
 * dominating either half. So this is where a port has to start, and there is
 * no shortcut in which one hot rule is moved and the rest left alone.
 *
 * INDENTATION IS STRUCTURAL in MDY — every two columns is one level — which is
 * why everything here works on a pre-measured line array rather than on raw
 * text. Each rule needs the width before it needs the content.
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>

#include "internal.h"

static void trim(const char **s, size_t *len);
static int definition_line(const mdy_line *l, const char **id, size_t *id_len,
                           const char **content, size_t *content_len);
static size_t parse_definition(mdy_doc *doc, const mdy_line *lines, size_t count, size_t i,
                               const char *id, size_t id_len,
                               const char *head, size_t head_len);

void mdy_options_default(mdy_options *out) {
    out->documents = 0;
    out->document_wrapper = NULL;   /* NULL means `article` */
    out->frontmatter = 1;
    out->frontmatter_fence = NULL;  /* NULL means `+++` */
    out->autolink = 1;
    out->emphasis = 1;
    out->max_heading = 6;
    out->line_offset = 0;
    out->highlight = NULL;
    out->highlight_ud = NULL;
    out->positions = 1;
    out->sanitize = 1;
    out->tasks = 0;
    out->line_map = NULL;
    out->line_map_len = 0;
}

/* ---- lines --------------------------------------------------------------- */

/** Split into lines, measuring indentation as we go. A tab advances to the
 * next four-column tab stop, matching the JavaScript's `indentWidth`. */
static mdy_line *split_lines(mdy_doc *doc, const char *text, size_t len, size_t *count) {
    size_t n = 1;
    for (size_t i = 0; i < len; i++) if (text[i] == '\n') n++;

    mdy_line *lines = mdy_alloc(&doc->arena, sizeof *lines * n);
    if (!lines) { *count = 0; return NULL; }

    size_t out = 0, start = 0;
    for (size_t i = 0; i <= len; i++) {
        if (i != len && text[i] != '\n') continue;
        size_t end = i;
        if (end > start && text[end - 1] == '\r') end--;   /* CRLF */

        mdy_line *line = &lines[out];
        line->text = text + start;
        line->len = end - start;
        /* Its line in the file: through the map when the script layer left
         * one, else its own count. A line the map does not reach — one a
         * loop wrote past the end — takes the map's last line, since that
         * is the line of the code that wrote it. */
        const mdy_options *o = &doc->options;
        if (o->line_map && o->line_map_len) {
            size_t at = out < o->line_map_len ? out : o->line_map_len - 1;
            line->number = o->line_map[at] + o->line_offset;
        } else {
            line->number = (uint32_t)out + 1 + o->line_offset;
        }
        /* Before the indent is stripped: a position's end column counts from
         * the start of the line, indentation and all. */
        line->units = (uint32_t)mdy_utf16_length(text + start, end - start);

        /*
         * `indentWidth`: a tab advances to the next TAB STOP, four columns
         * apart — `width += tabSize - (width % tabSize)`. Counting it as a
         * fixed two made one tab half an indent level, so a tab-indented
         * block did not nest.
         */
        size_t indent = 0, k = 0;
        while (k < line->len && (line->text[k] == ' ' || line->text[k] == '\t')) {
            indent += line->text[k] == '\t' ? 4 - (indent % 4) : 1;
            k++;
        }
        line->indent = indent;
        line->indent_chars = k;
        line->text += k;
        line->len -= k;
        line->blank = line->len == 0;

        out++;
        start = i + 1;
    }
    *count = out;
    return lines;
}

void mdy_set_position(mdy_node *node, const mdy_line *lines, size_t from, size_t to) {
    if (!node) return;
    node->line = lines[from].number;
    node->column = 1;
    node->end_line = lines[to].number;
    node->end_column = lines[to].units + 1;
}

/* Room for one more message, or NULL when the arena is exhausted. */
static mdy_message *next_message(mdy_doc *doc) {
    if (doc->message_count == doc->message_cap) {
        size_t want = doc->message_cap ? doc->message_cap * 2 : 8;
        mdy_message *grown = mdy_alloc(&doc->arena, sizeof *grown * want);
        if (!grown) return NULL;
        for (size_t i = 0; i < doc->message_count; i++) grown[i] = doc->messages[i];
        doc->messages = grown;
        doc->message_cap = want;
    }
    return &doc->messages[doc->message_count++];
}

/*
 * A warning about something the parser changed or dropped.
 *
 * The place is the same span a block element on that line would carry, which
 * is what `warn(reason, line, ruleId)` passes as `position(line, line)`.
 */
void mdy_warn(mdy_doc *doc, const mdy_line *lines, size_t line, const char *rule,
              const char *fmt, ...) {
    mdy_message *m = next_message(doc);
    if (!m) return;

    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);

    m->reason = mdy_strdup_n(&doc->arena, buf, strlen(buf));
    m->rule = rule;
    m->line = lines[line].number;
    m->column = 1;
    m->end_line = lines[line].number;
    m->end_column = lines[line].units + 1;
}

/*
 * A warning with no PLACE.
 *
 * The inline parser works on a joined string and has no line to point at —
 * and neither does the JavaScript's, which raises this one as
 * `file.message(reason, {ruleId, source})` with no `place` at all. A message
 * without a position is better than one with the wrong position.
 */
void mdy_warn_inline(mdy_doc *doc, const char *rule, const char *fmt, ...) {
    mdy_message *m = next_message(doc);
    if (!m) return;

    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);

    m->reason = mdy_strdup_n(&doc->arena, buf, strlen(buf));
    m->rule = rule;
    m->line = m->column = m->end_line = m->end_column = 0;
}

/* Note one document's front matter — or, with a NULL source, that it had
 * none, so the entries line up with the documents one for one. */
static void record_matter(mdy_doc *doc, const char *source, size_t len,
                          uint32_t open_line, uint32_t close_line) {
    if (doc->matter_count == doc->matter_cap) {
        size_t want = doc->matter_cap ? doc->matter_cap * 2 : 4;
        mdy_frontmatter *grown = mdy_alloc(&doc->arena, sizeof *grown * want);
        if (!grown) return;
        for (size_t i = 0; i < doc->matter_count; i++) grown[i] = doc->matter[i];
        doc->matter = grown;
        doc->matter_cap = want;
    }
    mdy_frontmatter *m = &doc->matter[doc->matter_count++];
    m->source = source;
    m->source_len = len;
    m->open_line = open_line;
    m->close_line = close_line;
}

void mdy_collect(mdy_doc *doc, mdy_ref_kind kind, const char *name, size_t len) {
    /* A wiki link's label is parsed as content, and a `#tag` in it is text
     * of the link, not a reference the document makes — `parseInline(label,
     * {...options, collect: undefined})`. */
    if (doc->ref_off) return;
    /*
     * Only once each, per document — `!list.includes(name)`. The dedup key is
     * (document, kind, name); past a threshold the linear `includes` becomes a
     * (name -> presence) index, with document and kind folded into the tag so
     * one table holds every document's names apart. The name is compared by
     * length and bytes, which interning reproduces exactly.
     */
    uint64_t tag = ((uint64_t)doc->ref_document << 32) | (uint32_t)kind;
    const char *name_key = NULL;
    if (doc->ref_index) {
        name_key = mdy_intern(&doc->arena, &doc->names, name, len);
        if (mdy_hindex_get(doc->ref_index, name_key, tag)) return;
    } else {
        for (size_t i = 0; i < doc->ref_count; i++) {
            const mdy_reference *r = &doc->refs[i];
            if (r->document == doc->ref_document && r->kind == kind &&
                r->name_len == len && memcmp(r->name, name, len) == 0) return;
        }
    }
    if (doc->ref_count == doc->ref_cap) {
        size_t want = doc->ref_cap ? doc->ref_cap * 2 : 16;
        mdy_reference *grown = mdy_alloc(&doc->arena, sizeof *grown * want);
        if (!grown) return;
        for (size_t i = 0; i < doc->ref_count; i++) grown[i] = doc->refs[i];
        doc->refs = grown;
        doc->ref_cap = want;
    }
    mdy_reference *r = &doc->refs[doc->ref_count++];
    r->kind = kind;
    r->name = mdy_strdup_n(&doc->arena, name, len);
    r->name_len = len;
    r->document = doc->ref_document;

    /* Keep the dedup index in step, and build it once the scan grows long. */
    if (doc->ref_index) {
        if (!name_key) name_key = mdy_intern(&doc->arena, &doc->names, name, len);
        if (!mdy_hindex_put(doc, doc->ref_index, name_key, tag, 0))
            doc->ref_index = NULL;
    } else if (!doc->ref_noindex && doc->ref_count >= MDY_HINDEX_THRESHOLD) {
        mdy_hindex *ix = mdy_alloc(&doc->arena, sizeof *ix);
        if (!ix) {
            doc->ref_noindex = 1;
        } else {
            memset(ix, 0, sizeof *ix);
            int ok = 1;
            for (size_t i = 0; i < doc->ref_count && ok; i++) {
                const mdy_reference *e = &doc->refs[i];
                const char *ki = mdy_intern(&doc->arena, &doc->names, e->name, e->name_len);
                uint64_t kt = ((uint64_t)e->document << 32) | (uint32_t)e->kind;
                ok = mdy_hindex_put(doc, ix, ki, kt, 0);
            }
            if (ok) doc->ref_index = ix;
            else doc->ref_noindex = 1;
        }
    }
}

size_t mdy_reference_count(const mdy_doc *doc) {
    return doc ? doc->ref_count : 0;
}

const mdy_reference *mdy_reference_at(const mdy_doc *doc, size_t i) {
    if (!doc || i >= doc->ref_count) return NULL;
    return &doc->refs[i];
}

size_t mdy_frontmatter_count(const mdy_doc *doc) {
    return doc ? doc->matter_count : 0;
}

const mdy_frontmatter *mdy_frontmatter_at(const mdy_doc *doc, size_t i) {
    if (!doc || i >= doc->matter_count) return NULL;
    return &doc->matter[i];
}

size_t mdy_message_count(const mdy_doc *doc) {
    return doc ? doc->message_count : 0;
}

const mdy_message *mdy_message_at(const mdy_doc *doc, size_t i) {
    if (!doc || i >= doc->message_count) return NULL;
    return &doc->messages[i];
}

/* ---- small helpers ------------------------------------------------------- */

/*
 * `/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/` — a thematic break.
 *
 * Three or more of ONE character, with whitespace allowed between them and
 * after them. `- - -` and `*  *  *` are breaks; a run of the character with
 * nothing between it is only the commonest way to write one.
 */
static int thematic_break(const mdy_line *l) {
    if (l->len == 0) return 0;
    char c = l->text[0];
    if (c != '-' && c != '*' && c != '_') return 0;
    size_t seen = 0;
    for (size_t i = 0; i < l->len; i++) {
        if (l->text[i] == c) { seen++; continue; }
        if (l->text[i] == ' ' || l->text[i] == '\t') continue;
        return 0;
    }
    return seen >= 3;
}

/* A Setext underline: `least` or more of `c`, then optional whitespace. */
static int underline_of(const mdy_line *l, char c, size_t least) {
    size_t n = 0;
    while (n < l->len && l->text[n] == c) n++;
    if (n < least) return 0;
    for (size_t k = n; k < l->len; k++)
        if (l->text[k] != ' ' && l->text[k] != '\t') return 0;
    return 1;
}

static size_t run_of(const mdy_line *l, char c) {
    size_t n = 0;
    while (n < l->len && l->text[n] == c) n++;
    return n;
}

/* JavaScript's notion of whitespace, not C's — see mdy_trim. */
static void trim(const char **s, size_t *len) { mdy_trim(s, len); }


/*
 * Block children of an ELEMENT are separated by newline text nodes — `"\n" p
 * "\n" p "\n"` — and block children of the ROOT are not. That asymmetry is
 * the JavaScript's, and it is what makes the HTML it stringifies come out one
 * block per line inside a container while a bare document has no leading
 * newline. Lists follow the same rule, which is why the list code below emits
 * its own.
 */
static void separate(mdy_doc *doc, mdy_node *parent) {
    if (parent->type == MDY_ELEMENT) mdy_append(parent, mdy_new_text(doc, "\n", 1));
}

/* How much node_text would write, so a caller can hold all of it. */
static size_t node_text_len(const mdy_node *n) {
    if (n->type == MDY_TEXT) return mdy_text_len(n);
    size_t total = 0;
    for (const mdy_node *c = n->first; c; c = c->next) total += node_text_len(c);
    return total;
}

static size_t node_text(const mdy_node *n, char *out, size_t cap, size_t o) {
    if (n->type == MDY_TEXT) {
        size_t len = mdy_text_len(n);
        if (o + len > cap) len = cap > o ? cap - o : 0;
        memcpy(out + o, n->text, len);
        return o + len;
    }
    for (const mdy_node *c = n->first; c; c = c->next) o = node_text(c, out, cap, o);
    return o;
}

static void set_heading_id(mdy_doc *doc, mdy_node *h, const char *text, size_t len) {
    /*
     * The SAME slug a `[[ label ]]` resolves to, not slugify — mdy-docs says
     * why in heading.js: "a heading and a link written from the same text
     * agree". The two differ wherever punctuation appears, because resolve
     * DELETES what slugify hyphenates: `King's List` is `kings-list` under one
     * and `king-s-list` under the other, and only the first is a link that
     * works.
     */
    size_t id_len = 0;
    const char *id = mdy_heading_id(doc, text, len, &id_len);
    if (id && id_len) mdy_set_string(doc, h, "id", id, id_len);
}

/* ---- list markers -------------------------------------------------------- */

/** How many characters of `l` are a list marker, and whether it is ordered.
 * `-`, `*`, `+` for bullets; `1.` or `1)` for ordered. 0 means not a list. */
/*
 * A marker must be followed by a space, a tab, or THE END OF THE LINE — that
 * last one is not a nicety. `1931.` alone on a line is an ordered list whose
 * item content is on the following lines, and reading it as prose instead put
 * it inside the paragraph above and shifted every footnote number after it.
 * `1931.x` is not a marker, because something that is not a space follows.
 */
/** The number an ordered marker carries, or 0 for a bullet. Only meaningful
 * when list_marker returned non-zero. */
static long marker_number(const mdy_line *l) {
    long value = 0;
    size_t i = 0;
    /* At most nine digits, which list_marker guarantees: the value fits a
     * 32-bit long. */
    while (i < l->len && i < 9 && l->text[i] >= '0' && l->text[i] <= '9') {
        value = value * 10 + (l->text[i] - '0');
        i++;
    }
    return i ? value : -1;
}

static size_t list_marker(const mdy_line *l, int *ordered) {
    if (l->len < 1) return 0;
    char c = l->text[0];
    if (c == '-' || c == '*' || c == '+') {
        if (l->len == 1) { *ordered = 0; return 1; }
        if (l->text[1] == ' ' || l->text[1] == '\t') { *ordered = 0; return 2; }
        return 0;
    }
    size_t digits = 0;
    while (digits < l->len && l->text[digits] >= '0' && l->text[digits] <= '9') digits++;
    /* `\d{1,9}`: ten digits or more is not a marker at all. */
    if (digits == 0 || digits > 9 || digits >= l->len) return 0;
    if (l->text[digits] != '.' && l->text[digits] != ')') return 0;
    if (digits + 1 == l->len) { *ordered = 1; return digits + 1; }   /* end of line */
    if (l->text[digits + 1] == ' ' || l->text[digits + 1] == '\t') { *ordered = 1; return digits + 2; }
    return 0;
}

/* ---- the `<element` syntax ------------------------------------------------ */

/*
 * `<figure`, `<img src="…" width="250"`, `<figcaption>caption text`.
 *
 * A bare `<` is a `<div>`. The closing `>` is optional, and when it IS present
 * whatever follows on that line is the element's INLINE content — no paragraph
 * wrapper and no newline separators, which is how `<li>King fort` produces
 * `li("King fort")` rather than `li("\n" p("King fort") "\n")`.
 *
 * Otherwise the element's children are the lines indented under it, parsed as
 * blocks. Indentation is structural in MDY, so "under it" means strictly more
 * indented, and the element closes as soon as the indentation comes back.
 */
/*
 * The name patterns from ../../src/parse/html.js: a tag is a letter then
 * letters, digits and hyphens; an attribute is a letter, underscore or colon
 * then letters, digits, dots, underscores, colons and hyphens.
 *
 * Both must START with a letter, and that is the part worth having: it is what
 * stops the `--` of `<!-- a comment -->` from being read as an attribute
 * called `--`.
 */
static int is_tag_start(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
static int is_tag_char(char c) {
    return is_tag_start(c) || (c >= '0' && c <= '9') || c == '-';
}
static int is_attr_start(char c) { return is_tag_start(c) || c == '_' || c == ':'; }
static int is_attr_char(char c) {
    return is_tag_start(c) || (c >= '0' && c <= '9') ||
           c == '.' || c == '_' || c == ':' || c == '-';
}

/** How far the element opened on line `i` extends: the first line at or below
 * its own indentation. */
static size_t child_lines(const mdy_line *lines, size_t count, size_t i, size_t indent) {
    size_t j = i + 1;
    size_t last = j;
    while (j < count) {
        if (lines[j].blank) { j++; continue; }   /* a blank line does not close it */
        if (lines[j].indent <= indent) break;
        j++;
        last = j;
    }
    return last;
}

/**
 * Parse the attributes of an opener into `el`, stopping at the closing `>` if
 * there is one. `*content` is set to whatever follows that `>`, or NULL.
 */
static void parse_attributes(mdy_doc *doc, mdy_node *el, const char *tag,
                             const mdy_line *lines, size_t line,
                             const char *p, size_t len,
                             const char **content, size_t *content_len) {
    *content = NULL;
    *content_len = 0;

    size_t i = 0;
    while (i < len) {
        while (i < len && (p[i] == ' ' || p[i] == '\t')) i++;
        if (i >= len) break;
        if (p[i] == '>') {
            *content = p + i + 1;
            *content_len = len - i - 1;
            return;
        }

        size_t start = i;
        if (is_attr_start(p[i])) {
            i++;
            while (i < len && is_attr_char(p[i])) i++;
        }
        if (i == start) { i++; continue; }        /* not a name — skip the byte */
        const char *name = p + start;
        size_t name_len = i - start;

        const char *value = NULL;
        size_t value_len = 0;
        int has_value = 0;
        size_t save = i;
        while (i < len && (p[i] == ' ' || p[i] == '\t')) i++;
        if (i < len && p[i] == '=') {
            i++;
            while (i < len && (p[i] == ' ' || p[i] == '\t')) i++;
            if (i < len && (p[i] == '"' || p[i] == '\'')) {
                char quote = p[i++];
                size_t vstart = i;
                while (i < len && p[i] != quote) i++;
                value = p + vstart;
                value_len = i - vstart;
                if (i < len) i++;
            } else {
                size_t vstart = i;
                while (i < len && p[i] != ' ' && p[i] != '\t' && p[i] != '>') i++;
                value = p + vstart;
                value_len = i - vstart;
            }
            has_value = 1;
        } else {
            i = save;   /* a bare name — `hidden` */
        }

        /*
         * The schema matches on the LOWERCASED name — `attribute.name
         * .toLowerCase()` — and the attribute that survives carries that
         * spelling into hast, so `DATA-x-Y` sanitised is `dataXY` where
         * unsanitised it is `dataX-Y`.
         */
        char lowered[256];
        if (doc->options.sanitize && name_len < sizeof lowered) {
            for (size_t k = 0; k < name_len; k++) {
                char c = name[k];
                lowered[k] = (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
            }
            name = lowered;
        }

        if (doc->options.sanitize && !mdy_attr_allowed(tag, name, name_len)) {
            mdy_warn(doc, lines, line, "sanitize",
                     "`%.*s` is not allowed on `<%s>`, dropping it",
                     (int)name_len, name, tag);
            continue;
        }
        if (doc->options.sanitize && has_value &&
            !mdy_protocol_allowed_n(name, name_len, value, value_len)) {
            mdy_warn(doc, lines, line, "sanitize",
                     "`%.*s` points at a protocol that is not allowed, dropping it",
                     (int)name_len, name);
            continue;
        }

        const char *hast = mdy_hast_name(doc, name, name_len);
        if (!has_value) { mdy_set_bool(doc, el, hast, 1); continue; }

        /*
         * A hand-written `<a href>` to a page of OURS is tidied exactly as a
         * wiki link's is, and written down the same way. Somebody else's URL
         * is theirs, case and all, and a fragment names an id.
         */
        if (strcmp(tag, "a") == 0 && strcmp(hast, "href") == 0 &&
            mdy_link_kind_page(value, value_len)) {
            char tidy[1024];
            if (value_len < sizeof tidy) {
                size_t tn = mdy_normalize_link(value, value_len, tidy, sizeof tidy);
                mdy_set_string(doc, el, hast, tidy, tn);
                mdy_collect(doc, MDY_REF_LINK, tidy, tn);
                continue;
            }
        }

        if (strcmp(hast, "className") == 0) {
            /* A class attribute is a space-separated list, and hast keeps it
             * as one. A repeated attribute replaces — properties is an object. */
            mdy_clear_class(doc, el);
            size_t k = 0;
            while (k < value_len) {
                while (k < value_len && (value[k] == ' ' || value[k] == '\t')) k++;
                size_t cstart = k;
                while (k < value_len && value[k] != ' ' && value[k] != '\t') k++;
                if (k > cstart) {
                    char one[128];
                    size_t n = k - cstart < sizeof one - 1 ? k - cstart : sizeof one - 1;
                    memcpy(one, value + cstart, n);
                    one[n] = '\0';
                    mdy_add_class(doc, el, one);
                }
            }
        } else {
            mdy_set_string(doc, el, hast, value, value_len);
        }
    }
}

/*
 * `/^<!doctype\b[^>]*>?[ \t]*$/i` — the one line of an HTML document that is
 * not an element.
 *
 * The whole line has to match, which is what a prefix test misses: `\b` after
 * `doctype` means `<!doctypefoo>` is not one, `[^>]*` means a `>` may appear
 * only at the end, and what follows it may be whitespace and nothing else.
 */
static int doctype_line(const mdy_line *l) {
    static const char PREFIX[] = "<!doctype";
    size_t n = sizeof PREFIX - 1;
    if (l->len < n) return 0;
    for (size_t k = 0; k < n; k++) {
        char c = l->text[k];
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        if (c != PREFIX[k]) return 0;
    }
    /* `\b`: what follows `doctype` may not be a word character. */
    if (l->len > n) {
        char c = l->text[n];
        int word = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                   (c >= '0' && c <= '9') || c == '_';
        if (word) return 0;
    }
    size_t i = n;
    while (i < l->len && l->text[i] != '>') i++;
    if (i < l->len) i++;                    /* the optional `>` */
    for (size_t k = i; k < l->len; k++)
        if (l->text[k] != ' ' && l->text[k] != '\t') return 0;
    return 1;
}

/* Put `child` at the front of `parent`'s children. */
static void prepend(mdy_node *parent, mdy_node *child) {
    child->next = parent->first;
    parent->first = child;
    if (!parent->last) parent->last = child;
}

/* All the text under a node, the markup taken off — `toText`, for a task's
 * label. Into `buf`, which is `cap` bytes; the result is cut to fit. */
static size_t text_of(const mdy_node *node, char *buf, size_t cap, size_t at) {
    if (!node) return at;
    if (node->type == MDY_TEXT) {
        size_t n = mdy_text_len(node);
        if (at + n >= cap) n = cap - 1 - at;
        memcpy(buf + at, node->text, n);
        at += n;
        buf[at] = '\0';
        return at;
    }
    for (const mdy_node *c = node->first; c; c = c->next) at = text_of(c, buf, cap, at);
    return at;
}

/* `<input type="hidden" name=… value=…>` */
static mdy_node *hidden(mdy_doc *doc, const char *name, const char *value) {
    mdy_node *in = mdy_new_element(doc, "input", 5);
    mdy_set_string(doc, in, "type", "hidden", 6);
    mdy_set_string(doc, in, "name", name, strlen(name));
    mdy_set_string(doc, in, "value", value, strlen(value));
    return in;
}

/*
 * A task's box as a form — src/parse/task.js's `taskForm`, property for
 * property: the line and column of the character between the brackets,
 * what it is now, and a submit button wearing a checkbox's role, state and
 * shape, with the glyph that shape is drawn with. The label is the item's
 * own text, which is why this runs after the inline parse.
 */
static mdy_node *task_form(mdy_doc *doc, int checked, uint32_t line, size_t column,
                           const char *label) {
    mdy_node *form = mdy_new_element(doc, "form", 4);
    mdy_set_string(doc, form, "method", "post", 4);
    mdy_add_class(doc, form, "task-list-item-form");
    char num[24];
    snprintf(num, sizeof num, "%u", (unsigned)line);
    mdy_append(form, hidden(doc, "line", num));
    snprintf(num, sizeof num, "%zu", column);
    mdy_append(form, hidden(doc, "column", num));
    mdy_append(form, hidden(doc, "was", checked ? "x" : " "));
    mdy_node *button = mdy_new_element(doc, "button", 6);
    mdy_set_string(doc, button, "type", "submit", 6);
    mdy_set_string(doc, button, "name", "next", 4);
    mdy_set_string(doc, button, "value", checked ? " " : "x", 1);
    mdy_set_string(doc, button, "role", "checkbox", 8);
    mdy_set_string(doc, button, "ariaChecked", checked ? "true" : "false", checked ? 4 : 5);
    if (label && *label) mdy_set_string(doc, button, "ariaLabel", label, strlen(label));
    mdy_add_class(doc, button, "task-list-item-toggle");
    mdy_node *glyph = mdy_new_element(doc, "span", 4);
    mdy_set_string(doc, glyph, "ariaHidden", "true", 4);
    mdy_append(glyph, mdy_new_text(doc, checked ? "\xe2\x98\x91" : "\xe2\x98\x90", 3));
    mdy_append(button, glyph);
    mdy_append(form, button);
    return form;
}

/*
 * The box at the head of a task item, and the space that separates it from
 * the text — put in FRONT of the item's parsed content, which is why this
 * runs after the inline parse: with `tasks` on, the box is a form whose
 * label is that content's text.
 *
 * The space goes in only when there IS text — `content.unshift({text: ' '})`
 * runs under `if (content.length)` — so an empty task ends at its box. The
 * box carries a position because the JavaScript builds it with the block
 * element helper, which gives every node one.
 */
static void add_task_box(mdy_doc *doc, mdy_node *into, int task, size_t content_len,
                         const mdy_line *lines, size_t line, size_t column) {
    if (task < 0) return;
    mdy_node *box;
    if (doc->options.tasks) {
        char label[1024];
        label[0] = '\0';
        size_t n = text_of(into, label, sizeof label, 0);
        /* `.trim()` */
        size_t start = 0;
        while (start < n && (label[start] == ' ' || label[start] == '\t' || label[start] == '\n')) start++;
        while (n > start && (label[n - 1] == ' ' || label[n - 1] == '\t' || label[n - 1] == '\n')) n--;
        label[n] = '\0';
        box = task_form(doc, task, lines[line].number, column, label + start);
    } else {
        box = mdy_new_element(doc, "input", 5);
        mdy_set_string(doc, box, "type", "checkbox", 8);
        mdy_set_bool(doc, box, "checked", task);
        mdy_set_bool(doc, box, "disabled", 1);
        mdy_set_position(box, lines, line, line);
    }
    if (content_len) prepend(into, mdy_new_text(doc, " ", 1));
    prepend(into, box);
}

/*
 * A fence opener, as src/parse/fence.js reads one: three or more backticks or
 * tildes, then whatever is written after them.
 *
 * Two details that a "three backticks" test misses, and both were wrong here:
 *
 *   - The LANGUAGE is the first word of the info, not the whole of it. An info
 *     of `js title="a b"` names the language `js`, and taking the lot put the
 *     title inside the class attribute.
 *   - A backtick fence may not carry a backtick in its info. Without that
 *     rule a line of prose holding a stray pair of backticks opens a code
 *     block that swallows the rest of the document.
 *
 * Returns the marker width, or 0 when the line is not an opener.
 */
static size_t fence_opener(const mdy_line *l, char *marker,
                           const char **lang, size_t *lang_len) {
    if (l->len < 3 || (l->text[0] != '`' && l->text[0] != '~')) return 0;
    char c = l->text[0];
    size_t width = 0;
    while (width < l->len && l->text[width] == c) width++;
    if (width < 3) return 0;

    const char *info = l->text + width;
    size_t info_len = l->len - width;
    trim(&info, &info_len);
    if (c == '`' && memchr(info, '`', info_len)) return 0;

    /* `info.trim().split(/\s+/)[0]` — the first word and no more. */
    size_t n = 0;
    while (n < info_len && info[n] != ' ' && info[n] != '\t') n++;

    *marker = c;
    *lang = info;
    *lang_len = n;
    return width;
}

/** A line that closes a fence: the same character, at least as many, and
 * nothing else once trailing whitespace is off. */
static int closes_fence(const mdy_line *l, char marker, size_t width) {
    const char *t = l->text;
    size_t len = l->len;
    mdy_trim_end(&t, &len);
    if (len < width) return 0;
    for (size_t k = 0; k < len; k++) if (t[k] != marker) return 0;
    return 1;
}

/*
 * Take a document's comments out.
 *
 * A `#` with nothing against it — a space, or the end of the line. What
 * follows says a comment was meant, because a word against the `#` makes a
 * tag instead; which also makes `# Title`, a Markdown heading, a comment
 * here. MDY writes headings with `=`.
 *
 * A comment is a WHOLE LINE and leaves nothing behind, so the markup around
 * it closes over the gap: the lines either side are as adjacent as they were,
 * and the indentation the block parser reads is the content's alone. Each
 * surviving line keeps its own `number`, so positions still point at the
 * source the comment came out of.
 *
 * A fenced block is the one place they are content: `# ` opens a comment in
 * half the languages a code sample might be written in, and one that quietly
 * lost them would be worse than useless. So the fences are found first and
 * whatever they hold is left exactly as it is.
 */
static int is_comment_line(const mdy_line *l) {
    if (l->len == 0 || l->text[0] != '#') return 0;
    return l->len == 1 || l->text[1] == ' ' || l->text[1] == '\t';
}

static void strip_comments(mdy_line *lines, size_t *count) {
    size_t n = *count;
    size_t any = 0;
    for (size_t i = 0; i < n; i++) if (is_comment_line(&lines[i])) { any = 1; break; }
    if (!any) return;                    /* left exactly as they are */

    char marker = 0;
    size_t width = 0;
    size_t fence_indent = 0;
    int in_fence = 0;
    size_t o = 0;

    for (size_t i = 0; i < n; i++) {
        if (in_fence) {
            if (closes_fence(&lines[i], marker, width)) {
                /* The closer belongs to the block and cannot open another. */
                in_fence = 0;
                lines[o++] = lines[i];
                continue;
            }
            /* An unclosed fence runs to the end of whatever encloses it,
             * which is wherever the indentation comes back out. */
            if (lines[i].len && lines[i].indent < fence_indent) in_fence = 0;
            else { lines[o++] = lines[i]; continue; }
        }

        char c = 0;
        const char *lang = NULL;
        size_t lang_len = 0;
        size_t w = fence_opener(&lines[i], &c, &lang, &lang_len);
        if (w) {
            in_fence = 1;
            marker = c;
            width = w;
            fence_indent = lines[i].indent;
        } else if (is_comment_line(&lines[i])) {
            continue;
        }
        lines[o++] = lines[i];
    }
    *count = o;
}

/* `/^---[ \t]*$/` — a document separator. Exactly three dashes; four is a
 * Setext underline and `- - -` is a thematic break, and both keep their
 * meaning. */
static int is_separator(const mdy_line *l) {
    if (l->indent != 0 || l->len < 3) return 0;
    if (l->text[0] != '-' || l->text[1] != '-' || l->text[2] != '-') return 0;
    for (size_t k = 3; k < l->len; k++)
        if (l->text[k] != ' ' && l->text[k] != '\t') return 0;
    return 1;
}

/* The five elements whose content is text and nothing else — html.js's
 * `rawText` set, and the same names the HTML parser treats as RCDATA. */
static int is_raw_text(const char *tag) {
    return strcmp(tag, "pre") == 0 || strcmp(tag, "script") == 0 ||
           strcmp(tag, "style") == 0 || strcmp(tag, "textarea") == 0 ||
           strcmp(tag, "title") == 0;
}

/*
 * An element whose content is TEXT and nothing else: pre, script, style,
 * textarea, title. Markup inside a <script> is not markup, and parsing it as
 * if it were is how a stylesheet ends up with an <em> in it. `el` is the
 * built element, `[i+1, end)` its lines, `opener_indent` the opener's column.
 *
 * The lines come through as written, minus the indentation that put them in
 * here — two columns past the opener's own, so anything deeper keeps the
 * difference. A BLANK line contributes nothing at all rather than an empty
 * line: the JavaScript joins with `filter(Boolean)`, which drops it along with
 * an empty opener. Appends `el` to `parent` and returns `end`.
 */
static size_t emit_raw_text_element(mdy_doc *doc, mdy_node *parent, mdy_node *el,
                                    const mdy_line *lines, size_t i, size_t end,
                                    size_t opener_indent, const char *content,
                                    size_t content_len) {
    size_t strip = opener_indent + 2;
    size_t need = 0;
    if (content) { trim(&content, &content_len); need += content_len + 1; }
    for (size_t k = i + 1; k < end; k++) {
        if (lines[k].blank) continue;
        size_t extra = lines[k].indent > strip ? lines[k].indent - strip : 0;
        need += extra + lines[k].len + 1;
    }
    char *text = need ? mdy_alloc(&doc->arena, need + 1) : NULL;
    size_t o = 0;
    if (text) {
        if (content && content_len) {
            memcpy(text + o, content, content_len);
            o += content_len;
        }
        for (size_t k = i + 1; k < end; k++) {
            if (lines[k].blank) continue;
            if (o) text[o++] = '\n';
            size_t extra = lines[k].indent > strip ? lines[k].indent - strip : 0;
            for (size_t sp = 0; sp < extra; sp++) text[o++] = ' ';
            memcpy(text + o, lines[k].text, lines[k].len);
            o += lines[k].len;
        }
        text[o] = '\0';
    }
    if (o) mdy_append(el, mdy_new_text(doc, text, o));
    mdy_set_position(el, lines, i, end > i + 1 ? end - 1 : i);
    separate(doc, parent);
    mdy_append(parent, el);
    return end;
}

/* Consume an element opener at line `i`; returns the next line to read. */
static size_t parse_element(mdy_doc *doc, mdy_node *parent,
                            const mdy_line *lines, size_t count, size_t i, size_t nesting) {
    const mdy_line *l = &lines[i];

    /*
     * `<!doctype html>` is its own node type and carries nothing — not the
     * name, not the line it was on. A comment is NOT special, by contrast:
     * `<!-- a comment -->` comes out as a <div> with `a` and `comment` as
     * boolean attributes, which is what the ordinary element rule below does
     * with it and what the JavaScript does too.
     */
    if (doctype_line(l)) {
        /*
         * DROPPED when sanitizing, and that is not an oversight in the
         * JavaScript: sanitizing is the mode for input somebody else wrote,
         * and a fragment has no business declaring what kind of document it
         * is in. The line is still consumed either way.
         */
        if (!doc->options.sanitize) {
            mdy_node *dt = mdy_alloc(&doc->arena, sizeof *dt);
            if (dt) {
                memset(dt, 0, sizeof *dt);
                dt->type = MDY_DOCTYPE;
                separate(doc, parent);
                mdy_append(parent, dt);
            }
        }
        return i + 1;
    }

    /*
     * Space after the `<` means nothing, the same as space between the
     * attributes — html.js says so in as many words, and a real layout is
     * written that way: `< html lang="en"` with the tag indented for reading.
     * Without this the tag came out empty, so every such element became a
     * <div> and its name became an attribute.
     */
    size_t n = 1;                       /* past the `<` */
    while (n < l->len && (l->text[n] == ' ' || l->text[n] == '\t')) n++;
    size_t tag_at = n;
    if (n < l->len && is_tag_start(l->text[n])) {
        n++;
        while (n < l->len && is_tag_char(l->text[n])) n++;
    }

    char tag[64];
    size_t tag_len = n - tag_at;
    if (tag_len == 0) { memcpy(tag, "div", 3); tag_len = 3; }
    else {
        if (tag_len > sizeof tag - 1) tag_len = sizeof tag - 1;
        for (size_t k = 0; k < tag_len; k++) {
            char c = l->text[tag_at + k];
            tag[k] = (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
        }
    }
    tag[tag_len] = '\0';

    /*
     * Two different rules, and collapsing them into one loses an author's
     * text. A tag in the STRIP list disappears with everything under it —
     * `<script>` may not survive in any form. A tag merely absent from the
     * allowed list becomes a <div> and KEEPS its content, because a typo in a
     * tag name should not silently delete a section.
     *
     * The attributes are still judged by the name the author WROTE: the
     * schema's per-tag rules are keyed on `opener.tagName`, not on the `div`
     * it may have just become.
     */
    const char *schema_tag = tag;      /* the name the author wrote */
    const char *build = tag;           /* the name to build */
    if (doc->options.sanitize) {
        if (mdy_tag_stripped(tag)) {
            mdy_warn(doc, lines, i, "sanitize",
                     "`<%s>` is not allowed, dropping it and its content", tag);
            return child_lines(lines, count, i, l->indent);
        }
        if (!mdy_tag_allowed(tag)) {
            mdy_warn(doc, lines, i, "sanitize",
                     "`<%s>` is not allowed, using `<div>` instead", tag);
            build = "div";
            tag_len = 3;
        }
    }

    mdy_node *el = mdy_new_element(doc, build, tag_len);
    const char *content = NULL;
    size_t content_len = 0;
    parse_attributes(doc, el, schema_tag, lines, i, l->text + n, l->len - n,
                     &content, &content_len);

    size_t end = child_lines(lines, count, i, l->indent);

    /*
     * A VOID element holds nothing, so anything written under it is not its
     * content — the lines stay where they are and the block loop makes of
     * them whatever it would have anyway (a <div>, when they are indented).
     */
    if (mdy_is_void_element(build)) {
        if (content) trim(&content, &content_len);
        if ((content && content_len) || end > i + 1)
            mdy_warn(doc, lines, i, "void-element",
                     "`<%s>` cannot have content, ignoring it", build);
        mdy_set_position(el, lines, i, i);
        separate(doc, parent);
        mdy_append(parent, el);
        return i + 1;
    }

    if (is_raw_text(build))
        return emit_raw_text_element(doc, parent, el, lines, i, end, l->indent, content, content_len);

    if (content) {
        /*
         * `<tag>text` — the rest of the line is INLINE content: no paragraph
         * wrapper and no separator before it. It may still have indented
         * children after it, and then both appear:
         *
         *     <th>Country      ->  th("Country" "\n" p("(present day)") "\n")
         *       (present day)
         *
         * Returning early here, as this did first, silently dropped every
         * such child — a whole column of a table, in the document that found
         * it.
         */
        trim(&content, &content_len);
        mdy_parse_inline(doc, el, content, content_len);
    }
    mdy_set_position(el, lines, i, end > i + 1 ? end - 1 : i);
    if (end > i + 1) {
        /*
         * The children's own column, so one of them being deeper than the
         * others is what makes a div rather than all of them.
         *
         * Seeded from the first NON-BLANK child. A blank line has an indent
         * of zero, and starting from it made every element with a blank line
         * under it wrap its content in a spurious <div>.
         */
        size_t inner = 0;
        int seen = 0;
        for (size_t k = i + 1; k < end; k++) {
            if (lines[k].blank) continue;
            if (!seen || lines[k].indent < inner) { inner = lines[k].indent; seen = 1; }
        }
        mdy_parse_block(doc, el, lines + i + 1, end - (i + 1), inner, nesting + 1);
    }
    separate(doc, parent);
    mdy_append(parent, el);
    return end;
}

/* ---- pipe tables ---------------------------------------------------------- */

/*
 * GitHub-flavoured tables: a header row of `|`-separated cells, a delimiter
 * row of the same width, then body rows.
 *
 * Alignment is expressed as a `style` attribute (`text-align: center`) rather
 * than the legacy `align` one — that is mdy-docs' `tableAlign: 'style'`
 * default, and the two are not interchangeable downstream.
 */
enum { ALIGN_NONE = 0, ALIGN_LEFT, ALIGN_CENTER, ALIGN_RIGHT };

/*
 * One row's cells, HOWEVER MANY THERE ARE. node has no column limit, so a
 * fixed array here is a table's columns silently leaving the document.
 *
 * A row cannot hold more cells than it has bytes, so one allocation sized
 * from the line always fits; an ordinary table never leaves the stack.
 */
enum { CELLS_INLINE = 64 };

typedef struct {
    const char **starts;
    size_t *lens;
    int *align;
    size_t cap;
    const char *s_stack[CELLS_INLINE];
    size_t l_stack[CELLS_INLINE];
    int a_stack[CELLS_INLINE];
} Cells;

static void cells_init(Cells *c, const mdy_line *l) {
    c->starts = c->s_stack; c->lens = c->l_stack; c->align = c->a_stack;
    c->cap = CELLS_INLINE;
    size_t want = l->len + 2;
    if (want <= CELLS_INLINE) return;
    const char **st = malloc(want * sizeof *st);
    size_t *ln = malloc(want * sizeof *ln);
    int *al = malloc(want * sizeof *al);
    /* A wide table needs this buffer: the 64-slot stack cannot hold its
     * columns, and falling back to it is exactly the silent column loss this
     * whole struct exists to prevent. An exhausted allocator ends the run, as
     * everywhere else in the parser. */
    if (!st || !ln || !al) { free(st); free(ln); free(al); mdy_oom_exit(); }
    c->starts = st; c->lens = ln; c->align = al; c->cap = want;
}

static void cells_free(Cells *c) {
    if (c->starts != c->s_stack) { free(c->starts); free(c->lens); free(c->align); }
}

/** Split a row on `|`, ignoring escaped pipes and the optional outer ones.
 * Returns how many cells, writing their bounds into `starts`/`lens`. */
static size_t split_cells(const mdy_line *l, const char **starts, size_t *lens, size_t max) {
    const char *text = l->text;
    size_t len = l->len;
    /* Leading and trailing pipes are decoration. */
    size_t from = 0, to = len;
    while (from < to && (text[from] == ' ' || text[from] == '\t')) from++;
    if (from < to && text[from] == '|') from++;
    while (to > from && (text[to - 1] == ' ' || text[to - 1] == '\t')) to--;
    if (to > from && text[to - 1] == '|') to--;

    size_t count = 0, start = from;
    for (size_t i = from; i <= to && count < max; i++) {
        if (i < to && (text[i] != '|' || (i > from && text[i - 1] == '\\'))) continue;
        const char *cell = text + start;
        size_t cell_len = i - start;
        trim(&cell, &cell_len);
        starts[count] = cell;
        lens[count] = cell_len;
        count++;
        start = i + 1;
        if (i == to) break;
    }
    return count;
}

/** Is this a delimiter row, and what alignment does each cell ask for? */
static int delimiter_row(const mdy_line *l, int *align, size_t want) {
    Cells cells;
    cells_init(&cells, l);
    size_t n = split_cells(l, cells.starts, cells.lens, cells.cap);
    int ok = (n == want && n != 0);

    for (size_t c = 0; ok && c < n; c++) {
        const char *s = cells.starts[c];
        size_t len = cells.lens[c];
        if (len == 0) { ok = 0; break; }
        int left = s[0] == ':';
        int right = s[len - 1] == ':';
        size_t from = left ? 1 : 0, to = right ? len - 1 : len;
        if (to <= from) { ok = 0; break; }
        for (size_t k = from; k < to; k++) if (s[k] != '-') { ok = 0; break; }
        if (!ok) break;
        align[c] = left && right ? ALIGN_CENTER : left ? ALIGN_LEFT : right ? ALIGN_RIGHT : ALIGN_NONE;
    }
    cells_free(&cells);
    return ok;
}

/** How many lines the table at `i` occupies, or 0 if this is not one. */
static size_t table_rows(const mdy_line *lines, size_t count, size_t i, size_t base) {
    Cells cells;
    cells_init(&cells, &lines[i]);
    size_t want = split_cells(&lines[i], cells.starts, cells.lens, cells.cap);
    int usable = want >= 1 && delimiter_row(&lines[i + 1], cells.align, want);
    cells_free(&cells);
    if (!usable) return 0;

    /*
     * The body runs until something else starts. A line WITHOUT a pipe is
     * still a row — it is a short one, padded out to the header's width —
     * so what ends the table is a blank line, a line indented past this
     * block, an element opener, a heading or a thematic break, and nothing
     * else.
     */
    size_t j = i + 2;
    while (j < count) {
        const mdy_line *r = &lines[j];
        if (r->blank || r->indent >= base + 2) break;
        if (r->text[0] == '<' || r->text[0] == '=') break;
        if (thematic_break(r)) break;
        j++;
    }
    return j - i;
}

/*
 * `\|` becomes `|` now that splitting is done, and every other escape is left
 * to the inline parser. It has to happen HERE rather than there: a code span
 * is raw, so the inline parser would never look inside one, and
 * `| ``a \| b`` |` is a cell holding `a | b`.
 */
static void unescape_pipes(mdy_doc *doc, const char **text, size_t *len) {
    if (!memchr(*text, '\\', *len)) return;
    char *out = mdy_alloc(&doc->arena, *len + 1);
    if (!out) return;
    size_t o = 0;
    for (size_t k = 0; k < *len; k++) {
        if ((*text)[k] == '\\' && k + 1 < *len && (*text)[k + 1] == '|') continue;
        out[o++] = (*text)[k];
    }
    out[o] = '\0';
    *text = out;
    *len = o;
}

/*
 * A CAPTION at `i`: one cell, opening with a pipe, directly above a line that
 * starts a table of its own.
 *
 * That last condition is the whole of it. A caption is written exactly the way
 * a one-column table's header is, and what tells them apart is what comes
 * next: a header has a delimiter row under it, a caption has a table.
 */
static int caption_at(const mdy_line *lines, size_t count, size_t i) {
    if (lines[i].len == 0 || lines[i].text[0] != '|') return 0;
    if (i + 2 >= count) return 0;

    Cells row;
    cells_init(&row, &lines[i]);
    size_t n = split_cells(&lines[i], row.starts, row.lens, row.cap);
    int one_cell = (n == 1 && row.lens[0] != 0);
    cells_free(&row);
    if (!one_cell) return 0;

    Cells head;
    cells_init(&head, &lines[i + 1]);
    size_t header = split_cells(&lines[i + 1], head.starts, head.lens, head.cap);
    int ok = header != 0 && memchr(lines[i + 1].text, '|', lines[i + 1].len) != NULL &&
             delimiter_row(&lines[i + 2], head.align, header);
    cells_free(&head);
    return ok;
}

static void add_cell(mdy_doc *doc, mdy_node *row, const char *tag, size_t tag_len,
                     const char *text, size_t len, int align,
                     const mdy_line *lines, size_t row_line) {
    mdy_node *cell = mdy_new_element(doc, tag, tag_len);
    if (align != ALIGN_NONE) {
        const char *style = align == ALIGN_LEFT ? "text-align: left"
                          : align == ALIGN_RIGHT ? "text-align: right"
                          : "text-align: center";
        mdy_set_string(doc, cell, "style", style, strlen(style));
    }
    unescape_pipes(doc, &text, &len);
    mdy_parse_inline(doc, cell, text, len);
    mdy_set_position(cell, lines, row_line, row_line);
    mdy_append(row, mdy_new_text(doc, "\n", 1));
    mdy_append(row, cell);
}

static size_t parse_table(mdy_doc *doc, mdy_node *parent, const mdy_line *lines,
                          size_t start, size_t i, size_t rows) {
    /*
     * One buffer for the whole table: the header row is the widest thing in
     * it, a body row is padded out to that width, and the caption's split
     * borrows it too. Wide enough for the header is wide enough for all of
     * them.
     */
    Cells cells;
    cells_init(&cells, &lines[i]);
    const char **starts = cells.starts;
    size_t *lens = cells.lens;
    int *align = cells.align;
    for (size_t c = 0; c < cells.cap; c++) align[c] = ALIGN_NONE;
    size_t columns = split_cells(&lines[i], starts, lens, cells.cap);
    delimiter_row(&lines[i + 1], align, columns);

    mdy_node *table = mdy_new_element(doc, "table", 5);
    mdy_append(table, mdy_new_text(doc, "\n", 1));

    /*
     * A <caption> is the table's FIRST child wherever it is meant to show:
     * which side it renders on is `caption-side` in CSS, not a fact about the
     * document.
     */
    if (start < i) {
        const char *ctext;
        size_t clen;
        split_cells(&lines[start], starts, lens, cells.cap);
        ctext = starts[0];
        clen = lens[0];
        unescape_pipes(doc, &ctext, &clen);
        mdy_node *cap = mdy_new_element(doc, "caption", 7);
        mdy_parse_inline(doc, cap, ctext, clen);
        mdy_set_position(cap, lines, start, start);
        mdy_append(table, cap);
        mdy_append(table, mdy_new_text(doc, "\n", 1));
        /* The caption's split reused `starts`/`lens`; the header's cells are
         * read from them below and have to be put back. */
        columns = split_cells(&lines[i], starts, lens, cells.cap);
    }

    mdy_node *thead = mdy_new_element(doc, "thead", 5);
    mdy_append(thead, mdy_new_text(doc, "\n", 1));
    mdy_node *head_row = mdy_new_element(doc, "tr", 2);
    for (size_t c = 0; c < columns; c++) add_cell(doc, head_row, "th", 2, starts[c], lens[c], align[c], lines, i);
    mdy_append(head_row, mdy_new_text(doc, "\n", 1));
    mdy_set_position(head_row, lines, i, i);
    mdy_append(thead, head_row);
    mdy_append(thead, mdy_new_text(doc, "\n", 1));
    mdy_set_position(thead, lines, i, i);
    mdy_append(table, thead);
    mdy_append(table, mdy_new_text(doc, "\n", 1));

    if (rows > 2) {
        mdy_node *tbody = mdy_new_element(doc, "tbody", 5);
        mdy_append(tbody, mdy_new_text(doc, "\n", 1));
        for (size_t r = i + 2; r < i + rows; r++) {
            size_t n = split_cells(&lines[r], starts, lens, cells.cap);
            mdy_node *tr = mdy_new_element(doc, "tr", 2);
            /* Every row is the header's width: a short one is PADDED with
             * empty cells and a long one loses the extra. A row that is
             * still a row, however short, keeps the table rectangular. */
            for (size_t c = 0; c < columns; c++)
                add_cell(doc, tr, "td", 2, c < n ? starts[c] : NULL, c < n ? lens[c] : 0,
                         align[c], lines, r);
            mdy_append(tr, mdy_new_text(doc, "\n", 1));
            mdy_set_position(tr, lines, r, r);
            mdy_append(tbody, tr);
            mdy_append(tbody, mdy_new_text(doc, "\n", 1));
        }
        mdy_set_position(tbody, lines, i + 2, i + rows - 1);
        mdy_append(table, tbody);
        mdy_append(table, mdy_new_text(doc, "\n", 1));
    }

    /* The table's span opens at the CAPTION when there is one. */
    mdy_set_position(table, lines, start, i + rows - 1);
    separate(doc, parent);
    mdy_append(parent, table);
    cells_free(&cells);
    return i + rows;
}

/* ---- the block loop ------------------------------------------------------ */

/* Returns whether anything was added — an all-whitespace run produces no
 * paragraph, and must not produce a separator either. */
static int add_paragraph(mdy_doc *doc, mdy_node *parent, const char *joined, size_t len) {
    mdy_trim_end(&joined, &len);
    if (!len) return 0;
    mdy_node *p = mdy_new_element(doc, "p", 1);
    mdy_parse_inline(doc, p, joined, len);
    mdy_append(parent, p);
    return 1;
}

/*
 * A LIST, as block.js's tryList reads one: the run of lines from its first
 * marker to whatever ends it, then a tree built from the markers' columns.
 *
 * What ends the run is a heading line, a thematic break, or a blank line
 * followed by anything that is not an item. Every other line belongs to the
 * item before it, at any indentation: `- one` then `two` is one item reading
 * "one two", and so is `- one` then `  <b>two`, because an item holds text
 * and nested lists and nothing else. A blank line before an item makes the
 * whole run loose — every item of every list in it wraps its text in a <p>.
 *
 * Items nest by their markers' columns: deeper opens a list inside the item
 * above, shallower closes back out to the list at that column, and a bullet
 * beside a number at the same column is a sibling list rather than a mixed
 * one. A list measures nothing against the run it sits in, which is what
 * lets an unindented continuation line still belong to an item.
 *
 * `i` is the line the first marker is on. Returns the first line AFTER the
 * run.
 */
typedef struct {
    size_t line, end;       /* the marker line, and the last line of its text */
    size_t indent;          /* the marker's column */
    int ordered;
    long start;             /* the number an ordered marker carries */
    int task;               /* -1 no box, 0 unticked, 1 ticked */
    size_t column;          /* of the character between the box's brackets, 1-based */
    const char *head;       /* the marker line's text after the marker and the box */
    size_t head_len;
} Item;

typedef struct ListNode ListNode;
typedef struct {
    const Item *item;
    ListNode **children;
    size_t child_count, child_cap;
} Entry;
struct ListNode {
    size_t indent;
    int ordered;
    long start;
    Entry *entries;
    size_t count, cap;
};

static void *grow_in_arena(mdy_doc *doc, void *old, size_t count, size_t *cap, size_t size) {
    size_t want = *cap ? *cap * 2 : 4;
    void *grown = mdy_alloc(&doc->arena, want * size);
    if (count) memcpy(grown, old, count * size);
    *cap = want;
    return grown;
}

static Entry *list_node_add(mdy_doc *doc, ListNode *l, const Item *item) {
    if (l->count == l->cap) l->entries = grow_in_arena(doc, l->entries, l->count, &l->cap, sizeof *l->entries);
    Entry *e = &l->entries[l->count++];
    memset(e, 0, sizeof *e);
    e->item = item;
    return e;
}

static void entry_add_child(mdy_doc *doc, Entry *e, ListNode *child) {
    if (e->child_count == e->child_cap)
        e->children = grow_in_arena(doc, e->children, e->child_count, &e->child_cap, sizeof *e->children);
    e->children[e->child_count++] = child;
}

/* The last line an entry covers, nested lists included. */
static size_t entry_end(const Entry *e) {
    size_t end = e->item->end;
    for (size_t c = 0; c < e->child_count; c++) {
        const ListNode *child = e->children[c];
        size_t nested = entry_end(&child->entries[child->count - 1]);
        if (nested > end) end = nested;
    }
    return end;
}

/* An item's text: the marker line's, then each continuation line's with its
 * trailing whitespace off, joined with a space — which puts a leading space
 * on an item whose marker line held nothing, as the JavaScript's join does. */
static char *item_text(mdy_doc *doc, const Item *it, const mdy_line *lines, size_t *out_len) {
    size_t total = it->head_len;
    for (size_t k = it->line + 1; k <= it->end; k++) total += lines[k].len + 1;
    char *joined = mdy_alloc(&doc->arena, total + 1);
    memcpy(joined, it->head, it->head_len);
    size_t o = it->head_len;
    for (size_t k = it->line + 1; k <= it->end; k++) {
        const char *t = lines[k].text;
        size_t n = lines[k].len;
        mdy_trim_end(&t, &n);
        joined[o++] = ' ';
        memcpy(joined + o, t, n);
        o += n;
    }
    joined[o] = '\0';
    *out_len = o;
    return joined;
}

/* `listNode`: one <ul> or <ol>, its items, and the lists nested in them. */
static mdy_node *list_element(mdy_doc *doc, const ListNode *l, int loose, const mdy_line *lines) {
    mdy_node *list = mdy_new_element(doc, l->ordered ? "ol" : "ul", 2);
    mdy_append(list, mdy_new_text(doc, "\n", 1));
    int any_task = 0;
    for (size_t k = 0; k < l->count; k++) {
        const Entry *e = &l->entries[k];
        const Item *it = e->item;
        mdy_node *li = mdy_new_element(doc, "li", 2);
        if (it->task >= 0) { any_task = 1; mdy_add_class(doc, li, "task-list-item"); }
        size_t tlen = 0;
        char *text = item_text(doc, it, lines, &tlen);
        if (loose) {
            /* `li("\n" p(content) "\n")` — the shape a blank line between
             * items produces. The paragraph spans the item's own lines. */
            mdy_node *wrap = mdy_new_element(doc, "p", 1);
            mdy_parse_inline(doc, wrap, text, tlen);
            add_task_box(doc, wrap, it->task, tlen, lines, it->line, it->column);
            mdy_set_position(wrap, lines, it->line, it->end);
            mdy_append(li, mdy_new_text(doc, "\n", 1));
            mdy_append(li, wrap);
            mdy_append(li, mdy_new_text(doc, "\n", 1));
        } else {
            mdy_parse_inline(doc, li, text, tlen);
            add_task_box(doc, li, it->task, tlen, lines, it->line, it->column);
        }
        for (size_t c = 0; c < e->child_count; c++) {
            if (!loose) mdy_append(li, mdy_new_text(doc, "\n", 1));
            mdy_append(li, list_element(doc, e->children[c], loose, lines));
            mdy_append(li, mdy_new_text(doc, "\n", 1));
        }
        mdy_set_position(li, lines, it->line, entry_end(e));
        mdy_append(list, li);
        mdy_append(list, mdy_new_text(doc, "\n", 1));
    }
    /* Set after the items, as the JavaScript's properties are: className
     * before start. A list counts from 1 on its own. */
    if (any_task) mdy_add_class(doc, list, "contains-task-list");
    if (l->ordered && l->start != 1) mdy_set_number(doc, list, "start", (double)l->start);
    mdy_set_position(list, lines, l->entries[0].item->line, entry_end(&l->entries[l->count - 1]));
    return list;
}

static size_t parse_list(mdy_doc *doc, mdy_node *parent, const mdy_line *lines,
                         size_t count, size_t i, size_t nesting) {
    Item *items = NULL;
    size_t n = 0, cap = 0;
    size_t index = i, last = i;
    int loose = 0, blank = 0;

    while (index < count) {
        const mdy_line *l = &lines[index];
        if (l->blank) { blank = 1; index++; continue; }
        if (l->text[0] == '=' || thematic_break(l)) break;

        int ordered = 0;
        size_t width = list_marker(l, &ordered);
        if (width) {
            if (blank) loose = 1;
            if (n == cap) items = grow_in_arena(doc, items, n, &cap, sizeof *items);
            Item *it = &items[n++];
            memset(it, 0, sizeof *it);
            it->line = it->end = index;
            it->indent = l->indent;
            it->ordered = ordered;
            it->start = ordered ? marker_number(l) : -1;
            it->task = -1;
            const char *rest = l->text + width;
            size_t rl = l->len - width;
            trim(&rest, &rl);
            /*
             * `[ ]` or `[x]` after the marker makes it a task —
             * `^\[([ xX])\](?:[ \t]+(.*))?$`, so the box has to be followed
             * by whitespace or by nothing at all. `- [x]done` is an ordinary
             * item reading `[x]done`. The column is the character between
             * the brackets, 1-based and counted from the start of the line,
             * indentation and all — what a handler needs to find the `x`.
             */
            if (rl >= 3 && rest[0] == '[' && rest[2] == ']' &&
                (rest[1] == ' ' || rest[1] == 'x' || rest[1] == 'X') &&
                (rl == 3 || rest[3] == ' ' || rest[3] == '\t')) {
                it->task = rest[1] != ' ';
                it->column = l->indent_chars + (size_t)(rest - l->text) + 2;
                rest += 3;
                rl -= 3;
                trim(&rest, &rl);
            }
            it->head = rest;
            it->head_len = rl;
        } else {
            if (blank) break;
            items[n - 1].end = index;
        }
        blank = 0;
        last = index;
        index++;
    }

    /*
     * The tree, by column. Each level is a <ul> and an <li> under the tree
     * `parent` already sits in, so the levels that fit are counted against
     * MDY_MAX_DEPTH; an item that would open one deeper joins the innermost
     * list instead, and says so.
     */
    ListNode **roots = NULL;
    size_t root_count = 0, root_cap = 0;
    ListNode *stack[MDY_MAX_DEPTH / 2 + 1];
    size_t top = 0;
    size_t levels = nesting + 1 < MDY_MAX_DEPTH ? (MDY_MAX_DEPTH - nesting - 1) / 2 : 0;
    if (levels == 0) levels = 1;
    int flattened = 0;
    for (size_t k = 0; k < n; k++) {
        const Item *it = &items[k];
        while (top && it->indent < stack[top - 1]->indent) top--;
        if (top && it->indent == stack[top - 1]->indent && it->ordered != stack[top - 1]->ordered) top--;
        if (!top || it->indent > stack[top - 1]->indent) {
            if (top >= levels) {
                flattened = 1;
            } else {
                ListNode *l = mdy_alloc(&doc->arena, sizeof *l);
                memset(l, 0, sizeof *l);
                l->indent = it->indent;
                l->ordered = it->ordered;
                l->start = it->start;
                if (top) {
                    ListNode *above = stack[top - 1];
                    entry_add_child(doc, &above->entries[above->count - 1], l);
                } else {
                    if (root_count == root_cap)
                        roots = grow_in_arena(doc, roots, root_count, &root_cap, sizeof *roots);
                    roots[root_count++] = l;
                }
                stack[top++] = l;
            }
        }
        list_node_add(doc, stack[top - 1], it);
    }
    if (flattened)
        mdy_warn(doc, lines, i, "nesting-depth",
                 "nesting deeper than %d levels is read flat", MDY_MAX_DEPTH);

    for (size_t r = 0; r < root_count; r++) {
        separate(doc, parent);
        mdy_append(parent, list_element(doc, roots[r], loose, lines));
    }
    return last + 1;
}

/*
 * A PARAGRAPH -- adjacent non-blank lines joined with a space -- and the
 * setext heading that a line underneath can turn it into.
 *
 * The two are one function because they are one decision made twice over the
 * same text: the lines are gathered and joined first, and only then does what
 * comes AFTER them say whether the result is a <p> or an <h1>. Splitting them
 * would mean gathering twice, or handing the join across a boundary.
 *
 * Most of it is the gathering, and all of that is one question: what ENDS a
 * paragraph. A deeper indent, a fence, a table with its delimiter under it, a
 * heading, an element opener, a list marker, a thematic break -- each of those
 * is a block that begins rather than a sentence that continues.
 *
 * Returns the first line after what it produced (j + 1 for a setext heading,
 * because the underline is consumed too), and sets *produced when it made
 * anything. That flag is the caller\'s and is sticky -- it only goes up, and
 * what it decides is whether a trailing separator is written.
 */
static size_t parse_paragraph(mdy_doc *doc, mdy_node *parent, const mdy_line *lines,
                              size_t count, size_t i, size_t base, int *produced) {
    size_t j = i;
    size_t total = 0;
    while (j < count && !lines[j].blank) {
        int ordered_here = 0;
        /* A line that starts another block ends this paragraph — and a
         * line further in than this run is another block, which is what
         * makes `top` / `  in` a paragraph and a div rather than one
         * paragraph reading "top in". */
        if (j > i && lines[j].indent > base) break;
        char fence_here = 0;
        const char *fl = NULL;
        size_t fll = 0;
        if (j > i && fence_opener(&lines[j], &fence_here, &fl, &fll)) break;
        /*
         * …and so does a table: a header row and its delimiter under a
         * line of prose start the table, they do not join the sentence.
         * A CAPTION line does too, which is what makes `| One` a
         * paragraph and `| Two` the caption of the table beneath it.
         */
        if (j > i && memchr(lines[j].text, '|', lines[j].len) && j + 1 < count) {
            size_t h = caption_at(lines, count, j) ? j + 1 : j;
            if (h + 1 < count && table_rows(lines, count, h, base)) break;
        }
        if (j > i && (lines[j].text[0] == '=' || lines[j].text[0] == '<' ||
                      list_marker(&lines[j], &ordered_here) ||
                      thematic_break(&lines[j]))) break;
        {
            const char *did, *dcontent;
            size_t did_len, dcontent_len;
            if (j > i && definition_line(&lines[j], &did, &did_len, &dcontent, &dcontent_len)) break;
        }
        total += lines[j].len + 1;
        j++;
    }
    char *joined = mdy_alloc(&doc->arena, total + 1);
    size_t o = 0;
    for (size_t k = i; k < j; k++) {
        /*
         * TRAILING whitespace only. A line's leading spaces are its
         * indentation and were removed when the lines were measured; a
         * leading NO-BREAK space is not indentation and belongs to the
         * text, which is what `\u00a0\u00a0Kingdom of …` in the corpus
         * depends on.
         */
        const char *lt = lines[k].text;
        size_t ll = lines[k].len;
        mdy_trim_end(&lt, &ll);
        if (k > i && o) joined[o++] = ' ';
        memcpy(joined + o, lt, ll);
        o += ll;
    }
    joined[o] = '\0';
    /* A run of only whitespace produces no paragraph, and so must produce
     * no separator either — which is why the emptiness is decided here
     * rather than inside add_paragraph. */
    /*
     * Setext: a line of `=` under a paragraph makes it an <h1>, and FOUR
     * or more `-` make it an <h2>. Three hyphens do not — that is a
     * thematic break, and the paragraph above it stands on its own.
     */
    const mdy_line *under = j < count ? &lines[j] : NULL;
    int setext = 0;
    if (under && !under->blank && under->indent == base) {
        /* `^(?:(=+)|(-{4,}))[ \t]*$` — trailing whitespace is
         * decoration on either form. */
        if (underline_of(under, '=', 1)) setext = 1;
        else if (underline_of(under, '-', 4)) setext = 2;
    }

    const char *probe = joined;
    size_t probe_len = o;
    mdy_trim_end(&probe, &probe_len);

    if (setext && probe_len) {
        char tag[3] = { 'h', (char)('0' + setext), '\0' };
        mdy_node *h = mdy_new_element(doc, tag, 2);
        mdy_parse_inline(doc, h, probe, probe_len);
        {
            /* ALL of the heading's text, as the `=` path does below: a fixed
             * buffer gave a long setext heading an id that stopped mid-word. */
            char stack_text[1024];
            size_t need = node_text_len(h) + 1;
            size_t text_cap = need > sizeof stack_text ? need : sizeof stack_text;
            char *rendered = text_cap > sizeof stack_text ? malloc(text_cap) : stack_text;
            if (rendered) {
                size_t rlen = node_text(h, rendered, text_cap, 0);
                set_heading_id(doc, h, rendered, rlen);
                if (rendered != stack_text) free(rendered);
            }
        }
        mdy_set_position(h, lines, i, j);
        separate(doc, parent);
        mdy_append(parent, h);
        *produced = 1;
        return j + 1;
    }

    if (probe_len) {
        separate(doc, parent);
        mdy_node *before = parent->last;
        if (add_paragraph(doc, parent, joined, o)) {
            mdy_node *made = before ? before->next : parent->first;
            mdy_set_position(made, lines, i, j > i ? j - 1 : i);
        }
        *produced = 1;
    }
    return j;
}

/*
 * Indentation as structure: a run of lines indented past `base` is a block of
 * its own, wrapped in nested <div>s at two columns per level. Returns the index
 * past the run when it produced them, or `i` unchanged when the nesting depth
 * was exhausted and the line must be read where it stands. Lifted out of
 * mdy_parse_block, which it recurses back into for the run's own content.
 */
static size_t parse_indented_div(mdy_doc *doc, mdy_node *parent, const mdy_line *lines,
                                 size_t count, size_t i, size_t base, size_t nesting,
                                 int *produced) {
    size_t j = i;
    while (j < count && (lines[j].blank || lines[j].indent > base)) j++;
    while (j > i && lines[j - 1].blank) j--;

    size_t inner = lines[i].indent;
    for (size_t k = i; k < j; k++)
        if (!lines[k].blank && lines[k].indent < inner) inner = lines[k].indent;

    /*
     * EVERY TWO COLUMNS IS ONE LEVEL. The grammar says so in as many words,
     * and it means an indent of eight is FOUR nested <div>s rather than one
     * deep-indented one. Making a single div for any depth looks right in a
     * two-space document and is wrong in every other: the corpus has
     * eight-column indents that come out four levels deep.
     */
    size_t levels = (inner - base) / 2;
    if (levels == 0) levels = 1;
    /*
     * One line of four hundred thousand spaces is two hundred thousand levels,
     * and this is the only construct that nests without the source growing with
     * it — everything else costs an indentation step per level, which is
     * quadratic. So it is the one that has to be held, and it is held against
     * the depth ALREADY under `parent`: two chains one inside the other would
     * each pass a check of their own and together be twice as deep.
     */
    size_t room = nesting < MDY_MAX_DEPTH ? MDY_MAX_DEPTH - nesting : 0;
    if (levels > room) levels = room;
    /*
     * Nothing left to nest into. The caller reads the line where it stands,
     * its indentation meaning nothing — said once, here, because this is where
     * something is actually lost: a clamp with room still left keeps nesting
     * and comes back round to this same test one level down.
     */
    if (levels == 0) {
        mdy_warn(doc, lines, i, "nesting-depth",
                 "nesting deeper than %d levels is read flat", MDY_MAX_DEPTH);
        return i;
    }

    mdy_node *outer = NULL, *innermost = NULL;
    for (size_t d = 0; d < levels; d++) {
        mdy_node *div = mdy_new_element(doc, "div", 3);
        mdy_set_position(div, lines, i, j > i ? j - 1 : i);
        if (innermost) {
            mdy_append(innermost, mdy_new_text(doc, "\n", 1));
            mdy_append(innermost, div);
            mdy_append(innermost, mdy_new_text(doc, "\n", 1));
        } else {
            outer = div;
        }
        innermost = div;
    }
    mdy_parse_block(doc, innermost, lines + i, j - i, base + levels * 2, nesting + levels);

    separate(doc, parent);
    mdy_append(parent, outer);
    *produced = 1;
    return j;
}

void mdy_parse_block(mdy_doc *doc, mdy_node *parent, const mdy_line *lines, size_t count,
                     size_t base, size_t nesting) {
    size_t i = 0;
    int produced = 0;

    while (i < count) {
        const mdy_line *l = &lines[i];

        if (l->blank) { i++; continue; }

        /*
         * Indentation is structural: a line further in than this run's own
         * column is a block of its own, in a <div> (parse_indented_div). It
         * applies at the very start of a document too. An element opener takes
         * its own indented lines as children instead, and a list item absorbs
         * its continuation lines, so by the time this fires the indentation
         * belongs to nothing else.
         */
        if (l->indent > base) {
            size_t next = parse_indented_div(doc, parent, lines, count, i, base, nesting, &produced);
            if (next != i) { i = next; continue; }
            /* depth exhausted: fall through and read the line where it stands */
        }

        /* --- thematic break: three or more of - * _ alone --- */
        if (thematic_break(l)) {
            separate(doc, parent);
            mdy_node *rule = mdy_new_element(doc, "hr", 2);
            mdy_set_position(rule, lines, i, i);
            mdy_append(parent, rule);
            produced = 1;
            i++;
            continue;
        }

        /* --- heading: one `=` per level, trailing `=` are decoration --- */
        if (l->text[0] == '=') {
            size_t depth = run_of(l, '=');
            size_t max = doc->options.max_heading ? (size_t)doc->options.max_heading : 6;
            /* The level becomes a single tag digit (`h1`..`h9`), so it must
             * stay in 1..9 whatever the option says — a max_heading of 0 falls
             * to the default above, a negative one casts to a huge size_t, and
             * either could otherwise make `'0' + depth` a non-digit tag. */
            if (max < 1) max = 1;
            if (max > 9) max = 9;
            const char *body = l->text + depth;
            size_t body_len = l->len - depth;
            /* Trailing decoration, e.g. `== Title ==`. */
            while (body_len && body[body_len - 1] == '=') body_len--;
            trim(&body, &body_len);

            if (depth > max) {
                mdy_warn(doc, lines, i, "heading-depth",
                         "Heading level %zu is deeper than h%zu, clamping", depth, max);
                depth = max;
            }
            char tag[3] = { 'h', (char)('0' + (int)depth), '\0' };
            mdy_node *h = mdy_new_element(doc, tag, 2);
            mdy_parse_inline(doc, h, body, body_len);
            /*
             * From the RENDERED text, not the source: `= Producing a //Book of
             * the Dead//` is `producing-a-book-of-the-dead`, because the
             * markers are gone by the time anyone reads the heading. Slugging
             * the source leaves the slashes in an id nothing can link to.
             */
            {
                /* ALL of the heading's text, not the first kilobyte: the
                 * slug comes from this, and a fixed buffer gives a long
                 * heading an id that stops mid-word. */
                char stack_text[1024];
                size_t need = node_text_len(h) + 1;
                size_t text_cap = need > sizeof stack_text ? need : sizeof stack_text;
                char *rendered = text_cap > sizeof stack_text ? malloc(text_cap) : stack_text;
                if (rendered) {
                    size_t rlen = node_text(h, rendered, text_cap, 0);
                    set_heading_id(doc, h, rendered, rlen);
                    if (rendered != stack_text) free(rendered);
                }
            }
            mdy_set_position(h, lines, i, i);
            separate(doc, parent);
            mdy_append(parent, h);
            produced = 1;
            i++;
            continue;
        }

        /* --- fenced code: three or more backticks or tildes --- */
        {
            char fence = 0;
            const char *lang = NULL;
            size_t lang_len = 0;
            size_t width = fence_opener(l, &fence, &lang, &lang_len);
            if (width) {
                size_t j = i + 1;
                size_t start = j;
                while (j < count && !closes_fence(&lines[j], fence, width)) j++;

                /* The content, verbatim, with its own newlines and the
                 * original indentation relative to the fence. */
                size_t total = 0;
                for (size_t k = start; k < j; k++) total += lines[k].indent + lines[k].len + 1;
                char *body = mdy_alloc(&doc->arena, total + 1);
                size_t o = 0;
                for (size_t k = start; k < j; k++) {
                    size_t strip = lines[k].indent > l->indent ? l->indent : lines[k].indent;
                    for (size_t s = strip; s < lines[k].indent; s++) body[o++] = ' ';
                    memcpy(body + o, lines[k].text, lines[k].len);
                    o += lines[k].len;
                    body[o++] = '\n';
                }
                body[o] = '\0';

                mdy_node *pre = mdy_new_element(doc, "pre", 3);
                mdy_node *code = mdy_new_element(doc, "code", 4);
                if (lang_len) {
                    char cls[64];
                    size_t n = lang_len < sizeof cls - 10 ? lang_len : sizeof cls - 10;
                    memcpy(cls, "language-", 9);
                    memcpy(cls + 9, lang, n);
                    cls[9 + n] = '\0';
                    mdy_add_class(doc, code, cls);
                }
                /* The embedder's highlighter, if any, sees every fence — an
                 * empty one too, which mdy-docs also colours (to nothing, but
                 * with the class). Plain text otherwise. */
                int highlighted = doc->options.highlight
                    ? doc->options.highlight(doc->options.highlight_ud, doc, code, body, o, lang, lang_len)
                    : 0;
                if (!highlighted && o) mdy_append(code, mdy_new_text(doc, body, o));
                mdy_append(pre, code);
                /* The fence's whole span, closing line included — and `code`
                 * carries the same one, which is what the JavaScript does. */
                size_t last_line = j < count ? j : (j > 0 ? j - 1 : 0);
                mdy_set_position(pre, lines, i, last_line);
                mdy_set_position(code, lines, i, last_line);
                separate(doc, parent);
                mdy_append(parent, pre);
                produced = 1;
                i = j < count ? j + 1 : j;
                continue;
            }
        }

        /* --- a footnote definition, and the lines that run on from it --- */
        {
            const char *id, *content;
            size_t id_len, content_len;
            if (definition_line(l, &id, &id_len, &content, &content_len)) {
                i = parse_definition(doc, lines, count, i, id, id_len, content, content_len);
                continue;
            }
        }

        /*
         * At the nesting cap, an element or a list is read as flat paragraph
         * text rather than recursed into: parse_element and parse_list both
         * re-enter mdy_parse_block at nesting+1, so without this an element
         * chain or a nested list drives the stack past MDY_MAX_DEPTH — the same
         * bound the indented-<div> path already applies. mdyast.h says a parsed
         * tree never nests deeper than this; this is what makes that true.
         */
        int at_depth_cap = nesting + 2 > MDY_MAX_DEPTH;
        if (at_depth_cap && (l->text[0] == '<' || list_marker(l, &(int){0})))
            mdy_warn(doc, lines, i, "nesting-depth",
                     "nesting deeper than %d levels is read flat", MDY_MAX_DEPTH);

        /* --- an element opener --- */
        if (!at_depth_cap && l->text[0] == '<') {
            i = parse_element(doc, parent, lines, count, i, nesting);
            produced = 1;
            continue;
        }

        /* --- a pipe table --- */
        if (memchr(l->text, '|', l->len) && i + 1 < count) {
            /* A caption above the header pushes the look-ahead one line on. */
            size_t head = caption_at(lines, count, i) ? i + 1 : i;
            if (head + 1 < count) {
                size_t n = table_rows(lines, count, head, base);
                if (n) { i = parse_table(doc, parent, lines, i, head, n); produced = 1; continue; }
            }
        }

        /* --- lists --- */
        if (!at_depth_cap && list_marker(l, &(int){0})) {
            i = parse_list(doc, parent, lines, count, i, nesting);
            produced = 1;
            continue;
        }

        /* --- paragraph, and the setext heading a line underneath makes of it --- */
        i = parse_paragraph(doc, parent, lines, count, i, base, &produced);
    }

    if (produced) separate(doc, parent);
}

/* ---- footnote definitions ------------------------------------------------ */

/*
 * `[[ ^id ]]: text` — footnote.js's definitionLine,
 * `^\[\[[ \t]*\^([^\]|]+?)[ \t]*\]\][ \t]*:[ \t]*(.*)$`, on a line's text
 * after its indentation. The id may hold spaces; it may not hold `]` or `|`.
 */
static int definition_line(const mdy_line *l, const char **id, size_t *id_len,
                           const char **content, size_t *content_len) {
    const char *t = l->text;
    size_t len = l->len;
    if (len < 7 || t[0] != '[' || t[1] != '[') return 0;
    size_t k = 2;
    while (k < len && (t[k] == ' ' || t[k] == '\t')) k++;
    if (k >= len || t[k] != '^') return 0;
    k++;
    size_t id_start = k;
    while (k < len && t[k] != ']' && t[k] != '|') k++;
    if (k + 1 >= len || t[k] != ']' || t[k + 1] != ']') return 0;
    size_t id_end = k;
    while (id_end > id_start && (t[id_end - 1] == ' ' || t[id_end - 1] == '\t')) id_end--;
    if (id_end == id_start) return 0;
    k += 2;
    while (k < len && (t[k] == ' ' || t[k] == '\t')) k++;
    if (k >= len || t[k] != ':') return 0;
    k++;
    while (k < len && (t[k] == ' ' || t[k] == '\t')) k++;
    *id = t + id_start;
    *id_len = id_end - id_start;
    *content = t + k;
    *content_len = len - k;
    return 1;
}

/*
 * The ids that have a definition somewhere in the document — footnote.js's
 * findDefinitions, over every line, fences and list items included. A
 * reference is a reference only when its id is known, and a definition may
 * come after the text that points at it, so this runs before any line is
 * parsed. What each note SAYS is read where the grammar reaches its
 * definition (parse_definition); until then it is known and undefined.
 */
static void find_definitions(mdy_doc *doc, const mdy_line *lines, size_t count) {
    for (size_t i = 0; i < count; i++) {
        const char *id, *content;
        size_t id_len, content_len;
        if (!definition_line(&lines[i], &id, &id_len, &content, &content_len)) continue;
        if (mdy_footnote_find(doc, id, id_len)) continue;

        if (doc->note_count == doc->note_cap) {
            size_t grown = doc->note_cap ? doc->note_cap * 2 : 16;
            mdy_footnote *next = mdy_alloc(&doc->arena, sizeof *next * grown);
            for (size_t n = 0; n < doc->note_count; n++) next[n] = doc->notes[n];
            doc->notes = next;
            doc->note_cap = grown;
        }
        mdy_footnote *note = &doc->notes[doc->note_count++];
        note->id = mdy_intern(&doc->arena, &doc->names, id, id_len);
        /* footnote.js's anchor(): `id.replace(/[^\w-]+/g, '-')`, \w being
         * ASCII letters, digits and `_`. */
        {
            char *safe = mdy_alloc(&doc->arena, id_len + 1);
            size_t o = 0;
            for (size_t k = 0; k < id_len; k++) {
                unsigned char c = (unsigned char)id[k];
                int word = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                           (c >= '0' && c <= '9') || c == '_' || c == '-';
                if (word) safe[o++] = (char)c;
                else if (o == 0 || safe[o - 1] != '-' || (k > 0 && id[k - 1] == '-')) safe[o++] = '-';
            }
            safe[o] = '\0';
            note->safe = safe;
        }
        note->content = NULL;
        note->content_len = 0;
        note->number = 0;
        note->refs = 0;

        /* Keep the id -> index map mdy_footnote_find reads in step, and build
         * it once from notes[] when the list grows past the threshold. */
        if (doc->note_index) {
            mdy_hindex_put(doc, doc->note_index, note->id, 0, doc->note_count - 1);
        } else if (doc->note_count >= MDY_HINDEX_THRESHOLD) {
            mdy_hindex *ix = mdy_alloc(&doc->arena, sizeof *ix);
            memset(ix, 0, sizeof *ix);
            for (size_t ni = 0; ni < doc->note_count; ni++)
                mdy_hindex_put(doc, ix, doc->notes[ni].id, 0, ni);
            doc->note_index = ix;
        }
    }
}

/*
 * A definition where the grammar reaches it, and the lines that run on from
 * it: every following line joins the note, indented or not, until a blank
 * line, another definition, a heading or a thematic break — block.js's
 * defineFootnote. A later definition of the same id replaces an earlier one.
 * Returns the first line after the definition.
 */
static size_t parse_definition(mdy_doc *doc, const mdy_line *lines, size_t count, size_t i,
                               const char *id, size_t id_len,
                               const char *head, size_t head_len) {
    trim(&head, &head_len);
    size_t last = i;
    size_t total = head_len;
    while (last + 1 < count) {
        const mdy_line *next = &lines[last + 1];
        const char *nid, *ncontent;
        size_t nid_len, ncontent_len;
        if (next->blank || definition_line(next, &nid, &nid_len, &ncontent, &ncontent_len) ||
            next->text[0] == '=' || thematic_break(next))
            break;
        last++;
        total += next->len + 1;
    }

    char *joined = mdy_alloc(&doc->arena, total + 1);
    memcpy(joined, head, head_len);
    size_t jo = head_len;
    for (size_t r = i + 1; r <= last; r++) {
        const char *t = lines[r].text;
        size_t n = lines[r].len;
        mdy_trim_end(&t, &n);
        joined[jo++] = ' ';
        memcpy(joined + jo, t, n);
        jo += n;
    }
    const char *content = joined;
    size_t content_len = jo;
    trim(&content, &content_len);

    mdy_footnote *note = mdy_footnote_find(doc, id, id_len);
    if (note) {
        note->content = content;
        note->content_len = content_len;
    }
    return last + 1;
}

/* ---- front matter and documents ------------------------------------------ */

/** A line that is exactly the fence, once trailing whitespace is off —
 * `lines[open].trimEnd() !== settings.fence`. Leading whitespace is not
 * allowed, so an indented `+++` is content. */
static int is_fence(const mdy_line *l, const char *fence, size_t fence_len) {
    if (l->indent != 0 || l->len < fence_len) return 0;
    if (memcmp(l->text, fence, fence_len) != 0) return 0;
    for (size_t k = fence_len; k < l->len; k++)
        if (l->text[k] != ' ' && l->text[k] != '\t') return 0;
    return 1;
}

/*
 * How many lines the leading front matter occupies, or 0 if there is none.
 *
 * The block has to open on the document's first line, GIVE OR TAKE BLANK ONES,
 * and it has to close. An opening fence with no partner is left alone: it is
 * more likely to be prose than a block somebody forgot to finish, and guessing
 * would swallow the rest of the document.
 *
 * The YAML inside is not parsed here — see mdy_frontmatter — but it is
 * recorded, so whoever embeds this can hand it to a reader.
 */
static size_t front_matter_lines(mdy_doc *doc, const mdy_line *lines, size_t count) {
    const char *fence = doc->options.frontmatter_fence;
    if (!fence) fence = "+++";
    size_t fence_len = strlen(fence);

    size_t open = 0;
    while (open < count && lines[open].blank) open++;
    if (open >= count || !is_fence(&lines[open], fence, fence_len)) return 0;

    size_t close = open + 1;
    while (close < count && !is_fence(&lines[close], fence, fence_len)) close++;
    if (close >= count) return 0;

    /* The source between the fences, rejoined with the newlines that were
     * there — the indentation too, because YAML is made of it. */
    size_t total = 0;
    for (size_t k = open + 1; k < close; k++) total += lines[k].indent + lines[k].len + 1;
    char *src = mdy_alloc(&doc->arena, total + 1);
    size_t o = 0;
    if (src) {
        for (size_t k = open + 1; k < close; k++) {
            if (o) src[o++] = '\n';
            for (size_t sp = 0; sp < lines[k].indent; sp++) src[o++] = ' ';
            memcpy(src + o, lines[k].text, lines[k].len);
            o += lines[k].len;
        }
        src[o] = '\0';
    }
    record_matter(doc, src, o, lines[open].number, lines[close].number);
    return close + 1;
}

/*
 * An empty document: an arena and a root, and nothing read yet.
 *
 * Both front ends start here — this one and src/markdown.c — because the tree
 * type is the thing they share and the arena is how it is owned. mdy_free is
 * the only cleanup either of them needs.
 */
/* An empty document, which cannot fail: its arena already ends the process
 * rather than hand back NULL (internal.h), and the struct that holds the
 * arena is the same allocation in every sense that matters. Returning NULL
 * here left each of six callers inventing an answer, and `$.node` picked
 * `undefined` -- a document built without the node it was given. */
mdy_doc *mdy_doc_new(void) {
    mdy_doc *doc = calloc(1, sizeof *doc);
    if (!doc) mdy_oom_exit();
    mdy_options_default(&doc->options);
    doc->root = mdy_alloc(&doc->arena, sizeof *doc->root);
    memset(doc->root, 0, sizeof *doc->root);
    doc->root->type = MDY_ROOT;
    return doc;
}

mdy_doc *mdy_parse(const char *text, size_t len, const mdy_options *options) {
    mdy_doc *doc = calloc(1, sizeof *doc);
    if (!doc) return NULL;
    if (options) doc->options = *options;
    else mdy_options_default(&doc->options);

    if (len == 0 && text) len = strlen(text);

    size_t count = 0;
    mdy_line *lines = split_lines(doc, text, len, &count);

    doc->root = mdy_alloc(&doc->arena, sizeof *doc->root);
    if (!doc->root) { mdy_free(doc); return NULL; }
    memset(doc->root, 0, sizeof *doc->root);
    doc->root->type = MDY_ROOT;

    /*
     * ORDER, and it is observable: front matter comes off FIRST, and comments
     * only after it.
     *
     * Stripping first looks harmless and is not. A `#` line above the fence
     * stops the fence being the top of the document, so there is no front
     * matter and the whole thing is a paragraph — strip it first and the
     * fence floats up and the document acquires front matter it does not
     * have. And a `#` line INSIDE the block is YAML's own comment, which is
     * the front matter's business rather than the grammar's.
     *
     * This is src/parse/block.js's sequence: extractMatter, then the code,
     * then stripComments, then the lines are measured. The code is the one
     * step this parser does not take: the script layer runs before it and
     * hands it lines (mdyscript.h).
     */
    /*
     * Only for a SINGLE document. A stream splits first and each document
     * takes its own front matter off, which is what fromStream does — running
     * this at the top as well would eat the first document's block before the
     * loop could see whose it was.
     */
    size_t start = 0;
    if (doc->options.frontmatter && !doc->options.documents)
        start = front_matter_lines(doc, lines, count);

    if (!doc->options.documents) {
        /* One entry either way, so a caller can ask this document what its
         * front matter was and get a straight answer. */
        if (doc->matter_count == 0) record_matter(doc, NULL, 0, 0, 0);
        size_t body = count - start;
        strip_comments(lines + start, &body);
        find_definitions(doc, lines + start, body);
        mdy_parse_block(doc, doc->root, lines + start, body, 0, 0);
        mdy_footnote_section(doc, doc->root);
        return doc;
    }

    /*
     * `/^---[ \t]*$/` starts the next document — exactly three dashes, as YAML
     * has it, with trailing whitespace tolerated. More than three stays a
     * thematic break or a Setext underline, which is the way out of the
     * collision.
     *
     * A leading separator OPENS the first document rather than making an empty
     * one before it, and a document holding nothing but whitespace is dropped
     * — both of which fall out of skipping the empty sections, so a stream can
     * be spaced out however reads best.
     */
    const char *wrapper = doc->options.document_wrapper;
    if (!wrapper) wrapper = "article";
    size_t wrapper_len = strlen(wrapper);

    size_t from = start;
    int index = 0;
    for (size_t i = start; i <= count; i++) {
        int boundary = i == count || is_separator(&lines[i]);
        if (!boundary) continue;

        size_t section_start = from;
        size_t section_end = i;
        from = i + 1;

        /* Nothing but whitespace is not a document. */
        int any = 0;
        for (size_t k = section_start; k < section_end; k++)
            if (!lines[k].blank) { any = 1; break; }
        if (!any) continue;

        size_t had = doc->matter_count;
        if (doc->options.frontmatter)
            section_start += front_matter_lines(doc, lines + section_start,
                                                section_end - section_start);
        if (doc->matter_count == had) record_matter(doc, NULL, 0, 0, 0);

        /*
         * Footnotes belong to their own document: each collects, numbers and
         * lists its own. The SECOND and later documents carry their index in
         * the id prefix, so two documents on one page cannot both own
         * `#user-content-fn-1`.
         */
        doc->note_count = 0;
        doc->note_index = NULL;     /* a document's notes are its own; so is their map */
        doc->note_noindex = 0;
        doc->next_number = 0;
        doc->ref_document = (uint32_t)index;
        if (index == 0) {
            doc->note_prefix = "user-content-";
        } else {
            char pre[64];
            snprintf(pre, sizeof pre, "user-content-%d-", index);
            doc->note_prefix = mdy_strdup_n(&doc->arena, pre, strlen(pre));
        }

        /* Per document, and after its own front matter — see the note above.
         * Compacting inside the section leaves the lines beyond it where the
         * scan above still expects them. */
        size_t body = section_end - section_start;
        strip_comments(lines + section_start, &body);
        find_definitions(doc, lines + section_start, body);

        if (wrapper_len == 0) {
            /* `documents: {wrapper: false}` — they run together, with no
             * element between them and the root. */
            mdy_parse_block(doc, doc->root, lines + section_start, body, 0, 0);
            mdy_footnote_section(doc, doc->root);
        } else {
            mdy_node *article = mdy_new_element(doc, wrapper, wrapper_len);
            mdy_parse_block(doc, article, lines + section_start, body, 0, 1);
            mdy_footnote_section(doc, article);
            mdy_append(doc->root, article);
        }
        index++;
    }
    return doc;
}

const mdy_node *mdy_root(const mdy_doc *doc) { return doc ? doc->root : NULL; }
size_t mdy_bytes(const mdy_doc *doc) { return doc ? doc->arena.total : 0; }

void mdy_free(mdy_doc *doc) {
    if (!doc) return;
    mdy_arena_free(&doc->arena);
    free(doc);
}
