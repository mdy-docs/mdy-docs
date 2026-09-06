/*
 * One document, rendered — with no JavaScript engine but lamassu.
 *
 * This is mdy-docs' three passes (src/mdy.js's file comment) done in C:
 *
 *   1. the source is split into documents on bare `---`, and each into the
 *      YAML at its top and the body below it, with ```data fences pulled out
 *      of that body                                     — mdydoc.h, mdydata.h
 *   2. the body's `%` and `{{ }}` lines compile to one run of JavaScript
 *      statements, which run inside lamassu and return the lines the document
 *      produced                                         — mdyscript.h, lamassu
 *   3. those lines are parsed to hast, and that is the last change of
 *      representation there is                          — mdyast.h
 *
 * and then, because a page has to become a file, the tree is written as HTML
 * (mdyhtml.h).
 *
 * No second JavaScript engine is involved. lamassu runs the DOCUMENT's code,
 * which is what it has always been for; everything around it is C.
 *
 * WHAT THIS DOES NOT DO YET, and each is a step of its own:
 *   - `$` is present but every native refuses, loudly. A document that calls
 *     `$.render` gets an error naming it rather than a wrong page.
 *   - `transform` needs the tree to reach the guest and come back.
 *   - Positions point at the GENERATED lines rather than the source ones:
 *     mdy-docs carries a line map from the script layer into the parser, and
 *     this does not yet. It does not change any HTML, only where a warning
 *     would say it came from.
 */
#ifndef MDY_ENGINE_H
#define MDY_ENGINE_H

#include <stddef.h>
#include <stdint.h>

typedef struct mdy_engine mdy_engine;

mdy_engine *mdy_engine_new(void);
void mdy_engine_free(mdy_engine *engine);

/*
 * OPEN a source as a document set, then render from it.
 *
 * Opening is where the set becomes queryable: every document's data — its
 * front matter merged with its ```data fences — is inserted into a nisaba
 * collection, and `$.find` and `$.findOne` run real queries against it. That
 * is mdy-docs' `openDocumentSet`, and it is why rendering takes an index into
 * an open set rather than a source and an offset.
 *
 * Results come back in DOCUMENT order, not the order the database returns
 * them: an `_id` to index map restores it, which is what makes a query's
 * answer the same on every build.
 */
int mdy_engine_open(mdy_engine *engine, const char *source, size_t len,
                    char *error, size_t error_len);

/*
 * Open a DIRECTORY as a document set — mdy-docs' `walkSources`, where every
 * file becomes a document and what its own file format means is applied:
 * `.mdy` is a template, `.md` is text that is never compiled, `.yaml` is a
 * data record, and anything else is its identity alone. `dist/`,
 * `node_modules/` and dotfiles are not sources.
 */
int mdy_engine_open_dir(mdy_engine *engine, const char *root,
                        char *error, size_t error_len);

/*
 * Every directory in the import graph, in post-order — a package comes after
 * everything it imports. `static/` is copied in this order so a site's own
 * files win over the ones its theme ships.
 */
size_t mdy_engine_root_count(mdy_engine *engine);
const char *mdy_engine_root_at(mdy_engine *engine, size_t index);

/* The document whose `path` is `entry`, or -1 — `main.mdy` is where a
 * directory starts unless a caller says otherwise. */
int mdy_engine_entry(mdy_engine *engine, const char *entry);

/*
 * Where a `$.publish` goes. `$.emit` writes an output; publish sends a
 * message to a page of this set BY NAME, and what happens to it is the
 * embedder's — exactly as an emitted output is. Core's whole job is deciding
 * that the name means a page, and refusing when it names none or several.
 *
 * `data_json` is the message's data as JSON, produced by the guest's own
 * JSON.stringify. `doc_index` is the document that published it.
 */
void mdy_engine_on_publish(mdy_engine *engine,
                           void (*fn)(void *ud, const char *name,
                                      const char *data_json, size_t doc_index),
                           void *ud);

/*
 * Where a `$.resize` output goes. A resized image is a BUILD OUTPUT — it is
 * never written back into the site's own static/ — so it reaches the embedder
 * the same way an emitted page does, except that it is bytes rather than text.
 * `path` is dist-relative, with a source's `static/` prefix already stripped.
 */
void mdy_engine_on_binary(mdy_engine *engine,
                          void (*fn)(void *ud, const char *path,
                                     const uint8_t *bytes, size_t len),
                          void *ud);

/*
 * A field on the entry document's `req`, set before rendering it.
 *
 * The engine supplies `today` on its own, because a site compares a post's
 * date against it. A BUILD supplies `drafts` and `future` — whether to include
 * documents marked as one or dated in it — which are the embedder's policy,
 * not the engine's. Call before mdy_engine_render.
 */
void mdy_engine_set_context_bool(mdy_engine *engine, const char *name, int value);
/*
 * A field on the entry document's `req` from JSON text — what `mdy -d k=v`
 * and `--data-file` supply. Parsed by the guest's own JSON.parse at render,
 * so a value means exactly what it would in mdy-docs; with `strict` off, text
 * that is not JSON is the string it is, which is `-d name=ada`.
 */
void mdy_engine_set_context_json(mdy_engine *engine, const char *name,
                                 const char *json, int strict);
/*
 * JSON text as binjson — what `--publish` sends: a message's data arrives
 * from `$.publish` as the guest's own JSON.stringify, and the broker takes
 * one binjson value. Parsed by the guest's JSON.parse and encoded by the
 * same encoder that puts documents into nisaba, so nothing is formatted
 * twice. Caller frees `*out`; -1 when the text is not JSON.
 */
int mdy_engine_encode_json(mdy_engine *engine, const char *json,
                           uint8_t **out, size_t *out_len);
/* Forget every context field set so far — a watch re-reads them per pass. */
void mdy_engine_clear_context(mdy_engine *engine);
/*
 * Called once per file the directory walk takes as a source, with its path
 * relative to the root — mdy-docs' `onSource`, which is where a `[read]` line
 * comes from. Set before mdy_engine_open_dir.
 */
void mdy_engine_on_source(mdy_engine *engine,
                          void (*fn)(void *ud, const char *path), void *ud);

/*
 * Start a new memo generation — mdy-docs' `rotateRenderMemo`, called at the
 * start of each build. A render that reached outside its document (a query,
 * a nested render, an emit, a publish, a native) is never remembered; the
 * rest — layouts, and any document that is only markup — are, keyed by what
 * the document is and what it was asked with, and a rebuild may reuse the
 * build before it. Two generations are kept, nothing older.
 */
void mdy_engine_rotate_memo(void);
/*
 * The document a message NAME addresses — its path without the extension,
 * "/" written as ".", or the `messageName` it declares — as an index; -1
 * when no document has that name, -2 when several do. What `$.publish`
 * checks before it sends, and what a delivery resolves before it renders.
 */
int mdy_engine_page_index(mdy_engine *engine, const char *name);
/* A document's `path`, as its record holds it. Caller frees; NULL when none. */
char *mdy_engine_document_path(mdy_engine *engine, size_t index);
/*
 * Render with `req` given whole, as JSON — a delivered message, bound as
 * the request exactly as mdy-bus binds it. The context fields set with
 * mdy_engine_set_context_* are NOT added; the JSON is the whole request.
 * The HTML comes back (caller frees) but a delivery's point is the emits
 * and publishes the render made. NULL on failure, with `error` set.
 */
char *mdy_engine_render_json(mdy_engine *engine, size_t index, const char *request_json,
                             char *error, size_t error_len);
/* How many documents the open set holds. */
size_t mdy_engine_count(mdy_engine *engine);

/*
 * Where a document's `$.emit(path, content)` goes.
 *
 * mdy has no opinion on what producing an output means — a build writes a
 * file, a server holds it in memory, a test collects it. Tokens in `content`
 * have already become the HTML they stood for, because a file is a string and
 * that is the shape it can hold.
 *
 * Without one, `$.emit` is a harmless no-op, which is also what mdy-docs does.
 */
void mdy_engine_on_emit(mdy_engine *engine,
                        void (*fn)(void *ud, const char *path, const char *content),
                        void *ud);

/*
 * Render the document at `index` to HTML. Caller frees.
 *
 * NULL on failure, with a message written into `error` — a compile error from
 * lamassu, a refused native, or anything the document threw.
 */
char *mdy_engine_render(mdy_engine *engine, size_t index,
                        char *error, size_t error_len);
/*
 * The same render as the text its code wrote, before any parse — mdy-docs'
 * `renderText`, for a document that is deliberately not markup: a feed, a
 * robots.txt, a plain-text report. Caller frees; NULL on failure as above.
 */
char *mdy_engine_render_text(mdy_engine *engine, size_t index,
                             char *error, size_t error_len);

#endif
