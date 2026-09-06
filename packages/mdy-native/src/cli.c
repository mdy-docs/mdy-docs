/*
 * `mdy` — the command, with no JavaScript engine anywhere in it but lamassu.
 *
 * bin/mdy.js's surface, subcommand for subcommand and flag for flag, held to
 * it by test/cli.test.js run against this binary (`make check-cli`): every
 * message, exit code and output shape below is the JavaScript's, because the
 * tests assert on them and a pipeline reading either binary's output must not
 * care which one wrote it.
 *
 *   mdy [path] [options]      one document (a file, a directory, or stdin)
 *   mdy build [dir] [options]  a whole site — see docs/cli-plan.md
 *   mdy dev / mdy dead         later phases of the same plan
 *
 * Where an emit lands is the embedder's business, and this embedder writes
 * files. `static/` is copied through verbatim, last, exactly as buildSite
 * does — a page emitted to the same path wins, since a document that meant to
 * write a file should not be silently shadowed by a stray asset.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>
#ifdef _WIN32
#  include <io.h>
#  include <fcntl.h>
#  include <windows.h>
#  define isatty _isatty
#  define fileno _fileno
#else
#  include <unistd.h>
#  include <sys/time.h>
#endif

#include "bjval.h"
#include "engine.h"
#include "fsx.h"
#include "http.h"
#include "mdydoc.h"
#include "mdyscript.h"
#include "mdyyaml.h"
#include "watch.h"
#include "httpd.h"

/* ---- presentation ------------------------------------------------------------
 *
 * Minimal ANSI colour, as bin/mdy.js does it: honours NO_COLOR and FORCE_COLOR,
 * and off when stdout is not a terminal — piped output, or a test harness
 * capturing it, never gets an escape code.
 */
static int use_color;
static const char *esc(const char *code) { return use_color ? code : ""; }
#define BOLD_OPEN()    esc("\x1b[1m")
#define BOLD_CLOSE()   esc("\x1b[22m")
#define DIM_OPEN()     esc("\x1b[2m")
#define DIM_CLOSE()    esc("\x1b[22m")
#define RED_OPEN()     esc("\x1b[31m")
#define RED_CLOSE()    esc("\x1b[39m")
#define GREEN_OPEN()   esc("\x1b[32m")
#define GREEN_CLOSE()  esc("\x1b[39m")
#define YELLOW_OPEN()  esc("\x1b[33m")
#define YELLOW_CLOSE() esc("\x1b[39m")
#define BLUE_OPEN()    esc("\x1b[34m")
#define BLUE_CLOSE()   esc("\x1b[39m")
#define CYAN_OPEN()    esc("\x1b[36m")
#define CYAN_CLOSE()   esc("\x1b[39m")
#define MAGENTA_OPEN() esc("\x1b[35m")
#define MAGENTA_CLOSE() esc("\x1b[39m")
/* an open/close pair, for a call that takes both */
#define BLUE   BLUE_OPEN(), BLUE_CLOSE()
#define GREEN  GREEN_OPEN(), GREEN_CLOSE()

static double now_ms(void) {
#ifdef _WIN32
    return (double)GetTickCount64();
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (double)tv.tv_sec * 1000.0 + (double)tv.tv_usec / 1000.0;
#endif
}

/* "mdy: <text>", red on a terminal, and out. Library errors already carry
 * the prefix; it is not doubled. */
static void fail(const char *text) {
    if (strncmp(text, "mdy: ", 5) == 0) text += 5;
    fprintf(stderr, "%smdy: %s%s\n", RED_OPEN(), text, RED_CLOSE());
    exit(1);
}

/* ---- usage, the JavaScript's text ---------------------------------------- */

static const char SITE_USAGE[] =
"mdy — build sites from mdy documents.\n"
"\n"
"Usage:\n"
"  mdy build [site-dir] [--out <dir>] [--drafts] [--future] [--entry <path>]\n"
"            [--publish [--broker <url>]]\n"
"      render the site (default dir: ., out: <site-dir>/dist)\n"
"  mdy dev [site-dir] [--port <n>] [--drafts] [--future] [--entry <path>]\n"
"          [--broker <url>] [--consumer <name>] [--group <name>]\n"
"          [--max-attempts <n>] [--backoff <ms>] [--max-backoff <ms>]\n"
"      development server: watch, rebuild, live reload (default port: 4321)\n"
"      — and, when a broker answers, publish and deliver messages too.\n"
"      For development only: it rebuilds the whole site on every save and\n"
"      injects a live-reload script into every page. Deploy `mdy build`'s\n"
"      output.\n"
"  mdy dead <page-name> [--broker <url>] [--requeue <index>]\n"
"      what could not be rendered, and putting one back\n"
"\n"
"On a terminal, build and dev keep the [read]/[write] line per file and add\n"
"a progress line beneath it — files read, documents ingested, then pages\n"
"rendered, with a real percentage once a previous build has said how many\n"
"pages to expect. Redirected output gets the per-file lines alone, so a\n"
"pipeline reading them is unaffected.\n"
"\n"
"Every site is a script-defined site: site-dir's entry document (main.mdy,\n"
"or --entry <path>) decides everything itself — content, URLs, layouts,\n"
"output shape — via $/$.find/$.render/$.emit. --drafts/--future are\n"
"threaded through as plain context booleans for it to interpret, not\n"
"filtered here.\n"
"\n"
"$.publish(name, data) queues a message for another page — $.render\n"
"deferred and made durable. Messages are collected during the build and\n"
"sent only once it has fully succeeded, so a failed build publishes\n"
"nothing and a watch-mode rebuild does not re-fire what the last one sent.\n"
"Without --publish they are reported and dropped; with it they go to a\n"
"sukkal broker (--broker, default http://127.0.0.1:8080).\n"
"\n"
"`mdy dev` is also the other end. With a broker reachable it sends what a\n"
"rebuild publishes and renders whichever page each delivered message is\n"
"addressed to, with the message bound as `req` — so the whole loop is one\n"
"process and editing a page changes what the next message renders. Nothing\n"
"subscribes and no front matter marks a page as a handler: a page is\n"
"addressable because it exists, and its name is its path without the\n"
"extension, \"/\" written as \".\". A render that throws does not acknowledge,\n"
"so the message comes back; pages reached this way have to be idempotent.\n";

static const char USAGE[] =
"mdy — generate a document from an mdy template, or a script-defined site.\n"
"\n"
"Usage:\n"
"  mdy [path] [options]\n"
"  mdy build [site-dir] [options]   render a whole site — see: mdy build --help\n"
"  mdy dev [site-dir] [options]     development server — see: mdy dev --help\n"
"\n"
"Arguments:\n"
"  path                   A .mdy file, a directory, or \"-\"/omitted for stdin.\n"
"                        A FILE renders just that file — its own `---`-split\n"
"                        documents, the first is the entry — with no access to\n"
"                        any other file.\n"
"                        A DIRECTORY is scanned in full: every file under it\n"
"                        is inserted as a raw document (path/name/ext/size/\n"
"                        mtime, plus front matter for .mdy files), so the\n"
"                        entry document's $/$.find/$.render reach any of\n"
"                        them — it alone decides what any file/path means\n"
"                        (which are \"posts\", what URL/layout each gets, …),\n"
"                        entirely in template code. The entry defaults to\n"
"                        main.mdy; --entry picks another file.\n"
"\n"
"Options:\n"
"  -o, --out <file>      Write output to <file> (default: stdout). If <file>\n"
"                        is an existing directory, any $.emit(path, content)\n"
"                        the entry produced is written under it instead (the\n"
"                        entry's own rendered output still goes to stdout in\n"
"                        that case, since there is no filename for it).\n"
"      --html            Emit the finished document as HTML instead of the\n"
"                        text its own code wrote (which is what an .mdy file\n"
"                        producing a feed, a robots.txt or any other\n"
"                        non-markup output actually means).\n"
"      --entry <path>    Directory input only: the entry document's path,\n"
"                        relative to the directory (default: main.mdy).\n"
"      --emit-js         Emit the compiled JavaScript instead of rendering\n"
"                        (debug): every document for a file input, just the\n"
"                        entry document for a directory input.\n"
"  -d, --data <k=v>      Add a context value (repeatable). Value is parsed as\n"
"                        JSON when possible, otherwise treated as a string.\n"
"      --data-file <f>   Merge a YAML/JSON file into the context.\n"
"  -w, --watch           Keep running and re-render on any relevant change —\n"
"                        the given file (or, for a directory, any file under\n"
"                        it) plus --data-file. A failing render reports to\n"
"                        stderr and keeps watching. Not available with stdin.\n"
"  -h, --help            Show this help.\n"
"\n"
"Extra context (from --data / --data-file) overrides the document's front matter.\n"
"A document with no $.emit calls just renders to stdout/-o as always; $.emit\n"
"is the idiom for producing more than one output from a single entry.\n"
"\n"
"Examples:\n"
"  mdy report.mdy\n"
"  mdy report.mdy --html -o report.html\n"
"  mdy report.mdy -d env=prod -d 'build=42' --data-file overrides.yaml\n"
"  mdy report.mdy -o report.md --watch             # live re-render on save\n"
"  cat report.mdy | mdy - --html                   # stdin → HTML on stdout\n"
"  mdy ./my-site                                   # scan the dir, render main.mdy\n"
"  mdy ./my-site --entry other.mdy -o dist         # write $.emit output\n";

/* ---- small helpers ------------------------------------------------------------ */

static char *read_stdin(size_t *len) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
#endif
    size_t cap = 1 << 16, used = 0;
    char *buf = malloc(cap);
    if (!buf) return NULL;
    for (;;) {
        if (used == cap) {
            char *grown = realloc(buf, cap *= 2);
            if (!grown) { free(buf); return NULL; }
            buf = grown;
        }
        size_t got = fread(buf + used, 1, cap - used, stdin);
        used += got;
        if (got == 0) break;
    }
    buf = realloc(buf, used + 1);
    buf[used] = '\0';
    *len = used;
    return buf;
}

static int is_dir(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}
static int exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0;
}

/* An absolute, normalised path — `.` and `..` collapsed — so that two
 * spellings of one file compare equal, which is how `-o` refuses to write
 * over its own input. */
static char *absolute(const char *path) {
    char joined[8192];
    if (fsx_is_absolute(path)) {
        snprintf(joined, sizeof joined, "%s", path);
    } else {
        char *cwd = fsx_cwd();
        snprintf(joined, sizeof joined, "%s/%s", cwd ? cwd : ".", path);
        free(cwd);
    }
    for (char *p = joined; *p; p++) if (*p == '\\') *p = '/';
    /* a drive keeps its letter as the first segment; `..` cannot climb past it */
    int rooted = joined[0] == '/';
    char *segs[512];
    size_t depth = 0;
    char *work = strdup(joined);
    for (char *seg = strtok(work, "/"); seg; seg = strtok(NULL, "/")) {
        if (strcmp(seg, ".") == 0) continue;
        if (strcmp(seg, "..") == 0) { if (depth > (rooted ? 0u : 1u)) depth--; continue; }
        if (depth < 512) segs[depth++] = seg;
    }
    char *out = malloc(strlen(joined) + 2);
    size_t at = 0;
    if (rooted) out[at++] = '/';
    for (size_t i = 0; i < depth; i++) {
        if (i) out[at++] = '/';
        size_t n = strlen(segs[i]);
        memcpy(out + at, segs[i], n);
        at += n;
    }
    out[at] = '\0';
    free(work);
    return out;
}

static const char *extension_of(const char *path) {
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    const char *dot = strrchr(base, '.');
    return dot ? dot : "";
}

static int ieq(const char *a, const char *b) {
    for (; *a && *b; a++, b++) {
        char x = *a, y = *b;
        if (x >= 'A' && x <= 'Z') x = (char)(x + 32);
        if (y >= 'A' && y <= 'Z') y = (char)(y + 32);
        if (x != y) return 0;
    }
    return *a == *b;
}

/* ---- what a render produced besides its own text ------------------------------
 *
 * `$.emit` outputs and `$.resize` outputs, in order of first appearance and
 * one per path — a Map, as mdy-docs keeps them.
 */
typedef struct { char *path; uint8_t *bytes; size_t len; int binary; } Output;
typedef struct { Output *items; size_t count, cap; } Outputs;

static void outputs_put(Outputs *o, const char *path, const uint8_t *bytes, size_t len, int binary) {
    for (size_t i = 0; i < o->count; i++) {
        if (strcmp(o->items[i].path, path) == 0) {
            free(o->items[i].bytes);
            o->items[i].bytes = malloc(len + 1);
            memcpy(o->items[i].bytes, bytes, len);
            o->items[i].bytes[len] = 0;
            o->items[i].len = len;
            o->items[i].binary = binary;
            return;
        }
    }
    if (o->count == o->cap) {
        o->cap = o->cap ? o->cap * 2 : 16;
        o->items = realloc(o->items, o->cap * sizeof *o->items);
    }
    Output *it = &o->items[o->count++];
    it->path = strdup(path);
    it->bytes = malloc(len + 1);
    memcpy(it->bytes, bytes, len);
    it->bytes[len] = 0;
    it->len = len;
    it->binary = binary;
}
static void outputs_clear(Outputs *o) {
    for (size_t i = 0; i < o->count; i++) { free(o->items[i].path); free(o->items[i].bytes); }
    o->count = 0;
}
static void collect_emit(void *ud, const char *path, const char *content) {
    outputs_put(ud, path, (const uint8_t *)content, strlen(content), 0);
}
static void collect_binary(void *ud, const char *path, const uint8_t *bytes, size_t len) {
    outputs_put(ud, path, bytes, len, 1);
}

/* ---- messages a build holds ---------------------------------------------------- */

typedef struct { char **names; char **json; size_t count, cap; } Messages;
static void collect_message(void *ud, const char *name, const char *data_json, size_t doc_index) {
    (void)doc_index;
    Messages *m = ud;
    if (m->count == m->cap) {
        m->cap = m->cap ? m->cap * 2 : 8;
        m->names = realloc(m->names, m->cap * sizeof *m->names);
        m->json = realloc(m->json, m->cap * sizeof *m->json);
    }
    m->names[m->count] = strdup(name);
    m->json[m->count] = strdup(data_json);
    m->count++;
}

/* ---- the broker ------------------------------------------------------------------
 *
 * What @mdy-docs/mdy-bus does, request for request: a message is one
 * binjson value POSTed to /pub/<name>, dead letters are GET /dead/<name>,
 * and a requeue is POST /requeue/<name>?index=N. Success bodies are binjson;
 * an error's is text, which is what the messages below quote.
 */
static const char DEFAULT_BROKER[] = "http://127.0.0.1:8080";

static void trim_slashes(char *url) {
    size_t n = strlen(url);
    while (n > 0 && url[n - 1] == '/') url[--n] = 0;
}

/* The JavaScript's error line for a failed request, and out. */
static void broker_fail(const char *fmt, const char *a, const char *b, int status, const HttpResponse *r) {
    char msg[2048];
    if (status) {
        char detail[512] = "";
        if (r && r->body_len) {
            snprintf(detail, sizeof detail, "%.*s", (int)(r->body_len > 400 ? 400 : r->body_len), (const char *)r->body);
            size_t n = strlen(detail);
            while (n && (detail[n - 1] == '\n' || detail[n - 1] == ' ')) detail[--n] = 0;
        }
        snprintf(msg, sizeof msg, fmt, a, b, status, detail[0] ? " — " : "", detail);
    } else {
        snprintf(msg, sizeof msg, fmt, a, b, 0, "", "");
    }
    fprintf(stderr, "%s%s%s\n", RED_OPEN(), msg, RED_CLOSE());
    exit(1);
}

/* Every held message to the broker, after a build that succeeded. */
static int publish_messages(mdy_engine *e, const Messages *m, const char *broker) {
    char url[2048];
    snprintf(url, sizeof url, "%s", broker ? broker : DEFAULT_BROKER);
    trim_slashes(url);
    int sent = 0;
    for (size_t i = 0; i < m->count; i++) {
        uint8_t *bytes = NULL; size_t len = 0;
        if (mdy_engine_encode_json(e, m->json[i], &bytes, &len) != 0) {
            fprintf(stderr, "%spublish: %s carries data that is not JSON%s\n", RED_OPEN(), m->names[i], RED_CLOSE());
            exit(1);
        }
        char target[2300];
        snprintf(target, sizeof target, "%s/pub/%s", url, m->names[i]);
        HttpResponse r;
        if (http_request("POST", target, "application/binjson", bytes, len, &r) != 0) {
            char msg[1024];
            snprintf(msg, sizeof msg, "publish: cannot reach the sukkal broker at %s (%s)", url, r.error);
            fprintf(stderr, "%s%s%s\n", RED_OPEN(), msg, RED_CLOSE());
            exit(1);
        }
        if (r.status < 200 || r.status >= 300)
            broker_fail("publish: %s refused with %.0s%d%s%s", m->names[i], "", r.status, &r);
        http_response_free(&r);
        free(bytes);
        sent++;
        printf("%s[send]%s %s %s(%zu bytes)%s\n", MAGENTA_OPEN(), MAGENTA_CLOSE(), m->names[i], DIM_OPEN(), len, DIM_CLOSE());
    }
    return sent;
}

/* mdy dead <name> [--broker <url>] [--requeue <index>] */
static int cmd_dead(int argc, char **argv) {
    if (argc == 0) { fputs(SITE_USAGE, stdout); return 1; }
    const char *name = NULL, *broker = NULL, *requeue = NULL;
    for (int i = 0; i < argc; i++) {
        const char *a = argv[i];
        if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) { fputs(SITE_USAGE, stdout); return 0; }
        else if (strcmp(a, "--broker") == 0 && i + 1 < argc) broker = argv[++i];
        else if (strcmp(a, "--requeue") == 0 && i + 1 < argc) requeue = argv[++i];
        else name = a;
    }
    if (!name) name = ".";
    char url[2048];
    snprintf(url, sizeof url, "%s", broker ? broker : DEFAULT_BROKER);
    trim_slashes(url);
    char target[2300];
    HttpResponse r;

    if (requeue) {
        snprintf(target, sizeof target, "%s/requeue/%s?index=%s", url, name, requeue);
        if (http_request("POST", target, NULL, NULL, 0, &r) != 0) {
            fprintf(stderr, "%srequeue: cannot reach the sukkal broker at %s (%s)%s\n", RED_OPEN(), url, r.error, RED_CLOSE());
            return 1;
        }
        if (r.status < 200 || r.status >= 300) {
            char who[512]; snprintf(who, sizeof who, "%s#%s", name, requeue);
            broker_fail("requeue: %s — %.0s%d %.0s%s", who, "", r.status, &r);
        }
        bjv *result = bjv_decode(r.body, r.body_len);
        double index = bjv_number(result, "index", -1);
        char at[32]; if (index >= 0) snprintf(at, sizeof at, "%.0f", index); else snprintf(at, sizeof at, "?");
        printf("%s✓%s requeued %s%s%s %s(dead #%s → #%s)%s\n", GREEN_OPEN(), GREEN_CLOSE(), CYAN_OPEN(), name, CYAN_CLOSE(),
               DIM_OPEN(), requeue, at, DIM_CLOSE());
        bjv_free(result);
        http_response_free(&r);
        return 0;
    }

    snprintf(target, sizeof target, "%s/dead/%s", url, name);
    if (http_request("GET", target, NULL, NULL, 0, &r) != 0) {
        fprintf(stderr, "%sdead: cannot reach the sukkal broker at %s (%s)%s\n", RED_OPEN(), url, r.error, RED_CLOSE());
        return 1;
    }
    if (r.status < 200 || r.status >= 300) broker_fail("dead: %s — %.0s%d %.0s%s", name, "", r.status, &r);
    bjv *entries = bjv_decode(r.body, r.body_len);
    size_t n = entries && entries->type == BJV_ARRAY ? entries->count : 0;
    if (n == 0) {
        printf("%snothing has died on %s%s\n", DIM_OPEN(), name, DIM_CLOSE());
    } else {
        for (size_t i = 0; i < n; i++) {
            const bjv *entry = entries->items[i];
            /* the envelope carries the letter as a binjson payload, or is the letter */
            const bjv *payload = bjv_get(entry, "payload");
            bjv *inner = payload && payload->type == BJV_BINARY ? bjv_decode(payload->bytes, payload->len) : NULL;
            const bjv *letter = inner ? inner : entry;
            double index = bjv_number(entry, "index", 0);
            const char *why = bjv_string(letter, "error");
            if (!why) why = bjv_string(letter, "reason");
            double attempts = bjv_number(letter, "attempts", 0);
            printf("%s[dead]%s %s#%.0f%s %s%s%s", RED_OPEN(), RED_CLOSE(), DIM_OPEN(), index, DIM_CLOSE(), BOLD_OPEN(), name, BOLD_CLOSE());
            if (attempts) printf("%s after %.0f attempt(s)%s", DIM_OPEN(), attempts, DIM_CLOSE());
            if (why) printf(" — %s", why);
            printf("\n");
            bjv_free(inner);
        }
        printf("%s  %zu dead — `mdy dead %s --requeue <index>` puts one back%s\n", DIM_OPEN(), n, name, DIM_CLOSE());
    }
    bjv_free(entries);
    http_response_free(&r);
    return 0;
}

/* ---- the progress line ------------------------------------------------------------
 *
 * src/progress.js, on a terminal: one line on stderr that updates in place —
 * files read, then pages rendered, with the percentage only when a previous
 * build said how many to expect. Off anywhere else, and `progress_log` is then
 * a plain line on stdout, so a pipeline reading the output sees no difference.
 */
typedef struct {
    int enabled, live, painted;
    double started, last_paint;
    int frame, files, pages, expected;
    enum { P_READING, P_RENDERING } phase;
} Progress;
static const char SPINNER[] = "|/-\\";
#define BAR_WIDTH 24
#define TICK_MS 100.0
#define CLEAR_LINE "\r\x1b[2K"

static void progress_paint(Progress *p) {
    char line[160];
    char spin = SPINNER[p->frame % 4];
    double secs = (now_ms() - p->started) / 1000.0;
    if (p->phase == P_READING) {
        snprintf(line, sizeof line, "%c reading %d file(s)  %.1fs", spin, p->files, secs);
    } else if (p->expected) {
        double ratio = p->pages >= p->expected ? 1.0 : (double)p->pages / p->expected;
        int shown = p->pages >= p->expected ? 99 : (int)(ratio * 100 + 0.5);
        int filled = (int)(ratio * BAR_WIDTH + 0.5);
        char bar[BAR_WIDTH + 1];
        for (int i = 0; i < BAR_WIDTH; i++) bar[i] = i < filled ? '#' : '.';
        bar[BAR_WIDTH] = 0;
        snprintf(line, sizeof line, "[%s] %3d%% %d/%d page(s)  %.1fs", bar, shown, p->pages, p->expected, secs);
    } else {
        snprintf(line, sizeof line, "%c %d page(s)  %.1fs", spin, p->pages, secs);
    }
    fprintf(stderr, CLEAR_LINE "%s", line);
    fflush(stderr);
    p->painted = 1;
}
static void progress_begin(Progress *p) {
    if (!p->enabled || p->live) return;
    p->live = 1; p->painted = 0; p->started = now_ms(); p->last_paint = 0;
    p->frame = 0; p->files = 0; p->pages = 0; p->phase = P_READING;
}
static void progress_maybe_paint(Progress *p) {
    double t = now_ms();
    if (t - p->last_paint < TICK_MS) return;
    p->last_paint = t;
    p->frame++;
    progress_paint(p);
}
static void progress_source(Progress *p) {
    progress_begin(p);
    if (!p->live) return;
    p->files++;
    if (p->phase == P_READING) progress_maybe_paint(p);
}
static void progress_emit(Progress *p) {
    progress_begin(p);
    if (!p->live) return;
    if (p->phase != P_RENDERING) { p->phase = P_RENDERING; p->last_paint = 0; }
    p->pages++;
    progress_maybe_paint(p);
}
/* A line ABOVE the moving one: the bar comes down, the line goes to stdout,
 * the bar is drawn again beneath it. */
static void progress_log(Progress *p, const char *line) {
    if (p->live && p->painted) fputs(CLEAR_LINE, stderr);
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    if (p->live) { p->last_paint = now_ms(); progress_paint(p); }
}
static void progress_finish(Progress *p) {
    if (!p->live) return;
    if (p->painted) fputs(CLEAR_LINE, stderr);
    if (p->pages > 0) p->expected = p->pages;
    p->live = 0;
}

/* ---- mdy build ----------------------------------------------------------------- */

typedef struct {
    const char *out;
    int quiet;
    Progress *progress;
    int pages, images, failed;
} BuildSink;

static void build_log(BuildSink *s, const char *tag_open, const char *tag_close, const char *tag, const char *path) {
    if (s->quiet) return;
    char line[8192];
    snprintf(line, sizeof line, "%s%s%s %s", tag_open, tag, tag_close, path);
    progress_log(s->progress, line);
}
static void build_source(void *ud, const char *path) {
    BuildSink *s = ud;
    progress_source(s->progress);
    build_log(s, BLUE, "[read]", path);
}
static void build_page(void *ud, const char *path, const char *content) {
    BuildSink *s = ud;
    if (fsx_write(s->out, path, (const uint8_t *)content, strlen(content)) != 0) {
        fprintf(stderr, "cannot write %s/%s\n", s->out, path);
        s->failed++;
        return;
    }
    s->pages++;
    progress_emit(s->progress);
    build_log(s, GREEN, "[write]", path);
}
static void build_image(void *ud, const char *path, const uint8_t *bytes, size_t len) {
    BuildSink *s = ud;
    if (fsx_write(s->out, path, bytes, len) != 0) {
        fprintf(stderr, "cannot write %s/%s\n", s->out, path);
        s->failed++;
        return;
    }
    s->images++;
    build_log(s, GREEN, "[write]", path);
}

/*
 * `static/` under a root, copied into the output as it is. The listing is
 * relative to `static/`, so `static/style.css` lands at `style.css`. Never
 * over a page: a document that emitted to that path meant to.
 */
static int copy_static(const char *root, BuildSink *s) {
    char dir[4096];
    snprintf(dir, sizeof dir, "%s/static", root);
    char *listing = fsx_list(dir, ".", NULL);
    if (!listing) return 0;
    int n = 0;
    for (char *rel = listing, *next; rel && *rel; rel = next) {
        char *nl = strchr(rel, '\n');
        next = nl ? nl + 1 : NULL;
        if (nl) *nl = '\0';
        if (!*rel) continue;
        /*
         * A `.mdy` under static/ is a metadata SIDECAR — static/logo.png.mdy
         * describes static/logo.png. It belongs in the document set, findable
         * by `$.find`, and must not be published as a raw text file a visitor
         * could stumble onto.
         */
        size_t rlen = strlen(rel);
        if (rlen >= 4 && strcmp(rel + rlen - 4, ".mdy") == 0) continue;
        size_t len = 0;
        uint8_t *bytes = fsx_read(dir, rel, &len);
        if (!bytes) continue;
        if (fsx_write(s->out, rel, bytes, len) == 0) { n++; build_log(s, GREEN, "[write]", rel); }
        free(bytes);
    }
    free(listing);
    return n;
}

static int cmd_build(int argc, char **argv) {
    const char *root = ".", *out = NULL, *entry = "main.mdy", *broker = NULL;
    int quiet = 0, drafts = 0, future = 0, publish = 0;
    for (int i = 0; i < argc; i++) {
        const char *a = argv[i];
        if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) { fputs(SITE_USAGE, stdout); return 0; }
        else if (strcmp(a, "--out") == 0 && i + 1 < argc) out = argv[++i];
        else if (strcmp(a, "--entry") == 0 && i + 1 < argc) entry = argv[++i];
        else if (strcmp(a, "--broker") == 0 && i + 1 < argc) broker = argv[++i];
        else if (strcmp(a, "--drafts") == 0) drafts = 1;
        else if (strcmp(a, "--future") == 0) future = 1;
        else if (strcmp(a, "--publish") == 0) publish = 1;
        else if (strcmp(a, "--quiet") == 0) quiet = 1;
        else root = a;
    }
    char out_default[4096];
    if (!out) {
        size_t n = strlen(root);
        while (n > 1 && root[n - 1] == '/') n--;
        snprintf(out_default, sizeof out_default, "%.*s/dist", (int)n, root);
        out = out_default;
    }
    char *out_abs = absolute(out);

    double started = now_ms();
    Progress progress = { .enabled = !quiet && isatty(fileno(stderr)) };
    BuildSink sink = { out_abs, quiet, &progress, 0, 0, 0 };
    Messages messages = { 0 };

    mdy_engine_rotate_memo();      /* a build is a memo generation */
    mdy_engine *e = mdy_engine_new();
    if (!e) fail("out of memory");
    mdy_engine_on_source(e, build_source, &sink);

    char err[1024];
    if (mdy_engine_open_dir(e, root, err, sizeof err) != 0) {
        progress_finish(&progress);
        fprintf(stderr, "%s%s%s\n", RED_OPEN(), err, RED_CLOSE());
        return 1;
    }
    mdy_engine_set_context_bool(e, "drafts", drafts);
    mdy_engine_set_context_bool(e, "future", future);

    int at = mdy_engine_entry(e, entry);
    if (at < 0) {
        progress_finish(&progress);
        fprintf(stderr, "%sentry script not found at \"%s\" (looked among %zu document(s) under %s)%s\n",
                RED_OPEN(), entry, mdy_engine_count(e), root, RED_CLOSE());
        return 1;
    }
    mdy_engine_on_emit(e, build_page, &sink);
    mdy_engine_on_binary(e, build_image, &sink);
    mdy_engine_on_publish(e, collect_message, &messages);

    char *html = mdy_engine_render(e, (size_t)at, err, sizeof err);
    if (!html) {
        progress_finish(&progress);
        fprintf(stderr, "%s%s%s\n", RED_OPEN(), err, RED_CLOSE());
        return 1;
    }
    free(html);

    /* Every root's static/, imports first — so the site's own copy of a name
     * is the one that survives. */
    size_t roots = mdy_engine_root_count(e);
    for (size_t i = 0; i < roots; i++) copy_static(mdy_engine_root_at(e, i), &sink);
    progress_finish(&progress);
    if (sink.failed) { mdy_engine_free(e); return 1; }

    if (!quiet) {
        printf("%s✓%s built %s%d%s page(s) → %s%s%s %s(%dms)%s\n",
               GREEN, BOLD_OPEN(), sink.pages, BOLD_CLOSE(), CYAN_OPEN(), out_abs, CYAN_CLOSE(),
               DIM_OPEN(), (int)(now_ms() - started), DIM_CLOSE());
    }
    /* Strictly after the build reported success — that ordering IS the
     * deferred half of $.publish, not a formatting choice. */
    if (messages.count) {
        if (publish) {
            int sent = publish_messages(e, &messages, broker);
            if (!quiet) printf("%s✓%s published %s%d%s message(s)\n", GREEN, BOLD_OPEN(), sent, BOLD_CLOSE());
        } else if (!quiet) {
            for (size_t i = 0; i < messages.count; i++)
                printf("%s[hold]%s %s\n", DIM_OPEN(), DIM_CLOSE(), messages.names[i]);
            printf("%s  %zu message(s) not sent — pass --publish to send them to a sukkal broker%s\n",
                   DIM_OPEN(), messages.count, DIM_CLOSE());
        }
    }
    mdy_engine_free(e);
    free(out_abs);
    return 0;
}

/* ---- mdy [path]: one document --------------------------------------------------- */

typedef struct {
    const char *out, *entry, *data_file;
    int html, emit_js, watch;
    char **data; size_t data_count;
    const char *input; int is_stdin, is_dir;
    char *input_abs;
} DocOptions;

typedef struct { char *text; size_t len, cap; } Buf;
static void buf_put(Buf *b, const char *s, size_t n) {
    if (b->len + n + 1 > b->cap) {
        while (b->len + n + 1 > b->cap) b->cap = b->cap ? b->cap * 2 : 4096;
        b->text = realloc(b->text, b->cap);
    }
    memcpy(b->text + b->len, s, n);
    b->len += n;
    b->text[b->len] = 0;
}
static void buf_puts(Buf *b, const char *s) { buf_put(b, s, strlen(s)); }

/* --emit-js's shape for one document: `compileTemplateSource`, wrapped as
 * bin/mdy.js wraps it. */
static void emit_js_document(Buf *to, size_t index, const char *text, size_t len) {
    mdy_chunk matter, body;
    mdy_split_frontmatter(text, len, &matter, &body);
    mdy_script *script = mdy_script_compile(body.text, body.len);
    size_t n = 0;
    const char *src = script ? mdy_script_source(script, &n) : "";
    char head[96];
    snprintf(head, sizeof head, "// document %zu\nfunction __doc%zu(req, res) {\n", index, index);
    buf_puts(to, head);
    buf_put(to, src, n);
    buf_puts(to, "\nreturn __out;\n}");
    mdy_script_free(script);
}

/* A `[read]` line, once per path this process has seen — a watch re-walks
 * the whole directory on every save, and repeating it all would drown out
 * what matters. */
static char **seen_sources; static size_t seen_count, seen_cap;
static void doc_source(void *ud, const char *path) {
    (void)ud;
    for (size_t i = 0; i < seen_count; i++) if (strcmp(seen_sources[i], path) == 0) return;
    if (seen_count == seen_cap) { seen_cap = seen_cap ? seen_cap * 2 : 64; seen_sources = realloc(seen_sources, seen_cap * sizeof *seen_sources); }
    seen_sources[seen_count++] = strdup(path);
    fprintf(stderr, "%s[read]%s %s\n", BLUE_OPEN(), BLUE_CLOSE(), path);
}

/* Context from --data-file (read each pass) then -d, later wins. Returns an
 * error message to fail with, or NULL. */
static char *load_context(mdy_engine *e, const DocOptions *o) {
    static char msg[4096];
    mdy_engine_clear_context(e);
    if (o->data_file) {
        size_t len = 0;
        char *path = absolute(o->data_file);
        uint8_t *text = fsx_read("/", path, &len);
        free(path);
        if (!text) { snprintf(msg, sizeof msg, "cannot read --data-file: no such file: %s", o->data_file); return msg; }
        char yerr[256];
        mdy_yaml *doc = mdy_yaml_parse((const char *)text, len, yerr, sizeof yerr);
        free(text);
        if (!doc) { snprintf(msg, sizeof msg, "cannot read --data-file: %s", yerr); return msg; }
        const mdy_yaml_node *root = mdy_yaml_root(doc);
        if (mdy_yaml_type_of(root) != MDY_YAML_MAPPING) {
            mdy_yaml_free(doc);
            snprintf(msg, sizeof msg, "--data-file must contain a YAML/JSON mapping");
            return msg;
        }
        size_t n = mdy_yaml_count(root);
        for (size_t i = 0; i < n; i++) {
            size_t klen = 0;
            const char *k = mdy_yaml_key(root, i, &klen);
            char *json = mdy_yaml_to_json(mdy_yaml_value(root, i));
            char *name = malloc(klen + 1);
            memcpy(name, k, klen); name[klen] = 0;
            mdy_engine_set_context_json(e, name, json ? json : "null", 1);
            free(name); free(json);
        }
        mdy_yaml_free(doc);
    }
    for (size_t i = 0; i < o->data_count; i++) {
        const char *pair = o->data[i];
        const char *eq = strchr(pair, '=');
        size_t klen = (size_t)(eq - pair);
        char *name = malloc(klen + 1);
        memcpy(name, pair, klen); name[klen] = 0;
        mdy_engine_set_context_json(e, name, eq + 1, 0);
        free(name);
    }
    return NULL;
}

/* One render pass. Writes the output to *out (caller frees) or returns an
 * error message to fail with; never exits, so a watch can survive it. */
static char *generate_output(const DocOptions *o, char **out, Outputs *emitted) {
    static char msg[4096];
    *out = NULL;
    outputs_clear(emitted);
    mdy_engine *e = mdy_engine_new();
    if (!e) return "out of memory";
    char *cerr = load_context(e, o);
    if (cerr) { mdy_engine_free(e); return cerr; }
    mdy_engine_on_emit(e, collect_emit, emitted);
    mdy_engine_on_binary(e, collect_binary, emitted);
    char err[1024];

    if (o->is_dir) {
        const char *entry = o->entry ? o->entry : "main.mdy";
        mdy_engine_on_source(e, doc_source, NULL);
        if (mdy_engine_open_dir(e, o->input_abs, err, sizeof err) != 0) {
            snprintf(msg, sizeof msg, "%s", err); mdy_engine_free(e); return msg;
        }
        int at = mdy_engine_entry(e, entry);
        if (at < 0) {
            snprintf(msg, sizeof msg, "entry script not found at \"%s\" (looked among %zu document(s) under %s)",
                     entry, mdy_engine_count(e), o->input_abs);
            mdy_engine_free(e);
            return msg;
        }
        if (o->emit_js) {
            size_t len = 0;
            uint8_t *text = fsx_read(o->input_abs, entry, &len);
            if (!text) { snprintf(msg, sizeof msg, "cannot read %s", entry); mdy_engine_free(e); return msg; }
            mdy_documents *docs = mdy_split_documents((const char *)text, len);
            mdy_chunk first = mdy_documents_at(docs, 0);
            Buf buf = { 0 };
            emit_js_document(&buf, (size_t)at, first.text, first.len);
            *out = buf.text;
            mdy_documents_free(docs);
            free(text);
            mdy_engine_free(e);
            return NULL;
        }
        char *text = o->html ? mdy_engine_render(e, (size_t)at, err, sizeof err)
                             : mdy_engine_render_text(e, (size_t)at, err, sizeof err);
        mdy_engine_free(e);
        if (!text) { snprintf(msg, sizeof msg, "%s", err); return msg; }
        *out = text;
        return NULL;
    }

    /* a file, or stdin: just that one input's own text, no site walk */
    size_t len = 0;
    char *text = NULL;
    if (o->is_stdin) {
        text = read_stdin(&len);
    } else {
        text = (char *)fsx_read("/", o->input_abs, &len);
        if (text) doc_source(NULL, o->input_abs);
    }
    if (!text) { snprintf(msg, sizeof msg, "cannot read input: %s", o->is_stdin ? "stdin" : o->input); mdy_engine_free(e); return msg; }

    if (o->emit_js) {
        mdy_documents *docs = mdy_split_documents(text, len);
        size_t n = mdy_documents_count(docs);
        Buf buf = { 0 };
        for (size_t i = 0; i < n; i++) {
            if (i) buf_puts(&buf, "\n\n");
            mdy_chunk c = mdy_documents_at(docs, i);
            emit_js_document(&buf, i, c.text, c.len);
        }
        if (!buf.text) buf_puts(&buf, "");
        *out = buf.text;
        mdy_documents_free(docs);
        free(text);
        mdy_engine_free(e);
        return NULL;
    }

    if (mdy_engine_open(e, text, len, err, sizeof err) != 0) {
        snprintf(msg, sizeof msg, "%s", err); free(text); mdy_engine_free(e); return msg;
    }
    free(text);
    char *rendered = o->html ? mdy_engine_render(e, 0, err, sizeof err)
                             : mdy_engine_render_text(e, 0, err, sizeof err);
    mdy_engine_free(e);
    if (!rendered) { snprintf(msg, sizeof msg, "%s", err); return msg; }
    *out = rendered;
    return NULL;
}

/* `$.emit` output: written under --out if it is an existing directory, else
 * reported. */
static void report_emitted(const DocOptions *o, Outputs *emitted) {
    if (emitted->count == 0) return;
    int to_dir = o->out && is_dir(o->out);
    if (to_dir) {
        for (size_t i = 0; i < emitted->count; i++) {
            Output *it = &emitted->items[i];
            if (fsx_write(o->out, it->path, it->bytes, it->len) != 0) {
                fprintf(stderr, "%smdy: cannot write %s/%s%s\n", RED_OPEN(), o->out, it->path, RED_CLOSE());
                continue;
            }
            fprintf(stderr, "%s[write]%s %s\n", GREEN_OPEN(), GREEN_CLOSE(), it->path);
        }
        fprintf(stderr, "mdy: wrote %zu emitted file(s) to %s\n", emitted->count, o->out);
    } else {
        fprintf(stderr, "mdy: %zu file(s) emitted via $.emit not written (pass --out <existing-dir> to write them): ",
                emitted->count);
        for (size_t i = 0; i < emitted->count; i++)
            fprintf(stderr, "%s%s", i ? ", " : "", emitted->items[i].path);
        fputc('\n', stderr);
    }
}

/* --out as an existing directory is claimed by $.emit output — there is no
 * filename for the entry's own text, so it goes to stdout, as with no --out. */
static char *emit_output(const DocOptions *o, const char *output) {
    static char msg[4096];
    int out_is_dir = o->out && is_dir(o->out);
    if (o->out && !out_is_dir) {
        FILE *f = fopen(o->out, "wb");
        if (!f || fputs(output, f) == EOF) {
            snprintf(msg, sizeof msg, "cannot write --out: %s", o->out);
            if (f) fclose(f);
            return msg;
        }
        fclose(f);
    } else {
        fputs(output, stdout);
        fflush(stdout);
    }
    return NULL;
}

/* ---- --watch: re-render on change, survive render errors ----------------------
 *
 * Status and errors go to stderr throughout, since stdout is the rendered
 * output when there is no -o. What is watched: the file (or, for a
 * directory, everything under it) and --data-file. Editors save atomically
 * — write a temp file, rename — so a file is watched through its
 * directory, as bin/mdy.js watches it, and this watcher's snapshot of a
 * single name behaves the same way.
 */
static void report(const char *msg, int error) {
    char stamp[32];
    time_t t = time(NULL);
    strftime(stamp, sizeof stamp, "%l:%M:%S %p", localtime(&t));
    const char *s = stamp; while (*s == ' ') s++;
    fprintf(stderr, "%s%s%s%s %s[mdy]%s %s%s\n", error ? RED_OPEN() : "", DIM_OPEN(), s, DIM_CLOSE(),
            CYAN_OPEN(), CYAN_CLOSE(), msg, error ? RED_CLOSE() : "");
}

typedef struct { char *root; char *only; Snapshot last; } Watched;

static int watch_document(DocOptions *o, Outputs *emitted) {
    Watched w[2];
    int nw = 0;
    if (o->is_dir) {
        w[nw].root = strdup(o->input_abs); w[nw].only = NULL; nw++;
    } else {
        char *dir = strdup(o->input_abs);
        char *slash = strrchr(dir, '/');
        const char *base = slash ? slash + 1 : dir;
        w[nw].only = strdup(base);
        if (slash) *slash = 0;
        w[nw].root = dir; nw++;
    }
    if (o->data_file) {
        char *abs = absolute(o->data_file);
        char *slash = strrchr(abs, '/');
        w[nw].only = strdup(slash ? slash + 1 : abs);
        if (slash) *slash = 0;
        w[nw].root = abs; nw++;
    }
    for (int i = 0; i < nw; i++) snapshot_take(&w[i].last, w[i].root, w[i].only);

    char target[4200];
    if (o->is_dir) snprintf(target, sizeof target, "%s", o->input_abs);
    else snprintf(target, sizeof target, "%d file(s)", o->data_file ? 2 : 1);
    fprintf(stderr, "\n  %s%sMDY%s%s  %swatching%s %s%s%s\n  %s➜%s  %spress ctrl+c to stop%s\n\n",
            BOLD_OPEN(), MAGENTA_OPEN(), MAGENTA_CLOSE(), BOLD_CLOSE(), DIM_OPEN(), DIM_CLOSE(),
            BOLD_OPEN(), target, BOLD_CLOSE(), GREEN_OPEN(), GREEN_CLOSE(), DIM_OPEN(), DIM_CLOSE());

    int first = 1;
    for (;;) {
        double started = now_ms();
        char *output = NULL;
        char *err = generate_output(o, &output, emitted);
        if (!err) {
            if (!o->emit_js) report_emitted(o, emitted);
            size_t n = strlen(output);
            if (n == 0 || output[n - 1] != '\n') { output = realloc(output, n + 2); output[n] = '\n'; output[n + 1] = 0; }
            err = emit_output(o, output);
            free(output);
        }
        if (err) report(err, 1);
        else if (!first) { char m[64]; snprintf(m, sizeof m, "rendered in %d ms", (int)(now_ms() - started)); report(m, 0); }
        first = 0;

        /* wait for a change, and let a burst of them settle */
        for (;;) {
            watch_sleep_ms(120);
            int changed = 0;
            for (int i = 0; i < nw; i++) {
                Snapshot now;
                snapshot_take(&now, w[i].root, w[i].only);
                char *diff = snapshot_changes(&w[i].last, &now);
                if (diff) {
                    for (const char *p = diff; *p; p += strlen(p) + 1) {
                        char m[4300];
                        snprintf(m, sizeof m, "%s[change]%s %s%s%s", YELLOW_OPEN(), YELLOW_CLOSE(),
                                 w[i].only ? "" : w[i].root, w[i].only ? "" : "/", p);
                        report(m, 0);
                    }
                    free(diff);
                    changed = 1;
                }
                snapshot_free(&w[i].last);
                w[i].last = now;
            }
            if (changed) { watch_sleep_ms(100); break; }
        }
    }
}

static int cmd_document(int argc, char **argv) {
    DocOptions o = { 0 };
    const char *positionals[8];
    int npos = 0;
    o.data = calloc((size_t)argc + 1, sizeof *o.data);

    /* node's parseArgs: `--name value`, `--name=value`, `-o value`, `--` ends
     * options, and an option nobody declared is an error. */
    int only_positionals = 0;
    for (int i = 0; i < argc; i++) {
        const char *a = argv[i];
        if (only_positionals || strcmp(a, "-") == 0 || a[0] != '-') {
            if (npos < 8) positionals[npos] = a;
            npos++;
            continue;
        }
        if (strcmp(a, "--") == 0) { only_positionals = 1; continue; }
        char name[128]; const char *value = NULL;
        const char *body = a + (a[1] == '-' ? 2 : 1);
        const char *eq = strchr(body, '=');
        if (eq) { snprintf(name, sizeof name, "%.*s", (int)(eq - body), body); value = eq + 1; }
        else snprintf(name, sizeof name, "%s", body);
        int takes_value = 0, is_help = 0;
        const char *canonical = NULL;
        if (strcmp(name, "out") == 0 || strcmp(name, "o") == 0) { canonical = "out"; takes_value = 1; }
        else if (strcmp(name, "html") == 0) canonical = "html";
        else if (strcmp(name, "entry") == 0) { canonical = "entry"; takes_value = 1; }
        else if (strcmp(name, "emit-js") == 0) canonical = "emit-js";
        else if (strcmp(name, "data") == 0 || strcmp(name, "d") == 0) { canonical = "data"; takes_value = 1; }
        else if (strcmp(name, "data-file") == 0) { canonical = "data-file"; takes_value = 1; }
        else if (strcmp(name, "watch") == 0 || strcmp(name, "w") == 0) canonical = "watch";
        else if (strcmp(name, "help") == 0 || strcmp(name, "h") == 0) { canonical = "help"; is_help = 1; }
        if (!canonical) {
            char m[256];
            snprintf(m, sizeof m, "Unknown option '%s'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"%s\"", a, a);
            fail(m);
        }
        if (takes_value && !value) {
            if (i + 1 >= argc) { char m[256]; snprintf(m, sizeof m, "Option '%s' argument missing", a); fail(m); }
            value = argv[++i];
        }
        (void)is_help;
        if (strcmp(canonical, "out") == 0) o.out = value;
        else if (strcmp(canonical, "html") == 0) o.html = 1;
        else if (strcmp(canonical, "entry") == 0) o.entry = value;
        else if (strcmp(canonical, "emit-js") == 0) o.emit_js = 1;
        else if (strcmp(canonical, "data") == 0) o.data[o.data_count++] = (char *)value;
        else if (strcmp(canonical, "data-file") == 0) o.data_file = value;
        else if (strcmp(canonical, "watch") == 0) o.watch = 1;
        else if (strcmp(canonical, "help") == 0) { fputs(USAGE, stdout); fputc('\n', stdout); return 0; }
    }

    /* -d pairs are static, so a malformed one fails at once */
    for (size_t i = 0; i < o.data_count; i++) {
        if (!strchr(o.data[i], '=')) {
            char m[512]; snprintf(m, sizeof m, "--data expects key=value, got \"%s\"", o.data[i]); fail(m);
        }
    }

    if (npos > 1) fail("mdy accepts a single input: one file, one directory, or stdin (\"-\")");
    o.input = npos ? positionals[0] : "-";
    o.is_stdin = strcmp(o.input, "-") == 0;
    if (!o.is_stdin) {
        o.input_abs = absolute(o.input);
        if (!exists(o.input_abs)) {
            char m[4096]; snprintf(m, sizeof m, "cannot read input: no such file or directory, stat '%s'", o.input_abs); fail(m);
        }
        o.is_dir = is_dir(o.input_abs);
    }

    if (o.entry && !o.is_dir) fail("--entry is only valid with a directory input");
    if (o.watch && o.is_stdin) fail("--watch cannot read from stdin");
    if (o.emit_js && o.html) fail("--emit-js cannot be combined with --html");
    if (o.out && !o.is_stdin) {
        char *out_abs = absolute(o.out);
        int same = strcmp(out_abs, o.input_abs) == 0;
        free(out_abs);
        if (same) fail("refusing to overwrite the input");
    }
    if (!o.is_stdin && !o.is_dir && !ieq(extension_of(o.input), ".mdy"))
        fprintf(stderr, "mdy: warning: input \"%s\" does not have a .mdy extension\n", o.input);

    Outputs emitted = { 0 };
    if (!o.watch) {
        char *output = NULL;
        char *err = generate_output(&o, &output, &emitted);
        if (err) fail(err);
        if (!o.emit_js) report_emitted(&o, &emitted);
        size_t n = strlen(output);
        if (n == 0 || output[n - 1] != '\n') {
            output = realloc(output, n + 2);
            output[n] = '\n'; output[n + 1] = 0;
        }
        err = emit_output(&o, output);
        if (err) fail(err);
        free(output);
        return 0;
    }
    return watch_document(&o, &emitted);
}

/* ---- mdy dev ----------------------------------------------------------------------
 *
 * src/serve.js, in C: pages rendered in memory and served from the map, a
 * $.resize result the same way, static/ from disk with the site's own copy
 * first; one watcher over every root; a debounced whole-site rebuild on any
 * change, with the last good build still served when one fails; browsers
 * holding /__mdy__/events and told to reload when a rebuild lands. Nothing
 * touches dist/.
 *
 * And the messaging half, when --broker names one that answers /health:
 * what a rebuild publishes is sent — once per run per (name, data) — and
 * a registration with the broker (`PUT /push/>`, the catch-all, in a queue
 * group) brings deliveries back as POSTs to /mdy/<consumer> on this same
 * server, each rendering the page its subject names with the message bound
 * as `req`. That is @mdy-docs/mdy-bus, request for request, in the one
 * process that already has the set.
 *
 * What is not here: the in-process broker mdy-bus opens when no --broker is
 * given, which is sukkal's wasm build inside node. Without --broker this
 * holds messages and says so, which is also what the JavaScript does when
 * that build is absent.
 */

static const char RELOAD_PATH[] = "/__mdy__/events";
static const char RELOAD_SNIPPET[] =
    "<script>\nnew EventSource(\"/__mdy__/events\").onmessage = () => location.reload();\n</script>";

typedef struct {
    const char *root_arg, *entry, *broker, *consumer, *group;
    int port, drafts, future, max_attempts, backoff, max_backoff;
} DevOptions;

typedef struct {
    DevOptions *o;
    char *root;                 /* absolute */
    Httpd *server;
    mdy_engine *engine;         /* the last good build's set; deliveries render against it */
    Outputs pages, binaries;    /* the last good build's outputs */
    Messages messages;          /* what the last render made, taken by whoever sends */
    char **roots; size_t root_count;   /* root + every import, for static/ and the watcher */
    Snapshot *snapshots;
    Progress progress;
    char **seen; size_t seen_count, seen_cap;   /* [read] once per path */
    char **announced; size_t announced_count;   /* [hold] once per name */
    /* the bus */
    int live;
    char token[40];
    char callback[512];
    char **policied; size_t policied_count;
    char **sent; size_t sent_count;             /* name\0data fingerprints already sent */
    double last_heartbeat;
} Dev;

static void stamp_now(char *out, size_t cap) {
    time_t t = time(NULL);
    strftime(out, cap, "%l:%M:%S %p", localtime(&t));
    if (out[0] == ' ') memmove(out, out + 1, strlen(out));
}
#define TS(buf) (stamp_now(buf, sizeof buf), buf)

static int seen_before(char ***list, size_t *count, size_t *cap, const char *s) {
    for (size_t i = 0; i < *count; i++) if (strcmp((*list)[i], s) == 0) return 1;
    if (*count == *cap) { *cap = *cap ? *cap * 2 : 32; *list = realloc(*list, *cap * sizeof **list); }
    (*list)[(*count)++] = strdup(s);
    return 0;
}

static void dev_source(void *ud, const char *path) {
    Dev *d = ud;
    progress_source(&d->progress);
    if (seen_before(&d->seen, &d->seen_count, &d->seen_cap, path)) return;
    char line[8192];
    snprintf(line, sizeof line, "%s[read]%s %s", BLUE, path);
    progress_log(&d->progress, line);
}
/* One whole build into a fresh engine. Returns the engine, or NULL with
 * `error` set; the caller swaps it in. */
static mdy_engine *dev_build(Dev *d, Outputs *pages, Outputs *binaries, Messages *messages, char *error, size_t error_len) {
    mdy_engine_rotate_memo();
    mdy_engine *e = mdy_engine_new();
    if (!e) { snprintf(error, error_len, "out of memory"); return NULL; }
    mdy_engine_on_source(e, dev_source, d);
    if (mdy_engine_open_dir(e, d->root, error, error_len) != 0) { mdy_engine_free(e); return NULL; }
    mdy_engine_set_context_bool(e, "drafts", d->o->drafts);
    mdy_engine_set_context_bool(e, "future", d->o->future);
    const char *entry = d->o->entry ? d->o->entry : "main.mdy";
    int at = mdy_engine_entry(e, entry);
    if (at < 0) {
        snprintf(error, error_len, "entry script not found at \"%s\" (looked among %zu document(s) under %s)", entry, mdy_engine_count(e), d->root);
        mdy_engine_free(e);
        return NULL;
    }
    /* collected into the CALLER's maps, so a failed build leaves the last good one alone */
    mdy_engine_on_emit(e, collect_emit, pages);
    mdy_engine_on_binary(e, collect_binary, binaries);
    mdy_engine_on_publish(e, collect_message, messages);
    char *html = mdy_engine_render(e, (size_t)at, error, error_len);
    if (!html) { mdy_engine_free(e); return NULL; }
    free(html);
    return e;
}

static void messages_clear(Messages *m) {
    for (size_t i = 0; i < m->count; i++) { free(m->names[i]); free(m->json[i]); }
    m->count = 0;
}

/* The broker's side, after a rebuild: send what this run has not sent. A
 * delivery's own publishes (`flush`) go out every time and say nothing —
 * the [deliver] line counts them. */
static void dev_send(Dev *d, int dedupe, int announce) {
    Messages fresh = { 0 };
    for (size_t i = 0; i < d->messages.count; i++) {
        if (!dedupe) { collect_message(&fresh, d->messages.names[i], d->messages.json[i], 0); continue; }
        size_t n = strlen(d->messages.names[i]) + 1 + strlen(d->messages.json[i]) + 1;
        char *fp = malloc(n);
        snprintf(fp, n, "%s%c%s", d->messages.names[i], 1, d->messages.json[i]);
        int dup = 0;
        for (size_t k = 0; k < d->sent_count; k++) if (strcmp(d->sent[k], fp) == 0) { dup = 1; break; }
        if (dup) { free(fp); continue; }
        d->sent = realloc(d->sent, (d->sent_count + 1) * sizeof *d->sent);
        d->sent[d->sent_count++] = fp;
        collect_message(&fresh, d->messages.names[i], d->messages.json[i], 0);
    }
    messages_clear(&d->messages);
    char ts[32];
    for (size_t i = 0; i < fresh.count; i++) {
        uint8_t *bytes = NULL; size_t len = 0;
        char url[2300];
        snprintf(url, sizeof url, "%s/pub/%s", d->o->broker, fresh.names[i]);
        HttpResponse r;
        if (mdy_engine_encode_json(d->engine, fresh.json[i], &bytes, &len) != 0 ||
            http_request("POST", url, "application/binjson", bytes, len, &r) != 0 || r.status < 200 || r.status >= 300) {
            fprintf(stderr, "%s%s %s[send]%s %s: not sent (%s)%s\n", TS(ts), RED_OPEN(), RED_OPEN(), RED_CLOSE(), fresh.names[i],
                    bytes ? (r.status ? "refused" : r.error) : "not JSON", RED_CLOSE());
        } else {
            if (announce)
                printf("%s%s%s %s[send]%s %s %s(%zu bytes)%s\n", DIM_OPEN(), TS(ts), DIM_CLOSE(), MAGENTA_OPEN(), MAGENTA_CLOSE(),
                       fresh.names[i], DIM_OPEN(), len, DIM_CLOSE());
            http_response_free(&r);
        }
        free(bytes);
    }
    messages_clear(&fresh);
}

/* `PUT /push/>` — the catch-all, as a queue group, delivering to this server. */
static int dev_register(Dev *d) {
    char url[2048];
    char cb[1024];
    size_t o = 0;
    for (const char *p = d->callback; *p && o + 4 < sizeof cb; p++) {
        if ((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || strchr("-._~", *p)) cb[o++] = *p;
        else o += (size_t)snprintf(cb + o, sizeof cb - o, "%%%02X", (unsigned char)*p);
    }
    cb[o] = 0;
    snprintf(url, sizeof url, "%s/push/>?consumer=%s&callback=%s&token=%s&group=%s", d->o->broker, d->o->consumer, cb, d->token, d->o->group);
    HttpResponse r;
    if (http_request("PUT", url, NULL, NULL, 0, &r) != 0) return -1;
    int ok = r.status >= 200 && r.status < 300;
    if (!ok) {
        char ts[32];
        fprintf(stderr, "%s %s[bus]%s bus: the broker refused the registration (%d%s%.*s)\n", TS(ts), RED_OPEN(), RED_CLOSE(),
                r.status, r.body_len ? " — " : "", (int)(r.body_len > 200 ? 200 : r.body_len), r.body ? (const char *)r.body : "");
    }
    http_response_free(&r);
    return ok ? 0 : -1;
}

/* A delivery: render the page the subject names, once per message. */
static void dev_deliver(Dev *d, Httpd *s, HttpdRequest *req) {
    char auth[128], subject[256], ts[32];
    char expect[64];
    snprintf(expect, sizeof expect, "Bearer %s", d->token);
    if (!httpd_header(req, "Authorization", auth, sizeof auth) || strcmp(auth, expect) != 0) { httpd_respond(s, req, 401, "text/plain", NULL, "", 0); return; }
    if (!httpd_header(req, "X-Sukkal-Subject", subject, sizeof subject)) { httpd_respond(s, req, 400, "text/plain", NULL, "", 0); return; }
    bjv *batch = bjv_decode(req->body, req->body_len);
    if (!batch || batch->type != BJV_ARRAY || batch->count == 0) { bjv_free(batch); httpd_respond(s, req, 400, "text/plain", NULL, "", 0); return; }

    /* the retry policy, once per subject, before any attempt is spent */
    if (!seen_before(&d->policied, &d->policied_count, &(size_t){d->policied_count}, subject)) {
        char url[1024];
        snprintf(url, sizeof url, "%s/queue/%s?group=%s&max_attempts=%d&backoff_ms=%d&max_backoff_ms=%d",
                 d->o->broker, subject, d->o->group, d->o->max_attempts, d->o->backoff, d->o->max_backoff);
        HttpResponse pr;
        if (http_request("PUT", url, NULL, NULL, 0, &pr) == 0) http_response_free(&pr);
    }

    int is_dead = strlen(subject) > 5 && strcmp(subject + strlen(subject) - 5, ".dead") == 0;
    int target = mdy_engine_page_index(d->engine, subject);
    char done_list[4096] = "";
    size_t done = 0, failed = 0;
    if (target < 0) {
        if (is_dead) {
            for (size_t i = 0; i < batch->count; i++) {
                char name[256]; snprintf(name, sizeof name, "%.*s", (int)(strlen(subject) - 5), subject);
                fprintf(stderr, "%s %s[dead]%s %s %s#%.0f%s %sno %s page — kept, see `mdy dead %s`%s\n", TS(ts), RED_OPEN(), RED_CLOSE(), subject,
                        DIM_OPEN(), bjv_number(batch->items[i], "index", 0), DIM_CLOSE(), DIM_OPEN(), subject, name, DIM_CLOSE());
            }
            bjv_free(batch);
            httpd_respond(s, req, 200, "text/plain", NULL, "", 0);
            return;
        }
        fprintf(stderr, "%s %s[return]%s %s %s(%s)%s — %zu message(s) returned; they will dead-letter\n", TS(ts), YELLOW_OPEN(), YELLOW_CLOSE(),
                subject, DIM_OPEN(), target == -2 ? "2 pages share that name" : "no page of that name here", DIM_CLOSE(), batch->count);
        bjv_free(batch);
        httpd_respond(s, req, 500, "text/plain", NULL, "", 0);
        return;
    }
    char *path = mdy_engine_document_path(d->engine, (size_t)target);
    for (size_t i = 0; i < batch->count; i++) {
        const bjv *entry = batch->items[i];
        double index = bjv_number(entry, "index", 0);
        double attempts = bjv_number(entry, "attempts", 1);
        const bjv *payload = bjv_get(entry, "payload");
        bjv *value = payload && payload->type == BJV_BINARY ? bjv_decode(payload->bytes, payload->len) : NULL;
        /* an ENVELOPE entry is [headers, message] */
        const bjv *message = value;
        if (bjv_number(entry, "type", 0) == 0x10 && value && value->type == BJV_ARRAY && value->count == 2) message = value->items[1];
        char *data = message && message->type == BJV_OBJECT ? bjv_to_json(message) : NULL;
        char *inner = message && message->type != BJV_OBJECT ? bjv_to_json(message) : NULL;
        size_t rlen = (data ? strlen(data) : (inner ? strlen(inner) : 4)) + strlen(subject) + 160;
        char *reqjson = malloc(rlen);
        if (data) snprintf(reqjson, rlen, "%.*s%s\"msg\":{\"name\":\"%s\",\"index\":%.0f,\"attempts\":%.0f}}",
                           (int)strlen(data) - 1, data, strlen(data) > 2 ? "," : "", subject, index, attempts);
        else snprintf(reqjson, rlen, "{\"value\":%s,\"msg\":{\"name\":\"%s\",\"index\":%.0f,\"attempts\":%.0f}}",
                      inner ? inner : "null", subject, index, attempts);
        free(data); free(inner);

        double started = now_ms();
        char err[1024];
        messages_clear(&d->messages);
        char *html = mdy_engine_render_json(d->engine, (size_t)target, reqjson, err, sizeof err);
        free(reqjson);
        int ms = (int)(now_ms() - started);
        char attempt[64] = "";
        if (attempts > 1) snprintf(attempt, sizeof attempt, " %sattempt %.0f/%d%s", YELLOW_OPEN(), attempts, d->o->max_attempts, YELLOW_CLOSE());
        if (!html) {
            failed++;
            int last = attempts >= d->o->max_attempts;
            char last_line[400];
            if (last) snprintf(last_line, sizeof last_line, "out of attempts — dead-lettering to %s.dead", subject);
            else snprintf(last_line, sizeof last_line, "returned; the broker will try again after a backoff");
            fprintf(stderr, "%s %s[refuse]%s %s %s#%.0f%s — %s%s%s threw after %dms%s\n  %s\n  %s%s%s\n", TS(ts), RED_OPEN(), RED_CLOSE(), subject,
                    DIM_OPEN(), index, DIM_CLOSE(), BOLD_OPEN(), path ? path : "?", BOLD_CLOSE(), ms, attempt, err, DIM_OPEN(), last_line, DIM_CLOSE());
        } else {
            free(html);
            size_t produced = d->messages.count;
            if (produced) dev_send(d, 0, 0);
            done++;
            char item[32]; snprintf(item, sizeof item, "%s%.0f", done_list[0] ? "," : "", index);
            strncat(done_list, item, sizeof done_list - strlen(done_list) - 1);
            char extra[64] = "";
            if (produced) snprintf(extra, sizeof extra, " %s(published %zu)%s", DIM_OPEN(), produced, DIM_CLOSE());
            printf("%s%s%s %s[%s]%s %s %s#%.0f%s → rendered %s%s%s in %s%dms%s%s%s\n", DIM_OPEN(), TS(ts), DIM_CLOSE(),
                   is_dead ? RED_OPEN() : GREEN_OPEN(), is_dead ? "dead" : "deliver", is_dead ? RED_CLOSE() : GREEN_CLOSE(), subject,
                   DIM_OPEN(), index, DIM_CLOSE(), BOLD_OPEN(), path ? path : "?", BOLD_CLOSE(), BOLD_OPEN(), ms, BOLD_CLOSE(), extra, attempt);
        }
        bjv_free(value);
    }
    free(path);
    bjv_free(batch);
    if (done == 0) httpd_respond(s, req, 500, "text/plain", NULL, "", 0);
    else if (failed) {
        char hdr[4200]; snprintf(hdr, sizeof hdr, "X-Sukkal-Done: %s\r\n", done_list);
        httpd_respond(s, req, 200, "text/plain", hdr, "", 0);
    } else httpd_respond(s, req, 200, "text/plain", NULL, "", 0);
    fflush(stdout);
}

static const char *mime_of(const char *path) {
    static const struct { const char *ext, *type; } TYPES[] = {
        { ".html", "text/html; charset=utf-8" }, { ".css", "text/css; charset=utf-8" },
        { ".js", "text/javascript; charset=utf-8" }, { ".mjs", "text/javascript; charset=utf-8" },
        { ".json", "application/json" }, { ".xml", "application/xml" }, { ".txt", "text/plain; charset=utf-8" },
        { ".svg", "image/svg+xml" }, { ".png", "image/png" }, { ".jpg", "image/jpeg" }, { ".jpeg", "image/jpeg" },
        { ".gif", "image/gif" }, { ".webp", "image/webp" }, { ".ico", "image/x-icon" }, { ".woff", "font/woff" }, { ".woff2", "font/woff2" },
    };
    const char *ext = extension_of(path);
    for (size_t i = 0; i < sizeof TYPES / sizeof *TYPES; i++) if (ieq(ext, TYPES[i].ext)) return TYPES[i].type;
    return "application/octet-stream";
}

/* HTML with the live-reload client injected — serve-time only. */
static char *with_reload(const uint8_t *html, size_t len, size_t *out_len) {
    const char *end = NULL;
    for (size_t i = 0; i + 7 <= len; i++) if (memcmp(html + i, "</body>", 7) == 0) { end = (const char *)html + i; break; }
    size_t n = len + strlen(RELOAD_SNIPPET) + 2;
    char *out = malloc(n + 1);
    if (end) {
        size_t before = (size_t)(end - (const char *)html);
        memcpy(out, html, before);
        size_t o = before;
        o += (size_t)snprintf(out + o, n + 1 - o, "%s\n", RELOAD_SNIPPET);
        memcpy(out + o, end, len - before);
        o += len - before;
        out[o] = 0; *out_len = o;
    } else {
        memcpy(out, html, len);
        memcpy(out + len, RELOAD_SNIPPET, strlen(RELOAD_SNIPPET));
        *out_len = len + strlen(RELOAD_SNIPPET);
        out[*out_len] = 0;
    }
    return out;
}

static void dev_handle(Httpd *s, HttpdRequest *req, void *ud) {
    Dev *d = ud;
    char consumer_path[300];
    snprintf(consumer_path, sizeof consumer_path, "/mdy/%s", d->o->consumer);
    if (d->live && strcmp(req->method, "POST") == 0 && strcmp(req->path, consumer_path) == 0) { dev_deliver(d, s, req); return; }
    if (strcmp(req->path, RELOAD_PATH) == 0) {
        httpd_keep_open(s, req, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\nretry: 300\n\n");
        return;
    }
    const char *p = req->path;
    while (*p == '/') p++;
    /* rendered pages first: /, /posts/hello/, and the slashless /posts/hello */
    char cand[3][4200]; int nc = 0;
    if (!*p) snprintf(cand[nc++], sizeof cand[0], "index.html");
    else if (p[strlen(p) - 1] == '/') snprintf(cand[nc++], sizeof cand[0], "%sindex.html", p);
    else { snprintf(cand[nc++], sizeof cand[0], "%s", p); snprintf(cand[nc++], sizeof cand[0], "%s/index.html", p); }
    for (int i = 0; i < nc; i++) {
        for (size_t k = 0; k < d->pages.count; k++) {
            Output *it = &d->pages.items[k];
            if (strcmp(it->path, cand[i]) != 0) continue;
            const char *type = mime_of(cand[i]);
            if (strncmp(type, "text/html", 9) == 0) {
                size_t n = 0; char *body = with_reload(it->bytes, it->len, &n);
                httpd_respond(s, req, 200, type, NULL, body, n);
                free(body);
            } else httpd_respond(s, req, 200, type, NULL, it->bytes, it->len);
            return;
        }
    }
    for (size_t k = 0; k < d->binaries.count; k++) {
        Output *it = &d->binaries.items[k];
        if (strcmp(it->path, p) == 0) { httpd_respond(s, req, 200, mime_of(p), NULL, it->bytes, it->len); return; }
    }
    /* static/ from disk, the site's own first, pinned inside each against traversal */
    if (*p && !ieq(extension_of(p), ".mdy") && !strstr(p, "..")) {
        for (size_t r = 0; r < d->root_count; r++) {
            char dir[4096]; snprintf(dir, sizeof dir, "%s/static", d->roots[r]);
            size_t len = 0;
            uint8_t *bytes = fsx_read(dir, p, &len);
            if (!bytes) continue;
            httpd_respond(s, req, 200, mime_of(p), NULL, bytes, len);
            free(bytes);
            return;
        }
    }
    /* 404, still carrying the reload client */
    const uint8_t *nf = NULL; size_t nflen = 0;
    for (size_t k = 0; k < d->pages.count; k++) if (strcmp(d->pages.items[k].path, "404.html") == 0) { nf = d->pages.items[k].bytes; nflen = d->pages.items[k].len; }
    char fallback[8300];
    if (!nf) {
        char esc[4200]; size_t o = 0;
        for (const char *c = req->path; *c && o + 6 < sizeof esc; c++) {
            if (*c == '&') o += (size_t)snprintf(esc + o, sizeof esc - o, "&amp;");
            else if (*c == '<') o += (size_t)snprintf(esc + o, sizeof esc - o, "&lt;");
            else if (*c == '>') o += (size_t)snprintf(esc + o, sizeof esc - o, "&gt;");
            else if (*c == '"') o += (size_t)snprintf(esc + o, sizeof esc - o, "&quot;");
            else esc[o++] = *c;
        }
        esc[o] = 0;
        nflen = (size_t)snprintf(fallback, sizeof fallback, "<h1>404</h1>\n<p><code>%s</code> not found.</p>", esc);
        nf = (const uint8_t *)fallback;
    }
    size_t n = 0; char *body = with_reload(nf, nflen, &n);
    httpd_respond(s, req, 404, "text/html; charset=utf-8", NULL, body, n);
    free(body);
}

/* A rebuild attempt: swap in on success, report either way as
 * makeServeLogger reports it. `changed` is a NUL-separated list or NULL. */
static int dev_rebuild(Dev *d, const char *changed, int first) {
    char ts[32];
    double started = now_ms();
    Outputs pages = { 0 }, binaries = { 0 };
    Messages messages = { 0 };
    char err[1024];
    mdy_engine *e = dev_build(d, &pages, &binaries, &messages, err, sizeof err);
    progress_finish(&d->progress);
    if (!first) for (const char *p = changed; p && *p; p += strlen(p) + 1)
        printf("%s%s%s %s[change]%s %s\n", DIM_OPEN(), TS(ts), DIM_CLOSE(), YELLOW_OPEN(), YELLOW_CLOSE(), p);
    if (!e) {
        outputs_clear(&pages); outputs_clear(&binaries); messages_clear(&messages);
        fprintf(stderr, "%s%s%s %s[mdy] build failed%s — still serving the last good build\n  %s\n", DIM_OPEN(), TS(ts), DIM_CLOSE(), RED_OPEN(), RED_CLOSE(), err);
        return 0;
    }
    /* swap */
    if (d->engine) mdy_engine_free(d->engine);
    d->engine = e;
    outputs_clear(&d->pages); free(d->pages.items); d->pages = pages;
    outputs_clear(&d->binaries); free(d->binaries.items); d->binaries = binaries;
    messages_clear(&d->messages); free(d->messages.names); free(d->messages.json); d->messages = messages;
    /* The engine goes on rendering — deliveries — so its collectors must
     * point at the maps that now live in `d`, not at the build's locals. */
    mdy_engine_on_emit(e, collect_emit, &d->pages);
    mdy_engine_on_binary(e, collect_binary, &d->binaries);
    mdy_engine_on_publish(e, collect_message, &d->messages);
    /* every root, the site's own first, for static/ and the watcher */
    for (size_t i = 0; i < d->root_count; i++) free(d->roots[i]);
    free(d->roots);
    size_t n = mdy_engine_root_count(e);
    d->roots = calloc(n + 1, sizeof *d->roots);
    d->root_count = 0;
    d->roots[d->root_count++] = strdup(d->root);
    for (size_t i = 0; i < n; i++) {
        const char *r = mdy_engine_root_at(e, i);
        if (strcmp(r, d->root) != 0) d->roots[d->root_count++] = strdup(r);
    }
    /* what it would have published */
    size_t held = d->messages.count;
    if (!d->live) {
        for (size_t i = 0; i < held; i++) {
            if (seen_before(&d->announced, &d->announced_count, &(size_t){d->announced_count}, d->messages.names[i])) continue;
            printf("%s%s%s %s[hold]%s %s %s— no broker; mdy build --publish sends%s\n", DIM_OPEN(), TS(ts), DIM_CLOSE(), DIM_OPEN(), DIM_CLOSE(),
                   d->messages.names[i], DIM_OPEN(), DIM_CLOSE());
        }
    }
    if (!first) {
        char holding[64] = "";
        if (held && !d->live) snprintf(holding, sizeof holding, "%s, %zu message(s) held%s", DIM_OPEN(), held, DIM_CLOSE());
        printf("%s%s%s %s[mdy]%s rendered %s%zu%s page(s) in %dms%s\n", DIM_OPEN(), TS(ts), DIM_CLOSE(), CYAN_OPEN(), CYAN_CLOSE(),
               BOLD_OPEN(), d->pages.count, BOLD_CLOSE(), (int)(now_ms() - started), holding);
    }
    if (d->live) dev_send(d, 1, 1);
    fflush(stdout);
    return 1;
}

static int cmd_dev(int argc, char **argv) {
    DevOptions o = { ".", NULL, NULL, "mdy-bus", "mdy", 4321, 0, 0, 5, 1000, 300000 };
    for (int i = 0; i < argc; i++) {
        const char *a = argv[i];
        if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) { fputs(SITE_USAGE, stdout); return 0; }
        else if (strcmp(a, "--port") == 0 && i + 1 < argc) o.port = atoi(argv[++i]);
        else if (strcmp(a, "--entry") == 0 && i + 1 < argc) o.entry = argv[++i];
        else if (strcmp(a, "--broker") == 0 && i + 1 < argc) o.broker = argv[++i];
        else if (strcmp(a, "--consumer") == 0 && i + 1 < argc) o.consumer = argv[++i];
        else if (strcmp(a, "--group") == 0 && i + 1 < argc) o.group = argv[++i];
        else if (strcmp(a, "--max-attempts") == 0 && i + 1 < argc) o.max_attempts = atoi(argv[++i]);
        else if (strcmp(a, "--backoff") == 0 && i + 1 < argc) o.backoff = atoi(argv[++i]);
        else if (strcmp(a, "--max-backoff") == 0 && i + 1 < argc) o.max_backoff = atoi(argv[++i]);
        else if (strcmp(a, "--drafts") == 0) o.drafts = 1;
        else if (strcmp(a, "--future") == 0) o.future = 1;
        else o.root_arg = a;
    }
    Dev d = { 0 };
    d.o = &o;
    d.root = absolute(o.root_arg);
    d.progress.enabled = isatty(fileno(stderr));
    double started = now_ms();

    /* the broker, if one answers */
    char broker[2048] = "";
    if (o.broker) {
        snprintf(broker, sizeof broker, "%s", o.broker);
        trim_slashes(broker);
        o.broker = broker;
        char url[2100]; snprintf(url, sizeof url, "%s/health", broker);
        HttpResponse r;
        if (http_request("GET", url, NULL, NULL, 0, &r) == 0 && r.status >= 200 && r.status < 300) d.live = 1;
        if (r.status) http_response_free(&r);
    }

    dev_rebuild(&d, NULL, 1);           /* a broken first build still serves */
    d.snapshots = calloc(d.root_count ? d.root_count : 1, sizeof *d.snapshots);
    if (!d.root_count) { d.roots = calloc(1, sizeof *d.roots); d.roots[0] = strdup(d.root); d.root_count = 1; }
    for (size_t i = 0; i < d.root_count; i++) snapshot_take(&d.snapshots[i], d.roots[i], NULL);

    d.server = httpd_listen("0.0.0.0", o.port, dev_handle, &d);
    if (!d.server) { fprintf(stderr, "%slisten EADDRINUSE: address already in use :::%d%s\n", RED_OPEN(), o.port, RED_CLOSE()); return 1; }
    char url[128]; snprintf(url, sizeof url, "http://localhost:%d/", httpd_port(d.server));

    if (d.live) {
        char host[128] = "127.0.0.1";
        http_local_address(o.broker, host, sizeof host);
        snprintf(d.token, sizeof d.token, "%08x%08x%08x%08x", (unsigned)rand(), (unsigned)rand(), (unsigned)rand(), (unsigned)rand());
        snprintf(d.callback, sizeof d.callback, "http://%s%s%s:%d/mdy/%s", strchr(host, ':') ? "[" : "", host, strchr(host, ':') ? "]" : "", httpd_port(d.server), o.consumer);
        if (dev_register(&d) != 0) d.live = 0;
        else { d.last_heartbeat = now_ms(); dev_send(&d, 1, 1); }
    }

    printf("\n  %s%sMDY%s%s  %sready in%s %s%d ms%s\n\n  %s➜%s  %sLocal:%s   %s%s%s\n%s  %s➜%s  %spress ctrl+c to stop%s\n\n",
           BOLD_OPEN(), MAGENTA_OPEN(), MAGENTA_CLOSE(), BOLD_CLOSE(), DIM_OPEN(), DIM_CLOSE(), BOLD_OPEN(), (int)(now_ms() - started), BOLD_CLOSE(),
           GREEN_OPEN(), GREEN_CLOSE(), BOLD_OPEN(), BOLD_CLOSE(), CYAN_OPEN(), url, CYAN_CLOSE(),
           d.live ? "" : "", GREEN_OPEN(), GREEN_CLOSE(), DIM_OPEN(), DIM_CLOSE());
    if (d.live) printf("  %s➜%s  %sBroker:%s  %s%s%s %s— publishing and delivering%s\n\n", GREEN_OPEN(), GREEN_CLOSE(), BOLD_OPEN(), BOLD_CLOSE(), CYAN_OPEN(), o.broker, CYAN_CLOSE(), DIM_OPEN(), DIM_CLOSE());
    fflush(stdout);

    /* the loop: serve, watch, rebuild, reload */
    char *pending = NULL; size_t pending_len = 0;
    double quiet_since = 0;
    double last_scan = now_ms();
    for (;;) {
        httpd_poll(d.server, 80);
        double t = now_ms();
        if (t - last_scan >= 120) {
            last_scan = t;
            for (size_t i = 0; i < d.root_count; i++) {
                Snapshot now; snapshot_take(&now, d.roots[i], NULL);
                char *diff = snapshot_changes(&d.snapshots[i], &now);
                if (diff) {
                    for (const char *p = diff; *p; p += strlen(p) + 1) {
                        size_t n = strlen(p) + 1;
                        pending = realloc(pending, pending_len + n + 1);
                        memcpy(pending + pending_len, p, n);
                        pending_len += n;
                        pending[pending_len] = 0;
                    }
                    free(diff);
                    quiet_since = t;
                }
                snapshot_free(&d.snapshots[i]);
                d.snapshots[i] = now;
            }
        }
        if (pending && t - quiet_since >= 80) {
            char *changed = pending; pending = NULL; pending_len = 0;
            if (dev_rebuild(&d, changed, 0)) httpd_broadcast(d.server, "data: reload\n\n", 14);
            free(changed);
        }
        if (d.live && t - d.last_heartbeat >= 30000) { d.last_heartbeat = t; dev_register(&d); }
    }
}

int main(int argc, char **argv) {
    const char *force = getenv("FORCE_COLOR"), *no = getenv("NO_COLOR");
    use_color = (force && *force) || (isatty(fileno(stdout)) && !(no && *no));

    if (argc > 1 && strcmp(argv[1], "build") == 0) return cmd_build(argc - 2, argv + 2);
    if (argc > 1 && strcmp(argv[1], "serve") == 0) {
        /* Not an alias: the rename exists to stop the CLI implying it is
         * somewhere to host a site, and a working `serve` would keep implying it. */
        fprintf(stderr, "%smdy: `mdy serve` is now `mdy dev`%s\n"
                        "  It was renamed to say what it is: a development server that rebuilds\n"
                        "  the whole site on every save and injects a live-reload script into\n"
                        "  every page. To publish a site, deploy what `mdy build` writes.\n",
                RED_OPEN(), RED_CLOSE());
        return 1;
    }
    if (argc > 1 && strcmp(argv[1], "dev") == 0) { srand((unsigned)time(NULL) ^ (unsigned)(size_t)&argc); return cmd_dev(argc - 2, argv + 2); }
    if (argc > 1 && strcmp(argv[1], "dead") == 0) return cmd_dead(argc - 2, argv + 2);
    return cmd_document(argc - 1, argv + 1);
}
