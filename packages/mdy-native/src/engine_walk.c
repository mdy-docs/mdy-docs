/*
 * A directory as a document set, and the import graph over it.
 *
 * mdy-docs' walkRawSources and openDocumentSet together: every file under the
 * root becomes a document, what its extension MEANS is applied here, and the
 * identity the walk derives travels beside each document rather than through
 * its text. `% import` is resolved from here too, each spec against the file
 * that wrote it, with a cache so a package imported twice is built once.
 *
 * This is where four of the review's bugs lived — a data file read as a
 * document separator, an empty file counted but not produced, a file name
 * carried through a text encoding that could not hold it, and the listing
 * split on a byte a file name may contain. They were all the same mistake in
 * different clothes: something about a file encoded as text and read back.
 */
#include "engine_internal.h"
#include "xalloc.h"

/* ---- a directory as a document set -------------------------------------------
 *
 * mdy-docs' `walkSources`: every file becomes a document, and what its own
 * FILE FORMAT means is applied — not a site-building convention like "posts
 * live in posts/", which stays the entry script's business.
 *
 *   .mdy         real text, compiled as a template
 *   .md          real text, NEVER compiled — a bare `---` or a literal `{{ }}`
 *                in prose must not be misread — so the text lands in
 *                `meta.body`, directly findable, and the document itself is a
 *                placeholder
 *   .yaml/.yml   parsed as a mapping and merged into the record; identity
 *                still wins for `path`
 *   anything     identity alone, so a file is still a queryable document
 *
 * dist/, node_modules/ and dotfiles are not sources.
 */

/* U+200B: survives "a whitespace-only document is dropped" while staying
 * invisible if anything ever did render it. */
#define PLACEHOLDER_BODY "\xe2\x80\x8b"

static int is_source(const char *rel) {
    const char *at = rel;
    for (;;) {
        if (strncmp(at, "dist/", 5) == 0 || strncmp(at, "node_modules/", 13) == 0 || at[0] == '.')
            return 0;
        const char *slash = strchr(at, '/');
        if (!slash) return 1;
        at = slash + 1;
    }
}

static const char *basename_of(const char *path) {
    const char *slash = strrchr(path, '/');
    return slash ? slash + 1 : path;
}

/* The extension including the dot, or "" — a leading dot is a dotfile rather
 * than an extension. */
static const char *extension_of(const char *name) {
    const char *dot = strrchr(name, '.');
    return (!dot || dot == name) ? "" : dot;
}

/*
 * Epoch milliseconds as ISO 8601 UTC — `2026-09-05T23:34:15.172Z`, which is
 * what a raw record's `mtime` IS. It is not a number: a site formats it by
 * matching `/^(\d{4})-(\d{2})-(\d{2})/` against it, and a number matches
 * nothing, so a "last updated" line silently disappears rather than failing.
 *
 * The civil date comes from Howard Hinnant's civil_from_days, the inverse of
 * the one $.rfc822 uses, rather than from gmtime — no locale, no time zone,
 * no platform in it at all.
 */
void iso8601_utc(double epoch_ms, char *out, size_t out_len) {
    long long ms = (long long)epoch_ms;
    long long days = ms / 86400000;
    long long rem = ms % 86400000;
    if (rem < 0) { rem += 86400000; days -= 1; }     /* floor, not truncate */

    long long z = days + 719468;
    long long era = (z >= 0 ? z : z - 146096) / 146097;
    unsigned long long doe = (unsigned long long)(z - era * 146097);
    unsigned long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    long long y = (long long)yoe + era * 400;
    unsigned long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    unsigned long long mp = (5 * doy + 2) / 153;
    unsigned long long d = doy - (153 * mp + 2) / 5 + 1;
    unsigned long long m = mp + (mp < 10 ? 3 : -9);
    y += (m <= 2);

    int hour = (int)(rem / 3600000);
    int minute = (int)((rem / 60000) % 60);
    int second = (int)((rem / 1000) % 60);
    int milli = (int)(rem % 1000);
    snprintf(out, out_len, "%04lld-%02llu-%02lluT%02d:%02d:%02d.%03dZ",
             y, m, d, hour, minute, second, milli);
}

/* The extensions mdy-docs reads dimensions for. A record carrying width and
 * height is what lets a template lay a page out without opening the file, and
 * `$.resize` refuses without them. */
static int is_image_ext(const char *ext) {
    static const char *const EXTS[] = {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
        ".svg", ".avif", ".ico", ".tiff", ".tif",
    };
    for (size_t i = 0; i < sizeof EXTS / sizeof *EXTS; i++)
        if (mdy_ieq(ext, EXTS[i])) return 1;
    return 0;
}

int ends_with_ci(const char *s, const char *suffix) {
    size_t n = strlen(s), m = strlen(suffix);
    return m <= n && mdy_ieq(s + n - m, suffix);
}


/*
 * A .md file's text, written into front matter as a YAML literal block
 * scalar. Every line is indented by two, and the indentation indicator is
 * EXPLICIT (`|2`) rather than inferred: a body whose first line begins with a
 * space would otherwise set the block's indent from that line and silently
 * shift the whole thing. The chomping indicator carries the trailing newlines,
 * which are part of the text and must come back exactly — `-` strips, plain
 * clips to one, `+` keeps them all.
 */
/*
 * THE YAML WRITER, and the one thing it is still for.
 *
 * Records do not come through here. Identity and `tags` are built as VALUES
 * (mdy_yaml_builder, mdyyaml.h) and handed to mdy_bj_document, so there is no
 * text in between: nothing to escape, nothing to mis-read, and a refused
 * allocation is answered rather than written as a block silently short a key.
 *
 * What still writes text is the SOURCE of a `.md` document: the synthetic
 * `+++` block the splitter reads, holding the file's prose as `body`. That is
 * not a record going to the store — it is document text going to the same
 * reader a `.mdy` file's own front matter goes to — so it has to be text, and
 * it has to be escaped. put_scalar is why it is.
 */
/* Room for `more` bytes, growing from nothing. 0 when there is none. */
/*
 * Room for `more` bytes of the identity block being built.
 *
 * This returned 0 on failure and every caller answered by returning quietly,
 * which truncated the block mid-line: a document whose `path` or `mtime` was
 * simply not there, written into the set and built as though that were the
 * file. There is no error channel through a chain of void put_* helpers, so
 * it does not fail. See xalloc.h.
 */
static void put_room(char **buf, size_t *len, size_t *cap, size_t more) {
    size_t need = *len + more;
    if (need <= *cap) return;
    size_t want = *cap ? *cap : 256;
    while (need > want) want *= 2;
    *buf = mdy_xrealloc(*buf, want);
    *cap = want;
}

/*
 * One double-quoted YAML scalar, escaped the way read_quoted unescapes it —
 * `\` and `"` named, control characters as `\xNN`, and everything else
 * including UTF-8 through as bytes, since only what the reader would take for
 * something else has to be named.
 *
 * EVERYTHING this file writes as YAML goes through here. A value pasted in
 * with `%s` is a value that can close its own quote: one tag with a quote in
 * it makes the whole generated `tags:` block unparseable, and the document's
 * tags then fall back
 * to whatever its front matter said and were silently never lowercased or
 * deduplicated at all.
 */
static void put_scalar(char **buf, size_t *len, size_t *cap, const char *value) {
    static const char H[] = "0123456789abcdef";
    size_t vlen = strlen(value);
    /* Four bytes out for one in is the worst an escape does (`\xNN`). */
    put_room(buf, len, cap, vlen * 4 + 8);

    char *out = *buf + *len;
    *out++ = '"';
    for (size_t i = 0; i < vlen; i++) {
        unsigned char c = (unsigned char)value[i];
        switch (c) {
            case '\\': *out++ = '\\'; *out++ = '\\'; break;
            case '"':  *out++ = '\\'; *out++ = '"';  break;
            case '\n': *out++ = '\\'; *out++ = 'n';  break;
            case '\t': *out++ = '\\'; *out++ = 't';  break;
            case '\r': *out++ = '\\'; *out++ = 'r';  break;
            default:
                if (c < 0x20 || c == 0x7f) {
                    *out++ = '\\'; *out++ = 'x'; *out++ = H[c >> 4]; *out++ = H[c & 15];
                } else {
                    *out++ = (char)c;
                }
        }
    }
    *out++ = '"';
    *out = '\0';
    *len = (size_t)(out - *buf);
}

/* `tags:` and its list, or `tags: []` for a document that declared the key
 * and has nothing to put under it. Written in one place because it was
 * written in two, character for character, and only one of them knew about
 * the empty case. */
static void put_tag_list(char **buf, size_t *len, size_t *cap,
                         const char (*tags)[128], size_t count) {
    if (count == 0) {
        put_room(buf, len, cap, 16);
        *len += (size_t)snprintf(*buf + *len, *cap - *len, "tags: []\n");
        return;
    }
    put_room(buf, len, cap, 8);
    *len += (size_t)snprintf(*buf + *len, *cap - *len, "tags:\n");
    for (size_t k = 0; k < count; k++) {
        put_room(buf, len, cap, 8);
        (*buf)[(*len)++] = ' ';
        (*buf)[(*len)++] = ' ';
        (*buf)[(*len)++] = '-';
        (*buf)[(*len)++] = ' ';
        put_scalar(buf, len, cap, tags[k]);
        put_room(buf, len, cap, 2);
        (*buf)[(*len)++] = '\n';
        (*buf)[*len] = '\0';
    }
}

static void put_block_scalar(char **buf, size_t *len, size_t *cap,
                             const char *keyname, const char *text, size_t tlen) {
    /*
     * The whole scalar is written after this one reservation, so the room has
     * to cover the worst case up front: two indent bytes and a newline per
     * line (bounded by `tlen * 2`), the `key: |2±\n` header, and the trailing
     * newlines a `+` chomp keeps. Through `put_room` like every other writer
     * here — it grows a local `want` and only commits `*cap` once the
     * allocation is real, where this hand-rolled its own `*cap *= 2` before the
     * `realloc` and returned silently on failure, leaving `*cap` claiming space
     * that was never allocated for the next writer to overrun. See xalloc.h.
     */
    put_room(buf, len, cap, tlen * 2 + strlen(keyname) + 64);
    if (tlen == 0) {
        *len += (size_t)snprintf(*buf + *len, *cap - *len, "%s: \"\"\n", keyname);
        return;
    }
    size_t trailing = 0;
    while (trailing < tlen && text[tlen - 1 - trailing] == '\n') trailing++;
    const char *chomp = trailing == 0 ? "-" : (trailing == 1 ? "" : "+");
    *len += (size_t)snprintf(*buf + *len, *cap - *len, "%s: |2%s\n", keyname, chomp);

    size_t body_end = tlen - trailing;
    size_t at = 0;
    while (at < body_end) {
        const char *nl = memchr(text + at, '\n', body_end - at);
        size_t line_len = nl ? (size_t)(nl - (text + at)) : body_end - at;
        if (line_len > 0) {
            memcpy(*buf + *len, "  ", 2);
            *len += 2;
            memcpy(*buf + *len, text + at, line_len);
            *len += line_len;
        }
        (*buf)[(*len)++] = '\n';
        at += line_len + 1;
    }
    /* `+` keeps every trailing newline, so they have to be written out. */
    if (trailing > 1) for (size_t i = 1; i < trailing; i++) (*buf)[(*len)++] = '\n';
    (*buf)[*len] = '\0';
}

/*
 * `extractTags` from mdy.js, for a .md file — the `#tags` its prose mentions,
 * lowercased, each once, in the order they are reached.
 *
 * What is NOT prose is skipped first: script lines (asked of the real
 * scanner, so a `%` inside a template literal is not mistaken for one), fenced
 * blocks, `{{ }}` expressions and inline code spans. A `#tag` inside any of
 * those is not a tag, and the whole reason to strip them is that a shell
 * comment in a fenced example otherwise becomes one.
 */
static int tag_char(unsigned char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '/' || c >= 0x80;
}

/* Lowercased, deduped, in order of first appearance. Returns how many. */
static size_t add_tag(char (**tags)[128], size_t *count, size_t *cap,
                      const char *name, size_t name_len) {
    if (name_len == 0 || name_len >= 128) return *count;
    char lowered[128];
    for (size_t i = 0; i < name_len; i++) {
        char c = name[i];
        lowered[i] = mdy_lower_ascii(c);
    }
    lowered[name_len] = '\0';
    for (size_t i = 0; i < *count; i++)
        if (strcmp((*tags)[i], lowered) == 0) return *count;
    if (*count == *cap) {
        size_t want = *cap ? *cap * 2 : 8;
        /* Returning the old count here dropped the tag and said nothing: the
         * document left every index that tag names. See xalloc.h. */
        *tags = mdy_xrealloc(*tags, want * sizeof **tags);
        *cap = want;
    }
    memcpy((*tags)[(*count)++], lowered, name_len + 1);
    return *count;
}

static void scan_hashtags(const char *text, size_t tlen,
                          char (**out)[128], size_t *count, size_t *cap) {
    mdy_script *script = mdy_script_compile(text, tlen);

    char *prose = mdy_xmalloc(tlen + 1);
    size_t plen = 0;
    size_t at = 0, line_no = 0;
    int in_fence = 0;
    while (at <= tlen) {
        const char *nl = at < tlen ? memchr(text + at, '\n', tlen - at) : NULL;
        size_t line_len = nl ? (size_t)(nl - (text + at)) : tlen - at;
        const char *line = text + at;

        size_t lead = 0;
        while (lead < line_len && (line[lead] == ' ' || line[lead] == '\t')) lead++;
        int fence = line_len - lead >= 3 &&
                    (memcmp(line + lead, "```", 3) == 0 || memcmp(line + lead, "~~~", 3) == 0);

        int is_code = script && mdy_script_is_code(script, line_no);
        if (!is_code && fence) {
            in_fence = !in_fence;
        } else if (!is_code && !in_fence) {
            memcpy(prose + plen, line, line_len);
            plen += line_len;
            prose[plen++] = '\n';
        }
        if (!nl) break;
        at += line_len + 1;
        line_no++;
    }
    mdy_script_free(script);

    /* `{{ … }}` and `` `…` `` become a space, so a tag against one does not
     * join the text either side of it. */
    for (size_t i = 0; i < plen;) {
        if (i + 1 < plen && prose[i] == '{' && prose[i + 1] == '{') {
            size_t j = i + 2;
            while (j + 1 < plen && !(prose[j] == '}' && prose[j + 1] == '}')) j++;
            size_t end = j + 1 < plen ? j + 2 : plen;
            memset(prose + i, ' ', end - i);
            i = end;
        } else if (prose[i] == '`') {
            size_t j = i + 1;
            while (j < plen && prose[j] != '`' && prose[j] != '\n') j++;
            if (j < plen && prose[j] == '`') { memset(prose + i, ' ', j + 1 - i); i = j + 1; }
            else i++;
        } else i++;
    }

    for (size_t i = 0; i < plen; i++) {
        if (prose[i] != '#') continue;
        /* A tag starts at a boundary and its first character is a letter. */
        if (i > 0) {
            unsigned char prev = (unsigned char)prose[i - 1];
            if (tag_char(prev) || prev == '#') continue;
        }
        size_t j = i + 1;
        if (j >= plen) break;
        unsigned char first = (unsigned char)prose[j];
        if (!((first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') || first >= 0x80))
            continue;
        while (j < plen && tag_char((unsigned char)prose[j])) j++;
        size_t name_len = j - i - 1;
        if (name_len == 0 || name_len >= 128) { i = j; continue; }

        const char *name = prose + i + 1;

        add_tag(out, count, cap, name, name_len);
        i = j - 1;
    }
    free(prose);
}

/*
 * A `.md` file's tags come from the WALK, not from the ingest: its document
 * body is a placeholder, and the markdown is on its data. So the hashtags are
 * scanned here, from the file, and land in the record as declared tags —
 * which the ingest then carries through unchanged.
 */
static void put_tags_from_text(char **buf, size_t *len, size_t *cap,
                               const char *text, size_t tlen) {
    char (*tags)[128] = NULL;
    size_t count = 0, cap_t = 0;
    scan_hashtags(text, tlen, &tags, &count, &cap_t);
    if (count > 0) put_tag_list(buf, len, cap, tags, count);
    free(tags);
}



/* ---- the import graph --------------------------------------------------------
 *
 * `% import style from "../style-antiquity"` — another mdy package, walked and
 * compiled into its OWN document set rather than merged into this one. The
 * imported package's own `$.find` and `$.render` keep working exactly as they
 * would standalone: its `layouts/base.mdy` does not collide with the
 * importer's file of the same name, and neither package has to know it is
 * importable. The importer reaches in explicitly, through the object the
 * import binds.
 *
 * `import` is rewritten HERE, not parsed by the JS engine, for the reason
 * imports.js gives: a real `import` statement is not legal inside a function
 * body, and every `%` line ends up inside one. So a recognised shape becomes
 * ordinary VM-legal JS before the compiler ever sees it — symmetrical to the
 * ```data fences.
 */

/* Pure POSIX string math. Every root this deals with is POSIX-shaped, and a
 * resolved directory may be virtual, so this is both correct and portable in
 * a way reaching for the platform's path handling would not be. */
void dirname_of(const char *p, char *out, size_t out_len) {
    const char *slash = strrchr(p, '/');
    if (!slash) { snprintf(out, out_len, "."); return; }
    if (slash == p) { snprintf(out, out_len, "/"); return; }
    size_t n = (size_t)(slash - p);
    if (n >= out_len) n = out_len - 1;
    memcpy(out, p, n);
    out[n] = '\0';
}

/* `spec` against `base`, with `.` and `..` collapsed. */
void resolve_path(const char *base, const char *spec, char *out, size_t out_len) {
    char combined[4096];
    if (fsx_is_absolute(spec)) snprintf(combined, sizeof combined, "%s", spec);
    else snprintf(combined, sizeof combined, "%s/%s", base, spec);
    /* No backslash translation, deliberately: see fsx_normalize's comment. */
    fsx_normalize(combined, out, out_len);
}

/* A relative root against the working directory, so cache keys and cycle
 * detection compare the same directory the same way however it was spelled. */
static void absolute_root(const char *root, char *out, size_t out_len) {
    if (fsx_is_absolute(root)) { resolve_path("/", root, out, out_len); return; }
    char *cwd = fsx_cwd();
    resolve_path(cwd ? cwd : ".", root, out, out_len);
    free(cwd);
}

/*
 * `% import name from "spec"` — a whole code line and nothing else on it.
 * A line mixing an import with other code is NOT recognised, deliberately:
 * `import`/`from` are not legal as ordinary expression code, so mixing them
 * surfaces as a script error rather than a silent misparse.
 *
 * Returns 1 and fills the parts if `line` is one.
 */
static int import_line(const char *line, size_t len,
                       size_t *indent_len, char *name, size_t name_cap,
                       char *spec, size_t spec_cap) {
    size_t i = 0;
    while (i < len && (line[i] == ' ' || line[i] == '\t')) i++;
    *indent_len = i;
    if (i >= len || line[i] != '%') return 0;
    i++;
    if (i < len && line[i] == '%') i++;                  /* `%%` is one too */
    while (i < len && (line[i] == ' ' || line[i] == '\t')) i++;
    if (len - i < 6 || memcmp(line + i, "import", 6) != 0) return 0;
    i += 6;
    if (i >= len || (line[i] != ' ' && line[i] != '\t')) return 0;
    while (i < len && (line[i] == ' ' || line[i] == '\t')) i++;

    size_t nstart = i;
    if (i >= len) return 0;
    char c = line[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '$')) return 0;
    while (i < len) {
        c = line[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || c == '_' || c == '$')) break;
        i++;
    }
    size_t nlen = i - nstart;
    if (nlen == 0 || nlen >= name_cap) return 0;

    if (i >= len || (line[i] != ' ' && line[i] != '\t')) return 0;
    while (i < len && (line[i] == ' ' || line[i] == '\t')) i++;
    if (len - i < 4 || memcmp(line + i, "from", 4) != 0) return 0;
    i += 4;
    if (i >= len || (line[i] != ' ' && line[i] != '\t')) return 0;
    while (i < len && (line[i] == ' ' || line[i] == '\t')) i++;

    if (i >= len || (line[i] != '"' && line[i] != '\'')) return 0;
    char quote = line[i++];
    size_t sstart = i;
    while (i < len && line[i] != quote) {
        if (line[i] == '"' || line[i] == '\'') return 0;   /* [^"']+ */
        i++;
    }
    if (i >= len) return 0;
    size_t slen = i - sstart;
    if (slen == 0 || slen >= spec_cap) return 0;
    i++;

    /* Trailing `;` and space, and then the line must END. */
    while (i < len && (line[i] == ' ' || line[i] == '\t')) i++;
    if (i < len && line[i] == ';') i++;
    while (i < len && (line[i] == ' ' || line[i] == '\t')) i++;
    if (i != len) return 0;

    memcpy(name, line + nstart, nlen); name[nlen] = '\0';
    memcpy(spec, line + sstart, slen); spec[slen] = '\0';
    return 1;
}

/*
 * Rewrite every import line in `text` to a plain object literal the VM can
 * run, recording the specs. One line in, one line out — a document's
 * positions still point where its author would look.
 */
static char *rewrite_imports(mdy_engine *e, const char *source_path,
                             const char *text, size_t len, size_t *out_len) {
    size_t cap = len + 1024, at_out = 0;
    char *out = malloc(cap);
    if (!out) return NULL;

    size_t at = 0;
    while (at <= len) {
        const char *nl = at < len ? memchr(text + at, '\n', len - at) : NULL;
        size_t line_len = nl ? (size_t)(nl - (text + at)) : len - at;
        const char *line = text + at;

        size_t indent = 0;
        char name[128], spec[1024];
        if (import_line(line, line_len, &indent, name, sizeof name, spec, sizeof spec)) {
            if (e->graph.import_count == e->graph.import_cap) {
                size_t want = e->graph.import_cap ? e->graph.import_cap * 2 : 8;
                Import *grown = realloc(e->graph.imports, want * sizeof *grown);
                if (!grown) { free(out); return NULL; }
                e->graph.imports = grown;
                e->graph.import_cap = want;
            }
            /* Written before the count moves: an import whose fields could
             * not be copied is not an import with NULL for a spec, which is
             * what every later reader dereferenced. */
            char *isrc = strdup(source_path);
            char *ispec = strdup(spec);
            if (!isrc || !ispec) { free(isrc); free(ispec); free(out); return NULL; }
            Import *imp = &e->graph.imports[e->graph.import_count++];
            imp->source_path = isrc;
            imp->spec = ispec;
            imp->set = NULL;

            /*
             * Measured, then allocated. This was a char[4096] with snprintf's
             * RETURN used as the length to copy -- and the line it builds
             * carries `spec` FOUR times, so a specifier past about 950
             * characters makes a line longer than the buffer and the memcpy
             * below reads off the end of it. ASan calls it a
             * stack-buffer-overflow, READ of size 4277; `import_line` admits
             * a spec of 1023.
             */
            static const char REWRITE[] =
                "%% const %s = { "
                "render: (target, ctx) => $.__importRender(\"%s\", target, ctx === undefined ? {} : ctx), "
                "find: (query) => $.__importFind(\"%s\", query === undefined ? {} : query), "
                "findOne: (query) => $.__importFindOne(\"%s\", query === undefined ? {} : query), "
                "resize: (record, options) => $.__importResize(\"%s\", record, options === undefined ? {} : options) };";
            int n = snprintf(NULL, 0, REWRITE, name, spec, spec, spec, spec);
            if (n < 0) { free(out); return NULL; }
            char *rewritten = mdy_xmalloc((size_t)n + 1);
            snprintf(rewritten, (size_t)n + 1, REWRITE, name, spec, spec, spec, spec);

            size_t need = at_out + indent + (size_t)n + 2;
            if (need > cap) {
                while (need > cap) cap *= 2;
                char *grown = realloc(out, cap);
                if (!grown) { free(rewritten); free(out); return NULL; }
                out = grown;
            }
            memcpy(out + at_out, line, indent);
            at_out += indent;
            memcpy(out + at_out, rewritten, (size_t)n);
            at_out += (size_t)n;
            free(rewritten);
        } else {
            size_t need = at_out + line_len + 2;
            if (need > cap) {
                while (need > cap) cap *= 2;
                char *grown = realloc(out, cap);
                if (!grown) { free(out); return NULL; }
                out = grown;
            }
            memcpy(out + at_out, line, line_len);
            at_out += line_len;
        }
        if (!nl) break;
        out[at_out++] = '\n';
        at += line_len + 1;
    }
    out[at_out] = '\0';
    *out_len = at_out;
    return out;
}

/* ---- the cache, and the recursion ------------------------------------------- */

static mdy_engine *cache_get(ImportCache *c, const char *dir) {
    for (size_t i = 0; i < c->count; i++)
        if (strcmp(c->dirs[i], dir) == 0) return c->sets[i];
    return NULL;
}

static void cache_put(ImportCache *c, const char *dir, mdy_engine *set) {
    if (c->count == c->cap) {
        /*
         * Each realloc taken as it succeeds.
         *
         * Doing both and then `free(d); free(s)` if either failed leaves
         * `c->dirs` DANGLING whichever way it goes: if realloc moved the
         * block the old pointer is already freed, and if it did not then
         * `free(d)` frees the block `c->dirs` still points at. The next
         * cache_get then reads freed memory — a use-after-free reached FROM an
         * allocation failure rather than at it.
         *
         * Each grow is still taken as it succeeds, for that reason. What has
         * gone is the failure itself: returning without adding left the
         * import uncached, and an import resolved twice is a second engine,
         * a different render count and different composition-token ids --
         * a different site, built quietly. See xalloc.h.
         */
        size_t want = c->cap ? c->cap * 2 : 8;
        c->dirs = mdy_xrealloc(c->dirs, want * sizeof *c->dirs);
        c->sets = mdy_xrealloc(c->sets, want * sizeof *c->sets);
        c->cap = want;
    }
    char *copy = mdy_xstrdup(dir);
    c->dirs[c->count] = copy;
    c->sets[c->count] = set;
    c->count++;
}

/* The chain from the graph's root down to whoever is calling — a REAL cycle
 * has a directory reappear in its OWN ancestors. A diamond (two files
 * importing the same package) does not, and must dedupe through the cache
 * rather than error, which is why this is a chain and not a flat set. */
typedef struct Ancestors {
    const char *dir;
    const struct Ancestors *up;
} Ancestors;

static int in_ancestors(const Ancestors *a, const char *dir) {
    for (; a; a = a->up) if (strcmp(a->dir, dir) == 0) return 1;
    return 0;
}


/*
 * What the walk learns about one file, before it knows how many documents the
 * file is. Only the splitter knows that, and it is asked once — after the
 * walk, when the set is opened — rather than counted here and re-derived
 * there, which is how the two came to disagree.
 */
typedef struct {
    size_t start, len;      /* the file's text, inside the staging buffer */
    mdy_yaml *pre;          /* identity as a DEFAULT: a data file's, else NULL */
    mdy_yaml *data;         /* a data file's own mapping */
    mdy_yaml *post;         /* identity where it WINS */
    int is_md;
} WalkedFile;

static void walked_free(WalkedFile *files, size_t count) {
    for (size_t i = 0; i < count; i++) {
        mdy_yaml_free(files[i].pre);
        mdy_yaml_free(files[i].post);
        mdy_yaml_free(files[i].data);
    }
    free(files);
}

/*
 * WHAT THE WALK ACCUMULATES, per file, before anything is a document yet.
 *
 * `source` is one buffer for the whole walk with a SPAN of it per file, and
 * `files` is one entry per file naming that span. Both grow, which is the
 * reason they travel together in a struct rather than as six pointers: the
 * per-file pass below appends to them and nothing else, and a failure
 * anywhere in it frees exactly these two.
 */
typedef struct {
    char *source; size_t len, cap;
    WalkedFile *files; size_t count, cap_files;
} Staging;

static void staging_free(Staging *st) {
    walked_free(st->files, st->count);
    free(st->source);
    st->files = NULL; st->source = NULL;
    st->count = st->cap_files = st->len = st->cap = 0;
}

/*
 * ONE FILE: read it, decide what kind it is, build its identity, and append
 * its text to the staging buffer.
 *
 * The seam is the staging buffer: everything here is per FILE, and everything
 * the caller does after the loop is per DOCUMENT, because only the splitter
 * knows how many documents a file became.
 *
 * `Staging` is why the twenty-odd failures below are one line each. Freeing
 * the whole walk at each of them means a slightly different subset every
 * time, which is the shape a leak hides in; a failure here frees only what
 * this function allocated, and the caller frees the staging and the listing
 * once.
 */
/*
 * The record for one file, built as VALUES (no YAML text in between, so nothing
 * to escape or mis-read). `path` FIRST because mdy-docs has it first — it builds
 * `{ ...meta, ...parsed, path }`, and mdy_bj_document takes a key's place from
 * the first mapping to hold it and its value from the last, so position and
 * value are separate. A picture's dimensions are read from its header when they
 * are there; a file this cannot decode still gets a record, just without them.
 * NULL means the builder saw an allocation it could not make.
 */
static mdy_yaml *build_identity(const char *rel, const char *name, const char *ext,
                                double size, double mtime, int is_image,
                                const uint8_t *bytes, size_t body_len) {
    char when[40];
    iso8601_utc(mtime, when, sizeof when);
    mdy_yaml_builder *ib = mdy_yaml_builder_new();
    if (!ib) return NULL;
    mdy_yaml_put_string(ib, "path", rel, 0);
    mdy_yaml_put_string(ib, "name", name, 0);
    mdy_yaml_put_string(ib, "ext", ext, 0);
    mdy_yaml_put_number(ib, "size", size);
    mdy_yaml_put_string(ib, "mtime", when, 0);
    if (is_image && bytes) {
        int iw = 0, ih = 0;
        if (mdy_image_size(bytes, body_len, &iw, &ih) == 0) {
            mdy_yaml_put_number(ib, "width", iw);
            mdy_yaml_put_number(ib, "height", ih);
        }
    }
    return mdy_yaml_builder_done(ib);
}

static int walk_one_file(mdy_engine *e, const char *root, const char *rel,
                         Staging *st, char *error, size_t error_len) {
    /* Not a source: nothing staged, nothing recorded, and not a failure. */
    if (!is_source(rel)) return 0;
    if (e->cb.on_source) e->cb.on_source(e->cb.on_source_ud, rel);

    const char *name = basename_of(rel);
    const char *ext = extension_of(name);

    /*
     * The walk has just listed this file, so a stat that fails is a real
     * failure -- and ignoring it left `size` and `mtime` at zero, which
     * is a record claiming an empty file last written in 1970. The
     * document was then built and written from it.
     */
    double size = 0, mtime = 0;
    if (fsx_stat(root, rel, &size, &mtime) != 0) {
        if (error && error_len) snprintf(error, error_len, "cannot stat %s/%s", root, rel);
        return -1;
    }

    size_t body_len = 0;
    char *body = NULL;
    int is_mdy = ends_with_ci(rel, ".mdy");
    int is_md = ends_with_ci(rel, ".md");
    int is_yaml = ends_with_ci(rel, ".yaml") || ends_with_ci(rel, ".yml");

    int is_image = is_image_ext(ext);
    uint8_t *bytes = NULL;
    if (is_mdy || is_md || is_yaml || is_image) {
        bytes = fsx_read(root, rel, &body_len);
        /*
         * A file the listing named and the read could not deliver. Letting
         * it through as no bytes drops a page from the site and still reports
         * success — the same answer an unreadable directory gets.
         */
        if (!bytes) {
            if (error && error_len) snprintf(error, error_len, "cannot read %s/%s", root, rel);
            return -1;
        }
    }

    /*
     * The record. `path` is written LAST of the identity fields for the
     * reason mdy-docs gives: a data file may declare its own `name` or
     * `size` and identity silently shadowing that would make the file's
     * own data unreachable — but `path` is structurally required to be
     * real, because everything resolves documents by it.
     */
    /* Identity, kept OUT of the text — see `identity` on the engine, and
     * build_identity above. NULL is an OOM (the builder remembers a refused
     * allocation); a document is short its record rather than built without it. */
    mdy_yaml *ident = build_identity(rel, name, ext, size, mtime, is_image, bytes, body_len);
    if (!ident) { free(bytes); if (error && error_len) snprintf(error, error_len, "out of memory");
                  return -1; }

    /* Doubling from a cap of ZERO never reaches `need`, so the growth starts
     * from a real size and the first file is what sizes the buffer. */
    size_t need = st->len + body_len + 4096;
    if (need > st->cap) {
        size_t want = st->cap ? st->cap : 65536;
        while (need > want) want *= 2;
        st->cap = want;
        char *grown = realloc(st->source, st->cap);
        if (!grown) { if (error && error_len) snprintf(error, error_len, "out of memory"); mdy_yaml_free(ident); free(bytes); return -1; }
        st->source = grown;
    }
    size_t file_start = st->len;

    /*
     * A built front-matter block, for the one kind that has no front
     * matter of its own and needs one: .md. A .mdy file's text goes in
     * untouched — its own `+++` block must be the first thing the splitter
     * sees, or it is read as body text — and a .yaml file's text does not
     * go in AT ALL: its fields are parsed below, out of the source, where
     * a `---` or a `+++` line among them cannot be read as structure.
     * Everything else is the placeholder body.
     */
    if (is_md) {
        /* Never compiled — a bare `---` or a literal `{{ }}` in prose
         * must not be misread — so the text is DATA: findable in `body`,
         * with the document itself a placeholder. Indented into a block
         * scalar, which is also what keeps a `---` in the prose out of
         * the splitter's way. */
        st->len += (size_t)snprintf(st->source + st->len, st->cap - st->len, "+++\n");
        if (bytes) {
            put_block_scalar(&st->source, &st->len, &st->cap, "body", (const char *)bytes, body_len);
            put_tags_from_text(&st->source, &st->len, &st->cap, (const char *)bytes, body_len);
        }
        st->len += (size_t)snprintf(st->source + st->len, st->cap - st->len, "+++\n");
    }

    if (is_mdy && bytes) {
        /* `% import` is rewritten before the compiler ever sees the text —
         * a real import statement is not legal inside a function body, and
         * every `%` line becomes one. */
        size_t rlen = 0;
        char *rewritten = rewrite_imports(e, rel, (const char *)bytes, body_len, &rlen);
        body = rewritten ? rewritten : (char *)bytes;
        size_t blen = rewritten ? rlen : body_len;

        size_t need2 = st->len + blen + 64;
        if (need2 > st->cap) {
            size_t want2 = st->cap ? st->cap : 65536;
            while (need2 > want2) want2 *= 2;
            st->cap = want2;
            char *grown = realloc(st->source, st->cap);
            if (!grown) { if (error && error_len) snprintf(error, error_len, "out of memory"); if (rewritten) free(rewritten); mdy_yaml_free(ident); free(bytes); return -1; }
            st->source = grown;
        }
        memcpy(st->source + st->len, body, blen);
        st->len += blen;
        if (rewritten) free(rewritten);
    } else {
        memcpy(st->source + st->len, PLACEHOLDER_BODY, strlen(PLACEHOLDER_BODY));
        st->len += strlen(PLACEHOLDER_BODY);
    }
    st->source[st->len] = '\0';

    /*
     * A data file IS its record, so its bytes are read here — once, as
     * YAML, never as document text. Unreadable, or not a mapping at all,
     * is not a build failure: a whole-directory walk cannot assume every
     * stray .yaml under the root (a CI config, anything) is meant to be a
     * record, so the file keeps its raw identity and says so, which is
     * what mdy-docs' walkRawSources does.
     */
    mdy_yaml *own = NULL;
    if (is_yaml && bytes && body_len) {
        char yerr[256];
        yerr[0] = '\0';
        own = mdy_yaml_parse((const char *)bytes, body_len, yerr, sizeof yerr);
        /* A .yaml this cannot READ keeps its raw identity and says so,
         * which is a real outcome. One it could not ALLOCATE for is not:
         * the file would lose every parsed field on a build that
         * succeeded. MDY_YAML_OOM is what tells them apart. */
        if (!own && strcmp(yerr, MDY_YAML_OOM) == 0) {
            if (error && error_len) snprintf(error, error_len, "out of memory");
            mdy_yaml_free(ident);
            free(bytes); return -1;
        }
        mdy_yaml_type kind = own ? mdy_yaml_type_of(mdy_yaml_root(own)) : MDY_YAML_NULL;
        if (!own)
            engine_message(e, 0, 0, 0, "yaml",
                           "%s — %s keeps its raw identity, no parsed fields",
                           yerr[0] ? yerr : "unreadable YAML", rel);
        else if (kind == MDY_YAML_NULL)
            { mdy_yaml_free(own); own = NULL; }      /* nothing in it, nothing to say */
        else if (kind != MDY_YAML_MAPPING) {
            engine_message(e, 0, 0, 0, "yaml",
                           "%s must be a YAML mapping — %s keeps its raw identity,"
                           " no parsed fields", rel, rel);
            mdy_yaml_free(own);
            own = NULL;
        }
    }

    /* One entry per FILE, with its text as a span. How many documents
     * that text is, the splitter says below. */
    if (st->count == st->cap_files) {
        size_t want = st->cap_files ? st->cap_files * 2 : 16;
        WalkedFile *grown = realloc(st->files, want * sizeof *grown);
        if (!grown) { if (error && error_len) snprintf(error, error_len, "out of memory"); mdy_yaml_free(own); mdy_yaml_free(ident); free(bytes); return -1; }
        st->files = grown;
        st->cap_files = want;
    }
    WalkedFile *f = &st->files[st->count++];
    f->start = file_start;
    f->len = st->len - file_start;
    f->data = own;
    f->is_md = is_md;
    /* Both, before anything below can fail: the slot is taken, so a
     * failure from here on goes through walked_free and it must not find
     * two uninitialised pointers to free. */
    f->pre = NULL;
    f->post = NULL;
    if (is_yaml) {
        /* A default: the file's own fields win, except `path`. */
        mdy_yaml_builder *pb = mdy_yaml_builder_new();
        if (pb) mdy_yaml_put_string(pb, "path", rel, 0);
        mdy_yaml *only_path = mdy_yaml_builder_done(pb);
        if (!only_path) { mdy_yaml_free(ident); free(bytes); if (error && error_len) snprintf(error, error_len, "out of memory");
                          return -1; }
        f->pre = ident;
        f->post = only_path;
    } else {
        f->post = ident;
    }
    free(bytes);
    return 0;
}

/* Once, on an engine nobody has opened yet: the root, the import cache and
 * the identity arrays are all taken to be empty here, and a site or a package
 * is walked exactly once. A rebuild is a NEW engine (cli.c's dev_rebuild). */
static int open_dir_inner(mdy_engine *e, const char *root, ImportCache *cache,
                          const Ancestors *ancestors, char *error, size_t error_len) {
    if (error && error_len) error[0] = '\0';
    e->graph.root = strdup(root);
    if (!e->graph.root) {
        if (error && error_len) snprintf(error, error_len, "out of memory");
        return -1;
    }
    e->graph.cache = cache;

    char *listing = fsx_list(root, ".", NULL);
    if (!listing) {
        if (error && error_len) snprintf(error, error_len, "cannot read %s", root);
        return -1;
    }

    /*
     * One buffer for the whole walk, and a SPAN of it per file: every file is
     * its own source, and the set is the files split one at a time, which is
     * what mdy-docs' parseDocuments does with an array. One allocation rather
     * than one per file, so a file is a span until the walk is over — the
     * buffer moves under a pointer taken early.
     *
     * NOT one source joined by the `---` the splitter reads, which looks the
     * same until a file holds no document: joined, an empty .mdy is a blank
     * chunk between two separators and the splitter drops it, while the walk
     * has counted a document and an identity for it. Every identity after it
     * then belongs to the wrong document.
     */
    Staging st = { 0 };
    for (const char *rel = listing; *rel; rel += strlen(rel) + 1) {
        if (walk_one_file(e, root, rel, &st, error, error_len) != 0) {
            staging_free(&st);
            free(listing);
            return -1;
        }
    }
    /* The spans are absolute offsets into `source`, so the running length has
     * done its job and the buffer is what is left. */
    char *source = st.source;
    WalkedFile *files = st.files;
    size_t file_count = st.count;

    free(listing);

    /*
     * The set: every file split ON ITS OWN, in order. The spans become
     * pointers only now, with the buffer done growing.
     */
    mdy_chunk *srcs = malloc((file_count ? file_count : 1) * sizeof *srcs);
    size_t *per_file = malloc((file_count ? file_count : 1) * sizeof *per_file);
    if (!srcs || !per_file) {
        free(srcs); free(per_file); walked_free(files, file_count); free(source);
        if (error && error_len) snprintf(error, error_len, "out of memory");
        return -1;
    }
    for (size_t i = 0; i < file_count; i++) {
        srcs[i].text = source + files[i].start;
        srcs[i].len = files[i].len;
    }
    mdy_documents *docs = mdy_split_sources(srcs, file_count, per_file);
    free(srcs);
    if (!docs) {
        free(per_file); walked_free(files, file_count); free(source);
        if (error && error_len) snprintf(error, error_len, "out of memory");
        return -1;
    }

    /* One identity per document the file became — the same one each time,
     * because a file is what identity is derived from. */
    size_t total = 0;
    for (size_t i = 0; i < file_count; i++) total += per_file[i];
    e->identity.pre = calloc(total ? total : 1, sizeof *e->identity.pre);
    e->identity.data = calloc(total ? total : 1, sizeof *e->identity.data);
    e->identity.post = calloc(total ? total : 1, sizeof *e->identity.post);
    e->identity.is_md = calloc(total ? total : 1, 1);
    if (!e->identity.pre || !e->identity.data || !e->identity.post || !e->identity.is_md) {
        free(per_file); walked_free(files, file_count); free(source);
        mdy_documents_free(docs);
        if (error && error_len) snprintf(error, error_len, "out of memory");
        return -1;
    }
    e->identity.count = total;
    for (size_t i = 0, at = 0; i < file_count; i++) {
        for (size_t k = 0; k < per_file[i]; k++, at++) {
            e->identity.is_md[at] = (char)(files[i].is_md ? 1 : 0);
            /*
             * NULL here is a real value -- it is what a file with no identity
             * block has -- so a failed copy could not be told from one, and
             * the document quietly lost its defaults and its overrides. A
             * page came out changed, or did not come out at all, on a build
             * that reported success.
             */
            if (files[i].pre) {
                e->identity.pre[at] = mdy_yaml_clone(files[i].pre);
                if (!e->identity.pre[at]) goto ident_oom;
            }
            if (files[i].post) {
                e->identity.post[at] = mdy_yaml_clone(files[i].post);
                if (!e->identity.post[at]) goto ident_oom;
            }
            /* The parsed mapping goes to the FIRST document of the file —
             * only a .mdy is ever more than one, and a .mdy has no mapping. */
            e->identity.data[at] = k == 0 ? files[i].data : NULL;
        }
        if (per_file[i]) files[i].data = NULL;      /* the engine owns it now */
    }
    if (0) {
    ident_oom:
        free(per_file); walked_free(files, file_count); free(source);
        mdy_documents_free(docs);
        if (error && error_len) snprintf(error, error_len, "out of memory");
        return -1;
    }
    free(per_file);
    walked_free(files, file_count);

    int rc = open_documents(e, docs, error, error_len);
    free(source);
    if (rc != 0) return rc;

    /*
     * Now the imports, each resolved relative to the FILE that declared it —
     * the same rule a real relative JS import follows, not relative to the
     * package root.
     */
    Ancestors here = { e->graph.root, ancestors };
    for (size_t i = 0; i < e->graph.import_count; i++) {
        Import *imp = &e->graph.imports[i];

        char joined[4096];
        snprintf(joined, sizeof joined, "%s/%s", e->graph.root, imp->source_path);
        char file_dir[4096];
        dirname_of(joined, file_dir, sizeof file_dir);
        char child_dir[4096];
        resolve_path(file_dir, imp->spec, child_dir, sizeof child_dir);

        if (in_ancestors(&here, child_dir)) {
            if (error && error_len)
                snprintf(error, error_len, "mdy: import cycle detected — %s -> %s",
                         e->graph.root, child_dir);
            return -1;
        }

        mdy_engine *have = cache_get(cache, child_dir);
        if (have) { imp->set = have; continue; }

        /* The importer's session: an imported package's renders go in the
         * same memo as the site's, which is what they did when the memo was
         * one process-wide table. */
        mdy_engine *child = mdy_engine_new(e->session);
        if (!child) { if (error && error_len) snprintf(error, error_len, "out of memory"); return -1; }
        /* An `$.emit` from an imported package contributes to the SAME
         * outputs as the site that imported it — and so, it turns out, does
         * everything else the host listens for. This was three of the five
         * pairs, assigned by hand; `on_source` was not among them, so an
         * imported package's files were read without a `[read]` line where
         * node prints one. Whole struct, so the next callback added cannot
         * be forgotten here. */
        child->cb = e->cb;
        child->compose.tokens = token_table(e);
        /* In the cache before it is built, so a package that imports itself
         * through a diamond finds the one in progress rather than starting a
         * second build of it. */
        cache_put(cache, child_dir, child);
        if (open_dir_inner(child, child_dir, cache, &here, error, error_len) != 0) return -1;
        imp->set = child;
    }

    /*
     * After its own imports: post-order.
     *
     * A root that fails to be recorded is not a smaller list -- it is a
     * package the rebuild watcher never watches and the CLI never reports,
     * on a build that says it succeeded. Both halves are checked now; the
     * strdup was not checked at all, so the array could hold a NULL that
     * every later reader dereferenced.
     */
    if (cache->root_count == cache->root_cap) {
        size_t want = cache->root_cap ? cache->root_cap * 2 : 8;
        char **grown = realloc(cache->roots, want * sizeof *grown);
        if (!grown) {
            if (error && error_len) snprintf(error, error_len, "out of memory");
            return -1;
        }
        cache->roots = grown; cache->root_cap = want;
    }
    char *root_copy = strdup(e->graph.root);
    if (!root_copy) {
        if (error && error_len) snprintf(error, error_len, "out of memory");
        return -1;
    }
    cache->roots[cache->root_count++] = root_copy;
    return 0;
}

size_t mdy_engine_root_count(mdy_engine *e) {
    return (e->graph.cache && e->graph.owns_cache) ? e->graph.cache->root_count : (e->graph.root ? 1 : 0);
}

const char *mdy_engine_root_at(mdy_engine *e, size_t i) {
    if (e->graph.cache && e->graph.owns_cache)
        return i < e->graph.cache->root_count ? e->graph.cache->roots[i] : NULL;
    return i == 0 ? e->graph.root : NULL;
}


/*
 * A document's `tags`: what its front matter and data fences DECLARE, plus the
 * `#hashtags` its prose mentions, lowercased and deduped in order of first
 * appearance.
 *
 * Both halves matter and they are not the same thing. The scan runs over the
 * RAW body, before any code has run, because a tag is static metadata about
 * the authored document — that is what lets `$.withTag` answer without
 * rendering every document in the set to find out. A `#{{ topic }}` generated
 * at render time is not a tag.
 *
 * `tags` is set when there are any OR when a part declared the key at all, so
 * a document that says `tags: []` keeps its empty list rather than losing it.
 */
mdy_yaml *document_tags(const mdy_yaml_node *const *parts, size_t part_count,
                        const char *body, size_t body_len, int *oom) {
    *oom = 0;
    char (*tags)[128] = NULL;
    size_t count = 0, cap_t = 0;
    int declared_key = 0;

    for (size_t i = 0; i < part_count; i++) {
        if (!parts[i] || mdy_yaml_type_of(parts[i]) != MDY_YAML_MAPPING) continue;
        const mdy_yaml_node *v = mdy_yaml_get(parts[i], "tags");
        if (!v) continue;
        declared_key = 1;
        if (mdy_yaml_type_of(v) == MDY_YAML_STRING) {
            size_t n = 0;
            const char *t = mdy_yaml_string(v, &n);
            if (t) add_tag(&tags, &count, &cap_t, t, n);
        } else if (mdy_yaml_type_of(v) == MDY_YAML_SEQUENCE) {
            for (size_t k = 0; k < mdy_yaml_count(v); k++) {
                const mdy_yaml_node *item = mdy_yaml_at(v, k);
                size_t n = 0;
                const char *t = item ? mdy_yaml_string(item, &n) : NULL;
                if (t) add_tag(&tags, &count, &cap_t, t, n);
            }
        }
    }

    scan_hashtags(body, body_len, &tags, &count, &cap_t);

    mdy_yaml *out = NULL;
    if (count > 0 || declared_key) {
        /* A sequence of values, not a `tags:` block to be parsed back. The
         * text form is what made ONE tag with a quote in it unparseable, and
         * an unparseable block did not fail: the document fell back to
         * whatever its front matter said and was silently never lowercased or
         * deduplicated at all. */
        const char **items = count ? malloc(count * sizeof *items) : NULL;
        if (count && !items) { free(tags); *oom = 1; return NULL; }
        for (size_t k = 0; k < count; k++) items[k] = tags[k];
        mdy_yaml_builder *b = mdy_yaml_builder_new();
        if (b) mdy_yaml_put_strings(b, "tags", items, count);
        out = mdy_yaml_builder_done(b);
        free(items);
        if (!out) *oom = 1;
    }
    free(tags);
    return out;
}

int mdy_engine_open_dir(mdy_engine *e, const char *root, char *error, size_t error_len) {
    char abs[4096];
    absolute_root(root, abs, sizeof abs);

    ImportCache *cache = calloc(1, sizeof *cache);
    if (!cache) { if (error && error_len) snprintf(error, error_len, "out of memory"); return -1; }
    e->graph.owns_cache = 1;
    cache_put(cache, abs, e);
    return open_dir_inner(e, abs, cache, NULL, error, error_len);
}


/*
 * The document whose `path` is `entry` — where a directory starts. A query
 * rather than a scan, because the set already carries a unique index on
 * `path`, built for exactly this.
 */
int mdy_engine_entry(mdy_engine *e, const char *entry) {
    JsValue query = js_object_new(e->ctx);
    js_gc_protect(e->vm, &query);
    set_val(e, query, "path", str(e->vm, entry, strlen(entry)));
    /* NULL: this returns an index, and -1 is already reported as "entry
     * script not found" and exits the build. */
    JsValue hit = run_query(e, query, 1, NULL);
    js_gc_unprotect(e->vm, &query);
    if (!js_is_object(hit)) return -1;
    char *id = js_string_utf8(get_val(e, hit, "_id"));
    int at = id ? index_of_id(e, id, strlen(id)) : -1;
    free(id);
    return at;
}
