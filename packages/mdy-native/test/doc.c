/*
 * The document splitter: a source into documents on `---`, several sources
 * into one list, and the front matter off the top of one document. These are
 * the rules the engine's directory walk counts on — a source that is empty is
 * ONE document, not none — and the CRLF reading mdy-docs has.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mdydoc.h"

static int failures = 0;

static void ok_(const char *what, int ok, const char *actual) {
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) { printf("      actual   %s\n", actual ? actual : "(nothing)"); failures++; }
}

/* Every document, joined with `|`, with `\n` written as `\n` so a line ending
 * inside one can be read in a failure. */
static char *joined(const mdy_documents *docs) {
    static char out[4096];
    size_t o = 0;
    for (size_t i = 0; i < mdy_documents_count(docs) && o + 4 < sizeof out; i++) {
        mdy_chunk c = mdy_documents_at(docs, i);
        if (i) out[o++] = '|';
        for (size_t k = 0; k < c.len && o + 3 < sizeof out; k++) {
            if (c.text[k] == '\n') { out[o++] = '\\'; out[o++] = 'n'; }
            else out[o++] = c.text[k];
        }
    }
    out[o] = '\0';
    return out;
}

static void split(const char *what, const char *source, const char *expected) {
    mdy_documents *docs = mdy_split_documents(source, strlen(source));
    char *got = joined(docs);
    ok_(what, strcmp(got, expected) == 0, got);
    mdy_documents_free(docs);
}

int main(void) {
    printf("--- mdydoc: one source into documents ---\n");
    split("a `---` line starts the next document", "one\n---\ntwo", "one|two");
    split("...with trailing whitespace on the marker", "one\n---  \ntwo", "one|two");
    split("...but four dashes are content", "one\n----\ntwo", "one\\n----\\ntwo");
    split("...and so is an indented one", "one\n ---\ntwo", "one\\n ---\\ntwo");
    split("a leading marker opens the first document", "---\none", "one");
    split("a chunk of only whitespace is dropped", "one\n---\n  \n---\ntwo", "one|two");
    split("when nothing survives, the source is ONE empty document", "---\n\n---\n", "");
    split("an empty source is one empty document too", "", "");
    /* A CRLF file gets an extra empty line per line: mdy-docs splits on `\n`,
     * the template literal turns the `\r` into a newline, and the output is
     * split again. Matching that is deliberate. */
    split("a CRLF line ending is a newline and an empty line", "crlf line\r\nsecond\r\n",
          "crlf line\\n\\nsecond\\n\\n");
    split("...and a bare CR is not an ending at all", "a\rb", "a\rb");

    printf("--- mdydoc: several sources into one list ---\n");
    {
        mdy_chunk sources[3] = { { "one\n---\ntwo", 11 }, { "", 0 }, { "   \n", 4 } };
        size_t per[3] = { 0, 0, 0 };
        mdy_documents *docs = mdy_split_sources(sources, 3, per);
        char *got = joined(docs);
        ok_("each source is split on its own and the documents follow in order",
            strcmp(got, "one|two||") == 0, got);
        char counts[32];
        snprintf(counts, sizeof counts, "%zu,%zu,%zu", per[0], per[1], per[2]);
        ok_("...and per_source counts one for a source that is empty or all whitespace",
            per[0] == 2 && per[1] == 1 && per[2] == 1, counts);
        mdy_documents_free(docs);
    }

    printf("--- mdydoc: the front matter off the top ---\n");
    {
        mdy_chunk matter, body;
        const char *t1 = "+++\na: 1\n+++\nbody\n";
        mdy_split_frontmatter(t1, strlen(t1), &matter, &body);
        char got[64];
        snprintf(got, sizeof got, "matter %zu bytes, body %zu bytes", matter.len, body.len);
        ok_("a closed block is the matter and the rest is the body",
            matter.len >= 4 && memcmp(matter.text, "a: 1", 4) == 0 && body.len >= 4 && memcmp(body.text, "body", 4) == 0,
            got);
        const char *t2 = "\n\n+++\na: 1\n+++\nbody";
        mdy_split_frontmatter(t2, strlen(t2), &matter, &body);
        ok_("...blank lines above it are allowed",
            matter.len >= 4 && memcmp(matter.text, "a: 1", 4) == 0 && body.len == 4 && memcmp(body.text, "body", 4) == 0, body.text);
        const char *t3 = "+++\na: 1\nbody";
        mdy_split_frontmatter(t3, strlen(t3), &matter, &body);
        ok_("an unclosed opener is prose, not a block", matter.len == 0 && body.len == strlen(t3), body.text);
        const char *t4 = "text\n+++\na: 1\n+++\n";
        mdy_split_frontmatter(t4, strlen(t4), &matter, &body);
        ok_("...and a block not at the top is prose too", matter.len == 0 && body.len == strlen(t4), body.text);
    }

    if (failures) { printf("\n%d check%s failed\n", failures, failures == 1 ? "" : "s"); return 1; }
    printf("\nall checks passed\n");
    return 0;
}
