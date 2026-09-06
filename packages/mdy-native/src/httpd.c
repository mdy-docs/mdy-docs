/* See httpd.h. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "httpd.h"

#if defined(__EMSCRIPTEN__)
Httpd *httpd_listen(const char *host, int port, HttpdHandler handler, void *ud) { (void)host; (void)port; (void)handler; (void)ud; return NULL; }
int httpd_port(const Httpd *s) { (void)s; return 0; }
void httpd_poll(Httpd *s, int timeout_ms) { (void)s; (void)timeout_ms; }
void httpd_close(Httpd *s) { (void)s; }
const char *httpd_header(const HttpdRequest *req, const char *name, char *out, size_t cap) { (void)req; (void)name; (void)out; (void)cap; return NULL; }
const char *httpd_query(const HttpdRequest *req, const char *name, char *out, size_t cap) { (void)req; (void)name; (void)out; (void)cap; return NULL; }
void httpd_respond(Httpd *s, HttpdRequest *req, int status, const char *content_type, const char *extra_headers, const void *body, size_t len) { (void)s; (void)req; (void)status; (void)content_type; (void)extra_headers; (void)body; (void)len; }
void httpd_keep_open(Httpd *s, HttpdRequest *req, const char *head) { (void)s; (void)req; (void)head; }
void httpd_broadcast(Httpd *s, const void *data, size_t len) { (void)s; (void)data; (void)len; }
size_t httpd_kept_count(const Httpd *s) { (void)s; return 0; }
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
#  include <sys/select.h>
#  include <netdb.h>
#  include <netinet/in.h>
#  include <unistd.h>
#  include <strings.h>
#  include <fcntl.h>
#  include <signal.h>
typedef int sock_t;
#  define BAD_SOCKET (-1)
#  define close_socket close
static int sockets_ready(void) { signal(SIGPIPE, SIG_IGN); return 1; }
#endif

#define MAX_CONNS 256

typedef struct {
    sock_t fd;
    int kept;               /* a stream: written to on broadcast, never read again */
    uint8_t *in;
    size_t in_len, in_cap;
} Conn;

struct Httpd {
    sock_t listener;
    int port;
    HttpdHandler handler;
    void *ud;
    Conn conns[MAX_CONNS];
};

static void conn_free(Conn *c) {
    if (c->fd != BAD_SOCKET) close_socket(c->fd);
    c->fd = BAD_SOCKET;
    free(c->in);
    c->in = NULL; c->in_len = c->in_cap = 0; c->kept = 0;
}

Httpd *httpd_listen(const char *host, int port, HttpdHandler handler, void *ud) {
    if (!sockets_ready()) return NULL;
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof hints);
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_PASSIVE;
    char portstr[16];
    snprintf(portstr, sizeof portstr, "%d", port);
    if (getaddrinfo(host, portstr, &hints, &res) != 0 || !res) return NULL;
    sock_t fd = BAD_SOCKET;
    for (struct addrinfo *a = res; a; a = a->ai_next) {
        fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (fd == BAD_SOCKET) continue;
        int one = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, (const char *)&one, sizeof one);
        if (bind(fd, a->ai_addr, (int)a->ai_addrlen) == 0 && listen(fd, 64) == 0) break;
        close_socket(fd);
        fd = BAD_SOCKET;
    }
    freeaddrinfo(res);
    if (fd == BAD_SOCKET) return NULL;

    struct sockaddr_storage bound;
    socklen_t blen = sizeof bound;
    int got = port;
    if (getsockname(fd, (struct sockaddr *)&bound, &blen) == 0) {
        if (bound.ss_family == AF_INET) got = ntohs(((struct sockaddr_in *)&bound)->sin_port);
        else if (bound.ss_family == AF_INET6) got = ntohs(((struct sockaddr_in6 *)&bound)->sin6_port);
    }

    Httpd *s = calloc(1, sizeof *s);
    s->listener = fd;
    s->port = got;
    s->handler = handler;
    s->ud = ud;
    for (int i = 0; i < MAX_CONNS; i++) s->conns[i].fd = BAD_SOCKET;
    return s;
}

int httpd_port(const Httpd *s) { return s->port; }

static int send_all(sock_t fd, const void *data, size_t len) {
    const char *p = data;
    while (len) {
        int n = (int)send(fd, p, (int)(len > 65536 ? 65536 : len), 0);
        if (n <= 0) return -1;
        p += n; len -= (size_t)n;
    }
    return 0;
}

static int hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
static void percent_decode(const char *in, size_t n, char *out, size_t cap) {
    size_t o = 0;
    for (size_t i = 0; i < n && o + 1 < cap; i++) {
        if (in[i] == '%' && i + 2 < n && hex(in[i + 1]) >= 0 && hex(in[i + 2]) >= 0) {
            out[o++] = (char)(hex(in[i + 1]) * 16 + hex(in[i + 2]));
            i += 2;
        } else if (in[i] == '+') out[o++] = ' ';
        else out[o++] = in[i];
    }
    out[o] = 0;
}

const char *httpd_header(const HttpdRequest *req, const char *name, char *out, size_t cap) {
    size_t nlen = strlen(name);
    for (const char *line = req->headers; line && *line; ) {
        const char *nl = strstr(line, "\r\n");
        size_t len = nl ? (size_t)(nl - line) : strlen(line);
        if (len > nlen + 1 && strncasecmp(line, name, nlen) == 0 && line[nlen] == ':') {
            const char *v = line + nlen + 1;
            while (*v == ' ') v++;
            size_t vl = len - (size_t)(v - line);
            if (vl >= cap) vl = cap - 1;
            memcpy(out, v, vl); out[vl] = 0;
            return out;
        }
        line = nl ? nl + 2 : NULL;
    }
    return NULL;
}

const char *httpd_query(const HttpdRequest *req, const char *name, char *out, size_t cap) {
    size_t nlen = strlen(name);
    for (const char *p = req->query; p && *p; ) {
        const char *amp = strchr(p, '&');
        size_t len = amp ? (size_t)(amp - p) : strlen(p);
        if (len > nlen && strncmp(p, name, nlen) == 0 && p[nlen] == '=') {
            percent_decode(p + nlen + 1, len - nlen - 1, out, cap);
            return out;
        }
        p = amp ? amp + 1 : NULL;
    }
    return NULL;
}

static const char *reason(int status) {
    switch (status) {
        case 200: return "OK"; case 400: return "Bad Request"; case 401: return "Unauthorized";
        case 404: return "Not Found"; case 500: return "Internal Server Error"; default: return "";
    }
}

void httpd_respond(Httpd *s, HttpdRequest *req, int status, const char *content_type,
                   const char *extra_headers, const void *body, size_t len) {
    Conn *c = &s->conns[req->connection];
    char head[4096];
    int n = snprintf(head, sizeof head,
                     "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nCache-Control: no-store\r\nConnection: close\r\n%s\r\n",
                     status, reason(status), content_type ? content_type : "application/octet-stream", len,
                     extra_headers ? extra_headers : "");
    if (send_all(c->fd, head, (size_t)n) == 0 && len) send_all(c->fd, body, len);
    conn_free(c);
}

void httpd_keep_open(Httpd *s, HttpdRequest *req, const char *head) {
    Conn *c = &s->conns[req->connection];
    if (send_all(c->fd, head, strlen(head)) != 0) { conn_free(c); return; }
    c->kept = 1;
    free(c->in); c->in = NULL; c->in_len = c->in_cap = 0;
}

void httpd_broadcast(Httpd *s, const void *data, size_t len) {
    for (int i = 0; i < MAX_CONNS; i++) {
        Conn *c = &s->conns[i];
        if (c->fd == BAD_SOCKET || !c->kept) continue;
        if (send_all(c->fd, data, len) != 0) conn_free(c);
    }
}

size_t httpd_kept_count(const Httpd *s) {
    size_t n = 0;
    for (int i = 0; i < MAX_CONNS; i++) if (s->conns[i].fd != BAD_SOCKET && s->conns[i].kept) n++;
    return n;
}

/* A complete request in the buffer, or not yet. */
static int dispatch(Httpd *s, int index) {
    Conn *c = &s->conns[index];
    c->in[c->in_len] = 0;
    char *sep = strstr((char *)c->in, "\r\n\r\n");
    if (!sep) return 0;
    *sep = 0;
    HttpdRequest req;
    memset(&req, 0, sizeof req);
    req.connection = index;
    const char *line_end = strstr((char *)c->in, "\r\n");
    req.headers = line_end ? line_end + 2 : "";
    /* the request line: METHOD SP target SP version */
    char target[8192] = "";
    sscanf((char *)c->in, "%15s %8191s", req.method, target);
    char *q = strchr(target, '?');
    if (q) { *q = 0; snprintf(req.query, sizeof req.query, "%s", q + 1); }
    percent_decode(target, strlen(target), req.path, sizeof req.path);

    char cl[32] = "";
    size_t body_len = httpd_header(&req, "Content-Length", cl, sizeof cl) ? (size_t)strtoul(cl, NULL, 10) : 0;
    const uint8_t *body = (const uint8_t *)sep + 4;
    size_t have = c->in_len - (size_t)(body - c->in);
    if (have < body_len) { *sep = '\r'; return 0; } /* wait for the rest */
    req.body = body;
    req.body_len = body_len;
    s->handler(s, &req, s->ud);
    /* an ordinary response closed the connection; a kept one stays */
    return 1;
}

void httpd_poll(Httpd *s, int timeout_ms) {
    fd_set readable;
    FD_ZERO(&readable);
    FD_SET(s->listener, &readable);
    sock_t maxfd = s->listener;
    for (int i = 0; i < MAX_CONNS; i++) {
        Conn *c = &s->conns[i];
        if (c->fd == BAD_SOCKET) continue;
        FD_SET(c->fd, &readable);
        if (c->fd > maxfd) maxfd = c->fd;
    }
    struct timeval tv = { timeout_ms / 1000, (timeout_ms % 1000) * 1000 };
    int n = select((int)maxfd + 1, &readable, NULL, NULL, &tv);
    if (n <= 0) return;

    if (FD_ISSET(s->listener, &readable)) {
        sock_t fd = accept(s->listener, NULL, NULL);
        if (fd != BAD_SOCKET) {
            int slot = -1;
            for (int i = 0; i < MAX_CONNS; i++) if (s->conns[i].fd == BAD_SOCKET) { slot = i; break; }
            if (slot < 0) close_socket(fd);
            else { s->conns[slot].fd = fd; s->conns[slot].kept = 0; }
        }
    }
    for (int i = 0; i < MAX_CONNS; i++) {
        Conn *c = &s->conns[i];
        if (c->fd == BAD_SOCKET || !FD_ISSET(c->fd, &readable)) continue;
        if (c->kept) {
            /* a kept connection only ever tells us it closed */
            char probe[64];
            int r = (int)recv(c->fd, probe, sizeof probe, 0);
            if (r <= 0) conn_free(c);
            continue;
        }
        if (c->in_len + 65536 + 1 > c->in_cap) {
            c->in_cap = c->in_cap ? c->in_cap * 2 : 131072;
            c->in = realloc(c->in, c->in_cap);
        }
        int r = (int)recv(c->fd, (char *)c->in + c->in_len, 65536, 0);
        if (r <= 0) { conn_free(c); continue; }
        c->in_len += (size_t)r;
        dispatch(s, i);
    }
}

void httpd_close(Httpd *s) {
    if (!s) return;
    for (int i = 0; i < MAX_CONNS; i++) conn_free(&s->conns[i]);
    close_socket(s->listener);
    free(s);
}
#endif
