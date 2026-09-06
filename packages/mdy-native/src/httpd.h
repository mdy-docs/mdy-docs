/*
 * The smallest HTTP/1.1 server `mdy dev` can be built on: one thread, a
 * select() loop, whole requests handed to one handler, and a connection
 * that can be KEPT — which is what a live-reload stream is, and what
 * sukkal's vendored http11c cannot do (it completes every response when the
 * handler returns). No TLS, no keep-alive for ordinary requests: a page is
 * one request, and a dev server is local.
 */
#ifndef MDY_HTTPD_H
#define MDY_HTTPD_H

#include <stddef.h>
#include <stdint.h>

typedef struct Httpd Httpd;

typedef struct {
    char method[16];
    char path[4096];        /* percent-decoded, no query */
    char query[4096];       /* raw, or "" */
    const char *headers;    /* the raw header block; see httpd_header() */
    const uint8_t *body;
    size_t body_len;
    int connection;         /* which connection, for httpd_keep_open */
} HttpdRequest;

/* Called once per complete request. Respond, or keep the connection. */
typedef void (*HttpdHandler)(Httpd *server, HttpdRequest *req, void *ud);

Httpd *httpd_listen(const char *host, int port, HttpdHandler handler, void *ud);
int httpd_port(const Httpd *s);
/* Accept, read, and dispatch what is ready, waiting up to `timeout_ms`. */
void httpd_poll(Httpd *s, int timeout_ms);
void httpd_close(Httpd *s);

/* A header of the request, or NULL. `out` receives the value. */
const char *httpd_header(const HttpdRequest *req, const char *name, char *out, size_t cap);
/* A query parameter of the request, percent-decoded, or NULL. */
const char *httpd_query(const HttpdRequest *req, const char *name, char *out, size_t cap);

/* A whole response, and the connection closes after it. `extra_headers`
 * is zero or more "Name: value\r\n" lines, or NULL. */
void httpd_respond(Httpd *s, HttpdRequest *req, int status, const char *content_type,
                   const char *extra_headers, const void *body, size_t len);

/* Send `head` (a complete status line and headers, ending in a blank line)
 * and keep the connection open to write to later. */
void httpd_keep_open(Httpd *s, HttpdRequest *req, const char *head);
/* Write to every kept connection; the ones that have gone are dropped. */
void httpd_broadcast(Httpd *s, const void *data, size_t len);
size_t httpd_kept_count(const Httpd *s);

#endif
