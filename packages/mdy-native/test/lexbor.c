/*
 * lexbor, vendored: does it do HTML5 tree construction?
 *
 * Not a test of lexbor, which has its own suite upstream. A test that the
 * FIVE files vendored out of it still add up to a working parser — the html
 * module needs core, dom, tag and ns, and one port file for malloc, and
 * getting that set wrong gives a library that links and then quietly declines
 * to repair anything.
 *
 * Three shapes, because each is a different rule and a tag matcher passes
 * none of them.
 */
#include <stdio.h>
#include <string.h>

#include "lexbor/html/html.h"
#include "lexbor/dom/dom.h"

static int failures = 0;

/* The body's children, written back out as HTML. */
static lxb_status_t collect(const lxb_char_t *data, size_t len, void *ctx) {
    char *out = ctx;
    size_t have = strlen(out);
    if (have + len < 4096) memcpy(out + have, data, len), out[have + len] = '\0';
    return LXB_STATUS_OK;
}

static void ok_(const char *what, const char *html, const char *want) {
    char got[4096] = "";
    lxb_html_document_t *doc = lxb_html_document_create();
    if (doc == NULL) { printf("  FAIL  %s (no document)\n", what); failures++; return; }

    if (lxb_html_document_parse(doc, (const lxb_char_t *)html, strlen(html)) != LXB_STATUS_OK) {
        printf("  FAIL  %s (parse refused)\n", what);
        failures++;
        lxb_html_document_destroy(doc);
        return;
    }
    lxb_dom_node_t *body = lxb_dom_interface_node(lxb_html_document_body_element(doc));
    for (lxb_dom_node_t *n = body->first_child; n != NULL; n = n->next) {
        lxb_html_serialize_tree_cb(n, collect, got);
    }
    lxb_html_document_destroy(doc);

    if (strcmp(got, want) == 0) {
        printf("  ok    %s\n", what);
    } else {
        printf("  FAIL  %s\n        want %s\n        got  %s\n", what, want, got);
        failures++;
    }
}

int main(void) {
    printf("--- lexbor: HTML5 tree construction ---\n");

    /* An unclosed tag is closed at the end of the fragment. Without this a
     * `<div>` written in one document reaches the next one on the page. */
    ok_("an unclosed tag is closed",
        "<p>a <b>unclosed", "<p>a <b>unclosed</b></p>");

    /* The adoption agency algorithm: `</i>` closes a `<b>` that was opened
     * inside it, and the `<b>` is re-opened around what follows. */
    ok_("crossed formatting elements are un-crossed",
        "<p>a <b>x</i> b</p>", "<p>a <b>x b</b></p>");

    /* Foster parenting: character data and elements may not sit between a
     * <table> and its first row, so they are hoisted out in front of it.
     * §4 wrote this one rule out by hand for tables; it is lexbor's now. */
    ok_("a stray element in a table is foster-parented out",
        "<table><b>stray</b><tr><td>x</td></tr></table>",
        "<b>stray</b><table><tbody><tr><td>x</td></tr></tbody></table>");

    if (failures == 0) printf("all checks passed\n");
    else printf("%d check(s) failed\n", failures);
    return failures == 0 ? 0 : 1;
}
