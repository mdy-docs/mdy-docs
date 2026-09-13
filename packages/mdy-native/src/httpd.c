/* See httpd.h. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "httpd.h"
#include "xalloc.h"

#if defined(__EMSCRIPTEN__)
Httpd *httpd_listen(const char *host, int port, HttpdHandler handler, void *ud) { (void)host; (void)port; (void)handler; (void)ud; return NULL; }
int httpd_port(const Httpd *s) { (void)s; return 0; }
void httpd_poll(Httpd *s, int timeout_ms) { (void)s; (void)timeout_ms; }
const char *httpd_header(const HttpdRequest *req, const char *name, char *out, size_t cap) { (void)req; (void)name; (void)out; (void)cap; return NULL; }
void httpd_respond(Httpd *s, HttpdRequest *req, int status, const char *content_type, const char *extra_headers, const void *body, size_t len) { (void)s; (void)req; (void)status; (void)content_type; (void)extra_headers; (void)body; (void)len; }
void httpd_keep_open(Httpd *s, HttpdRequest *req, const char *head) { (void)s; (void)req; (void)head; }
void httpd_broadcast(Httpd *s, const void *data, size_t len) { (void)s; (void)data; (void)len; }
int httpd_secret(char *out, size_t cap) { if (out && cap) out[0] = '\0'; return -1; }
#else

#ifdef _WIN32
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <bcrypt.h>
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

/*
 * The most a single request may grow to before the connection is dropped.
 *
 * There was no limit: `recv` appended and the buffer doubled, so any peer that
 * kept writing made this process allocate until it died — and the largest
 * legitimate request here is a delivered message batch, which is nothing like
 * this. Generous on purpose, since the cost of being wrong in one direction is
 * a refused message and in the other is the machine. (B17.)
 */
#define MAX_REQUEST (16u * 1024u * 1024u)

/*
 * How long a write may block before the peer is written off.
 *
 * One thread serves everything, so a `send` that blocks stops the watcher, the
 * rebuilds and every other client with it. A dev server owes a slow reader
 * nothing: five seconds, then the connection is dropped. (B17.)
 */
#define SEND_TIMEOUT_MS 5000

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

    /* The socket is already bound and listening; there is no sensible way to
     * hand back "the server exists but has no state". See xalloc.h. */
    Httpd *s = mdy_xcalloc(1, sizeof *s);
    s->listener = fd;
    s->port = got;
    s->handler = handler;
    s->ud = ud;
    for (int i = 0; i < MAX_CONNS; i++) s->conns[i].fd = BAD_SOCKET;
    return s;
}

int httpd_port(const Httpd *s) { return s->port; }

/*
 * The OS's own randomness, hex. See httpd.h for why there is no fallback.
 *
 * /dev/urandom rather than getrandom(2) or arc4random_buf: the first is Linux
 * only and the second BSD and macOS, and this has to build on both plus mingw
 * with nothing conditional beyond what is already here. It is the interface
 * every POSIX target in this project actually has.
 */
int httpd_secret(char *out, size_t cap) {
    if (!out || cap < 3) { if (out && cap) out[0] = '\0'; return -1; }
    size_t want = (cap - 1) / 2;
    unsigned char bytes[64];
    if (want > sizeof bytes) want = sizeof bytes;
#ifdef _WIN32
    if (!BCRYPT_SUCCESS(BCryptGenRandom(NULL, bytes, (ULONG)want,
                                        BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
        out[0] = '\0';
        return -1;
    }
#else
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) { out[0] = '\0'; return -1; }
    size_t got = fread(bytes, 1, want, f);
    fclose(f);
    if (got != want) { out[0] = '\0'; return -1; }
#endif
    static const char hex_digits[] = "0123456789abcdef";
    for (size_t i = 0; i < want; i++) {
        out[i * 2]     = hex_digits[bytes[i] >> 4];
        out[i * 2 + 1] = hex_digits[bytes[i] & 15];
    }
    out[want * 2] = '\0';
    return 0;
}

/* A socket that cannot block this thread for longer than SEND_TIMEOUT_MS. */
static void set_write_timeout(sock_t fd) {
#ifdef _WIN32
    DWORD ms = SEND_TIMEOUT_MS;
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, (const char *)&ms, sizeof ms);
#else
    struct timeval tv;
    tv.tv_sec = SEND_TIMEOUT_MS / 1000;
    tv.tv_usec = (SEND_TIMEOUT_MS % 1000) * 1000;
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#endif
}

/*
 * A whole response, or the peer is written off.
 *
 * The deadline is on the WHOLE write and not on each send, which is the
 * difference between a bound and a hope: SO_SNDTIMEO restarts every time a
 * send manages even one byte, so a client reading a trickle — or a kernel
 * that grows the buffer under it — holds this thread for as many multiples of
 * the timeout as it likes. Measured before this loop had its own deadline: 5s
 * per send became 13.7s of stall for one paused client. (B17.)
 *
 * time(NULL) rather than a millisecond clock because seconds are the units
 * this is specified in and httpd.c has no clock of its own. The comparison is
 * `>=` and not `>` for the same reason: at one-second resolution a `>` gives
 * the peer a whole extra round of SO_SNDTIMEO, which measured as ~10s of
 * stall for a 5s budget.
 */
static int send_all(sock_t fd, const void *data, size_t len) {
    const char *p = data;
    time_t deadline = time(NULL) + (SEND_TIMEOUT_MS + 999) / 1000;
    while (len) {
        int n = (int)send(fd, p, (int)(len > 65536 ? 65536 : len), 0);
        if (n <= 0) return -1;
        p += n; len -= (size_t)n;
        if (len && time(NULL) >= deadline) return -1;
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

static const char *reason(int status) {
    switch (status) {
        case 200: return "OK"; case 400: return "Bad Request"; case 401: return "Unauthorized";
        case 404: return "Not Found"; case 500: return "Internal Server Error"; default: return "";
    }
}

void httpd_respond(Httpd *s, HttpdRequest *req, int status, const char *content_type,
                   const char *extra_headers, const void *body, size_t len) {
    Conn *c = &s->conns[req->connection];
    /*
     * The head GROWS, and it has to: this was a char[4096] with snprintf's
     * return used as the length to send — which is what snprintf WOULD have
     * written, not what it did. A caller with headers past 4096 bytes
     * therefore sent `n` bytes out of a 4096-byte buffer, reading off the end
     * of it, and what reached the client was a truncated header with no
     * terminating blank line. Reachable from `X-Sukkal-Done`, which names
     * every settled job of a partial batch (§3, and B27's mistake again).
     */
    char fixed[512];
    int n = snprintf(fixed, sizeof fixed,
                     "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nCache-Control: no-store\r\nConnection: close\r\n",
                     status, reason(status), content_type ? content_type : "application/octet-stream", len);
    mdy_sbuf head = { .seed = 1024 };
    mdy_sbuf_put(&head, fixed, n > 0 && (size_t)n < sizeof fixed ? (size_t)n : strlen(fixed));
    if (extra_headers) mdy_sbuf_puts(&head, extra_headers);
    mdy_sbuf_puts(&head, "\r\n");
    if (send_all(c->fd, head.s, head.len) == 0 && len) send_all(c->fd, body, len);
    free(head.s);
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
            else { set_write_timeout(fd); s->conns[slot].fd = fd; s->conns[slot].kept = 0; }
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
        /*
         * The cap, before the growth and not after: a peer that keeps writing
         * used to double this buffer until the allocation failed, and `in` was
         * assigned from realloc without checking, so the next recv wrote
         * through NULL. Both halves are the same line. (B17.)
         */
        if (c->in_len >= MAX_REQUEST) {
            static const char too_big[] =
                "HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n"
                "Connection: close\r\n\r\n";
            send_all(c->fd, too_big, sizeof too_big - 1);
            conn_free(c);
            continue;
        }
        if (c->in_len + 65536 + 1 > c->in_cap) {
            size_t want = c->in_cap ? c->in_cap * 2 : 131072;
            uint8_t *grown = realloc(c->in, want);
            if (!grown) { conn_free(c); continue; }
            c->in = grown;
            c->in_cap = want;
        }
        int r = (int)recv(c->fd, (char *)c->in + c->in_len, 65536, 0);
        if (r <= 0) { conn_free(c); continue; }
        c->in_len += (size_t)r;
        dispatch(s, i);
    }
}

#endif
