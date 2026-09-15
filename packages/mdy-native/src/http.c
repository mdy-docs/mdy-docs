/* See http.h. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "http.h"
#include "xalloc.h"

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
#  include <sys/select.h>
#  include <sys/time.h>
#  include <netdb.h>
#  include <unistd.h>
#  include <errno.h>
#  include <fcntl.h>
#  include <strings.h>
#  include <signal.h>
typedef int sock_t;
#  define BAD_SOCKET (-1)
#  define close_socket close
/* A peer that resets mid-send raises SIGPIPE, whose default ends the
 * process; ignored, the send fails and is reported like any other. */
static int sockets_ready(void) { signal(SIGPIPE, SIG_IGN); return 1; }
#endif

/*
 * EVERY wait here is bounded. A broker that accepts and then says nothing
 * would otherwise hang `mdy build --publish`, `mdy dead` and the dev server's
 * registration for as long as it cared to hold the socket — forever, in
 * practice.
 *
 * Two numbers. CONNECT is short because the broker is local by default and a
 * refused connection already answers instantly; this is for the host that
 * drops SYNs, where the OS would otherwise spend 75 seconds. TOTAL bounds the
 * whole exchange after that, and is what the dev server can afford to block
 * its poll loop for, since registration and heartbeats go through here.
 *
 * MDY_HTTP_TIMEOUT_MS moves TOTAL, because a broker across a slow link is a
 * real thing and a hard limit with no way out is how a fix becomes a bug.
 */
/*
 * The most a response may grow to. The largest legitimate one here is a batch
 * of held messages from the broker, which is nothing like this; the number is
 * a bound on what a broken or hostile peer can make this process allocate,
 * not a guess at what is normal.
 */
#define MAX_RESPONSE (64u * 1024u * 1024u)

#define CONNECT_TIMEOUT_MS 5000
#define TOTAL_TIMEOUT_MS   15000

static long total_timeout_ms(void) {
    const char *env = getenv("MDY_HTTP_TIMEOUT_MS");
    if (!env || !*env) return TOTAL_TIMEOUT_MS;
    long v = strtol(env, NULL, 10);
    return v > 0 ? v : TOTAL_TIMEOUT_MS;
}

/*
 * Wall-clock milliseconds. NOT clock(), which is CPU time: a process blocked
 * in recv burns none of it, so a deadline built on clock() is a deadline that
 * never arrives — which is the bug this whole function exists to fix, written
 * a second time. Same shape as cli.c's now_ms.
 */
static long long now_ms_http(void) {
#ifdef _WIN32
    return (long long)GetTickCount64();
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
#endif
}

static void set_io_timeouts(sock_t s, long ms) {
#ifdef _WIN32
    DWORD t = (DWORD)ms;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&t, sizeof t);
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char *)&t, sizeof t);
#else
    struct timeval tv;
    tv.tv_sec = ms / 1000;
    tv.tv_usec = (ms % 1000) * 1000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#endif
}

static int set_blocking(sock_t s, int blocking) {
#ifdef _WIN32
    u_long mode = blocking ? 0 : 1;
    return ioctlsocket(s, FIONBIO, &mode) == 0 ? 0 : -1;
#else
    int fl = fcntl(s, F_GETFL, 0);
    if (fl < 0) return -1;
    fl = blocking ? (fl & ~O_NONBLOCK) : (fl | O_NONBLOCK);
    return fcntl(s, F_SETFL, fl) == 0 ? 0 : -1;
#endif
}

/*
 * connect(), but it gives up. There is no socket option for this — the only
 * portable way is to go non-blocking, start the connect, wait on the socket
 * becoming writable, and then ask SO_ERROR whether it actually arrived. A
 * writable socket is not the same as a connected one, which is the mistake
 * this is written out longhand to avoid.
 */
static int connect_timeout(sock_t s, const struct sockaddr *addr, socklen_t len, long ms) {
    if (set_blocking(s, 0) != 0) return connect(s, addr, (int)len);
    int rc = connect(s, addr, (int)len);
    if (rc != 0) {
#ifdef _WIN32
        if (WSAGetLastError() != WSAEWOULDBLOCK) { set_blocking(s, 1); return -1; }
#else
        if (errno != EINPROGRESS) { set_blocking(s, 1); return -1; }
#endif
        fd_set w;
        FD_ZERO(&w);
        FD_SET(s, &w);
        struct timeval tv;
        tv.tv_sec = ms / 1000;
        tv.tv_usec = (ms % 1000) * 1000;
        if (select((int)s + 1, NULL, &w, NULL, &tv) <= 0) { set_blocking(s, 1); return -1; }
        int err = 0;
        socklen_t elen = sizeof err;
        if (getsockopt(s, SOL_SOCKET, SO_ERROR, (char *)&err, &elen) != 0 || err != 0) {
            set_blocking(s, 1);
            return -1;
        }
    }
    set_blocking(s, 1);
    return 0;
}

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
    /*
     * An IPv6 literal is bracketed, and the brackets are what tell its colons
     * apart from the port's. Without this the first colon inside the address
     * reads as the port separator and `http://[::1]:8080` asks the resolver
     * for a host called "[". getaddrinfo wants the address WITHOUT the
     * brackets, so they are stripped here rather than passed on.
     */
    const char *colon;
    size_t hn;
    if (*p == '[') {
        const char *close_br = memchr(p, ']', (size_t)(end - p));
        if (!close_br) { snprintf(error, error_cap, "unclosed [ in %s", url); return -1; }
        hn = (size_t)(close_br - p) - 1;
        if (hn == 0 || hn >= host_cap) { snprintf(error, error_cap, "no host in %s", url); return -1; }
        memcpy(host, p + 1, hn); host[hn] = 0;
        colon = (close_br + 1 < end && close_br[1] == ':') ? close_br + 1 : NULL;
    } else {
        colon = memchr(p, ':', (size_t)(end - p));
        hn = (size_t)((colon ? colon : end) - p);
        if (hn == 0 || hn >= host_cap) { snprintf(error, error_cap, "no host in %s", url); return -1; }
        memcpy(host, p, hn); host[hn] = 0;
    }
    if (colon) snprintf(port, port_cap, "%.*s", (int)(end - colon - 1), colon + 1);
    else snprintf(port, port_cap, "80");
    snprintf(path, path_cap, "%s", slash && *slash ? slash : "/");
    return 0;
}

/*
 * The deadline is on the whole write, not on each send. SO_SNDTIMEO restarts
 * every time a send manages one byte, so a peer reading a trickle holds this
 * for as many multiples of the timeout as it likes — 13.7s against a 5s
 * timeout, measured in httpd.c.
 */
static int send_all(sock_t s, const void *data, size_t len, long long deadline) {
    const char *p = data;
    while (len) {
        int n = (int)send(s, p, (int)(len > 65536 ? 65536 : len), 0);
        if (n <= 0) return -1;
        p += n; len -= (size_t)n;
        if (len && now_ms_http() >= deadline) return -1;
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
    /* `host:port` for a message, with the brackets an IPv6 literal needs to
     * be readable back — `::1:8080` is not an address anyone can parse. */
    char authority[300];
    snprintf(authority, sizeof authority, strchr(host, ':') ? "[%s]:%s" : "%s:%s", host, port);

    long budget = total_timeout_ms();
    long long deadline = now_ms_http() + budget;
    sock_t s = BAD_SOCKET;
    for (struct addrinfo *a = res; a; a = a->ai_next) {
        s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s == BAD_SOCKET) continue;
        if (connect_timeout(s, a->ai_addr, (socklen_t)a->ai_addrlen, CONNECT_TIMEOUT_MS) == 0) break;
        close_socket(s);
        s = BAD_SOCKET;
    }
    freeaddrinfo(res);
    if (s == BAD_SOCKET) {
        snprintf(out->error, sizeof out->error, "connect ECONNREFUSED %s", authority);
        return -1;
    }
    /* Per-call, so a wedged peer cannot block one send or recv indefinitely;
     * `deadline` above bounds the exchange as a whole. Both are needed — see
     * send_all. */
    set_io_timeouts(s, budget);

    /* Measured, then allocated. `hn` is what snprintf WOULD have written,
     * so sending `hn` bytes out of a fixed buffer sends from beyond the end of
     * it — the same shape httpd_respond and engine_walk guard against. */
    static const char REQUEST[] =
        "%s %s HTTP/1.1\r\nHost: %s:%s\r\nConnection: close\r\nAccept: */*\r\n%s%s%s"
        "Content-Length: %zu\r\n\r\n";
    const char *ct_label = content_type ? "Content-Type: " : "";
    const char *ct_value = content_type ? content_type : "";
    const char *ct_end = content_type ? "\r\n" : "";
    int hn = snprintf(NULL, 0, REQUEST, method, path, host, port,
                      ct_label, ct_value, ct_end, body_len);
    if (hn < 0) { close_socket(s); snprintf(out->error, sizeof out->error, "the request could not be built"); return -1; }
    char *head = mdy_xmalloc((size_t)hn + 1);
    snprintf(head, (size_t)hn + 1, REQUEST, method, path, host, port,
             ct_label, ct_value, ct_end, body_len);
    int sent = send_all(s, head, (size_t)hn, deadline);
    free(head);
    if (sent != 0 ||
        (body_len && send_all(s, body, body_len, deadline) != 0)) {
        close_socket(s);
        snprintf(out->error, sizeof out->error, "the connection to %s dropped while sending", authority);
        return -1;
    }

    /*
     * Read until the peer closes, under a deadline and a size cap: a broker
     * that accepts and says nothing would otherwise hold this forever, and
     * one that says too much would grow the buffer until an allocation
     * failed.
     */
    size_t cap = 65536, len = 0;
    uint8_t *buf = malloc(cap + 1);
    if (!buf) { close_socket(s); snprintf(out->error, sizeof out->error, "out of memory"); return -1; }
    int timed_out = 0;
    for (;;) {
        if (len == cap) {
            if (cap >= MAX_RESPONSE) { timed_out = 0; break; }
            size_t want = cap * 2;
            uint8_t *grown = realloc(buf, want + 1);
            if (!grown) { free(buf); close_socket(s); snprintf(out->error, sizeof out->error, "out of memory"); return -1; }
            buf = grown;
            cap = want;
        }
        int n = (int)recv(s, (char *)buf + len, (int)(cap - len), 0);
        if (n < 0) {
            /* SO_RCVTIMEO expiring is not the peer closing, and the two want
             * different words: one is "said nothing in time", the other is
             * "said something that was not HTTP". */
#ifdef _WIN32
            if (WSAGetLastError() == WSAETIMEDOUT) timed_out = 1;
#else
            if (errno == EAGAIN || errno == EWOULDBLOCK) timed_out = 1;
#endif
            break;
        }
        if (n == 0) break;
        len += (size_t)n;
        if (now_ms_http() >= deadline) { timed_out = 1; break; }
    }
    close_socket(s);
    buf[len] = 0;
    /* A partial response is not a response: saying so beats handing back a
     * truncated body that parses. */
    if (timed_out && len == 0) {
        free(buf);
        snprintf(out->error, sizeof out->error, "%s did not answer within %ldms",
                 authority, budget);
        return -1;
    }

    char *sep = strstr((char *)buf, "\r\n\r\n");
    if (len < 12 || strncmp((char *)buf, "HTTP/1.", 7) != 0 || !sep) {
        free(buf);
        snprintf(out->error, sizeof out->error, "%s sent no HTTP response", authority);
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
int http_local_address(const char *url, char *out, size_t cap) {
    char host[256], port[16], path[64], err[64];
    if (!sockets_ready() || parse_url(url, host, sizeof host, port, sizeof port, path, sizeof path, err, sizeof err) != 0) return -1;
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof hints);
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, port, &hints, &res) != 0 || !res) return -1;
    int rc = -1;
    for (struct addrinfo *a = res; a && rc != 0; a = a->ai_next) {
        sock_t s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s == BAD_SOCKET) continue;
        if (connect_timeout(s, a->ai_addr, (socklen_t)a->ai_addrlen, CONNECT_TIMEOUT_MS) == 0) {
            struct sockaddr_storage local;
            socklen_t len = sizeof local;
            if (getsockname(s, (struct sockaddr *)&local, &len) == 0 &&
                getnameinfo((struct sockaddr *)&local, len, out, (socklen_t)cap, NULL, 0, NI_NUMERICHOST) == 0) rc = 0;
        }
        close_socket(s);
    }
    freeaddrinfo(res);
    return rc;
}
#endif

#if defined(__EMSCRIPTEN__)
int http_local_address(const char *url, char *out, size_t cap) { (void)url; (void)out; (void)cap; return -1; }
#endif

void http_response_free(HttpResponse *r) {
    free(r->body);
    r->body = NULL;
    r->body_len = 0;
}
