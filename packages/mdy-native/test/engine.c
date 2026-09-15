/*
 * One document, rendered — with no JavaScript engine but lamassu.
 *
 * The whole of mdy-docs' three passes, in C: the source split into documents
 * and each into data and body, the `%` and `{{ }}` lines compiled and run in
 * lamassu, the lines they produced parsed to hast, and the tree written as
 * HTML. No JavaScript engine but lamassu is linked into this binary at all.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef _WIN32
#include <sys/stat.h>
#include <unistd.h>
#endif

#include "engine.h"
#include "httpd.h"
#include "http.h"
#include "mdyast.h"
#include "fsx.h"
#include "binjson.h"
#include "bjval.h"
#include "broker.h"

static int failures;

/*
 * ONE session for the whole run: engines come and go, the memo does not.
 * memo_key_checks and reopen_checks are about a tree rendered by one engine
 * and found again by the next, so a session per engine would quietly make
 * them test nothing.
 */
static mdy_session *S;

/* Where an `$.emit` lands, for the check below. */
static char last_emit_path[256];
static char last_emit_content[4096];

/*
 * What the library SAYS, which is not the same as what it writes.
 *
 * Messages go through `on_message`, so an engine whose embedder registers
 * nothing says nothing — which is what a callback means, and is the one way
 * a message can go missing without anything failing. Collected and asserted
 * rather than printed for a reader to look at.
 */
/* The first WARN_STORE messages are kept in full for `warned()` to look at;
 * `warning_count` is the TRUE total, incremented past the store, so a "these
 * are the only two" assertion catches a ninth warning instead of a silent
 * cap swallowing it. Reads of the array below stay inside WARN_STORE. */
#define WARN_STORE 8
static char warnings[WARN_STORE][512];
static size_t warning_count;

static void collect_warning(void *ud, size_t doc_index, uint32_t line, uint32_t column,
                            const char *rule, const char *reason) {
    (void)ud; (void)doc_index; (void)line; (void)column; (void)rule;
    if (warning_count < WARN_STORE) snprintf(warnings[warning_count], 512, "%s", reason ? reason : "");
    warning_count++;
}

/* Whether any of the kept messages said this, in full. */
static int warned(const char *exact) {
    size_t kept = warning_count < WARN_STORE ? warning_count : WARN_STORE;
    for (size_t i = 0; i < kept; i++)
        if (strcmp(warnings[i], exact) == 0) return 1;
    return 0;
}

static void collect_emit(void *ud, const char *path, const char *content) {
    (void)ud;
    snprintf(last_emit_path, sizeof last_emit_path, "%s", path);
    snprintf(last_emit_content, sizeof last_emit_content, "%s", content);
}

static void check(const char *what, const char *source, const char *expected) {
    mdy_engine *e = mdy_engine_new(S);
    char err[256];
    char *html = NULL;
    if (mdy_engine_open(e, source, strlen(source), err, sizeof err) == 0)
        html = mdy_engine_render(e, 0, err, sizeof err);
    int ok = html && strcmp(html, expected) == 0;
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        printf("      expected %s\n      actual   %s\n", expected,
               html ? html : (err[0] ? err : "(null)"));
        failures++;
    }
    free(html);
    mdy_engine_free(e);
}

/* A document that asks for something the engine cannot do yet must FAIL,
 * naming it — not render a page quietly missing it. */
static void refuses(const char *what, const char *source, const char *expected) {
    mdy_engine *e = mdy_engine_new(S);
    char err[256];
    char *html = NULL;
    if (mdy_engine_open(e, source, strlen(source), err, sizeof err) == 0)
        html = mdy_engine_render(e, 0, err, sizeof err);
    int ok = !html && strstr(err, expected) != NULL;
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        printf("      expected an error containing %s\n      actual   %s\n", expected,
               html ? "(it rendered)" : err);
        failures++;
    }
    free(html);
    mdy_engine_free(e);
}


/* ---- a directory as a site --------------------------------------------------
 *
 * The natives first, because they are pure, and then the whole thing: a real
 * directory on disk, walked, rendered, and its emits collected — which is what
 * `mdy build` is once a caller decides where the files go.
 */

/* Emits from a whole-site render, in arrival order. */
static char emit_paths[64][256];
static char emit_bodies[64][8192];
static int emit_count;

static void collect_all(void *ud, const char *path, const char *content) {
    (void)ud;
    if (emit_count >= 64) return;
    snprintf(emit_paths[emit_count], 256, "%s", path);
    snprintf(emit_bodies[emit_count], 8192, "%s", content);
    emit_count++;
}

static const char *emitted(const char *path) {
    for (int i = 0; i < emit_count; i++)
        if (strcmp(emit_paths[i], path) == 0) return emit_bodies[i];
    return NULL;
}

static void write_file(const char *root, const char *rel, const char *text) {
    char path[1024];
    snprintf(path, sizeof path, "%s/%s", root, rel);
    char *slash = strrchr(path, '/');
    if (slash) { *slash = '\0'; fsx_mkdirp(path); *slash = '/'; }
    FILE *f = fopen(path, "wb");
    if (!f) { printf("      cannot write %s\n", path); failures++; return; }
    fwrite(text, 1, strlen(text), f);
    fclose(f);
}

static void write_bytes(const char *root, const char *rel, const uint8_t *bytes, size_t n) {
    char path[1024];
    snprintf(path, sizeof path, "%s/%s", root, rel);
    char *slash = strrchr(path, '/');
    if (slash) { *slash = '\0'; fsx_mkdirp(path); *slash = '/'; }
    FILE *f = fopen(path, "wb");
    if (!f) { printf("      cannot write %s\n", path); failures++; return; }
    if (n) fwrite(bytes, 1, n, f);
    fclose(f);
}

static void ok_(const char *what, int cond, const char *detail) {
    printf("  %s  %s\n", cond ? "ok  " : "FAIL", what);
    if (!cond) { printf("      actual %s\n", detail ? detail : "(null)"); failures++; }
}

static void site_checks(void) {
    printf("\n--- engine: a directory as a site ---\n");

    /* fsx_mkdtemp takes a PATH template, so the system temp directory has to
     * be part of it — a bare prefix makes the directory in the working one,
     * and a crashing test then leaves it in the source tree. */
    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-site", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    /*
     * A site with one of each kind of file, so the dispatch is exercised by
     * what the entry can actually SEE rather than by asserting on the walk.
     */
    write_file(root, "main.mdy",
        "% for (const c of $.find({ role: 'city' })) {\n"
        "%   $.emit(c.slug + '/index.html', $.render({ path: 'layout.mdy' }, { who: c.who }))\n"
        "% }\n"
        "% const notes = $.findOne({ ext: '.md' })\n"
        "% $.emit('notes.txt', notes.body)\n"
        "% const conf = $.findOne({ path: 'site.yaml' })\n"
        "% $.emit('title.txt', conf.title)\n"
        /*
         * A data file's OWN fields win over the identity the walk derived —
         * identity is a default there, not an override. A record commonly
         * declares a `name` or a `size` of its own, and shadowing those would
         * make the file's data unreachable under the field it actually used.
         * `path` is the exception: everything resolves documents by it, so it
         * is always the real one.
         */
        "% $.emit('own.txt', [conf.name, conf.size, conf.ext, conf.path].join('|'))\n"
        "% $.emit('tags.txt', (notes.tags || []).join(','))\n"
        "% $.emit('words.txt', $.tokenize('The Walls of Uruk and the walls').join(','))\n"
        "% $.emit('date.txt', $.rfc822('2026-09-05'))\n");
    write_file(root, "layout.mdy", "= {{ req.who }}\n");
    write_file(root, "cities/uruk.yaml", "role: city\nwho: Uruk\nslug: uruk\n");
    write_file(root, "cities/babylon.yaml", "role: city\nwho: Babylon\nslug: babylon\n");
    write_file(root, "site.yaml", "title: A Directory\nname: Not The File Name\nsize: enormous\n");
    write_file(root, "notes.md",
        "A {{ literal }} in prose. #uruk and #Uruk again.\n"
        "\n"
        "---\n"
        "\n"
        "That rule above is prose, not a document separator.\n"
        "\n"
        "```\n"
        "# not a tag: a shell comment in a fence\n"
        "```\n");
    write_file(root, "dist/stale.mdy", "= Should not be here\n");
    write_file(root, ".hidden/secret.mdy", "= Nor this\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    ok_("a directory opens as a document set", mdy_engine_count(e) == 6, NULL);

    int entry = mdy_engine_entry(e, "main.mdy");
    ok_("the entry is found by path", entry >= 0, NULL);

    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    /* A .yaml file's fields are its record: found by query, read by name. */
    const char *uruk = emitted("uruk/index.html");
    ok_("a .yaml file is a queryable document",
        uruk && strcmp(uruk, "<h1 id=\"uruk\">Uruk</h1>") == 0, uruk);
    ok_("...and so is every other one",
        emitted("babylon/index.html") != NULL, NULL);
    ok_("a data file's own fields beat the identity the walk derived",
        emitted("own.txt") &&
            strcmp(emitted("own.txt"),
                   "Not The File Name|enormous|.yaml|site.yaml") == 0,
        emitted("own.txt"));
    ok_("a data file's own field is readable",
        emitted("title.txt") && strcmp(emitted("title.txt"), "A Directory") == 0,
        emitted("title.txt"));

    /* A .md file's text is in `body`, and was NEVER compiled — the `---` and
     * the `{{ }}` in it are prose, and reach the entry as prose. */
    const char *notes = emitted("notes.txt");
    ok_("a .md file's text lands in body, uncompiled",
        notes && strncmp(notes, "A {{ literal }} in prose.", 24) == 0, notes);
    ok_("...a `---` line in it is prose, not a document separator",
        mdy_engine_count(e) == 6 && strstr(notes ? notes : "", "\n---\n") != NULL, notes);
    ok_("...byte for byte, fence and all",
        notes && strstr(notes, "```\n# not a tag: a shell comment in a fence\n```\n") != NULL,
        notes);
    ok_("a .md file's hashtags are extracted, lowercased and deduplicated",
        emitted("tags.txt") && strcmp(emitted("tags.txt"), "uruk") == 0,
        emitted("tags.txt"));

    ok_("dist/ and dotfiles are not sources", mdy_engine_count(e) == 6, NULL);

    ok_("$.tokenize drops stopwords, shorts and repeats",
        emitted("words.txt") && strcmp(emitted("words.txt"), "walls,uruk") == 0,
        emitted("words.txt"));
    ok_("$.rfc822 gives an RSS pubDate",
        emitted("date.txt") &&
            strcmp(emitted("date.txt"), "Sat, 05 Sep 2026 00:00:00 GMT") == 0,
        emitted("date.txt"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- a data file's own YAML -------------------------------------------------
 *
 * A .yaml file is a record, and its bytes are read as YAML and NOTHING else.
 * Written into the source the walk builds, as front matter, they would be
 * split on `---` lines — so a data file opening with the document marker YAML
 * itself allows becomes TWO documents where the walk counted one. Every
 * identity after it then belongs to the wrong document: the roll call below
 * comes back shifted, and `$.render({ path: … })` answers with a neighbour.
 *
 * The roll call is the check. Each line is one document's own path beside the
 * field only that file declared, so a document wearing another's identity
 * cannot produce it. Every expected line here is what `node bin/mdy.js` writes
 * for the same directory.
 */
static void data_file_checks(void) {
    printf("\n--- engine: a data file's own YAML ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-data", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "main.mdy",
        "% const roll = $.find({}).map((d) => [d.path, d.title ?? '-',\n"
        "%   (d.tags ?? []).join('/') || '-'].join('|')).join('\\n')\n"
        "% $.emit('roll.txt', roll)\n"
        "% $.emit('by-query.txt', $.findOne({ path: 'zed.yaml' }).title)\n");
    /* The bug, exactly: a document marker opening a data file. */
    write_file(root, "data.yaml", "---\ntitle: Data file\n");
    write_file(root, "zed.yaml", "title: Bee\n");
    /* A data record's `tags` are ITS value — not the lowercased, deduplicated
     * hashtag list a document body earns. mdy-docs merges a source's `meta`
     * after that list is computed, so the file's own array comes through. */
    write_file(root, "tagged.yaml", "tags:\n  - Alpha\n  - alpha\n");
    /* Two the walk cannot read. Both warn and keep their raw identity rather
     * than failing the build — a directory walk cannot assume every stray
     * .yaml under the root was meant to be a record. */
    write_file(root, "plus.yaml", "title: Before\n+++\nafter: yes\n");
    write_file(root, "list.yaml", "- one\n- two\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    warning_count = 0;
    mdy_engine_on_message(e, collect_warning, NULL);
    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory of data files\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    ok_("a data file opening with `---` is ONE document", mdy_engine_count(e) == 6, NULL);
    /* Both warnings, in full. `plus.yaml`'s message carries the READER's words
     * for what it found, so only its tail is fixed; `list.yaml`'s is fixed
     * throughout and is the one that is byte-for-byte what node prints. */
    ok_("a .yaml that is not a mapping says so, in the words node uses",
        warned("list.yaml must be a YAML mapping — list.yaml keeps its raw identity,"
               " no parsed fields"),
        warning_count ? warnings[0] : "(nothing was said)");
    {
        int found = 0;
        size_t kept = warning_count < WARN_STORE ? warning_count : WARN_STORE;
        for (size_t i = 0; i < kept; i++)
            if (strstr(warnings[i], "plus.yaml keeps its raw identity, no parsed fields")) found = 1;
        ok_("...and one the reader could not parse says why, and keeps its identity",
            found, warning_count > 1 ? warnings[1] : "(nothing was said)");
    }
    ok_("...and those are the only two", warning_count == 2, NULL);

    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    /* Walk order is sorted (fsx_list's contract), so this is the whole set. */
    const char *roll = emitted("roll.txt");
    ok_("...and every identity after it still belongs to its own document",
        roll && strcmp(roll,
            "data.yaml|Data file|-\n"
            "list.yaml|-|-\n"
            "main.mdy|-|-\n"
            "plus.yaml|-|-\n"
            "tagged.yaml|-|Alpha/alpha\n"
            "zed.yaml|Bee|-") == 0,
        roll);
    ok_("...so a query by path answers with that file's record",
        emitted("by-query.txt") && strcmp(emitted("by-query.txt"), "Bee") == 0,
        emitted("by-query.txt"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- a file that holds no document ------------------------------------------
 *
 * Every file under the root is its own SOURCE, split on its own, and the sets
 * are laid end to end — which is what mdy-docs' parseDocuments does with an
 * array. An empty .mdy, one that is nothing but blank lines, one that is
 * nothing but a `---`: each is ONE empty document, because that is what the
 * splitter says an empty source is.
 *
 * Joining the files into one text with `---` between them makes a file
 * holding no document a blank chunk between two separators, which disappears
 * — while the walk has counted a document and an identity for it. Every
 * document after it then wears its neighbour's, and asking for main.mdy
 * renders zed.mdy.
 *
 * The roll call is the check, and `$.text` beside it — a file's trailing
 * newline is its own, which a joined text made surprisingly easy to lose.
 */
static void blank_file_checks(void) {
    printf("\n--- engine: a file that holds no document ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-blank", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "a.mdy", "");
    write_file(root, "bare.mdy", "---\n");
    write_file(root, "blank.mdy", "  \n\n");
    /* Two documents from one file, with a blank one between them that is not
     * a third — the count the walk must not guess at. */
    write_file(root, "multi.mdy", "one\n---\n\n---\ntwo\n");
    write_file(root, "zed.mdy", "+++\ntitle: Zed\n+++\nhello\n");
    write_file(root, "main.mdy",
        "% $.emit('roll.txt', $.find({}).map((d, i) => [i, d.path].join('|')).join('\\n'))\n"
        "% $.emit('zed.txt', JSON.stringify($.text({ path: 'zed.mdy' })))\n"
        "% $.emit('multi.txt', $.text(4) + '/' + $.text(5))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory with empty files in it\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    ok_("an empty file is one empty document, not none", mdy_engine_count(e) == 7, NULL);

    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    const char *roll = emitted("roll.txt");
    ok_("...so every later document keeps its own identity",
        roll && strcmp(roll,
            "0|a.mdy\n"
            "1|bare.mdy\n"
            "2|blank.mdy\n"
            "3|main.mdy\n"
            "4|multi.mdy\n"
            "5|multi.mdy\n"
            "6|zed.mdy") == 0,
        roll);
    ok_("...and one file's two documents are two, not three",
        emitted("multi.txt") && strcmp(emitted("multi.txt"), "one/two\n") == 0,
        emitted("multi.txt"));
    ok_("a file's trailing newline is the document's",
        emitted("zed.txt") && strcmp(emitted("zed.txt"), "\"hello\\n\"") == 0,
        emitted("zed.txt"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- a .md document through $.render ----------------------------------------
 *
 * The other front end has no code to run, so it parses and hands the tree
 * back — and it has to do that through `done`, which is where the key a
 * render is HELD under gets written. Returning early parks the tree under
 * whatever the last render left there: nothing at all on the first render, so
 * the token carries no id and the content disappears, or the PREVIOUS
 * render's key, and the page shows that render twice.
 *
 * Both shapes are here, and each uses a .md nothing has rendered yet —
 * a SECOND render of one is answered from the memo, which took the same exit
 * as everything else and was always named correctly. Plus that memo case, so
 * it stays that way. Every expected string is what `node bin/mdy.js` writes
 * for this directory.
 */
static void markdown_render_checks(void) {
    printf("\n--- engine: a .md document through $.render ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-md", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "a.md", "# Alpha\n\nfirst body\n");
    write_file(root, "b.md", "# Beta\n\nsecond body\n");
    write_file(root, "c.md", "# Gamma\n\nthird body\n");
    write_file(root, "lay.mdy", "layout text\n");
    write_file(root, "main.mdy",
        "% $.emit('two.html', $.html($.render({ path: 'a.md' })) + '|' + $.html($.render({ path: 'b.md' })))\n"
        "% $.emit('after.html', $.html($.render({ path: 'lay.mdy' })) + '|' + $.html($.render({ path: 'c.md' })))\n"
        "% $.emit('twice.html', $.html($.render({ path: 'a.md' })) + '|' + $.html($.render({ path: 'a.md' })))\n"
        "% $.emit('text.txt', JSON.stringify($.text({ path: 'a.md' })))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory of markdown\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }

    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    ok_("a .md rendered first is there at all",
        emitted("two.html") &&
            strcmp(emitted("two.html"),
                   "<h1 id=\"alpha\">Alpha</h1>\n<p>first body</p>|"
                   "<h1 id=\"beta\">Beta</h1>\n<p>second body</p>") == 0,
        emitted("two.html"));
    ok_("...and a .md rendered AFTER another document is itself, not that one",
        emitted("after.html") &&
            strcmp(emitted("after.html"),
                   "<p>layout text</p>|<h1 id=\"gamma\">Gamma</h1>\n<p>third body</p>") == 0,
        emitted("after.html"));
    ok_("...and the same one twice is it twice",
        emitted("twice.html") &&
            strcmp(emitted("twice.html"),
                   "<h1 id=\"alpha\">Alpha</h1>\n<p>first body</p>|"
                   "<h1 id=\"alpha\">Alpha</h1>\n<p>first body</p>") == 0,
        emitted("twice.html"));
    ok_("$.text on a .md is the file, since no code wrote anything else",
        emitted("text.txt") &&
            strcmp(emitted("text.txt"), "\"# Alpha\\n\\nfirst body\\n\"") == 0,
        emitted("text.txt"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- GFM footnotes in a .md document ----------------------------------------
 *
 * md4c reported footnotes all along — MD_FLAG_FOOTNOTES is part of
 * MD_DIALECT_GITHUB — and markdown.c handled none of the three callbacks, so
 * all three callbacks have to be handled: without them every reference is
 * dropped and every definition leaks out of the end of the document as a
 * paragraph of its own.
 *
 * Five shapes, each pinning a rule that is separately wrong if it is wrong:
 * the markup itself; the `-2` on a second reference and the <sup> that goes
 * with it; numbering by FIRST REFERENCE rather than by where the definitions
 * were written; a reference inside a TABLE, which md4c counts twice because it
 * parses a table's cells twice; and a definition with nothing in it, which
 * takes no paragraph. Every expected string is what `node bin/mdy.js` writes
 * for the same file.
 */
static void footnote_checks(void) {
    printf("\n--- engine: GFM footnotes in a .md ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-fn", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "one.md",   "a[^1]\n\n[^1]: n\n");
    write_file(root, "twice.md", "a[^1] b[^1]\n\n[^1]: n\n");
    write_file(root, "order.md", "a[^z] b[^y]\n\n[^y]: why\n[^z]: zed\n");
    write_file(root, "table.md", "| h |\n| --- |\n| c[^1] |\n\n[^1]: n\n");
    write_file(root, "empty.md", "a[^1]\n\n[^1]:\n");
    write_file(root, "main.mdy",
        "% $.emit('one.html',   $.html($.render({ path: 'one.md' })))\n"
        "% $.emit('twice.html', $.html($.render({ path: 'twice.md' })))\n"
        "% $.emit('order.html', $.html($.render({ path: 'order.md' })))\n"
        "% $.emit('table.html', $.html($.render({ path: 'table.md' })))\n"
        "% $.emit('empty.html', $.html($.render({ path: 'empty.md' })))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory of markdown\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }

    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    static const char ONE[] =
        "<p>a<sup><a href=\"#user-content-fn-1\" id=\"user-content-fnref-1\""
        " data-footnote-ref=\"\" aria-describedby=\"footnote-label\">1</a></sup></p>\n"
        "<section data-footnotes=\"\" class=\"footnotes\">"
        "<h2 class=\"sr-only\" id=\"footnote-label\">Footnotes</h2>\n"
        "<ol>\n"
        "<li id=\"user-content-fn-1\">\n"
        "<p>n <a href=\"#user-content-fnref-1\" data-footnote-backref=\"\""
        " aria-label=\"Back to reference 1\" class=\"data-footnote-backref\">\xe2\x86\xa9</a></p>\n"
        "</li>\n"
        "</ol>\n"
        "</section>";
    ok_("a reference becomes GitHub's <sup><a>, and the definitions a section after the body",
        emitted("one.html") && strcmp(emitted("one.html"), ONE) == 0, emitted("one.html"));

    /* The SECOND reference is `-2` and carries a <sup> saying so; the first
     * carries none, which is not the same as "there is only one". */
    static const char TWICE[] =
        "<p>a<sup><a href=\"#user-content-fn-1\" id=\"user-content-fnref-1\""
        " data-footnote-ref=\"\" aria-describedby=\"footnote-label\">1</a></sup>"
        " b<sup><a href=\"#user-content-fn-1\" id=\"user-content-fnref-1-2\""
        " data-footnote-ref=\"\" aria-describedby=\"footnote-label\">1</a></sup></p>\n"
        "<section data-footnotes=\"\" class=\"footnotes\">"
        "<h2 class=\"sr-only\" id=\"footnote-label\">Footnotes</h2>\n"
        "<ol>\n"
        "<li id=\"user-content-fn-1\">\n"
        "<p>n <a href=\"#user-content-fnref-1\" data-footnote-backref=\"\""
        " aria-label=\"Back to reference 1\" class=\"data-footnote-backref\">\xe2\x86\xa9</a>"
        " <a href=\"#user-content-fnref-1-2\" data-footnote-backref=\"\""
        " aria-label=\"Back to reference 1-2\" class=\"data-footnote-backref\">"
        "\xe2\x86\xa9<sup>2</sup></a></p>\n"
        "</li>\n"
        "</ol>\n"
        "</section>";
    ok_("...a second reference to one note is -2, with a back-reference each way",
        emitted("twice.html") && strcmp(emitted("twice.html"), TWICE) == 0, emitted("twice.html"));

    /* `z` is referenced first, so it is note 1 and the section lists it
     * first — though `y` is DEFINED first. */
    static const char ORDER[] =
        "<p>a<sup><a href=\"#user-content-fn-z\" id=\"user-content-fnref-z\""
        " data-footnote-ref=\"\" aria-describedby=\"footnote-label\">1</a></sup>"
        " b<sup><a href=\"#user-content-fn-y\" id=\"user-content-fnref-y\""
        " data-footnote-ref=\"\" aria-describedby=\"footnote-label\">2</a></sup></p>\n"
        "<section data-footnotes=\"\" class=\"footnotes\">"
        "<h2 class=\"sr-only\" id=\"footnote-label\">Footnotes</h2>\n"
        "<ol>\n"
        "<li id=\"user-content-fn-z\">\n"
        "<p>zed <a href=\"#user-content-fnref-z\" data-footnote-backref=\"\""
        " aria-label=\"Back to reference 1\" class=\"data-footnote-backref\">\xe2\x86\xa9</a></p>\n"
        "</li>\n"
        "<li id=\"user-content-fn-y\">\n"
        "<p>why <a href=\"#user-content-fnref-y\" data-footnote-backref=\"\""
        " aria-label=\"Back to reference 2\" class=\"data-footnote-backref\">\xe2\x86\xa9</a></p>\n"
        "</li>\n"
        "</ol>\n"
        "</section>";
    ok_("...numbered and listed by FIRST REFERENCE, not by where they were defined",
        emitted("order.html") && strcmp(emitted("order.html"), ORDER) == 0, emitted("order.html"));

    /*
     * One reference in a table cell, and md4c says two: it parses a cell's
     * inline content twice and its own counter advances on both passes. Taking
     * `ref_id` at its word gives `user-content-fnref-1-2` here, pointing at a
     * reference that does not exist, and a second back-reference beside it.
     */
    ok_("...and a reference in a TABLE cell is still the first reference",
        emitted("table.html") &&
            strstr(emitted("table.html"), "id=\"user-content-fnref-1\"") != NULL &&
            strstr(emitted("table.html"), "fnref-1-2") == NULL,
        emitted("table.html"));

    /* Nothing to append to, so no paragraph and no leading space either. */
    static const char EMPTY[] =
        "<p>a<sup><a href=\"#user-content-fn-1\" id=\"user-content-fnref-1\""
        " data-footnote-ref=\"\" aria-describedby=\"footnote-label\">1</a></sup></p>\n"
        "<section data-footnotes=\"\" class=\"footnotes\">"
        "<h2 class=\"sr-only\" id=\"footnote-label\">Footnotes</h2>\n"
        "<ol>\n"
        "<li id=\"user-content-fn-1\">\n"
        "<a href=\"#user-content-fnref-1\" data-footnote-backref=\"\""
        " aria-label=\"Back to reference 1\" class=\"data-footnote-backref\">\xe2\x86\xa9</a>\n"
        "</li>\n"
        "</ol>\n"
        "</section>";
    ok_("...and a definition with nothing in it takes no paragraph",
        emitted("empty.html") && strcmp(emitted("empty.html"), EMPTY) == 0, emitted("empty.html"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- a bracket that is not a footnote after all ------------------------------
 *
 * md4c expanded the opener to eat the `^` BEFORE checking that the label has
 * a definition. Both checks after it return false, the bracket pair then goes
 * on to be resolved as an ordinary link, and an opener already moved past the
 * `^` takes it out of that link's text. The one local patch in
 * third_party/md4c — see its README.
 *
 * `[^a b]` is not a footnote to either engine: a label with a space in it is
 * not a footnote label, so both read the pair as a link reference and its
 * definition. What differed was the link's TEXT.
 *
 * Both failure paths are here, because the mutation was before both: a label
 * with a space, and an empty one. So is a real footnote, which takes the
 * SUCCEEDING path and must still eat its `^`.
 *
 * And the neighbouring case: a label ending in whitespace finds no
 * definition at all unless md4c's label HASH strips a trailing
 * whitespace run where its label COMPARISON does — the hash is consulted
 * first, so the entry was never reached. Both patches are in
 * third_party/md4c; see its README.
 */
static void caret_bracket_checks(void) {
    printf("\n--- engine: a bracket that is not a footnote after all ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-caret", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "space.md", "a[^a b]\n\n[^a b]: n\n");
    write_file(root, "empty.md", "a[^]\n\n[^]: n\n");
    write_file(root, "note.md",  "a[^1]\n\n[^1]: n\n");
    write_file(root, "trail.md", "a[x ]\n\n[x ]: n\n");
    write_file(root, "cross.md", "a[x ]\n\n[x]: n\n");
    write_file(root, "inner.md", "a[p  q]\n\n[p q]: n\n");
    write_file(root, "main.mdy",
        "% $.emit('space.html', $.html($.render({ path: 'space.md' })))\n"
        "% $.emit('empty.html', $.html($.render({ path: 'empty.md' })))\n"
        "% $.emit('note.html',  $.html($.render({ path: 'note.md' })))\n"
        "% $.emit('trail.html', $.html($.render({ path: 'trail.md' })))\n"
        "% $.emit('cross.html', $.html($.render({ path: 'cross.md' })))\n"
        "% $.emit('inner.html', $.html($.render({ path: 'inner.md' })))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory of markdown\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }

    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    ok_("a label with a space is a link, and keeps the `^` in its text",
        emitted("space.html") &&
            strcmp(emitted("space.html"), "<p>a<a href=\"n\">^a b</a></p>") == 0,
        emitted("space.html"));
    ok_("...and so does an empty one, the other path the mutation was before",
        emitted("empty.html") &&
            strcmp(emitted("empty.html"), "<p>a<a href=\"n\">^</a></p>") == 0,
        emitted("empty.html"));
    /* The succeeding path: a real footnote still eats its `^`, which is what
     * moving the mutation could have broken. */
    ok_("...while a real footnote still eats its `^` and is a reference",
        emitted("note.html") &&
            strstr(emitted("note.html"), "data-footnote-ref") != NULL &&
            strstr(emitted("note.html"), "^") == NULL,
        emitted("note.html"));

    /* The label's TRAILING whitespace. Three shapes, because the hash and
     * the comparison have to agree about all of them — and the third
     * would fail a fix that stripped whitespace everywhere rather than at
     * the end, since an inner run collapses to one space and stays. */
    ok_("a label ending in whitespace finds its definition",
        emitted("trail.html") &&
            strcmp(emitted("trail.html"), "<p>a<a href=\"n\">x </a></p>") == 0,
        emitted("trail.html"));
    ok_("...and finds one written without the whitespace",
        emitted("cross.html") &&
            strcmp(emitted("cross.html"), "<p>a<a href=\"n\">x </a></p>") == 0,
        emitted("cross.html"));
    ok_("...while an INNER run still collapses to one space rather than going",
        emitted("inner.html") &&
            strcmp(emitted("inner.html"), "<p>a<a href=\"n\">p  q</a></p>") == 0,
        emitted("inner.html"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- a GitHub alert ----------------------------------------------------------
 *
 * `> [!NOTE]` and its four siblings. md4c reports the block and eats the
 * marker line; what this file adds is the frame
 * remark-github-blockquote-alert builds around it — a <div> with two classes
 * and `dir="auto"`, and a title paragraph carrying an octicon in front of
 * what the quote said. The five icons are in alert_table.h, which
 * scripts/generate-alerts.mjs reads out of the plugin and check-generated
 * holds to it.
 *
 * The assertion is the whole <div> rather than a piece of it, because every
 * part of it was a separate decision: the class names, the attribute ORDER
 * inside the <svg>, the uppercased title, and `width="16"` staying a string
 * where the same attribute on an <img> is the number 16 — an <svg> is in a
 * namespace of its own and property-information types it by a different
 * schema.
 */
static void alert_checks(void) {
    printf("\n--- engine: a GitHub alert ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-alert", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "a.md", "> [!WARNING]\n> Careful.\n");
    write_file(root, "q.md", "> Just a quote.\n");
    write_file(root, "main.mdy",
        "% $.emit('a.html', $.html($.render({ path: 'a.md' })))\n"
        "% $.emit('q.html', $.html($.render({ path: 'q.md' })))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);
    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory of alerts\n      %s\n", err);
        failures++; mdy_engine_free(e); free(root); return;
    }
    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++; mdy_engine_free(e); free(root); return;
    }
    free(html);

    const char *a = emitted("a.html");
    ok_("an alert is a <div> with the plugin's two classes and dir",
        a && strstr(a, "<div class=\"markdown-alert markdown-alert-warning\" dir=\"auto\">") == a,
        a);
    ok_("...with a title paragraph in front of what the quote said",
        a && strstr(a, "<p class=\"markdown-alert-title\" dir=\"auto\">") != NULL &&
            strstr(a, ">WARNING</p>") != NULL,
        a);
    /* The attribute order is hast's insertion order and the writer's. */
    ok_("...whose octicon carries its attributes in the plugin's order",
        a && strstr(a, "<svg class=\"octicon\" viewBox=\"0 0 16 16\" width=\"16\" "
                       "height=\"16\" aria-hidden=\"true\"><path d=\"M6.457") != NULL,
        a);
    ok_("...and an ordinary quote is still a quote",
        emitted("q.html") &&
            strstr(emitted("q.html"), "<blockquote>") == emitted("q.html"),
        emitted("q.html"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- a heading id that is already taken -------------------------------------
 *
 * `.mdy` headings were made unique against the ids a document had already
 * handed out, and `.md` headings were not: three headings called "foo" were
 * all `id="foo"` where mdy-docs gives foo, foo-1, foo-2. Duplicate ids are
 * invalid HTML and every `#anchor` past the first points at the wrong one.
 *
 * One function does it for both front ends now, so the two cases here are the
 * same assertion twice — which is the point: they were different code, and
 * that is why only one of them was right. The third heading is `Foo`, because
 * the collision is between SLUGS and not between headings.
 */
static void heading_id_checks(void) {
    printf("\n--- engine: a heading id that is already taken ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-hid", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "dup.md",  "# foo\n## foo\n### Foo\n");
    write_file(root, "dup.mdy", "= foo\n== foo\n=== Foo\n");
    write_file(root, "main.mdy",
        "% $.emit('md.html',  $.html($.render({ path: 'dup.md' })))\n"
        "% $.emit('mdy.html', $.html($.render({ path: 'dup.mdy' })))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory of headings\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    ok_("a repeated heading id is numbered in a .md",
        emitted("md.html") &&
            strcmp(emitted("md.html"),
                   "<h1 id=\"foo\">foo</h1>\n<h2 id=\"foo-1\">foo</h2>\n"
                   "<h3 id=\"foo-2\">Foo</h3>") == 0,
        emitted("md.html"));
    ok_("...and in a .mdy, which is where the rule already was",
        emitted("mdy.html") &&
            strcmp(emitted("mdy.html"),
                   "<h1 id=\"foo\">foo</h1><h2 id=\"foo-1\">foo</h2>"
                   "<h3 id=\"foo-2\">Foo</h3>") == 0,
        emitted("mdy.html"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- raw HTML inside a .md paragraph ----------------------------------------
 *
 * `MD_TEXT_HTML` had no case in the text callback and fell through to
 * `default:`, so an inline tag became ordinary text and the writer escaped it.
 * The BLOCK kind was right all along, which is what made it look like a
 * policy. It is one `.md` pipeline with rehype-raw at the end of it, and
 * both kinds have to be handed something to re-parse.
 *
 * The last two are the ones that would go wrong in the other direction. A tag
 * inside a code span, and a tag inside an image's alt, are STRINGS rather
 * than tree content and must stay escaped — and a `.mdy` document escapes an
 * inline tag whatever this does, because mdy's own language has no inline
 * HTML. Every expected string is what `node bin/mdy.js` writes.
 */
static void raw_html_checks(void) {
    printf("\n--- engine: raw HTML inside a .md paragraph ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-raw", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "inline.md", "a <b>x</b> b\n");
    write_file(root, "code.md",   "a `code <b>x</b> here` b\n");
    write_file(root, "alt.md",    "![alt <b>t</b>](/i.png)\n");
    write_file(root, "cell.md",   "| h |\n| --- |\n| <b>x</b> |\n");
    write_file(root, "same.mdy",  "a <b>x</b> b\n");
    write_file(root, "unclosed.md", "a <b>unclosed\n");
    write_file(root, "crossed.md",  "a <b>x</i> b\n");
    write_file(root, "blockinp.md", "<p>a <div>b</div> c</p>\n");
    write_file(root, "foster.md",   "<table><b>stray</b><tr><td>x</td></tr></table>\n");
    write_file(root, "one.md",      "first, with an unclosed <div>\n");
    write_file(root, "two.md",      "second\n");
    write_file(root, "main.mdy",
        "% $.emit('inline.html', $.html($.render({ path: 'inline.md' })))\n"
        "% $.emit('code.html',   $.html($.render({ path: 'code.md' })))\n"
        "% $.emit('alt.html',    $.html($.render({ path: 'alt.md' })))\n"
        "% $.emit('cell.html',   $.html($.render({ path: 'cell.md' })))\n"
        "% $.emit('mdy.html',    $.html($.render({ path: 'same.mdy' })))\n"
        "% $.emit('unclosed.html', $.html($.render({ path: 'unclosed.md' })))\n"
        "% $.emit('crossed.html',  $.html($.render({ path: 'crossed.md' })))\n"
        "% $.emit('blockinp.html', $.html($.render({ path: 'blockinp.md' })))\n"
        "% $.emit('foster.html',   $.html($.render({ path: 'foster.md' })))\n"
        "% $.emit('two.html', $.html($.render({ path: 'one.md' })) + $.html($.render({ path: 'two.md' })))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory of markdown\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }

    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    ok_("an inline tag in a .md paragraph is markup, not escaped text",
        emitted("inline.html") &&
            strcmp(emitted("inline.html"), "<p>a <b>x</b> b</p>") == 0,
        emitted("inline.html"));

    /* The table path is worth its own case: a cell's content is parsed
     * through the same callbacks and then foster-parented (§4). */
    ok_("...and so is one in a table cell",
        emitted("cell.html") &&
            strstr(emitted("cell.html"), "<td><b>x</b></td>") != NULL,
        emitted("cell.html"));

    ok_("...but a tag in a code span stays literal, because that is a string",
        emitted("code.html") &&
            strcmp(emitted("code.html"),
                   "<p>a <code>code &#x3C;b>x&#x3C;/b> here</code> b</p>") == 0,
        emitted("code.html"));

    ok_("...and so does one in an image's alt",
        emitted("alt.html") &&
            strcmp(emitted("alt.html"),
                   "<p><img src=\"/i.png\" alt=\"alt <b>t</b>\"></p>") == 0,
        emitted("alt.html"));

    /* The other front end, unchanged and deliberately so: mdy's own language
     * has no inline HTML — a `<` in a paragraph is a `<`. */
    ok_("...and a .mdy document still escapes it, which is mdy's own rule",
        emitted("mdy.html") &&
            strcmp(emitted("mdy.html"), "<p>a &#x3C;b>x&#x3C;/b> b</p>") == 0,
        emitted("mdy.html"));

    /*
     * And what the HTML5 parse REPAIRS, which is the other half of the same
     * stage. Four rules, each a different part of tree construction and none
     * of them a tag matcher's:
     */
    ok_("an unclosed tag is closed at the end of its document",
        emitted("unclosed.html") &&
            strcmp(emitted("unclosed.html"), "<p>a <b>unclosed</b></p>") == 0,
        emitted("unclosed.html"));
    ok_("...crossed formatting elements are un-crossed",
        emitted("crossed.html") &&
            strcmp(emitted("crossed.html"), "<p>a <b>x b</b></p>") == 0,
        emitted("crossed.html"));
    ok_("...a block inside a <p> splits the paragraph around it",
        emitted("blockinp.html") &&
            strcmp(emitted("blockinp.html"), "<p>a </p><div>b</div> c<p></p>") == 0,
        emitted("blockinp.html"));
    ok_("...and a stray element in a table is foster-parented out in front",
        emitted("foster.html") &&
            strcmp(emitted("foster.html"),
                   "<b>stray</b><table><tbody><tr><td>x</td></tr></tbody></table>") == 0,
        emitted("foster.html"));

    /*
     * The one with a consequence past a wrong tree: two documents composed
     * onto one page, the first leaving a `<div>` open. It is closed at that
     * document's own boundary, so the second is beside it and not inside it.
     */
    ok_("...so an unclosed tag cannot reach the document after it",
        emitted("two.html") &&
            strcmp(emitted("two.html"),
                   "<p>first, with an unclosed </p><div><p></p></div><p>second</p>") == 0,
        emitted("two.html"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- an answer in document order --------------------------------------------
 *
 * A hit carries the `_id` it was inserted with, and the answer is put back
 * into the order the documents were written in — never the order the database
 * happened to walk its keys in. Resolving a hit's id to its document is a
 * map built once: a scan that re-formats every id on every step, inside a
 * loop over every document, inside a loop over every hit, is cubic — twelve
 * seconds for a $.find({}) over 1,200 documents.
 *
 * That is a change of cost and not of answer, so what this pins is the answer,
 * at a size where the map has real collisions and probe runs in it. Two
 * hundred documents numbered BACKWARDS against their own positions, so an
 * answer in id order, in `n` order, or in any order but the set's says so
 * loudly. Every expected value is what `node bin/mdy.js` writes for the same
 * source.
 */
static void query_order_checks(void) {
    printf("\n--- engine: an answer in document order ---\n");

    enum { N = 200 };
    size_t cap = 64 * 1024;
    char *source = malloc(cap);
    char *want = malloc(4 * 1024);
    if (!source || !want) {
        printf("  FAIL  out of memory\n");
        failures++;
        free(source); free(want);
        return;
    }
    size_t len = (size_t)snprintf(source, cap,
        "%% $.emit('order.txt', $.find({ role: 'item' }).map((d) => d.n).join(','))\n"
        "%% $.emit('first.txt', String($.findOne({ role: 'item' }).n))\n"
        "%% $.emit('text.txt', JSON.stringify($.text($.findOne({ n: 7 }))))\n"
        "%% $.emit('render.txt', $.html($.render($.findOne({ n: 7 }))))\n");
    size_t wlen = 0;
    for (int i = N; i >= 1; i--) {
        len += (size_t)snprintf(source + len, cap - len,
                                "---\n+++\nrole: item\nn: %d\n+++\nbody %d\n", i, i);
        wlen += (size_t)snprintf(want + wlen, 4 * 1024 - wlen, i == N ? "%d" : ",%d", i);
    }

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open(e, source, len, err, sizeof err) != 0) {
        printf("  FAIL  open a set of %d documents\n      %s\n", N, err);
        failures++;
        mdy_engine_free(e);
        free(source); free(want);
        return;
    }
    ok_("a set of two hundred documents opens", mdy_engine_count(e) == N + 1, NULL);

    char *html = mdy_engine_render(e, 0, err, sizeof err);
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(source); free(want);
        return;
    }
    free(html);

    ok_("...and every hit comes back in the order the documents were written",
        emitted("order.txt") && strcmp(emitted("order.txt"), want) == 0,
        emitted("order.txt"));
    ok_("...so findOne is the FIRST of them, not the lowest id",
        emitted("first.txt") && strcmp(emitted("first.txt"), "200") == 0,
        emitted("first.txt"));
    /* Both of these resolve a hit's own `_id` back to its document, which is
     * the same lookup from the other direction. */
    ok_("a hit resolves back to the document it came from",
        emitted("text.txt") && strcmp(emitted("text.txt"), "\"body 7\"") == 0,
        emitted("text.txt"));
    ok_("...and renders as that one",
        emitted("render.txt") && strcmp(emitted("render.txt"), "<p>body 7</p>") == 0,
        emitted("render.txt"));

    mdy_engine_free(e);
    free(source);
    free(want);
}


/* ---- a set closed with the engine -------------------------------------------
 *
 * A set's data lives in a nisaba collection, opened the first time a set is
 * and never closed. Every engine left behind a primary store, an index store,
 * two B+trees and a slot in nisaba's table. A build is one engine and does not
 * care; `mdy dev` and `--watch` are a NEW engine per save, and two hundred
 * rebuilds of examples/blog took the process from 7 MB to 72 MB. A leak
 * checker never saw a byte of it: the memory stayed reachable from nisaba's
 * slot table, which nothing ever marked free.
 *
 * That is not a thing a check can assert. What it can assert is the other half
 * of the same fact — opening a set twice on ONE engine, which could not be
 * done at all: the second open reached a collection that already had its
 * `path` index and nisaba refused it. The first set is closed with its
 * collection now, so the second is the whole set.
 */
static void reopen_checks(void) {
    printf("\n--- engine: a set closed with the engine ---\n");

    const char *first =
        "= {{ $.find({ who: { $exists: true } }).map((d) => d.who).join(',') }}\n"
        "---\n+++\nwho: first\n+++\n";
    const char *second =
        "= {{ $.find({ who: { $exists: true } }).map((d) => d.who).join(',') }}\n"
        "---\n+++\nwho: second\n+++\n";

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    err[0] = '\0';

    char *html = NULL;
    if (mdy_engine_open(e, first, strlen(first), err, sizeof err) == 0)
        html = mdy_engine_render(e, 0, err, sizeof err);
    ok_("a set opens and finds its own document",
        html && strcmp(html, "<h1 id=\"first\">first</h1>") == 0, html ? html : err);
    free(html);

    html = NULL;
    err[0] = '\0';
    int opened = mdy_engine_open(e, second, strlen(second), err, sizeof err) == 0;
    ok_("...and the SAME engine opens a second one", opened, err);
    if (opened) html = mdy_engine_render(e, 0, err, sizeof err);
    ok_("...which is the whole set, the first having gone with its collection",
        html && strcmp(html, "<h1 id=\"second\">second</h1>") == 0, html ? html : err);
    free(html);

    mdy_engine_free(e);
}


/* ---- what a document IS, across builds --------------------------------------
 *
 * The render memo keeps two generations so a rebuild may reuse the build
 * before it, which is what `mdy dev` and `--watch` are for. The key is the
 * document's fingerprint, and the fingerprint hashed the RECORD as nisaba
 * hands it back — `_id` included, and `_id` is a fresh ObjectId minted every
 * time a set is opened. So it said WHEN the set was opened rather than what
 * the document is: over examples/blog every rebuild reported the same 4 hits
 * and 34 misses, forever, and the second generation matched nothing.
 *
 * The key is not reachable from the API, but its shadow is. A composed
 * document's token carries the key of the render it stands for, and `$.text`
 * hands the token back in the text — so two builds of one source name the same
 * render the same way, or they do not.
 *
 * And two builds under different engine knobs must NOT: the memo is shared by
 * every set in the process, and the same text under a different element
 * allowlist is a different render. That is why the knobs are in the
 * fingerprint beside the record, and it is what mdy-docs folds its native
 * names in for.
 */
static char *composed_text_in(mdy_session *session, int sanitize) {
    const char *source = "before {{ $.render(1) }} after\n---\n= Card\n";
    mdy_engine *e = mdy_engine_new(session);
    char err[256];
    mdy_engine_set_sanitize(e, sanitize);
    char *text = NULL;
    if (mdy_engine_open(e, source, strlen(source), err, sizeof err) == 0)
        text = mdy_engine_render_text(e, 0, err, sizeof err);
    mdy_engine_free(e);
    return text;
}

static char *composed_text(int sanitize) { return composed_text_in(S, sanitize); }

/* ---- sessions ---------------------------------------------------------------
 *
 * What is NOT asserted here, and why: a memo HIT is invisible by design. A
 * memo that changed an answer would be a bug, so "did this come from the
 * memo" cannot be read off the output — `memo_key_checks` above gets at its
 * shadow through a composition token, and that token is the same whether the
 * render was remembered or made again. MDY_MEMO_DEBUG and the allocation
 * sweep are what see hits; 4000 refusals against fixture-awkward is the
 * measurement that the memo is doing anything at all.
 *
 * What IS a contract, and is here: who owns the memo, and how long it lasts.
 * None of it could be written before — with the memo in process globals there
 * was one, it lasted for the process, and no test could hold it or hand it
 * over.
 */
static void session_checks(void) {
    printf("\n--- engine: sessions ---\n");

    ok_("an engine needs a session", mdy_engine_new(NULL) == NULL, NULL);

    mdy_session *a = mdy_session_new();
    ok_("a session is made", a != NULL, NULL);
    if (!a) return;

    mdy_engine *e = mdy_engine_new(a);
    ok_("an engine hands back the session it was made in", mdy_engine_session(e) == a, NULL);
    ok_("...and NULL has none", mdy_engine_session(NULL) == NULL, NULL);
    mdy_engine_free(e);

    /* The property a session exists for, stated as a lifetime: the engine is
     * gone and the session is not, so the next engine in it renders against what the last
     * one left. That is what makes a rebuild cheaper than a build. */
    char *first = composed_text_in(a, 0);
    char *second = composed_text_in(a, 0);
    ok_("a session outlives its engines: the next one names the same render",
        first && second && strcmp(first, second) == 0, second);

    /* Two sessions are two lifetimes. Freeing one — which frees both its memo
     * generations and every tree in them — leaves the other untouched, and
     * the same source still renders to the same thing in it. */
    mdy_session *b = mdy_session_new();
    char *elsewhere = composed_text_in(b, 0);
    ok_("...and another session renders it the same", 
        first && elsewhere && strcmp(first, elsewhere) == 0, elsewhere);
    mdy_session_free(a);
    char *after = composed_text_in(b, 0);
    ok_("...and freeing the first leaves the second working",
        elsewhere && after && strcmp(elsewhere, after) == 0, after);
    mdy_session_free(b);

    free(first); free(second); free(elsewhere); free(after);

    /* Rotation on nothing, and freeing nothing: both are no-ops rather than
     * a crash, because the CLI rotates before it has built anything. */
    mdy_session_rotate_memo(NULL);
    mdy_session_free(NULL);
    ok_("rotating and freeing nothing are no-ops", 1, NULL);
}

static void memo_key_checks(void) {
    printf("\n--- engine: what a document is, across builds ---\n");

    /* Three builds, each rotating the memo first, as the CLI does per save. */
    mdy_session_rotate_memo(S);
    char *once = composed_text(0);
    mdy_session_rotate_memo(S);
    char *again = composed_text(0);
    mdy_session_rotate_memo(S);
    char *stricter = composed_text(1);

    ok_("a composed document hands its token back in the text",
        once && strstr(once, "\xee\x80\x80") != NULL && strstr(once, "\xee\x80\x81") != NULL,
        once);
    ok_("...and the next build of the same source names that render the same",
        once && again && strcmp(once, again) == 0, again);
    ok_("...while a set read under different rules is a different render",
        once && stricter && strcmp(once, stricter) != 0, stricter);

    free(once);
    free(again);
    free(stricter);
}


/* ---- $.count ----------------------------------------------------------------
 *
 * mdy-docs writes `$.count` into every document's program as a literal,
 * beside `$.data` and the rest. Not setting it makes `{{ $.count }}`
 * `undefined` where node says `2` — a missing property, which reports nothing
 * and renders the word into the page.
 *
 * The second half is the memo, and it is why this is not a one-line fix. The
 * size of the set is not part of any document's text or record, so adding a
 * file leaves every other document's fingerprint alone; a second build in the
 * same process would then serve each of them the render made when the set was
 * smaller, with `$.count` frozen at the old number. Both fingerprints carry
 * the size, and the two builds below disagree on purpose. test/mdy.test.js
 * has this test's twin.
 */
static char *count_of(const char *source, int *docs) {
    mdy_engine *e = mdy_engine_new(S);
    char err[256];
    char *text = NULL;
    if (mdy_engine_open(e, source, strlen(source), err, sizeof err) == 0) {
        if (docs) *docs = (int)mdy_engine_count(e);
        text = mdy_engine_render_text(e, 0, err, sizeof err);
    }
    mdy_engine_free(e);
    return text;
}

static void count_checks(void) {
    printf("\n--- engine: $.count ---\n");

    int n = 0;
    char *two = count_of("= {{ $.count }}\n---\n+++\na: 1\n+++\n", &n);
    ok_("$.count is the size of the set, not undefined",
        two && strstr(two, "2") != NULL && strstr(two, "undefined") == NULL, two);
    ok_("...and it is the number the engine itself reports", n == 2, two);
    free(two);

    char *one = count_of("= {{ $.count }}\n", NULL);
    ok_("a set of one counts one", one && strstr(one, "1") != NULL, one);
    free(one);

    /*
     * The control first: the memo must still HIT for a set that did not
     * change, or everything below would pass for an engine that had merely
     * stopped reusing renders. The token a composed document hands back is the
     * key of the render it stands for, base 36, so equal tokens are one key.
     */
    const char *nested = "{{ $.render(1) }}\n---\n= {{ $.count }}\n";
    mdy_session_rotate_memo(S);
    char *before = count_of(nested, NULL);
    mdy_session_rotate_memo(S);
    char *unchanged = count_of(nested, NULL);
    ok_("a nested render's token is the key of the render it stands for",
        before && before[0] && strstr(before, "undefined") == NULL, before);
    ok_("...and the same set built again names the same render",
        before && unchanged && strcmp(before, unchanged) == 0, unchanged);
    free(before);
    free(unchanged);

    /*
     * And the bug itself. Document 0 is byte-identical in both sets and sits
     * at the same index; only the SET is bigger. Without the size in the
     * fingerprint the second build hits the first build's entry and answers
     * 2. Measured on both sides rather than inferred.
     */
    char *html_small = NULL, *html_big = NULL;
    const char *set2 = "= {{ $.count }}\n---\n= b\n";
    const char *set3 = "= {{ $.count }}\n---\n= b\n---\n= c\n";
    mdy_session_rotate_memo(S);
    {
        mdy_engine *e = mdy_engine_new(S);
        char err[256];
        if (mdy_engine_open(e, set2, strlen(set2), err, sizeof err) == 0)
            html_small = mdy_engine_render(e, 0, err, sizeof err);
        mdy_engine_free(e);
    }
    mdy_session_rotate_memo(S);
    {
        mdy_engine *e = mdy_engine_new(S);
        char err[256];
        if (mdy_engine_open(e, set3, strlen(set3), err, sizeof err) == 0)
            html_big = mdy_engine_render(e, 0, err, sizeof err);
        mdy_engine_free(e);
    }
    ok_("the same document in a two-document set says 2",
        html_small && strstr(html_small, ">2<") != NULL, html_small);
    ok_("...and in a three-document set says 3, not the 2 it said last build",
        html_big && strstr(html_big, ">3<") != NULL, html_big);
    free(html_small);
    free(html_big);
}

/* ---- the delivery token ------------------------------------------------------
 *
 * `mdy dev` puts a bearer token on the endpoint a broker delivers to. It used
 * to be four rand() calls seeded with `time(NULL) ^ &argc`: thirty-two hex
 * characters standing for at most the ~31 bits of an LCG's state, off a seed
 * that is not a secret. Anyone who could reach the port could work it out.
 *
 * There is no way to test that bytes are random. What can be tested is what
 * the failure looked like: a fixed length of hex, and DIFFERENT every time,
 * which four rand() calls from a one-second-resolution seed are not — two
 * servers started in the same second shared a token.
 */
static void token_checks(void) {
    printf("\n--- engine: the delivery token ---\n");

    char a[40], b[40];
    int rc_a = httpd_secret(a, sizeof a);
    int rc_b = httpd_secret(b, sizeof b);
    ok_("the OS supplies randomness", rc_a == 0 && rc_b == 0, rc_a ? "no source" : "ok");

    size_t n = strlen(a);
    ok_("...as hex filling the buffer it was given", n == 38, a);

    int hexonly = 1;
    for (size_t i = 0; i < n; i++)
        if (!((a[i] >= '0' && a[i] <= '9') || (a[i] >= 'a' && a[i] <= 'f'))) hexonly = 0;
    ok_("...lowercase hex and nothing else", hexonly && n > 0, a);

    ok_("...and two of them differ", strcmp(a, b) != 0, a);

    /* Not all one byte repeated — what a zeroed buffer or a failed read
     * would look like if the return code were ignored. */
    int varied = 0;
    for (size_t i = 1; i < n; i++) if (a[i] != a[0]) varied = 1;
    ok_("...and one is not a single byte repeated", varied, a);

    /* A buffer too small to hold anything is refused, not half-filled. */
    char tiny[2] = { 'x', 'x' };
    ok_("a buffer with no room is refused and emptied",
        httpd_secret(tiny, sizeof tiny) == -1 && tiny[0] == '\0', tiny);

    /* An EVEN cap is not an error — char[40] is what the dev server has, and
     * an API that refuses the buffer its only caller owns is an outage. */
    char even[10];
    ok_("an even-sized buffer is filled, not rejected",
        httpd_secret(even, sizeof even) == 0 && strlen(even) == 8, even);
}


/* ---- numbers that are not numbers -------------------------------------------
 *
 * `.inf`, `-.inf` and `.nan` are legal YAML and node's parser reads them as
 * real Infinity and NaN. What crosses into a document does not: mdy-docs puts
 * the record into the program with JSON.stringify, and JSON cannot write
 * either — `JSON.stringify({a: Infinity})` is `{"a":null}`.
 *
 * This engine handed the document the number itself, so `{{ res.data.big }}`
 * was `Infinity` where node said `null`, `$.find({ big: 1/0 })` matched a
 * record where node matched none, and a guest property of `1/0` came out as
 * `data-x="inf"` where node omits the attribute. Three crossings, one rule:
 * the STORE keeps the infinity, because node's does, and null is what crosses.
 *
 * And `(int64_t)` of either is undefined behaviour — UBSan on the first
 * document below says so in as many words:
 *     ingest.c:22:30: inf is outside the range of representable values
 */
static void nonfinite_checks(void) {
    printf("\n--- engine: numbers that are not numbers ---\n");

    check("an infinity in front matter reaches the document as null",
          "+++\nbig: .inf\n+++\n= {{ res.data.big }}\n",
          "<h1 id=\"null\">null</h1>");
    check("...a negative one too",
          "+++\nbig: -.inf\n+++\n= {{ res.data.big }}\n",
          "<h1 id=\"null\">null</h1>");
    check("...and a NaN",
          "+++\nbig: .nan\n+++\n= {{ res.data.big }}\n",
          "<h1 id=\"null\">null</h1>");

    /* Ordinary numbers are untouched, including the integer/float distinction
     * a query depends on: `{size: 4}` has to match a document that said 4. */
    check("an integer is still an integer, and still matches a query",
          "= {{ $.find({ size: 4 }).length }}\n---\n+++\nsize: 4\n+++\n= x\n",
          "<h1 id=\"1\">1</h1>");
    /* Every expectation in this block was read off `node bin/mdy.js` on the
     * same input, not written from memory — three of them were wrong the
     * first time, in the slug and in the escaping rather than in the number. */
    check("a float is still a float",
          "+++\nratio: 1.5\n+++\n= {{ res.data.ratio }}\n",
          "<h1 id=\"1.5\">1.5</h1>");
    check("...and negatives, zero and exponents are unchanged",
          "+++\na: -42\nb: 0\nc: 1e3\n+++\n= {{ res.data.a }}|{{ res.data.b }}|{{ res.data.c }}\n",
          "<h1 id=\"-4201000\">-42|0|1000</h1>");

    /* The other direction: a guest's own infinity, written into a query. Under
     * mdy-docs it is stringified to null, so it asks for null and matches
     * nothing — not the record that holds an infinity. */
    check("a query FOR an infinity matches nothing, as node's does",
          "= {{ $.find({ big: 1/0 }).length }}\n---\n+++\nbig: .inf\n+++\n= x\n",
          "<h1 id=\"0\">0</h1>");

    /* And a guest's infinity as a tree property: node's null property is one
     * the HTML writer leaves out, so the attribute is absent either way. */
    check("a non-finite tree property is left out, not written as \"inf\"",
          "% const t = { type: 'element', tagName: 'p',\n"
          "%             properties: { id: 'z', 'data-x': 1/0 },\n"
          "%             children: [{ type: 'text', value: 'hi' }] }\n"
          "{{ $.html($.node(t)) }}\n",
          "<p id=\"z\">hi&#x3C;/p></p>");
}


/* ---- an entity inside a link's attribute ------------------------------------
 *
 * md4c hands an attribute as a run of SUBSTRINGS so entities can be resolved
 * in it, and set_attribute took `a->text` whole. So `&amp;` stayed literal and
 * the HTML writer escaped it a second time: `href="http://a?b=1&#x26;amp;c=2"`
 * where node has `&#x26;`. A query string is the common case with more than
 * one substring in it.
 *
 * Every expectation was read off `node bin/mdy.js` on the same input.
 */
static void attr_entity_checks(void) {
    printf("\n--- engine: an entity inside a link's attribute ---\n");

    check("an entity in an href is resolved, not escaped twice",
          "{{ $.markdown('[x](http://a?b=1&amp;c=2)') }}\n",
          "<p><a href=\"http://a?b=1&#x26;c=2\">x</a></p>");
    check("...and in a title",
          "{{ $.markdown('[t](http://a \"q&amp;r\")') }}\n",
          "<p><a href=\"http://a\" title=\"q&#x26;r\">t</a></p>");
    check("a bare ampersand is unchanged",
          "{{ $.markdown('[y](http://a?b=1&c=2)') }}\n",
          "<p><a href=\"http://a?b=1&#x26;c=2\">y</a></p>");
    check("numeric entities too, decimal and hex",
          "{{ $.markdown('[h](http://a?&#x26;&#38;)') }}\n",
          "<p><a href=\"http://a?&#x26;&#x26;\">h</a></p>");
    /* An entity the table does not have goes through as it was typed, which is
     * what CommonMark says about `&nope;` and what text does. */
    /* An <img>'s attributes in mdy-docs' order: src, alt, title. `alt` is not
     * known until the span closes, so its slot is claimed on the way in. */
    check("an image's attributes are src, alt, title",
          "{{ $.markdown('![i](http://a?x \"cap\")') }}\n",
          "<p><img src=\"http://a?x\" alt=\"i\" title=\"cap\"></p>");
    check("...with no title, just src and alt",
          "{{ $.markdown('![j](http://a)') }}\n",
          "<p><img src=\"http://a\" alt=\"j\"></p>");
    check("...and an empty alt still holds its place",
          "{{ $.markdown('![](http://a \"t\")') }}\n",
          "<p><img src=\"http://a\" alt=\"\" title=\"t\"></p>");

    check("an unknown entity is left as it was typed",
          "{{ $.markdown('[n](http://a?&nope;b)') }}\n",
          "<p><a href=\"http://a?&#x26;nope;b\">n</a></p>");

    /*
     * normalizeUri, on a destination and nowhere else.
     *
     * The two that decide whether this is a port of micromark's function or a
     * guess at it: an already-encoded sequence is left alone (or `%C3%A9`
     * becomes `%25C3%25A9`), and `XX` there is two ASCII ALPHANUMERICS rather
     * than two hex digits, so `%zz` is passed through as well.
     */
    check("a non-ASCII character in an href is percent-encoded",
          "{{ $.markdown('[u](http://a?\xc3\xa9)') }}\n",
          "<p><a href=\"http://a?%C3%A9\">u</a></p>");
    check("...and one already encoded is not encoded again",
          "{{ $.markdown('[u](http://a?%C3%A9)') }}\n",
          "<p><a href=\"http://a?%C3%A9\">u</a></p>");
    check("a percent that begins nothing is itself encoded",
          "{{ $.markdown('[u](http://a?a%)') }}\n",
          "<p><a href=\"http://a?a%25\">u</a></p>");
    check("two alphanumerics after a percent count, not two hex digits",
          "{{ $.markdown('[u](http://a?%zz)') }}\n",
          "<p><a href=\"http://a?%zz\">u</a></p>");
    check("a space is encoded",
          "{{ $.markdown('[u](<a b>)') }}\n",
          "<p><a href=\"a%20b\">u</a></p>");
    check("...and the brackets outside micromark's safe set",
          "{{ $.markdown('[u](<a[b]c>)') }}\n",
          "<p><a href=\"a%5Bb%5Dc\">u</a></p>");
    check("an image's src is normalized the same way",
          "{{ $.markdown('![i](/caf\xc3\xa9.png)') }}\n",
          "<p><img src=\"/caf%C3%A9.png\" alt=\"i\"></p>");
    /* A title is NOT a destination, and keeps its bytes — the check above with
     * `q&amp;r` covers the entity half; this one covers the non-ASCII half. */
    check("a title is left alone",
          "{{ $.markdown('[t](http://a \"\xc3\xa9\")') }}\n",
          "<p><a href=\"http://a\" title=\"\xc3\xa9\">t</a></p>");

    /* An empty destination is still a destination. */
    check("an empty href is written, not dropped",
          "{{ $.markdown('[u](<>)') }}\n",
          "<p><a href=\"\">u</a></p>");
    check("...and an empty src",
          "{{ $.markdown('![i](<>)') }}\n",
          "<p><img src=\"\" alt=\"i\"></p>");
}


/* ---- a record's keys, and whose id it is ------------------------------------
 *
 * A document sees its own record as an object, and the order its keys come
 * back in is part of what it sees: one that serialises its record, or walks
 * `Object.keys`, sees different bytes if the two engines disagree.
 *
 *   $.find({})[0]   before  ["_id","name","ext","size","mtime","path"]
 *                   after   ["path","name","ext","size","mtime","_id"]   = node
 *   $.data(0)       before  carried `_id`
 *                   after   does not                                     = node
 *
 * `_id` moved last because nisaba's JS insert adds it after spreading the
 * document; `path` moved first because mdy-docs builds the record as
 * `{ ...meta, ...parsed, path }` and re-assigning a key in JS leaves it where
 * it was first written. Position and value are separate in mdy_bj_document —
 * the first mapping decides a key's place, the last decides its value — so
 * moving `path` does not change which one wins, which the directory check
 * below is for.
 *
 * The order only shows where there IS a file identity, so that half needs a
 * directory; document mode has `_id` and whatever the front matter declared.
 */
static void record_key_checks(void) {
    printf("\n--- engine: a record's keys, and whose id it is ---\n");

    /* Document mode: the store id is the only key a bare document has. */
    check("a bare document's record is its store id",
          "= {{ JSON.stringify(Object.keys($.find({})[0])) }}\n",
          "<h1 id=\"_id\">[\"_id\"]</h1>");
    check("$.data carries no store id",
          "= {{ JSON.stringify(Object.keys($.data(0))) }}\n",
          "<h1>[]</h1>");
    check("...and neither does res.data",
          "= {{ JSON.stringify(Object.keys(res.data)) }}\n",
          "<h1>[]</h1>");
    check("what the front matter declared is there, and the id is not",
          "+++\ntitle: T\n+++\n= {{ JSON.stringify(Object.keys(res.data)) }}\n",
          "<h1 id=\"title\">[\"title\"]</h1>");

    /* A directory, where the identity gives the order its meaning. */
    {
        char *tmp = fsx_tmpdir();
        char prefix[1024];
        snprintf(prefix, sizeof prefix, "%s/mdy-keys", tmp ? tmp : ".");
        free(tmp);
        char *root = fsx_mkdtemp(prefix);
        if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

        write_file(root, "main.mdy",
            "% $.emit('k.txt', JSON.stringify(Object.keys($.find({ path: 'main.mdy' })[0]))\n"
            "%   + ' ' + JSON.stringify(Object.keys(res.data))\n"
            "%   + ' path=' + $.find({ name: 'note.yaml' })[0].path)\n");
        /* A data file naming its own `path`: the walk's must still win. */
        write_file(root, "note.yaml", "path: i-said-this\ntitle: T\n");

        mdy_engine *e = mdy_engine_new(S);
        char err[512];
        emit_count = 0;
        mdy_engine_on_emit(e, collect_all, NULL);
        char *html = NULL;
        if (mdy_engine_open_dir(e, root, err, sizeof err) == 0) {
            int at = mdy_engine_entry(e, "main.mdy");
            if (at >= 0) html = mdy_engine_render(e, (size_t)at, err, sizeof err);
        }
        const char *got = emitted("k.txt");
        ok_("a walked record is path first and _id last",
            got && strstr(got, "[\"path\",\"name\",\"ext\",\"size\",\"mtime\",\"_id\"]") == got,
            got ? got : err);
        ok_("...res.data has the same order without the id",
            got && strstr(got, "[\"path\",\"name\",\"ext\",\"size\",\"mtime\"] path=") != NULL,
            got ? got : err);
        ok_("...and the walk's path still beats a data file's own",
            got && strstr(got, "path=note.yaml") != NULL, got ? got : err);
        free(html);
        mdy_engine_free(e);
        free(root);
    }
}


/* ---- inputs that outgrow a fixed buffer ------------------------------------
 *
 * A buffer that truncates silently is a parity divergence nobody is told
 * about. Measured against `node bin/mdy.js`, which has no such limits, so the
 * shape of every check is "as much as node kept".
 *
 *   heading id        char unique[256]  — cut at 255 bytes
 *   the slug's source char rendered[1024] — the id came from the first KB
 *   table columns     starts/lens/align[64] — the 65th column left
 *   URLs per para     MDY_MAX_URLS 512  — and past it the `//` in `http://`
 *                                         opened the emphasis the list exists
 *                                         to prevent
 *
 * Three that were already fine and are here so they stay that way: a long
 * class, a long href, a long footnote label.
 */
static size_t occurrences(const char *haystack, const char *needle) {
    size_t n = 0;
    for (const char *p = haystack; (p = strstr(p, needle)); p += strlen(needle)) n++;
    return n;
}

static char *render_source(const char *source) {
    mdy_engine *e = mdy_engine_new(S);
    char err[256];
    char *html = NULL;
    if (mdy_engine_open(e, source, strlen(source), err, sizeof err) == 0)
        html = mdy_engine_render(e, 0, err, sizeof err);
    mdy_engine_free(e);
    return html;
}

static void wide_buffer_checks(void) {
    printf("\n--- engine: buffers that used to stop ---\n");

    /* A heading whose slug runs well past the old 255. */
    {
        char src[2048];
        size_t n = 0;
        n += (size_t)snprintf(src + n, sizeof src - n, "= ");
        for (int k = 0; k < 70; k++) n += (size_t)snprintf(src + n, sizeof src - n, "word ");
        snprintf(src + n, sizeof src - n, "\n");
        char *html = render_source(src);
        /* 70 * "word-" less the last hyphen = 349 characters of id. */
        int ok = html && strstr(html, "id=\"") != NULL &&
                 strlen(strstr(html, "id=\"") + 4) > 340;
        ok_("a heading id is as long as the heading needs", ok, html ? html : "(null)");
        free(html);
    }

    /* The slug comes from ALL the text, not the first kilobyte. */
    {
        char src[4096];
        size_t n = (size_t)snprintf(src, sizeof src, "= ");
        for (int k = 0; k < 300; k++) n += (size_t)snprintf(src + n, sizeof src - n, "ab ");
        snprintf(src + n, sizeof src - n, "zz\n");
        char *html = render_source(src);
        int ok = html && strstr(html, "-zz\"") != NULL;
        ok_("...and from the whole heading, not its first kilobyte", ok,
            html ? "(id did not end in the last word)" : "(null)");
        free(html);
    }

    /* Every column of a wide table. */
    {
        char src[4096];
        size_t n = 0;
        for (int row = 0; row < 3; row++) {
            n += (size_t)snprintf(src + n, sizeof src - n, "|");
            for (int c = 0; c < 80; c++)
                n += (size_t)snprintf(src + n, sizeof src - n, row == 1 ? " --- |" : " c%d |", c);
            n += (size_t)snprintf(src + n, sizeof src - n, "\n");
        }
        char *html = render_source(src);
        /* `</th>`, not `<th`, which also matches `<thead`. */
        size_t th = html ? occurrences(html, "</th>") : 0;
        ok_("a table keeps all eighty of its columns", th == 80,
            html ? "(wrong number of <th>)" : "(null)");
        free(html);
    }

    /* Every URL in a long paragraph, and no emphasis grown from `//`. */
    {
        char *src = malloc(600 * 24 + 8);
        size_t n = 0;
        for (int k = 0; k < 600; k++) n += (size_t)sprintf(src + n, "http://e%d.com ", k);
        sprintf(src + n, "\n");
        char *html = render_source(src);
        size_t links = html ? occurrences(html, "<a href=\"http://e") : 0;
        ok_("a paragraph links all six hundred of its URLs", links == 600,
            html ? "(wrong number of links)" : "(null)");
        ok_("...and grows no emphasis from the slashes",
            html && occurrences(html, "<em>") == 0, "(<em> appeared)");
        free(html);
        free(src);
    }

    /* Already fine, and staying that way. */
    {
        char src[1024];
        size_t n = (size_t)snprintf(src, sizeof src, "= Head .");
        for (int k = 0; k < 200; k++) n += (size_t)snprintf(src + n, sizeof src - n, "c");
        snprintf(src + n, sizeof src - n, "\n");
        char *html = render_source(src);
        ok_("a long class name is unchanged", html != NULL, "(null)");
        free(html);
    }
}


/* ---- a file written on Windows ---------------------------------------------
 *
 * mdy-docs' splitter splits on `\n` alone, so every line keeps its `\r`; the
 * script compiler then puts each line inside a backtick template literal,
 * where ECMAScript normalises a `<CR>` to `<LF>`. So one file line becomes two
 * program lines, and a CRLF document renders with a blank line between every
 * pair. Nothing in mdy.js mentions `\r`; it is a property of the language the
 * generated program is written in.
 *
 * Dropping the `\r` gives one line, which reads better and is not what node
 * does. Matching node is the decision, and these are the two observables it
 * rests on — the rendered HTML and the text a render
 * wrote, both byte-compared against `node bin/mdy.js` on the same input.
 */
static void crlf_checks(void) {
    printf("\n--- engine: a file written on Windows ---\n");

    check("CRLF prose breaks the paragraph, as node's does",
          "crlf line\r\nsecond\r\n",
          "<p>crlf line</p><p>second</p>");
    check("...and the same file with LF is one paragraph, unchanged",
          "crlf line\nsecond\n",
          "<p>crlf line second</p>");

    /*
     * $.text is the other half. Emitted to a file the bytes are
     * "crlf line\n\nsecond\n\n" on both sides; through markdown the
     * backslashes of JSON.stringify are eaten identically by both, which is
     * what this pins.
     */
    check("a CRLF document's text carries the empty lines",
          "{{ JSON.stringify($.text(1)) }}\n---\ncrlf line\r\nsecond\r\n",
          "<p>\"crlf linennsecondnn\"</p>");

    /* A CR with no LF after it is NOT a line ending, on either side — measured
     * rather than reasoned, because the template-literal argument above would
     * have predicted otherwise. */
    check("a lone carriage return is not a line ending",
          "a\rb\n",
          "<p>a b</p>");

    /*
     * Where this deliberately does NOT follow node, and it is not a small
     * thing. node's separators are anchored regexes that allow only spaces and
     * tabs after the marker —
     *
     *     DOCUMENT_SEPARATOR     = /^---[ \t]*$/
     *     FRONT_MATTER_SEPARATOR = /^\+\+\+[ \t]*$/
     *
     * — so `---\r` and `+++\r` match neither. On a CRLF file node therefore
     * ignores front matter entirely, and FAILS THE BUILD on a second document:
     * `mdy: document 0 failed: mdy: no document at index 1`. Matching that
     * would mean a Windows-authored file losing its front matter and a
     * multi-document one refusing to build, which is a different order of
     * thing from a blank line. These two stay as they are.
     */
    check("CRLF front matter is still read here, where node ignores it",
          "+++\r\ntitle: T\r\n+++\r\n= {{ res.data.title }}\r\n",
          "<h1 id=\"t\">T</h1>");
    check("...and a CRLF separator still splits, where node cannot find doc 1",
          "A {{ $.text(1) }}\r\n---\r\nsecond doc\r\n",
          "<p>A second doc</p>");
}


/* ---- an integer too big to be one -------------------------------------------
 *
 * `big: 9007199254740992` in front matter made the document it was in
 * DISAPPEAR — not the field, the whole document, with `$.find({})` answering 0
 * and `title` going with it, while the insert returns success and reports
 * nothing.
 *
 * The cause was two levels down, in binjson, and it was an encoder and a
 * decoder disagreeing: `bj_put_int` wrote an INT at any magnitude, while both
 * decoders — the C one and the JS reference — refuse an INT outside the JS
 * safe-integer range and abort the DECODE. So one such integer cost the whole
 * document, because the failure lands on the decode and not on the value.
 * binjson's encoder now does what its JS reference always did: an integer
 * outside the safe range goes in as a FLOAT.
 *
 * Which means these are parity checks and not divergences: the value comes
 * back as the same number node has, because it is stored the way node's
 * encoder stores it. Every expectation here was read off `node bin/mdy.js`.
 */
static void big_integer_checks(void) {
    printf("\n--- engine: an integer too big to be one ---\n");

    check("a record with an over-large integer keeps its other keys",
          "+++\ntitle: Fine\nbig: 9007199254740992\nalso: Fine too\n+++\n"
          "= {{ res.data.title }}|{{ res.data.also }}\n",
          "<h1 id=\"finefine-too\">Fine|Fine too</h1>");
    check("...and the document is still findable",
          "= {{ $.find({}).length }}\n---\n+++\nbig: 9007199254740992\n+++\n= x\n",
          "<h1 id=\"2\">2</h1>");
    check("...and the value is a NUMBER, as node's is",
          "+++\nbig: 9007199254740992\n+++\n= {{ res.data.big }}/{{ typeof res.data.big }}\n",
          "<h1 id=\"9007199254740992/number\">9007199254740992/number</h1>");

    /* One below the boundary was never affected — it is a safe integer, so it
     * stays an INT, and this is what says the fix did not move the boundary. */
    check("one below 2^53 is untouched",
          "+++\nbig: 9007199254740991\n+++\n= {{ res.data.big }}/{{ typeof res.data.big }}\n",
          "<h1 id=\"9007199254740991/number\">9007199254740991/number</h1>");
    check("...and still matches a query written as a number",
          "= {{ $.find({ big: 9007199254740991 }).length }}\n"
          "---\n+++\nbig: 9007199254740991\n+++\n= x\n",
          "<h1 id=\"1\">1</h1>");

    /* Negative, exponent form and hex all reach the same branch. */
    check("a negative one past -2^53 survives too",
          "+++\nbig: -9007199254740992\n+++\n= {{ res.data.big }}/{{ typeof res.data.big }}\n",
          "<h1 id=\"-9007199254740992/number\">-9007199254740992/number</h1>");
    check("...and exponent form that lands above it",
          "+++\nbig: 1e17\n+++\n= {{ res.data.big }}/{{ typeof res.data.big }}\n",
          "<h1 id=\"100000000000000000/number\">100000000000000000/number</h1>");
    check("...and hex",
          "+++\nbig: 0x20000000000000\n+++\n= {{ res.data.big }}/{{ typeof res.data.big }}\n",
          "<h1 id=\"9007199254740992/number\">9007199254740992/number</h1>");

    /* A float was never the broken path, at any magnitude. */
    check("a float stays a float, however large",
          "+++\nbig: 1e308\n+++\n= {{ res.data.big }}/{{ typeof res.data.big }}\n",
          "<h1 id=\"1e308/number\">1e+308/number</h1>");
}


/* ---- the URL a broker is named by ---------------------------------------------
 *
 * `parse_url` split host from port on the first colon, so an IPv6 literal —
 * `http://[::1]:8080`, which is the only way to write one in a URL — asks
 * the resolver for a host called "[".
 *
 * The parser is static, so this goes through http_request, which is the way a
 * caller meets it anyway. Port 1 is nothing's port: every case here ends in a
 * refused connection, immediately, and what is being read is the ERROR, which
 * carries back the authority that was actually parsed.
 */
static void url_checks(void) {
    printf("\n--- engine: the URL a broker is named by ---\n");

    HttpResponse r;
    struct { const char *url, *want, *what; } cases[] = {
        { "http://[::1]:1/health",       "[::1]:1",
          "an IPv6 literal keeps its address and its port" },
        { "http://[::1]/health",         "[::1]:80",
          "...and without a port, it is 80" },
        { "http://127.0.0.1:1/health",   "127.0.0.1:1",
          "an ordinary host is unchanged" },
        { "http://127.0.0.1/health",     "127.0.0.1:80",
          "...and it still defaults to 80" },
    };
    for (size_t i = 0; i < sizeof cases / sizeof *cases; i++) {
        memset(&r, 0, sizeof r);
        int rc = http_request("GET", cases[i].url, NULL, NULL, 0, &r);
        ok_(cases[i].what, rc == -1 && strstr(r.error, cases[i].want) != NULL, r.error);
        http_response_free(&r);
    }

    /* A bracket that never closes is a bad URL, not a host called "[::1:8080". */
    memset(&r, 0, sizeof r);
    ok_("an unclosed [ is refused by name",
        http_request("GET", "http://[::1:8080/health", NULL, NULL, 0, &r) == -1 &&
            strstr(r.error, "unclosed [") != NULL, r.error);
    http_response_free(&r);

    /* And the scheme check still stands in front of all of it. */
    memset(&r, 0, sizeof r);
    ok_("a URL that is not http:// is refused",
        http_request("GET", "https://example.com/", NULL, NULL, 0, &r) == -1 &&
            strstr(r.error, "only http://") != NULL, r.error);
    http_response_free(&r);
}


#ifndef _WIN32
/* ---- a directory that will not open ----------------------------------------
 *
 * `walk` answered `errno == ENOENT ? 0 : 0` — every opendir failure was an
 * empty directory. A subtree whose permissions kept us out simply left the
 * site: no warning, a page built, exit 0. node reports
 * `EACCES: permission denied, scandir …` and exits 1.
 *
 * POSIX only (chmod), and skipped when running as root, where 000 keeps
 * nobody out.
 */
static void unreadable_dir_checks(void) {
    printf("\n--- engine: a directory that will not open ---\n");

    if (geteuid() == 0) {
        printf("  (skipped: running as root, where a mode of 000 stops nothing)\n");
        return;
    }

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-perm", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "main.mdy", "= main\n");
    write_file(root, "sub/page.mdy", "= hidden\n");

    char sub[1200];
    snprintf(sub, sizeof sub, "%s/sub", root);
    if (chmod(sub, 0) != 0) {
        printf("  (skipped: chmod would not take)\n");
        free(root);
        return;
    }

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    err[0] = '\0';
    int rc = mdy_engine_open_dir(e, root, err, sizeof err);
    ok_("a subtree that cannot be read fails the open, rather than vanishing",
        rc != 0, rc == 0 ? "it opened" : err);
    ok_("...and says which directory it was",
        rc != 0 && strstr(err, "cannot read") != NULL, err);
    mdy_engine_free(e);

    /* ...and a directory that is merely ABSENT is still an empty list, which
     * a package with no static/ depends on. */
    chmod(sub, 0755);
    char gone[1200];
    snprintf(gone, sizeof gone, "%s/not-there", root);
    char *listing = fsx_list(gone, ".", NULL);
    ok_("a missing directory is still an empty list, not an error",
        listing != NULL && listing[0] == '\0', listing ? "(empty)" : "(NULL)");
    free(listing);

    free(root);
}
#endif


/* ---- a package, imported ----------------------------------------------------
 *
 * `% import style from "../pkg"` opens a SECOND set beside this one and
 * `style.render(...)` renders into it. Without cover here, lookup_import's
 * read — it asks the CURRENT document's record for its `path`, to know who
 * declared the import — can be broken without a single test noticing.
 *
 * The site and the package are siblings under one temp root, which is how
 * fixture-pkg is laid out and the case a relative specifier has to get right.
 */
static void import_checks(void) {
    printf("\n--- engine: a package, imported ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-imp", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    char site[1100], pkg[1100];
    snprintf(site, sizeof site, "%s/site", root);
    snprintf(pkg, sizeof pkg, "%s/pkg", root);

    write_file(site, "main.mdy",
        "% import style from \"../pkg\"\n"
        "% $.emit(\"out.txt\", style.render({ path: \"layouts/card.mdy\" }, { t: \"from the site\" }))\n"
        "% $.emit(\"who.txt\", style.findOne({ path: \"layouts/card.mdy\" }).path)\n");
    write_file(pkg, "layouts/card.mdy", "= {{ req.t }}\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);
    if (mdy_engine_open_dir(e, site, err, sizeof err) != 0) {
        printf("  FAIL  open the importing site\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    ok_("a site that imports a package beside it renders",
        html != NULL, html ? html : err);

    const char *out = emitted("out.txt");
    ok_("...and a render THROUGH the package comes back composed",
        out && strstr(out, "from the site") != NULL, out ? out : "(nothing emitted)");

    /* The package's own set answers its own queries — which is the read that
     * was unrooted: the import is resolved by the importing document's path. */
    const char *who = emitted("who.txt");
    ok_("...and the package's set is the one queried, not the site's",
        who && strcmp(who, "layouts/card.mdy") == 0, who ? who : "(nothing emitted)");

    free(html);
    mdy_engine_free(e);

    /*
     * A LONG specifier, which is the one that overflowed. The line the walk
     * builds for an import carries the spec four times, so `import_line`'s
     * limit of 1023 makes a line of about 4,500 characters — and it was
     * assembled into a char[4096] with snprintf's RETURN used as the length to
     * copy out of it. ASan: stack-buffer-overflow, READ of size 4277. (§3.)
     *
     * The import does not resolve, and does not need to: what is under test is
     * the rewrite of the line, which happens before anything looks for the
     * package. Failing to resolve is the correct outcome and the engine says
     * so rather than crashing.
     */
    char spec[1200];
    memset(spec, 'a', sizeof spec - 1);
    spec[sizeof spec - 1] = '\0';
    memcpy(spec, "../", 3);
    char line[1400];
    snprintf(line, sizeof line, "%% import x from \"%s\"\n= main\n", spec);

    char site2[1100];
    snprintf(site2, sizeof site2, "%s/long", root);
    write_file(site2, "main.mdy", line);

    mdy_engine *e2 = mdy_engine_new(S);
    int opened = mdy_engine_open_dir(e2, site2, err, sizeof err);
    ok_("an import specifier of a thousand characters does not overflow the line",
        opened != 0 || mdy_engine_count(e2) > 0, err);
    mdy_engine_free(e2);

    free(root);
}


/* ---- values a document can make deeper than the walk ------------------------
 *
 * Everything that carries a tree or a value recurses per level, and a document
 * can build sixty thousand levels in two lines of its own code — no crafted
 * file needed, just a loop. `$.node` of such a tree was a segfault, and so was
 * such an object handed to `$.render` as its request.
 *
 * Two thousand rather than sixty: what is checked here is the BOUND, which
 * bites at two hundred and fifty-six either way, and sixty thousand nested
 * objects built in the guest is a minute of this suite's time for nothing.
 * What this asserts is that the tree comes back the depth this says and not
 * the depth it was given.
 */
static void deep_value_checks(void) {
    printf("\n--- engine: values deeper than the walk ---\n");

    const char *built =
        "% let t = { type: 'text', value: 'x' }\n"
        "% for (let i = 0; i < 2000; i++) t = { type: 'element', tagName: 'div', properties: {}, children: [t] }\n"
        "{{ $.node(t) }}\n";
    const char *requested =
        "% let o = 1\n"
        "% for (let i = 0; i < 2000; i++) o = { a: o }\n"
        "{{ $.render(1, { q: o }) }} and {{ $.render(1, { q: o, n: 2 }) }}\n"
        "---\n= Card\n";

    {
        mdy_engine *e = mdy_engine_new(S);
        char err[256];
        char *html = NULL;
        if (mdy_engine_open(e, built, strlen(built), err, sizeof err) == 0)
            html = mdy_engine_render(e, 0, err, sizeof err);
        size_t divs = 0;
        for (const char *p = html; p && (p = strstr(p, "<div>")); p += 5) divs++;
        int ok = html && divs == MDY_MAX_DEPTH;
        printf("  %s  a tree the document built two thousand deep comes back at the limit\n",
               ok ? "ok  " : "FAIL");
        if (!ok) { printf("      %zu divs, limit %d (%s)\n", divs, MDY_MAX_DEPTH,
                          html ? "rendered" : err); failures++; }
        free(html);
        mdy_engine_free(e);
    }
    {
        mdy_engine *e = mdy_engine_new(S);
        char err[256];
        char *html = NULL;
        if (mdy_engine_open(e, requested, strlen(requested), err, sizeof err) == 0)
            html = mdy_engine_render(e, 0, err, sizeof err);
        /* Both renders happen and neither is remembered: a key that stopped
         * short of what tells two requests apart would answer the wrong one.
         * So they are named by count instead, and two of them are two. */
        ok_("...and two requests nested that deep are two renders, not one twice",
            html && strcmp(html, "<p><h1 id=\"card\">Card</h1> and <h1 id=\"card\">Card</h1></p>") == 0,
            html ? html : err);
        free(html);
        mdy_engine_free(e);
    }
}

/* ---- a file name the identity writer has to carry --------------------------
 *
 * Identity is written as YAML and read back, and it was written with a bare
 * `snprintf("%s")`. A file called `it"s.mdy` produced `name: "it"s.mdy"`,
 * which the reader took as `it`: the document's name, ext and path all
 * truncated at the quote, and nothing said so. A backslash began an escape.
 *
 * A newline is the same story one layer earlier: the walk came back from
 * fsx_list one file per LINE, so `new\nline.mdy` was two entries, `new` and
 * `line.mdy`, neither of which exists, and the file was silently not part of
 * the site at all. The listing separates on NUL now, which is the one byte a
 * file name cannot hold.
 *
 * Not on Windows, where none of these characters is legal in a file name, so
 * there is nothing there to carry. The expected line is what
 * `node bin/mdy.js` writes for the same directory.
 */
#ifndef _WIN32
static void odd_name_checks(void) {
    printf("\n--- engine: a file name identity has to carry ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-name", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "it\"s.mdy", "+++\nk: quote\n+++\nbody\n");
    write_file(root, "a\\b.mdy", "+++\nk: slash\n+++\nbody\n");
    write_file(root, "bell\a.mdy", "+++\nk: bell\n+++\nbody\n");
    write_file(root, "new\nline.mdy", "+++\nk: newline\n+++\nbody\n");
    write_file(root, "main.mdy",
        "% $.emit('roll.txt', $.find({ k: { $exists: true } })"
        ".map((x) => x.k + '=' + x.name + '|' + x.path).join(','))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory of oddly named files\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    ok_("a quote, a backslash, a control character and a NEWLINE all reach the record",
        emitted("roll.txt") &&
            strcmp(emitted("roll.txt"),
                   "slash=a\\b.mdy|a\\b.mdy,"
                   "bell=bell\a.mdy|bell\a.mdy,"
                   "quote=it\"s.mdy|it\"s.mdy,"
                   "newline=new\nline.mdy|new\nline.mdy") == 0,
        emitted("roll.txt"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}
#endif


/* Defined further down, with the resize checks it was written for. */
static void write_png(const char *root, const char *rel, int w, int h);

/* ---- a picture the header reader cannot trust -------------------------------
 *
 * A file's dimensions come out of its header, and a header is whatever bytes
 * are on disk. TIFF puts the offset of its first directory in the first eight
 * of them, and the bounds check on that offset was `off + 2 > n` with `off` the
 * width the FILE chose: 0xFFFFFFFE wrapped the sum to zero, walked past the
 * check, and read four gigabytes beyond the buffer. Eight bytes in a .tif
 * anywhere under a site ended the build.
 *
 * Not decodable is not an error — a corrupt or truncated picture is still a
 * real file and still gets its record, just without width and height — so what
 * these assert is that each of them arrives that way rather than not at all.
 */
static void bad_image_checks(void) {
    printf("\n--- engine: a picture the header reader cannot trust ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-image", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    /* The offset that wraps, little- and big-endian; one just past the end;
     * one directory count that would walk entries off it; and a header cut
     * short. */
    static const uint8_t wrap_le[]  = { 'I','I',0x2a,0x00, 0xFE,0xFF,0xFF,0xFF };
    static const uint8_t wrap_be[]  = { 'M','M',0x00,0x2a, 0xFF,0xFF,0xFF,0xFE };
    static const uint8_t past[]     = { 'I','I',0x2a,0x00, 0x00,0x00,0x00,0x10 };
    static const uint8_t count[]    = { 'I','I',0x2a,0x00, 0x08,0x00,0x00,0x00, 0xFF,0xFF };
    static const uint8_t cut[]      = { 'I','I',0x2a,0x00 };
    write_bytes(root, "a-wrap.tif", wrap_le, sizeof wrap_le);
    write_bytes(root, "b-wrap.tif", wrap_be, sizeof wrap_be);
    write_bytes(root, "c-past.tif", past, sizeof past);
    write_bytes(root, "d-count.tif", count, sizeof count);
    write_bytes(root, "e-cut.tif", cut, sizeof cut);
    write_bytes(root, "f-empty.tif", cut, 0);
    /* A real one beside them, so the reader is not merely refusing everything. */
    write_png(root, "g-good.png", 9, 4);

    write_file(root, "main.mdy",
        "% $.emit('roll.txt', $.find({ ext: { $exists: true } })\n"
        "%   .filter((x) => x.ext === '.tif' || x.ext === '.png')\n"
        "%   .map((x) => x.name + '=' + (x.width ?? '-') + 'x' + (x.height ?? '-')).join(','))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory of broken pictures\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    ok_("a header the reader cannot trust costs the file its size, not the build",
        emitted("roll.txt") &&
            strcmp(emitted("roll.txt"),
                   "a-wrap.tif=-x-,b-wrap.tif=-x-,c-past.tif=-x-,"
                   "d-count.tif=-x-,e-cut.tif=-x-,f-empty.tif=-x-,"
                   "g-good.png=9x4") == 0,
        emitted("roll.txt"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- a tag the tags writer has to carry -------------------------------------
 *
 * A document's tags are lowercased and deduplicated, and the way that happens
 * is that the engine WRITES them back out as YAML and reads them in again.
 * They were pasted in with `%s`, so one tag with a quote in it made the whole
 * generated block unparseable — and the failure was silent: the document's
 * tags fall back to whatever the front matter said, never lowercased and
 * never deduplicated — a quieter wrong answer than the truncation the same
 * mistake causes for file names.
 *
 * Every expected value is what `node bin/mdy.js` writes for this directory.
 */
static void tag_checks(void) {
    printf("\n--- engine: a tag the writer has to carry ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-tags", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_file(root, "q.mdy", "+++\ntags: ['A\"b', Alpha, ALPHA, 'c\\d', \"e\\tf\"]\n+++\nbody\n");
    write_file(root, "h.md", "# H\n\n#One and #one and #Two\n");
    write_file(root, "e.mdy", "+++\ntags: []\n+++\nnone\n");
    write_file(root, "main.mdy",
        "% $.emit('tags.txt', $.find({}).filter((d) => d.tags)"
        ".map((d) => d.path + '=' + JSON.stringify(d.tags)).join('|'))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);

    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        printf("  FAIL  open a directory of tagged documents\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    int entry = mdy_engine_entry(e, "main.mdy");
    char *html = entry >= 0 ? mdy_engine_render(e, (size_t)entry, err, sizeof err) : NULL;
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        free(root);
        return;
    }
    free(html);

    ok_("a quote, a backslash and a tab in a tag survive the round trip",
        emitted("tags.txt") &&
            strcmp(emitted("tags.txt"),
                   "e.mdy=[]|"
                   "h.md=[\"one\",\"two\"]|"
                   "q.mdy=[\"a\\\"b\",\"alpha\",\"c\\\\d\",\"e\\tf\"]") == 0,
        emitted("tags.txt"));

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}


/* ---- the collector, and values this engine has just built --------------------
 *
 * The engine hands the VM values it makes itself: a record's keys, a tree's
 * nodes, a query's results. A value reachable only from the C stack is
 * invisible to the collector, and freeing one does not crash — the cell is
 * reused for the next string, and a property quietly becomes a DIFFERENT
 * property.
 *
 * The site that found this had a 642-key record come back with one key gone
 * and another present twice, so a single link out of nine hundred pointed at
 * the wrong page. Nothing else was wrong with the build.
 *
 * These run with the collector at every safe point, which is what makes the
 * failure certain rather than occasional. Run the whole suite that way too:
 * `MDY_GC_STRESS=1 make check-engine`.
 */
static void gc_checks(void) {
    printf("\n--- engine: values the collector can see ---\n");

    /*
     * The shape the real failure had: a large record read from the store,
     * handed to ANOTHER document as its `req`, and read back there after
     * enough rendering in between to have collected several times.
     */
    char *source = malloc(900000);
    if (!source) { printf("  FAIL  out of memory\n"); failures++; return; }
    size_t at = 0;
    at += (size_t)sprintf(source + at,
        "%% const d = $.findOne({ path: 'r.mdy' })\n"
        "%% for (let round = 0; round < 12; round++) {\n"
        "%%   $.text({ path: 'filler.mdy' }, { n: round })\n"
        "%% }\n"
        "%% $.emit('bad', $.text({ path: 'reader.mdy' }, { map: d.map }))\n"
        "---\n+++\npath: filler.mdy\n+++\n"
        "%% let junk = []\n"
        "%% for (let i = 0; i < 400; i++) { junk.push({ a: 'x' + i + req.n, b: [i], c: { d: 'y' + i } }) }\n"
        "filler\n"
        "---\n+++\npath: reader.mdy\n+++\n"
        "%% let bad = 0\n"
        "%% for (let i = 0; i < 800; i++) { if (req.map['k' + i] !== 'v' + i) bad++ }\n"
        "{{ String(bad) + '/' + Object.keys(req.map).length }}\n"
        "---\n+++\npath: r.mdy\nmap:\n");
    for (int i = 0; i < 800; i++)
        at += (size_t)sprintf(source + at, "  k%d: v%d\n", i, i);
    at += (size_t)sprintf(source + at, "+++\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[256];
    emit_count = 0;
    mdy_engine_on_emit(e, collect_all, NULL);
    char *html = NULL;
    if (mdy_engine_open(e, source, at, err, sizeof err) == 0)
        html = mdy_engine_render(e, 0, err, sizeof err);
    free(source);
    free(html);

    const char *got = emitted("bad");
    ok_("every key of a large record survives collection",
        got && strcmp(got, "0/800") == 0, got ? got : err);
    mdy_engine_free(e);
}


/* Where a `$.publish` landed, for the checks below. */
static char last_message[512];
static int message_count;

static void collect_message(void *ud, const char *name, const char *data_json,
                            size_t doc_index) {
    (void)ud;
    snprintf(last_message, sizeof last_message, "%s %s from %zu", name, data_json, doc_index);
    message_count++;
}

static void natives_checks(void) {
    printf("\n--- engine: the rest of `$` ---\n");

    /*
     * The tree a document did not write itself. All of these end in a token
     * except `$.parse`, which hands back the TREE — its whole purpose is to be
     * looked at — and `$.html`, which is the way back out to text.
     *
     * Every expectation here was taken from `node bin/mdy.js build` on the
     * same source.
     */
    /*
     * `$.html` returns a STRING, and a string written into a document is
     * TEXT — so the markup in it is escaped when the document is read, and an
     * `= ` at the start of the line still opens a heading. That is the whole
     * reason `$.node` and the rest hand back tokens instead: a token is a
     * tree, and a tree goes in as nodes.
     *
     * Both expectations here were wrong the first time and both were taken
     * from `node bin/mdy.js build` on this exact source.
     */
    check("$.parse reads MDY and gives back a tree",
          "{{ $.html($.parse('= A heading')) }}",
          "<h1 id=\"a-heading\">A heading&#x3C;/h1></h1>");
    check("$.markdown is the other front end",
          "{{ $.markdown('# Md heading') }}",
          "<h1 id=\"md-heading\">Md heading</h1>");
    check("$.node parks a tree the document built",
          "{{ $.node({ type: 'element', tagName: 'p', properties: { className: ['x'] },"
          " children: [{ type: 'text', value: 'built' }] }) }}",
          "<p class=\"x\">built</p>");
    check("$.table, with a cell read as MDY",
          "{{ $.table([['Name'], ['**old**']]) }}",
          "<table><thead><tr><th>Name</th></tr></thead>"
          "<tbody><tr><td><strong>old</strong></td></tr></tbody></table>");
    check("...and an alignment per column",
          "{{ $.table([['A', 'B']], ['left', 'right']) }}",
          "<table><thead><tr><th style=\"text-align: left\">A</th>"
          "<th style=\"text-align: right\">B</th></tr></thead></table>");
    check("a table cell that is not one paragraph stays the text it was",
          "{{ $.table([['H'], ['- one\\n- two']]) }}",
          "<table><thead><tr><th>H</th></tr></thead>"
          "<tbody><tr><td>- one\n- two</td></tr></tbody></table>");
    check("$.html turns a token in a string into its HTML",
          "% const frag = $.render(1)\n{{ $.html('before ' + frag + ' after') }}\n"
          "---\n**frag**\n",
          "<p>before &#x3C;p>&#x3C;strong>frag&#x3C;/strong>&#x3C;/p> after</p>");

    /*
     * `$.toc()` returns a token before there is anything to put in it, and
     * that is the point: the list has to be able to name a heading a loop
     * writes BELOW it.
     */
    check("$.toc() names a heading written after it",
          "< nav\n  {{ $.toc() }}\n% for (const c of ['Uruk', 'Akkad']) {\n== {{ c }}\n% }\n",
          "<nav>\n<ul><li><a href=\"#uruk\">Uruk</a></li>"
          "<li><a href=\"#akkad\">Akkad</a></li></ul>\n</nav>"
          "<h2 id=\"uruk\">Uruk</h2><h2 id=\"akkad\">Akkad</h2>");
    check("...and nests a deeper heading, then comes back OUT of it",
          "{{ $.toc() }}\n= One\n== Two\n= Three\n",
          "<ul><li><a href=\"#one\">One</a><ul><li><a href=\"#two\">Two</a></li></ul></li>"
          "<li><a href=\"#three\">Three</a></li></ul>"
          "<h1 id=\"one\">One</h1><h2 id=\"two\">Two</h2><h1 id=\"three\">Three</h1>");
    /* A heading the parser did not give an id to cannot be linked, so it is
     * not listed. Raw HTML is how one gets written. */
    check("...and skips a heading with no id to link to",
          "{{ $.toc() }}\n<h2>Raw heading\n= Real\n",
          "<ul><li><a href=\"#real\">Real</a></li></ul>"
          "<h2>Raw heading</h2><h1 id=\"real\">Real</h1>");
    check("...and disappears entirely when nothing can be listed",
          "{{ $.toc() }}\n<p>plain\n", "<p>plain</p>");
    {
        /* A heading's id is as long as the heading, and the link is as long
         * as the id: nothing between them is a fixed size. */
        enum { LONG = 700 };
        char word[LONG + 1];
        memset(word, 'x', LONG);
        word[LONG] = '\0';
        char source[LONG + 64], expected[4 * LONG + 128];
        snprintf(source, sizeof source, "{{ $.toc() }}\n= %s\n", word);
        snprintf(expected, sizeof expected,
                 "<ul><li><a href=\"#%s\">%s</a></li></ul><h1 id=\"%s\">%s</h1>",
                 word, word, word, word);
        check("...and links a heading of seven hundred characters in full", source, expected);
    }
    check("$.toc(text) is a question, not a token",
          "{{ JSON.stringify($.toc('= One\\n\\n== Two')) }}",
          "<p>[{\"depth\":1,\"text\":\"One\",\"slug\":\"one\"},"
          "{\"depth\":2,\"text\":\"Two\",\"slug\":\"two\"}]</p>");
    check("...and takes a rendered document too",
          "{{ JSON.stringify($.toc($.render(1))) }}\n---\n= Zed\n",
          "<p>[{\"depth\":1,\"text\":\"Zed\",\"slug\":\"zed\"}]</p>");

    refuses("$.node wants a hast node", "{{ $.node('nope') }}",
            "expects a hast node");
    refuses("$.table wants rows", "{{ $.table('nope') }}",
            "array of row arrays");
    refuses("$.toc wants something it can read", "{{ $.toc(42) }}",
            "expects MDY text, a hast node, or a rendered document");

    /* ---- publishing ---- */
    {
        const char *source =
            "% $.publish('handlers.invoice', { total: 3 })\n"
            "---\n+++\npath: handlers/invoice.mdy\next: .mdy\n+++\n= Invoice\n";
        mdy_engine *e = mdy_engine_new(S);
        char err[256];
        message_count = 0;
        last_message[0] = '\0';
        mdy_engine_on_publish(e, collect_message, NULL);
        char *html = NULL;
        if (mdy_engine_open(e, source, strlen(source), err, sizeof err) == 0)
            html = mdy_engine_render(e, 0, err, sizeof err);
        ok_("a page's name is its path without the extension",
            message_count == 1 &&
                strcmp(last_message, "handlers.invoice {\"total\":3} from 1") == 0,
            last_message[0] ? last_message : err);
        free(html);
        mdy_engine_free(e);
    }

    refuses("publishing to a name no document answers to",
            "% $.publish('nowhere.at.all', {})\n",
            "no document is named \"nowhere.at.all\"");
    /*
     * Both halves of the ambiguity message, and the second half is the point:
     * naming the documents means READING each one's `path` back out of its
     * record, and a record is built fresh per call and reachable only from the
     * C stack. Asserting only "is ambiguous" leaves that read unchecked: the
     * function is covered and the read inside it is not.
     */
    refuses("...or to one that several share",
            "% $.publish('x', {})\n"
            "---\n+++\npath: a/one.mdy\next: .mdy\nmessageName: x\n+++\n= A\n"
            "---\n+++\npath: b/two.mdy\next: .mdy\nmessageName: x\n+++\n= B\n",
            "is ambiguous");
    refuses("...and it says WHICH documents share it",
            "% $.publish('x', {})\n"
            "---\n+++\npath: a/one.mdy\next: .mdy\nmessageName: x\n+++\n= A\n"
            "---\n+++\npath: b/two.mdy\next: .mdy\nmessageName: x\n+++\n= B\n",
            "(a/one.mdy, b/two.mdy)");
    refuses("...or to a name that is not one",
            "% $.publish('bad name!', {})\n",
            "may only contain letters, digits");
    /* A record with nothing to run is not an endpoint — which is also what
     * stops static/logo.png and static/logo.jpg colliding on static.logo. */
    refuses("a record that is not a page is not addressable",
            "% $.publish('static.logo', {})\n"
            "---\n+++\npath: static/logo.png\next: .png\n+++\n",
            "no document is named \"static.logo\"");
}


/* Bytes a `$.resize` produced, for the checks below. */
static char last_image_path[256];
static size_t last_image_len;
static int image_count;
static uint8_t last_image[65536];

static void collect_image(void *ud, const char *path, const uint8_t *bytes, size_t len) {
    (void)ud;
    snprintf(last_image_path, sizeof last_image_path, "%s", path);
    last_image_len = len < sizeof last_image ? len : sizeof last_image;
    memcpy(last_image, bytes, last_image_len);
    image_count++;
}

/* A real PNG, built here rather than checked in: 4 bytes of header a decoder
 * would reject is not a test of a decoder. */
static void write_png(const char *root, const char *rel, int w, int h) {
    /* Uncompressed deflate blocks, so no compressor is needed — a valid zlib
     * stream is a 2-byte header, stored blocks, and an Adler-32. */
    size_t raw_len = (size_t)h * (1 + (size_t)w * 4);
    uint8_t *raw = malloc(raw_len);
    if (!raw) return;
    size_t at = 0;
    for (int y = 0; y < h; y++) {
        raw[at++] = 0;                       /* filter: none */
        for (int x = 0; x < w; x++) {
            raw[at++] = (uint8_t)((x * 37) & 0xFF);
            raw[at++] = (uint8_t)((y * 53) & 0xFF);
            raw[at++] = 128;
            raw[at++] = 255;
        }
    }
    uint32_t a = 1, b = 0;
    for (size_t i = 0; i < raw_len; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
    uint32_t adler = (b << 16) | a;

    size_t z_cap = raw_len + raw_len / 65535 * 5 + 64;
    uint8_t *z = malloc(z_cap);
    if (!z) { free(raw); return; }
    size_t zn = 0;
    z[zn++] = 0x78; z[zn++] = 0x01;
    size_t left = raw_len, off = 0;
    while (left > 0 || raw_len == 0) {
        uint16_t chunk = left > 65535 ? 65535 : (uint16_t)left;
        z[zn++] = (uint8_t)((left <= 65535) ? 1 : 0);
        z[zn++] = (uint8_t)(chunk & 0xFF);
        z[zn++] = (uint8_t)(chunk >> 8);
        z[zn++] = (uint8_t)(~chunk & 0xFF);
        z[zn++] = (uint8_t)((~chunk >> 8) & 0xFF);
        memcpy(z + zn, raw + off, chunk);
        zn += chunk; off += chunk; left -= chunk;
        if (left == 0) break;
    }
    z[zn++] = (uint8_t)(adler >> 24); z[zn++] = (uint8_t)(adler >> 16);
    z[zn++] = (uint8_t)(adler >> 8);  z[zn++] = (uint8_t)adler;

    static const uint32_t CRC_POLY = 0xEDB88320u;
    uint32_t table[256];
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = (c & 1) ? (CRC_POLY ^ (c >> 1)) : (c >> 1);
        table[i] = c;
    }
    uint8_t *png = malloc(zn + 128);
    if (!png) { free(raw); free(z); return; }
    size_t pn = 0;
    memcpy(png + pn, "\x89PNG\r\n\x1a\n", 8); pn += 8;
    /* One chunk: length, type, payload, CRC over type+payload. */
    #define PUT_CHUNK(type, payload, plen) do { \
        uint32_t L = (uint32_t)(plen); \
        png[pn++] = (uint8_t)(L >> 24); png[pn++] = (uint8_t)(L >> 16); \
        png[pn++] = (uint8_t)(L >> 8);  png[pn++] = (uint8_t)L; \
        size_t cs = pn; \
        memcpy(png + pn, (type), 4); pn += 4; \
        if (plen) memcpy(png + pn, (payload), (plen)); \
        pn += (plen); \
        uint32_t c = 0xFFFFFFFFu; \
        for (size_t i = cs; i < pn; i++) c = table[(c ^ png[i]) & 0xFF] ^ (c >> 8); \
        c ^= 0xFFFFFFFFu; \
        png[pn++] = (uint8_t)(c >> 24); png[pn++] = (uint8_t)(c >> 16); \
        png[pn++] = (uint8_t)(c >> 8);  png[pn++] = (uint8_t)c; \
    } while (0)
    uint8_t ihdr[13] = {
        (uint8_t)(w >> 24), (uint8_t)(w >> 16), (uint8_t)(w >> 8), (uint8_t)w,
        (uint8_t)(h >> 24), (uint8_t)(h >> 16), (uint8_t)(h >> 8), (uint8_t)h,
        8, 6, 0, 0, 0,
    };
    PUT_CHUNK("IHDR", ihdr, 13);
    PUT_CHUNK("IDAT", z, zn);
    PUT_CHUNK("IEND", NULL, 0);
    #undef PUT_CHUNK

    char path[1024];
    snprintf(path, sizeof path, "%s/%s", root, rel);
    char *slash = strrchr(path, '/');
    if (slash) { *slash = '\0'; fsx_mkdirp(path); *slash = '/'; }
    FILE *f = fopen(path, "wb");
    if (f) { fwrite(png, 1, pn, f); fclose(f); }
    free(raw); free(z); free(png);
}

static void resize_checks(void) {
    printf("\n--- engine: $.resize ---\n");

    char *tmp = fsx_tmpdir();
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "%s/mdy-resize", tmp ? tmp : ".");
    free(tmp);
    char *root = fsx_mkdtemp(prefix);
    if (!root) { printf("  FAIL  cannot make a temp directory\n"); failures++; return; }

    write_png(root, "static/logo.png", 64, 40);
    write_file(root, "notes.md", "not an image\n");
    write_file(root, "static/notes.txt", "hello\n");
    write_file(root, "static/bad.png", "not a PNG at all\n");
    /*
     * Every refusal as well as every success. `$.resize` reports by ANSWERING
     * with its message rather than throwing an Error, so the guest sees a
     * bare string — which is why each is caught as `String(err)` and not
     * `err.message`.
     *
     * They are checked BYTE for byte because they are parity: node prints the
     * same text, and a message that drifts is a build whose log stops matching
     * even though its output still does. Only the first of these was covered
     * before the seven exits were unified behind one macro.
     */
    write_file(root, "main.mdy",
        "% const logo = $.findOne({ path: 'static/logo.png' })\n"
        "% $.emit('dims.txt', logo.width + 'x' + logo.height)\n"
        "% const a = $.resize(logo, { width: 20 })\n"
        "% $.emit('a.txt', [a.path, a.url, a.width, a.height].join('|'))\n"
        "% const b = $.resize(logo, { height: 10 })\n"
        "% $.emit('b.txt', [b.path, b.url, b.width, b.height].join('|'))\n"
        "% const again = $.resize(logo, { width: 20 })\n"
        "% $.emit('memo.txt', String(again.path === a.path))\n"
        "% const refused = (label, fn) => { try { fn(); $.emit(label, 'NO REFUSAL') }\n"
        "%                                  catch (err) { $.emit(label, String(err)) } }\n"
        "% refused('r-notdoc.txt', () => $.resize({ nope: 1 }, { width: 4 }))\n"
        "% refused('r-notpng.txt', () => $.resize($.findOne({ path: 'static/notes.txt' }), { width: 4 }))\n"
        "% refused('r-nodims.txt', () => $.resize($.findOne({ path: 'static/bad.png' }), { width: 4 }))\n"
        "% refused('r-nosize.txt', () => $.resize(logo, {}))\n");

    mdy_engine *e = mdy_engine_new(S);
    char err[512];
    emit_count = 0;
    image_count = 0;
    last_image_path[0] = '\0';
    mdy_engine_on_emit(e, collect_all, NULL);
    mdy_engine_on_binary(e, collect_image, NULL);

    char *html = NULL;
    if (mdy_engine_open_dir(e, root, err, sizeof err) == 0) {
        int at = mdy_engine_entry(e, "main.mdy");
        if (at >= 0) html = mdy_engine_render(e, (size_t)at, err, sizeof err);
    }
    if (!html) {
        printf("  FAIL  the entry renders\n      %s\n", err);
        failures++;
        mdy_engine_free(e);
        fsx_rm_rf(root);
        free(root);
        return;
    }
    free(html);

    /* An image's dimensions are read from its header during the walk — a
     * record without them cannot be resized at all. */
    ok_("an image file's record carries its dimensions",
        emitted("dims.txt") && strcmp(emitted("dims.txt"), "64x40") == 0,
        emitted("dims.txt"));

    /*
     * The output path is DIST-relative: `static/` is stripped, because a build
     * copies static/'s contents to the output root and a resized file has to
     * land in the same flattened space or its URL would not match.
     */
    ok_("a resize names where it landed, with static/ flattened away",
        emitted("a.txt") && strcmp(emitted("a.txt"),
                                   "logo-20x13.png|/logo-20x13.png|20|13") == 0,
        emitted("a.txt"));
    ok_("...deriving the other side from the aspect ratio",
        emitted("b.txt") && strcmp(emitted("b.txt"),
                                   "logo-16x10.png|/logo-16x10.png|16|10") == 0,
        emitted("b.txt"));
    ok_("...and asking twice decodes once",
        emitted("memo.txt") && strcmp(emitted("memo.txt"), "true") == 0 && image_count == 2,
        emitted("memo.txt"));

    /* Each one's exact text, against what node prints. */
    ok_("a refusal names what was passed instead of a document",
        emitted("r-notdoc.txt") && strcmp(emitted("r-notdoc.txt"),
            "resize: expected a file document (path/ext, from $.find/$.findOne), not {\"nope\":1}") == 0,
        emitted("r-notdoc.txt"));
    ok_("...names the extension it will not take",
        emitted("r-notpng.txt") && strcmp(emitted("r-notpng.txt"),
            "resize: unsupported image type \".txt\" (supported: .png)") == 0,
        emitted("r-notpng.txt"));
    ok_("...names the file whose dimensions would not read",
        emitted("r-nodims.txt") && strcmp(emitted("r-nodims.txt"),
            "resize: static/bad.png has no known width/height "
            "(its dimensions could not be read)") == 0,
        emitted("r-nodims.txt"));
    ok_("...and says what it wanted when neither side was given",
        emitted("r-nosize.txt") && strcmp(emitted("r-nosize.txt"),
            "resize: pass at least one of { width, height }") == 0,
        emitted("r-nosize.txt"));

    /* The bytes are a real PNG of the size asked for — checked by reading the
     * header back, because "it wrote something" is not the claim. */
    int ok_png = last_image_len > 24 &&
                 memcmp(last_image, "\x89PNG\r\n\x1a\n", 8) == 0;
    int w = 0, h = 0;
    if (ok_png) {
        w = (int)((last_image[16] << 24) | (last_image[17] << 16) |
                  (last_image[18] << 8) | last_image[19]);
        h = (int)((last_image[20] << 24) | (last_image[21] << 16) |
                  (last_image[22] << 8) | last_image[23]);
    }
    char detail[128];
    snprintf(detail, sizeof detail, "%s %dx%d (%zu bytes)",
             last_image_path, w, h, last_image_len);
    ok_("...and the bytes really are a PNG of that size",
        ok_png && w == 16 && h == 10, detail);

    mdy_engine_free(e);
    fsx_rm_rf(root);
    free(root);
}

/*
 * The broker that `mdy dev` runs when no --broker is given: sukkal's store
 * and routes over a directory in memory (memns.h). What is checked is the
 * store's whole life for one subject, through the same requests the dev
 * loop makes — publish, list, take, done, fail, and the move to the
 * dead-letter channel — because that directory is this package's own
 * adapter, and a bug in it would show up as a message that never comes
 * back, on Windows and in the browser first.
 */
static int broker_ok(Broker *b, const char *method, const char *path, const char *query,
                     const uint8_t *body, size_t len, bjv **out) {
    BrokerReply r;
    int ok = broker_request(b, method, path, query, body, len, &r) == 0 && r.status >= 200 && r.status < 300;
    *out = ok ? bjv_decode(r.body, r.body_len) : NULL;
    int status = r.status;
    broker_reply_free(&r);
    return ok ? status : -status;
}

static void broker_checks(void) {
    printf("\n--- the broker in this process ---\n");
    char detail[256];
    Broker *b = broker_open();
    ok_("opens over a directory in memory", b != NULL, "NULL");
    if (!b) return;

    bj_builder *bld = bj_builder_new();
    bj_begin_object(bld);
    bj_put_key(bld, (const uint8_t *)"id", 2);
    bj_put_string(bld, (const uint8_t *)"a-1001", 6);
    bj_end_object(bld);
    size_t len = 0;
    const uint8_t *body = bj_builder_data(bld, &len);

    bjv *v = NULL;
    int st = broker_ok(b, "POST", "/pub/jobs.invoice", NULL, body, len, &v);
    snprintf(detail, sizeof detail, "status %d index %.0f", st, bjv_number(v, "index", -1));
    ok_("a publish lands at index 1", st > 0 && bjv_number(v, "index", -1) == 1, detail);
    bjv_free(v);
    st = broker_ok(b, "POST", "/pub/jobs.invoice", NULL, body, len, &v);
    snprintf(detail, sizeof detail, "status %d index %.0f", st, bjv_number(v, "index", -1));
    ok_("...and the next at index 2", st > 0 && bjv_number(v, "index", -1) == 2, detail);
    bjv_free(v);

    st = broker_ok(b, "GET", "/subjects", NULL, NULL, 0, &v);
    int listed = v && v->type == BJV_ARRAY && v->count == 1 && v->items[0]->type == BJV_STRING &&
                 strcmp(v->items[0]->string, "jobs.invoice") == 0;
    char *json = bjv_to_json(v);
    ok_("the listing names the subject", listed, json);
    free(json); bjv_free(v);

    st = broker_ok(b, "PUT", "/queue/jobs.invoice", "group=mdy&max_attempts=2&backoff_ms=0", NULL, 0, &v);
    ok_("a queue group with two attempts and no backoff", st > 0, "refused");
    bjv_free(v);

    st = broker_ok(b, "POST", "/take/jobs.invoice", "group=mdy&max=16&lease=30000", NULL, 0, &v);
    int took = v && v->type == BJV_ARRAY && v->count == 2 &&
               bjv_number(v->items[0], "index", 0) == 1 && bjv_number(v->items[1], "index", 0) == 2 &&
               bjv_number(v->items[1], "attempts", 0) == 1;
    json = bjv_to_json(v);
    ok_("a take leases both, first attempt", took, json);
    /* the payload comes back as the bytes that went in */
    const bjv *payload = took ? bjv_get(v->items[0], "payload") : NULL;
    ok_("...with the payload byte for byte",
        payload && payload->type == BJV_BINARY && payload->len == len && memcmp(payload->bytes, body, len) == 0, json);
    free(json); bjv_free(v);

    st = broker_ok(b, "POST", "/done/jobs.invoice", "group=mdy&index=1", NULL, 0, &v); bjv_free(v);
    ok_("done settles the first", st > 0, "refused");
    st = broker_ok(b, "POST", "/fail/jobs.invoice", "group=mdy&index=2", NULL, 0, &v); bjv_free(v);
    ok_("fail returns the second", st > 0, "refused");

    st = broker_ok(b, "POST", "/take/jobs.invoice", "group=mdy&max=16&lease=30000", NULL, 0, &v);
    took = v && v->type == BJV_ARRAY && v->count == 1 &&
           bjv_number(v->items[0], "index", 0) == 2 && bjv_number(v->items[0], "attempts", 0) == 2;
    json = bjv_to_json(v);
    ok_("the failed one comes back alone, second attempt", took, json);
    free(json); bjv_free(v);
    st = broker_ok(b, "POST", "/fail/jobs.invoice", "group=mdy&index=2", NULL, 0, &v); bjv_free(v);

    /* out of attempts: the next take moves it to the dead-letter channel */
    st = broker_ok(b, "POST", "/take/jobs.invoice", "group=mdy&max=16&lease=30000", NULL, 0, &v);
    json = bjv_to_json(v);
    ok_("out of attempts, a take hands out nothing", v && v->type == BJV_ARRAY && v->count == 0, json);
    free(json); bjv_free(v);

    st = broker_ok(b, "GET", "/subjects", NULL, NULL, 0, &v);
    int has_dead = 0;
    if (v && v->type == BJV_ARRAY)
        for (size_t i = 0; i < v->count; i++)
            if (v->items[i]->type == BJV_STRING && strcmp(v->items[i]->string, "jobs.invoice.dead") == 0) has_dead = 1;
    json = bjv_to_json(v);
    ok_("...and the dead-letter channel is a subject now", has_dead, json);
    free(json); bjv_free(v);

    st = broker_ok(b, "POST", "/take/jobs.invoice.dead", "group=mdy&max=16&lease=30000", NULL, 0, &v);
    json = bjv_to_json(v);
    ok_("the dead letter can be taken from there", v && v->type == BJV_ARRAY && v->count == 1, json);
    free(json); bjv_free(v);

    st = broker_ok(b, "GET", "/dead/jobs.invoice", NULL, NULL, 0, &v);
    json = bjv_to_json(v);
    ok_("`mdy dead` sees it too", st > 0 && v && v->type == BJV_ARRAY && v->count == 1, json);
    free(json); bjv_free(v);

    bj_builder_free(bld);
    broker_close(b);
    ok_("closes with nothing left behind", 1, NULL);
}

/* ---- the public surface an embedder holds --------------------------------
 *
 * Ten of the twelve entry points below had NO test here at all; they were
 * reached only through the 34 CLI cases, which CI runs on Linux alone (§4,
 * and §5 called this the cheapest remaining thing worth doing). What an
 * embedder holds is engine.h, and engine.h is what this exercises: the
 * things a caller does BEFORE a render (the knobs, a scope, a response), the
 * things it asks DURING one (a page by name, a document's path), and the
 * things it reads AFTER (the roots, the response, JSON encoded the way
 * nisaba wants it).
 *
 * Each assertion is the contract engine.h states, quoted where it is short
 * enough to quote.
 */
static void api_checks(void) {
    printf("\n--- engine: the public surface, from engine.h ---\n");

    char err[512];

    /* --- render_text and render_json ------------------------------------- */
    {
        mdy_engine *e = mdy_engine_new(S);
        const char *src = "% $.emit(\"a.txt\", \"x\")\n= Title\n\nbody\n";
        if (mdy_engine_open(e, src, strlen(src), err, sizeof err) != 0) {
            ok_("open for render_text", 0, err);
        } else {
            char *text = mdy_engine_render_text(e, 0, err, sizeof err);
            ok_("render_text gives the text the document's code wrote, not its HTML",
                text && strstr(text, "= Title") != NULL && strstr(text, "<h1") == NULL,
                text ? text : err);
            free(text);
        }
        mdy_engine_free(e);
    }
    {
        /* "mdy_engine_set_context_* are NOT added; the JSON is the whole
         * request" — so `req` is exactly what was handed in. */
        mdy_engine *e = mdy_engine_new(S);
        const char *src = "= Hello {{ req.who }}\n";
        if (mdy_engine_open(e, src, strlen(src), err, sizeof err) != 0) {
            ok_("open for render_json", 0, err);
        } else {
            char *html = mdy_engine_render_json(e, 0, "{\"who\":\"world\"}", err, sizeof err);
            ok_("render_json binds the JSON it was given as `req`",
                html && strstr(html, "Hello world") != NULL, html ? html : err);
            free(html);

            char *bad = mdy_engine_render_json(e, 0, "{not json", err, sizeof err);
            ok_("...and says so rather than rendering when the request is not JSON",
                bad == NULL, bad ? bad : "(NULL, with an error)");
            free(bad);
        }
        mdy_engine_free(e);
    }

    /* --- encode_json ------------------------------------------------------ */
    {
        mdy_engine *e = mdy_engine_new(S);
        const char *src = "= x\n";
        mdy_engine_open(e, src, strlen(src), err, sizeof err);
        uint8_t *out = NULL;
        size_t len = 0;
        ok_("encode_json turns a JSON text into one binjson value",
            mdy_engine_encode_json(e, "{\"a\":1}", &out, &len) == 0 && out && len > 0,
            out ? "(encoded)" : "(nothing)");
        free(out);
        out = NULL; len = 0;
        /* "-1 when the text is not JSON" */
        ok_("...and answers -1 for a text that is not JSON",
            mdy_engine_encode_json(e, "{nope", &out, &len) != 0, "(refused)");
        free(out);
        mdy_engine_free(e);
    }

    /* --- set_response / last_response ------------------------------------- */
    {
        mdy_engine *e = mdy_engine_new(S);
        const char *src = "% res.answer = 42\n= x\n";
        mdy_engine_set_response(e, 1);
        if (mdy_engine_open(e, src, strlen(src), err, sizeof err) != 0) {
            ok_("open for set_response", 0, err);
        } else {
            char *html = mdy_engine_render(e, 0, err, sizeof err);
            const char *res = mdy_engine_last_response(e);
            ok_("set_response keeps `res` and last_response gives it back as JSON",
                res && strstr(res, "42") != NULL, res ? res : "(nothing)");
            /* "minus `doc`, which is the tree and is the HTML's business" */
            ok_("...without `doc`, which is the tree",
                res && strstr(res, "\"doc\"") == NULL, res ? res : "(nothing)");
            free(html);
        }
        mdy_engine_free(e);
    }
    {
        mdy_engine *e = mdy_engine_new(S);
        const char *src = "% res.answer = 42\n= x\n";
        mdy_engine_open(e, src, strlen(src), err, sizeof err);
        char *html = mdy_engine_render(e, 0, err, sizeof err);
        ok_("...and nothing is kept when it was not asked for",
            mdy_engine_last_response(e) == NULL, "(NULL)");
        free(html);
        mdy_engine_free(e);
    }

    /* --- set_scope_json ---------------------------------------------------- */
    {
        mdy_engine *e = mdy_engine_new(S);
        const char *src = "= {{ site.name }}\n";
        int ok = mdy_engine_set_scope_json(e, "site", "{\"name\":\"Uruk\"}");
        mdy_engine_open(e, src, strlen(src), err, sizeof err);
        char *html = mdy_engine_render(e, 0, err, sizeof err);
        ok_("set_scope_json binds a name in the document's own scope",
            ok == 0 && html && strstr(html, "Uruk") != NULL, html ? html : err);
        free(html);
        /* "The name must be an identifier and may not be one of the toolkit's
         * (transform, visit, h, toText, slug); -1 when it is either." */
        ok_("...refuses a name that is not an identifier",
            mdy_engine_set_scope_json(e, "not a name", "1") == -1, "(-1)");
        ok_("...and refuses one of the toolkit's own",
            mdy_engine_set_scope_json(e, "slug", "1") == -1, "(-1)");
        mdy_engine_free(e);
    }

    /* --- the knobs: sanitize and tasks -------------------------------------- */
    {
        /* tasks: "1: a task's box is a form carrying the line and column of
         * its `[x]`; 0: a disabled checkbox." */
        const char *src = "- [ ] a task\n";
        mdy_engine *a = mdy_engine_new(S);
        mdy_engine_set_tasks(a, 0);
        mdy_engine_open(a, src, strlen(src), err, sizeof err);
        char *off = mdy_engine_render(a, 0, err, sizeof err);

        mdy_engine *b = mdy_engine_new(S);
        mdy_engine_set_tasks(b, 1);
        mdy_engine_open(b, src, strlen(src), err, sizeof err);
        char *on = mdy_engine_render(b, 0, err, sizeof err);

        ok_("set_tasks(0) gives a disabled checkbox",
            off && strstr(off, "disabled") != NULL, off ? off : err);
        ok_("set_tasks(1) gives a form instead",
            on && strstr(on, "<form") != NULL, on ? on : err);
        free(off); free(on);
        mdy_engine_free(a); mdy_engine_free(b);
    }
    {
        /* A bare `---` starts a document. That is the format, not a knob:
         * nothing can ask this engine to read a source any other way. */
        const char *src = "= one\n---\n= two\n";
        mdy_engine *a = mdy_engine_new(S);
        mdy_engine_open(a, src, strlen(src), err, sizeof err);
        ok_("a bare `---` always starts a second document",
            mdy_engine_count(a) == 2, mdy_engine_count(a) == 2 ? "(2)" : "(not 2)");
        mdy_engine_free(a);
    }
    {
        /* sanitize: what a document may write as raw HTML. */
        const char *src = "<script>x()</script>\n";
        mdy_engine *a = mdy_engine_new(S);
        mdy_engine_set_sanitize(a, 1);
        mdy_engine_open(a, src, strlen(src), err, sizeof err);
        char *on = mdy_engine_render(a, 0, err, sizeof err);
        ok_("set_sanitize(1) drops a <script> a document wrote",
            on && strstr(on, "<script") == NULL, on ? on : err);
        free(on);
        mdy_engine_free(a);
    }

    /* --- page_index and document_path -------------------------------------- */
    {
        char *tmp = fsx_tmpdir();
        char prefix[1024];
        snprintf(prefix, sizeof prefix, "%s/mdy-api", tmp ? tmp : ".");
        free(tmp);
        char *root = fsx_mkdtemp(prefix);
        if (!root) { ok_("a temp directory for the directory checks", 0, "(none)"); return; }

        write_file(root, "main.mdy", "= main\n");
        write_file(root, "handlers/one.mdy", "+++\nmessageName: handlers.one\n+++\n= one\n");
        write_file(root, "handlers/two.mdy", "= two\n");

        mdy_engine *e = mdy_engine_new(S);
        if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
            ok_("open_dir for the directory checks", 0, err);
            mdy_engine_free(e);
            free(root);
            return;
        }

        /* "a page's own name — its path without the extension, `/` written as
         * `.`, or the `messageName` it declares" */
        int by_path = mdy_engine_page_index(e, "handlers.two");
        int by_declared = mdy_engine_page_index(e, "handlers.one");
        ok_("page_index finds a page by its path with `/` written as `.`",
            by_path >= 0, by_path >= 0 ? "(found)" : "(-1)");
        ok_("...and by the messageName a document declares",
            by_declared >= 0, by_declared >= 0 ? "(found)" : "(-1)");
        ok_("...and answers -1 for a name no document has",
            mdy_engine_page_index(e, "handlers.nope") == -1, "(-1)");

        char *p = by_declared >= 0 ? mdy_engine_document_path(e, (size_t)by_declared) : NULL;
        ok_("document_path gives the path its record holds",
            p && strcmp(p, "handlers/one.mdy") == 0, p ? p : "(NULL)");
        free(p);

        /* "Every directory in the import graph, in post-order" — one site with
         * no imports is one root, and it is this one. */
        size_t roots = mdy_engine_root_count(e);
        const char *r0 = roots ? mdy_engine_root_at(e, 0) : NULL;
        ok_("root_count is 1 for a site that imports nothing",
            roots == 1, roots == 1 ? "(1)" : "(not 1)");
        ok_("...and root_at(0) is the site itself",
            r0 && strstr(r0, "mdy-api") != NULL, r0 ? r0 : "(NULL)");
        ok_("...and an index past the end is NULL, not a crash",
            mdy_engine_root_at(e, roots + 5) == NULL, "(NULL)");

        mdy_engine_free(e);
        free(root);
    }
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    S = mdy_session_new();
    if (!S) { printf("cannot make a session\n"); return 1; }
    printf("[main]\n");
    printf("--- engine: a document, end to end ---\n");

    check("plain markup", "= Hello\n\ntext", "<h1 id=\"hello\">Hello</h1><p>text</p>");

    check("a `%` line runs, and writes nothing itself",
          "% const x = 1\n= Value {{ x }}",
          "<h1 id=\"value-1\">Value 1</h1>");

    check("a loop encloses the markup under it",
          "% for (const n of [1, 2, 3]) {\n- item {{ n }}\n% }",
          "<ul>\n<li>item 1</li>\n<li>item 2</li>\n<li>item 3</li>\n</ul>");

    check("front matter is data, not content",
          "+++\ntitle: A\n+++\n= Body",
          "<h1 id=\"body\">Body</h1>");

    check("a ```data fence comes out of the body",
          "= Title\n\n```data\nextra: 1\n```\n\ntail",
          "<h1 id=\"title\">Title</h1><p>tail</p>");

    check("an empty document renders to nothing", "", "");

    check("inline markup and a wiki link",
          "//em// and **strong** and [[ Ancient Egypt ]]",
          "<p><em>em</em> and <strong>strong</strong> and "
          "<a href=\"ancient-egypt\">Ancient Egypt</a></p>");

    /* The three characters a template literal cannot hold plainly — `$`, a
     * backtick and a backslash — survive the script layer's escaping. MDY's
     * code marker is a DOUBLE backtick; a single one is text, which is what
     * this checks and what I first got wrong. */
    check("a template literal's own escapes survive",
          "cost: $5 and `tick` and \\\\slash",
          "<p>cost: $5 and `tick` and \\slash</p>");
    check("…and a double backtick is code",
          "and ``tick`` here",
          "<p>and <code>tick</code> here</p>");

    printf("--- engine: several documents in one source ---\n");
    {
        const char *source = "= One\n---\n= Two";
        mdy_engine *e = mdy_engine_new(S);
        char open_err[256];
        mdy_engine_open(e, source, strlen(source), open_err, sizeof open_err);
        int ok = mdy_engine_count(e) == 2;
        printf("  %s  a source holds two documents\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        char err[256];
        char *second = mdy_engine_render(e, 1, err, sizeof err);
        ok = second && strcmp(second, "<h1 id=\"two\">Two</h1>") == 0;
        printf("  %s  …and the second one renders\n", ok ? "ok  " : "FAIL");
        if (!ok) { printf("      actual %s\n", second ? second : err); failures++; }
        free(second);
        mdy_engine_free(e);
    }

    printf("--- engine: the set, queried ---\n");

    /*
     * Every document's DATA goes into nisaba when the set is opened — its
     * front matter merged with its ```data fences, and never its text — and
     * `$.find` runs a real query against it.
     */
    {
        const char *set =
            "% for (const c of $.find({ role: 'city' })) {\n"
            "- {{ c.who }} of {{ c.era }}\n"
            "% }\n"
            "---\n+++\nrole: city\nwho: Uruk\nera: Sumer\n+++\n"
            "---\n+++\nrole: card\nwho: Ignored\n+++\n"
            "---\n+++\nrole: city\nwho: Babylon\nera: Akkad\n+++\n";
        check("a document finds its siblings by query", set,
              "<ul>\n<li>Uruk of Sumer</li>\n<li>Babylon of Akkad</li>\n</ul>");
    }

    check("findOne takes the first hit",
          "= {{ $.findOne({ role: 'city' }).who }}\n"
          "---\n+++\nrole: city\nwho: Uruk\n+++\n"
          "---\n+++\nrole: city\nwho: Babylon\n+++\n",
          "<h1 id=\"uruk\">Uruk</h1>");

    check("…and answers null when nothing matches",
          "= {{ $.findOne({ role: 'nowhere' }) === null ? 'none' : 'some' }}",
          "<h1 id=\"none\">none</h1>");

    check("an empty query finds every document",
          "= {{ $.find({}).length }}\n---\n+++\na: 1\n+++\n---\n+++\nb: 2\n+++\n",
          "<h1 id=\"3\">3</h1>");

    /*
     * Several hits, in the order the documents are written — with paths that
     * sort backwards against them, so a straight index walk would answer
     * three,two,one.
     *
     * BE CLEAR ABOUT WHAT THIS DOES NOT PROVE. It passes with the ordering
     * pass removed, so it does not isolate it: nisaba's ObjectIds are
     * monotonic, so the primary tree already walks in insertion order and an
     * index ties break by `_id`, which is the same order again. I could not
     * construct a case that tells them apart, and a check that cannot fail is
     * worth less than knowing it cannot. The sort stays because mdy-docs sorts
     * — it is defensive about an order neither of us should rely on — and the
     * `_id` to index map earns its place regardless: resolving a hit back to
     * its document is what `$.render({ … })` will need.
     */
    check("several hits come back with their documents, in order",
          "= {{ $.find({ path: { $exists: true } }).map((d) => d.n).join(',') }}\n"
          "---\n+++\npath: c.mdy\nn: one\n+++\n"
          "---\n+++\npath: b.mdy\nn: two\n+++\n"
          "---\n+++\npath: a.mdy\nn: three\n+++\n",
          "<h1 id=\"onetwothree\">one,two,three</h1>");

    check("a ```data fence is queryable too",
          "= {{ $.findOne({ kind: 'note' }).title }}\n"
          "---\ntext\n\n```data\nkind: note\ntitle: Found\n```\n",
          "<h1 id=\"found\">Found</h1>");

    check("a fence overrides the front matter it merges over",
          "= {{ $.findOne({ role: 'r' }).size }}\n"
          "---\n+++\nrole: r\nsize: 4\n+++\nbody\n\n```data\nsize: 9\n```\n",
          "<h1 id=\"9\">9</h1>");

    check("$.data reaches a document by index",
          "= {{ $.data(1).who }}\n---\n+++\nwho: Uruk\n+++\n",
          "<h1 id=\"uruk\">Uruk</h1>");

    check("a number in front matter stays a number",
          "= {{ typeof $.findOne({ n: 42 }).n }}\n---\n+++\nn: 42\n+++\n",
          "<h1 id=\"number\">number</h1>");

    check("the body text is not in the database",
          "= {{ JSON.stringify($.findOne({ role: 'r' })).includes('secret') ? 'leaked' : 'clean' }}\n"
          "---\n+++\nrole: r\n+++\nthe secret body\n",
          "<h1 id=\"clean\">clean</h1>");

    printf("--- engine: composition ---\n");

    /*
     * `$.render` returns a TOKEN, not HTML — a few private-use characters
     * standing for a tree the host parked. The token travels through the
     * document's own code like any other string, and the tree goes back in
     * once the text around it has been parsed. That is why a render needs no
     * indentation argument: the parser already knows which element is open
     * where the token landed.
     */
    check("a render on a line of its own becomes that document",
          "{{ $.render(1) }}\n---\n= Card\n",
          "<h1 id=\"card\">Card</h1>");

    check("…and is not wrapped in a paragraph",
          "before\n\n{{ $.render(1) }}\n\nafter\n---\n= Card\n",
          "<p>before</p><h1 id=\"card\">Card</h1><p>after</p>");

    /* A block cannot sit inside a sentence, so it gives up its wrapper and
     * lends its content instead. */
    check("a render inside a sentence gives up its blocks",
          "say {{ $.render(1) }} now\n---\ninner\n",
          "<p>say inner now</p>");

    check("a render by query",
          "{{ $.render({ role: 'card' }) }}\n---\n+++\nrole: card\n+++\n= Found\n",
          "<h1 id=\"found\">Found</h1>");

    check("a render of a document a find returned",
          "% const c = $.findOne({ role: 'card' })\n{{ $.render(c) }}\n"
          "---\n+++\nrole: card\n+++\n= By reference\n",
          "<h1 id=\"by-reference\">By reference</h1>");

    check("several renders in a loop",
          "% for (const c of $.find({ role: 'city' })) {\n"
          "{{ $.render(c) }}\n"
          "% }\n"
          "---\n+++\nrole: city\n+++\n= Uruk\n"
          "---\n+++\nrole: city\n+++\n= Babylon\n",
          "<h1 id=\"uruk\">Uruk</h1><h1 id=\"babylon\">Babylon</h1>");

    check("a render nested two deep",
          "{{ $.render(1) }}\n---\nouter {{ $.render(2) }}\n---\ninner\n",
          "<p>outer inner</p>");

    /*
     * `$.text` is the text a document's code WROTE, not its tree's text — it
     * is never read as MDY on the way past. So the markup comes back intact
     * and is read by whoever received it, here the heading.
     *
     * This check asserted the opposite until a real site disagreed: a document
     * that writes JSON had `\"` inside a caption turned into `"`, and what
     * came back was no longer JSON. `node bin/mdy.js build` on this same
     * source produces the markup below.
     */
    check("$.text gives what a document wrote, markup and all",
          "= {{ $.text(1) }}\n---\n**bold** and //em//\n",
          "<h1 id=\"bold-and-em\"><strong>bold</strong> and <em>em</em></h1>");

    /*
     * The reason it must not be parsed, and the shape a real site uses: a
     * document writes JSON, and its reader parses it. Read it as MDY on the
     * way past and `\"` inside a string comes back as `"` — no longer JSON,
     * and the failure lands in the caller, far from the cause.
     */
    check("...so JSON a document wrote parses back, escapes intact",
          "% const o = JSON.parse($.text(1))\n= {{ o.q }}\n---\n"
          "{{ JSON.stringify({ q: 'a \"b\" c' }) }}\n",
          "<h1 id=\"a-b-c\">a \"b\" c</h1>");

    check("a token in a transformed document is still composed",
          "%% transform((tree) => {\n"
          "  visit(tree, 'h1', (node) => { node.tagName = 'h2'; });\n"
          "})\n"
          "{{ $.render(1) }}\n---\n= Card\n",
          "<h2 id=\"card\">Card</h2>");

    /* `$.render(target, data)` hands the target its `req`. */
    check("a render passes its data as req",
          "{{ $.render(1, { who: 'Uruk' }) }}\n---\n= {{ req.who }}\n",
          "<h1 id=\"uruk\">Uruk</h1>");

    check("…and the same document answers differently each time",
          "% for (const who of ['Uruk', 'Babylon']) {\n"
          "{{ $.render(1, { who }) }}\n"
          "% }\n---\n= {{ req.who }}\n",
          "<h1 id=\"uruk\">Uruk</h1><h1 id=\"babylon\">Babylon</h1>");

    /*
     * The ENTRY's `req` is not empty: the engine puts `today` on it, because a
     * site compares a post's date against it to decide whether it is published
     * yet. A build adds its own policy beside it (see
     * mdy_engine_set_context_bool); this test renders through the engine
     * directly, so `today` is all there is.
     *
     * This asserted an empty request until a real site disagreed — blog's tag
     * pages dated an entry `undefined`.
     */
    check("the entry's request carries today",
          "= {{ Object.keys(req).join(',') }}", "<h1 id=\"today\">today</h1>");

    refuses("a render that cycles", "{{ $.render(0) }}", "render depth exceeded");

    /*
     * The shape a site actually has: a loop over queried documents, each
     * rendered through a shared layout with its own data, each emitted to its
     * own path — and the layout transforming its own tree on the way.
     */
    {
        last_emit_path[0] = last_emit_content[0] = '\0';
        mdy_engine *e = mdy_engine_new(S);
        mdy_engine_on_emit(e, collect_emit, NULL);
        char err[256];
        const char *source =
            "% for (const c of $.find({ role: 'city' })) {\n"
            "%   $.emit(c.slug + '/index.html', $.render({ role: 'layout' }, { who: c.who }))\n"
            "% }\n"
            "---\n+++\nrole: layout\n+++\n"
            "%% transform((tree) => { visit(tree, 'h1', (n) => { n.properties.className = ['title']; }); })\n"
            "= {{ req.who }}\n"
            "---\n+++\nrole: city\nwho: Uruk\nslug: uruk\n+++\n"
            "---\n+++\nrole: city\nwho: Babylon\nslug: babylon\n+++\n";
        int ok = mdy_engine_open(e, source, strlen(source), err, sizeof err) == 0;
        if (ok) { char *html = mdy_engine_render(e, 0, err, sizeof err); ok = html != NULL; free(html); }
        ok = ok && strcmp(last_emit_path, "babylon/index.html") == 0 &&
             /* `id` then `class`: the parser sets the id, the transform adds
              * the class, and that is the order. Taken from what
              * `node bin/mdy.js build` writes for this exact site. */
             strcmp(last_emit_content, "<h1 id=\"babylon\" class=\"title\">Babylon</h1>") == 0;
        printf("  %s  a query, a shared layout, a transform and an emit each\n", ok ? "ok  " : "FAIL");
        if (!ok) { printf("      last path %s\n      last content %s\n      err %s\n",
                          last_emit_path, last_emit_content, err); failures++; }
        mdy_engine_free(e);
    }

    printf("--- engine: emit ---\n");
    {
        /* A build writes a file, a server holds it, this collects it — mdy
         * has no opinion on what producing an output means. */
        last_emit_path[0] = last_emit_content[0] = '\0';

        mdy_engine *e = mdy_engine_new(S);
        mdy_engine_on_emit(e, collect_emit, NULL);
        char err[256];
        const char *source =
            "% $.emit('index.html', $.render(1))\n"
            "---\n= Page\n";
        if (mdy_engine_open(e, source, strlen(source), err, sizeof err) == 0) {
            char *html = mdy_engine_render(e, 0, err, sizeof err);
            free(html);
        }
        int ok = strcmp(last_emit_path, "index.html") == 0 &&
                 strcmp(last_emit_content, "<h1 id=\"page\">Page</h1>") == 0;
        printf("  %s  a token in emitted content becomes its HTML\n", ok ? "ok  " : "FAIL");
        if (!ok) { printf("      path %s\n      content %s\n", last_emit_path, last_emit_content); failures++; }
        mdy_engine_free(e);
    }

    printf("--- engine: transform, the tree through lamassu and back ---\n");

    /*
     * The one place a document's own code sees its tree. The host parses the
     * lines, hands the tree to the guest as VALUES, the guest changes it, and
     * the host takes it back — no JSON in either direction.
     */
    check("a transform sees the tree and can change it",
          "%% transform((tree) => {\n"
          "  visit(tree, 'h1', (node) => { node.tagName = 'h2'; });\n"
          "})\n"
          "= Title",
          "<h2 id=\"title\">Title</h2>");

    check("…and can set a property",
          "%% transform((tree) => {\n"
          "  visit(tree, 'p', (node) => { node.properties.className = ['lead']; });\n"
          "})\n"
          "text",
          "<p class=\"lead\">text</p>");

    check("…and can read the text through the toolkit",
          "%% transform((tree) => {\n"
          "  visit(tree, 'h1', (node) => { node.properties.id = slug(toText(node)); });\n"
          "})\n"
          "= A Long Title",
          "<h1 id=\"a-long-title\">A Long Title</h1>");

    check("…and can return a new tree",
          "%% transform(() => ({ type: 'element', tagName: 'main', properties: {},\n"
          "  children: [{ type: 'text', value: 'replaced' }] }))\n"
          "= Gone",
          "<main>replaced</main>");

    check("…and can add a node with h()",
          "%% transform((tree) => {\n"
          "  tree.children.push(h('footer.note', 'end'));\n"
          "})\n"
          "text",
          "<p>text</p><footer class=\"note\">end</footer>");

    check("a document with no transform takes the shorter path",
          "= Untouched", "<h1 id=\"untouched\">Untouched</h1>");

    /*
     * ATTRIBUTE ORDER through the round trip: an element written `href class
     * rel title` comes back exactly so after passing through a transform.
     *
     * lamassu keeps string keys in insertion order, as the language
     * requires, so both engines answer with the document's own order. In
     * hash order the tree's properties come back shuffled — `href title
     * class rel` — on both sides, which looks like agreement and is not.
     */
    check("attribute order survives the round trip",
          "%% transform((tree) => {})\n"
          "<a href=\"/x\" class=\"one two\" rel=\"noopener\" title=\"t\">link",
          "<a href=\"/x\" class=\"one two\" rel=\"noopener\" title=\"t\">link</a>");

    refuses("a transform that returns something that is not a node",
            "%% transform(() => 42)\n= x", "transform must return a hast node");

    printf("--- engine: what it refuses, loudly ---\n");
    /* Nothing refuses any more — every native mdy-docs documents is here.
     * What is left to check is that each one says clearly what it wanted. */
    refuses("$.resize wants a file document",
            "{{ $.resize('nope', {}) }}",
            "expected a file document (path/ext, from $.find/$.findOne)");
    refuses("a render of a document that is not there",
            "{{ $.render({ role: 'nowhere' }) }}", "found no such document");
    refuses("code that does not compile", "% const = \n= x", "did not compile");
    refuses("code that throws", "% throw 'nope'\n= x", "nope");
    {
        /* `refuses` always asks for document 0, and `= One` has one — so this
         * one asks for an index that genuinely is not there. */
        mdy_engine *e = mdy_engine_new(S);
        char err[256];
        mdy_engine_open(e, "= One", 5, err, sizeof err);
        char *html = mdy_engine_render(e, 5, err, sizeof err);
        int ok = !html && strstr(err, "no document at index") != NULL;
        printf("  %s  a document index that is not there\n", ok ? "ok  " : "FAIL");
        if (!ok) { printf("      actual %s\n", html ? html : err); failures++; }
        free(html);

        /* …and it gives back the render depth it took on the way in. It did
         * not, so the thirty-third of these exhausted the cycle guard and
         * every render after it failed, in an engine nothing had gone wrong
         * in. */
        for (int i = 0; i < 40; i++) free(mdy_engine_render(e, 5, err, sizeof err));
        char *after = mdy_engine_render(e, 0, err, sizeof err);
        ok = after && strcmp(after, "<h1 id=\"one\">One</h1>") == 0;
        printf("  %s  ...forty times over, and the document that IS there renders\n", ok ? "ok  " : "FAIL");
        if (!ok) { printf("      actual %s\n", after ? after : err); failures++; }
        free(after);
        mdy_engine_free(e);
    }

    site_checks();
    data_file_checks();
    blank_file_checks();
    markdown_render_checks();
    footnote_checks();
    raw_html_checks();
    heading_id_checks();
    alert_checks();
    caret_bracket_checks();
    query_order_checks();
    reopen_checks();
    session_checks();
    memo_key_checks();
    count_checks();
    import_checks();
    api_checks();
#ifndef _WIN32
    unreadable_dir_checks();
#endif
    token_checks();
    url_checks();
    nonfinite_checks();
    big_integer_checks();
    crlf_checks();
    attr_entity_checks();
    record_key_checks();
    wide_buffer_checks();
    deep_value_checks();
#ifndef _WIN32
    odd_name_checks();
#endif
    natives_checks();
    resize_checks();
    bad_image_checks();
    tag_checks();
    gc_checks();
    broker_checks();

    mdy_session_free(S);

    if (failures) { printf("\n%d failed\n", failures); return 1; }
    printf("\nall checks passed\n");
    return 0;
}
