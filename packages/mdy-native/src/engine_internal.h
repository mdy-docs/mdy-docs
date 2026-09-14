/*
 * The engine's private header: what every one of its translation units needs,
 * and nothing outside it may have. The public contract is engine.h.
 *
 * This exists because engine.c was five thousand lines doing six jobs and
 * `struct mdy_engine` has fifty fields spanning all of them — so the moment
 * one of those jobs moves to a file of its own, the struct and the types
 * around it have to be somewhere both can see. The split follows the section
 * markers the file already had.
 */
#ifndef MDY_ENGINE_INTERNAL_H
#define MDY_ENGINE_INTERNAL_H
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <time.h>
#include <string.h>

#include "lamassu.h"
#include "lamassu_compile.h"

#include "engine.h"
#include "mdyast.h"
#include "mdydata.h"
#include "mdydoc.h"
#include "mdyhtml.h"
#include "binjson.h"
#include "bplustree.h"
#include "db.h"
#include "fsx.h"
#include "ingest.h"

#include "mdybuild.h"
#include "images.h"
#include "mdymarkdown.h"
#include "mdyscript.h"
#include "mdytext.h"
#include "toolkit.h"
#include "highlight_bundle.h"

#define MDY_HIGHLIGHT_SPEC "mdy-docs/highlight"

/* A tree a `$.render` parked, and the id of the token standing for it. */
/*
 * A parked tree, or a promise of one. `tree == NULL` with `is_toc` set is a
 * contents list: the token exists before the list can, because a document's
 * headings are not known until its whole tree is — including the ones a loop
 * below the contents list writes.
 */
typedef struct { char id[24]; mdy_doc *doc; mdy_node *tree; int is_toc; } Held;

/* One document's index, under the `_id` it was inserted with — see
 * `oid_slots` on the engine. An empty `hex` is an empty slot. */
typedef struct { char hex[25]; int index; } OidSlot;

typedef struct Resized Resized;

/* One document of an open set. Its TEXT is here; its DATA is in nisaba. */
typedef struct {
    mdy_chunk chunk;      /* the document's own text */
    mdy_chunk matter;     /* its front matter, unparsed */
    size_t matter_lines;  /* how many lines of the chunk come before the body */
    mdy_data *fences;     /* its ```data fences, and the body without them */
    uint8_t oid[12];
    /*
     * A `.md` document is the OTHER front end: markup with no code in it, so
     * there is nothing to run. It goes straight to hast at its own boundary
     * and joins everything else as a tree, and `$.text` on it gives back the
     * file — there was no code to write anything else.
     */
    int is_markdown;
    uint64_t fingerprint;   /* for the render memo; 0 until first asked */
} Document;

/* A resolved `% import name from "spec"`. `set` is owned by the cache, not
 * by the importer — a package imported twice is one build. */
typedef struct {
    char *source_path;   /* the file that declared it */
    char *spec;          /* the literal string it wrote */
    struct mdy_engine *set;
} Import;

/* Every package built so far, by absolute directory, shared across the graph.
 * `roots` is post-order — an import lands before whoever imported it — which
 * is the order `static/` must be copied in for a site to win over its theme. */
typedef struct {
    char **dirs;
    struct mdy_engine **sets;
    size_t count, cap;
    /* Post-order: a package lands after everything IT imports. `static/` is
     * copied in this order, so a site's own files win over its theme's —
     * the same precedence Hugo and Jekyll give a site over a theme. */
    char **roots;
    size_t root_count, root_cap;
} ImportCache;

struct mdy_engine {
    JsVm *vm;
    JsContext *ctx;
    /*
     * The render in progress. `$.compose` is a host call made from the middle
     * of one, and it needs the document being rendered; with one render at a
     * time this is where it lives.
     */
    mdy_doc *tree_owner;

    /* The open set. */
    Document *docs;
    size_t count;
    int handle;                 /* nisaba's, from nis_open */
    mdy_documents *source_docs;

    /*
     * Trees a `$.render` parked, and the tokens standing for them.
     *
     * The table is shared by the WHOLE import graph — `tokens` points at the
     * graph's root engine, or at this one for a standalone set. A token minted
     * while rendering a site and written into the data an imported layout
     * receives has to resolve THERE, and a per-package table cannot do that:
     * the layout would find no such token and quietly drop the page's entire
     * body. mdy-docs shares one module-level registry for the same reason.
     */
    struct mdy_engine *tokens;
    Held *held;
    size_t held_count, held_cap;
    /* Trees kept alive but never named — see keep_alive. */
    mdy_doc **kept;
    size_t kept_count, kept_cap;
    size_t next_token;
    int depth;                  /* renders inside renders */
    void (*on_emit)(void *ud, const char *path, const char *content);
    void *on_emit_ud;
    void (*on_publish)(void *ud, const char *name, const char *data_json, size_t doc_index);
    void *on_publish_ud;
    void (*on_binary)(void *ud, const char *path, const uint8_t *bytes, size_t len);
    void *on_binary_ud;
    /* Fenced code's colouring: highlight.js, in lamassu — see load_highlighter(). */
    JsValue highlight_fn;
    int highlight_state;        /* 0 not yet asked for, 1 ready, -1 unavailable */
    /* Resizes already made, on the graph's token table so a theme and the site
     * that imported it do not each make their own copy. */
    Resized *resized;
    size_t resized_count;
    /* Extra fields for the entry's `req`, set by the embedder. */
    char **ctx_names;
    char **ctx_json;            /* each a JSON text, parsed at render */
    char *ctx_strict;           /* 0: text that is not JSON is a string */
    size_t ctx_count;
    void (*on_source)(void *ud, const char *path);
    void *on_source_ud;
    /* Set by any native that reaches outside the document being rendered —
     * see the render memo. Saved and restored around each render. */
    int taint;
    char last_render_key[24];   /* the memo key of the render just done, base 36 */
    /* mdy-docs/parse's knobs — see engine.h */
    int split, sanitize, tasks;
    char **scope_names;
    char **scope_json;
    size_t scope_count;
    void (*on_message)(void *ud, size_t doc_index, uint32_t line, uint32_t column,
                       const char *rule, const char *reason);
    void *on_message_ud;
    int want_response;
    char *last_response;
    JsValue render_res;         /* the `res` of the render in progress, for its references */
    /* `_id` to index, in insertion order, so a hit maps back to its document. */
    uint8_t (*ids)[12];
    /*
     * The same thing the other way round, so putting an answer back into
     * document order is a lookup rather than a scan. Open addressing on the
     * 24 hex characters; built the first time a query asks for it and thrown
     * away with the set, since it is exactly as valid as `ids` is.
     */
    OidSlot *oid_slots;
    size_t oid_cap;

    /*
     * The import graph. `root` is this package's own directory; `imports` is
     * every `% import name from "spec"` any of its files declared, resolved.
     *
     * `cache` is shared by the WHOLE graph and owned by whoever built it —
     * the same package imported twice is built once. `current` is the
     * document being rendered, which is what tells an `$.__import*` native
     * which file's import it is being asked about: the same spec written in
     * two files can resolve to two different packages.
     */
    /*
     * A document's file identity — path, name, ext, size, mtime — as a YAML
     * mapping, one per document, or NULL for a set that did not come from a
     * directory.
     *
     * It is a MAPPING MERGED LAST rather than front matter written into the
     * source, and the difference is not cosmetic: a file with its own `+++`
     * block would otherwise have two of them, and the second would be read as
     * body text. Merging last is also what makes identity win over a field of
     * the same name, which is the rule mdy-docs states — a document's `name`
     * is its file's, never its front matter's.
     */
    /*
     * Identity is merged in a DIFFERENT PLACE depending on the kind of file,
     * because the rule differs:
     *
     *   .mdy/.md    identity WINS. A document's `name` is its file's, never a
     *               front-matter field of the same name.
     *   .yaml       identity is a DEFAULT. A data record commonly declares its
     *               own `name` or `size` — Ada Lovelace's name, a product's
     *               size — and identity shadowing those would make the file's
     *               own data unreachable under the field it actually used.
     *               Only `path` is structurally required to be real, because
     *               everything resolves documents by it.
     *
     * So `ident_pre` goes in before the document's own fields and `ident_post`
     * after: one is set for a data file, the other for everything else.
     *
     * `ident_data` is a data file's OWN mapping, parsed from the file's bytes
     * and carried here rather than written into the concatenated source as
     * front matter. That source is split on `---` lines, so a `.yaml` file
     * opening with the document marker YAML itself allows was read as a
     * document SEPARATOR: the file became two documents where the walk had
     * counted one, and every identity after it belonged to the wrong
     * document. The bytes never become document structure now — a `---` or a
     * `+++` among them is just YAML. It merges after the document's own
     * fields and before `ident_post`, which is where mdy-docs puts a source's
     * `meta` (parseDocuments, src/mdy.js).
     */
    mdy_yaml **ident_pre;
    mdy_yaml **ident_data;
    mdy_yaml **ident_post;
    char *ident_is_md;
    size_t identity_count;

    char *root;
    /* Scratch for the module canonicalizer: the engine copies the result
     * before the call returns, so it need only outlive the call. */
    uint16_t *module_spec;
    Import *imports;
    size_t import_count, import_cap;
    ImportCache *cache;
    int owns_cache;
    size_t current;
};

/* ---- engine_value.c: the VM boundary ----------------------------------------
 *
 * What every other part of the engine needs to make a value lamassu can hold,
 * or to read one back. The conversions themselves — trees, binjson, UTF-16 —
 * stay private to that file; these twelve are the ones the rest of the engine
 * actually says out loud.
 */
/* UTF-8 here, UTF-16 there. Both allocate; caller frees. The decoding is the
 * parser's (mdytext.h), so the same bytes mean the same thing whichever way
 * they entered the process. */
uint16_t *to_utf16(const char *in, size_t len, size_t *out_len);
char *from_utf16(const uint16_t *u, size_t len);

JsValue str(JsVm *vm, const char *s, size_t len);       /* UTF-8 bytes as a JS string */
JsValue key(JsVm *vm, const char *s);                   /* ...interned, for a property name */
char *js_string_utf8(JsValue v);                        /* back again; caller frees, NULL if not a string */
void set_val(mdy_engine *e, JsValue obj, const char *name, JsValue v);
/* ...and the read. Roots `obj` before interning the name, which is a safe
 * point; use it instead of js_object_get(vm, x, key(vm, "n")) — see B13. */
JsValue get_val(mdy_engine *e, JsValue obj, const char *name);
void push_item(mdy_engine *e, JsValue array, JsValue v);

/* A hast tree as the objects the guest sees, and back. `js_to_tree` answers
 * NULL past MDY_MAX_DEPTH — see mdyast.h. */
JsValue tree_to_js(mdy_engine *e, const mdy_node *n);
mdy_node *js_to_tree(mdy_engine *e, mdy_doc *doc, JsValue v);
void js_children_to_tree(mdy_engine *e, mdy_doc *doc, mdy_node *parent, JsValue kids);

/* A query filter into binjson, and an answer back out. `consumed` may be NULL. */
int js_to_binjson(mdy_engine *e, bj_builder *b, JsValue v);
JsValue binjson_to_js(mdy_engine *e, const uint8_t *bytes, size_t len, size_t *consumed);

/* ---- engine_compose.c: the trees a render parks ------------------------------
 *
 * A token is what `$.render` hands a document's code; the tree it stands for
 * waits in the held table until the text around it has been parsed. The
 * natives mint the tokens, this keeps them.
 */
mdy_engine *token_table(mdy_engine *e);  /* the graph's table, which a package shares */
char *hold_tree(mdy_engine *e, mdy_doc *doc, mdy_node *tree);
char *hold_tree_as(mdy_engine *e, mdy_doc *doc, mdy_node *tree, const char *id);
void keep_alive(mdy_engine *e, mdy_doc *doc);   /* outlive the render, but unnamed */
void release_held(mdy_engine *e);
void splice_tree(mdy_engine *e, mdy_doc *doc, mdy_node *parent);
char *fill_tokens(mdy_engine *e, const char *s, size_t len);

/* Reading a token back out of text: its id at `s` and how many bytes it
 * spanned, whether a string is nothing BUT tokens, and the tree one names. */
size_t token_at(const char *s, size_t len, char *id, size_t id_cap);
int only_tokens(const char *s, size_t len);
Held *held_find(mdy_engine *e, const char *id);
/* The text of a node whose only child is text, with its length, or NULL. */
const char *sole_text(const mdy_node *n, size_t *len);

/* ---- engine_walk.c: a directory as a document set ---------------------------
 *
 * The walk itself is behind mdy_engine_open_dir (engine.h). What crosses are
 * the small things the rest of the engine borrows from it — paths, a
 * timestamp, an extension test — and the tags writer, which the store calls
 * for every document whether it came from a directory or a string.
 */
void iso8601_utc(double epoch_ms, char *out, size_t out_len);
int ends_with_ci(const char *s, const char *suffix);
void dirname_of(const char *p, char *out, size_t out_len);
void resolve_path(const char *base, const char *spec, char *out, size_t out_len);
/*
 * `tags`: what the parts DECLARE plus the `#hashtags` the prose mentions,
 * lowercased and deduplicated, as a mapping of its own for the merge.
 *
 * NULL when no part declared the key and the prose mentions nothing — which
 * is a document with no `tags` at all, not one with an empty list. `*oom` is
 * the other NULL, and the caller has to tell them apart: a document that
 * loses its tags loses the indexes it appears in.
 */
mdy_yaml *document_tags(const mdy_yaml_node *const *parts, size_t part_count,
                        const char *body, size_t body_len, int *oom);

/* ---- engine.c: what the walk borrows back ------------------------------------
 *
 * The store and the query engine. `mdy_engine_entry` lives with the walk
 * because it is a question about a directory, and it is answered by a query —
 * which is the one place these two lean on each other.
 */
int open_documents(mdy_engine *e, mdy_documents *docs, char *error, size_t error_len);
/* `failed` (optional) says the query could not RUN, as distinct from
 * matching nothing -- see run_query_in. Pass NULL only where the caller's
 * own "not found" answer already stops the build. */
JsValue run_query(mdy_engine *e, JsValue query, int one, int *failed);
int index_of_id(mdy_engine *e, const char *hex, size_t len);

#endif
