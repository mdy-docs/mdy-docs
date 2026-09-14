/*
 * YAML, read.
 *
 * The corpus harness (make check-yaml) covers the 4.9 MB of YAML this project
 * actually holds. These cover the language: every construct the parser claims
 * to read, and every one it claims to refuse.
 *
 * The expectations were taken from a reference implementation and then checked
 * against the specification where the two could differ — `Yes` is the one that
 * matters here, and it is a STRING. YAML 1.1 made it a boolean; 1.2's core
 * schema does not, and real front matter in this corpus says `public-access:
 * Yes` and means the word.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mdyyaml.h"

static int failures = 0;

static void check(const char *what, const char *source, const char *expected) {
    char err[256];
    mdy_yaml *doc = mdy_yaml_parse(source, strlen(source), err, sizeof err);
    if (!doc) {
        printf("  FAIL  %s\n      expected %s\n      actual   error: %s\n", what, expected, err);
        failures++;
        return;
    }
    char *json = mdy_yaml_to_json(mdy_yaml_root(doc));
    int ok = json && strcmp(json, expected) == 0;
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) printf("      expected %s\n      actual   %s\n", expected, json ? json : "(null)");
    if (!ok) failures++;
    free(json);
    mdy_yaml_free(doc);
}

/* A construct this refuses, and the line it names. */
static void refuses(const char *what, const char *source, const char *expected) {
    char err[256];
    mdy_yaml *doc = mdy_yaml_parse(source, strlen(source), err, sizeof err);
    int ok = !doc && strcmp(err, expected) == 0;
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        printf("      expected error %s\n      actual   %s\n", expected,
               doc ? "(it parsed)" : err);
        failures++;
    }
    mdy_yaml_free(doc);
}


/* A document built from C rather than read from text. `expected` is the JSON,
 * so a built document and a parsed one are held to the same statement of what
 * is in them. */
static void built(const char *what, mdy_yaml *doc, const char *expected) {
    if (!doc) {
        printf("  FAIL  %s\n      expected %s\n      actual   the builder gave nothing\n",
               what, expected);
        failures++;
        return;
    }
    char *json = mdy_yaml_to_json(mdy_yaml_root(doc));
    int ok = json && strcmp(json, expected) == 0;
    printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) printf("      expected %s\n      actual   %s\n", expected, json ? json : "(null)");
    if (!ok) failures++;
    free(json);
    mdy_yaml_free(doc);
}

/*
 * The property the builder exists for: a value goes in as bytes and comes out
 * as the same bytes, whatever is in it. Built and then CLONED before reading,
 * so the copy is held to it too — a clone that dropped or truncated a value
 * would otherwise only show up in a site.
 */
static void survives(const char *what, const char *value, const char *expected) {
    mdy_yaml_builder *b = mdy_yaml_builder_new();
    mdy_yaml_put_string(b, "v", value, 0);
    mdy_yaml *doc = mdy_yaml_builder_done(b);
    mdy_yaml *copy = mdy_yaml_clone(doc);
    mdy_yaml_free(doc);
    built(what, copy, expected);
}

int main(void) {
    printf("--- mdyyaml: the language ---\n");
    check("null forms", "a: ~\nb: null\nc: Null\nd: NULL\ne:",
          "{\"a\":null,\"b\":null,\"c\":null,\"d\":null,\"e\":null}");
    check("booleans are only true/false", "a: true\nb: True\nc: TRUE\nd: false\ne: False",
          "{\"a\":true,\"b\":true,\"c\":true,\"d\":false,\"e\":false}");
    check("Yes and No are STRINGS in 1.2", "a: Yes\nb: no\nc: on\nd: off\ne: y",
          "{\"a\":\"Yes\",\"b\":\"no\",\"c\":\"on\",\"d\":\"off\",\"e\":\"y\"}");
    check("decimal integers", "a: 0\nb: 42\nc: -7\nd: +5\ne: 007",
          "{\"a\":0,\"b\":42,\"c\":-7,\"d\":5,\"e\":7}");
    check("octal and hex", "a: 0o17\nb: 0x1A\nc: 0xff",
          "{\"a\":15,\"b\":26,\"c\":255}");
    check("binary is not 1.2", "a: 0b101",
          "{\"a\":\"0b101\"}");
    check("floats", "a: 1.5\nb: .5\nc: -0.25\nd: 1e3\ne: 1.5e-3\nf: 2.0",
          "{\"a\":1.5,\"b\":0.5,\"c\":-0.25,\"d\":1000,\"e\":0.0015,\"f\":2}");
    check("underscores are not 1.2", "a: 1_000",
          "{\"a\":\"1_000\"}");
    /*
     * An integer wide enough that the rounding shows. `v * 10 + digit` rounds
     * once per digit, and seventeen of those landed on 100000000000000016
     * where the nearest double — and node, and strtod — is
     * 100000000000000000. The long and leading-zero cases are here because
     * the reader copies into a fixed buffer to get there.
     */
    check("seventeen digits round where one conversion rounds",
          "a: 99999999999999999\nb: -99999999999999999",
          "{\"a\":100000000000000000,\"b\":-100000000000000000}");
    check("...sixteen were always exact",
          "a: 1234567890123456", "{\"a\":1234567890123456}");
    check("...seventy digits is still the right infinity-adjacent value",
          "a: 9999999999999999999999999999999999999999999999999999999999999999999999",
          "{\"a\":1e+70}");
    check("...and leading zeros do not eat the buffer",
          "a: 00000000000000000000000000000000000000000000000000000000000000000000001",
          "{\"a\":1}");
    check("...hex and octal are unchanged",
          "a: 0x20000000000000\nb: 0o777", "{\"a\":9007199254740992,\"b\":511}");

    /* A closing `...`, which is single-document YAML and reads as one. */
    check("a closing document marker ends the document",
          "a: 1\n...\n", "{\"a\":1}");
    check("...with blank lines after it",
          "a: 1\n...\n\n", "{\"a\":1}");
    check("...with a comment after it",
          "a: 1\n...\n# tail\n", "{\"a\":1}");
    check("...and after a leading marker too",
          "---\na: 1\n...\n", "{\"a\":1}");
    check("a marker on its own is an empty document",
          "...\n", "null");

    check("a date is a string", "a: 2024-01-01\nb: 12:30",
          "{\"a\":\"2024-01-01\",\"b\":\"12:30\"}");
    check("a colon inside a value", "a: x:y\nb: a#b",
          "{\"a\":\"x:y\",\"b\":\"a#b\"}");
    check("single quotes", "a: 'it''s'\nb: 'x'",
          "{\"a\":\"it's\",\"b\":\"x\"}");
    check("double quotes and escapes", "a: \"x\\ny\"\nb: \"tab\\there\"\nc: \"q\\\"uote\"\nd: \"\\u00e9\"",
          "{\"a\":\"x\\ny\",\"b\":\"tab\\there\",\"c\":\"q\\\"uote\",\"d\":\"é\"}");
    check("a quoted scalar folds across lines", "a: \"one\n  two\"",
          "{\"a\":\"one two\"}");
    check("an escaped line break suppresses the fold", "a: \"one\\\n  two\"",
          "{\"a\":\"onetwo\"}");
    check("a plain scalar folds across lines", "a: one\n  two",
          "{\"a\":\"one two\"}");
    check("a blank line inside a plain scalar", "a: one\n\n  two",
          "{\"a\":\"one\\ntwo\"}");
    check("literal keeps its breaks", "a: |\n  one\n  two\n",
          "{\"a\":\"one\\ntwo\\n\"}");
    check("literal, stripped", "a: |-\n  one\n  two\n",
          "{\"a\":\"one\\ntwo\"}");
    check("literal, kept", "a: |+\n  one\n\n",
          "{\"a\":\"one\\n\\n\"}");
    check("folded folds", "a: >\n  one\n  two\n",
          "{\"a\":\"one two\\n\"}");
    check("folded keeps a blank line", "a: >\n  one\n\n  two\n",
          "{\"a\":\"one\\ntwo\\n\"}");
    check("folded keeps a more-indented line", "a: >\n  one\n   two\n  three\n",
          "{\"a\":\"one\\n two\\nthree\\n\"}");
    check("an explicit indentation indicator", "a: |2\n   one\n  two\n",
          "{\"a\":\" one\\ntwo\\n\"}");
    check("a block scalar with no content", "a: >\nb: 1",
          "{\"a\":\"\",\"b\":1}");
    check("a sequence at its key's indent", "k:\n- a\n- b",
          "{\"k\":[\"a\",\"b\"]}");
    check("a sequence indented under its key", "k:\n  - a\n  - b",
          "{\"k\":[\"a\",\"b\"]}");
    check("the compact `- key: value` form", "- a: 1\n  b: 2\n- a: 3",
          "[{\"a\":1,\"b\":2},{\"a\":3}]");
    check("a sequence inside a sequence", "- - a\n  - b",
          "[[\"a\",\"b\"]]");
    check("a bare dash takes what is under it", "-\n  a: 1",
          "[{\"a\":1}]");
    check("nested mappings", "a:\n  b:\n    c: 1",
          "{\"a\":{\"b\":{\"c\":1}}}");
    check("an empty value is null", "a:\nb: 1",
          "{\"a\":null,\"b\":1}");
    check("a flow sequence", "k: [1, two, \"three\"]",
          "{\"k\":[1,\"two\",\"three\"]}");
    check("a flow mapping", "k: {a: 1, b: two}",
          "{\"k\":{\"a\":1,\"b\":\"two\"}}");
    check("nested flow", "k: [{a: 1}, [2, 3]]",
          "{\"k\":[{\"a\":1},[2,3]]}");
    check("flow across lines", "k: [\n  1,\n  2\n]",
          "{\"k\":[1,2]}");
    check("empty flow collections", "k: {}\nj: []",
          "{\"k\":{},\"j\":[]}");
    check("a flow value with no value", "k: {a: , b: 1}",
          "{\"k\":{\"a\":null,\"b\":1}}");
    check("a comment line", "# note\nk: v",
          "{\"k\":\"v\"}");
    check("a comment after a value", "k: v # note",
          "{\"k\":\"v\"}");
    check("a hash inside a word is not a comment", "k: a#b",
          "{\"k\":\"a#b\"}");
    check("trailing whitespace", "k: v   ",
          "{\"k\":\"v\"}");
    check("blank lines between keys", "a: 1\n\n\nb: 2",
          "{\"a\":1,\"b\":2}");
    check("an empty document", "",
          "null");
    check("only a comment", "# nothing",
          "null");
    check("a bare scalar document", "hello",
          "\"hello\"");
    check("a top-level sequence", "- a\n- b",
          "[\"a\",\"b\"]");
    check("a leading document marker", "---\na: 1",
          "{\"a\":1}");
    check("quoted keys", "\"a b\": 1\n'c': 2",
          "{\"a b\":1,\"c\":2}");
    check("a key that looks like a number", "1: a\ntrue: b",
          "{\"1\":\"a\",\"true\":\"b\"}");
    /* "It is an error for two equal keys to appear in the same mapping." */
    refuses("a repeated key is an error", "a: 1\na: 2", "line 2: duplicate key in a mapping");

    printf("--- mdyyaml: what it refuses, and where ---\n");
    /*
     * Each of these is a feature to add rather than a corner to guess at, and
     * none appears in the 179 YAML blocks this was built for. What matters is
     * that a refusal is loud: a parser that silently mis-reads data is worse
     * than one that stops.
     */
    refuses("anchors", "a: &x 1\nb: 2", "line 1: anchors and aliases are not supported");
    refuses("aliases", "a: 1\nb: *x", "line 2: anchors and aliases are not supported");
    refuses("tags", "a: !!str 1", "line 1: tags are not supported");
    refuses("merge keys", "<<: *base\na: 1", "line 1: merge keys are not supported");
    refuses("a second document", "a: 1\n---\nb: 2",
            "line 2: more than one document in a stream is not supported");
    /*
     * ...but a `...` that CLOSES the one document is not a second one:
     * `a: 1\n...\n` is `{a: 1}`, in a data file and in `+++` front matter
     * alike. What decides is whether anything of substance follows — blanks
     * and comments do not make a document, a mapping does.
     */
    refuses("a second document after a closing marker", "a: 1\n...\nb: 2",
            "line 2: more than one document in a stream is not supported");
    refuses("...or one opened again after it", "a: 1\n...\n---\nb: 2",
            "line 2: more than one document in a stream is not supported");
    refuses("directives", "%YAML 1.2\n---\na: 1", "line 1: directives are not supported");
    refuses("a tab for indentation", "a:\n\tb: 1", "line 2: a tab cannot be used for indentation");
    refuses("an unterminated quote", "a: \"x", "line 1: unterminated double-quoted scalar");
    refuses("an unterminated flow sequence", "a: [1, 2", "line 1: unterminated flow sequence");
    refuses("an unknown escape", "a: \"\\q\"",
            "line 1: unknown escape in a double-quoted scalar");

    printf("--- mdyyaml: reading a tree ---\n");
    {
        const char *src = "title: Uruk\nyears: [4000, 3100]\nfacts:\n  founded: true\n";
        char err[256];
        mdy_yaml *doc = mdy_yaml_parse(src, strlen(src), err, sizeof err);
        const mdy_yaml_node *root = mdy_yaml_root(doc);
        int ok = doc && mdy_yaml_type_of(root) == MDY_YAML_MAPPING &&
                 mdy_yaml_count(root) == 3;
        printf("  %s  a mapping knows its size\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        size_t len = 0;
        const char *title = mdy_yaml_string(mdy_yaml_get(root, "title"), &len);
        ok = title && len == 4 && memcmp(title, "Uruk", 4) == 0;
        printf("  %s  a string is reachable by key\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        const mdy_yaml_node *years = mdy_yaml_get(root, "years");
        ok = mdy_yaml_type_of(years) == MDY_YAML_SEQUENCE && mdy_yaml_count(years) == 2 &&
             mdy_yaml_number(mdy_yaml_at(years, 0)) == 4000;
        printf("  %s  a sequence is indexable\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        ok = mdy_yaml_bool(mdy_yaml_get(mdy_yaml_get(root, "facts"), "founded")) == 1;
        printf("  %s  a nested mapping\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        const char *key = mdy_yaml_key(root, 0, &len);
        ok = key && len == 5 && memcmp(key, "title", 5) == 0;
        printf("  %s  keys keep the order they were written\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        ok = mdy_yaml_get(root, "absent") == NULL &&
             mdy_yaml_at(years, 9) == NULL &&
             mdy_yaml_string(years, NULL) == NULL;
        printf("  %s  asking for what is not there answers nothing\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;

        mdy_yaml_free(doc);
    }

    /*
     * `a: ` and two hundred thousand `[` is one short line, two hundred
     * thousand frames in the reader and as many again in everything that
     * walks the value afterwards. It is refused, like everything else this
     * reader will not guess at.
     */
    /*
     * A quoted scalar ends at its closing quote. `title: "Hello" world` came
     * back as `Hello` with `world` dropped, and `name: "it"s.mdy"` as `it` —
     * the one place this reader guessed, against its own contract. What may
     * follow is nothing, or a comment, and the same question is asked of a
     * quoted KEY against the `:` it was measured by. node's reader refuses
     * every one of these too.
     */
    printf("--- mdyyaml: where a quoted scalar ends ---\n");
    refuses("text after a quoted value", "title: \"Hello\" world",
            "line 1: unexpected text after a quoted scalar");
    refuses("...single-quoted too", "title: 'Hi' there",
            "line 1: unexpected text after a quoted scalar");
    refuses("...and on the line a multi-line one closes on", "title: \"multi\n  line\" tail",
            "line 2: unexpected text after a quoted scalar");
    refuses("text after a quoted key", "\"a\"x: v",
            "line 1: unexpected text after a quoted key");
    check("...but a comment after one is not text", "title: \"a\" # comment", "{\"title\":\"a\"}");
    check("...nor is trailing space", "title: \"a\"   ", "{\"title\":\"a\"}");
    check("...nor a space before a key's colon", "\"a\" : v", "{\"a\":\"v\"}");
    check("...nor a colon inside the key itself", "\"a: b\": v", "{\"a: b\":\"v\"}");

    printf("--- how deep a flow collection gets ---\n");
    {
        size_t asked = 200000;
        char *source = malloc(asked * 2 + 8);
        if (!source) { printf("  FAIL  out of memory\n"); failures++; }
        else {
            memcpy(source, "a: ", 3);
            memset(source + 3, '[', asked);
            memset(source + 3 + asked, ']', asked);
            source[3 + asked * 2] = '\0';
            refuses("nested past what the reader will follow", source,
                    "line 1: nested deeper than this reads");
            free(source);
        }
        check("...and an ordinary flow collection still nests",
              "a: [[[1]]]", "{\"a\":[[[1]]]}");
    }


    printf("--- built from C, not read from text ---\n");
    {
        mdy_yaml_builder *b = mdy_yaml_builder_new();
        mdy_yaml_put_string(b, "path", "pages/uruk.mdy", 0);
        mdy_yaml_put_string(b, "name", "uruk", 0);
        mdy_yaml_put_number(b, "size", 1234);
        mdy_yaml_put_bool(b, "draft", 0);
        mdy_yaml_put_null(b, "nothing");
        built("scalars, in the order they were put", mdy_yaml_builder_done(b),
              "{\"path\":\"pages/uruk.mdy\",\"name\":\"uruk\",\"size\":1234,"
              "\"draft\":false,\"nothing\":null}");
    }
    {
        const char *tags[] = { "alpha", "beta" };
        mdy_yaml_builder *b = mdy_yaml_builder_new();
        mdy_yaml_put_strings(b, "tags", tags, 2);
        built("a sequence of strings", mdy_yaml_builder_done(b),
              "{\"tags\":[\"alpha\",\"beta\"]}");
    }
    {
        mdy_yaml_builder *b = mdy_yaml_builder_new();
        mdy_yaml_put_strings(b, "tags", NULL, 0);
        built("...and an empty one is a key with a list, not a missing key",
              mdy_yaml_builder_done(b), "{\"tags\":[]}");
    }
    {
        /* A whole number goes out as digits, the way the text path's `%.0f`
         * did, so a record built either way encodes identically. */
        mdy_yaml_builder *b = mdy_yaml_builder_new();
        mdy_yaml_put_number(b, "size", 0);
        mdy_yaml_put_number(b, "width", 1920);
        built("whole numbers are whole", mdy_yaml_builder_done(b),
              "{\"size\":0,\"width\":1920}");
    }
    {
        /* The same key twice is two pairs, in order: the merge downstream is
         * what decides which wins, and it cannot if this collapses them. */
        mdy_yaml_builder *b = mdy_yaml_builder_new();
        mdy_yaml_put_string(b, "a", "first", 0);
        mdy_yaml_put_string(b, "a", "second", 0);
        built("a repeated key is kept as written", mdy_yaml_builder_done(b),
              "{\"a\":\"first\",\"a\":\"second\"}");
    }

    printf("--- what a text round-trip could not carry ---\n");
    survives("a double quote", "say \"hi\"", "{\"v\":\"say \\\"hi\\\"\"}");
    survives("a backslash", "C:\\path\\to", "{\"v\":\"C:\\\\path\\\\to\"}");
    survives("a newline", "one\ntwo", "{\"v\":\"one\\ntwo\"}");
    survives("a tab and a return", "a\tb\rc", "{\"v\":\"a\\tb\\rc\"}");
    survives("a control character", "a\001b", "{\"v\":\"a\\u0001b\"}");
    survives("a line that looks like a document break", "---", "{\"v\":\"---\"}");
    survives("a line that looks like front matter", "+++\ntitle: x\n+++",
             "{\"v\":\"+++\\ntitle: x\\n+++\"}");
    survives("a key-shaped value", "k: v", "{\"v\":\"k: v\"}");
    survives("UTF-8 through as bytes", "Ur\xc3\xbck \xf0\x9f\x8f\xba",
             "{\"v\":\"Ur\xc3\xbck \xf0\x9f\x8f\xba\"}");
    survives("the empty string", "", "{\"v\":\"\"}");

    printf("--- clone ---\n");
    {
        char err[256];
        mdy_yaml *doc = mdy_yaml_parse("a: [1, {b: \"x\"}]\nc: true", 0, err, sizeof err);
        mdy_yaml *copy = mdy_yaml_clone(doc);
        mdy_yaml_free(doc);          /* freed FIRST: the copy owns nothing of it */
        built("a parsed tree, copied, outlives its original", copy,
              "{\"a\":[1,{\"b\":\"x\"}],\"c\":true}");
    }
    {
        /* Not through `built`: nothing in, nothing out — and NULL is the
         * answer, not a document holding null. */
        int ok = mdy_yaml_clone(NULL) == NULL;
        printf("  %s  cloning nothing gives nothing\n", ok ? "ok  " : "FAIL");
        if (!ok) failures++;
    }

    if (failures) {
        printf("\n%d check%s failed\n", failures, failures == 1 ? "" : "s");
        return 1;
    }
    printf("\nall checks passed\n");
    return 0;
}
