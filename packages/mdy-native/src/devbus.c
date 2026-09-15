#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "devbus.h"
#include "bjval.h"
#include "cli_util.h"
#include "http.h"
#include "mdytext.h"
#include "xalloc.h"

void collect_message(void *ud, const char *name, const char *data_json, size_t doc_index) {
    (void)doc_index;
    Messages *m = ud;
    if (m->count == m->cap) {
        m->cap = m->cap ? m->cap * 2 : 8;
        m->names = mdy_xrealloc(m->names, m->cap * sizeof *m->names);
        m->json = mdy_xrealloc(m->json, m->cap * sizeof *m->json);
    }
    m->names[m->count] = mdy_xstrdup(name);
    m->json[m->count] = mdy_xstrdup(data_json);
    m->count++;
}
void messages_clear(Messages *m) {
    for (size_t i = 0; i < m->count; i++) { free(m->names[i]); free(m->json[i]); }
    m->count = 0;
}

/* The indexes of a batch's jobs that settled one way. */
typedef struct { double *index; size_t count, cap; } Settled;

static void settled_add(Settled *s, double index) {
    if (s->count == s->cap) {
        s->cap = s->cap ? s->cap * 2 : 16;
        s->index = mdy_xrealloc(s->index, s->cap * sizeof *s->index);
    }
    s->index[s->count++] = index;
}

/* The broker's side, after a rebuild: send what this run has not sent. A
 * delivery's own publishes (`flush`) go out every time and say nothing —
 * the [deliver] line counts them. */
void bus_send(Bus *b, int dedupe, int announce) {
    Messages fresh = { 0 };
    for (size_t i = 0; i < b->messages.count; i++) {
        if (!dedupe) { collect_message(&fresh, b->messages.names[i], b->messages.json[i], 0); continue; }
        const char *name = b->messages.names[i];
        size_t name_len = strlen(name);
        size_t n = name_len + 1 + strlen(b->messages.json[i]) + 1;
        char *fp = mdy_xmalloc(n);
        snprintf(fp, n, "%s%c%s", name, 1, b->messages.json[i]);

        /*
         * ONE ENTRY PER NAME, holding that name's LAST value.
         *
         * Keeping every (name, value) ever sent does two things nobody wants.
         * It grows by an entry per distinct value for as long as the server is
         * up -- and the lookup is this loop, so a session pays for its own
         * history on every rebuild. And a value that changes BACK is then
         * silently dropped: `1 -> 2 -> 1 -> 3` sends three times, not four,
         * and a consumer never learns the value returned.
         *
         * What the list is for is not sending the SAME thing twice, and that
         * is a question about the value a name has NOW. So a name is found,
         * compared, and replaced. A rebuild that changes nothing still sends
         * nothing; a rebuild that changes a value sends it, whichever
         * direction it moved; and the list is bounded by the number of
         * message names a site has.
         *
         * There is no node behaviour to match here: mdy-docs' dev server
         * never publishes at all (src/serve.js -- "a publish that went out
         * would re-fire on every keystroke"), which is the same problem
         * answered by declining the feature. This server sends, so it needs
         * the rule.
         */
        size_t at = b->sent_count;
        for (size_t k = 0; k < b->sent_count; k++) {
            if (strncmp(b->sent[k], name, name_len) == 0 && b->sent[k][name_len] == 1) { at = k; break; }
        }
        if (at < b->sent_count) {
            if (strcmp(b->sent[at], fp) == 0) { free(fp); continue; }   /* unchanged */
            free(b->sent[at]);
            b->sent[at] = fp;
        } else {
            if (b->sent_count == b->sent_cap) {
                b->sent_cap = b->sent_cap ? b->sent_cap * 2 : 16;
                b->sent = mdy_xrealloc(b->sent, b->sent_cap * sizeof *b->sent);
            }
            b->sent[b->sent_count++] = fp;
        }
        collect_message(&fresh, name, b->messages.json[i], 0);
    }
    messages_clear(&b->messages);
    char ts[32];
    for (size_t i = 0; i < fresh.count; i++) {
        uint8_t *bytes = NULL; size_t len = 0;
        if (b->local) {
            /* The same route, the same binjson body, no POST — and the
             * index it landed at, which the JavaScript's local line shows. */
            char path[300]; snprintf(path, sizeof path, "/pub/%s", fresh.names[i]);
            BrokerReply reply = { 0 };
            int ok = mdy_engine_encode_json(b->engine, fresh.json[i], &bytes, &len) == 0 &&
                     broker_request(b->local, "POST", path, NULL, bytes, len, &reply) == 0 && reply.status >= 200 && reply.status < 300;
            if (!ok) {
                fprintf(stderr, "%s%s %s[send]%s publish: %s refused with %d%s\n", TS(ts), RED_OPEN(), RED_OPEN(), RED_CLOSE(), fresh.names[i], reply.status, RED_CLOSE());
            } else if (announce) {
                bjv *v = bjv_decode(reply.body, reply.body_len);
                printf("%s%s%s %s[send]%s %s %s#%.0f, %zu bytes%s\n", DIM_OPEN(), TS(ts), DIM_CLOSE(), MAGENTA_OPEN(), MAGENTA_CLOSE(),
                       fresh.names[i], DIM_OPEN(), bjv_number(v, "index", 0), len, DIM_CLOSE());
                bjv_free(v);
            }
            broker_reply_free(&reply);
            free(bytes);
            continue;
        }
        char url[2300];
        snprintf(url, sizeof url, "%s/pub/%s", b->o.broker, fresh.names[i]);
        /*
         * Zeroed at the declaration, and freed on every path: a refusal that
         * skipped http_response_free would keep the body of every non-2xx
         * answer for the life of a server meant to run all day. The zeroing
         * is what lets the free be unconditional — `encoded` can fail before
         * http_request has touched `r` at all.
         */
        HttpResponse r = { 0 };
        int encoded = mdy_engine_encode_json(b->engine, fresh.json[i], &bytes, &len) == 0;
        int answered = encoded &&
                       http_request("POST", url, "application/binjson", bytes, len, &r) == 0;
        if (!answered || r.status < 200 || r.status >= 300) {
            fprintf(stderr, "%s%s %s[send]%s %s: not sent (%s)%s\n", TS(ts), RED_OPEN(), RED_OPEN(), RED_CLOSE(), fresh.names[i],
                    encoded ? (r.status ? "refused" : r.error) : "not JSON", RED_CLOSE());
        } else if (announce) {
            printf("%s%s%s %s[send]%s %s %s(%zu bytes)%s\n", DIM_OPEN(), TS(ts), DIM_CLOSE(), MAGENTA_OPEN(), MAGENTA_CLOSE(),
                   fresh.names[i], DIM_OPEN(), len, DIM_CLOSE());
        }
        http_response_free(&r);
        free(bytes);
    }
    messages_clear(&fresh);
}

/* `PUT /push/>` — the catch-all, as a queue group, delivering to this server. */
int bus_register(Bus *b) {
    char url[2048];
    char cb[1024];
    size_t o = 0;
    for (const char *p = b->callback; *p && o + 4 < sizeof cb; p++) {
        if ((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || strchr("-._~", *p)) cb[o++] = *p;
        else o += (size_t)snprintf(cb + o, sizeof cb - o, "%%%02X", (unsigned char)*p);
    }
    cb[o] = 0;
    snprintf(url, sizeof url, "%s/push/>?consumer=%s&callback=%s&token=%s&group=%s", b->o.broker, b->o.consumer, cb, b->token, b->o.group);
    HttpResponse r;
    if (http_request("PUT", url, NULL, NULL, 0, &r) != 0) return -1;
    int ok = r.status >= 200 && r.status < 300;
    if (!ok) {
        char ts[32];
        fprintf(stderr, "%s %s[bus]%s bus: the broker refused the registration (%d%s%.*s)\n", TS(ts), RED_OPEN(), RED_CLOSE(),
                r.status, r.body_len ? " — " : "", (int)(r.body_len > 200 ? 200 : r.body_len), r.body ? (const char *)r.body : "");
    }
    http_response_free(&r);
    return ok ? 0 : -1;
}

/* A delivery: render the page the subject names, once per message. */
/* The retry policy, once per subject, before any attempt is spent. */
static void bus_policy(Bus *b, const char *subject) {
    if (seen_before(&b->policied, &b->policied_count, &b->policied_cap, subject)) return;
    char query[256];
    snprintf(query, sizeof query, "group=%s&max_attempts=%d&backoff_ms=%d&max_backoff_ms=%d",
             b->o.group, b->o.max_attempts, b->o.backoff, b->o.max_backoff);
    if (b->local) {
        char path[300]; snprintf(path, sizeof path, "/queue/%s", subject);
        BrokerReply r; broker_request(b->local, "PUT", path, query, NULL, 0, &r); broker_reply_free(&r);
        return;
    }
    char url[1024];
    snprintf(url, sizeof url, "%s/queue/%s?%s", b->o.broker, subject, query);
    HttpResponse pr;
    if (http_request("PUT", url, NULL, NULL, 0, &pr) == 0) http_response_free(&pr);
}

/*
 * The local bus: what mdy-bus's runLocalBus does. Every subject the store
 * holds, its policy set once, its leased jobs taken, each rendered against
 * the page it names and settled with done or fail. Rounds until a pass finds
 * nothing, since a render publishes onward.
 */
static void deliver_batch(Bus *b, const char *subject, const bjv *batch, int is_dead, int target,
                          Settled *done, Settled *failed);

void bus_drain(Bus *b) {
    /* Nothing to render them with: they stay queued rather than being taken
     * and found undeliverable. The drain after the next good build has them. */
    if (!b->local || !b->engine) return;
    for (int round = 0; round < 32; round++) {
        size_t handled = 0;
        BrokerReply r;
        if (broker_request(b->local, "GET", "/subjects", NULL, NULL, 0, &r) != 0 || r.status != 200) { broker_reply_free(&r); return; }
        bjv *subjects = bjv_decode(r.body, r.body_len);
        broker_reply_free(&r);
        if (!subjects || subjects->type != BJV_ARRAY) { bjv_free(subjects); return; }
        for (size_t i = 0; i < subjects->count; i++) {
            const bjv *name = subjects->items[i];
            if (name->type != BJV_STRING) continue;
            const char *subject = name->string;
            bus_policy(b, subject);
            char path[300], query[128];
            snprintf(path, sizeof path, "/take/%s", subject);
            snprintf(query, sizeof query, "group=%s&max=16&lease=30000", b->o.group);
            BrokerReply t;
            if (broker_request(b->local, "POST", path, query, NULL, 0, &t) != 0 || t.status != 200) { broker_reply_free(&t); continue; }
            bjv *jobs = bjv_decode(t.body, t.body_len);
            broker_reply_free(&t);
            if (!jobs || jobs->type != BJV_ARRAY || jobs->count == 0) { bjv_free(jobs); continue; }
            int is_dead = strlen(subject) > 5 && strcmp(subject + strlen(subject) - 5, ".dead") == 0;
            int target = mdy_engine_page_index(b->engine, subject);
            Settled done = { 0 }, failed = { 0 };
            deliver_batch(b, subject, jobs, is_dead, target, &done, &failed);
            for (size_t k = 0; k < done.count; k++) {
                snprintf(path, sizeof path, "/done/%s", subject);
                snprintf(query, sizeof query, "group=%s&index=%.0f", b->o.group, done.index[k]);
                BrokerReply x; broker_request(b->local, "POST", path, query, NULL, 0, &x); broker_reply_free(&x);
            }
            for (size_t k = 0; k < failed.count; k++) {
                snprintf(path, sizeof path, "/fail/%s", subject);
                snprintf(query, sizeof query, "group=%s&index=%.0f", b->o.group, failed.index[k]);
                BrokerReply x; broker_request(b->local, "POST", path, query, NULL, 0, &x); broker_reply_free(&x);
            }
            free(done.index); free(failed.index);
            handled += jobs->count;
            bjv_free(jobs);
        }
        bjv_free(subjects);
        if (handled == 0) return;
    }
    char ts[32];
    fprintf(stderr, "%s %s[bus]%s bus: still draining after 32 rounds; continuing next tick\n", TS(ts), RED_OPEN(), RED_CLOSE());
}

/*
 * One batch, delivered: every job rendered against the page its subject
 * names, and its index appended to `done` or `failed`. The lists GROW: over
 * HTTP the done list is how a partial batch tells the broker which of its
 * jobs are settled, and an index that fell off the end would be delivered
 * again.
 */
static void deliver_batch(Bus *b, const char *subject, const bjv *batch, int is_dead, int target,
                          Settled *done, Settled *failed) {
    char ts[32];
    if (target < 0 && !is_dead) {
        /*
         * No page of that name, and this is not the dead-letter channel: the
         * messages are RETURNED, so the broker's retry and dead-letter policy
         * has them. `is_dead` has to be honoured HERE as well: bus_deliver
         * guards before it calls and bus_drain does not, so ignoring it makes
         * the same situation finished-and-forgotten in-process and
         * dead-lettered over HTTP.
         *
         * It is reachable without anything exotic: publish to a page, delete
         * the page, rebuild. The name was valid when the message was made.
         */
        for (size_t i = 0; i < batch->count; i++) {
            double index = bjv_number(batch->items[i], "index", 0);
            settled_add(failed, index);
        }
        fprintf(stderr, "%s %s[return]%s %s %s(%s)%s — %zu message(s) returned; they will dead-letter\n",
                TS(ts), YELLOW_OPEN(), YELLOW_CLOSE(), subject, DIM_OPEN(),
                target == -2 ? "2 pages share that name" : "no page of that name here",
                DIM_CLOSE(), batch->count);
        return;
    }
    if (target < 0) {
        /* a dead-letter channel with no page: reported and finished */
        for (size_t i = 0; i < batch->count; i++) {
            char name[256]; snprintf(name, sizeof name, "%.*s", (int)(strlen(subject) - 5), subject);
            double index = bjv_number(batch->items[i], "index", 0);
            fprintf(stderr, "%s %s[dead]%s %s %s#%.0f%s %sno %s page — kept, see `mdy dead %s`%s\n", TS(ts), RED_OPEN(), RED_CLOSE(), subject,
                    DIM_OPEN(), index, DIM_CLOSE(), DIM_OPEN(), subject, name, DIM_CLOSE());
            settled_add(done, index);
        }
        return;
    }
    char *path = mdy_engine_document_path(b->engine, (size_t)target);
    /* a set typed into one file has no paths: name the document by its
     * place in the set, which is what its author can count */
    char where[64];
    if (!path) { snprintf(where, sizeof where, "document %d", target); path = strdup(where); }
    for (size_t i = 0; i < batch->count; i++) {
        const bjv *entry = batch->items[i];
        double index = bjv_number(entry, "index", 0);
        double attempts = bjv_number(entry, "attempts", 1);
        const bjv *payload = bjv_get(entry, "payload");
        bjv *value = payload && payload->type == BJV_BINARY ? bjv_decode(payload->bytes, payload->len) : NULL;
        /* an ENVELOPE entry is [headers, message] */
        const bjv *message = value;
        if (bjv_number(entry, "type", 0) == 0x10 && value && value->type == BJV_ARRAY && value->count == 2) message = value->items[1];
        char *data = message && message->type == BJV_OBJECT ? bjv_to_json(message) : NULL;
        char *inner = message && message->type != BJV_OBJECT ? bjv_to_json(message) : NULL;
        size_t rlen = (data ? strlen(data) : (inner ? strlen(inner) : 4)) + strlen(subject) + 160;
        /* Written through on both branches below. See xalloc.h. */
        char *reqjson = mdy_xmalloc(rlen);
        if (data) snprintf(reqjson, rlen, "%.*s%s\"msg\":{\"name\":\"%s\",\"index\":%.0f,\"attempts\":%.0f}}",
                           (int)strlen(data) - 1, data, strlen(data) > 2 ? "," : "", subject, index, attempts);
        else snprintf(reqjson, rlen, "{\"value\":%s,\"msg\":{\"name\":\"%s\",\"index\":%.0f,\"attempts\":%.0f}}",
                      inner ? inner : "null", subject, index, attempts);
        free(data); free(inner);

        double started = now_ms();
        char err[1024];
        messages_clear(&b->messages);
        char *html = mdy_engine_render_json(b->engine, (size_t)target, reqjson, err, sizeof err);
        free(reqjson);
        int ms = (int)(now_ms() - started);
        char attempt[64] = "";
        if (attempts > 1) snprintf(attempt, sizeof attempt, " %sattempt %.0f/%d%s", YELLOW_OPEN(), attempts, b->o.max_attempts, YELLOW_CLOSE());
        if (!html) {
            settled_add(failed, index);
            b->refusals++;
            int last = attempts >= b->o.max_attempts;
            char last_line[400];
            if (last) snprintf(last_line, sizeof last_line, "out of attempts — dead-lettering to %s.dead", subject);
            else snprintf(last_line, sizeof last_line, "returned; the broker will try again after a backoff");
            fprintf(stderr, "%s %s[refuse]%s %s %s#%.0f%s — %s%s%s threw after %dms%s\n  %s\n  %s%s%s\n", TS(ts), RED_OPEN(), RED_CLOSE(), subject,
                    DIM_OPEN(), index, DIM_CLOSE(), BOLD_OPEN(), path ? path : "?", BOLD_CLOSE(), ms, attempt, err, DIM_OPEN(), last_line, DIM_CLOSE());
        } else {
            size_t produced = b->messages.count;
            if (produced) bus_send(b, 0, 0);
            settled_add(done, index);
            char extra[64] = "";
            if (produced) snprintf(extra, sizeof extra, " %s(published %zu)%s", DIM_OPEN(), produced, DIM_CLOSE());
            printf("%s%s%s %s[%s]%s %s %s#%.0f%s → rendered %s%s%s in %s%dms%s%s%s\n", DIM_OPEN(), TS(ts), DIM_CLOSE(),
                   is_dead ? RED_OPEN() : GREEN_OPEN(), is_dead ? "dead" : "deliver", is_dead ? RED_CLOSE() : GREEN_CLOSE(), subject,
                   DIM_OPEN(), index, DIM_CLOSE(), BOLD_OPEN(), path ? path : "?", BOLD_CLOSE(), BOLD_OPEN(), ms, BOLD_CLOSE(), extra, attempt);
            if (b->show_output) {
                /* what the message caused, line by line, two spaces in */
                for (const char *line = html; *line; ) {
                    const char *nl = strchr(line, '\n');
                    size_t n = nl ? (size_t)(nl - line) : strlen(line);
                    if (n || nl) printf("  %.*s\n", (int)n, line);
                    if (!nl) break;
                    line = nl + 1;
                }
            }
            free(html);
        }
        bjv_free(value);
    }
    free(path);
}

/* ---- mdy [path] --publish: the document's messages, delivered here ------------
 *
 * What the document published, sent to a broker of this process's own and
 * delivered to the pages it names, following the chain a delivered page's
 * own publishes make — the one-shot form of what `mdy dev` keeps doing.
 * One attempt per message and no backoff, because there is no later to
 * wait for: a refusal goes straight to the dead-letter channel, where a
 * `.dead` page sees it in the same pass if the document has one. Each
 * delivered page's output is printed under its line, since here the
 * interesting thing about a message is what it caused.
 */
void bus_publish_document(mdy_engine *e, Messages *m) {
    Bus bus = { 0 };
    bus.o.broker = "in-process"; bus.o.consumer = "mdy-bus"; bus.o.group = "mdy";
    bus.o.max_attempts = 1;
    bus.engine = e;
    bus.messages = *m;
    memset(m, 0, sizeof *m);
    bus.show_output = 1;
    mdy_engine_on_publish(e, collect_message, &bus.messages);
    bus.local = broker_open();
    if (!bus.local) {
        fprintf(stderr, "%smdy: publish: cannot open a broker in this process%s\n", RED_OPEN(), RED_CLOSE());
    } else {
        setvbuf(stdout, NULL, _IOLBF, 0);   /* in step with stderr's refusals */
        bus_send(&bus, 0, 1);
        /* The store moves a job that is out of attempts to its dead-letter
         * channel on the take AFTER the failing one, so a pass that refused
         * something is followed by another, which finds the .dead subject
         * and delivers it — and so on, while refusals keep coming. */
        for (int pass = 0; pass < 8; pass++) {
            size_t before = bus.refusals;
            bus_drain(&bus);
            if (bus.refusals == before) break;
        }
        broker_close(bus.local);
    }
    mdy_engine_on_publish(e, collect_message, m);
    bus_free(&bus);
}

void bus_deliver(Bus *b, Httpd *s, HttpdRequest *req) {
    char auth[128], subject[256];
    char expect[64];
    snprintf(expect, sizeof expect, "Bearer %s", b->token);
    if (!httpd_header(req, "Authorization", auth, sizeof auth) || strcmp(auth, expect) != 0) { httpd_respond(s, req, 401, "text/plain", NULL, "", 0); return; }
    if (!httpd_header(req, "X-Sukkal-Subject", subject, sizeof subject)) { httpd_respond(s, req, 400, "text/plain", NULL, "", 0); return; }
    bjv *batch = bjv_decode(req->body, req->body_len);
    if (!batch || batch->type != BJV_ARRAY || batch->count == 0) { bjv_free(batch); httpd_respond(s, req, 400, "text/plain", NULL, "", 0); return; }

    /*
     * No build to deliver to. `mdy dev` goes on serving when the FIRST build
     * fails — there is nothing to fall back to and a broken save should not
     * take the server down with it — so the engine can be ABSENT here, and
     * reading documents off it would kill the server on the first message
     * delivered.
     *
     * 500 returns them to the broker, which brings them back after a backoff,
     * and by then a save may have fixed the build. Routing them with no engine
     * would find no page of that name, which is a different thing and settles
     * them away.
     */
    if (!b->engine) {
        char ts[32];
        fprintf(stderr, "%s %s[hold]%s %s %s(no build yet)%s — %zu message(s) returned; the broker will try again\n",
                TS(ts), YELLOW_OPEN(), YELLOW_CLOSE(), subject, DIM_OPEN(), DIM_CLOSE(), batch->count);
        bjv_free(batch);
        httpd_respond(s, req, 500, "text/plain", NULL, "", 0);
        fflush(stdout);
        return;
    }

    bus_policy(b, subject);

    int is_dead = strlen(subject) > 5 && strcmp(subject + strlen(subject) - 5, ".dead") == 0;
    int target = mdy_engine_page_index(b->engine, subject);
    if (target < 0 && !is_dead) {
        char ts[32];
        fprintf(stderr, "%s %s[return]%s %s %s(%s)%s — %zu message(s) returned; they will dead-letter\n", TS(ts), YELLOW_OPEN(), YELLOW_CLOSE(),
                subject, DIM_OPEN(), target == -2 ? "2 pages share that name" : "no page of that name here", DIM_CLOSE(), batch->count);
        bjv_free(batch);
        httpd_respond(s, req, 500, "text/plain", NULL, "", 0);
        return;
    }
    Settled done = { 0 }, failed = { 0 };
    deliver_batch(b, subject, batch, is_dead, target, &done, &failed);
    bjv_free(batch);
    if (done.count == 0) httpd_respond(s, req, 500, "text/plain", NULL, "", 0);
    else if (failed.count) {
        /* The header carries every settled index, however many there are. */
        mdy_sbuf hdr = { 0 };
        mdy_sbuf_puts(&hdr, "X-Sukkal-Done: ");
        for (size_t k = 0; k < done.count; k++) {
            char item[32];
            snprintf(item, sizeof item, "%s%.0f", k ? "," : "", done.index[k]);
            mdy_sbuf_puts(&hdr, item);
        }
        mdy_sbuf_puts(&hdr, "\r\n");
        httpd_respond(s, req, 200, "text/plain", hdr.s, "", 0);
        free(hdr.s);
    } else httpd_respond(s, req, 200, "text/plain", NULL, "", 0);
    free(done.index); free(failed.index);
    fflush(stdout);
}

void bus_free(Bus *b) {
    messages_clear(&b->messages); free(b->messages.names); free(b->messages.json);
    for (size_t i = 0; i < b->sent_count; i++) free(b->sent[i]);
    free(b->sent);
    for (size_t i = 0; i < b->policied_count; i++) free(b->policied[i]);
    free(b->policied);
    memset(b, 0, sizeof *b);
}
