/*
 * Composition: the trees a render parks, and the tokens that stand for them.
 *
 * `$.render` gives a document's code a few private-use characters rather than
 * HTML, so the token travels through that code like any other string and the
 * tree goes back in once the text around it has been parsed. Everything about
 * that — the table a tree waits in, reading a token out of text, splicing one
 * back, and the contents list that cannot exist until the tree does — is
 * here. The natives that MINT tokens are not; they are where the rest of `$`
 * is.
 */
#include "engine_internal.h"
#include "xalloc.h"

/* ---- composition -------------------------------------------------------------
 *
 * `$.render` does not return HTML, or a tree, or text. It returns a TOKEN — a
 * few private-use characters standing for a tree the host has parked — and the
 * token travels through the document's own code like any other string, into a
 * variable, a template literal, an attribute. The tree goes back in once the
 * text around it has been parsed.
 *
 * That is what makes `$.render` need no indentation argument: the parser
 * already knows which element is open where the token landed, so there is no
 * column for the caller to compute.
 *
 *   U+E000 <id> U+E001
 *
 * The id is base36 so a counter and a content-derived identity are both
 * covered by one pattern — three regexes in compose.js have to agree about
 * what an id looks like, and once they did not.
 */
#define TOKEN_OPEN  "\xee\x80\x80"      /* U+E000 as UTF-8 */
#define TOKEN_CLOSE "\xee\x80\x81"      /* U+E001 */

/* A token's id at `s`, or 0. Writes the id and how many bytes it spanned.
 * `id_cap` is a Held's id (24 bytes): an id longer than that is not one this
 * engine minted, and is refused as such rather than cut. */
size_t token_at(const char *s, size_t len, char *id, size_t id_cap) {
    if (len < 5 || memcmp(s, TOKEN_OPEN, 3) != 0) return 0;
    size_t i = 3;
    size_t n = 0;
    while (i < len && n + 1 < id_cap) {
        char c = s[i];
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z')) { id[n++] = c; i++; continue; }
        break;
    }
    id[n] = '\0';
    if (n == 0) return 0;
    if (i + 3 > len || memcmp(s + i, TOKEN_CLOSE, 3) != 0) return 0;
    return i + 3;
}

/* Whoever owns the token table this engine writes into. */
mdy_engine *token_table(mdy_engine *e) { return e->compose.tokens ? e->compose.tokens : e; }

Held *held_find(mdy_engine *e, const char *id) {
    mdy_engine *t = token_table(e);
    for (size_t i = 0; i < t->compose.held_count; i++)
        if (strcmp(t->compose.held[i].id, id) == 0) return &t->compose.held[i];
    return NULL;
}

/*
 * Park a tree and hand back the token that stands for it.
 *
 * Nothing is reclaimed within a render: a token can be written into a string,
 * kept in a variable, dropped, or used twice, and nothing here gets to decide
 * when the last of those happened.
 */
char *hold_tree_as(mdy_engine *e, mdy_doc *doc, mdy_node *tree, const char *id);
char *hold_tree(mdy_engine *e, mdy_doc *doc, mdy_node *tree) {
    return hold_tree_as(e, doc, tree, NULL);
}

/*
 * `id` names the tree by what it IS rather than by when it was parked — the
 * key of the render that made it — and a caller that can say so should: a
 * token travels in the text a document hands back and reaches its parent
 * inside `req`, so it is part of the parent's memo key, and sequential
 * numbering would make two builds either side of an edit look alike. That is
 * compose.js's `hold(tree, id)`, and it is also why the counter here counts
 * only what mdy-docs' counts — trees a document built itself — and the ids
 * a site's own text ends up holding match.
 */
char *hold_tree_as(mdy_engine *e, mdy_doc *doc, mdy_node *tree, const char *id) {
    mdy_engine *t = token_table(e);
    /*
     * A token is not optional. Returning NULL here left six callers each
     * inventing their own answer -- one of them returned `true` with `*result`
     * never assigned, which the VM then read as a value. The id is also
     * OBSERVABLE (see keep_alive below), so a hold that did not happen moves
     * every id after it and changes the site's own search index. See xalloc.h.
     */
    if (t->compose.held_count == t->compose.held_cap) {
        size_t want = t->compose.held_cap ? t->compose.held_cap * 2 : 8;
        t->compose.held = mdy_xrealloc(t->compose.held, want * sizeof *t->compose.held);
        t->compose.held_cap = want;
    }
    Held *h = &t->compose.held[t->compose.held_count++];
    if (id) snprintf(h->id, sizeof h->id, "%s", id);
    else snprintf(h->id, sizeof h->id, "%zu", t->compose.next_token++);
    h->doc = doc;
    h->tree = tree;
    h->is_toc = 0;

    size_t n = strlen(TOKEN_OPEN) + strlen(h->id) + strlen(TOKEN_CLOSE) + 1;
    char *token = mdy_xmalloc(n);
    snprintf(token, n, "%s%s%s", TOKEN_OPEN, h->id, TOKEN_CLOSE);
    return token;
}

/*
 * Keep a document alive for the rest of the render WITHOUT naming it.
 *
 * `$.text` and `$.parse` both produce a tree that has to outlive the call —
 * `$.text` because a token spliced into it points at held nodes, `$.parse`
 * because the value handed back does — but neither hands out a token for it.
 * Minting one anyway advances the token counter, and that counter is
 * OBSERVABLE: a token's id is in the text `$.text` returns, so a site that
 * indexes its own output indexes the number. Two extra holds moved every id
 * after them and a search index disagreed with mdy-docs' by one word.
 */
void keep_alive(mdy_engine *e, mdy_doc *doc) {
    mdy_engine *t = token_table(e);
    /* Returning here freed nothing and kept nothing: the document the caller
     * is about to hand out went on being referenced after the render released
     * it. See xalloc.h. */
    if (t->compose.kept_count == t->compose.kept_cap) {
        size_t want = t->compose.kept_cap ? t->compose.kept_cap * 2 : 8;
        t->compose.kept = mdy_xrealloc(t->compose.kept, want * sizeof *t->compose.kept);
        t->compose.kept_cap = want;
    }
    t->compose.kept[t->compose.kept_count++] = doc;
}

void release_held(mdy_engine *e) {
    mdy_engine *t = token_table(e);
    for (size_t i = 0; i < t->compose.held_count; i++) mdy_free(t->compose.held[i].doc);
    free(t->compose.held);
    t->compose.held = NULL;
    t->compose.held_count = t->compose.held_cap = 0;
    for (size_t i = 0; i < t->compose.kept_count; i++) mdy_free(t->compose.kept[i]);
    free(t->compose.kept);
    t->compose.kept = NULL;
    t->compose.kept_count = t->compose.kept_cap = 0;
}

/* Whitespace, and nothing else. */
static int only_space(const char *s, size_t len) {
    for (size_t i = 0; i < len; i++)
        if (s[i] != ' ' && s[i] != '\t' && s[i] != '\n' && s[i] != '\r') return 0;
    return 1;
}

/* `^(?:\s*TOKEN)+\s*$` — a run that is nothing but tokens and space. */
int only_tokens(const char *s, size_t len) {
    size_t i = 0;
    int found = 0;
    for (;;) {
        while (i < len && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
        if (i >= len) return found;
        char id[24];
        size_t used = token_at(s + i, len - i, id, sizeof id);
        if (!used) return 0;
        i += used;
        found = 1;
    }
}

/* Elements that hold a line of their own, and so cannot hold one of somebody
 * else's — the ones a nested render is likely to produce at its top level. */
static int is_block_tag(const char *tag) {
    static const char *const BLOCK[] = { "p", "div", "section", "article", "main", "header", "footer" };
    for (size_t i = 0; i < sizeof BLOCK / sizeof BLOCK[0]; i++)
        if (strcmp(BLOCK[i], tag) == 0) return 1;
    return 0;
}

/*
 * Block wrappers off, phrasing content out. A block cannot sit inside a
 * sentence, so it gives up its wrapper and lends its content instead — as far
 * down as the blocks go, since unwrapping a <div> only to find a <p> under it
 * has solved nothing.
 */
static void unwrap_into(mdy_node *dest, mdy_node *source) {
    for (mdy_node *c = source->first; c;) {
        mdy_node *next = c->next;
        c->next = NULL;
        if (c->type == MDY_ELEMENT && is_block_tag(c->tag)) unwrap_into(dest, c);
        else if (c->type == MDY_TEXT && only_space(c->text ? c->text : "", mdy_text_len(c))) ;
        else mdy_append(dest, c);
        c = next;
    }
}

/* What a held tree contributes where a BLOCK was expected: a root lends its
 * children, anything else stands for itself. */
static void block_content(mdy_node *dest, mdy_node *tree) {
    if (tree->type == MDY_ROOT) {
        for (mdy_node *c = tree->first; c;) {
            mdy_node *next = c->next;
            c->next = NULL;
            mdy_append(dest, c);
            c = next;
        }
    } else {
        mdy_append(dest, tree);
    }
}

/*
 * Tokens in a run of TEXT, as the inline content they become. Anything that is
 * not a token stays the text it was.
 */
static void inline_content(mdy_engine *e, mdy_doc *doc, mdy_node *dest,
                           const char *s, size_t len) {
    size_t i = 0, last = 0;
    while (i < len) {
        char id[24];
        size_t used = token_at(s + i, len - i, id, sizeof id);
        if (!used) { i++; continue; }
        if (i > last) mdy_append(dest, mdy_new_text(doc, s + last, i - last));
        Held *h = held_find(e, id);
        if (h && h->tree) {
            mdy_node *holder = mdy_new_element(doc, "span", 4);
            /*
             * A COPY, because a token can be used more than once — a site
             * renders its colophon once and passes the same token to every
             * page. Splicing moves nodes, so the second use would find the
             * tree already emptied and contribute only its whitespace: a
             * growing run of blank lines, one per page that reused it.
             */
            block_content(holder, mdy_clone(doc, h->tree));
            unwrap_into(dest, holder);
        } else {
            mdy_append(dest, mdy_new_text(doc, s + i, used));
        }
        i += used;
        last = i;
    }
    if (last < len) mdy_append(dest, mdy_new_text(doc, s + last, len - last));
}

/* The text of a node that is a `<p>` holding one text child, or a text node —
 * which is what `onlyTokens` asks about. */
const char *sole_text(const mdy_node *n, size_t *len) {
    if (n->type == MDY_TEXT) { *len = mdy_text_len(n); return n->text; }
    if (n->type == MDY_ELEMENT && strcmp(n->tag, "p") == 0 && n->first &&
        n->first == n->last && n->first->type == MDY_TEXT) {
        *len = mdy_text_len(n->first);
        return n->first->text;
    }
    return NULL;
}

/*
 * Put the held trees back where their tokens are.
 *
 * A paragraph holding nothing but tokens is REPLACED by what they hold — a
 * render on a line of its own is that document, not a paragraph wrapping it.
 * A token inside a sentence gives up its blocks instead.
 */
void splice_tree(mdy_engine *e, mdy_doc *doc, mdy_node *parent) {
    mdy_node *child = parent->first;
    parent->first = parent->last = NULL;

    while (child) {
        mdy_node *next = child->next;
        child->next = NULL;

        size_t len = 0;
        const char *text = sole_text(child, &len);

        if (text && only_tokens(text, len)) {
            size_t i = 0;
            int filled = 0;
            while (i < len) {
                char id[24];
                size_t used = token_at(text + i, len - i, id, sizeof id);
                if (!used) { i++; continue; }
                Held *h = held_find(e, id);
                if (h && h->tree) { block_content(parent, mdy_clone(doc, h->tree)); filled = 1; }
                i += used;
            }
            if (filled) { child = next; continue; }
        }

        if (child->type == MDY_TEXT && child->text && strstr(child->text, TOKEN_OPEN)) {
            inline_content(e, doc, parent, child->text, mdy_text_len(child));
            child = next;
            continue;
        }

        if (child->first) splice_tree(e, doc, child);
        mdy_append(parent, child);
        child = next;
    }
}

/*
 * A string holding tokens, as HTML — the string-shaped half of composition.
 * `$.emit(url, $.render(page))` writes a page because a file is a string and
 * that is the shape it can hold.
 */
char *fill_tokens(mdy_engine *e, const char *s, size_t len) {
    mdy_sbuf out = { .seed = len + 256 };
    size_t i = 0, last = 0;
    while (i < len) {
        char id[24];
        size_t used = token_at(s + i, len - i, id, sizeof id);
        if (!used) { i++; continue; }

        Held *h = held_find(e, id);
        char *html = NULL;
        if (h && h->tree) {
            html = mdy_to_html(h->tree, NULL);
            /* A held tree that will not serialise is not an empty token: the
             * page would be written with the rendered piece silently missing
             * and the build would report success. */
            if (!html) { free(out.s); return NULL; }
        }
        /* A token nothing holds stays as it was written, as compose.js's
         * fillTokens leaves an unknown match; only a contents placeholder,
         * which is held with no tree yet, becomes nothing. */
        mdy_sbuf_put(&out, s + last, i - last + (h ? 0 : used));
        if (html) { mdy_sbuf_puts(&out, html); free(html); }
        i += used;
        last = i;
    }
    mdy_sbuf_put(&out, s + last, len - last);
    return out.s;
}
