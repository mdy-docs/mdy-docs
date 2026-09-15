/*
 * The render memo: src/mdy.js's, to the letter. A render is a pure function of three things —
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
#include "engine_internal.h"
#include "xalloc.h"

#define MEMO_MAX 4096
#define MEMO_SLOTS 8192
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
mdy_doc *memo_copy(const mdy_doc *stored) {
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
     * page that is otherwise correct. mdy-docs embeds the count in the
     * program text and its fingerprint carries the set's size, so the two
     * agree here.
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
void key_base36(uint64_t key, char out[TOKEN_ID_CAP]) {
    char tmp[24]; int n = 0;
    do { tmp[n++] = "0123456789abcdefghijklmnopqrstuvwxyz"[key % 36]; key /= 36; } while (key && n < 23);
    for (int i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
    out[n] = '\0';
}

uint64_t memo_key(mdy_engine *e, size_t index, JsValue request) {
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
 * The memo, before anything else: a hit is a render that does not happen.
 *
 * A hit found in the PREVIOUS table is promoted into the current one, because
 * the next rotation drops whatever is still only in `prev` — a tree that is
 * being asked for is a tree the next build will ask for too.
 *
 * Returns the entry to answer from, or NULL to go and render.
 */
MemoEntry *memo_take(mdy_engine *e, size_t index, uint64_t mkey) {
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

/* A live generation to write into, made on first use. */
void memo_open(mdy_session *s) { if (!s->now) mdy_session_rotate_memo(s); }

void memo_remember(mdy_engine *e, uint64_t mkey, mdy_doc *out, char *text) {
    memo_put(e->session->now, mkey, memo_copy(out), text);
}
