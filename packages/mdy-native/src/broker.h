/*
 * sukkal, in this process.
 *
 * `mdy dev` with no --broker runs the broker itself: sukkal's store and
 * routes are C, they are linked into this binary, and a request is a direct
 * call to sukkal_dispatch — no socket, no port, no registration. That is
 * the seam sukkal's own WebAssembly build uses, and it is what mdy-bus
 * opens under node as the "in-process broker".
 *
 * What is NOT linked is sukkal's delivery transport, which is libcurl.
 * Nothing is lost by that here: the local bus pulls — take, render, done or
 * fail — exactly as mdy-bus's does, since a single thread delivering to
 * itself over a callback would be a thread waiting for itself.
 *
 * The store is a directory of entry logs, and here the directory is memory
 * (memns.h): no path, no files left behind, and no POSIX, which is what
 * lets this link on Windows and into the wasm build. It is the JavaScript's
 * memory provider, and like it, a message lives as long as the process.
 */
#ifndef MDY_BROKER_H
#define MDY_BROKER_H

#include <stddef.h>
#include <stdint.h>

typedef struct Broker Broker;

typedef struct {
    int status;
    uint8_t *body;      /* caller frees */
    size_t body_len;
} BrokerReply;

/* A broker over a fresh, empty store in memory. NULL on failure. */
Broker *broker_open(void);
void broker_close(Broker *b);

/* One request, answered in place. `query` is "a=1&b=2" or NULL; a body is
 * binjson. Returns 0 with the reply filled (whatever its status). */
int broker_request(Broker *b, const char *method, const char *path, const char *query,
                   const uint8_t *body, size_t body_len, BrokerReply *out);
void broker_reply_free(BrokerReply *r);

#endif
