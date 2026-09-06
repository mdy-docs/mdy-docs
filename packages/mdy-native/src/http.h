/*
 * The smallest HTTP/1.1 client that talks to a sukkal broker: one request,
 * one response, over a socket, `Connection: close`. No TLS, no redirects,
 * no keep-alive — a broker is local, and every call the CLI makes is a
 * request line, a few headers, a body and a status back.
 *
 * Why it exists at all: sukkal's own client is libcurl, and this binary
 * depends on no system library. The platform split is fsx.c's — BSD sockets
 * everywhere, winsock on Windows, and nothing in the wasm build, where a
 * browser's network is the page's business.
 */
#ifndef MDY_HTTP_H
#define MDY_HTTP_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    int status;              /* the response's status code; 0 when none arrived */
    char content_type[128];  /* its Content-Type, or "" */
    uint8_t *body;           /* its body, NUL-terminated for convenience; caller frees */
    size_t body_len;
    char error[256];         /* why no response arrived, when status is 0 */
} HttpResponse;

/*
 * One request. `url` is http://host[:port]/path[?query]; `content_type` and
 * `body` may be NULL for a bodiless request. Returns 0 when a response was
 * read (whatever its status) and -1 when none was, with `error` saying why.
 */
int http_request(const char *method, const char *url, const char *content_type,
                 const uint8_t *body, size_t body_len, HttpResponse *out);

void http_response_free(HttpResponse *r);

#endif
