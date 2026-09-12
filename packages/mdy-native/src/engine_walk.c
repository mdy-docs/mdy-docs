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

/* The extensions mdy-docs reads dimensions for. A record carrying width and
 * height is what lets a template lay a page out without opening the file, and
 * `$.resize` refuses without them. */
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

static int is_image_ext(const char *ext) {
    static const char *const EXTS[] = {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
        ".svg", ".avif", ".ico", ".tiff", ".tif",
    };
    for (size_t i = 0; i < sizeof EXTS / sizeof *EXTS; i++) {
        size_t n = strlen(EXTS[i]);
        if (strlen(ext) != n) continue;
        size_t k = 0;
        while (k < n) {
            char a = ext[k], b = EXTS[i][k];
            if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
            if (a != b) break;
            k++;
        }
        if (k == n) return 1;
    }
    return 0;
}

int ends_with_ci(const char *s, const char *suffix) {
    size_t n = strlen(s), m = strlen(suffix);
    if (m > n) return 0;
    for (size_t i = 0; i < m; i++) {
        char a = s[n - m + i], b = suffix[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (a != b) return 0;
    }
    return 1;
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
 * One identity field as YAML: `key: "value"`, escaped the way the reader
 * unescapes it (read_quoted, yaml.c).
 *
 * It was an `snprintf("%s")` into a fixed array, which had two ways to go
 * wrong and took both. A file called `it"s.mdy` produced `name: "it"s.mdy"`,
 * which the reader took as `it` — the document's name, ext and path all
 * truncated at the quote, and nothing said so — while a backslash in a name
 * began an escape and a newline in one ended the line. A long enough path ran
 * off the end of the array and left the whole mapping unreadable.
 *
 * None of this would need escaping if identity were built as VALUES and handed
 * to mdy_bj_document, rather than written out and read back; that wants a way
 * to make an mdy_yaml mapping from C, which there is not. Until there is, the
 * writer and the reader have to agree, and this is the half that can be sure.
 */
/* Room for `more` bytes, growing from nothing. 0 when there is none. */
static int put_room(char **buf, size_t *len, size_t *cap, size_t more) {
    size_t need = *len + more;
    if (need <= *cap) return 1;
    size_t want = *cap ? *cap : 256;
    while (need > want) want *= 2;
    char *grown = realloc(*buf, want);
    if (!grown) return 0;
    *buf = grown;
    *cap = want;
    return 1;
}

/*
 * One double-quoted YAML scalar, escaped the way read_quoted unescapes it —
 * `\` and `"` named, control characters as `\xNN`, and everything else
 * including UTF-8 through as bytes, since only what the reader would take for
 * something else has to be named.
 *
 * Everything this file writes as YAML goes through here. It did not: identity
 * was pasted in with `%s` (which is B8) and so was every tag, where the
 * consequence was quieter and worse — one tag with a quote in it made the
 * whole generated `tags:` block unparseable, so the document's tags fell back
 * to whatever its front matter said and were silently never lowercased or
 * deduplicated at all.
 */
static void put_scalar(char **buf, size_t *len, size_t *cap, const char *value) {
    static const char H[] = "0123456789abcdef";
    size_t vlen = strlen(value);
    /* Four bytes out for one in is the worst an escape does (`\xNN`). */
    if (!put_room(buf, len, cap, vlen * 4 + 8)) return;

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

/* `key: "value"` on a line of its own. */
static void put_quoted(char **buf, size_t *len, size_t *cap,
                       const char *key, const char *value) {
    size_t klen = strlen(key);
    if (!put_room(buf, len, cap, klen + 4)) return;
    memcpy(*buf + *len, key, klen);
    *len += klen;
    (*buf)[(*len)++] = ':';
    (*buf)[(*len)++] = ' ';
    put_scalar(buf, len, cap, value);
    if (!put_room(buf, len, cap, 2)) return;
    (*buf)[(*len)++] = '\n';
    (*buf)[*len] = '\0';
}

/* `tags:` and its list, or `tags: []` for a document that declared the key
 * and has nothing to put under it. Written in one place because it was
 * written in two, character for character, and only one of them knew about
 * the empty case. */
static void put_tag_list(char **buf, size_t *len, size_t *cap,
                         const char (*tags)[128], size_t count) {
    if (count == 0) {
        if (!put_room(buf, len, cap, 16)) return;
        *len += (size_t)snprintf(*buf + *len, *cap - *len, "tags: []\n");
        return;
    }
    if (!put_room(buf, len, cap, 8)) return;
    *len += (size_t)snprintf(*buf + *len, *cap - *len, "tags:\n");
    for (size_t k = 0; k < count; k++) {
        if (!put_room(buf, len, cap, 8)) return;
        (*buf)[(*len)++] = ' ';
        (*buf)[(*len)++] = ' ';
        (*buf)[(*len)++] = '-';
        (*buf)[(*len)++] = ' ';
        put_scalar(buf, len, cap, tags[k]);
        if (!put_room(buf, len, cap, 2)) return;
        (*buf)[(*len)++] = '\n';
        (*buf)[*len] = '\0';
    }
}

/* The identity fields that are numbers. Whole ones — a size in bytes, a
 * picture's width — so `%.0f` is the digits and nothing else. */
static void put_number(char **buf, size_t *len, size_t *cap,
                       const char *key, double value) {
    size_t need = *len + strlen(key) + 48;
    if (need > *cap) {
        size_t want = *cap ? *cap : 256;
        while (need > want) want *= 2;
        char *grown = realloc(*buf, want);
        if (!grown) return;
        *buf = grown;
        *cap = want;
    }
    *len += (size_t)snprintf(*buf + *len, *cap - *len, "%s: %.0f\n", key, value);
}

static void put_block_scalar(char **buf, size_t *len, size_t *cap,
                             const char *keyname, const char *text, size_t tlen) {
    size_t need = *len + tlen * 2 + strlen(keyname) + 64;
    if (need > *cap) {
        while (need > *cap) *cap *= 2;
        char *grown = realloc(*buf, *cap);
        if (!grown) return;
        *buf = grown;
    }
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
        lowered[i] = (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
    }
    lowered[name_len] = '\0';
    for (size_t i = 0; i < *count; i++)
        if (strcmp((*tags)[i], lowered) == 0) return *count;
    if (*count == *cap) {
        size_t want = *cap ? *cap * 2 : 8;
        void *grown = realloc(*tags, want * sizeof **tags);
        if (!grown) return *count;
        *tags = grown;
        *cap = want;
    }
    memcpy((*tags)[(*count)++], lowered, name_len + 1);
    return *count;
}

static void scan_hashtags(const char *text, size_t tlen,
                          char (**out)[128], size_t *count, size_t *cap) {
    mdy_script *script = mdy_script_compile(text, tlen);

    char *prose = malloc(tlen + 1);
    if (!prose) { mdy_script_free(script); return; }
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

    /* A drive-letter path has no leading slash to restore; its first segment
     * is the drive, and `..` cannot climb above it. */
    int absolute = combined[0] == '/';
    size_t floor = (!absolute && fsx_is_absolute(combined)) ? 1 : 0;
    char *stack[256];
    size_t depth = 0;
    for (char *seg = strtok(combined, "/"); seg; seg = strtok(NULL, "/")) {
        if (strcmp(seg, ".") == 0) continue;
        if (strcmp(seg, "..") == 0) { if (depth > floor) depth--; continue; }
        if (depth < 256) stack[depth++] = seg;
    }
    size_t at = 0;
    if (absolute && out_len) out[at++] = '/';
    for (size_t i = 0; i < depth; i++) {
        if (i && at + 1 < out_len) out[at++] = '/';
        size_t n = strlen(stack[i]);
        if (at + n >= out_len) n = out_len - at - 1;
        memcpy(out + at, stack[i], n);
        at += n;
    }
    out[at < out_len ? at : out_len - 1] = '\0';
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
            if (e->import_count == e->import_cap) {
                size_t want = e->import_cap ? e->import_cap * 2 : 8;
                Import *grown = realloc(e->imports, want * sizeof *grown);
                if (!grown) { free(out); return NULL; }
                e->imports = grown;
                e->import_cap = want;
            }
            Import *imp = &e->imports[e->import_count++];
            imp->source_path = strdup(source_path);
            imp->spec = strdup(spec);
            imp->set = NULL;

            char rewritten[4096];
            int n = snprintf(rewritten, sizeof rewritten,
                "%% const %s = { "
                "render: (target, ctx) => $.__importRender(\"%s\", target, ctx === undefined ? {} : ctx), "
                "find: (query) => $.__importFind(\"%s\", query === undefined ? {} : query), "
                "findOne: (query) => $.__importFindOne(\"%s\", query === undefined ? {} : query), "
                "resize: (record, options) => $.__importResize(\"%s\", record, options === undefined ? {} : options) };",
                name, spec, spec, spec, spec);

            size_t need = at_out + indent + (size_t)n + 2;
            if (need > cap) {
                while (need > cap) cap *= 2;
                char *grown = realloc(out, cap);
                if (!grown) { free(out); return NULL; }
                out = grown;
            }
            memcpy(out + at_out, line, indent);
            at_out += indent;
            memcpy(out + at_out, rewritten, (size_t)n);
            at_out += (size_t)n;
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
        size_t want = c->cap ? c->cap * 2 : 8;
        char **d = realloc(c->dirs, want * sizeof *d);
        mdy_engine **s = realloc(c->sets, want * sizeof *s);
        if (!d || !s) { free(d); free(s); return; }
        c->dirs = d; c->sets = s; c->cap = want;
    }
    c->dirs[c->count] = strdup(dir);
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
    size_t start, len;   /* the file's text, inside the staging buffer */
    char *pre;           /* identity as a DEFAULT: a data file's, else NULL */
    mdy_yaml *data;      /* a data file's own mapping */
    char *post;          /* identity where it WINS */
    int is_md;
} WalkedFile;

static void walked_free(WalkedFile *files, size_t count) {
    for (size_t i = 0; i < count; i++) {
        free(files[i].pre);
        free(files[i].post);
        mdy_yaml_free(files[i].data);
    }
    free(files);
}

/* Once, on an engine nobody has opened yet: the root, the import cache and
 * the identity arrays are all taken to be empty here, and a site or a package
 * is walked exactly once. A rebuild is a NEW engine (cli.c's dev_rebuild). */
static int open_dir_inner(mdy_engine *e, const char *root, ImportCache *cache,
                          const Ancestors *ancestors, char *error, size_t error_len) {
    if (error && error_len) error[0] = '\0';
    e->root = strdup(root);
    e->cache = cache;

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
     * They used to be one source joined by the `---` the splitter reads,
     * which looks the same until a file holds no document: joined, an empty
     * .mdy is a blank chunk between two separators and the splitter drops it,
     * while the walk had counted a document and an identity for it. Every
     * identity after it then belonged to the wrong document.
     */
    size_t cap = 65536, len = 0;
    char *source = malloc(cap);
    if (!source) { free(listing); return -1; }
    source[0] = '\0';

    WalkedFile *files = NULL;
    size_t file_count = 0, file_cap = 0;

    for (const char *rel = listing; *rel; rel += strlen(rel) + 1) {
        if (!is_source(rel)) continue;
        if (e->on_source) e->on_source(e->on_source_ud, rel);

        const char *name = basename_of(rel);
        const char *ext = extension_of(name);

        double size = 0, mtime = 0;
        fsx_stat(root, rel, &size, &mtime);

        size_t body_len = 0;
        char *body = NULL;
        int is_mdy = ends_with_ci(rel, ".mdy");
        int is_md = ends_with_ci(rel, ".md");
        int is_yaml = ends_with_ci(rel, ".yaml") || ends_with_ci(rel, ".yml");

        int is_image = is_image_ext(ext);
        uint8_t *bytes = NULL;
        if (is_mdy || is_md || is_yaml || is_image) bytes = fsx_read(root, rel, &body_len);

        /*
         * The record. `path` is written LAST of the identity fields for the
         * reason mdy-docs gives: a data file may declare its own `name` or
         * `size` and identity silently shadowing that would make the file's
         * own data unreachable — but `path` is structurally required to be
         * real, because everything resolves documents by it.
         */
        /* Identity, kept OUT of the text — see `identity` on the engine. */
        char when[40];
        iso8601_utc(mtime, when, sizeof when);
        char *ident = NULL;
        size_t ilen = 0, icap = 0;
        put_quoted(&ident, &ilen, &icap, "name", name);
        put_quoted(&ident, &ilen, &icap, "ext", ext);
        put_number(&ident, &ilen, &icap, "size", size);
        put_quoted(&ident, &ilen, &icap, "mtime", when);
        put_quoted(&ident, &ilen, &icap, "path", rel);
        /*
         * A picture's dimensions, read from its header. Not decodable —
         * corrupt, truncated, a variant this does not know — is not an error:
         * it is still a real file and still gets its record, just without
         * width and height.
         */
        if (is_image && bytes) {
            int iw = 0, ih = 0;
            if (mdy_image_size(bytes, body_len, &iw, &ih) == 0) {
                put_number(&ident, &ilen, &icap, "width", iw);
                put_number(&ident, &ilen, &icap, "height", ih);
            }
        }

        size_t need = len + body_len + 4096;
        if (need > cap) {
            while (need > cap) cap *= 2;
            char *grown = realloc(source, cap);
            if (!grown) { free(bytes); free(source); free(listing);
                          walked_free(files, file_count); return -1; }
            source = grown;
        }
        size_t file_start = len;

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
            len += (size_t)snprintf(source + len, cap - len, "+++\n");
            if (bytes) {
                put_block_scalar(&source, &len, &cap, "body", (const char *)bytes, body_len);
                put_tags_from_text(&source, &len, &cap, (const char *)bytes, body_len);
            }
            len += (size_t)snprintf(source + len, cap - len, "+++\n");
        }

        if (is_mdy && bytes) {
            /* `% import` is rewritten before the compiler ever sees the text —
             * a real import statement is not legal inside a function body, and
             * every `%` line becomes one. */
            size_t rlen = 0;
            char *rewritten = rewrite_imports(e, rel, (const char *)bytes, body_len, &rlen);
            body = rewritten ? rewritten : (char *)bytes;
            size_t blen = rewritten ? rlen : body_len;

            size_t need2 = len + blen + 64;
            if (need2 > cap) {
                while (need2 > cap) cap *= 2;
                char *grown = realloc(source, cap);
                if (!grown) { if (rewritten) free(rewritten); free(bytes); free(source);
                              free(listing); walked_free(files, file_count); return -1; }
                source = grown;
            }
            memcpy(source + len, body, blen);
            len += blen;
            if (rewritten) free(rewritten);
        } else {
            memcpy(source + len, PLACEHOLDER_BODY, strlen(PLACEHOLDER_BODY));
            len += strlen(PLACEHOLDER_BODY);
        }
        source[len] = '\0';

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
            mdy_yaml_type kind = own ? mdy_yaml_type_of(mdy_yaml_root(own)) : MDY_YAML_NULL;
            if (!own)
                fprintf(stderr, "mdy: %s — %s keeps its raw identity, no parsed fields\n",
                        yerr[0] ? yerr : "unreadable YAML", rel);
            else if (kind == MDY_YAML_NULL)
                { mdy_yaml_free(own); own = NULL; }      /* nothing in it, nothing to say */
            else if (kind != MDY_YAML_MAPPING) {
                fprintf(stderr, "mdy: %s must be a YAML mapping — %s keeps its raw identity,"
                                " no parsed fields\n", rel, rel);
                mdy_yaml_free(own);
                own = NULL;
            }
        }

        /* One entry per FILE, with its text as a span. How many documents
         * that text is, the splitter says below. */
        if (file_count == file_cap) {
            size_t want = file_cap ? file_cap * 2 : 16;
            WalkedFile *grown = realloc(files, want * sizeof *grown);
            if (!grown) { mdy_yaml_free(own); free(ident); free(bytes); free(source);
                          free(listing); walked_free(files, file_count); return -1; }
            files = grown;
            file_cap = want;
        }
        WalkedFile *f = &files[file_count++];
        f->start = file_start;
        f->len = len - file_start;
        f->data = own;
        f->is_md = is_md;
        if (is_yaml) {
            /* A default: the file's own fields win, except `path`. */
            char *only_path = NULL;
            size_t plen = 0, pcap = 0;
            put_quoted(&only_path, &plen, &pcap, "path", rel);
            f->pre = ident;
            f->post = only_path;
        } else {
            f->pre = NULL;
            f->post = ident;
        }
        free(bytes);
    }

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
    e->ident_pre = calloc(total ? total : 1, sizeof *e->ident_pre);
    e->ident_data = calloc(total ? total : 1, sizeof *e->ident_data);
    e->ident_post = calloc(total ? total : 1, sizeof *e->ident_post);
    e->ident_is_md = calloc(total ? total : 1, 1);
    if (!e->ident_pre || !e->ident_data || !e->ident_post || !e->ident_is_md) {
        free(per_file); walked_free(files, file_count); free(source);
        mdy_documents_free(docs);
        if (error && error_len) snprintf(error, error_len, "out of memory");
        return -1;
    }
    e->identity_count = total;
    for (size_t i = 0, at = 0; i < file_count; i++) {
        for (size_t k = 0; k < per_file[i]; k++, at++) {
            e->ident_is_md[at] = (char)(files[i].is_md ? 1 : 0);
            e->ident_pre[at] = files[i].pre ? strdup(files[i].pre) : NULL;
            e->ident_post[at] = files[i].post ? strdup(files[i].post) : NULL;
            /* The parsed mapping goes to the FIRST document of the file —
             * only a .mdy is ever more than one, and a .mdy has no mapping. */
            e->ident_data[at] = k == 0 ? files[i].data : NULL;
        }
        if (per_file[i]) files[i].data = NULL;      /* the engine owns it now */
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
    Ancestors here = { e->root, ancestors };
    for (size_t i = 0; i < e->import_count; i++) {
        Import *imp = &e->imports[i];

        char joined[4096];
        snprintf(joined, sizeof joined, "%s/%s", e->root, imp->source_path);
        char file_dir[4096];
        dirname_of(joined, file_dir, sizeof file_dir);
        char child_dir[4096];
        resolve_path(file_dir, imp->spec, child_dir, sizeof child_dir);

        if (in_ancestors(&here, child_dir)) {
            if (error && error_len)
                snprintf(error, error_len, "mdy: import cycle detected — %s -> %s",
                         e->root, child_dir);
            return -1;
        }

        mdy_engine *have = cache_get(cache, child_dir);
        if (have) { imp->set = have; continue; }

        mdy_engine *child = mdy_engine_new();
        if (!child) { if (error && error_len) snprintf(error, error_len, "out of memory"); return -1; }
        /* An `$.emit` from an imported package contributes to the SAME
         * outputs as the site that imported it. */
        child->on_emit = e->on_emit;
        child->on_emit_ud = e->on_emit_ud;
        child->on_publish = e->on_publish;
        child->on_publish_ud = e->on_publish_ud;
        child->on_binary = e->on_binary;
        child->on_binary_ud = e->on_binary_ud;
        child->tokens = token_table(e);
        /* In the cache before it is built, so a package that imports itself
         * through a diamond finds the one in progress rather than starting a
         * second build of it. */
        cache_put(cache, child_dir, child);
        if (open_dir_inner(child, child_dir, cache, &here, error, error_len) != 0) return -1;
        imp->set = child;
    }

    /* After its own imports: post-order. */
    if (cache->root_count == cache->root_cap) {
        size_t want = cache->root_cap ? cache->root_cap * 2 : 8;
        char **grown = realloc(cache->roots, want * sizeof *grown);
        if (grown) { cache->roots = grown; cache->root_cap = want; }
    }
    if (cache->root_count < cache->root_cap)
        cache->roots[cache->root_count++] = strdup(e->root);
    return 0;
}

size_t mdy_engine_root_count(mdy_engine *e) {
    return (e->cache && e->owns_cache) ? e->cache->root_count : (e->root ? 1 : 0);
}

const char *mdy_engine_root_at(mdy_engine *e, size_t i) {
    if (e->cache && e->owns_cache)
        return i < e->cache->root_count ? e->cache->roots[i] : NULL;
    return i == 0 ? e->root : NULL;
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
void put_document_tags(char **buf, size_t *len, size_t *cap,
                              const mdy_yaml_node *const *parts, size_t part_count,
                              const char *body, size_t body_len) {
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

    if (count > 0 || declared_key) put_tag_list(buf, len, cap, tags, count);
    free(tags);
}

int mdy_engine_open_dir(mdy_engine *e, const char *root, char *error, size_t error_len) {
    char abs[4096];
    absolute_root(root, abs, sizeof abs);

    ImportCache *cache = calloc(1, sizeof *cache);
    if (!cache) { if (error && error_len) snprintf(error, error_len, "out of memory"); return -1; }
    e->owns_cache = 1;
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
    JsValue hit = run_query(e, query, 1);
    js_gc_unprotect(e->vm, &query);
    if (!js_is_object(hit)) return -1;
    char *id = js_string_utf8(js_object_get(e->vm, hit, key(e->vm, "_id")));
    int at = id ? index_of_id(e, id, strlen(id)) : -1;
    free(id);
    return at;
}
