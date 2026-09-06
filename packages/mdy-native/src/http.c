/* See http.h. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "http.h"

#if defined(__EMSCRIPTEN__)
/* No sockets in a page: the wrapper around the wasm build is where a
 * request would go, and nothing in it publishes yet. */
int http_request(const char *method, const char *url, const char *content_type,
                 const uint8_t *body, size_t body_len, HttpResponse *out) {
    (void)method; (void)url; (void)content_type; (void)body; (void)body_len;
    memset(out, 0, sizeof *out);
    snprintf(out->error, sizeof out->error, "no network in the WebAssembly build");
    return -1;
}
#else

#ifdef _WIN32
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  define strncasecmp _strnicmp
typedef SOCKET sock_t;
#  define BAD_SOCKET INVALID_SOCKET
#  define close_socket closesocket
static int sockets_ready(void) {
    static int ready;
    if (!ready) { WSADATA w; if (WSAStartup(MAKEWORD(2, 2), &w) != 0) return 0; ready = 1; }
    return 1;
}
#else
#  include <sys/socket.h>
#  include <netdb.h>
#  include <unistd.h>
#  include <errno.h>
#  include <strings.h>
typedef int sock_t;
#  define BAD_SOCKET (-1)
#  define close_socket close
static int sockets_ready(void) { return 1; }
#endif

/* http://host[:port]/path?query, and nothing else. */
static int parse_url(const char *url, char *host, size_t host_cap, char *port, size_t port_cap,
                     char *path, size_t path_cap, char *error, size_t error_cap) {
    if (strncmp(url, "http://", 7) != 0) {
        snprintf(error, error_cap, "only http:// URLs are supported, not %s", url);
        return -1;
    }
    const char *p = url + 7;
    const char *slash = strchr(p, '/');
    const char *end = slash ? slash : p + strlen(p);
    const char *colon = memchr(p, ':', (size_t)(end - p));
    size_t hn = (size_t)((colon ? colon : end) - p);
    if (hn == 0 || hn >= host_cap) { snprintf(error, error_cap, "no host in %s", url); return -1; }
    memcpy(host, p, hn); host[hn] = 0;
    if (colon) snprintf(port, port_cap, "%.*s", (int)(end - colon - 1), colon + 1);
    else snprintf(port, port_cap, "80");
    snprintf(path, path_cap, "%s", slash && *slash ? slash : "/");
    return 0;
}

static int send_all(sock_t s, const void *data, size_t len) {
    const char *p = data;
    while (len) {
        int n = (int)send(s, p, (int)(len > 65536 ? 65536 : len), 0);
        if (n <= 0) return -1;
        p += n; len -= (size_t)n;
    }
    return 0;
}

static int header_value(const char *headers, const char *name, char *out, size_t cap) {
    size_t nlen = strlen(name);
    for (const char *line = headers; line && *line; ) {
        const char *nl = strstr(line, "\r\n");
        size_t len = nl ? (size_t)(nl - line) : strlen(line);
        if (len > nlen + 1 && strncasecmp(line, name, nlen) == 0 && line[nlen] == ':') {
            const char *v = line + nlen + 1;
            while (*v == ' ') v++;
            size_t vl = len - (size_t)(v - line);
            if (vl >= cap) vl = cap - 1;
            memcpy(out, v, vl); out[vl] = 0;
            return 1;
        }
        line = nl ? nl + 2 : NULL;
    }
    return 0;
}

/* Transfer-Encoding: chunked, undone in place. */
static size_t dechunk(uint8_t *body, size_t len) {
    size_t in = 0, out = 0;
    while (in < len) {
        char *endp;
        unsigned long n = strtoul((const char *)body + in, &endp, 16);
        const uint8_t *data = (const uint8_t *)strstr(endp, "\r\n");
        if (!data) break;
        data += 2;
        if (n == 0) break;
        if ((size_t)(data - body) + n > len) n = len - (size_t)(data - body);
        memmove(body + out, data, n);
        out += n;
        in = (size_t)(data - body) + n + 2;
    }
    return out;
}

int http_request(const char *method, const char *url, const char *content_type,
                 const uint8_t *body, size_t body_len, HttpResponse *out) {
    memset(out, 0, sizeof *out);
    if (!sockets_ready()) { snprintf(out->error, sizeof out->error, "sockets unavailable"); return -1; }

    char host[256], port[16], path[2048];
    if (parse_url(url, host, sizeof host, port, sizeof port, path, sizeof path, out->error, sizeof out->error) != 0) return -1;

    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof hints);
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, port, &hints, &res) != 0 || !res) {
        snprintf(out->error, sizeof out->error, "cannot resolve %s", host);
        return -1;
    }
    sock_t s = BAD_SOCKET;
    for (struct addrinfo *a = res; a; a = a->ai_next) {
        s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s == BAD_SOCKET) continue;
        if (connect(s, a->ai_addr, (int)a->ai_addrlen) == 0) break;
        close_socket(s);
        s = BAD_SOCKET;
    }
    freeaddrinfo(res);
    if (s == BAD_SOCKET) {
        snprintf(out->error, sizeof out->error, "connect ECONNREFUSED %s:%s", host, port);
        return -1;
    }

    char head[4096];
    int hn = snprintf(head, sizeof head,
                      "%s %s HTTP/1.1\r\nHost: %s:%s\r\nConnection: close\r\nAccept: */*\r\n%s%s%s"
                      "Content-Length: %zu\r\n\r\n",
                      method, path, host, port,
                      content_type ? "Content-Type: " : "", content_type ? content_type : "", content_type ? "\r\n" : "",
                      body_len);
    if (send_all(s, head, (size_t)hn) != 0 || (body_len && send_all(s, body, body_len) != 0)) {
        close_socket(s);
        snprintf(out->error, sizeof out->error, "the connection to %s:%s dropped while sending", host, port);
        return -1;
    }

    size_t cap = 65536, len = 0;
    uint8_t *buf = malloc(cap + 1);
    for (;;) {
        if (len == cap) { cap *= 2; buf = realloc(buf, cap + 1); }
        int n = (int)recv(s, (char *)buf + len, (int)(cap - len), 0);
        if (n <= 0) break;
        len += (size_t)n;
    }
    close_socket(s);
    buf[len] = 0;

    char *sep = strstr((char *)buf, "\r\n\r\n");
    if (len < 12 || strncmp((char *)buf, "HTTP/1.", 7) != 0 || !sep) {
        free(buf);
        snprintf(out->error, sizeof out->error, "%s:%s sent no HTTP response", host, port);
        return -1;
    }
    out->status = atoi((char *)buf + 9);
    *sep = 0;
    const char *headers = strstr((char *)buf, "\r\n");
    headers = headers ? headers + 2 : "";
    header_value(headers, "Content-Type", out->content_type, sizeof out->content_type);
    char te[64] = "", cl[32] = "";
    header_value(headers, "Transfer-Encoding", te, sizeof te);
    header_value(headers, "Content-Length", cl, sizeof cl);

    uint8_t *body_at = (uint8_t *)sep + 4;
    size_t body_n = len - (size_t)(body_at - buf);
    if (strstr(te, "chunked")) body_n = dechunk(body_at, body_n);
    else if (cl[0]) { size_t want = (size_t)strtoul(cl, NULL, 10); if (want < body_n) body_n = want; }
    out->body = malloc(body_n + 1);
    memcpy(out->body, body_at, body_n);
    out->body[body_n] = 0;
    out->body_len = body_n;
    free(buf);
    return 0;
}
#endif

void http_response_free(HttpResponse *r) {
    free(r->body);
    r->body = NULL;
    r->body_len = 0;
}
