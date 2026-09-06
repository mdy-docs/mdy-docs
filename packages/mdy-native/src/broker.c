/* See broker.h. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#  include <windows.h>
#else
#  include <sys/time.h>
#endif

#include "broker.h"
#include "memns.h"

#include "sukkal.h"

struct Broker {
    sukkal_app app;
    bj_ns ns;
    /* the reply being composed */
    int status;
    uint8_t *body;
    size_t body_len, body_cap;
};

/* Milliseconds since the epoch. sukkal's own clock lives in its libcurl
 * transport, which is not linked; push.c still asks for it by this name,
 * and the store is given the same one so leases and backoffs agree. */
uint64_t bjm_now_ms(void) {
#ifdef _WIN32
    /* 100ns ticks since 1601; 11644473600 s to 1970 */
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    uint64_t ticks = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return ticks / 10000u - 11644473600000ull;
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint64_t)tv.tv_sec * 1000u + (uint64_t)tv.tv_usec / 1000u;
#endif
}
static uint64_t store_clock(void *ctx) { (void)ctx; return bjm_now_ms(); }

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

Broker *broker_open(void) {
    Broker *b = calloc(1, sizeof *b);
    if (!b) return NULL;
    if (memns_open(&b->ns) != BJ_OK) { free(b); return NULL; }
    b->app.dir = "";
    b->app.store = bjm_store_open_ns(b->ns);
    if (!b->app.store) { memns_free(&b->ns); free(b); return NULL; }
    bjm_store_set_clock(b->app.store, store_clock, NULL);
    bjm_store_set_listing(b->app.store, memns_listing, b->ns.ctx);
    bjm_store_set_adopt(b->app.store, memns_adopt, b->ns.ctx);
    b->app.bld = bj_builder_new();
    b->app.started_s = (uint64_t)time(NULL);
    b->app.push = bjm_pusher_new(b->app.store, "", SUKKAL_DEFAULT_BATCH);
    b->app.backend = "in-process";
    if (!b->app.bld || !b->app.push) { broker_close(b); return NULL; }
    return b;
}

void broker_close(Broker *b) {
    if (!b) return;
    if (b->app.push) bjm_pusher_free(b->app.push);
    if (b->app.bld) bj_builder_free(b->app.bld);
    if (b->app.store) bjm_store_free(b->app.store);
    memns_free(&b->ns);
    free(b->body);
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
