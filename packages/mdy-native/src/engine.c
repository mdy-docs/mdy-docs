/* The contract, and what is not here yet, is in engine.h. */
#include <stdarg.h>
#include <stddef.h>
#include "engine_internal.h"
#include "nis.h"
#include "xalloc.h"

/*
 * The debug switches, read ONCE.
 *
 * MDY_MEMO_DEBUG was three getenv calls per render and MDY_LINEMAP_DEBUG one
 * per produced line. Measured before changing it, because §4 filed this as a
 * hot path and it is worth knowing by how much: `docs-site` built with two
 * thousand extra environment variables was 1.9% slower than with a normal
 * one, median of nine. So the cost is real and small. What this buys is that
 * it is provably nothing, and that a switch cannot be read differently in two
 * places — the same idiom `key()` already uses for MDY_GC_STRESS.
 */
static int debug_flag(const char *name, int *cache) {
    if (*cache < 0) *cache = getenv(name) != NULL;
    return *cache;
}
static int memo_debug(void)    { static int c = -1; return debug_flag("MDY_MEMO_DEBUG", &c); }
static int linemap_debug(void) { static int c = -1; return debug_flag("MDY_LINEMAP_DEBUG", &c); }

/* ---- the site's three small natives ------------------------------------------
 *
 * These are on `$` for the reason script-site.js gives: each is a primitive a
 * template cannot compute for itself, and none of them decides policy. The
 * script decides what to index and what goes in a feed; these only do the
 * arithmetic — which in `rfc822`'s case a template genuinely cannot, because
 * the VM forbids `new`.
 */

static const char *const STOPWORDS[] = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
    "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
    "their", "then", "there", "these", "they", "this", "to", "was", "will",
    "with",
};

static int is_stopword(const char *w, size_t len) {
    for (size_t i = 0; i < sizeof STOPWORDS / sizeof *STOPWORDS; i++)
        if (strlen(STOPWORDS[i]) == len && memcmp(STOPWORDS[i], w, len) == 0) return 1;
    return 0;
}

/*
 * `$.tokenize` — the search widget's word list. Lowercased, split on anything
 * that is not [a-z0-9], words of length > 1, stopwords out, duplicates out,
 * in order of first appearance.
 *
 * The split is on the ASCII class exactly as the JavaScript regex is written,
 * so a byte >= 0x80 is a separator here just as it is there. That looks like a
 * bug against a Unicode corpus and is not one to fix HERE: the widget shipped
 * in `static/search.js` tokenizes a visitor's query with the same rule, and a
 * word list that disagrees with the query tokenizer is a search box that finds
 * nothing. The two move together or not at all.
 */
static bool tokenize_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                            int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* an embedder native: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    char *text = argc > 0 ? js_string_utf8(args[0]) : NULL;
    if (!text) { *result = js_array_new(ctx, 0); return true; }

    size_t len = strlen(text);
    /* The result is what a site INDEXES, so a truncated word list is a
     * search box that cannot find a page on a build that succeeded. Nothing
     * below may answer a refused allocation with a short list. See
     * xalloc.h. */
    char *word = mdy_xmalloc(len + 1);
    /*
     * The words are collected and deduplicated ON THIS SIDE, and the JS array
     * is built once at the end.
     *
     * Asking the array what it already holds means converting every entry back
     * out of UTF-16 for every word — quadratic, with an allocation per
     * comparison. On a real corpus that was half of the entire build.
     */
    char **words = NULL;
    size_t count = 0, cap = 0;
    /* Open-addressed index over `words`, power of two, kept under half full. */
    size_t *slots = NULL;
    size_t slot_cap = 0;

    size_t i = 0;
    while (i < len) {
        /*
         * The JavaScript lowercases the WHOLE string and only then splits on
         * `[^a-z0-9]`, so the case mapping runs first and can itself produce
         * an ASCII letter: `İ` folds to `i` followed by a combining dot, which
         * both keeps the letter and ENDS the word. Lowercasing only ASCII gets
         * both of those wrong, and the search index then disagrees with the
         * query the widget tokenizes.
         */
        size_t wlen = 0;
        while (i < len) {
            uint32_t cp = 0, lc[2];
            size_t w = mdy_utf8_decode(text + i, len - i, &cp);
            size_t n = mdy_lower_full(cp, lc);
            if (!((lc[0] >= 'a' && lc[0] <= 'z') || (lc[0] >= '0' && lc[0] <= '9'))) break;
            word[wlen++] = (char)lc[0];
            i += w;
            if (n > 1 && !((lc[1] >= 'a' && lc[1] <= 'z') || (lc[1] >= '0' && lc[1] <= '9')))
                break;
        }
        while (i < len) {                       /* the separator run */
            uint32_t cp = 0, lc[2];
            size_t w = mdy_utf8_decode(text + i, len - i, &cp);
            mdy_lower_full(cp, lc);
            if ((lc[0] >= 'a' && lc[0] <= 'z') || (lc[0] >= '0' && lc[0] <= '9')) break;
            i += w;
        }
        word[wlen] = '\0';
        if (wlen <= 1 || is_stopword(word, wlen)) continue;

        if (count * 2 + 2 > slot_cap) {         /* grow and rehash */
            size_t want = slot_cap ? slot_cap * 2 : 64;
            size_t *grown = mdy_xmalloc(want * sizeof *grown);
            for (size_t k = 0; k < want; k++) grown[k] = (size_t)-1;
            for (size_t k = 0; k < count; k++) {
                uint64_t h = 1469598103934665603u;
                for (const char *p = words[k]; *p; p++)
                    h = (h ^ (unsigned char)*p) * 1099511628211u;
                size_t at = (size_t)(h & (want - 1));
                while (grown[at] != (size_t)-1) at = (at + 1) & (want - 1);
                grown[at] = k;
            }
            free(slots);
            slots = grown;
            slot_cap = want;
        }

        uint64_t h = 1469598103934665603u;
        for (size_t k = 0; k < wlen; k++) h = (h ^ (unsigned char)word[k]) * 1099511628211u;
        size_t at = (size_t)(h & (slot_cap - 1));
        int seen = 0;
        while (slots[at] != (size_t)-1) {
            const char *have = words[slots[at]];
            if (strlen(have) == wlen && memcmp(have, word, wlen) == 0) { seen = 1; break; }
            at = (at + 1) & (slot_cap - 1);
        }
        if (seen) continue;

        if (count == cap) {
            size_t want = cap ? cap * 2 : 32;
            words = mdy_xrealloc(words, want * sizeof *words);
            cap = want;
        }
        words[count] = mdy_xmalloc(wlen + 1);
        memcpy(words[count], word, wlen + 1);
        slots[at] = count;
        count++;
    }
    free(word);
    free(text);
    free(slots);

    /* In order of first appearance, which is what `new Set` preserves. */
    JsValue out = js_array_new(ctx, (uint32_t)count);
    js_gc_protect(e->vm, &out);
    for (size_t k = 0; k < count; k++) {
        push_item(e, out, str(e->vm, words[k], strlen(words[k])));
        free(words[k]);
    }
    js_gc_unprotect(e->vm, &out);
    free(words);
    *result = out;
    return true;
}

/*
 * `$.rfc822` — a canonical YYYY-MM-DD to the form an RSS `pubDate` needs.
 * Howard Hinnant's days_from_civil, which is exact for every proleptic
 * Gregorian date and needs no time.h: `timegm` is not portable and `mktime`
 * would read the machine's timezone, which would make a feed's contents
 * depend on where it was built.
 */
static bool rfc822_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                          int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* an embedder native: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    *result = js_undefined();
    char *s = argc > 0 ? js_string_utf8(args[0]) : NULL;
    if (!s) return true;

    int y = 0, m = 0, d = 0;
    if (sscanf(s, "%4d-%2d-%2d", &y, &m, &d) != 3 || m < 1 || m > 12 || d < 1 || d > 31) {
        free(s);
        return true;   /* `new Date('nonsense').toUTCString()` is "Invalid Date" */
    }
    free(s);

    long yy = y - (m <= 2);
    long era = (yy >= 0 ? yy : yy - 399) / 400;
    unsigned long yoe = (unsigned long)(yy - era * 400);
    unsigned long doy = (unsigned long)((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1);
    unsigned long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    long days = era * 146097 + (long)doe - 719468;
    /* 1970-01-01 was a Thursday; C's % keeps the sign of the dividend. */
    int dow = (int)(((days % 7) + 11) % 7);

    static const char *const DAYS[] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
    static const char *const MONTHS[] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
    char out[64];
    int n = snprintf(out, sizeof out, "%s, %02d %s %04d 00:00:00 GMT",
                     DAYS[dow], d, MONTHS[m - 1], y);
    *result = str(e->vm, out, (size_t)n);
    return true;
}

/* ---- rendering, and rendering from inside a render --------------------------- */

/* A render produces a TREE; HTML is what the outermost caller asks for at the
 * end. That is the whole reason `$.render` can return a token. */
/* `req` is what the caller is answering with — `$.render(target, data)`'s
 * second argument, and an empty object for a render nobody asked a question
 * of. MDY neither reads it nor cares what shape it is. */
/*
 * A render produces a tree, and — when `wrote` is given — the TEXT the
 * document's own code wrote, before any of it is read as MDY.
 *
 * Those are two different strings and `$.text` wants the second. mdy.js says
 * why in one line: "a feed rendered only for its text should not be read as
 * MDY on the way past". A JSON record written by a document is the case that
 * proves it — parse it and `\"` inside a caption comes back as `"`, and what
 * the caller gets is no longer JSON.
 */
static mdy_doc *render_tree_out(mdy_engine *e, size_t index, JsValue req,
                                char **wrote, char *error, size_t error_len);
static mdy_doc *render_tree(mdy_engine *e, size_t index, JsValue req,
                            char *error, size_t error_len);

/*
 * `$.render(target, data)` — the target resolved, rendered, parked, and a
 * token handed back.
 *
 * A target is an index, or a query, or a document a `$.find` already returned
 * (which carries its own `_id`). All three end at a document index, which is
 * what the `_id` to index map is for.
 */
static int resolve_target(mdy_engine *e, JsValue target, int *failed) {
    if (js_is_number(target)) {
        double at = js_get_number(target);
        return (at >= 0 && at < (double)e->set.count) ? (int)at : -1;
    }
    if (!js_is_object(target)) return -1;

    /* A document from `$.find` carries the id it was inserted with. */
    char *id = js_string_utf8(get_val(e, target, "_id"));
    if (id) {
        int at = index_of_id(e, id, strlen(id));
        free(id);
        if (at >= 0) return at;
    }

    JsValue hit = run_query(e, target, 1, failed);
    if (!js_is_object(hit)) return -1;
    char *hit_id = js_string_utf8(get_val(e, hit, "_id"));
    if (!hit_id) return -1;
    int at = index_of_id(e, hit_id, strlen(hit_id));
    free(hit_id);
    return at;
}

static bool render_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                          int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    int failed = 0;
    int at = argc > 0 ? resolve_target(e, args[0], &failed) : -1;
    if (at < 0) {
        const char *msg = failed ? "mdy-engine: $.render could not run the query"
                                 : "mdy-engine: $.render found no such document";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }

    char err[256];
    mdy_doc *doc = render_tree(e, (size_t)at,
                               argc > 1 ? args[1] : js_undefined(), err, sizeof err);
    if (!doc) {
        /*
         * A nested render's failure is passed through rather than wrapped
         * again. mdy-docs wraps at every level, so a cycle reports
         * "document 0 failed: document 0 failed: …" thirty times over and the
         * reason falls off the end. The first message is the one that says
         * something.
         */
        char msg[320];
        if (strncmp(err, "mdy-engine:", 11) == 0)
            snprintf(msg, sizeof msg, "%s", err);
        else
            snprintf(msg, sizeof msg, "mdy-engine: document %d failed: %s", at, err);
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }

    char *token = hold_tree_as(e, doc, (mdy_node *)mdy_root(doc),
                               e->compose.last_render_key[0] ? e->compose.last_render_key : NULL);
    *result = str(e->vm, token, strlen(token));
    free(token);
    return true;
}

/* `$.text(target)` — the same render, as the text it holds rather than a
 * token. What a document's own code wrote, with no markup around it. */
static void collect_text_into(const mdy_node *n, char **out, size_t *len, size_t *cap) {
    if (n->type == MDY_TEXT && n->text) {
        size_t add = mdy_text_len(n);
        if (*len + add + 1 > *cap) {
            /*
             * `*cap` moved BEFORE the allocation was known to have succeeded,
             * and the early return left it moved: the next call through here
             * saw room that did not exist and wrote past the end of the
             * buffer. A heap overflow reached from an allocation failure
             * rather than at it -- the same shape as cache_put's, found by
             * the same sweep. `want` is local until it is real, and there is
             * no early return now. See xalloc.h.
             */
            size_t want = *cap;
            while (*len + add + 1 > want) want = want ? want * 2 : 256;
            *out = mdy_xrealloc(*out, want);
            *cap = want;
        }
        memcpy(*out + *len, n->text, add);
        *len += add;
        (*out)[*len] = '\0';
    }
    if (n->type == MDY_COMMENT || n->type == MDY_DOCTYPE) return;
    for (const mdy_node *c = n->first; c; c = c->next) collect_text_into(c, out, len, cap);
}

static bool text_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                        int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    int failed = 0;
    int at = argc > 0 ? resolve_target(e, args[0], &failed) : -1;
    if (at < 0) {
        const char *msg = failed ? "mdy-engine: $.text could not run the query"
                                 : "mdy-engine: $.text found no such document";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    char err[256];
    char *text = NULL;
    mdy_doc *doc = render_tree_out(e, (size_t)at,
                                   argc > 1 ? args[1] : js_undefined(), &text,
                                   err, sizeof err);
    if (!doc) {
        char msg[320];
        if (strncmp(err, "mdy-engine:", 11) == 0) snprintf(msg, sizeof msg, "%s", err);
        else snprintf(msg, sizeof msg, "mdy-engine: document %d failed: %s", at, err);
        *result = str(e->vm, msg, strlen(msg));
        free(text);
        return false;
    }
    size_t len = text ? strlen(text) : 0;
    *result = str(e->vm, text ? text : "", len);
    free(text);
    /* The tree outlives this call — a token spliced into it points at held
     * nodes — but nothing will ask for it by name. */
    keep_alive(e, doc);
    return true;
}

/*
 * `$.emit(path, content)` — a named output. Tokens in the content become the
 * HTML they hold, because a file is a string and that is the shape it can
 * hold.
 */
static bool emit_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                        int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    if (argc < 2) { *result = js_null(); return true; }
    char *path = js_string_utf8(args[0]);
    char *content = js_string_utf8(args[1]);
    int failed = 0;
    if (path && content) {
        char *filled = fill_tokens(e, content, strlen(content));
        /* fill_tokens returns NULL only when it could not build the string --
         * emitting the page without its composed pieces, or not at all, is a
         * file that is wrong rather than a file that is missing. */
        if (!filled) failed = 1;
        else if (e->cb.on_emit) e->cb.on_emit(e->cb.on_emit_ud, path, filled);
        free(filled);
    }
    free(path);
    free(content);
    if (failed) {
        const char *msg = "mdy-engine: $.emit could not build the page";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    *result = js_null();
    return true;
}

/* ---- the document set --------------------------------------------------------
 *
 * Opening a source is mdy-docs' `openDocumentSet`: every document's data — its
 * front matter merged with its ```data fences — goes into a nisaba collection,
 * and `$.find` runs real queries against it.
 *
 * The `_id` to index map is not bookkeeping. A query answers in whatever order
 * the database walks its keys, and a document set answers in DOCUMENT order —
 * so a hit is mapped back to the document it came from and the answer sorted
 * by that. Without it a page's list of siblings would reorder between builds.
 */


/* ---- opening a set ---------------------------------------------------------- */

/* nisaba keys its primary tree on OID bytes. Its storage is four callbacks
 * (see nis.c), and here they are a buffer: a document set lives as long as the
 * engine that opened it and never wanted a file. The nis_* prototypes are
 * nis.h's, included at the top rather than hand-declared here. */

static void close_set(mdy_engine *e) {
    for (size_t i = 0; i < e->set.count; i++) mdy_data_free(e->set.docs[i].fences);
    free(e->set.docs);
    free(e->set.ids);
    free(e->set.oid_slots);
    mdy_documents_free(e->set.source_docs);
    /*
     * The collection goes with the documents that are in it. Nothing closed
     * it, so every engine left behind a primary store, an index store, two
     * B+trees and a slot in nisaba's table — a build is one engine and does
     * not care, but `mdy dev` and `--watch` are a new engine per save, and
     * the process grew by a third of a megabyte on every keystroke that
     * landed.
     *
     * The handle goes back to -1 rather than being reused, which is what
     * makes opening a set TWICE on one engine mean what it says: otherwise
     * the second open inserts into the collection the first one filled and
     * the old documents are still there to be found.
     */
    if (e->set.handle >= 0) nis_close(e->set.handle);
    e->set.handle = -1;
    e->set.docs = NULL;
    e->set.ids = NULL;
    e->set.oid_slots = NULL;
    e->set.oid_cap = 0;
    e->set.source_docs = NULL;
    e->set.count = 0;
}

int mdy_engine_open(mdy_engine *e, const char *source, size_t len,
                    char *error, size_t error_len) {
    if (error && error_len) error[0] = '\0';
    mdy_documents *docs = mdy_split_documents(source, len);
    if (!docs) { close_set(e); return -1; }
    return open_documents(e, docs, error, error_len);
}

/*
 * The rest of opening a set, once the documents are in hand — however they
 * were arrived at. One source split here; a file each, split on its own, when
 * a directory is the set (open_dir_inner). Takes ownership of `docs`.
 */
static int insert_one_document(mdy_engine *e, size_t i, char *error, size_t error_len) {
    Document *d = &e->set.docs[i];
    d->chunk = mdy_documents_at(e->set.source_docs, i);
    mdy_chunk body;
    mdy_split_frontmatter(d->chunk.text, d->chunk.len, &d->matter, &body);
    /*
     * NULL from a non-NULL body means mdy_data_extract could not
     * allocate, not that the body has no ```data fences -- a body with
     * none comes back as an empty set. Treating the two alike dropped
     * every fence the document had, so its data and its tags simply were
     * not there, on a build that reported success.
     */
    d->fences = mdy_data_extract(body.text, body.len);
    if (!d->fences && body.text) {
        if (error && error_len) snprintf(error, error_len, "out of memory");
        return -1;
    }
    /* The lines the front matter took, so a position in the body can
     * step over them — mdy-docs' `lineOffset`. */
    d->matter_lines = 0;
    if (body.text >= d->chunk.text && body.text <= d->chunk.text + d->chunk.len)
        for (const char *p = d->chunk.text; p < body.text; p++)
            if (*p == '\n') d->matter_lines++;
    d->is_markdown = e->identity.is_md && i < e->identity.count && e->identity.is_md[i];

    /*
     * The document's DATA: its front matter, with each ```data fence
     * merged over it — `Object.assign({}, frontMatter, ...blocks)`. Its
     * text never goes in, which is what a measured build of mdy-docs
     * shows it doing.
     */
    char err[256] = { 0 };
    mdy_yaml *matter = NULL;
    if (d->matter.len) matter = mdy_yaml_parse(d->matter.text, d->matter.len, err, sizeof err);
    /*
     * A front matter the parser could not READ is this document's problem
     * and is left as no data, which is what node does with it too. One it
     * could not ALLOCATE for is the process's problem, and leaving it as
     * no data means building the page without its fields and reporting
     * success. MDY_YAML_OOM exists to tell those apart.
     */
    if (!matter && d->matter.len && strcmp(err, MDY_YAML_OOM) == 0) {
        if (error && error_len) snprintf(error, error_len, "out of memory");
        return -1;
    }

    size_t fence_count = d->fences ? mdy_data_count(d->fences) : 0;
    /* identity-as-default + front matter + fences + tags + data + identity */
    const mdy_yaml_node **maps = calloc(fence_count + 5, sizeof *maps);
    mdy_yaml **parsed = calloc(fence_count + 1, sizeof *parsed);
    if (!maps || !parsed) { free(maps); free(parsed); mdy_yaml_free(matter); return -1; }

    size_t used = 0;
    /* All four are freed by the cleanup below, which the OOM jumps reach,
     * so all four are declared before the first of those jumps. */
    mdy_yaml *tag_map = NULL;
    int oom = 0;
    /* Identity is VALUES, built by the walk — no text in between to
     * parse, so nothing here can fail and nothing needed escaping. */
    if (e->identity.pre && i < e->identity.count && e->identity.pre[i])
        maps[used++] = mdy_yaml_root(e->identity.pre[i]);
    if (matter) maps[used++] = mdy_yaml_root(matter);
    for (size_t f = 0; f < fence_count; f++) {
        const mdy_data_fence *fence = mdy_data_at(d->fences, f);
        err[0] = '\0';
        mdy_yaml *y = mdy_yaml_parse(fence->source, fence->source_len, err, sizeof err);
        /* A malformed fence is skipped, as node skips it. One that could
         * not be allocated for is not the same thing. */
        if (!y && strcmp(err, MDY_YAML_OOM) == 0) goto docs_oom;
        if (!y) continue;
        parsed[f] = y;
        maps[used++] = mdy_yaml_root(y);
    }


    /*
     * `tags`, from the parts that declare them plus the hashtags in the
     * body. A mapping of its own, merged after the parts it was computed
     * from, because it REPLACES whatever `tags` they held with the merged
     * list — which is what Object.assign then a single `data.tags = tags`
     * does on the JavaScript side.
     */
    {
        size_t body_len = 0;
        const char *body = mdy_data_body(d->fences, &body_len);
        /* `if (text)` here meant a document silently kept none of its
         * tags -- and tags decide which indexes it appears in. */
        int tags_oom = 0;
        tag_map = document_tags(maps, used, body ? body : "", body_len, &tags_oom);
        if (tags_oom) goto docs_oom;
        if (tag_map) maps[used++] = mdy_yaml_root(tag_map);
    }

    /* A data file's own mapping, after everything the document itself
     * said and before the one field identity still wins. It is merged
     * HERE, not as front matter, so `tags` above never saw it: a data
     * record's `tags` are its own value, not the normalized hashtag list
     * a document body earns — which is where mdy-docs' `meta` leaves
     * them too. */
    if (e->identity.data && i < e->identity.count && e->identity.data[i])
        maps[used++] = mdy_yaml_root(e->identity.data[i]);

    /* After them, where identity WINS — and, for a data file, the one
     * field that must be real whatever it declared. */
    if (e->identity.post && i < e->identity.count && e->identity.post[i])
        maps[used++] = mdy_yaml_root(e->identity.post[i]);

    mdy_oid_next(d->oid);
    memcpy(e->set.ids[i], d->oid, 12);

    bj_builder *b = bj_builder_new();
    int ok = b && mdy_bj_document(b, d->oid, maps, used) == 0 && !bj_builder_error(b);
    if (ok) {
        size_t dlen = 0;
        const uint8_t *bytes = bj_builder_data(b, &dlen);
        ok = bytes && nis_insert(e->set.handle, bytes, (uint32_t)dlen) == 0;
    }
    bj_builder_free(b);
    if (0) {
        /*
         * Every mdy_yaml_parse in this loop can fail two ways, and only
         * one of them is the document's fault. A malformed part is
         * skipped -- node skips it too -- but a part that could not be
         * ALLOCATED for is the process failing, and skipping it builds
         * the page without its data and calls that a success. The four
         * call sites above jump here; the cleanup is the loop's own.
         */
    docs_oom:
        ok = 0;
        oom = 1;
    }
    mdy_yaml_free(matter);
    mdy_yaml_free(tag_map);
    for (size_t f = 0; f < fence_count; f++) mdy_yaml_free(parsed[f]);
    free(maps);
    free(parsed);

    if (!ok) {
        if (error && error_len) {
            if (oom) snprintf(error, error_len, "out of memory");
            else snprintf(error, error_len, "document %zu could not be inserted", i);
        }
        return -1;
    }
    return 0;
}

int open_documents(mdy_engine *e, mdy_documents *docs,
                          char *error, size_t error_len) {
    close_set(e);
    e->set.source_docs = docs;

    size_t n = mdy_documents_count(e->set.source_docs);
    e->set.docs = calloc(n ? n : 1, sizeof *e->set.docs);
    e->set.ids = calloc(n ? n : 1, sizeof *e->set.ids);
    if (!e->set.docs || !e->set.ids) { close_set(e); return -1; }
    e->set.count = n;

    /* close_set above reset the handle to -1, so the collection is always
     * opened fresh here. */
    e->set.handle = nis_open();
    if (e->set.handle < 0) {
        if (error && error_len) snprintf(error, error_len, "could not open a collection");
        close_set(e);
        return -1;
    }

    /*
     * `path` is the natural key of a set built from a directory, and every
     * `$.render({ path: … })` resolves through a query on it — so without the
     * index each one is a scan of the whole set. SPARSE because a document
     * need not have a path at all, and NOT unique because one file can hold
     * several documents and they all carry its path.
     *
     * It is also what makes the document-order sort do real work: a query
     * answered from an index comes back in INDEX order, not `_id` order.
     */
    {
        /*
         * `fields` is a binjson ARRAY OF STRINGS — the fields in composite-key
         * order — not the `{ path: 1 }` object MongoDB's createIndex takes.
         * It was written as that object, which decodes as an unknown type, so
         * the call returned BJ_ERR_UNKNOWN_TYPE and the index was never
         * registered. Nothing said so, because the return value was dropped:
         * every `$.render({ path: … })` then scanned the whole collection, and
         * on a 93-page site that was 62% of the entire build.
         *
         * So the result is CHECKED. An index that silently fails to exist is
         * indistinguishable from one that works, right up until a corpus is
         * large enough to notice.
         */
        bj_builder *spec = bj_builder_new();
        if (!spec) {
            if (error && error_len) snprintf(error, error_len, "out of memory");
            close_set(e);
            return -1;
        }
        bj_begin_array(spec);
        bj_put_string(spec, (const uint8_t *)"path", 4);
        bj_end_array(spec);
        size_t slen = 0;
        const uint8_t *bytes = bj_builder_data(spec, &slen);
        int rc = bj_builder_error(spec) ? -1
               : nis_create_index(e->set.handle, "path", bytes, (uint32_t)slen, 0, 1);
        bj_builder_free(spec);
        if (rc != 0) {
            if (error && error_len)
                snprintf(error, error_len,
                         "could not index documents by path (nisaba error %d)", rc);
            close_set(e);
            return -1;
        }
    }

    for (size_t i = 0; i < n; i++)
        if (insert_one_document(e, i, error, error_len) != 0) { close_set(e); return -1; }

    return 0;
}

size_t mdy_engine_count(mdy_engine *e) { return e ? e->set.count : 0; }

void mdy_engine_on_emit(mdy_engine *e,
                        void (*fn)(void *ud, const char *path, const char *content),
                        void *ud) {
    if (!e) return;
    e->cb.on_emit = fn;
    e->cb.on_emit_ud = ud;
}

void mdy_engine_on_publish(mdy_engine *e,
                           void (*fn)(void *ud, const char *name,
                                      const char *data_json, size_t doc_index),
                           void *ud) {
    e->cb.on_publish = fn;
    e->cb.on_publish_ud = ud;
}

void mdy_engine_on_binary(mdy_engine *e,
                          void (*fn)(void *ud, const char *path,
                                     const uint8_t *bytes, size_t len),
                          void *ud) {
    e->cb.on_binary = fn;
    e->cb.on_binary_ud = ud;
}

/*
 * void, and called before a build starts: a context that quietly failed to
 * bind is a document whose `$.site` is undefined, built and written as if
 * that were what it said. See xalloc.h.
 */
void mdy_engine_set_context_json(mdy_engine *e, const char *name, const char *json, int strict) {
    e->knobs.ctx_names  = mdy_xrealloc(e->knobs.ctx_names, (e->knobs.ctx_count + 1) * sizeof *e->knobs.ctx_names);
    e->knobs.ctx_json   = mdy_xrealloc(e->knobs.ctx_json, (e->knobs.ctx_count + 1) * sizeof *e->knobs.ctx_json);
    e->knobs.ctx_strict = mdy_xrealloc(e->knobs.ctx_strict, e->knobs.ctx_count + 1);
    e->knobs.ctx_names[e->knobs.ctx_count] = mdy_xstrdup(name);
    e->knobs.ctx_json[e->knobs.ctx_count] = mdy_xstrdup(json);
    e->knobs.ctx_strict[e->knobs.ctx_count] = (char)(strict ? 1 : 0);
    e->knobs.ctx_count++;
}

void mdy_engine_set_context_bool(mdy_engine *e, const char *name, int value) {
    mdy_engine_set_context_json(e, name, value ? "true" : "false", 1);
}

void mdy_engine_set_sanitize(mdy_engine *e, int sanitize) { e->knobs.sanitize = sanitize ? 1 : 0; }
void mdy_engine_set_tasks(mdy_engine *e, int tasks) { e->knobs.tasks = tasks ? 1 : 0; }

int mdy_engine_set_scope_json(mdy_engine *e, const char *name, const char *json) {
    /* an identifier, and not one the toolkit or the wrapper already binds */
    if (!name || !*name) return -1;
    for (const char *p = name; *p; p++) {
        int ok = (*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || *p == '_' || *p == '$' ||
                 (p > name && *p >= '0' && *p <= '9');
        if (!ok) return -1;
    }
    static const char *const taken[] = { "transform", "visit", "h", "toText", "slug", "req", "res", "$", "$$", NULL };
    for (int i = 0; taken[i]; i++) if (strcmp(name, taken[i]) == 0) return -1;
    /* Through xalloc, as mdy_engine_set_context_json does: the -1 this returns
     * means "not a valid variable", not "out of memory", and an unchecked
     * realloc/strdup here left a NULL that document_fingerprint later fed to
     * strlen. See xalloc.h. */
    e->knobs.scope_names = mdy_xrealloc(e->knobs.scope_names, (e->knobs.scope_count + 1) * sizeof *e->knobs.scope_names);
    e->knobs.scope_json  = mdy_xrealloc(e->knobs.scope_json, (e->knobs.scope_count + 1) * sizeof *e->knobs.scope_json);
    /* the same name again replaces the value */
    for (size_t i = 0; i < e->knobs.scope_count; i++) {
        if (strcmp(e->knobs.scope_names[i], name) == 0) {
            free(e->knobs.scope_json[i]);
            e->knobs.scope_json[i] = mdy_xstrdup(json);
            return 0;
        }
    }
    e->knobs.scope_names[e->knobs.scope_count] = mdy_xstrdup(name);
    e->knobs.scope_json[e->knobs.scope_count] = mdy_xstrdup(json);
    e->knobs.scope_count++;
    return 0;
}

void engine_message(mdy_engine *e, size_t doc_index, uint32_t line, uint32_t column,
                    const char *rule, const char *fmt, ...) {
    if (!e || !e->cb.on_message) return;
    char reason[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(reason, sizeof reason, fmt, ap);
    va_end(ap);
    e->cb.on_message(e->cb.on_message_ud, doc_index, line, column, rule, reason);
}

void mdy_engine_on_message(mdy_engine *e,
                           void (*fn)(void *ud, size_t doc_index, uint32_t line, uint32_t column,
                                      const char *rule, const char *reason),
                           void *ud) {
    e->cb.on_message = fn;
    e->cb.on_message_ud = ud;
}

void mdy_engine_set_response(mdy_engine *e, int keep) { e->knobs.want_response = keep ? 1 : 0; }
const char *mdy_engine_last_response(mdy_engine *e) { return e->compose.last_response; }

static JsValue context_value(mdy_engine *e, const char *json, int strict);

int mdy_engine_encode_json(mdy_engine *e, const char *json, uint8_t **out, size_t *out_len) {
    *out = NULL; *out_len = 0;
    JsValue v = context_value(e, json, 1);
    if (js_is_undefined(v)) return -1;
    js_gc_protect(e->vm, &v);
    bj_builder *b = bj_builder_new();
    int rc = b ? js_to_binjson(e, b, v) : -1;
    js_gc_unprotect(e->vm, &v);
    if (rc == 0 && !bj_builder_error(b)) {
        size_t n = 0;
        const uint8_t *data = bj_builder_data(b, &n);
        /* Through xalloc: the -1 channel here means "not JSON", and a NULL from
         * a bare malloc reached memcpy as a crash rather than that. See xalloc.h. */
        *out = mdy_xmalloc(n + 1);
        memcpy(*out, data, n);
        (*out)[n] = 0;
        *out_len = n;
    } else rc = -1;
    bj_builder_free(b);
    return rc;
}

void mdy_engine_clear_context(mdy_engine *e) {
    for (size_t i = 0; i < e->knobs.ctx_count; i++) { free(e->knobs.ctx_names[i]); free(e->knobs.ctx_json[i]); }
    e->knobs.ctx_count = 0;
}

void mdy_engine_on_source(mdy_engine *e, void (*fn)(void *ud, const char *path), void *ud) {
    e->cb.on_source = fn;
    e->cb.on_source_ud = ud;
}

/*
 * A context value from its JSON text, through the guest's own JSON.parse —
 * so `-d n=3` is the number 3 and `-d list=[1,2]` an array, exactly as
 * mdy-docs reads them. Text that is not JSON is the string it is when the
 * caller allowed that (`-d name=ada`), and undefined otherwise.
 */
static JsValue context_value(mdy_engine *e, const char *json, int strict) {
    JsValue text = str(e->vm, json, strlen(json));
    js_gc_protect(e->vm, &text);
    JsValue JSON = get_val(e, js_context_globals(e->ctx), "JSON");
    JsValue parse = js_is_object(JSON) ? get_val(e, JSON, "parse") : js_undefined();
    JsValue out = js_undefined();
    int ok = js_is_function(parse) && js_call(e->ctx, parse, JSON, &text, 1, &out);
    js_gc_unprotect(e->vm, &text);
    if (ok) return out;
    return strict ? js_undefined() : str(e->vm, json, strlen(json));
}

/* ---- querying ---------------------------------------------------------------
 *
 * A hit carries the `_id` it was inserted with, so it maps back to the
 * document it came from — and the answer is sorted by that, not by whatever
 * order the database walked its keys in. That is what makes a query's answer
 * the same on every build.
 */
static void id_hex(const uint8_t id[12], char out[25]) {
    static const char H[] = "0123456789abcdef";
    for (int k = 0; k < 12; k++) {
        out[k * 2] = H[id[k] >> 4];
        out[k * 2 + 1] = H[id[k] & 15];
    }
    out[24] = '\0';
}

static uint32_t oid_hash(const char *hex) {
    uint32_t h = 2166136261u;
    for (int i = 0; i < 24; i++) { h ^= (unsigned char)hex[i]; h *= 16777619u; }
    return h;
}

/*
 * The map, built ONCE for the set.
 *
 * The alternative is a linear search re-formatting every `_id` on every step,
 * inside a loop over every document, inside a loop over every hit — cubic in
 * the size of the set. `$.find({})` over 600 documents is 1.8s that way
 * against node's 0.7, and 1,200 is 12.7.
 */
/*
 * It does not fail, because its caller has no way to say that it did.
 * index_of_id answers -1, which means "no document of this set has that id" —
 * a real answer a query relies on. A map that could not be BUILT answered the
 * same -1, so every hit was dropped and `$.find` quietly returned fewer
 * documents than matched. See xalloc.h.
 */
static void oid_map_build(mdy_engine *e) {
    size_t cap = 16;
    while (cap < e->set.count * 2) cap *= 2;
    OidSlot *slots = mdy_xcalloc(cap, sizeof *slots);
    for (size_t i = 0; i < e->set.count; i++) {
        char hex[25];
        id_hex(e->set.ids[i], hex);
        size_t at = oid_hash(hex) & (cap - 1);
        while (slots[at].hex[0]) at = (at + 1) & (cap - 1);
        memcpy(slots[at].hex, hex, sizeof hex);
        slots[at].index = (int)i;
    }
    e->set.oid_slots = slots;
    e->set.oid_cap = cap;
}

/* `hex` is the 24 characters of an ObjectId; anything else belongs to no
 * document in this set. */
int index_of_id(mdy_engine *e, const char *hex, size_t len) {
    if (len != 24) return -1;
    if (!e->set.oid_slots) oid_map_build(e);
    size_t at = oid_hash(hex) & (e->set.oid_cap - 1);
    for (size_t probe = 0; probe < e->set.oid_cap; probe++) {
        if (!e->set.oid_slots[at].hex[0]) return -1;      /* a hole ends the run */
        if (memcmp(e->set.oid_slots[at].hex, hex, 24) == 0) return e->set.oid_slots[at].index;
        at = (at + 1) & (e->set.oid_cap - 1);
    }
    return -1;
}

/* A hit, and where in the set it belongs. */
typedef struct { int at; uint32_t hit; } Placed;

static int by_document_index(const void *a, const void *b) {
    int x = ((const Placed *)a)->at, y = ((const Placed *)b)->at;
    return x < y ? -1 : x > y ? 1 : 0;
}

/*
 * `vals` is the VM the result must be readable in; `store` is the set being
 * queried. They differ for a cross-package `find`: each package has its own
 * VM, so a value made in one is meaningless in the other and the documents
 * have to be rebuilt on the caller's side.
 */
static JsValue run_query_in(mdy_engine *vals, mdy_engine *store, JsValue query,
                            int one, int *failed) {
    mdy_engine *e = vals;
    if (failed) *failed = 0;
    bj_builder *b = bj_builder_new();
    if (!b) { if (failed) *failed = 1; return js_undefined(); }
    if (js_is_object(query) && !js_is_array(query)) {
        if (js_to_binjson(e, b, query) != 0) {
            bj_builder_free(b);
            if (failed) *failed = 1;
            return js_undefined();
        }
    } else {
        bj_begin_object(b);
        bj_end_object(b);
    }
    size_t flen = 0;
    const uint8_t *filter = bj_builder_data(b, &flen);

    uint8_t *out = NULL;
    size_t out_len = 0;
    int rc = nis_find(store->set.handle, filter, (uint32_t)flen, &out, &out_len);
    bj_builder_free(b);
    /*
     * A query that could not RUN is not a query that matched nothing.
     *
     * nisaba reports an exhausted allocation properly, all the way out through
     * dc_find's negative return -- and this threw that away and answered with
     * an empty array. `$.find` then said the site had no posts, the index page
     * was written without them, and the build reported success. It is the one
     * place in this engine where a foreign error code was dropped rather than
     * missing, which is why it survived so long.
     */
    if (rc != 0 || !out) {
        if (failed) *failed = 1;
        return one ? js_null() : js_array_new(e->ctx, 0);
    }

    /* The result is a binjson ARRAY of documents. */
    JsValue hits = binjson_to_js(e, out, out_len, NULL);
    free(out);
    if (!js_is_array(hits)) {
        if (failed) *failed = 1;
        return one ? js_null() : js_array_new(e->ctx, 0);
    }
    js_gc_protect(e->vm, &hits);

    /* Back into document order. */
    uint32_t n = js_array_length(hits);
    JsValue ordered = js_array_new(e->ctx, n);
    js_gc_protect(e->vm, &ordered);
    /*
     * Each hit's `_id` read ONCE, and the atom for it made once as well: both
     * were being redone on every step of a nested loop. Reading the units in
     * place allocates nothing, which also means there is no safe point in
     * this loop and so nothing in it to root.
     */
    JsValue id_key = key(e->vm, "_id");
    js_gc_protect(e->vm, &id_key);
    /* Placing the hits is not optional: `order` being NULL used to mean the
     * loop did not run and `find` answered with nothing. See xalloc.h. */
    Placed *order = n ? mdy_xmalloc((size_t)n * sizeof *order) : NULL;
    uint32_t placed = 0;
    for (uint32_t i = 0; order && i < n; i++) {
        size_t ulen = 0;
        const uint16_t *u = js_string_units(js_object_get(e->vm, js_array_get(hits, i), id_key), &ulen);
        if (!u || ulen != 24) continue;
        char hex[25];
        for (size_t k = 0; k < 24; k++) hex[k] = u[k] < 128 ? (char)u[k] : '?';
        hex[24] = '\0';
        int at = index_of_id(store, hex, 24);
        if (at < 0) continue;                    /* not a document of this set */
        order[placed].at = at;
        order[placed].hit = i;
        placed++;
    }
    /* No two documents share an `_id`, so there are no ties to break and the
     * sort's instability is not reachable. */
    if (order) qsort(order, placed, sizeof *order, by_document_index);
    for (uint32_t k = 0; k < placed; k++)
        push_item(e, ordered, js_array_get(hits, order[k].hit));
    free(order);
    js_gc_unprotect(e->vm, &id_key);
    js_gc_unprotect(e->vm, &ordered);
    js_gc_unprotect(e->vm, &hits);

    if (!one) return ordered;
    return js_array_length(ordered) > 0 ? js_array_get(ordered, 0) : js_null();
}

/* The ordinary case: one set, queried in its own VM. */
JsValue run_query(mdy_engine *e, JsValue query, int one, int *failed) {
    return run_query_in(e, e, query, one, failed);
}

static bool find_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                        int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    int failed = 0;
    *result = run_query(e, argc > 0 ? args[0] : js_undefined(), 0, &failed);
    if (failed) {
        const char *msg = "mdy-engine: $.find could not run the query";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    return true;
}

static bool find_one_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                            int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    int failed = 0;
    *result = run_query(e, argc > 0 ? args[0] : js_undefined(), 1, &failed);
    if (failed) {
        const char *msg = "mdy-engine: $.findOne could not run the query";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    return true;
}

/* `$.data(i)` — a document's own data, by index, without a query. */
/* One document's record, as the guest sees it. */
/*
 * A document looked up by its OWN id, which `open_documents` inserted and
 * `at < e->count` guarantees is there. So the empty object this returned on
 * every failure was never "not found": it was `$.data` answering `{}` for a
 * page whose data exists, and the page being written from it. There is no
 * JsValue that means "could not read the store", and nine callers, so the
 * failures that are allocations end the run. See xalloc.h.
 */
/*
 * The stored record for the document at index `idx`, as a guest value — the
 * "{_id: ids[idx]} filter -> nis_find -> decode -> first hit" that three
 * readers (document_record, data_native, lookup_import) each spelled out. It
 * returns js_undefined() for any failure, and each caller decides what that
 * means: fatal, null, or nothing. There is no GC safe point between the decode
 * and the return, so the value is meant to be used immediately, which is the
 * same discipline the inline copies relied on.
 */
static JsValue record_by_index(mdy_engine *e, size_t idx) {
    if (idx >= e->set.count) return js_undefined();
    bj_builder *b = bj_builder_new();
    if (!b) return js_undefined();
    bj_begin_object(b);
    bj_put_key(b, (const uint8_t *)"_id", 3);
    bj_put_oid(b, e->set.ids[idx]);
    bj_end_object(b);
    size_t flen = 0;
    const uint8_t *filter = bj_builder_data(b, &flen);
    uint8_t *out = NULL;
    size_t out_len = 0;
    int rc = nis_find(e->set.handle, filter, (uint32_t)flen, &out, &out_len);
    bj_builder_free(b);
    if (rc != 0 || !out) return js_undefined();
    JsValue hits = binjson_to_js(e, out, out_len, NULL);
    free(out);
    if (!js_is_array(hits) || js_array_length(hits) == 0) return js_undefined();
    return js_array_get(hits, 0);
}

static JsValue document_record(mdy_engine *e, size_t at) {
    if (at >= e->set.count) return js_object_new(e->ctx);
    JsValue r = record_by_index(e, at);
    if (js_is_undefined(r)) mdy_fatal("the document store could not return a document");
    return r;
}

/*
 * The record without its store id.
 *
 * `$.data(i)` carries no `_id` under mdy-docs — the same rule wrap()'s
 * `__answer` already applies to `res.data`, written once more for the native.
 * A store id says when a set was opened, not what a document is, so a document
 * that serialises its own data must not carry one.
 */
static JsValue record_without_id(mdy_engine *e, JsValue rec) {
    if (!js_is_object(rec)) return rec;
    /*
     * `rec` rooted BEFORE the object that will hold the copy, because
     * js_object_new allocates and the record arrives here reachable only from
     * the C stack — `record_without_id(e, document_record(e, index))` hands
     * over a value nothing else holds. Rooting it second loses the record,
     * which is what MDY_GC_STRESS is for — sixteen checks fail under it and
     * none without.
     */
    js_gc_protect(e->vm, &rec);
    JsValue out = js_object_new(e->ctx);
    js_gc_protect(e->vm, &out);
    size_t n = js_object_size(rec);
    for (size_t i = 0; i < n; i++) {
        JsValue k = js_object_key_at(rec, i);
        char *name = js_string_utf8(k);
        if (!name) continue;
        if (strcmp(name, "_id") != 0) set_val(e, out, name, js_object_get(e->vm, rec, k));
        free(name);
    }
    js_gc_unprotect(e->vm, &rec);
    js_gc_unprotect(e->vm, &out);
    return out;
}

static bool data_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                        int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    if (argc < 1 || !js_is_number(args[0])) { *result = js_null(); return true; }
    double at = js_get_number(args[0]);
    if (at < 0 || at >= (double)e->set.count) { *result = js_null(); return true; }

    JsValue r = record_by_index(e, (size_t)at);
    *result = js_is_undefined(r) ? js_null() : record_without_id(e, r);
    return true;
}


/*
 * `$.compose(__out)` — the one native step 2 implements, and the reason the
 * tree conversions exist.
 *
 * A document with a `transform` needs its own finished tree, so the host takes
 * the lines it produced, parses them, and hands the tree BACK to the guest as
 * values. The guest transforms it and returns it; the host converts it back
 * and writes the HTML. mdy-docs does the same thing with JSON in both
 * directions.
 */
static mdy_doc *parse_lines(JsValue out, mdy_engine *e);
static void note_references(mdy_engine *e, const mdy_doc *tree);

static bool compose_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                           int argc, JsValue *result) {
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    if (argc < 1 || !js_is_array(args[0])) {
        const char *msg = "mdy-engine: $.compose wants the lines a document produced";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    mdy_doc *tree = parse_lines(args[0], e);
    if (!tree) {
        const char *msg = "mdy-engine: the produced lines did not parse";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    /* Composed before the transforms see it: a transform works on the
     * document's FINISHED tree, renders and all. */
    splice_tree(e, tree, (mdy_node *)mdy_root(tree));
    note_references(e, tree);
    /* The document owns the tree until the render finishes with it. */
    mdy_free(e->compose.tree_owner);
    e->compose.tree_owner = tree;
    *result = tree_to_js(e, mdy_root(tree));
    return true;
}

static void register_one(mdy_engine *e, const char *name, JsNativeFn fn) {
    size_t n = 0;
    uint16_t *u = to_utf16(name, strlen(name), &n);
    if (!u) return;
    js_register_native(e->ctx, u, n, fn, NULL);
    free(u);
}


/* ---- reaching into an imported package --------------------------------------
 *
 * The spec a document wrote, resolved against THAT document — imports are
 * recorded per source file, so the same spec in two files can be two packages.
 */
/*
 * The imported set a `spec` names, resolved against the CURRENT document, or
 * NULL with a reason written into `why` (may be NULL when the caller does not
 * use it). `path` is a LOCAL buffer now, not a static returned through a `const
 * char **`: the old shape handed the caller a pointer into shared storage that
 * the next lookup would overwrite.
 */
static mdy_engine *lookup_import(mdy_engine *e, const char *spec, char *why, size_t why_cap) {
    char path[1024];
    path[0] = '\0';
    /* The record for THIS document, by its own id. */
    JsValue r = record_by_index(e, e->graph.current);
    if (!js_is_undefined(r)) {
        char *p = js_string_utf8(get_val(e, r, "path"));
        if (p) { snprintf(path, sizeof path, "%s", p); free(p); }
    }
    if (!path[0]) { if (why && why_cap) snprintf(why, why_cap, "a document with no path"); return NULL; }
    for (size_t i = 0; i < e->graph.import_count; i++) {
        if (strcmp(e->graph.imports[i].spec, spec) == 0 &&
            strcmp(e->graph.imports[i].source_path, path) == 0)
            return e->graph.imports[i].set;
    }
    if (why && why_cap) snprintf(why, why_cap, "%s", path);
    return NULL;
}

/*
 * A value from one package's VM, rebuilt in another's.
 *
 * Each package is its own VM, and a JsValue is only meaningful inside the one
 * that made it — handing an importer's object straight to an imported
 * document gives it something that is not an object there at all. So data
 * crosses as DATA, through the same encoding the document store uses, exactly
 * as mdy-docs' separate VMs make it cross as JSON.
 */
static JsValue cross_vm(mdy_engine *from, mdy_engine *to, JsValue v) {
    if (!js_is_object(v)) return js_object_new(to->ctx);
    bj_builder *b = bj_builder_new();
    if (!b) return js_object_new(to->ctx);
    if (js_to_binjson(from, b, v) != 0 || bj_builder_error(b)) {
        bj_builder_free(b);
        return js_object_new(to->ctx);
    }
    size_t len = 0;
    const uint8_t *bytes = bj_builder_data(b, &len);
    JsValue out = bytes ? binjson_to_js(to, bytes, len, NULL) : js_object_new(to->ctx);
    bj_builder_free(b);
    return out;
}

static bool import_render_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                                 int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    *result = js_undefined();
    char *spec = argc > 0 ? js_string_utf8(args[0]) : NULL;
    if (!spec) return true;

    char why[1024] = "";
    mdy_engine *set = lookup_import(e, spec, why, sizeof why);
    if (!set) {
        char msg[512];
        snprintf(msg, sizeof msg, "mdy: import \"%s\" was not resolved (declared in %s)", spec, why);
        *result = str(e->vm, msg, strlen(msg));
        free(spec);
        return false;
    }
    free(spec);

    int qfailed = 0;
    int at = resolve_target(set, argc > 1 ? args[1] : js_undefined(), &qfailed);
    if (at < 0) {
        const char *msg = qfailed ? "$.render: the imported package could not run the query"
                                  : "$.render: no such document in the imported package";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }

    char err[512];
    /*
     * A cross-package render is a TREE, exactly as an in-set one is: the
     * imported document is parsed at its own boundary and comes back as a
     * node, so an imported layout cannot leak an unclosed tag into the page
     * that used it.
     */
    JsValue req = cross_vm(e, set, argc > 2 ? args[2] : js_undefined());
    js_gc_protect(set->vm, &req);
    mdy_doc *tree = render_tree(set, (size_t)at, req, err, sizeof err);
    js_gc_unprotect(set->vm, &req);
    if (!tree) {
        const char *msg = err[0] ? err : "the imported document failed to render";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }

    /* Parked by the IMPORTER, whose composition pass will splice it and whose
     * render owns it from here. Numbered, not keyed: mdy-docs' import render
     * holds sequentially, and the blog's search index says so. */
    char *token = hold_tree(e, tree, (mdy_node *)mdy_root(tree));
    *result = str(e->vm, token, strlen(token));
    free(token);
    return true;
}

static bool import_query_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                                int argc, JsValue *result, int one) {
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    *result = one ? js_null() : js_array_new(ctx, 0);
    char *spec = argc > 0 ? js_string_utf8(args[0]) : NULL;
    if (!spec) return true;
    mdy_engine *set = lookup_import(e, spec, NULL, 0);
    free(spec);
    if (!set) {
        const char *msg = "mdy: import was not resolved";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }

    /*
     * The query runs in the IMPORTED set — its own nisaba handle, its own
     * documents — but the values must come back as the IMPORTER's, because
     * that is the VM the caller will read them in.
     */
    int failed = 0;
    JsValue hits = run_query_in(e, set, argc > 1 ? args[1] : js_undefined(), one, &failed);
    if (failed) {
        const char *msg = "mdy-engine: the imported set could not run the query";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    *result = hits;
    return true;
}

static bool import_find_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                               int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    return import_query_native(ctx, this_val, args, argc, result, 0);
}

static bool import_find_one_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                                   int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    return import_query_native(ctx, this_val, args, argc, result, 1);
}


/* ---- the trees a document builds for itself ---------------------------------
 *
 * `$.parse`, `$.markdown`, `$.node`, `$.table` and `$.html`: the ways a
 * document gets a tree that did not come from its own text, and the way one
 * goes back out as HTML.
 *
 * All but `$.html` end in a token, for the reason `$.render` does — a tree
 * travels through a document's own code as a few private-use characters, and
 * goes back in where the parser knows what is open. `$.parse` is the
 * exception on the other side: it hands back the TREE, because its whole
 * purpose is to be looked at.
 */

/* The options the document engine asks the parser for: front matter, document
 * splitting and the script layer are all already done by the time a document
 * calls one of these. */
static int engine_highlight(void *ud, mdy_doc *doc, mdy_node *code,
                            const char *value, size_t value_len,
                            const char *language, size_t language_len);

static void parse_options(mdy_engine *e, mdy_options *options) {
    mdy_options_default(options);
    options->frontmatter = 0;
    options->documents = 0;
    options->sanitize = e->knobs.sanitize;
    options->tasks = e->knobs.tasks;
    options->highlight = engine_highlight;
    options->highlight_ud = e;
}

/*
 * The document's references, onto its `res.data` — mdy-docs' `collectReferences`:
 * `tags`, `users` and `links` are always there to be asked about, an array
 * each unless the front matter made one something else, and a name goes in
 * as it was written, once. Filled as the text is parsed, which is after the
 * code has run and before the transforms do — so from `$.compose` for a
 * document with a transform, and from the host's parse for one without.
 */
static void note_references(mdy_engine *e, const mdy_doc *tree) {
    if (!js_is_object(e->compose.render_res)) return;
    JsValue data = get_val(e, e->compose.render_res, "data");
    if (!js_is_object(data)) return;
    static const char *const lists[] = { "tags", "users", "links" };
    /* Every value made here is a GC root until it is stored: interning a key
     * or growing an array can run the collector, and a fresh array or string
     * nothing points at yet is exactly what it sweeps. */
    js_gc_protect(e->vm, &data);
    JsValue arrays[3];
    for (int k = 0; k < 3; k++) {
        JsValue have = get_val(e, data, lists[k]);
        if (js_is_undefined(have)) {
            have = js_array_new(e->ctx, 0);
            js_gc_protect(e->vm, &have);
            set_val(e, data, lists[k], have);
            js_gc_unprotect(e->vm, &have);
        }
        arrays[k] = js_is_array(have) ? have : js_undefined();
    }
    size_t n = mdy_reference_count(tree);
    for (size_t i = 0; i < n; i++) {
        const mdy_reference *r = mdy_reference_at(tree, i);
        int k = r->kind == MDY_REF_TAG ? 0 : r->kind == MDY_REF_MENTION ? 1 : 2;
        if (js_is_undefined(arrays[k])) continue;
        int seen = 0;
        uint32_t len = js_array_length(arrays[k]);
        for (uint32_t j = 0; j < len && !seen; j++) {
            char *s = js_string_utf8(js_array_get(arrays[k], j));
            seen = s && strlen(s) == r->name_len && memcmp(s, r->name, r->name_len) == 0;
            free(s);
        }
        if (!seen) {
            JsValue name = str(e->vm, r->name, r->name_len);
            js_gc_protect(e->vm, &name);
            js_array_push(e->vm, arrays[k], name);
            js_gc_unprotect(e->vm, &name);
        }
    }
    js_gc_unprotect(e->vm, &data);
}

/* MDY text as a tree, with any tokens in it spliced — `$.parse` is handed to
 * code that will read the tree, so a `$.render` inside the text has to have
 * become its nodes by then. */
static bool parse_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                         int argc, JsValue *result) {
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    char *text = argc > 0 ? js_string_utf8(args[0]) : NULL;

    mdy_options options;
    parse_options(e, &options);
    mdy_doc *doc = mdy_parse(text ? text : "", text ? strlen(text) : 0, &options);
    free(text);
    if (!doc) {
        const char *msg = "mdy-engine: $.parse could not read that as MDY";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    splice_tree(e, doc, (mdy_node *)mdy_root(doc));
    *result = tree_to_js(e, mdy_root(doc));
    /* The document owns it until the render finishes: the value handed back is
     * a copy in the VM, but a token spliced into it points at held nodes. */
    keep_alive(e, doc);
    return true;
}

/* Markdown as a tree — the OTHER front end, for a `.md` file's body or any
 * markdown a document holds and wants as nodes. */
static bool markdown_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                            int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* an embedder native: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    char *text = argc > 0 ? js_string_utf8(args[0]) : NULL;
    const char *why = NULL;
    mdy_doc *doc = mdy_markdown_parse(text ? text : "", text ? strlen(text) : 0, &why);
    free(text);
    if (!doc) {
        char msg[160];
        snprintf(msg, sizeof msg, "mdy-engine: $.markdown: %s", why ? why : "could not read that as Markdown");
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    char *token = hold_tree(e, doc, (mdy_node *)mdy_root(doc));
    *result = str(e->vm, token, strlen(token));
    free(token);
    return true;
}

/*
 * A tree the document built ITSELF — with `h`, by hand, or in a module it
 * imported — parked like any other and spliced where its token lands.
 *
 * Hast is plain data, so it crosses as it is: a fragment built this way is a
 * node from the start rather than a string of HTML somebody has to parse
 * back.
 */
static bool node_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                        int argc, JsValue *result) {
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    if (argc < 1 || !js_is_object(args[0]) ||
        !js_is_string(get_val(e, args[0], "type"))) {
        const char *msg = "mdy: $.node expects a hast node ({ type, … })";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    mdy_doc *doc = mdy_doc_new();
    if (!doc) { *result = js_undefined(); return true; }
    mdy_node *root = js_to_tree(e, doc, args[0]);
    /*
     * `mdy_doc` owns its root, so what came back is hung under it — a root
     * lends its children, and a single element becomes the document's one
     * child. The same thing `$.compose` does with a transform's return.
     */
    mdy_node *into = (mdy_node *)mdy_root(doc);
    if (root && root->type == MDY_ROOT) {
        for (mdy_node *c = root->first; c;) {
            mdy_node *next = c->next;
            c->next = NULL;
            mdy_append(into, c);
            c = next;
        }
    } else if (root) {
        mdy_append(into, root);
    }
    char *token = hold_tree(e, doc, into);
    *result = str(e->vm, token, strlen(token));
    free(token);
    return true;
}

/* A tree, or a token standing for one, as HTML text. */
static bool html_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                        int argc, JsValue *result) {
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);

    if (argc > 0 && js_is_string(args[0])) {
        /* Tokens in a string become the HTML of what they hold. */
        char *s = js_string_utf8(args[0]);
        char *filled = s ? fill_tokens(e, s, strlen(s)) : NULL;
        /* fill_tokens returns NULL only when it could not build the string —
         * an OOM. Returning "" made that a normal empty result, dropping the
         * composed pieces silently; emit_native fails on the same NULL, so
         * this does too rather than answer with a different string. */
        int failed = s && !filled;
        free(s);
        if (failed) {
            const char *msg = "mdy-engine: $.html could not build the string";
            free(filled);
            *result = str(e->vm, msg, strlen(msg));
            return false;
        }
        *result = str(e->vm, filled ? filled : "", filled ? strlen(filled) : 0);
        free(filled);
        return true;
    }
    if (argc < 1 || !js_is_object(args[0]) ||
        !js_is_string(get_val(e, args[0], "type"))) {
        const char *msg = "mdy: $.html expects a hast node ({ type, … }) or a string";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    mdy_doc *doc = mdy_doc_new();
    if (!doc) { *result = js_undefined(); return true; }
    mdy_node *root = js_to_tree(e, doc, args[0]);
    char *html = root ? mdy_to_html(root, NULL) : NULL;
    mdy_free(doc);
    *result = str(e->vm, html ? html : "", html ? strlen(html) : 0);
    free(html);
    return true;
}

/*
 * `$.table(rows, align)` — an array of row arrays, the first being the header.
 *
 * A cell's text is parsed as MDY, so a link or an emphasis in a cell is a
 * link or an emphasis. A cell that parses to exactly one paragraph gives up
 * that paragraph and contributes its children; anything else is kept as the
 * text it was, which is what stops a cell holding a list from breaking the
 * row apart.
 */
static const char *column_align(JsValue align, uint32_t i) {
    if (!js_is_array(align) || i >= js_array_length(align)) return NULL;
    char *s = js_string_utf8(js_array_get(align, i));
    if (!s) return NULL;
    char first = s[0];
    free(s);
    if (first >= 'A' && first <= 'Z') first = (char)(first - 'A' + 'a');
    if (first == 'l') return "left";
    if (first == 'c') return "center";
    if (first == 'r') return "right";
    return NULL;
}

static void table_cell(mdy_engine *e, mdy_doc *doc, mdy_node *row,
                       JsValue value, uint32_t i, int header, JsValue align) {
    char *text = js_is_undefined(value) || js_is_null(value) ? NULL : js_string_utf8(value);
    const char *body = text ? text : "";

    mdy_node *cell = mdy_new_element(doc, header ? "th" : "td", 2);
    const char *at = column_align(align, i);
    if (at) {
        char style[32];
        int n = snprintf(style, sizeof style, "text-align: %s", at);
        mdy_set_string(doc, cell, "style", style, (size_t)n);
    }

    mdy_options options;
    parse_options(e, &options);
    mdy_doc *parsed = mdy_parse(body, strlen(body), &options);
    const mdy_node *root = parsed ? mdy_root(parsed) : NULL;
    const mdy_node *only = root ? root->first : NULL;
    int one_paragraph = only && !only->next && only->type == MDY_ELEMENT &&
                        strcmp(only->tag, "p") == 0;
    if (one_paragraph) {
        for (const mdy_node *c = only->first; c; c = c->next) {
            mdy_node *copy = mdy_clone(doc, c);
            if (copy) mdy_append(cell, copy);
        }
    } else {
        mdy_append(cell, mdy_new_text(doc, body, strlen(body)));
    }
    mdy_free(parsed);
    free(text);
    mdy_append(row, cell);
}

static bool table_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                         int argc, JsValue *result) {
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    JsValue rows = argc > 0 ? args[0] : js_undefined();
    JsValue align = argc > 1 ? args[1] : js_undefined();

    int shaped = js_is_array(rows);
    for (uint32_t i = 0; shaped && i < js_array_length(rows); i++)
        if (!js_is_array(js_array_get(rows, i))) shaped = 0;
    if (!shaped) {
        const char *msg = "mdy: $.table expects an array of row arrays (first row is the header)";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    if (!js_is_undefined(align) && !js_is_null(align) && !js_is_array(align)) {
        const char *msg = "mdy: $.table align must be an array like ['left', 'center', 'right']";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    uint32_t count = js_array_length(rows);
    if (count == 0) { *result = str(e->vm, "", 0); return true; }

    mdy_doc *doc = mdy_doc_new();
    if (!doc) { *result = js_undefined(); return true; }
    mdy_node *table = mdy_new_element(doc, "table", 5);
    mdy_node *thead = mdy_new_element(doc, "thead", 5);
    mdy_node *head_row = mdy_new_element(doc, "tr", 2);
    JsValue head = js_array_get(rows, 0);
    for (uint32_t i = 0; i < js_array_length(head); i++)
        table_cell(e, doc, head_row, js_array_get(head, i), i, 1, align);
    mdy_append(thead, head_row);
    mdy_append(table, thead);

    if (count > 1) {
        mdy_node *tbody = mdy_new_element(doc, "tbody", 5);
        for (uint32_t r = 1; r < count; r++) {
            mdy_node *tr = mdy_new_element(doc, "tr", 2);
            JsValue cells = js_array_get(rows, r);
            for (uint32_t i = 0; i < js_array_length(cells); i++)
                table_cell(e, doc, tr, js_array_get(cells, i), i, 0, align);
            mdy_append(tbody, tr);
        }
        mdy_append(table, tbody);
    }
    mdy_append((mdy_node *)mdy_root(doc), table);

    char *token = hold_tree(e, doc, table);
    *result = str(e->vm, token, strlen(token));
    free(token);
    return true;
}


/* ---- a document's own contents list ------------------------------------------
 *
 * `$.toc()` returns a token before there is anything to put in it. That is the
 * point: a document's headings are not known until its whole tree is, and a
 * contents list at the top has to be able to name a heading a loop writes
 * below it. So the token is parked empty and filled LAST, after the transforms
 * have had the tree — which is also why the ids in it are the parser's own,
 * and nothing has to agree with anything.
 */

static char *hold_toc(mdy_engine *e) {
    char *token = hold_tree(e, NULL, NULL);
    if (token) {
        mdy_engine *t = token_table(e);
        t->compose.held[t->compose.held_count - 1].is_toc = 1;
    }
    return token;
}

typedef struct { int depth; char *text; char *id; } Heading;

/* All the text under a node, which is what a heading's entry reads. */
static void heading_text(const mdy_node *n, char **buf, size_t *len, size_t *cap) {
    collect_text_into(n, buf, len, cap);
}

static int heading_depth(const mdy_node *n) {
    if (n->type != MDY_ELEMENT || !n->tag) return 0;
    if (n->tag[0] != 'h' || n->tag[1] < '1' || n->tag[1] > '6' || n->tag[2]) return 0;
    return n->tag[1] - '0';
}

static void collect_headings(const mdy_node *n, Heading **out, size_t *count, size_t *cap) {
    int depth = heading_depth(n);
    if (depth) {
        /* A heading dropped here is a contents list missing an entry, on a
         * page that was written and reported built. See xalloc.h. */
        if (*count == *cap) {
            size_t want = *cap ? *cap * 2 : 16;
            *out = mdy_xrealloc(*out, want * sizeof **out);
            *cap = want;
        }
        char *text = NULL;
        size_t tlen = 0, tcap = 0;
        heading_text(n, &text, &tlen, &tcap);
        const char *id = NULL;
        for (const mdy_prop *p = n->props; p; p = p->next)
            if (strcmp(p->name, "id") == 0 && p->type == MDY_PROP_STRING) id = p->as.string;
        (*out)[*count].depth = depth;
        (*out)[*count].text = text ? text : mdy_xcalloc(1, 1);
        /* NULL is a real value here -- it is a heading with no id, which the
         * list leaves out -- so a failed copy could not be told from one. */
        (*out)[*count].id = id ? mdy_xstrdup(id) : NULL;
        (*count)++;
    }
    for (const mdy_node *c = n->first; c; c = c->next)
        collect_headings(c, out, count, cap);
}

/*
 * A nested `<ul>`, or nothing when no heading carries an id — one list per
 * depth, the deepest last: a heading goes in the list at its own level, and a
 * level that opens goes inside the item above it.
 */
static mdy_node *toc_list(mdy_doc *doc, Heading *entries, size_t count) {
    size_t listed = 0;
    int min = 7;
    for (size_t i = 0; i < count; i++)
        if (entries[i].id) { listed++; if (entries[i].depth < min) min = entries[i].depth; }
    if (listed == 0) return NULL;

    mdy_node *root = mdy_new_element(doc, "ul", 2);
    struct { int depth; mdy_node *list; } stack[8];
    size_t top = 0;
    stack[0].depth = min;
    stack[0].list = root;

    for (size_t i = 0; i < count; i++) {
        if (!entries[i].id) continue;
        while (top > 0 && entries[i].depth < stack[top].depth) top--;
        while (entries[i].depth > stack[top].depth && top + 1 < 8) {
            mdy_node *above = stack[top].list->last;
            mdy_node *nested = mdy_new_element(doc, "ul", 2);
            if (above) {
                mdy_append(above, nested);
            } else {
                mdy_node *li = mdy_new_element(doc, "li", 2);
                mdy_append(li, nested);
                mdy_append(stack[top].list, li);
            }
            top++;
            stack[top].depth = stack[top - 1].depth + 1;
            stack[top].list = nested;
        }
        mdy_node *li = mdy_new_element(doc, "li", 2);
        mdy_node *a = mdy_new_element(doc, "a", 1);
        /* `#` and the id, at whatever length the heading made the id. */
        size_t idlen = strlen(entries[i].id);
        char *href = mdy_xmalloc(idlen + 2);
        href[0] = '#';
        memcpy(href + 1, entries[i].id, idlen + 1);
        mdy_set_string(doc, a, "href", href, idlen + 1);
        free(href);
        mdy_append(a, mdy_new_text(doc, entries[i].text, strlen(entries[i].text)));
        mdy_append(li, a);
        mdy_append(stack[top].list, li);
    }
    return root;
}

static void free_headings(Heading *entries, size_t count) {
    for (size_t i = 0; i < count; i++) { free(entries[i].text); free(entries[i].id); }
    free(entries);
}

/*
 * Fill every contents token in a finished tree. Run LAST, on the whole tree,
 * so the headings are all of them and the ids are the parser's.
 */
static void splice_toc(mdy_engine *e, mdy_doc *doc, mdy_node *parent,
                       Heading *entries, size_t count) {
    mdy_node *child = parent->first;
    parent->first = parent->last = NULL;

    while (child) {
        mdy_node *next = child->next;
        child->next = NULL;

        size_t len = 0;
        const char *text = sole_text(child, &len);
        char id[24];
        if (text && only_tokens(text, len) && token_at(text, len, id, sizeof id)) {
            Held *h = held_find(e, id);
            if (h && h->is_toc) {
                mdy_node *list = toc_list(doc, entries, count);
                if (list) mdy_append(parent, list);
                child = next;
                continue;
            }
        }
        splice_toc(e, doc, child, entries, count);
        mdy_append(parent, child);
        child = next;
    }
}

static void fill_toc(mdy_engine *e, mdy_doc *doc) {
    /* Nothing to do unless a token asked for one — the walk is not free. */
    mdy_engine *t = token_table(e);
    int wanted = 0;
    for (size_t i = 0; i < t->compose.held_count && !wanted; i++) wanted = t->compose.held[i].is_toc;
    if (!wanted) return;

    Heading *entries = NULL;
    size_t count = 0, cap = 0;
    collect_headings(mdy_root(doc), &entries, &count, &cap);
    splice_toc(e, doc, (mdy_node *)mdy_root(doc), entries, count);
    free_headings(entries, count);
}

/*
 * `$.toc()` with no argument is the token above. With one it is a QUESTION:
 * the headings of what was passed, for a document that would rather build the
 * list itself. MDY text, a hast node, or a rendered document (which arrives
 * as a token, so that has to be accepted too).
 */
static bool toc_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                       int argc, JsValue *result) {
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);

    if (argc < 1 || js_is_undefined(args[0])) {
        char *token = hold_toc(e);
        *result = str(e->vm, token, strlen(token));
        free(token);
        return true;
    }

    const mdy_node *tree = NULL;
    mdy_doc *owned = NULL;

    if (js_is_string(args[0])) {
        char *s = js_string_utf8(args[0]);
        size_t slen = s ? strlen(s) : 0;
        char id[24];
        /* A token is how a rendered document travels, so `$.toc($.render(…))`
         * is asking about THAT document, not about three characters. */
        if (s && only_tokens(s, slen) && token_at(s, slen, id, sizeof id)) {
            Held *h = held_find(e, id);
            if (h) tree = h->tree;
        } else {
            mdy_options options;
            parse_options(e, &options);
            owned = mdy_parse(s ? s : "", slen, &options);
            tree = owned ? mdy_root(owned) : NULL;
        }
        free(s);
    } else if (js_is_object(args[0]) &&
               js_is_string(get_val(e, args[0], "type"))) {
        owned = mdy_doc_new();
        tree = owned ? js_to_tree(e, owned, args[0]) : NULL;
    }

    if (!tree) {
        mdy_free(owned);
        const char *msg = "mdy: $.toc expects MDY text, a hast node, or a rendered document";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }

    Heading *entries = NULL;
    size_t count = 0, cap = 0;
    collect_headings(tree, &entries, &count, &cap);

    JsValue out = js_array_new(ctx, (uint32_t)count);
    js_gc_protect(e->vm, &out);
    for (size_t i = 0; i < count; i++) {
        JsValue entry = js_object_new(e->ctx);
        js_gc_protect(e->vm, &entry);
        set_val(e, entry, "depth", js_number(entries[i].depth));
        set_val(e, entry, "text", str(e->vm, entries[i].text, strlen(entries[i].text)));
        if (entries[i].id)
            set_val(e, entry, "slug", str(e->vm, entries[i].id, strlen(entries[i].id)));
        push_item(e, out, entry);
        js_gc_unprotect(e->vm, &entry);
    }
    js_gc_unprotect(e->vm, &out);
    free_headings(entries, count);
    mdy_free(owned);
    *result = out;
    return true;
}


/* ---- publishing to a page ----------------------------------------------------
 *
 * `$.emit`'s other tense. `$.emit` writes an output; `$.publish` sends a
 * message to a page of this set BY NAME, and what happens to it is the
 * embedder's business — exactly as an emitted output is.
 *
 * A page's name is its path with the extension dropped and the separators
 * turned into dots: `handlers/invoice.mdy` is `handlers.invoice`. A document
 * may override that with `messageName` in its front matter. It is NOT `name`,
 * which is already taken twice over — every walked source carries its file's
 * base name, and a data record commonly declares its own — and reusing it
 * would let an author's data silently readdress their messages.
 */

/* The grammar is a file name's, because a subject is one where these end up:
 * letters, digits, `_`, `.` and `-`, 1–128 of them, no leading or trailing
 * dot and no `..`. */
static const char *name_problem(const char *name, char *buf, size_t buf_len) {
    if (!name || !*name) return "must be a non-empty string";
    size_t n = strlen(name);
    /* One rule, so one message: the grammar is a single anchored pattern, and
     * a name that is too long fails it the same way one with a space does. */
    int legal = n <= 128;
    for (size_t i = 0; i < n && legal; i++) {
        char c = name[i];
        legal = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-';
    }
    if (!legal) {
        snprintf(buf, buf_len,
                 "may only contain letters, digits, \"_\", \".\" and \"-\", and must be "
                 "1\u2013128 characters (got \"%s\")", name);
        return buf;
    }
    if (name[0] == '.' || name[n - 1] == '.') return "must not start or end with \".\"";
    if (strstr(name, "..")) return "must not contain \"..\"";
    return NULL;
}

/* A document's message name, or NULL — most documents are never published to,
 * and a name is only required of the ones that are. Caller frees. */
static char *message_name(mdy_engine *e, size_t at) {
    JsValue record = document_record(e, at);
    js_gc_protect(e->vm, &record);

    /*
     * A record carrying an `ext` that is not .mdy/.md is skipped: a set built
     * from a directory holds raw records too, and a message RENDERS the page
     * it names, so a record with nothing to run is not an endpoint. It also
     * stops static/logo.png and static/logo.jpg colliding on `static.logo`.
     * A set built from a string has no `ext` at all and stays addressable.
     */
    char *ext = js_string_utf8(get_val(e, record, "ext"));
    if (ext) {
        int runnable = ends_with_ci(ext, ".mdy") || ends_with_ci(ext, ".md");
        free(ext);
        if (!runnable) { js_gc_unprotect(e->vm, &record); return NULL; }
    }

    char *declared = js_string_utf8(get_val(e, record, "messageName"));
    if (declared && *declared) { js_gc_unprotect(e->vm, &record); return declared; }
    free(declared);

    char *path = js_string_utf8(get_val(e, record, "path"));
    js_gc_unprotect(e->vm, &record);
    if (!path || !*path) { free(path); return NULL; }

    /* Drop the extension — the last dot, but only in the last segment. */
    char *slash = strrchr(path, '/');
    char *dot = strrchr(slash ? slash : path, '.');
    if (dot && dot != path) *dot = '\0';
    for (char *p = path; *p; p++) if (*p == '/') *p = '.';
    if (!*path) { free(path); return NULL; }
    return path;
}

static bool publish_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                           int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    *result = js_null();

    char *name = argc > 0 ? js_string_utf8(args[0]) : NULL;
    char why[512];
    const char *problem = name_problem(name, why, sizeof why);
    if (problem) {
        char msg[768];
        snprintf(msg, sizeof msg, "mdy: publish: a message name %s", problem);
        free(name);
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }

    /* Which documents answer to it. Deciding that the name means a page of
     * this set is the whole of core's job here. */
    size_t found = 0, first = 0;
    char others[512];
    size_t used = 0;
    others[0] = '\0';
    for (size_t i = 0; i < e->set.count; i++) {
        char *have = message_name(e, i);
        if (have && strcmp(have, name) == 0) {
            if (found == 0) first = i;
            found++;
            char *path = js_string_utf8(
                get_val(e, document_record(e, i), "path"));
            if (path && used + strlen(path) + 3 < sizeof others)
                used += (size_t)snprintf(others + used, sizeof others - used,
                                         "%s%s", used ? ", " : "", path);
            free(path);
        }
        free(have);
    }

    if (found == 0) {
        char msg[512];
        snprintf(msg, sizeof msg,
                 "mdy: publish: no document is named \"%s\" (a page's name is its path "
                 "without the extension, \"/\" written as \".\")", name);
        free(name);
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    if (found > 1) {
        char msg[768];
        snprintf(msg, sizeof msg,
                 "mdy: publish: \"%s\" is ambiguous \u2014 %zu documents share it (%s); "
                 "give one of them a messageName", name, found, others);
        free(name);
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }

    if (e->cb.on_publish) {
        /*
         * The data arrives ALREADY serialised, by the guest's own
         * JSON.stringify — see the `$` wrapper. That is deliberate: a second
         * serialiser written here would need its own number formatting, and
         * getting that subtly wrong is exactly the kind of difference that
         * shows up as a last digit in a page and nowhere else.
         */
        char *json = argc > 1 ? js_string_utf8(args[1]) : NULL;
        e->cb.on_publish(e->cb.on_publish_ud, name, json ? json : "{}", first);
        free(json);
    }
    free(name);
    return true;
}


/* ---- $.resize ----------------------------------------------------------------
 *
 * A document asks for a smaller copy of an image and gets back where to find
 * it:
 *
 *   % const logo = $.findOne({ path: 'static/logo.png' })
 *   % const thumb = $.resize(logo, { width: 200 })
 *   <img src="{{ thumb.url }}" width="{{ thumb.width }}" height="{{ thumb.height }}">
 *
 * The resized image is a BUILD OUTPUT and is never written back into the
 * site's own static/ — it reaches the embedder through the binary-output
 * callback, the same way `$.emit` reaches it with a page. Its path is
 * DIST-relative rather than site-relative: a source under static/ has that
 * prefix stripped, because a build copies static/'s contents straight to the
 * output root and a resized file has to land in the same flattened space or
 * its URL would not match how every other asset is served.
 *
 * PNG only. That is parity, not a shortfall: mdy-docs' own CODECS table holds
 * one entry, because @jsquash's JPEG codec has a different init shape and was
 * never wired up.
 *
 * The BYTES will not match mdy-docs'. It resizes with Squoosh's codecs and
 * this uses stb — a different resampler and a different encoder, so the same
 * request gives a visually equivalent image with a different file. It is the
 * one place in this port where output is not byte-for-byte the JavaScript's,
 * and it is stated wherever resize is documented rather than discovered.
 */

static const char *STATIC_PREFIX = "static/";

/* A resize already done, so the same request does not decode twice. */
struct Resized {
    char *path;
    int width, height;
};

/*
 * `from` is the package whose FILE is being read, which is not always the one
 * whose code asked. `style.resize(logo, …)` names a record belonging to the
 * imported package, and its bytes are under that package's root — reading
 * them relative to the importer's finds nothing.
 */
static bool resize_in(mdy_engine *e, mdy_engine *from, const JsValue *args,
                      int argc, JsValue *result);

static bool resize_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                          int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    return resize_in(e, e, args, argc, result);
}

/* `$.__importResize(spec, record, options)` — the same work, reading from the
 * imported package. */
static bool import_resize_native(JsContext *ctx, JsValue this_val, const JsValue *args,
                                 int argc, JsValue *result) {
    ((mdy_engine *)js_context_userdata(ctx))->compose.taint = 1; /* reached outside: see the render memo */
    (void)this_val;
    mdy_engine *e = js_context_userdata(ctx);
    char *spec = argc > 0 ? js_string_utf8(args[0]) : NULL;
    if (!spec) { *result = js_undefined(); return true; }
    mdy_engine *set = lookup_import(e, spec, NULL, 0);
    free(spec);
    if (!set) {
        const char *msg = "mdy: import was not resolved";
        *result = str(e->vm, msg, strlen(msg));
        return false;
    }
    /* Values stay the CALLER's — only the root to read from changes. */
    return resize_in(e, set, args + 1, argc - 1, result);
}

/* The `{ path, url, width, height }` object $.resize answers with — built the
 * same way whether the result was just made or found already done. */
static JsValue resize_result(mdy_engine *e, const char *out_path, int width, int height) {
    JsValue r = js_object_new(e->ctx);
    js_gc_protect(e->vm, &r);
    set_val(e, r, "path", str(e->vm, out_path, strlen(out_path)));
    char url[1100];
    int n = snprintf(url, sizeof url, "/%s", out_path);
    set_val(e, r, "url", str(e->vm, url, (size_t)n));
    set_val(e, r, "width", js_number(width));
    set_val(e, r, "height", js_number(height));
    js_gc_unprotect(e->vm, &r);
    return r;
}

static bool resize_in(mdy_engine *e, mdy_engine *from, const JsValue *args,
                      int argc, JsValue *result) {
    char msg[768];

    /*
     * EVERY failure, and the reason it took three lines to write one.
     *
     * A resize reports by ANSWERING with the message rather than throwing, so
     * each of the seven exits below has to format, release the three strings
     * it borrowed, hand the text back and return false — in that order,
     * because five of the messages interpolate `path` or `ext` and cannot be
     * formatted after those are freed.
     *
     * That ordering is why the macro FREES: a macro that did not could only
     * be used by the two messages that say nothing about the file. `path`,
     * `ext` and `shown` are declared above every use, and a NULL among them
     * is what `free` is for.
     */
#define RESIZE_FAIL(...) do { \
        snprintf(msg, sizeof msg, __VA_ARGS__); \
        free(path); free(ext); free(shown); \
        *result = str(e->vm, msg, strlen(msg)); \
        return false; \
    } while (0)

    JsValue doc = argc > 0 ? args[0] : js_undefined();
    /* `JSON.stringify` of an undefined value is undefined, not a string —
     * which concatenates as "undefined", so that is what is printed. */
    char *shown = argc > 2 ? js_string_utf8(args[2]) : NULL;
    const char *got = shown ? shown : "undefined";

    char *path = js_is_object(doc)
        ? js_string_utf8(get_val(e, doc, "path")) : NULL;
    char *ext = js_is_object(doc)
        ? js_string_utf8(get_val(e, doc, "ext")) : NULL;
    if (!path || !ext)
        RESIZE_FAIL("resize: expected a file document (path/ext, from $.find/$.findOne), not %s",
                    got);

    char lower[64];
    snprintf(lower, sizeof lower, "%s", ext);
    for (char *p = lower; *p; p++) if (*p >= 'A' && *p <= 'Z') *p = (char)(*p - 'A' + 'a');
    if (strcmp(lower, ".png") != 0)
        RESIZE_FAIL("resize: unsupported image type \"%s\" (supported: .png)", ext);

    JsValue vw = get_val(e, doc, "width");
    JsValue vh = get_val(e, doc, "height");
    if (!js_is_number(vw) || !js_is_number(vh))
        RESIZE_FAIL("resize: %s has no known width/height (its dimensions could not be read)",
                    path);
    double src_w = js_get_number(vw), src_h = js_get_number(vh);

    /* At least one of width/height; the other follows from the aspect ratio. */
    JsValue options = argc > 1 && js_is_object(args[1]) ? args[1] : js_undefined();
    JsValue ow = js_is_object(options) ? get_val(e, options, "width")
                                       : js_undefined();
    JsValue oh = js_is_object(options) ? get_val(e, options, "height")
                                       : js_undefined();
    int has_w = js_is_number(ow), has_h = js_is_number(oh);
    if (!has_w && !has_h) RESIZE_FAIL("resize: pass at least one of { width, height }");
    double want_w = has_w ? js_get_number(ow) : 0;
    double want_h = has_h ? js_get_number(oh) : 0;
    if (!has_w) want_w = floor((want_h / src_h) * src_w + 0.5);
    if (!has_h) want_h = floor((want_w / src_w) * src_h + 0.5);
    int width = (int)floor(want_w + 0.5);
    int height = (int)floor(want_h + 0.5);
    if (width < 1) width = 1;
    if (height < 1) height = 1;

    /* Where it lands: dist-relative, with static/ flattened away. */
    size_t plen = strlen(path), elen = strlen(ext);
    size_t stem_len = plen >= elen ? plen - elen : plen;
    const char *stem = path;
    if (stem_len >= strlen(STATIC_PREFIX) &&
        strncmp(path, STATIC_PREFIX, strlen(STATIC_PREFIX)) == 0) {
        stem += strlen(STATIC_PREFIX);
        stem_len -= strlen(STATIC_PREFIX);
    }
    char out_path[1024];
    snprintf(out_path, sizeof out_path, "%.*s-%dx%d%s",
             (int)stem_len, stem, width, height, ext);

    /* Already done? The same request must not decode the file twice. */
    mdy_engine *t = token_table(e);
    for (size_t i = 0; i < t->compose.resized_count; i++) {
        if (strcmp(t->compose.resized[i].path, out_path) == 0) {
            free(path); free(ext); free(shown);
            *result = resize_result(e, out_path, t->compose.resized[i].width, t->compose.resized[i].height);
            return true;
        }
    }

    if (!from->graph.root)
        RESIZE_FAIL("resize: this document set was not opened from a directory, "
                    "so there is no file to read");

    size_t len = 0;
    uint8_t *bytes = fsx_read(from->graph.root, path, &len);
    if (!bytes) RESIZE_FAIL("resize: cannot read %s", path);

    size_t out_len = 0;
    uint8_t *made = mdy_image_resize_png(bytes, len, width, height, &out_len);
    free(bytes);
    if (!made) RESIZE_FAIL("resize: %s could not be decoded as a PNG", path);

    if (e->cb.on_binary) e->cb.on_binary(e->cb.on_binary_ud, out_path, made, out_len);
    free(made);

    /* Remembered on the token table, which the whole import graph shares — a
     * theme and the site that imported it must not each make their own copy. */
    /*
     * `if (grown)` here meant a resize that was not remembered, which is a
     * second copy written for the same picture -- and `strdup` was not checked
     * at all, so the table could hold a NULL that every later comparison
     * dereferenced. See xalloc.h.
     */
    t->compose.resized = mdy_xrealloc(t->compose.resized, (t->compose.resized_count + 1) * sizeof *t->compose.resized);
    t->compose.resized[t->compose.resized_count].path = mdy_xstrdup(out_path);
    t->compose.resized[t->compose.resized_count].width = width;
    t->compose.resized[t->compose.resized_count].height = height;
    t->compose.resized_count++;
    free(path); free(ext); free(shown);
    *result = resize_result(e, out_path, width, height);
    return true;
#undef RESIZE_FAIL
}


/* ---- guest ES modules --------------------------------------------------------
 *
 * The OTHER kind of import: `% const util = await import("./lib/util.js")`.
 *
 * `% import x from "…"` is an mdy PACKAGE, rewritten before the compiler ever
 * sees it (see rewrite_imports). This is a real ES module, compiled and linked
 * by the engine, and it reaches the host through two callbacks.
 *
 * Modules stay INSIDE their own package, mirroring the package-import design:
 * an imported package's templates load their own modules through their own
 * set, and nothing here reaches across a package root or outside the graph.
 */

/*
 * A specifier's canonical form: an ABSOLUTE path inside the package, which
 * becomes the module's registry identity. So "./util.js" reached from two
 * directories is two modules, and one file reached by two spellings is one.
 *
 * A module's own imports resolve against the MODULE; a document's resolve
 * against the FILE that wrote it — the same rule a relative import follows
 * everywhere else.
 */
static bool module_canonicalize(void *ud, const uint16_t *spec, size_t spec_len,
                                const uint16_t *referrer, size_t ref_len,
                                const uint16_t **out, size_t *out_len) {
    mdy_engine *e = ud;
    char *specifier = from_utf16(spec, spec_len);
    char *from = ref_len ? from_utf16(referrer, ref_len) : NULL;
    if (!specifier) { free(from); return false; }

    /* The engine's own module is its own name, from anywhere. */
    if (strcmp(specifier, MDY_HIGHLIGHT_SPEC) == 0) {
        free(specifier);
        free(from);
        *out = spec;
        *out_len = spec_len;
        return true;
    }

    char base[4096];
    if (from && *from) {
        dirname_of(from, base, sizeof base);
    } else {
        /* No referrer: a document asked, so resolve against the document's own
         * file. `e->current` is the document being rendered. */
        char joined[4096];
        char *path = NULL;
        if (e->graph.current < e->set.count) {
            JsValue record = document_record(e, e->graph.current);
            js_gc_protect(e->vm, &record);
            path = js_string_utf8(get_val(e, record, "path"));
            js_gc_unprotect(e->vm, &record);
        }
        snprintf(joined, sizeof joined, "%s/%s", e->graph.root ? e->graph.root : "",
                 path ? path : "");
        free(path);
        dirname_of(joined, base, sizeof base);
    }

    char resolved[4096];
    resolve_path(base, specifier, resolved, sizeof resolved);
    free(specifier);
    free(from);

    /* The engine copies before this returns, so a per-engine buffer is enough
     * and it need only outlive the call. */
    free(e->graph.module_spec);
    size_t n = 0;
    e->graph.module_spec = to_utf16(resolved, strlen(resolved), &n);
    if (!e->graph.module_spec) return false;
    *out = e->graph.module_spec;
    *out_len = n;
    return true;
}

/* The loader answers with a promise; these are the two already-settled cases,
 * which is all this needs — reading a file here is synchronous. */
static JsValue settled(JsContext *ctx, JsValue v, int ok) {
    /* `v` is a string made a moment ago and held nowhere but here, and
     * making the promise allocates: without this, a collection between the
     * two takes the module's source, and the compiler reads whatever the
     * memory holds now. Found by MDY_GC_STRESS on the first 380 KB module. */
    mdy_engine *e = js_context_userdata(ctx);
    js_gc_protect(e->vm, &v);
    JsValue p = js_promise_new(ctx);
    if (!js_is_undefined(p)) { if (ok) js_resolve(ctx, p, v); else js_reject(ctx, p, v); }
    js_gc_unprotect(e->vm, &v);
    return p;
}

/* The module's source, or a rejected promise saying why not. */
static JsValue module_load(void *ud, JsContext *ctx,
                           const uint16_t *spec, size_t spec_len,
                           const uint16_t *referrer, size_t ref_len) {
    (void)referrer; (void)ref_len;
    mdy_engine *e = ud;
    e->compose.taint = 1; /* an import reaches outside: see the render memo */
    char *specifier = from_utf16(spec, spec_len);
    char msg[1024];

    if (!specifier) return js_undefined();

    /* highlight.js, in lamassu's subset, as an ES module: what a document
     * gets from `import { highlightCode } from "mdy-docs/highlight"`, and
     * what the engine itself loads to colour fences. See load_highlighter()
     * and third_party/highlight.js. */
    if (strcmp(specifier, MDY_HIGHLIGHT_SPEC) == 0) {
        free(specifier);
        return settled(ctx, str(e->vm, MDY_HIGHLIGHT_MODULE, strlen(MDY_HIGHLIGHT_MODULE)), 1);
    }

    size_t n = strlen(specifier);
    int js = (n > 3 && ends_with_ci(specifier, ".js")) ||
             (n > 4 && ends_with_ci(specifier, ".mjs"));
    if (!js) {
        snprintf(msg, sizeof msg,
                 "only .js/.mjs modules can be imported (got \"%s\")", specifier);
        free(specifier);
        return settled(ctx, str(e->vm, msg, strlen(msg)), 0);
    }

    /* Inside this package, and nowhere else. */
    size_t root_len = e->graph.root ? strlen(e->graph.root) : 0;
    int inside = e->graph.root && n > root_len + 1 &&
                 strncmp(specifier, e->graph.root, root_len) == 0 &&
                 specifier[root_len] == '/';
    if (!inside) {
        snprintf(msg, sizeof msg, "module \"%s\" is outside this package (%s)",
                 specifier, e->graph.root ? e->graph.root : "no directory");
        free(specifier);
        return settled(ctx, str(e->vm, msg, strlen(msg)), 0);
    }

    size_t len = 0;
    /* Absolute, against the bare-slash root fsx.c treats as "as given" — and
     * given whole: a Windows path here is `D:/…`, and `+ 1` took its drive. */
    uint8_t *bytes = fsx_read("/", specifier, &len);
    if (!bytes) {
        snprintf(msg, sizeof msg, "module not found: %s", specifier);
        free(specifier);
        return settled(ctx, str(e->vm, msg, strlen(msg)), 0);
    }
    free(specifier);

    JsValue source = str(e->vm, (const char *)bytes, len);
    free(bytes);
    return settled(ctx, source, 1);
}

static void register_natives(mdy_engine *e) {
    register_one(e, "__compose", compose_native);
    register_one(e, "__find", find_native);
    register_one(e, "__findOne", find_one_native);
    register_one(e, "__data", data_native);
    register_one(e, "__render", render_native);
    register_one(e, "__text", text_native);
    register_one(e, "__emit", emit_native);
    register_one(e, "__tokenize", tokenize_native);
    register_one(e, "__rfc822", rfc822_native);
    register_one(e, "__importRender", import_render_native);
    register_one(e, "__importFind", import_find_native);
    register_one(e, "__importFindOne", import_find_one_native);
    register_one(e, "__parse", parse_native);
    register_one(e, "__markdown", markdown_native);
    register_one(e, "__node", node_native);
    register_one(e, "__html", html_native);
    register_one(e, "__table", table_native);
    register_one(e, "__toc", toc_native);
    register_one(e, "__publish", publish_native);
    register_one(e, "__resize", resize_native);
    register_one(e, "__importResize", import_resize_native);
}

/*
 * `$` is built in the wrapper source rather than as an object of native
 * function VALUES, because lamassu's public API has no way to make one:
 * js_register_native defines a global, and there is no js_function_new. So
 * one global native stands behind every name, exactly as mdy-docs' own
 * `__call` does — minus the JSON, since arguments now cross as values.
 *
 * Closing that gap is worth doing when `$` starts doing real work; a native
 * per name is clearer than a name-dispatching one, and it is the same small
 * addition to lamassu that js_array_new was.
 */


/* ---- the pieces ------------------------------------------------------------- */

mdy_engine *mdy_engine_new(mdy_session *session) {
    if (!session) return NULL;
    mdy_engine *e = calloc(1, sizeof *e);
    if (!e) return NULL;
    e->session = session;
    JsVmConfig cfg = {0};
    /*
     * Two knobs for testing, and they earn their place: this engine hands the
     * VM values it has just built, and a value reachable only from the C stack
     * is invisible to the collector. Such a bug shows up as a property
     * silently becoming a DIFFERENT one — no crash, no error — and only in a
     * run long enough to collect at the wrong moment.
     *
     * MDY_GC_STRESS=1 collects at every safe point, which turns that from a
     * once-in-a-93-page-build event into a certainty.
     * MDY_GC_THRESHOLD=<bytes> moves the first collection, and setting it
     * enormous is how to ask "is this a collector problem at all?".
     */
    if (getenv("MDY_GC_THRESHOLD"))
        cfg.gc_threshold = (size_t)strtoull(getenv("MDY_GC_THRESHOLD"), NULL, 10);
    if (getenv("MDY_GC_STRESS")) cfg.gc_stress = true;
    e->vm = js_vm_new(&cfg);
    if (!e->vm) { free(e); return NULL; }
    e->set.handle = -1;
    e->ctx = js_context_new(e->vm);
    if (!e->ctx) { js_vm_free(e->vm); free(e); return NULL; }
    /* So a native can find the engine it belongs to. */
    js_context_set_userdata(e->ctx, e);
    /*
     * `await import("./lib/util.js")` — a guest ES module, resolved against
     * the file that asked and read from inside this package.
     *
     * Source modules are a CAPABILITY in lamassu, off unless the frontend
     * turns them on: the runtime alone can link precompiled bytecode but has
     * no parser to compile a source string. A document engine compiles
     * documents from source already, so it has the frontend and this costs
     * nothing.
     */
    js_set_module_loader(e->ctx, module_load, module_canonicalize, e);
    js_enable_source_modules(e->ctx);
    register_natives(e);
    e->highlight.fn = js_undefined();
    e->highlight.state = 0;
    return e;
}

/* ---- fenced code ------------------------------------------------------------
 *
 * mdy-docs colours fenced code with lowlight — highlight.js's grammars,
 * producing hast — as the parser builds the fence. This engine does the same
 * with the same grammars: third_party/highlight.js is highlight.js and
 * lowlight's emitter in lamassu's subset, bundled into MDY_HIGHLIGHT_MODULE
 * and loaded as an ES module the first time a fence asks. The parser calls
 * engine_highlight() with the fence's text and language; the guest returns
 * hast children, which js_to_tree puts into the C tree, and `hljs` goes on
 * the class list after `language-x` — the order mdy-docs writes them in.
 *
 * Loading is lazy and its failure is final: a site with no fences never
 * compiles the 380 KB, and a bundle that will not load says so once and
 * leaves every fence plain — which is also what mdy-docs does for a
 * language it has no grammar for.
 */

static void load_highlighter(mdy_engine *e) {
    e->highlight.state = -1;

    size_t slen = 0;
    uint16_t *spec = to_utf16(MDY_HIGHLIGHT_SPEC, strlen(MDY_HIGHLIGHT_SPEC), &slen);
    if (!spec) return;
    JsValue promise = js_eval_module(e->ctx, spec, slen);
    free(spec);
    if (js_is_undefined(promise)) return;
    js_gc_protect(e->vm, &promise);
    js_run_jobs(e->ctx);

    if (js_promise_state(promise) != 1) {
        JsValue reason = js_promise_result(promise);
        char *text = js_is_object(reason)
            ? js_string_utf8(get_val(e, reason, "message"))
            : js_string_utf8(reason);
        engine_message(e, e->graph.current, 0, 0, "highlight",
                       "fenced code will not be highlighted: the highlighter did not load (%s)",
                       text ? text : "no reason given");
        free(text);
        js_gc_unprotect(e->vm, &promise);
        return;
    }

    size_t nlen = 0;
    uint16_t *name = to_utf16("highlightCode", 13, &nlen);
    /* Rooted in its final home before the promise that reaches it lets go. */
    e->highlight.fn = name ? js_module_get_export(e->ctx, js_promise_result(promise), name, nlen) : js_undefined();
    js_gc_protect(e->vm, &e->highlight.fn);
    free(name);
    js_gc_unprotect(e->vm, &promise);
    if (!js_is_function(e->highlight.fn)) {
        engine_message(e, e->graph.current, 0, 0, "highlight",
                       "fenced code will not be highlighted: the highlighter exports no highlightCode");
        js_gc_unprotect(e->vm, &e->highlight.fn);
        e->highlight.fn = js_undefined();
        return;
    }
    e->highlight.state = 1;
}

static int engine_highlight(void *ud, mdy_doc *doc, mdy_node *code,
                            const char *value, size_t value_len,
                            const char *language, size_t language_len) {
    mdy_engine *e = ud;
    if (e->highlight.state == 0) load_highlighter(e);
    if (e->highlight.state != 1) return 0;

    /* One at a time: making the second string can collect the first. */
    JsValue args[2] = { str(e->vm, value, value_len), js_undefined() };
    js_gc_protect(e->vm, &args[0]);
    args[1] = str(e->vm, language, language_len);
    js_gc_protect(e->vm, &args[1]);
    JsValue result = js_undefined();
    int ok = js_call(e->ctx, e->highlight.fn, js_undefined(), args, 2, &result);
    js_gc_unprotect(e->vm, &args[1]);
    js_gc_unprotect(e->vm, &args[0]);
    if (!ok || !js_is_object(result)) return 0;

    js_gc_protect(e->vm, &result);
    int highlighted = js_get_bool(get_val(e, result, "highlighted"));
    if (highlighted) {
        js_children_to_tree(e, doc, code, get_val(e, result, "children"));
        mdy_add_class(doc, code, "hljs");
    }
    js_gc_unprotect(e->vm, &result);
    return highlighted;
}

mdy_session *mdy_engine_session(const mdy_engine *e) { return e ? e->session : NULL; }

void mdy_engine_free(mdy_engine *e) {
    if (!e) return;
    if (e->highlight.state == 1) js_gc_unprotect(e->vm, &e->highlight.fn);
    for (size_t i = 0; i < e->knobs.scope_count; i++) { free(e->knobs.scope_names[i]); free(e->knobs.scope_json[i]); }
    free(e->knobs.scope_names);
    free(e->knobs.scope_json);
    free(e->compose.last_response);

    /*
     * The graph is freed by whoever owns the cache — every package in it,
     * including this one, is in there exactly once. An importer must not free
     * its imports directly: a package imported twice is one set with two
     * importers, and the second free would be of memory already gone.
     */
    if (e->graph.owns_cache && e->graph.cache) {
        ImportCache *c = e->graph.cache;
        e->graph.cache = NULL;
        for (size_t i = 0; i < c->count; i++) {
            free(c->dirs[i]);
            if (c->sets[i] != e) {
                c->sets[i]->graph.cache = NULL;      /* it does not own it */
                mdy_engine_free(c->sets[i]);
            }
        }
        for (size_t i = 0; i < c->root_count; i++) free(c->roots[i]);
        free(c->roots);
        free(c->dirs);
        free(c->sets);
        free(c);
    }

    for (size_t i = 0; i < e->graph.import_count; i++) {
        free(e->graph.imports[i].source_path);
        free(e->graph.imports[i].spec);
    }
    free(e->graph.imports);
    for (size_t i = 0; i < e->identity.count; i++) {
        if (e->identity.pre) mdy_yaml_free(e->identity.pre[i]);
        if (e->identity.data) mdy_yaml_free(e->identity.data[i]);
        if (e->identity.post) mdy_yaml_free(e->identity.post[i]);
    }
    free(e->identity.pre);
    free(e->identity.data);
    free(e->identity.post);
    free(e->identity.is_md);
    free(e->graph.module_spec);
    for (size_t i = 0; i < e->compose.resized_count; i++) free(e->compose.resized[i].path);
    free(e->compose.resized);
    mdy_engine_clear_context(e);
    free(e->knobs.ctx_names);
    free(e->knobs.ctx_json);
    free(e->knobs.ctx_strict);
    free(e->graph.root);

    close_set(e);
    mdy_free(e->compose.tree_owner);
    js_context_free(e->ctx);
    js_vm_free(e->vm);
    free(e);
}

/*
 * The statements, wrapped as a function of their data.
 *
 * `req`, `res` and `$` are ARGUMENTS, so the same compiled function serves
 * every render of the document — which is the whole reason the script layer
 * produces statements that never mention the request.
 */
/*
 * The document's compiled statements, wrapped in the `$`/`req`/`res` closure.
 * `stmt_len` is the statements' byte length — NOT strlen — because the body a
 * document embeds can hold a NUL (a `.mdy` file's own bytes), and taking the
 * length with strlen truncated the source mid template literal, so the code
 * "did not compile". `*wrapped_len` receives the wrapped source's byte length,
 * which the caller hands to to_utf16 for the same reason.
 */
static char *wrap(mdy_engine *e, const char *statements, size_t stmt_len, size_t *wrapped_len) {
    /*
     * Every `$` native. There is no longer a refusing stand-in behind any of
     * them: the last one, `$.resize`, was the only native that needed a codec
     * rather than a port, and it has one now.
     */
    static const char OPEN[] =
        "(async (req, res, $$) => {\n"
        "const $ = {\n"
        /* The one `$` member that is not a call. mdy-docs embeds it in the
         * program text because it builds a program per document; this wrapper
         * is compiled once and reused for every render of the document, so the
         * number arrives beside `req` instead, on `$$`. Read here, at object
         * construction, so `$.count` is a plain number to the document either
         * way — and so a document cannot reach the host through it. */
        "  count: $$.__count,\n"
        "  find: (q) => __find(q === undefined ? {} : q),\n"
        "  findOne: (q) => __findOne(q === undefined ? {} : q),\n"
        "  withTag: (t) => __find({ tags: String(t).toLowerCase() }),\n"
        "  render: (t, d) => __render(t, d),\n"
        "  text: (t, d) => __text(t, d),\n"
        "  emit: (p, c) => __emit(p, c),\n"
        "  publish: (n, d) => __publish(n, JSON.stringify(d === undefined ? {} : d)),\n"
        /* The one native that is a DEPENDENCY rather than a port: resizing
         * needs JPEG and PNG codecs. It refuses by name so a document that
         * asks gets told, rather than a page quietly missing a picture. */
        /* The record is stringified for the ERROR message — mdy-docs names
         * what it was given when the shape is wrong, and a file record is a
         * handful of fields, so the cost is nothing beside decoding a PNG. */
        "  resize: (r, o) => __resize(r, o === undefined ? {} : o, JSON.stringify(r)),\n"
        "  parse: (s) => __parse(s),\n"
        "  markdown: (s) => __markdown(s),\n"
        "  node: (t) => __node(t),\n"
        "  html: (v) => __html(v),\n"
        "  table: (r, a) => __table(r, a),\n"
        "  toc: (t) => __toc(t),\n"
        "  tokenize: (s) => __tokenize(s),\n"
        "  rfc822: (d) => __rfc822(d),\n"
        "  __importRender: (s, t, c) => __importRender(s, t, c),\n"
        "  __importFind: (s, q) => __importFind(s, q),\n"
        "  __importFindOne: (s, q) => __importFindOne(s, q),\n"
        "  __importResize: (s, r, o) => __importResize(s, r, o === undefined ? {} : o, JSON.stringify(r)),\n"
        "  data: (i) => __data(i),\n"
        "  compose: (o) => __compose(o),\n"
        "};\n"
        "const __transforms = [];\n"
        "const transform = (fn) => { __transforms.push(fn); };\n";

    /*
     * The epilogue, which is mdy-docs' own: a document with no transform hands
     * back its LINES and the host composes them; one with a transform asks for
     * its tree, runs each transform over it, and hands the TREE back. The two
     * shapes are told apart by which key the result carries.
     */
    static const char CLOSE[] =
        /* What the document answered with, for a host that asked to keep it:
         * `res` minus `doc`, which is the tree. */
        "\nconst __answer = () => {\n"
        "  if (!$$.__wantResponse) return;\n"
        "  $$.__answered = true;\n"
        "  const __r = {};\n"
        "  for (const k of Object.keys(res)) if (k !== \"doc\") __r[k] = res[k];\n"
        /* the record's own store id is the store's, not the document's */
        "  if (__r.data && typeof __r.data === \"object\") { const d = {}; for (const k of Object.keys(__r.data)) if (k !== \"_id\") d[k] = __r.data[k]; __r.data = d; }\n"
        "  $$.__response = JSON.stringify(__r);\n"
        "};\n"
        /* ...and for the host, which parses a transform-less document's lines
         * itself and finds the references only then: called again once the
         * tree is final, so the answer has them. */
        "$$.__answer = __answer;\n"
        "if (__transforms.length > 0) {\n"
        "  let __tree = $.compose(__out);\n"
        "  res.doc = __tree;\n"
        "  for (const fn of __transforms) {\n"
        "    const returned = fn(__tree);\n"
        "    if (returned !== undefined && returned !== null) {\n"
        "      if (typeof returned !== \"object\" || typeof returned.type !== \"string\") {\n"
        "        throw \"transform must return a hast node ({ type, ... }), or undefined after changing the tree in place\";\n"
        "      }\n"
        "      __tree = returned;\n"
        "    }\n"
        "    res.doc = __tree;\n"
        "  }\n"
        "  __answer();\n"
        "  return { tree: __tree };\n"
        "}\n"
        "__answer();\n"
        "return { out: __out };\n})";
    /* The host's values, each a `const` of its own name — after the
     * toolkit, so the names are checked against it rather than shadowing
     * it (mdy_engine_set_scope_json refuses the toolkit's). */
    size_t scope_len = 0;
    for (size_t i = 0; i < e->knobs.scope_count; i++) scope_len += 2 * strlen(e->knobs.scope_names[i]) + 32;
    /*
     * memcpy and not snprintf for the big pieces: snprintf returns `int`, and
     * a document over two gigabytes overflows it — the cast to size_t then
     * makes `out + o` an address nowhere near the buffer — AddressSanitizer
     * calls it `negative-size-param`. Pathological, and memcpy is also the
     * simpler thing to read.
     *
     * The scope lines keep snprintf: each is one short identifier twice, the
     * reservation above gives it 2*len + 32, and its return cannot overflow an
     * int at that size. It is still checked, because a negative would be the
     * same bug in miniature.
     */
    size_t open_len = strlen(OPEN), tool_len = strlen(MDY_TOOLKIT);
    size_t close_len = strlen(CLOSE);   /* stmt_len is the caller's, may span a NUL */
    size_t n = open_len + tool_len + scope_len + stmt_len + close_len + 1;
    char *out = malloc(n);
    if (!out) return NULL;
    size_t o = 0;
    memcpy(out + o, OPEN, open_len); o += open_len;
    memcpy(out + o, MDY_TOOLKIT, tool_len); o += tool_len;
    for (size_t i = 0; i < e->knobs.scope_count; i++) {
        int w = snprintf(out + o, n - o, "const %s = $$.__scope[\"%s\"];\n",
                         e->knobs.scope_names[i], e->knobs.scope_names[i]);
        if (w < 0 || (size_t)w >= n - o) { free(out); return NULL; }
        o += (size_t)w;
    }
    memcpy(out + o, statements, stmt_len); o += stmt_len;
    memcpy(out + o, CLOSE, close_len); o += close_len;
    out[o] = '\0';
    *wrapped_len = o;
    return out;
}

/*
 * `scriptOutput`: the `[line, text]` pairs the document produced, flattened
 * into lines. One push can still yield several, when what was interpolated had
 * newlines in it.
 */
static char *flatten(JsValue out, size_t *out_len) {
    size_t cap = 4096, len = 0;
    char *text = mdy_xmalloc(cap);
    text[0] = '\0';

    uint32_t n = js_array_length(out);
    for (uint32_t i = 0; i < n; i++) {
        JsValue pair = js_array_get(out, i);
        JsValue value = js_array_get(pair, 1);
        size_t ulen = 0;
        const uint16_t *u = js_string_units(value, &ulen);
        char *piece = u ? from_utf16(u, ulen) : NULL;
        if (!piece) continue;
        size_t plen = strlen(piece);
        if (len + plen + 2 > cap) {
            while (len + plen + 2 > cap) cap *= 2;
            char *grown = realloc(text, cap);
            if (!grown) { free(piece); free(text); return NULL; }
            text = grown;
        }
        /* between EVERY pair, empty ones included — `lines.join('\n')` keeps
         * a leading blank line, and a position counts it */
        if (i) text[len++] = '\n';
        memcpy(text + len, piece, plen);
        len += plen;
        text[len] = '\0';
        free(piece);
    }
    *out_len = len;
    return text;
}

/* The lines a document produced, parsed — what `$.compose` returns and what a
 * document with no transform gets at the end. */
static mdy_doc *parse_lines(JsValue out, mdy_engine *e) {
    size_t text_len = 0;
    char *text = flatten(out, &text_len);
    if (!text) return NULL;

    /* What the document engine asks the parser for: it has already taken the
     * front matter off and split the documents, and the code has already run
     * — so all three are the parser's business no longer. */
    mdy_options options;
    parse_options(e, &options);

    /*
     * Where each produced line came from, in the FILE: the pair's line is a
     * 0-based line of the body, the body's lines were once lines of the
     * chunk (a ```data fence taken out moved the ones under it), and the
     * chunk's lines sit under its front matter. One pair can be several
     * lines when what was interpolated had newlines in it; they all name the
     * line of the code that wrote them, which is the only honest answer.
     */
    uint32_t *map = NULL;
    size_t map_len = 0;
    if (e->graph.current < e->set.count) {
        const Document *d = &e->set.docs[e->graph.current];
        size_t body_count = 0;
        const uint32_t *body_lines = mdy_data_body_lines(d->fences, &body_count);
        uint32_t n = js_array_length(out);
        size_t cap = n + 16;
        map = malloc(cap * sizeof *map);
        for (uint32_t i = 0; map && i < n; i++) {
            JsValue pair = js_array_get(out, i);
            JsValue at = js_array_get(pair, 0);
            size_t body_line = js_is_number(at) ? (size_t)js_get_number(at) : 0;
            size_t chunk_line = body_lines && body_line < body_count ? body_lines[body_line] : body_line;
            uint32_t file_line = (uint32_t)(d->matter_lines + chunk_line + 1);
            char *piece = js_string_utf8(js_array_get(pair, 1));
            size_t lines_in = 1;
            for (const char *p = piece; p && *p; p++) if (*p == '\n') lines_in++;
            free(piece);
            if (map_len + lines_in > cap) {
                while (map_len + lines_in > cap) cap *= 2;
                uint32_t *grown = realloc(map, cap * sizeof *map);
                if (!grown) { free(map); map = NULL; break; }
                map = grown;
            }
            for (size_t k = 0; k < lines_in; k++) map[map_len++] = file_line;
            if (linemap_debug())
                fprintf(stderr, "linemap doc %zu: pair %u body %zu chunk %zu file %u (matter %zu, body lines %zu)\n",
                        e->graph.current, i, body_line, chunk_line, file_line, d->matter_lines, body_count);
        }
        if (map) { options.line_map = map; options.line_map_len = map_len; }
    }

    mdy_doc *tree = mdy_parse(text, text_len, &options);
    free(text);
    free(map);

    if (tree && e->cb.on_message) {
        size_t n = mdy_message_count(tree);
        for (size_t i = 0; i < n; i++) {
            const mdy_message *m = mdy_message_at(tree, i);
            e->cb.on_message(e->cb.on_message_ud, e->graph.current, m->line, m->column, m->rule, m->reason);
        }
    }
    return tree;
}

static mdy_doc *render_tree(mdy_engine *e, size_t index, JsValue request,
                            char *error, size_t error_len) {
    return render_tree_out(e, index, request, NULL, error, error_len);
}

/* ---- the render memo ----------------------------------------------------------
 *
 * src/mdy.js's, to the letter. A render is a pure function of three things —
 * the document's own code, its own data, and the `req` it was handed — but
 * only if it asked the host for nothing else along the way. A document that
 * queries, renders another document, reads $.data, emits, publishes, resizes
 * or imports has reached outside those three, and its result is not ours to
 * keep: every one of those goes through a native here, and each sets
 * `e->taint`. What is left — layouts, and any document that is only markup —
 * is the bulk of a site's renders.
 *
 * The key is a fingerprint of the document (its text and its record, which
 * is what mdy-docs hashes as path, body and data) with the request as
 * canonical JSON — keys sorted, since this engine's own JSON.stringify walks
 * them in hash order and a key must not depend on that.
 *
 * Why this has to match and not merely help: a composition token's id is
 * the count of renders before it, and a site that indexes its own `$.text`
 * indexes that number. A memo hit is a render that never happened, so hits
 * and misses have to fall exactly where mdy-docs' do.
 *
 * Two generations rather than a bounded map: what a rebuild can reuse is the
 * build before it, and nothing older is worth the memory. Process-wide, as
 * mdy-docs' is — every set in the process shares it, and the fingerprint
 * keeps two sets' documents apart.
 */
#define MEMO_MAX 4096
#define MEMO_SLOTS 8192
typedef struct { uint64_t key; mdy_doc *doc; char *text; } MemoEntry;
typedef struct { MemoEntry slots[MEMO_SLOTS]; size_t count; } MemoTable;

/*
 * The session, which is only ever this: the two memo generations, and the
 * lifetime that says when they end. It is a struct rather than two file
 * statics so that the answer to "how long is this remembered" belongs to
 * something a caller holds — see engine.h.
 */
struct mdy_session {
    MemoTable *now, *prev;
};
static uint64_t fnv64(uint64_t h, const void *p, size_t n) {
    const unsigned char *b = p;
    for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 1099511628211u;
    return h;
}

static void memo_clear(MemoTable *t) {
    if (!t) return;
    for (size_t i = 0; i < MEMO_SLOTS; i++) {
        if (t->slots[i].doc) { mdy_free(t->slots[i].doc); free(t->slots[i].text); }
        t->slots[i].doc = NULL; t->slots[i].text = NULL; t->slots[i].key = 0;
    }
    t->count = 0;
}

mdy_session *mdy_session_new(void) {
    return calloc(1, sizeof(mdy_session));
}

void mdy_session_free(mdy_session *s) {
    if (!s) return;
    /* Both generations, not just the live one: a session ending is the only
     * point at which the older table is anybody's to free, and it holds a
     * whole build's trees. */
    memo_clear(s->now);
    memo_clear(s->prev);
    free(s->now);
    free(s->prev);
    free(s);
}

void mdy_session_rotate_memo(mdy_session *s) {
    if (!s) return;
    memo_clear(s->prev);
    MemoTable *old = s->prev;
    s->prev = s->now;
    s->now = old ? old : calloc(1, sizeof *old);
}

static MemoEntry *memo_find(MemoTable *t, uint64_t key) {
    if (!t || !key) return NULL;
    for (size_t i = key & (MEMO_SLOTS - 1), n = 0; n < MEMO_SLOTS; i = (i + 1) & (MEMO_SLOTS - 1), n++) {
        if (!t->slots[i].doc) return NULL;
        if (t->slots[i].key == key) return &t->slots[i];
    }
    return NULL;
}

static void memo_put(MemoTable *t, uint64_t key, mdy_doc *doc, char *text) {
    if (!t || !key || !doc || t->count >= MEMO_MAX) { mdy_free(doc); free(text); return; }
    for (size_t i = key & (MEMO_SLOTS - 1);; i = (i + 1) & (MEMO_SLOTS - 1)) {
        if (t->slots[i].doc && t->slots[i].key != key) continue;
        if (t->slots[i].doc) { mdy_free(t->slots[i].doc); free(t->slots[i].text); t->count--; }
        t->slots[i].key = key; t->slots[i].doc = doc; t->slots[i].text = text;
        t->count++;
        return;
    }
}

/* A copy of a memoised tree under a fresh document, for the caller to own. */
static mdy_doc *memo_copy(const mdy_doc *stored) {
    mdy_doc *doc = mdy_doc_new();
    if (!doc) return NULL;
    mdy_node *root = mdy_clone(doc, mdy_root(stored));
    mdy_node *into = (mdy_node *)mdy_root(doc);
    if (root) for (mdy_node *c = root->first; c;) { mdy_node *next = c->next; c->next = NULL; mdy_append(into, c); c = next; }
    return doc;
}

/* JSON of a value with every object's keys sorted — JSON.stringify's shape,
 * in an order that does not depend on the engine's — folded into `h`. */
static int key_cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

/*
 * `skip`, when it is not NULL, is one key left OUT — of the TOP object only.
 * A value nested inside may legitimately be called the same thing and is the
 * document's own business; what this is for is `_id`, which the record wears
 * on the outside and which says nothing about the document. See
 * document_fingerprint.
 */
static uint64_t canonical_hash_deep(mdy_engine *e, JsValue v, uint64_t h,
                                    const char *skip, size_t depth, int *too_deep);

static uint64_t canonical_hash_without(mdy_engine *e, JsValue v, uint64_t h, const char *skip) {
    return canonical_hash_deep(e, v, h, skip, 0, NULL);
}

/*
 * `depth` is here for the reason MDY_MAX_DEPTH is: a document can build an
 * object sixty thousand deep in two lines of its own code and hand it to
 * `$.render` as the request, and this walks it. Past the limit it stops and
 * says so through `too_deep`, which is not the same as hashing a marker and
 * carrying on: two different values nested that deep would then hash alike,
 * and a memo key that cannot tell two requests apart is a render served to
 * the wrong one.
 */
static uint64_t canonical_hash_deep(mdy_engine *e, JsValue v, uint64_t h,
                                    const char *skip, size_t depth, int *too_deep) {
    if (depth >= MDY_MAX_DEPTH) {
        if (too_deep) *too_deep = 1;
        return fnv64(h, "!", 1);
    }
    if (js_is_undefined(v)) return fnv64(h, "undefined", 9);
    if (js_is_null(v)) return fnv64(h, "null", 4);
    if (js_is_bool(v)) return js_get_bool(v) ? fnv64(h, "true", 4) : fnv64(h, "false", 5);
    if (js_is_number(v)) { char buf[40]; snprintf(buf, sizeof buf, "%.17g", js_get_number(v)); return fnv64(h, buf, strlen(buf)); }
    if (js_is_string(v)) {
        size_t n = 0; const uint16_t *u = js_string_units(v, &n);
        h = fnv64(h, "\"", 1);
        if (u) h = fnv64(h, u, n * sizeof *u);
        return fnv64(h, "\"", 1);
    }
    if (js_is_array(v)) {
        h = fnv64(h, "[", 1);
        uint32_t n = js_array_length(v);
        for (uint32_t i = 0; i < n; i++) {
            h = canonical_hash_deep(e, js_array_get(v, i), h, NULL, depth + 1, too_deep);
            h = fnv64(h, ",", 1);
        }
        return fnv64(h, "]", 1);
    }
    if (js_is_object(v)) {
        size_t n = js_object_size(v);
        /* A hash has no way to report a failure -- a wrong one is a memo hit
         * on a different request. See xalloc.h. */
        char **names = mdy_xmalloc((n ? n : 1) * sizeof *names);
        size_t m = 0;
        for (size_t i = 0; i < n; i++) { char *k = js_string_utf8(js_object_key_at(v, i)); if (k) names[m++] = k; }
        qsort(names, m, sizeof *names, key_cmp);
        h = fnv64(h, "{", 1);
        for (size_t i = 0; i < m; i++) {
            JsValue val = get_val(e, v, names[i]);
            int left_out = skip && strcmp(names[i], skip) == 0;
            if (!left_out && !js_is_undefined(val) && !js_is_function(val)) {
                h = fnv64(h, names[i], strlen(names[i]));
                h = fnv64(h, ":", 1);
                h = canonical_hash_deep(e, val, h, NULL, depth + 1, too_deep);
                h = fnv64(h, ",", 1);
            }
            free(names[i]);
        }
        free(names);
        return fnv64(h, "}", 1);
    }
    return fnv64(h, "?", 1);
}

/*
 * What the document IS: its text and its record — path, identity, its own
 * data — hashed once, the first time it is rendered.
 *
 * Without `_id`, which is the one thing in a record that is not about the
 * document: a fresh ObjectId minted every time a set is opened. Including it
 * made the fingerprint say WHEN the set was opened, so two builds of an
 * unchanged site never shared a key and the memo's second generation — which
 * exists precisely so "a rebuild may reuse the build before it" — matched
 * nothing, ever. mdy-docs hashes `doc.data`, which is the same record before
 * nisaba puts an id on it.
 *
 * What the ENGINE brings goes in beside the document, because the memo is
 * shared by every set in the process and this is what now lets two of them
 * meet: the same text and the same record still render differently under a
 * different element allowlist, a different task form, or different values in
 * scope. mdy-docs folds in its own equivalent — the native names a set
 * offers — and says the same thing about why.
 */
static uint64_t document_fingerprint(mdy_engine *e, size_t index) {
    Document *d = &e->set.docs[index];
    if (d->fingerprint) return d->fingerprint;
    uint64_t h = 1469598103934665603u;
    /*
     * `n` is the size of the set, and it is here because `$.count` reads it.
     * Without it the memo answers a question it did not key on: add a file to
     * a directory and every OTHER document keeps its fingerprint, so a second
     * build in the same process serves each of them the render made when the
     * set was one document smaller — `$.count` frozen at the old number, in a
     * page that is otherwise correct. mdy-docs can get this wrong the same
     * way in reverse: it embeds the count in the program text, so keying the
     * memo on the text BEFORE the count is substituted in has the same fault.
     * Its
     * fingerprint carries the set's size now, so the two agree here.
     */
    char knobs[32];
    int klen = snprintf(knobs, sizeof knobs, "s%dt%dn%zu", e->knobs.sanitize ? 1 : 0, e->knobs.tasks ? 1 : 0, e->set.count);
    h = fnv64(h, knobs, klen > 0 ? (size_t)klen : 0);
    for (size_t i = 0; i < e->knobs.scope_count; i++) {
        h = fnv64(h, e->knobs.scope_names[i], strlen(e->knobs.scope_names[i]));
        h = fnv64(h, "=", 1);
        h = fnv64(h, e->knobs.scope_json[i], strlen(e->knobs.scope_json[i]));
        h = fnv64(h, "\0", 1);
    }
    h = fnv64(h, d->chunk.text, d->chunk.len);
    h = fnv64(h, "\0", 1);
    JsValue record = document_record(e, index);
    js_gc_protect(e->vm, &record);
    h = canonical_hash_without(e, record, h, "_id");
    js_gc_unprotect(e->vm, &record);
    d->fingerprint = h ? h : 1;
    return d->fingerprint;
}

/* A key as a token id: base 36, which is what token_at reads. */
static void key_base36(uint64_t key, char out[24]) {
    char tmp[24]; int n = 0;
    do { tmp[n++] = "0123456789abcdefghijklmnopqrstuvwxyz"[key % 36]; key /= 36; } while (key && n < 23);
    for (int i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
    out[n] = '\0';
}

static uint64_t memo_key(mdy_engine *e, size_t index, JsValue request) {
    uint64_t h = document_fingerprint(e, index);
    h = fnv64(h, "\0", 1);
    int too_deep = 0;
    h = canonical_hash_deep(e, request, h, NULL, 0, &too_deep);
    /* No key at all rather than one that might belong to another request:
     * zero is what the memo already reads as "do not remember this". The
     * record cannot get here — it comes from YAML, which refuses to nest
     * that deep in the first place. */
    if (too_deep) return 0;
    return h ? h : 1;
}

/*
 * Every GC root one render holds, in one place.
 *
 * A root is an ADDRESS the collector keeps, so the rule these seven live
 * under is that they are registered together and released together: one left
 * registered when the frame returns points at reused stack memory, and the
 * next collection marks whatever now sits there — a crash with no relation to
 * the code that caused it.
 *
 * Being a struct rather than seven locals is what lets the phases below be
 * functions at all. A phase takes `RenderRoots *`, so every address the
 * collector was given belongs to `render_tree_out`'s frame and stays valid
 * for exactly as long as that frame does — which is the same guarantee the
 * seven locals had, now stated once instead of relied on seven times.
 *
 * `rooted` is the whole struct's, not per-field: nothing protects a later
 * root without having protected `fn` first, so one flag answers "is there
 * anything to release" for all of them.
 */
typedef struct {
    int rooted;
    union {
        struct { JsValue fn, promise, callable, req, res, dollar, result; };
        JsValue all[7];
    };
} RenderRoots;
/*
 * Release walks `all` rather than naming the seven, so it cannot forget one —
 * and this says a root cannot be added without joining the array. Adding an
 * eighth field to the struct above grows RenderRoots past the union, and this
 * stops the build rather than leaving a root registered on a dead frame,
 * which is the failure this whole arrangement exists to prevent. It is worth
 * a compile-time check because it is worth nothing at run time: a root left
 * registered is a crash LATER, somewhere else, and the parity suite, the
 * engine tests and MDY_GC_STRESS=1 were each measured against a deliberately
 * leaked root here and none of the three noticed.
 */
_Static_assert(sizeof(RenderRoots) == offsetof(RenderRoots, all) + sizeof(JsValue[7]),
               "a root added to RenderRoots must go in all[] too — roots_release walks it");

static void roots_release(mdy_engine *e, RenderRoots *r) {
    if (!r->rooted) return;
    for (size_t i = 0; i < sizeof r->all / sizeof r->all[0]; i++) js_gc_unprotect(e->vm, &r->all[i]);
    r->rooted = 0;
}

/*
 * The memo, before anything else: a hit is a render that does not happen.
 *
 * A hit found in the PREVIOUS table is promoted into the current one, because
 * the next rotation drops whatever is still only in `prev` — a tree that is
 * being asked for is a tree the next build will ask for too.
 *
 * Returns the entry to answer from, or NULL to go and render.
 */
static MemoEntry *memo_take(mdy_engine *e, size_t index, uint64_t mkey) {
    MemoTable *now = e->session->now, *prev = e->session->prev;
    MemoEntry *hit = memo_find(now, mkey);
    if (!hit) {
        hit = memo_find(prev, mkey);
        if (hit) { memo_put(now, mkey, memo_copy(hit->doc), mdy_xstrdup(hit->text)); hit = memo_find(now, mkey); }
    }
    if (memo_debug()) {
        JsValue rec = document_record(e, index);
        js_gc_protect(e->vm, &rec);
        char *path = js_string_utf8(get_val(e, rec, "path"));
        js_gc_unprotect(e->vm, &rec);
        fprintf(stderr, "memo %s %s\n", hit ? "hit " : "miss", path ? path : "?");
        free(path);
    }
    return hit;
}

/*
 * The other front end. A `.md` file is markup with no code in it, so there is
 * nothing to run: it goes to hast at its own boundary and joins everything
 * else as a tree. The walk keeps its real text on its DATA rather than as a
 * body to compile, which is where this reads it from — and `$.text` on it
 * gives back the file, because no code wrote anything else.
 *
 * Holds no root past its own return: `record` is protected and released here.
 */
static mdy_doc *render_markdown_document(mdy_engine *e, size_t index, uint64_t mkey,
                                         char **wrote, char *error, size_t error_len) {
    JsValue record = document_record(e, index);
    js_gc_protect(e->vm, &record);
    char *text = js_string_utf8(get_val(e, record, "body"));
    js_gc_unprotect(e->vm, &record);
    const char *why = NULL;
    mdy_doc *out = mdy_markdown_parse(text ? text : "", text ? strlen(text) : 0, &why);
    if (!out) {
        free(text);
        if (error && error_len) snprintf(error, error_len, "%s", why ? why : "the markdown document could not be read");
        return NULL;
    }
    /* Pure by construction — no code ran — so kept, as mdy-docs keeps it. */
    if (mkey) memo_put(e->session->now, mkey, memo_copy(out), mdy_xstrdup(text ? text : ""));
    if (memo_debug()) fprintf(stderr, "memo kept #%zu\n", index);
    if (wrote) *wrote = text; else free(text);
    return out;
}

/*
 * The document's own code, from its body to a function this can call: the
 * script layer, the wrapper, the module, and the module's default export.
 *
 * Takes the roots because three of them start here and have to outlive it —
 * `fn`, `promise` and `callable` are live until the render is done with them,
 * and `rooted` turning 1 is what makes the release at `done` release anything
 * at all. `script` goes back to the caller for the same reason: it owns the
 * source the compiled module was made from and is freed at `done`.
 */
static int compile_to_callable(mdy_engine *e, Document *d, mdy_script **script,
                               RenderRoots *r, char *error, size_t error_len) {
#define CFAIL(...) do { if (error && error_len) snprintf(error, error_len, __VA_ARGS__); return 0; } while (0)
    /* 1. the body, which `mdy_engine_open` already took the data out of */
    size_t template_len = 0;
    const char *template_text = mdy_data_body(d->fences, &template_len);

    /* 2. the script layer */
    *script = mdy_script_compile(template_text, template_len);
    if (!*script) CFAIL("the script layer could not compile this document");

    size_t src_len = 0;
    const char *statements = mdy_script_source(*script, &src_len);
    size_t wrapped_len = 0;
    char *wrapped = wrap(e, statements, src_len, &wrapped_len);
    if (!wrapped) CFAIL("out of memory");

    size_t ulen = 0;
    uint16_t *u = to_utf16(wrapped, wrapped_len, &ulen);
    const char *err_msg = NULL;
    uint32_t err_pos = 0;
    r->fn = js_compile_module(e->ctx, u, ulen, &err_msg, &err_pos);
    free(u);
    free(wrapped);
    if (js_is_undefined(r->fn)) CFAIL("the document's code did not compile: %s", err_msg ? err_msg : "?");
    js_gc_protect(e->vm, &r->fn);
    r->rooted = 1;

    r->promise = js_run_module(e->ctx, r->fn);
    js_gc_protect(e->vm, &r->promise);
    js_run_jobs(e->ctx);
    r->callable = js_promise_result(r->promise);
    if (!js_is_function(r->callable)) CFAIL("the document's code did not produce a function");
    js_gc_protect(e->vm, &r->callable);
    return 1;
#undef CFAIL
}

/*
 * The three arguments the document's function is called with: the request,
 * the response, and `$`. All three are roots from here to `done`.
 */
static void make_call_arguments(mdy_engine *e, size_t index, JsValue request, RenderRoots *r) {
    r->req = js_is_object(request) ? request : js_object_new(e->ctx);
    js_gc_protect(e->vm, &r->req);
    r->res = js_object_new(e->ctx);
    js_gc_protect(e->vm, &r->res);
    /*
     * `res.data` is the document's OWN data — its front matter, its data
     * fences and its file identity, the same record `$.data(index)` gives.
     * That is what lets a template write `req.x ?? res.data.x` and always be
     * able to reach its own declared value.
     */
    set_val(e, r->res, "data", record_without_id(e, document_record(e, index)));
    r->dollar = js_object_new(e->ctx);
    js_gc_protect(e->vm, &r->dollar);
    /* the host's scope values, for the `const`s the wrapper declared */
    if (e->knobs.scope_count) {
        JsValue scope = js_object_new(e->ctx);
        set_val(e, r->dollar, "__scope", scope);
        for (size_t i = 0; i < e->knobs.scope_count; i++) {
            JsValue v = context_value(e, e->knobs.scope_json[i], 1);
            set_val(e, scope, e->knobs.scope_names[i], js_is_undefined(v) ? js_null() : v);
        }
    }
    if (e->knobs.want_response) set_val(e, r->dollar, "__wantResponse", js_bool(true));
    /* `$.count`: the documents in THIS set. A render into an imported package
     * runs on that package's engine, so it counts the package's, which is
     * what mdy-docs does by giving each set its own program. */
    set_val(e, r->dollar, "__count", js_number((double)e->set.count));
    /* This render's `res`, for the references its parse will find. */
    e->compose.render_res = r->res;
}

/*
 * If the document returned a promise, run the jobs and take what it settled
 * to. Replaces `result` in place, re-rooting it, because the settled value is
 * a different object from the promise that carried it.
 *
 * Returns 0 when there is nothing to settle to, having said which of the two
 * different problems it was: a rejection reason is not always a string — a
 * thrown Error is an object with `message`, and reporting "did not settle"
 * for one hides the actual fault behind a symptom. Pending and rejected must
 * not read the same either.
 */
static int settle_result(mdy_engine *e, RenderRoots *r, char *error, size_t error_len) {
    if (!js_is_promise(r->result)) return 1;
    js_run_jobs(e->ctx);
    int state = js_promise_state(r->result);
    if (state != 1) {
        JsValue reason = js_promise_result(r->result);
        char *msg = NULL;
        size_t mlen = 0;
        const uint16_t *mu = js_string_units(reason, &mlen);
        if (mu) msg = from_utf16(mu, mlen);
        if (!msg && js_is_object(reason)) {
            JsValue m = get_val(e, reason, "message");
            mu = js_string_units(m, &mlen);
            if (mu) msg = from_utf16(mu, mlen);
        }
        if (error && error_len) {
            if (msg) snprintf(error, error_len, "%s", msg);
            else if (state == 0) snprintf(error, error_len,
                "the document did not settle (a promise is still pending)");
            else snprintf(error, error_len, "the document was rejected with a non-string reason");
        }
        free(msg);
        return 0;
    }
    JsValue settled = js_promise_result(r->result);
    js_gc_unprotect(e->vm, &r->result);
    r->result = settled;
    js_gc_protect(e->vm, &r->result);
    return 1;
}

/*
 * 3. the tree. A document with a transform already has one — it asked for it
 * through `$.compose` and handed back what its transforms made of it — and
 * one without hands back its lines for the host to parse.
 *
 * `transformed` goes back to the caller because the memo write needs to know
 * which of the two happened: a transformed document's text is its tree's
 * HTML, and an untransformed one's is its joined lines.
 */
static mdy_doc *tree_from_result(mdy_engine *e, RenderRoots *r, JsValue *transformed,
                                 char **wrote, char *error, size_t error_len) {
#define TFAIL(...) do { if (error && error_len) snprintf(error, error_len, __VA_ARGS__); return NULL; } while (0)
    JsValue lines_out = get_val(e, r->result, "out");
    if (wrote && js_is_array(lines_out)) {
        /* No transform: the text is what the code wrote, joined — mdy.js's
         * `scriptOutput(out).lines.join('\n')`, which is exactly `flatten`. */
        size_t n = 0;
        *wrote = flatten(lines_out, &n);
    }

    *transformed = get_val(e, r->result, "tree");
    if (js_is_object(*transformed)) {
        /* Already composed: `$.compose` spliced it before the transforms saw
         * it, which is what let a transform work on the finished tree. */
        mdy_doc *doc = mdy_doc_new();
        if (!doc) TFAIL("out of memory");
        mdy_node *root = js_to_tree(e, doc, *transformed);
        /*
         * `mdy_doc` owns its root, so the tree that came back is hung under
         * it: a root lends its children, and a transform that returned a
         * single element becomes that document's one child. Which is what
         * `blockContent` does with a held tree, for the same reason.
         */
        mdy_node *into = (mdy_node *)mdy_root(doc);
        if (root && root->type == MDY_ROOT) {
            for (mdy_node *c = root->first; c;) {
                mdy_node *next = c->next;
                c->next = NULL;
                mdy_append(into, c);
                c = next;
            }
        } else if (root) {
            mdy_append(into, root);
        }
        /* A transformed document has no lines left to hand back — it gave up
         * its `out` for a tree — so its text is that tree's HTML, which is
         * what mdy.js falls back to for exactly this case. */
        if (wrote && !*wrote) *wrote = mdy_to_html(mdy_root(doc), NULL);
        return doc;
    }

    JsValue lines = get_val(e, r->result, "out");
    if (!js_is_array(lines)) TFAIL("the document did not produce its lines");
    mdy_doc *tree = parse_lines(lines, e);
    if (!tree) TFAIL("the produced lines did not parse");
    /* The held trees go back where their tokens are. */
    splice_tree(e, tree, (mdy_node *)mdy_root(tree));
    note_references(e, tree);
    return tree;
#undef TFAIL
}

/*
 * What the render answered with, now that the parse has added what the text
 * refers to — the guest's own serialiser, called from here.
 */
static void take_response(mdy_engine *e, RenderRoots *r) {
    JsValue answer = get_val(e, r->dollar, "__answer");
    JsValue ignored = js_undefined();
    if (js_is_function(answer) && js_call(e->ctx, answer, js_undefined(), NULL, 0, &ignored)) {
        char *text = js_string_utf8(get_val(e, r->dollar, "__response"));
        if (text) { free(e->compose.last_response); e->compose.last_response = text; }
    }
}

/*
 * Park the finished render under its key: its text as well as its tree, since
 * a later hit may be asked for either — `$.text` and the CLI's default output
 * want the text.
 */
static void memo_keep(mdy_engine *e, uint64_t mkey, mdy_doc *out,
                      RenderRoots *r, JsValue transformed, char **wrote) {
    char *text = wrote && *wrote ? strdup(*wrote) : NULL;
    if (!text) {
        JsValue lo = get_val(e, r->result, "out");
        size_t n = 0;
        text = js_is_array(lo) && !js_is_object(transformed) ? flatten(lo, &n) : mdy_to_html(mdy_root(out), NULL);
    }
    memo_put(e->session->now, mkey, memo_copy(out), text ? text : strdup(""));
}

static mdy_doc *render_tree_out(mdy_engine *e, size_t index, JsValue request,
                                char **wrote, char *error, size_t error_len) {
    if (error && error_len) error[0] = '\0';
    if (wrote) *wrote = NULL;

    /* The memo, first: a hit is a render that does not happen.
     *
     * With one exception: the ENTRY render when `--response` is wanted. The
     * response is produced by take_response AFTER a full render (below), and a
     * memo hit returns before it — so a hit would leave `last_response` at
     * whatever the previous render set it to, which in watch mode is a fresh
     * engine's NULL, and `--response` would write `null`. compose.depth is 0
     * only for the outermost render, so nested composition renders still
     * memoise exactly as before and their token ids do not move. */
    if (!e->session->now) mdy_session_rotate_memo(e->session);
    uint64_t mkey = index < e->set.count ? memo_key(e, index, request) : 0;
    int response_entry = e->knobs.want_response && e->compose.depth == 0;
    MemoEntry *hit = response_entry ? NULL : memo_take(e, index, mkey);
    if (hit) {
        key_base36(mkey, e->compose.last_render_key);
        if (wrote) *wrote = mdy_xstrdup(hit->text);
        return memo_copy(hit->doc);
    }
    /*
     * A render inside a render inside a render is a cycle somebody wrote.
     * Checked HERE, before a thing has been put aside to be restored at
     * `done`: it is the one exit that does not go through the label, and it
     * can only be that if there is nothing yet to give back.
     */
    if (e->compose.depth > 32) {
        if (error && error_len)
            snprintf(error, error_len, "mdy-engine: render depth exceeded (cyclic $.render?)");
        return NULL;
    }

    int outer_taint = e->compose.taint;
    e->compose.taint = 0;
    JsValue transformed = js_undefined();
    mdy_doc *out = NULL;
    mdy_script *script = NULL;
    /* The seven roots, released together at `done` — see RenderRoots. `FAIL`
     * jumps straight there, so there is no path that can skip the release. */
    RenderRoots r;
    r.rooted = 0;
    for (size_t i = 0; i < sizeof r.all / sizeof r.all[0]; i++) r.all[i] = js_undefined();
    /* the enclosing render's `res`, put back at `done` whatever happened */
    JsValue outer_res = e->compose.render_res;

    e->compose.depth++;
    /* Which file is asking — an `$.__import*` native resolves its spec
     * against the document that wrote it, and the same spec in two files can
     * mean two packages. */
    size_t outer_current = e->graph.current;
    e->graph.current = index;

#define FAIL(...) do { if (error && error_len) snprintf(error, error_len, __VA_ARGS__); goto done; } while (0)

    if (index >= e->set.count) FAIL("no document at index %zu", index);
    Document *d = &e->set.docs[index];

    if (d->is_markdown) {
        /*
         * `done`, not a return of its own. The key this render is held under
         * is written there, and a .md tree parked under a key nobody set was
         * either LOST — no render had happened, so the id was empty and the
         * token unreadable — or parked under the previous render's id, where
         * the page showed that render twice.
         */
        out = render_markdown_document(e, index, mkey, wrote, error, error_len);
        goto done;
    }

    if (!compile_to_callable(e, d, &script, &r, error, error_len)) goto done;
    make_call_arguments(e, index, request, &r);

    JsValue args[3] = { r.req, r.res, r.dollar };
    if (!js_call(e->ctx, r.callable, js_undefined(), args, 3, &r.result)) {
        size_t mlen = 0;
        const uint16_t *mu = js_string_units(r.result, &mlen);
        char *msg = mu ? from_utf16(mu, mlen) : NULL;
        if (error && error_len) snprintf(error, error_len, "%s", msg ? msg : "the document threw");
        free(msg);
        goto done;
    }
    js_gc_protect(e->vm, &r.result);

    if (!settle_result(e, &r, error, error_len)) goto done;
    if (!js_is_object(r.result)) FAIL("the document did not produce a result");

    out = tree_from_result(e, &r, &transformed, wrote, error, error_len);
    if (!out) goto done;

    /* Last of all, on the finished tree: a contents list names every heading
     * the document ended up with, including ones written below it. */
    fill_toc(e, out);
    if (e->knobs.want_response) take_response(e, &r);
    if (!e->compose.taint && !response_entry && mkey) memo_keep(e, mkey, out, &r, transformed, wrote);
    if (memo_debug()) fprintf(stderr, "memo %s #%zu\n", e->compose.taint ? "impure" : "kept", index);

done:
#undef FAIL
    e->compose.taint = outer_taint;
    e->compose.render_res = outer_res;
    /* Recorded LAST, after any render inside this one recorded its own, so
     * what $.render holds its result under is this render's key.
     *
     * A render with NO key — a request nested deeper than the hash will walk,
     * see memo_key — leaves it empty, and $.render names that tree by count
     * instead. Naming two of them after the same absent key would park both
     * under one id, and the first would be spliced in for the second. */
    if (mkey) key_base36(mkey, e->compose.last_render_key);
    else e->compose.last_render_key[0] = '\0';
    roots_release(e, &r);
    e->graph.current = outer_current;
    e->compose.depth--;
    mdy_script_free(script);
    return out;
}

static char *render_public(mdy_engine *e, size_t index, int want_text, char *error, size_t error_len);

char *mdy_engine_render(mdy_engine *e, size_t index, char *error, size_t error_len) {
    return render_public(e, index, 0, error, error_len);
}

char *mdy_engine_render_text(mdy_engine *e, size_t index, char *error, size_t error_len) {
    return render_public(e, index, 1, error, error_len);
}

/* `mdy: document N failed: <reason>` — what mdy-docs' runDoc throws for any
 * render that did, unless the reason already says which document. */
static void wrap_failure(size_t index, char *error, size_t error_len) {
    if (!error || !error_len || !error[0]) return;
    if (strncmp(error, "mdy: document ", 14) == 0 || strncmp(error, "mdy-engine:", 11) == 0) return;
    char copy[1024];
    snprintf(copy, sizeof copy, "%s", error);
    snprintf(error, error_len, "mdy: document %zu failed: %s", index, copy);
}

/* NULL is no set, and no set has no page — the same answer mdy_engine_count
 * gives, and for the same reason: a host may hold an engine it has not opened
 * (`mdy dev` keeps serving when a build fails) and asking it a question about
 * documents should not be a crash. */
int mdy_engine_page_index(mdy_engine *e, const char *name) {
    if (!e) return -1;
    int found = -1;
    for (size_t i = 0; i < e->set.count; i++) {
        char *have = message_name(e, i);
        int hit = have && strcmp(have, name) == 0;
        free(have);
        if (!hit) continue;
        if (found >= 0) return -2;
        found = (int)i;
    }
    return found;
}

char *mdy_engine_document_path(mdy_engine *e, size_t index) {
    if (!e || index >= e->set.count) return NULL;
    JsValue record = document_record(e, index);
    js_gc_protect(e->vm, &record);
    char *path = js_string_utf8(get_val(e, record, "path"));
    js_gc_unprotect(e->vm, &record);
    return path;
}

char *mdy_engine_render_json(mdy_engine *e, size_t index, const char *request_json,
                             char *error, size_t error_len) {
    if (error && error_len) error[0] = '\0';
    JsValue req = context_value(e, request_json, 1);
    if (js_is_undefined(req)) {
        if (error && error_len) snprintf(error, error_len, "the request is not JSON");
        return NULL;
    }
    js_gc_protect(e->vm, &req);
    mdy_doc *doc = render_tree_out(e, index, req, NULL, error, error_len);
    js_gc_unprotect(e->vm, &req);
    if (!doc) { wrap_failure(index, error, error_len); release_held(e); return NULL; }
    char *html = mdy_to_html(mdy_root(doc), NULL);
    mdy_free(doc);
    release_held(e);
    return html;
}

static char *render_public(mdy_engine *e, size_t index, int want_text, char *error, size_t error_len) {
    if (error && error_len) error[0] = '\0';

    /*
     * The entry document's `req` carries `today` — today's date as
     * YYYY-MM-DD, which is what a site compares a post's date against to
     * decide whether it is published yet. mdy-docs builds the same context,
     * from `new Date()` normalised through toISOString, so it is the UTC day.
     *
     * `MDY_TODAY` overrides it, which is how a build is made repeatable: a
     * site that hides future posts renders differently tomorrow, and a test
     * that could not pin this would rot on its own.
     */
    JsValue context = js_object_new(e->ctx);
    js_gc_protect(e->vm, &context);
    const char *forced = getenv("MDY_TODAY");
    char today[40];
    if (forced && *forced) {
        snprintf(today, sizeof today, "%s", forced);
    } else {
        iso8601_utc((double)time(NULL) * 1000.0, today, sizeof today);
        today[10] = '\0';                    /* the date, without the time */
    }
    set_val(e, context, "today", str(e->vm, today, strlen(today)));
    for (size_t i = 0; i < e->knobs.ctx_count; i++) {
        JsValue v = context_value(e, e->knobs.ctx_json[i], e->knobs.ctx_strict[i]);
        if (!js_is_undefined(v)) set_val(e, context, e->knobs.ctx_names[i], v);
    }

    char *wrote = NULL;
    mdy_doc *doc = render_tree_out(e, index, context, want_text ? &wrote : NULL, error, error_len);
    js_gc_unprotect(e->vm, &context);
    if (!doc) { wrap_failure(index, error, error_len); release_held(e); free(wrote); return NULL; }
    if (want_text) {
        /* The text its code wrote. A document that composed a tree through a
         * transform wrote no lines the host still has; its HTML stands in. */
        if (wrote) { mdy_free(doc); release_held(e); return wrote; }
        char *html = mdy_to_html(mdy_root(doc), NULL);
        mdy_free(doc);
        release_held(e);
        return html;
    }
    char *html = mdy_to_html(mdy_root(doc), NULL);
    mdy_free(doc);
    /* Nothing a render parked outlives the render that asked for it. */
    release_held(e);
    return html;
}
