/*
 * The messaging half of `mdy dev` and `mdy [path] --publish`: what
 * @mdy-docs/mdy-bus does, request for request, in the one process that
 * already has the set.
 *
 * What a build publishes is sent to the broker — once per run per (name,
 * data) — and a registration with the broker (`PUT /push/>`, the catch-all,
 * in a queue group) brings deliveries back as POSTs to /mdy/<consumer> on the
 * dev server, each rendering the page its subject names with the message
 * bound as `req`.
 *
 * Without --broker, the broker is this process's own (broker.h): sukkal's
 * store and routes over a directory in memory, which is what mdy-bus opens
 * when no --broker is given. There the bus pulls rather than being called
 * back, since a thread delivering to itself over a callback would be waiting
 * for itself.
 */
#ifndef MDY_DEVBUS_H
#define MDY_DEVBUS_H
#include <stddef.h>

#include "broker.h"
#include "engine.h"
#include "httpd.h"

/* What a build published, in order: an on_publish callback and its store. */
typedef struct { char **names; char **json; size_t count, cap; } Messages;
void collect_message(void *ud, const char *name, const char *data_json, size_t doc_index);
void messages_clear(Messages *m);

typedef struct {
    const char *broker;         /* the URL that answered --broker, or "in-process" */
    const char *consumer, *group;
    int max_attempts, backoff, max_backoff;
} BusOptions;

typedef struct {
    BusOptions o;
    mdy_engine *engine;         /* the last good build's set, which deliveries render against; NULL until there is one */
    Messages messages;          /* what the last render made, taken by whoever sends */
    Broker *local;              /* a broker of this process's own, or NULL when --broker named one */
    char token[40];             /* what a delivery must present */
    char callback[512];         /* where the broker delivers: the dev server's /mdy/<consumer> */
    char **sent; size_t sent_count, sent_cap;   /* one `name\1data` per NAME: see bus_send */
    char **policied; size_t policied_count, policied_cap;   /* subjects whose retry policy is set */
    size_t refusals;            /* deliveries that threw, ever — a one-shot drains again after one */
    int show_output;            /* `mdy [path] --publish`: a delivered page's output, under its line */
} Bus;

/* After a rebuild: send what this run has not sent. `dedupe` skips a (name,
 * data) already sent; `announce` prints a [send] line per message. */
void bus_send(Bus *b, int dedupe, int announce);
/* `PUT /push/>` — the catch-all, as a queue group, delivering to `callback`.
 * 0 on success. Repeated as a heartbeat. */
int bus_register(Bus *b);
/* The local bus: every subject the store holds, its leased jobs taken and
 * each rendered against the page it names. Nothing without `local`. */
void bus_drain(Bus *b);
/* A delivery from a remote broker: POST /mdy/<consumer>. Answers the request. */
void bus_deliver(Bus *b, Httpd *s, HttpdRequest *req);
/* What the bus allocated: its lists and its messages. Not the engine. */
void bus_free(Bus *b);

/*
 * What the document published, sent to a broker of this process's own and
 * delivered to the pages it names, following the chain a delivered page's
 * own publishes make — the one-shot form of what `mdy dev` keeps doing.
 * `m` is taken and left empty.
 */
void bus_publish_document(mdy_engine *e, Messages *m);

#endif
