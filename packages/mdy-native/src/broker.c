/* See broker.h. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "broker.h"

#if defined(__EMSCRIPTEN__) || defined(_WIN32)
/* Absent here. sukkal's store opens its directory as a descriptor and works
 * relative to it — openat — which Windows has no equivalent of; and a page
 * has no dev loop to run a broker for. On both, `mdy dev` without --broker
 * holds messages and says so, as the JavaScript does without its wasm. */
Broker *broker_open(const char *dir) { (void)dir; return NULL; }
void broker_close(Broker *b) { (void)b; }
int broker_request(Broker *b, const char *method, const char *path, const char *query,
                   const uint8_t *body, size_t body_len, BrokerReply *out) {
    (void)b; (void)method; (void)path; (void)query; (void)body; (void)body_len;
    memset(out, 0, sizeof *out);
    return -1;
}
void broker_reply_free(BrokerReply *r) { (void)r; }
#else

#include "sukkal.h"

struct Broker {
    sukkal_app app;
    char *dir;
    /* the reply being composed */
    int status;
    uint8_t *body;
    size_t body_len, body_cap;
};

/* sukkal's clock lives in its libcurl transport, which is not linked. */
uint64_t bjm_now_ms(void) {
    return (uint64_t)time(NULL) * 1000u;
}

static void r_status(void *impl, int code) { ((struct Broker *)impl)->status = code; }
static void r_header(void *impl, const char *name, const char *value) { (void)impl; (void)name; (void)value; }
static void r_write(void *impl, const uint8_t *data, size_t len) {
    struct Broker *b = impl;
    if (b->body_len + len > b->body_cap) {
        size_t want = b->body_cap ? b->body_cap * 2 : 1024;
        while (want < b->body_len + len) want *= 2;
        b->body = realloc(b->body, want);
        b->body_cap = want;
    }
    memcpy(b->body + b->body_len, data, len);
    b->body_len += len;
}

Broker *broker_open(const char *dir) {
    Broker *b = calloc(1, sizeof *b);
    if (!b) return NULL;
    b->dir = strdup(dir);
    b->app.dir = b->dir;
    b->app.store = bjm_store_open(dir);
    if (!b->app.store) { free(b->dir); free(b); return NULL; }
    b->app.bld = bj_builder_new();
    b->app.started_s = (uint64_t)time(NULL);
    b->app.push = bjm_pusher_new(b->app.store, dir, SUKKAL_DEFAULT_BATCH);
    b->app.backend = "in-process";
    if (!b->app.bld || !b->app.push) { broker_close(b); return NULL; }
    return b;
}

void broker_close(Broker *b) {
    if (!b) return;
    if (b->app.push) bjm_pusher_free(b->app.push);
    if (b->app.bld) bj_builder_free(b->app.bld);
    if (b->app.store) bjm_store_free(b->app.store);
    free(b->body);
    free(b->dir);
    free(b);
}

int broker_request(Broker *b, const char *method, const char *path, const char *query,
                   const uint8_t *body, size_t body_len, BrokerReply *out) {
    memset(out, 0, sizeof *out);
    b->status = 200;
    b->body_len = 0;
    sukkal_req req;
    memset(&req, 0, sizeof req);
    req.ctx = &b->app;
    req.impl = (void *)(query ? query : "");
    req.method = method;
    req.path = path;
    req.body = body;
    req.body_len = body_len;
    req.content_type = body ? SUKKAL_MEDIA_TYPE : NULL;
    req.query_get = sukkal_query_from_string;
    sukkal_res res = { b, r_status, r_header, r_write };
    sukkal_dispatch(&req, &res);
    out->status = b->status;
    out->body = malloc(b->body_len + 1);
    memcpy(out->body, b->body, b->body_len);
    out->body[b->body_len] = 0;
    out->body_len = b->body_len;
    return 0;
}

void broker_reply_free(BrokerReply *r) {
    free(r->body);
    r->body = NULL;
    r->body_len = 0;
}
#endif
