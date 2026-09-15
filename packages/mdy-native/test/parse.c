/*
 * The checks that do not need node — enough to know the library is not broken
 * before test/compare.mjs asks the harder question, which is whether it agrees
 * with the JavaScript.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mdyast.h"
#include "mdyhtml.h"
#include "mdymarkdown.h"
#include "internal.h"

static int failures = 0;

static void check(const char *what, const char *source, const char *expected, const mdy_options *o) {
    mdy_doc *doc = mdy_parse(source, 0, o);
    /* Structure alone: these check what the tree IS, and threading a position
     * through every expectation would bury that. Positions have checks of
     * their own below. */
    char *json = mdy_to_json_bare(mdy_root(doc));
    int ok = json && strcmp(json, expected) == 0;
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        printf("      expected %s\n      actual   %s\n", expected, json ? json : "(null)");
        failures++;
    }
    free(json);
    mdy_free(doc);
}

/* The warnings a source raises, as `line:col-line:col: reason` lines joined
 * with `|` — the shape a vfile message prints in, and just the reason when
 * there is no place. */
static void check_messages(const char *what, const char *source,
                           const char *expected, const mdy_options *o) {
    mdy_doc *doc = mdy_parse(source, 0, o);
    char got[1024];
    size_t n = 0;
    got[0] = '\0';
    for (size_t i = 0; i < mdy_message_count(doc); i++) {
        const mdy_message *m = mdy_message_at(doc, i);
        if (n) n += (size_t)snprintf(got + n, sizeof got - n, "|");
        if (m->line) {
            n += (size_t)snprintf(got + n, sizeof got - n, "%u:%u-%u:%u: %s",
                                  m->line, m->column, m->end_line, m->end_column, m->reason);
        } else {
            n += (size_t)snprintf(got + n, sizeof got - n, "%s", m->reason);
        }
    }
    int ok = strcmp(got, expected) == 0;
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        printf("      expected %s\n      actual   %s\n", expected, got);
        failures++;
    }
    mdy_free(doc);
}

/* One document's front matter SOURCE, or `(none)`, per document, joined with
 * `|` — the block is found here and read by whoever embeds this. */
static void check_matter(const char *what, const char *source,
                         const char *expected, const mdy_options *o) {
    mdy_doc *doc = mdy_parse(source, 0, o);
    char got[1024];
    size_t n = 0;
    got[0] = '\0';
    for (size_t i = 0; i < mdy_frontmatter_count(doc); i++) {
        const mdy_frontmatter *m = mdy_frontmatter_at(doc, i);
        if (n) n += (size_t)snprintf(got + n, sizeof got - n, "|");
        if (m->source) {
            n += (size_t)snprintf(got + n, sizeof got - n, "%u-%u:%.*s",
                                  m->open_line, m->close_line, (int)m->source_len, m->source);
        } else {
            n += (size_t)snprintf(got + n, sizeof got - n, "(none)");
        }
    }
    int ok = strcmp(got, expected) == 0;
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) { printf("      expected %s\n      actual   %s\n", expected, got); failures++; }
    mdy_free(doc);
}

/* What a document says it refers to, as `kind:name` per entry. */
static void check_refs(const char *what, const char *source,
                       const char *expected, const mdy_options *o) {
    static const char *const KIND[] = { "tag", "mention", "link" };
    mdy_doc *doc = mdy_parse(source, 0, o);
    char got[1024];
    size_t n = 0;
    got[0] = '\0';
    for (size_t i = 0; i < mdy_reference_count(doc); i++) {
        const mdy_reference *r = mdy_reference_at(doc, i);
        n += (size_t)snprintf(got + n, sizeof got - n, "%s%u:%s:%.*s", n ? "|" : "",
                              r->document, KIND[r->kind], (int)r->name_len, r->name);
    }
    int ok = strcmp(got, expected) == 0;
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) { printf("      expected %s\n      actual   %s\n", expected, got); failures++; }
    mdy_free(doc);
}

#define EL(tag, props, kids) "{\"type\":\"element\",\"tagName\":\"" tag "\",\"properties\":{" props "},\"children\":[" kids "]}"
#define TX(v) "{\"type\":\"text\",\"value\":\"" v "\"}"
#define ROOT(kids) "{\"type\":\"root\",\"children\":[" kids "]}"

/* The `id` of every `tag` element in the tree, in document order, joined with
 * `,` into `out`. For documents too large to spell out as a tree. */
static void ids_of(const mdy_node *n, const char *tag, char *out, size_t cap, size_t *len) {
    if (n->type == MDY_ELEMENT && strcmp(n->tag, tag) == 0) {
        for (const mdy_prop *p = n->props; p; p = p->next) {
            if (strcmp(p->name, "id") != 0 || p->type != MDY_PROP_STRING) continue;
            int w = snprintf(out + *len, cap - *len, "%s%s", *len ? "," : "", p->as.string);
            if (w > 0) *len = *len + (size_t)w < cap ? *len + (size_t)w : cap - 1;
        }
    }
    for (const mdy_node *c = n->first; c; c = c->next) ids_of(c, tag, out, cap, len);
}

static void ok_(const char *what, int ok, const char *actual) {
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) { printf("      actual   %s\n", actual ? actual : "(nothing)"); failures++; }
}

/*
 * Names past the size a fixed table would hold. The intern table grows, and a
 * name must come back as the same pointer however many names came after it.
 */
static void intern_checks(void) {
    printf("--- mdyast: interning, at size ---\n");
    enum { N = 50000 };
    mdy_arena arena = { 0 };
    mdy_intern_table table = { 0 };
    const char **first = malloc(N * sizeof *first);
    char name[32];
    int same = 1, distinct = 1, found = 1;
    for (int i = 0; i < N; i++) {
        int len = snprintf(name, sizeof name, "name-%d", i);
        first[i] = mdy_intern(&arena, &table, name, (size_t)len);
    }
    for (int i = 0; i < N; i++) {
        int len = snprintf(name, sizeof name, "name-%d", i);
        if (mdy_intern(&arena, &table, name, (size_t)len) != first[i]) same = 0;
        if (mdy_intern_lookup(&table, name, (size_t)len) != first[i]) found = 0;
        if (i && first[i] == first[i - 1]) distinct = 0;
    }
    size_t before = table.count;
    const char *miss = mdy_intern_lookup(&table, "never-interned", 14);
    ok_("fifty thousand names each come back as the pointer they were first given", same, NULL);
    ok_("…and two different names never share one", distinct, NULL);
    ok_("a lookup finds every interned name", found, NULL);
    ok_("a lookup of a name never interned finds nothing and adds nothing",
        miss == NULL && table.count == before, NULL);
    /* The empty name, and names equal up to a NUL, are names like any other. */
    const char *empty = mdy_intern(&arena, &table, "", 0);
    const char *nul = mdy_intern(&arena, &table, "a\0b", 3);
    ok_("the empty name and a name holding a NUL are distinct entries",
        empty && nul && empty != nul && nul != mdy_intern(&arena, &table, "a", 1) &&
        mdy_intern_lookup(&table, "a\0b", 3) == nul, NULL);
    free(first);
    mdy_arena_free(&arena);
}

/*
 * Footnotes and headings in the numbers where the lookups stop being scans:
 * past the index threshold, past the first sizes of the order and intern
 * tables. What must not change at size is what the small cases show.
 */
static void footnote_scale_checks(const mdy_options *o) {
    printf("--- mdyast: footnotes and headings, at size ---\n");
    enum { NOTES = 40 };
    char *src = malloc(8192);
    size_t n = 0;
    /* Referenced in reverse definition order, so the numbering is not the
     * order notes[] holds them in; plus references nothing defines. */
    for (int i = NOTES - 1; i >= 0; i--) n += (size_t)sprintf(src + n, "x [[^n%d]] [[^miss%d]] ", i, i);
    n += (size_t)sprintf(src + n, "\n\n");
    for (int i = 0; i < NOTES; i++)
        n += (size_t)sprintf(src + n, "[[^n%d]]: note %d%s\n", i, i, i == 0 ? " see [[^late]]" : "");
    /* Referenced only from inside another note, so it is numbered while the
     * section is being written, and goes after every note numbered before. */
    sprintf(src + n, "[[^late]]: late\n");

    mdy_doc *doc = mdy_parse(src, 0, o);
    char got[4096] = "", want[4096] = "";
    size_t gl = 0, wl = 0;
    ids_of(mdy_root(doc), "li", got, sizeof got, &gl);
    for (int i = NOTES - 1; i >= 0; i--)
        wl += (size_t)snprintf(want + wl, sizeof want - wl, "%suser-content-fn-n%d", wl ? "," : "", i);
    snprintf(want + wl, sizeof want - wl, ",user-content-fn-late");
    ok_("forty notes are listed in the order they were first referenced", strcmp(got, want) == 0, got);
    char *json = mdy_to_json_bare(mdy_root(doc));
    ok_("…and a reference nothing defines stays text", json && strstr(json, "[[^miss0]]") != NULL, NULL);
    free(json);
    mdy_free(doc);

    /* An anchor and the link back to it are built the same way, so a long
     * id makes a long anchor and an equally long link, never a shorter one. */
    {
        char id[241];
        memset(id, 'A', 240);
        id[240] = '\0';
        char text[1024];
        snprintf(text, sizeof text, "x [[^%s]] and [[^%s]]\n\n[[^%s]]: note\n", id, id, id);
        mdy_doc *d = mdy_parse(text, 0, o);
        char *html = mdy_to_html(mdy_root(d), NULL);
        char want_id[300], want_href[300];
        snprintf(want_id, sizeof want_id, "id=\"user-content-fnref-%s-2\"", id);
        snprintf(want_href, sizeof want_href, "href=\"#user-content-fnref-%s-2\"", id);
        ok_("a back-reference to a long footnote id points at the whole anchor",
            html && strstr(html, want_id) && strstr(html, want_href), html);
        free(html);
        mdy_free(d);
    }

    /* Three hundred distinct headings, then a repeat of the first. */
    n = 0;
    char *heads = malloc(300 * 24 + 64);
    n += (size_t)sprintf(heads + n, "= Same\n\n");
    for (int i = 0; i < 300; i++) n += (size_t)sprintf(heads + n, "= Head %d\n\n", i);
    sprintf(heads + n, "= Same\n");
    doc = mdy_parse(heads, 0, o);
    char hid[16384] = "";
    size_t hl = 0;
    ids_of(mdy_root(doc), "h1", hid, sizeof hid, &hl);
    const char *tail = hl >= 7 ? hid + hl - 7 : "";
    ok_("the three hundred and second heading repeats the first and is told apart",
        strncmp(hid, "same,head-0,", 12) == 0 && strcmp(tail, ",same-1") == 0 &&
        strstr(hid, ",head-299,") != NULL, hid);
    mdy_free(doc);
    free(heads);
    free(src);
}

/*
 * Raw HTML through the .md front end: what hastscript makes of an attribute
 * value, and how deep a raw fragment may go.
 */
static void markdown_raw_checks(void) {
    printf("--- markdown: raw attributes, as hastscript reads them ---\n");
    {
        const char *why = NULL;
        mdy_doc *d = mdy_markdown_parse(
            "<table><tr><td colspan=\"0.123456789\" rowspan=\"infinity\">a</td>"
            "<td colspan=\"0x10\" rowspan=\"1e400\">b</td>"
            "<td colspan=\" 7 \" rowspan=\"nan\">c</td></tr></table>\n\n<p class=\"\">x</p>\n", 0, &why);
        char *json = d ? mdy_to_json_bare(mdy_root(d)) : NULL;
        char *html = d ? mdy_to_html(mdy_root(d), NULL) : NULL;
        ok_("Number() of a value: a decimal as it is, hex read, `infinity` and `nan` kept as text",
            json && strstr(json, "\"colSpan\":0.123456789,\"rowSpan\":\"infinity\"") &&
            strstr(json, "\"colSpan\":16,\"rowSpan\":null") &&
            strstr(json, "\"colSpan\":7,\"rowSpan\":\"nan\""), json);
        ok_("…and the HTML writes what String() writes of each",
            html && strstr(html, "colspan=\"0.123456789\" rowspan=\"infinity\"") &&
            strstr(html, "colspan=\"16\" rowspan=\"Infinity\"") &&
            strstr(html, "colspan=\"7\" rowspan=\"nan\""), html);
        ok_("an empty class attribute is an empty list",
            json && strstr(json, "\"className\":[]") != NULL, json);
        free(json); free(html); mdy_free(d);
    }
    {
        char *deep = malloc(300 * 3 + 16);
        size_t n = 0;
        for (int i = 0; i < 300; i++) n += (size_t)sprintf(deep + n, "<b>");
        sprintf(deep + n, "x\n");
        const char *why = NULL;
        mdy_doc *d = mdy_markdown_parse(deep, 0, &why);
        ok_("raw HTML past the depth limit is dropped with one warning, not silently",
            d && mdy_message_count(d) == 1 &&
            strcmp(mdy_message_at(d, 0)->rule, "nesting-depth") == 0,
            d ? "a different message count" : why);
        mdy_free(d);
        free(deep);
    }
}

int main(void) {
    mdy_options o;
    mdy_options_default(&o);

    printf("--- mdyast: the tree ---\n");
    check("a paragraph", "hello world", ROOT(EL("p", "", TX("hello world"))), &o);
    check("blank lines separate blocks", "one\n\ntwo",
          ROOT(EL("p", "", TX("one")) "," EL("p", "", TX("two"))), &o);
    check("adjacent lines join with a space", "one\ntwo",
          ROOT(EL("p", "", TX("one two"))), &o);
    check("a heading, with its slug", "= Title",
          ROOT(EL("h1", "\"id\":\"title\"", TX("Title"))), &o);
    check("one = per level", "=== Deep",
          ROOT(EL("h3", "\"id\":\"deep\"", TX("Deep"))), &o);
    check("trailing = are decoration", "== Title ==",
          ROOT(EL("h2", "\"id\":\"title\"", TX("Title"))), &o);
    check("a thematic break", "***", ROOT(EL("hr", "", "")), &o);

    printf("--- mdyast: inline is toggling, not nesting ---\n");
    check("a single * is literal", "a *b* c", ROOT(EL("p", "", TX("a *b* c"))), &o);
    check("** toggles strong", "a **b** c",
          ROOT(EL("p", "", TX("a ") "," EL("strong", "", TX("b")) "," TX(" c"))), &o);
    check("// toggles em", "a //b// c",
          ROOT(EL("p", "", TX("a ") "," EL("em", "", TX("b")) "," TX(" c"))), &o);
    /* An unclosed marker still opens, and runs to the end of the input. This
     * expectation was written the other way round first, on intuition rather
     * than by asking the JavaScript — and it passed, because the C had the
     * same wrong idea. */
    check("an unclosed marker still opens", "a ** b",
          ROOT(EL("p", "", TX("a ") "," EL("strong", "", TX(" b")))), &o);
    check("a backslash escapes", "a \\*\\*b\\*\\* c",
          ROOT(EL("p", "", TX("a **b** c"))), &o);
    check("`` is raw — nothing inside is markup", "a ``**b**`` c",
          ROOT(EL("p", "", TX("a ") "," EL("code", "", TX("**b**")) "," TX(" c"))), &o);

    printf("--- mdyast: lists ---\n");
    check("a bullet list, newlines and all", "- a\n- b",
          ROOT(EL("ul", "", TX("\\n") "," EL("li", "", TX("a")) "," TX("\\n") ","
                              EL("li", "", TX("b")) "," TX("\\n"))), &o);
    check("an ordered list", "1. a",
          ROOT(EL("ol", "", TX("\\n") "," EL("li", "", TX("a")) "," TX("\\n"))), &o);
    /* Every line after an item belongs to it, at any indentation, until a
     * heading, a break, or a blank line before something that is not an
     * item: an item holds text and nested lists and nothing else. */
    check("an indented element line is an item's text, not a block",
          "- a\n  <b>bold\n",
          ROOT(EL("ul", "", TX("\\n") "," EL("li", "", TX("a <b>bold")) "," TX("\\n"))), &o);
    check("an unindented line continues the item too", "- one\ntwo\n- three",
          ROOT(EL("ul", "", TX("\\n") "," EL("li", "", TX("one two")) "," TX("\\n") ","
                              EL("li", "", TX("three")) "," TX("\\n"))), &o);
    check("a heading line ends the list", "- a\n  = Head\n",
          ROOT(EL("ul", "", TX("\\n") "," EL("li", "", TX("a")) "," TX("\\n")) ","
               EL("div", "", TX("\\n") "," EL("h1", "\"id\":\"head\"", TX("Head")) "," TX("\\n"))), &o);
    /* One blank line makes the whole run loose, nested lists included. */
    check("looseness is decided once for the whole run", "- a\n  - b\n\n- c\n",
          ROOT(EL("ul", "", TX("\\n") ","
                   EL("li", "", TX("\\n") "," EL("p", "", TX("a")) "," TX("\\n") ","
                       EL("ul", "", TX("\\n") "," EL("li", "", TX("\\n") "," EL("p", "", TX("b")) "," TX("\\n")) "," TX("\\n")) ","
                       TX("\\n")) ","
                   TX("\\n") ","
                   EL("li", "", TX("\\n") "," EL("p", "", TX("c")) "," TX("\\n")) "," TX("\\n"))), &o);
    check("...and reaches a sibling list of the other kind", "- a\n\n1. b\n",
          ROOT(EL("ul", "", TX("\\n") "," EL("li", "", TX("\\n") "," EL("p", "", TX("a")) "," TX("\\n")) "," TX("\\n")) ","
               EL("ol", "", TX("\\n") "," EL("li", "", TX("\\n") "," EL("p", "", TX("b")) "," TX("\\n")) "," TX("\\n"))), &o);
    check("a shallower marker closes back out to its own column", "- a\n    - b\n  - c\n",
          ROOT(EL("ul", "", TX("\\n") ","
                   EL("li", "", TX("a") "," TX("\\n") ","
                       EL("ul", "", TX("\\n") "," EL("li", "", TX("b")) "," TX("\\n")) "," TX("\\n") "," TX("\\n") ","
                       EL("ul", "", TX("\\n") "," EL("li", "", TX("c")) "," TX("\\n")) "," TX("\\n")) ","
                   TX("\\n"))), &o);
    check("ten digits is not a marker", "1234567890. x",
          ROOT(EL("p", "", TX("1234567890. x"))), &o);

    printf("--- mdyast: autolink ---\n");
    check("a bare URL becomes a link", "go to https://example.com now",
          ROOT(EL("p", "", TX("go to ") ","
                  EL("a", "\"href\":\"https://example.com\"", TX("https://example.com")) ","
                  TX(" now"))), &o);
    check("a trailing full stop is not part of it", "see https://example.com.",
          ROOT(EL("p", "", TX("see ") ","
                  EL("a", "\"href\":\"https://example.com\"", TX("https://example.com")) ","
                  TX("."))), &o);

    printf("--- mdyast: front matter and documents ---\n");
    check("front matter is not content", "+++\ntitle: x\n+++\nbody",
          ROOT(EL("p", "", TX("body"))), &o);
    o.documents = 1;
    /* An element container separates its block children with newline text
     * nodes; the root does not. See `separate` in src/block.c. */
    check("--- starts a new article", "one\n---\ntwo",
          ROOT(EL("article", "", TX("\\n") "," EL("p", "", TX("one")) "," TX("\\n")) ","
               EL("article", "", TX("\\n") "," EL("p", "", TX("two")) "," TX("\\n"))), &o);
    o.documents = 0;

    /*
     * Front matter comes off BEFORE comments do, and the order is observable:
     * a `#` above the fence stops the fence being the top of the document, so
     * there is no front matter at all. Stripping first floats the fence up and
     * invents some.
     */
    {
        mdy_options fm = o;
        fm.frontmatter = 1;
        check("a comment above the fence is not front matter",
              "# a comment above\n+++\ntitle: A\n+++\nbody",
              ROOT(EL("p", "", TX("+++ title: A +++ body"))), &fm);
        check("…and a # inside the block belongs to the YAML",
              "+++\ntitle: A\n# a yaml comment\n+++\nbody",
              ROOT(EL("p", "", TX("body"))), &fm);
    }

    printf("--- mdyast: fences ---\n");
    check("a fence keeps its content verbatim", "```js\nlet x = 1\n```",
          ROOT(EL("pre", "", EL("code", "\"className\":[\"language-js\"]", TX("let x = 1\\n")))), &o);

    printf("--- mdyast: tables ---\n");
    check("a pipe table", "a | b\n--- | ---\n1 | 2",
          ROOT(EL("table", "",
                  TX("\\n") ","
                  EL("thead", "", TX("\\n") ","
                     EL("tr", "", TX("\\n") "," EL("th", "", TX("a")) ","
                        TX("\\n") "," EL("th", "", TX("b")) "," TX("\\n")) ","
                     TX("\\n")) ","
                  TX("\\n") ","
                  EL("tbody", "", TX("\\n") ","
                     EL("tr", "", TX("\\n") "," EL("td", "", TX("1")) ","
                        TX("\\n") "," EL("td", "", TX("2")) "," TX("\\n")) ","
                     TX("\\n")) ","
                  TX("\\n"))), &o);
    /* A table needs a pipe: `a\\n:-:\\n1` is a paragraph, and `:-:` in it is an
     * emoticon. Written the other way round first, on the assumption that one
     * column is a degenerate table — it is not. */
    check("alignment is a style attribute", "a | b\n:-: | --:\n1 | 2",
          ROOT(EL("table", "",
                  TX("\\n") ","
                  EL("thead", "", TX("\\n") ","
                     EL("tr", "", TX("\\n") ","
                        EL("th", "\"style\":\"text-align: center\"", TX("a")) "," TX("\\n") ","
                        EL("th", "\"style\":\"text-align: right\"", TX("b")) "," TX("\\n")) ","
                     TX("\\n")) ","
                  TX("\\n") ","
                  EL("tbody", "", TX("\\n") ","
                     EL("tr", "", TX("\\n") ","
                        EL("td", "\"style\":\"text-align: center\"", TX("1")) "," TX("\\n") ","
                        EL("td", "\"style\":\"text-align: right\"", TX("2")) "," TX("\\n")) ","
                     TX("\\n")) ","
                  TX("\\n"))), &o);

    printf("--- mdyast: typography and references ---\n");
    check("-- is an em dash", "a -- b", ROOT(EL("p", "", TX("a — b"))), &o);
    check("--- is not", "a---b", ROOT(EL("p", "", TX("a---b"))), &o);
    check("... is an ellipsis", "x...y", ROOT(EL("p", "", TX("x…y"))), &o);
    check("--> is an arrow", "a --> b", ROOT(EL("p", "", TX("a → b"))), &o);
    /* A tag keeps its case, unlike almost everything else that becomes a URL. */
    check("#tag keeps its case", "see #Tag-One",
          ROOT(EL("p", "", TX("see ") ","
                  EL("a", "\"href\":\"/tags/Tag-One\"", TX("#Tag-One")))), &o);
    check("@mention", "ask @dan",
          ROOT(EL("p", "", TX("ask ") ","
                  EL("a", "\"href\":\"/users/dan\"", TX("@dan")))), &o);

    printf("--- mdyast: footnotes ---\n");
    check("a reference with no definition stays text", "body [[ ^7 ]] end",
          ROOT(EL("p", "", TX("body [[ ^7 ]] end"))), &o);
    check("an unreferenced definition produces nothing", "body\n\n[[ ^9 ]]: never used",
          ROOT(EL("p", "", TX("body"))), &o);
    footnote_scale_checks(&o);
    intern_checks();
    markdown_raw_checks();

    printf("--- mdyast: wiki links ---\n");
    /* defaultResolve DELETES what it cannot keep; slugify would hyphenate it.
     * `Umm el-Qa'ab` is umm-el-qaab, not umm-el-qa-ab. */
    check("a bare label resolves to its own slug", "[[ Umm el-Qa\'ab ]]",
          ROOT(EL("p", "", EL("a", "\"href\":\"umm-el-qaab\"", TX("Umm el-Qa\'ab")))), &o);
    check("…keeping a full stop", "[[ Edward R. Ayrton ]]",
          ROOT(EL("p", "", EL("a", "\"href\":\"edward-r.-ayrton\"", TX("Edward R. Ayrton")))), &o);
    check("an explicit target is used verbatim", "[[ label | /url ]]",
          ROOT(EL("p", "", EL("a", "\"href\":\"/url\"", TX("label")))), &o);

    printf("--- mdyast: the element syntax ---\n");
    /* Space after the `<` means nothing, which a real layout relies on:
     * `< html lang="en"` with the tag indented for reading. Unsanitised,
     * because <html> is not on the allowlist — with sanitising on, both this
     * and the JavaScript produce nothing at all. */
    {
        mdy_options raw = o;
        raw.sanitize = 0;
        check("space after < is nothing", "< html lang=\"en\"",
              ROOT(EL("html", "\"lang\":\"en\"", "")), &raw);
        check("…and <html> is not on the allowlist", "< html lang=\"en\"", ROOT(""), &o);
    }
    check("a bare < is a div", "<\n  inside",
          ROOT(EL("div", "", TX("\\n") "," EL("p", "", TX("inside")) "," TX("\\n"))), &o);
    check("attributes become hast properties", "<img src=\"a.jpg\" height=\"10\"",
          ROOT(EL("img", "\"src\":\"a.jpg\",\"height\":\"10\"", "")), &o);
    /* scope is allowed on th and not on td — sanitisation is not optional. */
    check("a disallowed attribute is dropped", "<td scope=\"col\" colspan=\"2\"",
          ROOT(EL("td", "\"colSpan\":\"2\"", "")), &o);
    check("a closing > makes the rest inline content", "<figcaption>caption text",
          ROOT(EL("figcaption", "", TX("caption text"))), &o);

    printf("--- mdyast: block structure ---\n");
    /* Indentation is structural: a line further in than its run is a block of
     * its own. It applies at the start of a document too. */
    check("an indented line gets a div", "top\n  in",
          ROOT(EL("p", "", TX("top")) ","
               EL("div", "", TX("\\n") "," EL("p", "", TX("in")) "," TX("\\n"))), &o);
    check("…including the first line", "  only indented",
          ROOT(EL("div", "", TX("\\n") "," EL("p", "", TX("only indented")) "," TX("\\n"))), &o);
    check("a list item absorbs its continuation", "- one\n  two",
          ROOT(EL("ul", "", TX("\\n") "," EL("li", "", TX("one two")) "," TX("\\n"))), &o);
    check("a deeper marker nests a list", "- a\n  - b",
          ROOT(EL("ul", "", TX("\\n") ","
                  EL("li", "", TX("a") "," TX("\\n") ","
                     EL("ul", "", TX("\\n") "," EL("li", "", TX("b")) "," TX("\\n")) ","
                     TX("\\n")) ","
                  TX("\\n"))), &o);

    printf("--- mdyast: setext underlining ---\n");
    check("= underlines to h1", "Title\n=====",
          ROOT(EL("h1", "\"id\":\"title\"", TX("Title"))), &o);
    /* FOUR or more hyphens. Three is a thematic break, and the paragraph above
     * it stands on its own. */
    check("four - underline to h2", "Title\n----",
          ROOT(EL("h2", "\"id\":\"title\"", TX("Title"))), &o);
    check("three - is a break, not an underline", "Title\n---",
          ROOT(EL("p", "", TX("Title")) "," EL("hr", "", "")), &o);

    printf("--- mdyast: task lists ---\n");
    check("a task list", "- [ ] todo\n- [x] done",
          ROOT(EL("ul", "\"className\":[\"contains-task-list\"]", TX("\\n") ","
                  EL("li", "\"className\":[\"task-list-item\"]",
                     EL("input", "\"type\":\"checkbox\",\"checked\":false,\"disabled\":true", "") ","
                     TX(" ") "," TX("todo")) "," TX("\\n") ","
                  EL("li", "\"className\":[\"task-list-item\"]",
                     EL("input", "\"type\":\"checkbox\",\"checked\":true,\"disabled\":true", "") ","
                     TX(" ") "," TX("done")) "," TX("\\n"))), &o);

    printf("--- mdyast: heading ids are unique ---\n");
    check("a repeated heading gets a suffix", "= Same\n\n= Same",
          ROOT(EL("h1", "\"id\":\"same\"", TX("Same")) ","
               EL("h1", "\"id\":\"same-1\"", TX("Same"))), &o);

    printf("--- mdyast: unicode ---\n");
    /* An astral character is ONE code point and TWO UTF-16 units. The corpus
     * has 1,351 of them, all cuneiform, so this is the case to get right. */
    {
        const char *sign = "\xf0\x92\x80\x80";          /* U+12000 CUNEIFORM SIGN A */
        uint32_t cp = 0;
        size_t width = mdy_utf8_decode(sign, 4, &cp);
        int ok = width == 4 && cp == 0x12000;
        printf("  %s  a cuneiform sign decodes to one code point\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        uint16_t units[8];
        size_t n = mdy_to_utf16(sign, 4, units, 8);
        ok = n == 2 && units[0] == 0xD808 && units[1] == 0xDC00;
        printf("  %s  …and to a surrogate PAIR in UTF-16\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        ok = mdy_utf16_length(sign, 4) == 2;
        printf("  %s  …so its JavaScript length is 2, not 1\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        char back[8];
        size_t b = mdy_from_utf16(units, n, back, 8);
        ok = b == 4 && memcmp(back, sign, 4) == 0;
        printf("  %s  …and round trips back to the same bytes\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        /* An unpaired surrogate cannot be encoded; U+FFFD rather than a
         * refusal, since the character is already lost. */
        uint16_t lone[1] = { 0xD808 };
        b = mdy_from_utf16(lone, 1, back, 8);
        ok = b == 3 && (unsigned char)back[0] == 0xEF;
        printf("  %s  an unpaired surrogate becomes U+FFFD\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        /* Ill-formed input must not shift everything after it. */
        uint32_t bad = 0;
        ok = mdy_utf8_decode("\xC3", 1, &bad) == 1 && bad == 0xFFFD;
        printf("  %s  a truncated sequence is one byte and U+FFFD\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        /* An overlong form is ill-formed: C0 80 is not U+0000. */
        ok = mdy_utf8_decode("\xC0\x80", 2, &bad) == 1 && bad == 0xFFFD;
        printf("  %s  an overlong form is rejected\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        ok = mdy_lower_cp(0x0143) == 0x0144 && mdy_lower_cp(0x1E2A) == 0x1E2B &&
             mdy_lower_cp(0x00C9) == 0x00E9;
        printf("  %s  case mapping is the real table, not a guess (Ń Ḫ É)\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        ok = mdy_is_letter_or_number_cp(0x12000) && !mdy_is_letter_or_number_cp(0x2013) &&
             mdy_is_letter_or_number_cp(0x0661);
        printf("  %s  \\p{L} and \\p{N} are the real tables (cuneiform yes, en dash no)\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        /* Invalid bytes in the middle of a document must not derail the rest
         * of it: one byte consumed, one replacement character, everything
         * after it still at the right offset. */
        ok = mdy_utf8_decode("\xED\xA0\x80", 3, &bad) == 1 && bad == 0xFFFD;
        printf("  %s  a surrogate encoded as UTF-8 is rejected\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        ok = mdy_utf8_decode("\xF5\x80\x80\x80", 4, &bad) == 1 && bad == 0xFFFD;
        printf("  %s  a code point above U+10FFFF is rejected\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;
    }

    /* Astral characters must survive the parse and the JSON, unmangled. */
    check("cuneiform survives a paragraph", "sign \xf0\x92\x80\x80 here",
          ROOT(EL("p", "", TX("sign \xf0\x92\x80\x80 here"))), &o);
    /* An en dash is not a letter, so defaultResolve deletes it — and deletes
     * all three of its bytes. */
    check("an en dash is deleted from a slug, whole", "[[ First Jewish\xe2\x80\x93Roman War ]]",
          ROOT(EL("p", "", EL("a", "\"href\":\"first-jewishroman-war\"",
                              TX("First Jewish\xe2\x80\x93Roman War")))), &o);
    check("a slug lowercases beyond ASCII", "[[ Kazimierz Micha\xc5\x81owski ]]",
          ROOT(EL("p", "", EL("a", "\"href\":\"kazimierz-micha\xc5\x82owski\"",
                              TX("Kazimierz Micha\xc5\x81owski")))), &o);

    printf("--- mdyast: links (the linkify-it port) ---\n");
    /* The conditional path rules, which are the whole reason for the port: a
     * full stop ending a sentence is not part of the URL, and a comma with
     * something after it is. */
    check("a trailing full stop is not in the URL", "see http://x.com.",
          ROOT(EL("p", "", TX("see ") ","
                  EL("a", "\"href\":\"http://x.com\"", TX("http://x.com")) "," TX("."))), &o);
    check("a comma inside a path is", "at http://x.com/a,b end",
          ROOT(EL("p", "", TX("at ") ","
                  EL("a", "\"href\":\"http://x.com/a,b\"", TX("http://x.com/a,b")) ","
                  TX(" end"))), &o);
    /* A protocol-relative URL needs a dotted host; `//word` is emphasis. */
    check("//host is a link", "x //example.com/p y",
          ROOT(EL("p", "", TX("x ") ","
                  EL("a", "\"href\":\"//example.com/p\"", TX("//example.com/p")) "," TX(" y"))), &o);
    check("…and a hyphen in the last label is not", "x //a.b-c// y",
          ROOT(EL("p", "", TX("x ") "," EL("em", "", TX("a.b-c")) "," TX(" y"))), &o);
    /* An underscore before a scheme disqualifies it — and then the `//` is
     * just a marker, which opens an emphasis that runs to the end. Checked
     * against the JavaScript rather than assumed: the obvious expectation is
     * that the whole thing stays literal text, and it does not. */
    check("_ before a scheme is not a link", "a _http://x.com b",
          ROOT(EL("p", "", TX("a _http:") "," EL("em", "", TX("x.com b")))), &o);

    printf("--- mdyast: doctype ---\n");
    /*
     * A fourth node type, and one a scan of the corpus's DOCUMENTS misses —
     * a doctype only appears in a site's LAYOUTS. Which is also why the two
     * checks below were wrong for a while: they asserted, with sanitizing ON,
     * that the doctype survives. It does not, and no corpus document could
     * have said so.
     *
     * `/^<!doctype\b[^>]*>?[ \t]*$/i`, and DROPPED when sanitizing: that mode
     * is for input somebody else wrote, and a fragment has no business
     * declaring what kind of document it is in.
     */
    {
        mdy_options raw = o;
        raw.sanitize = 0;
        check("<!doctype html> is its own node", "<!doctype html>",
              ROOT("{\"type\":\"doctype\"}"), &raw);
        check("…case-insensitively, and with trailing space", "<!DOCTYPE html>  ",
              ROOT("{\"type\":\"doctype\"}"), &raw);
        /* `\b` — a word character after `doctype` means this is not one, and
         * the ordinary element rule takes the line instead. */
        check("…but a word against it is not a doctype", "<!doctypefoo>",
              ROOT(EL("div", "\"doctypefoo\":true", "")), &raw);
        /* `[^>]*>?[ \t]*$` — nothing may follow the `>` but whitespace. */
        check("…nor is anything written after the `>`", "<!doctype html> x",
              ROOT(EL("div", "\"doctype\":true,\"html\":true", TX("x"))), &raw);
    }
    check("a doctype is dropped when sanitizing, line and all", "<!doctype html>",
          ROOT(""), &o);
    /* A comment is NOT special — the ordinary element rule handles it, and
     * the JavaScript agrees. Its `a` and `comment` read as boolean attributes,
     * which the schema then drops; with sanitize off they survive. */
    check("a comment is an ordinary div", "<!-- a comment -->",
          ROOT(EL("div", "", "")), &o);
    {
        mdy_options raw = o;
        raw.sanitize = 0;
        check("…keeping its stray attributes when unsanitised", "<!-- a comment -->",
              ROOT(EL("div", "\"a\":true,\"comment\":true", "")), &raw);
    }

    printf("--- mdyast: raw-text elements ---\n");
    /*
     * pre, script, style, textarea, title: markup inside a <script> is not
     * markup, and parsing it as if it were is how a stylesheet ends up with
     * an <em> in it. A blank line inside contributes nothing.
     *
     * Unsanitised, because none of the five is in the schema — a document
     * cannot carry a <script>, and these appear in LAYOUTS, which is also
     * where a <title> wrapped in a <p> was found.
     */
    {
        mdy_options raw = o;
        raw.sanitize = 0;
        check("a title holds text, not a paragraph", "< title\n  Order intake",
              ROOT(EL("title", "", TX("Order intake"))), &raw);
        check("…and its markup is left alone", "< title\n  a //b//",
              ROOT(EL("title", "", TX("a //b//"))), &raw);
        check("indentation past the opener's is kept", "< title\n  a\n    b",
              ROOT(EL("title", "", TX("a\\n  b"))), &raw);
        check("a blank line inside contributes nothing", "< title\n  a\n\n  b",
              ROOT(EL("title", "", TX("a\\nb"))), &raw);
    }

    printf("--- mdyast: comments ---\n");
    /* A `#` with nothing against it. A word against it is a tag instead —
     * which makes `# Title`, a Markdown heading, a comment here. */
    check("a comment line leaves nothing behind", "# a comment\ntext",
          ROOT(EL("p", "", TX("text"))), &o);
    check("the lines either side stay adjacent", "alpha\n# gap\nbeta",
          ROOT(EL("p", "", TX("alpha beta"))), &o);
    check("a bare # is a comment too", "#\ntext",
          ROOT(EL("p", "", TX("text"))), &o);
    /* A word against the `#` makes a TAG, which is the whole reason the
     * comment rule needs the space — and is what the JavaScript does. */
    check("a word against the # is a tag, not a comment", "#tag\n",
          ROOT(EL("p", "", EL("a", "\"href\":\"/tags/tag\"", TX("#tag")))), &o);
    /* The one place a comment is content: a code sample that quietly lost its
     * comments would be worse than useless. */
    check("a fence keeps its own", "```py\n# kept\n```",
          ROOT(EL("pre", "", EL("code", "\"className\":[\"language-py\"]", TX("# kept\\n")))), &o);

    printf("--- mdyast: fences ---\n");
    check("the language is the first word of the info", "```js title=\"a b\"\nx\n```",
          ROOT(EL("pre", "", EL("code", "\"className\":[\"language-js\"]", TX("x\\n")))), &o);
    check("a fence interrupts a paragraph", "text\n```\ncode\n```",
          ROOT(EL("p", "", TX("text")) "," EL("pre", "", EL("code", "", TX("code\\n")))), &o);

    printf("--- mdyast: front matter and references ---\n");
    /*
     * The block is FOUND here, where the fence rule belongs, and read by
     * whoever embeds this — it is YAML, and a YAML reader is not a thing to
     * write twice.
     */
    check_matter("the source between the fences comes back",
                 "+++\ntitle: A\ntags: [x]\n+++\nbody",
                 "1-4:title: A\ntags: [x]", &o);
    /* The block has to open on the first line, GIVE OR TAKE BLANK ONES, and
     * the fence tolerates trailing whitespace. */
    check_matter("blank lines above the fence are allowed",
                 "\n\n+++\na: 1\n+++  \nbody", "3-5:a: 1", &o);
    /* An opening fence with no partner is left alone: more likely prose than
     * a block somebody forgot to finish. */
    check_matter("an unclosed fence is not front matter", "+++\na: 1\nbody",
                 "(none)", &o);
    check_matter("a document with none says so", "body", "(none)", &o);
    {
        mdy_options fence = o;
        fence.documents = 1;
        check_matter("each document in a stream has its own",
                     "+++\na: 1\n+++\none\n---\ntwo\n---\n+++\nb: 2\n+++\nthree",
                     "1-3:a: 1|(none)|8-10:b: 2", &fence);
    }
    {
        mdy_options alt = o;
        alt.frontmatter_fence = "---yaml";
        check_matter("the fence is an option", "---yaml\na: 1\n---yaml\nbody",
                     "1-3:a: 1", &alt);
    }

    /* Names go in as WRITTEN, in the order the document reaches them, and only
     * once each — a document is asked what it refers to often enough that it
     * should not have to be read again to answer. */
    check_refs("tags, mentions and page links are written down",
               "#one and @two and [[ x | Some Page ]] and #one again",
               "0:tag:one|0:mention:two|0:link:some-page", &o);
    {
        mdy_options st = o;
        st.documents = 1;
        check_refs("…and each document keeps its own", "#a\n---\n#b",
                   "0:tag:a|1:tag:b", &st);
    }

    printf("--- mdyast: messages ---\n");
    /*
     * A <script> silently vanishing is a worse answer than one that says so.
     * These are compared against what mdy-docs puts on the vfile, text and
     * place both — a build shows them to whoever wrote the document.
     */
    check_messages("a stripped element says so", "<script>\n  alert(1)",
                   "1:1-1:9: `<script>` is not allowed, dropping it and its content", &o);
    check_messages("…and an unknown one says what it became", "<blink>\n  content",
                   "1:1-1:8: `<blink>` is not allowed, using `<div>` instead", &o);
    check_messages("a dropped attribute names its element", "<img src=\"x\" onerror=\"y\">",
                   "1:1-1:26: `onerror` is not allowed on `<img>`, dropping it", &o);
    check_messages("a refused protocol says so", "<a href=\"javascript:alert(1)\">x",
                   "1:1-1:32: `href` points at a protocol that is not allowed, dropping it", &o);
    check_messages("content under a void element is reported", "<hr>\n  ignored",
                   "1:1-1:5: `<hr>` cannot have content, ignoring it", &o);
    check_messages("a clamped heading reports its own depth", "======== deep",
                   "1:1-1:14: Heading level 8 is deeper than h6, clamping", &o);
    /* No PLACE: the inline parser works on a joined string and has no line to
     * point at, and neither does the JavaScript when it raises this one. */
    check_messages("a refused wiki link has no place to point at",
                   "[[ x | javascript:alert(1) ]]",
                   "`[[x]]` points at a protocol that is not allowed, dropping the link", &o);
    check_messages("a clean document raises nothing", "= Title\n\ntext", "", &o);

    printf("--- mdyast: table captions ---\n");
    /*
     * A caption is written exactly the way a one-column table's header is,
     * and what tells them apart is what comes NEXT: a header has a delimiter
     * row under it, a caption has a table.
     */
    check("a single-cell pipe line above a table captions it",
          "| Table 1. |\n| a | b |\n| - | - |",
          ROOT(EL("table", "", TX("\\n") ","
                  EL("caption", "", TX("Table 1.")) "," TX("\\n") ","
                  EL("thead", "", TX("\\n") ","
                     EL("tr", "", TX("\\n") "," EL("th", "", TX("a")) "," TX("\\n") ","
                        EL("th", "", TX("b")) "," TX("\\n")) "," TX("\\n")) "," TX("\\n"))), &o);
    /*
     * Two cells is not a caption, and neither is an empty one. The line stays
     * a paragraph — and the table under it is still a table, because the
     * paragraph rule stops at a header-and-delimiter pair.
     */
    {
        const char *table_ab =
            EL("table", "", TX("\\n") ","
               EL("thead", "", TX("\\n") ","
                  EL("tr", "", TX("\\n") "," EL("th", "", TX("a")) "," TX("\\n") ","
                     EL("th", "", TX("b")) "," TX("\\n")) "," TX("\\n")) "," TX("\\n"));
        char expect[1024];
        snprintf(expect, sizeof expect, "{\"type\":\"root\",\"children\":[%s,%s]}",
                 EL("p", "", TX("| One | Two |")), table_ab);
        check("only a ONE-cell line is a caption", "| One | Two |\n| a | b |\n| - | - |",
                   expect, &o);
        snprintf(expect, sizeof expect, "{\"type\":\"root\",\"children\":[%s,%s]}",
                 EL("p", "", TX("| |")), table_ab);
        check("an empty pipe line is not a caption", "| |\n| a | b |\n| - | - |",
                   expect, &o);
    }

    /* A caption line ends a paragraph, which is what makes `| One` prose and
     * `| Two` the caption of the table beneath it. */
    check_refs("only the line against the table is the caption — refs unaffected",
               "| One\n| Two\n| a | b |\n| - | - |", "", &o);
    {
        char expect[1400];
        snprintf(expect, sizeof expect, "{\"type\":\"root\",\"children\":[%s,%s]}",
                 EL("p", "", TX("| One")),
                 EL("table", "", TX("\\n") ","
                    EL("caption", "", TX("Two")) "," TX("\\n") ","
                    EL("thead", "", TX("\\n") ","
                       EL("tr", "", TX("\\n") "," EL("th", "", TX("a")) "," TX("\\n") ","
                          EL("th", "", TX("b")) "," TX("\\n")) "," TX("\\n")) "," TX("\\n")));
        check("a caption line ends the paragraph above it",
              "| One\n| Two\n| a | b |\n| - | - |", expect, &o);
    }

    printf("--- mdyast: table bodies ---\n");
    /* A row WITHOUT a pipe is still a row: a short one, padded to the
     * header's width. What ends a table is a blank line, an element opener,
     * a heading, a thematic break or an indent — not a missing pipe. */
    check("a line with no pipe is a short row", "| a | b |\n| - | - |\nonly one cell",
          ROOT(EL("table", "", TX("\\n") ","
                  EL("thead", "", TX("\\n") ","
                     EL("tr", "", TX("\\n") "," EL("th", "", TX("a")) "," TX("\\n") ","
                        EL("th", "", TX("b")) "," TX("\\n")) "," TX("\\n")) "," TX("\\n") ","
                  EL("tbody", "", TX("\\n") ","
                     EL("tr", "", TX("\\n") "," EL("td", "", TX("only one cell")) "," TX("\\n") ","
                        EL("td", "", "") "," TX("\\n")) "," TX("\\n")) "," TX("\\n"))), &o);

    printf("--- mdyast: links, tags and arrows ---\n");
    /* An arrow may not stand against another character the table draws with,
     * so nothing inside `<--->` is one. */
    check("a longer run is left alone", "---> and <--- and <===> and <---->",
          ROOT(EL("p", "", TX("---> and <--- and <===> and <---->"))), &o);
    /* linkify-it's normalize() puts `mailto:` in front of a bare email: the
     * link SAYS what was written and POINTS at the normalised url. */
    check("a bare email links through mailto:", "mail me a@b.com",
          ROOT(EL("p", "", TX("mail me ") "," EL("a", "\"href\":\"mailto:a@b.com\"", TX("a@b.com")))), &o);
    /* `setting.href + encodeURIComponent(name)` — the label keeps its case
     * and its characters, the href is encoded. */
    check("a tag name is percent-encoded in the href", "#caf\xc3\xa9",
          ROOT(EL("p", "", EL("a", "\"href\":\"/tags/caf%C3%A9\"", TX("#caf\xc3\xa9")))), &o);
    /* `href.toLowerCase().replace(/\\s+/g, '-')`, and only for a page of
     * ours — somebody else's URL is theirs, case and all. */
    check("a page link is lower cased with spaces as dashes",
          "[[ x | /docs/API Reference ]]",
          ROOT(EL("p", "", EL("a", "\"href\":\"/docs/api-reference\"", TX("x")))), &o);
    check("…a relative step upward is still a page", "[[ x | ../Up One ]]",
          ROOT(EL("p", "", EL("a", "\"href\":\"../up-one\"", TX("x")))), &o);
    check("…and somebody else's URL is left as written",
          "[[ x | https://Example.COM/Path ]]",
          ROOT(EL("p", "", EL("a", "\"href\":\"https://Example.COM/Path\"", TX("x")))), &o);
    /* A hand-written <a href> to a page of ours is tidied the same way. */
    check("a hand-written href is tidied too", "<a href=\"/Docs/API Reference\">x",
          ROOT(EL("a", "\"href\":\"/docs/api-reference\"", TX("x"))), &o);
    check_refs("…and written down", "<a href=\"/Docs/API Reference\">x",
               "0:link:/docs/api-reference", &o);
    check("a wiki link follows the schema for protocols",
          "[[ x | javascript:alert(1) ]]",
          ROOT(EL("p", "", EL("a", "", TX("x")))), &o);

    printf("--- mdyast: indentation and underlines ---\n");
    /* `width += tabSize - (width % tabSize)` with tabSize 4 — a tab runs to
     * the next tab stop, so one tab is a full indent level. */
    check("a tab counts to the next four-column stop", "a\n\thello",
          ROOT(EL("p", "", TX("a")) ","
               EL("div", "", TX("\\n") "," EL("div", "", TX("\\n") "," EL("p", "", TX("hello")) "," TX("\\n")) "," TX("\\n"))), &o);
    /* `^(?:(=+)|(-{4,}))[ \t]*$` — trailing whitespace is decoration. */
    check("a setext underline tolerates trailing whitespace", "Title\n=====  ",
          ROOT(EL("h1", "\"id\":\"title\"", TX("Title"))), &o);

    printf("--- mdyast: the sanitize schema ---\n");
    /* Two rules, not one. A tag in `strip` disappears with its content; a tag
     * merely absent from the allowed list becomes a <div> and KEEPS it. */
    check("an unknown element becomes a div and keeps its content",
          "<marquee>\n  content survives",
          ROOT(EL("div", "", TX("\\n") "," EL("p", "", TX("content survives")) "," TX("\\n"))), &o);
    check("a stripped element takes its content with it", "<script>\n  alert(1)",
          ROOT(""), &o);
    check("a javascript: URL is not a protocol the schema allows",
          "<a href=\"javascript:alert(1)\">x",
          ROOT(EL("a", "", TX("x"))), &o);
    check("…and an attribute the tag does allow survives",
          "<time datetime=\"2026-08-18\">x",
          ROOT(EL("time", "\"dateTime\":\"2026-08-18\"", TX("x"))), &o);

    printf("--- mdyast: void and blank-line elements ---\n");
    /* A void element holds nothing, so what is written under it is not its
     * content — the lines stay where they are. */
    check("a void element takes no content", "<hr>\n  ignored",
          ROOT(EL("hr", "", "") "," EL("div", "", TX("\\n") "," EL("p", "", TX("ignored")) "," TX("\\n"))), &o);
    /* A blank line has an indent of zero, and seeding the children's column
     * from it wrapped every such element's content in a spurious <div>. */
    check("a blank line does not close an element, or nest one",
          "<aside>\n\n  inside\n\nafter",
          ROOT(EL("aside", "", TX("\\n") "," EL("p", "", TX("inside")) "," TX("\\n")) ","
               EL("p", "", TX("after"))), &o);

    printf("--- mdyast: thematic breaks ---\n");
    /* `^([-*_])(?:[ \\t]*\\1){2,}[ \\t]*$` — three or more of one character,
     * with whitespace allowed between them. */
    check("spaces between the characters are allowed", "- - -",
          ROOT(EL("hr", "", "")), &o);
    check("…and more of them", "*  *  *",
          ROOT(EL("hr", "", "")), &o);

    printf("--- mdyast: hast property names ---\n");
    /*
     * `property-information`'s `find(html, name)`, which is what mdy-docs
     * calls. Each of these was wrong when the table was hand-written, and each
     * changed real output: one attribute resolving differently was enough to
     * reorder an entire element's properties downstream.
     */
    {
        mdy_options raw = o;
        raw.sanitize = 0;
        check("a known name is matched case-insensitively", "<img SRC=\"a\">",
              ROOT(EL("img", "\"src\":\"a\"", "")), &raw);
        check("…including the ones hast respells", "<i For=\"a\">",
              ROOT(EL("i", "\"htmlFor\":\"a\"", "")), &raw);
        check("an unknown name keeps the author's case", "<img FOO=\"1\">",
              ROOT(EL("img", "\"FOO\":\"1\"", "")), &raw);
        check("data- camel-cases only before a lowercase letter", "<img DATA-x-Y=\"e\">",
              ROOT(EL("img", "\"dataX-Y\":\"e\"", "")), &raw);
        check("…and does capitalise the first segment", "<img data-foo-bar=\"d\">",
              ROOT(EL("img", "\"dataFooBar\":\"d\"", "")), &raw);
        /* Properties are an object, so a repeated attribute REPLACES. The
         * append in mdy_add_class is for the parser's own classes. */
        check("a repeated class replaces rather than accumulating",
              "<i ClassName=\"a\" CLASS=\"b\">",
              ROOT(EL("i", "\"className\":[\"b\"]", "")), &raw);
    }

    printf("--- mdyast: ordered list start ---\n");
    /* A marker may be followed by the END OF THE LINE, and an ordered list
     * that does not begin at 1 records where it does. */
    check("1931. alone is a marker, and sets start", "1931.\nx",
          ROOT(EL("ol", "\"start\":1931", TX("\\n") ","
                  EL("li", "", TX(" x")) "," TX("\\n"))), &o);
    check("…and 1 is the default, so it is left off", "1. a",
          ROOT(EL("ol", "", TX("\\n") "," EL("li", "", TX("a")) "," TX("\\n"))), &o);
    check("a continuation needs no indentation", "- one\ntwo",
          ROOT(EL("ul", "", TX("\\n") "," EL("li", "", TX("one two")) "," TX("\\n"))), &o);

    printf("--- mdyast: loose and tight lists ---\n");
    check("a blank line between items makes the list loose", "- a\n\n- b",
          ROOT(EL("ul", "", TX("\\n") ","
                  EL("li", "", TX("\\n") "," EL("p", "", TX("a")) "," TX("\\n")) "," TX("\\n") ","
                  EL("li", "", TX("\\n") "," EL("p", "", TX("b")) "," TX("\\n")) "," TX("\\n"))), &o);

    printf("--- mdyast: indentation nests ---\n");
    /* Every TWO columns is one level, so four columns is two divs. */
    check("four columns is two nested divs", "top\n    in",
          ROOT(EL("p", "", TX("top")) ","
               EL("div", "", TX("\\n") ","
                  EL("div", "", TX("\\n") "," EL("p", "", TX("in")) "," TX("\\n")) ","
                  TX("\\n"))), &o);

    printf("--- mdyast: unist positions ---\n");
    {
        /* Block elements only, and every number here is what mdy-docs emits
         * for the same source. */
        mdy_doc *doc = mdy_parse("one two\n\n= Head\n\n- a\n- b", 0, &o);
        char *json = mdy_to_json(mdy_root(doc));
        struct { const char *what; const char *needle; } want[] = {
            { "a paragraph spans its line",
              "\"position\":{\"start\":{\"line\":1,\"column\":1},\"end\":{\"line\":1,\"column\":8}}" },
            { "a heading knows which line it was on",
              "\"position\":{\"start\":{\"line\":3,\"column\":1},\"end\":{\"line\":3,\"column\":7}}" },
            { "a list spans all of its items",
              "\"position\":{\"start\":{\"line\":5,\"column\":1},\"end\":{\"line\":6,\"column\":4}}" },
        };
        for (size_t k = 0; k < sizeof want / sizeof want[0]; k++) {
            int ok = strstr(json, want[k].needle) != NULL;
            printf("  %s  %s\n", ok ? "ok  " : "FAIL", want[k].what);
            if (!ok) { failures++; printf("      wanted %s\n      in     %s\n", want[k].needle, json); }
        }
        free(json);
        mdy_free(doc);

        /* A column is UTF-16 units, so an astral character counts twice —
         * `a 𒀀 b` is six units, not five characters and not seven bytes. */
        doc = mdy_parse("a \xf0\x92\x80\x80 b", 0, &o);
        json = mdy_to_json(mdy_root(doc));
        int ok = strstr(json, "\"end\":{\"line\":1,\"column\":7}") != NULL;
        printf("  %s  a column counts UTF-16 units, not characters\n", ok ? "ok  " : "FAIL");
        if (!ok) { failures++; printf("      %s\n", json); }
        free(json);
        mdy_free(doc);

        /* An indented block still starts at column 1: the column is measured
         * from the start of the line, indentation included. */
        doc = mdy_parse("top\n  in", 0, &o);
        json = mdy_to_json(mdy_root(doc));
        ok = strstr(json, "\"start\":{\"line\":2,\"column\":1},\"end\":{\"line\":2,\"column\":5}") != NULL;
        printf("  %s  an indented block starts at column 1, ends past its indent\n", ok ? "ok  " : "FAIL");
        if (!ok) { failures++; printf("      %s\n", json); }
        free(json);
        mdy_free(doc);

        /* Inline elements carry none, and neither does the root. */
        doc = mdy_parse("a **b** c", 0, &o);
        json = mdy_to_json(mdy_root(doc));
        const char *strong = strstr(json, "\"tagName\":\"strong\"");
        const char *after = strong ? strstr(strong, "\"position\"") : NULL;
        const char *next_p = strong ? strstr(strong, "}]}") : NULL;
        ok = strong && (!after || (next_p && after > next_p));
        printf("  %s  an inline element carries no position\n", ok ? "ok  " : "FAIL");
        if (!ok) { failures++; printf("      %s\n", json); }
        free(json);
        mdy_free(doc);

        /* lineOffset points positions at the real file rather than at whatever
         * slice of it was handed over. */
        mdy_options shifted = o;
        shifted.line_offset = 10;
        doc = mdy_parse("hi", 0, &shifted);
        json = mdy_to_json(mdy_root(doc));
        ok = strstr(json, "\"start\":{\"line\":11,\"column\":1}") != NULL;
        printf("  %s  line_offset moves them to the original file\n", ok ? "ok  " : "FAIL");
        if (!ok) { failures++; printf("      %s\n", json); }
        free(json);
        mdy_free(doc);
    }

    /*
     * How deep a tree this builds, which is not a matter of taste: every pass
     * over a tree recurses per level, so one line of four hundred thousand
     * spaces — two hundred thousand nested <div>s, and the only construct
     * here that nests without the source growing with it — was a segfault in
     * whichever pass ran first. The nesting stops at MDY_MAX_DEPTH and the
     * rest of the line is read flat, with a warning that says so.
     */
    printf("--- how deep a tree gets ---\n");
    {
        size_t asked = 200000;
        char *source = malloc(asked * 2 + 8);
        if (!source) { printf("  FAIL  out of memory\n"); failures++; }
        else {
            memset(source, ' ', asked * 2);
            source[asked * 2] = 'x';
            source[asked * 2 + 1] = '\0';

            mdy_doc *doc = mdy_parse(source, 0, NULL);
            /* Down the chain of elements, iteratively — a recursive measure
             * of a tree this test exists to bound would go over the same
             * cliff it is checking for. */
            size_t deepest = 0;
            for (const mdy_node *n = mdy_root(doc); n; ) {
                const mdy_node *into = NULL;
                for (const mdy_node *c = n->first; c; c = c->next)
                    if (c->type == MDY_ELEMENT) { into = c; break; }
                if (!into) break;
                deepest++;
                n = into;
            }
            /* The chain the indentation asked for, plus the one element the
             * line itself became — a paragraph at the bottom of it. */
            int ok = deepest > 0 && deepest <= MDY_MAX_DEPTH + 1;
            printf("  %s  a line indented past what any pass can walk is read flat\n",
                   ok ? "ok  " : "FAIL");
            if (!ok) { printf("      %zu elements deep, limit %d + the paragraph\n",
                              deepest, MDY_MAX_DEPTH); failures++; }

            int said = 0;
            for (size_t i = 0; i < mdy_message_count(doc); i++)
                if (strcmp(mdy_message_at(doc, i)->rule, "nesting-depth") == 0) said++;
            printf("  %s  ...and says so, once\n", said == 1 ? "ok  " : "FAIL");
            if (said != 1) { printf("      %d messages\n", said); failures++; }

            mdy_free(doc);
            free(source);
        }

        /* Right up to the limit it still nests, so the cap is a cap and not a
         * rounding of everything deep down to nothing. */
        char shallow[64];
        snprintf(shallow, sizeof shallow, "%*sx", 8, "");
        mdy_doc *doc = mdy_parse(shallow, 0, NULL);
        char *json = mdy_to_json_bare(mdy_root(doc));
        int ok = json && strstr(json, "\"tagName\":\"div\"") != NULL;
        printf("  %s  an ordinary indent still nests\n", ok ? "ok  " : "FAIL");
        if (!ok) { printf("      %s\n", json ? json : "(null)"); failures++; }
        free(json);
        mdy_free(doc);
    }

    /*
     * A five-digit port where the SPAN ends but the buffer does not.
     *
     * match_port bounded the value with `strtoul(t->s + i + 1, …)`, which
     * stops at the first non-digit — and a Text is a view, not a copy, so
     * there need not be one inside `len`. Digits after the span were read as
     * part of the port, make it larger than 65535, and the whole link is
     * dropped: `links=0` for a perfectly good URL.
     *
     * The buffer here is deliberately not NUL-terminated and is followed by
     * digits, which is the arrangement that went wrong; `mdy_find_links` is
     * given only the URL's length.
     */
    {
        const char *span = "http://a:12345";
        const char *after = "99999";
        size_t n = strlen(span), m = strlen(after);
        char *buf = malloc(n + m);
        memcpy(buf, span, n);
        memcpy(buf + n, after, m);
        mdy_link links[8];
        size_t got = mdy_find_links(buf, n, links, 8);
        int ok = got == 1 && links[0].start == 0 && links[0].end == n;
        printf("  %s  a 5-digit port is read from the span, not past it\n", ok ? "ok  " : "FAIL");
        if (!ok) { printf("      found %zu link(s)\n", got); failures++; }
        free(buf);
    }
    {
        /* ...and a port that really is too large is still not one. */
        const char *span = "http://a:99999";
        mdy_link links[8];
        size_t got = mdy_find_links(span, strlen(span), links, 8);
        int ok = got == 0;
        printf("  %s  ...and 99999 is still not a port\n", ok ? "ok  " : "FAIL");
        if (!ok) { printf("      found %zu link(s)\n", got); failures++; }
    }

    printf("\n%s\n", failures ? "FAILURES" : "all checks passed");
    return failures ? 1 : 0;
}
