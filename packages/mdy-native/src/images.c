/*
 * Image dimensions, and resizing a PNG.
 *
 * The dimension reader is written out by hand rather than handed to stb,
 * because the set of formats mdy-docs reads dimensions for is not the set stb
 * decodes: WebP, AVIF, SVG, TIFF and ICO are all on the first list and none of
 * them on the second. Reading a header is a few bytes either way, so the
 * formats stb does know are done here too and stb is left for the one job that
 * genuinely needs a decoder.
 */
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#include "images.h"
#include "xalloc.h"

/*
 * Vendored, and it compiles a handful of helpers this build never reaches —
 * `-Wall -Wextra` says so twice, and they were the only warnings left in a
 * clean build. Silenced HERE rather than in the Makefile, so the exemption is
 * as narrow as the file it is for, and rather than in stb_image.h, which is
 * somebody else's to update.
 */
#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC diagnostic push
#  pragma GCC diagnostic ignored "-Wunused-function"
/* stb_image_resize2.h's ring_buffer_size, which it computes and then only uses
 * under an #ifdef. It appears at -O1 and not at -O2, so it was invisible until
 * the ASan build started being read for warnings as well as the default one. */
#  pragma GCC diagnostic ignored "-Wunused-but-set-variable"
#endif

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_NO_STDIO
#include "stb_image.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
/*
 * The writer's own allocator, because its answer to an exhausted one is
 * `STBIW_ASSERT(p)` -- abort(), from inside a vendored header, with no way
 * for the caller to hear about it. These three are the documented way to
 * replace it (stb_image_write.h's own notes say all or none), and they turn
 * that abort into the same one line every other allocation failure here
 * prints. It is not a patch to the vendored file. See xalloc.h.
 */
#define STBIW_MALLOC(sz)      mdy_xmalloc(sz)
#define STBIW_REALLOC(p, sz)  mdy_xrealloc(p, sz)
#define STBIW_FREE(p)         free(p)
#include "stb_image_write.h"

#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include "stb_image_resize2.h"

#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC diagnostic pop
#endif

/* ---- dimensions, from the header ------------------------------------------- */

static uint32_t be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static uint32_t le32(const uint8_t *p) {
    return ((uint32_t)p[3] << 24) | ((uint32_t)p[2] << 16) | ((uint32_t)p[1] << 8) | p[0];
}
static uint16_t be16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint16_t le16(const uint8_t *p) { return (uint16_t)((p[1] << 8) | p[0]); }

static int png_size(const uint8_t *b, size_t n, int *w, int *h) {
    /* IHDR is always the first chunk, at a fixed offset. */
    if (n < 24 || memcmp(b, "\x89PNG\r\n\x1a\n", 8) != 0) return -1;
    if (memcmp(b + 12, "IHDR", 4) != 0) return -1;
    *w = (int)be32(b + 16);
    *h = (int)be32(b + 20);
    return 0;
}

static int gif_size(const uint8_t *b, size_t n, int *w, int *h) {
    if (n < 10 || memcmp(b, "GIF8", 4) != 0) return -1;
    *w = le16(b + 6);
    *h = le16(b + 8);
    return 0;
}

static int bmp_size(const uint8_t *b, size_t n, int *w, int *h) {
    if (n < 26 || b[0] != 'B' || b[1] != 'M') return -1;
    int32_t width = (int32_t)le32(b + 18);
    int32_t height = (int32_t)le32(b + 22);
    /*
     * Magnitude taken in UNSIGNED. `-width` on a signed int is undefined for
     * INT32_MIN — a 26-byte crafted `.bmp` anywhere under a site was enough to
     * hit it — and the negation is well defined modulo 2^32 in unsigned. A
     * negative height just means the rows are stored top-down. The clamp is for
     * the one magnitude (2^31) that does not fit a signed int; a real image is
     * nowhere near it.
     */
    uint32_t uw = width < 0 ? -(uint32_t)width : (uint32_t)width;
    uint32_t uh = height < 0 ? -(uint32_t)height : (uint32_t)height;
    *w = uw > (uint32_t)INT_MAX ? INT_MAX : (int)uw;
    *h = uh > (uint32_t)INT_MAX ? INT_MAX : (int)uh;
    return 0;
}

/*
 * JPEG: walk the markers to the frame header. The size is not at a fixed
 * offset — an EXIF thumbnail, a colour profile and a comment can all come
 * first — so the segment lengths have to be followed.
 */
static int jpeg_size(const uint8_t *b, size_t n, int *w, int *h) {
    if (n < 4 || b[0] != 0xFF || b[1] != 0xD8) return -1;
    size_t i = 2;
    while (i + 3 < n) {
        if (b[i] != 0xFF) { i++; continue; }        /* resynchronise on fill bytes */
        uint8_t marker = b[i + 1];
        if (marker == 0xFF) { i++; continue; }
        if (marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
            i += 2;
            continue;                               /* no payload */
        }
        /* `be16(b + i + 2)` reads b[i+2..i+3], and the loop guard `i + 3 < n`
         * already keeps both in bounds. */
        uint16_t seg = be16(b + i + 2);
        if (seg < 2) return -1;
        /* SOF0..SOF15, except the four that are not frame headers. */
        if (marker >= 0xC0 && marker <= 0xCF &&
            marker != 0xC4 && marker != 0xC8 && marker != 0xCC) {
            if (i + 9 >= n) return -1;
            *h = be16(b + i + 5);
            *w = be16(b + i + 7);
            return 0;
        }
        i += 2 + seg;
    }
    return -1;
}

/* WebP: the VP8/VP8L/VP8X chunk inside a RIFF container, each with its own
 * layout for the same two numbers. */
static int webp_size(const uint8_t *b, size_t n, int *w, int *h) {
    if (n < 30 || memcmp(b, "RIFF", 4) != 0 || memcmp(b + 8, "WEBP", 4) != 0) return -1;
    const uint8_t *c = b + 12;
    if (memcmp(c, "VP8X", 4) == 0) {               /* extended: 24-bit, minus one */
        *w = (int)(((uint32_t)c[8] | ((uint32_t)c[9] << 8) | ((uint32_t)c[10] << 16)) + 1);
        *h = (int)(((uint32_t)c[11] | ((uint32_t)c[12] << 8) | ((uint32_t)c[13] << 16)) + 1);
        return 0;
    }
    if (memcmp(c, "VP8L", 4) == 0) {               /* lossless: 14 bits each */
        if (c[8] != 0x2F) return -1;   /* n >= 30 already, checked at the top */
        uint32_t bits = (uint32_t)c[9] | ((uint32_t)c[10] << 8) |
                        ((uint32_t)c[11] << 16) | ((uint32_t)c[12] << 24);
        *w = (int)((bits & 0x3FFF) + 1);
        *h = (int)(((bits >> 14) & 0x3FFF) + 1);
        return 0;
    }
    if (memcmp(c, "VP8 ", 4) == 0) {               /* lossy: after the start code */
        if (n < 30 || c[11] != 0x9D || c[12] != 0x01 || c[13] != 0x2A) return -1;
        *w = le16(c + 14) & 0x3FFF;
        *h = le16(c + 16) & 0x3FFF;
        return 0;
    }
    return -1;
}

/* ICO/CUR: the first directory entry, where 0 means 256. */
static int ico_size(const uint8_t *b, size_t n, int *w, int *h) {
    if (n < 22 || b[0] || b[1]) return -1;
    if ((b[2] != 1 && b[2] != 2) || b[3]) return -1;
    if (le16(b + 4) == 0) return -1;
    *w = b[6] ? b[6] : 256;
    *h = b[7] ? b[7] : 256;
    return 0;
}

/* TIFF: the ImageWidth (0x0100) and ImageLength (0x0101) tags of IFD 0. */
static int tiff_size(const uint8_t *b, size_t n, int *w, int *h) {
    if (n < 8) return -1;
    int little;
    if (memcmp(b, "II\x2a\x00", 4) == 0) little = 1;
    else if (memcmp(b, "MM\x00\x2a", 4) == 0) little = 0;
    else return -1;

    /*
     * The offset is the file's to choose and nothing has checked it yet, so
     * every sum it takes part in is done in 64 bits. `off + 2` was done in the
     * width the file gave it: 0xFFFFFFFE wrapped to 0, walked past the bounds
     * check, and `le16(b + off)` read four gigabytes past the buffer. An
     * eight-byte .tif anywhere under a site was enough to end the build.
     *
     * uint64_t rather than size_t, which is 32 bits under emscripten and would
     * wrap in exactly the same place.
     */
    uint32_t off = little ? le32(b + 4) : be32(b + 4);
    if ((uint64_t)off + 2 > n) return -1;
    uint16_t count = little ? le16(b + off) : be16(b + off);
    int have_w = 0, have_h = 0;
    for (uint16_t i = 0; i < count; i++) {
        uint64_t e = (uint64_t)off + 2 + (uint64_t)i * 12;
        if (e + 12 > n) return -1;
        const uint8_t *at = b + (size_t)e;      /* e + 12 <= n, so it fits */
        uint16_t tag = little ? le16(at) : be16(at);
        uint16_t type = little ? le16(at + 2) : be16(at + 2);
        if (tag != 0x0100 && tag != 0x0101) continue;
        /* SHORT is 3, LONG is 4, each stored inline in the value field; a
         * dimension of any other type is a file this does not read. */
        if (type != 3 && type != 4) return -1;
        uint32_t v = type == 3 ? (little ? le16(at + 8) : be16(at + 8))
                               : (little ? le32(at + 8) : be32(at + 8));
        if (v > 0x7fffffff) return -1;
        if (tag == 0x0100) { *w = (int)v; have_w = 1; } else { *h = (int)v; have_h = 1; }
        if (have_w && have_h) return 0;
    }
    return -1;
}

/*
 * AVIF and HEIC: ISOBMFF, read as the `image-size` package reads it, since
 * that is what writes the record on the other side: the first `ispe` box in
 * `meta` > `iprp` > `ipco`, its width less the right crop of a `clap` box
 * that follows it in the same `ipco`.
 */

/* The box named `name` at or after `at`, within `end`: its offset and size
 * through `*size`, or 0 when there is none. A box shorter than its header is
 * where the search stops, as it is for image-size. */
static size_t find_box(const uint8_t *b, size_t at, size_t end, const char *name, size_t *size) {
    while (at + 8 <= end) {
        uint32_t box = be32(b + at);
        if (box < 8 || (uint64_t)at + box > end) return 0;
        if (memcmp(b + at + 4, name, 4) == 0) { *size = box; return at; }
        at += box;
    }
    return 0;
}

static int isobmff_size(const uint8_t *b, size_t n, int *w, int *h) {
    if (n < 12 || memcmp(b + 4, "ftyp", 4) != 0) return -1;
    size_t size = 0;
    size_t meta = find_box(b, 0, n, "meta", &size);
    if (!meta) return -1;
    size_t meta_end = meta + size;
    size_t iprp = find_box(b, meta + 12, meta_end, "iprp", &size);   /* meta is a full box: 4 more bytes */
    if (!iprp) return -1;
    size_t iprp_end = iprp + size;
    size_t ipco = find_box(b, iprp + 8, iprp_end, "ipco", &size);
    if (!ipco) return -1;
    size_t ipco_end = ipco + size;
    size_t ispe = find_box(b, ipco + 8, ipco_end, "ispe", &size);
    if (!ispe || ispe + 20 > ipco_end) return -1;
    uint32_t width = be32(b + ispe + 12), height = be32(b + ispe + 16);
    size_t clap = find_box(b, ipco + 8, ipco_end, "clap", &size);
    if (clap && clap + 16 <= ipco_end) width -= be32(b + clap + 12);
    if (width == 0 || height == 0 || width > 0x7fffffff || height > 0x7fffffff) return -1;
    *w = (int)width;
    *h = (int)height;
    return 0;
}

/*
 * SVG: `width` and `height` if they are plain numbers, else the last two
 * numbers of `viewBox`. A percentage or a unit gives up rather than guessing
 * — an SVG has no intrinsic pixel size and inventing one is worse than
 * leaving the record without dimensions.
 */
static int svg_number(const uint8_t *b, size_t n, const char *attr, double *out) {
    size_t alen = strlen(attr);
    for (size_t i = 0; i + alen + 2 < n; i++) {
        if (memcmp(b + i, attr, alen) != 0) continue;
        if (i > 0) {                                /* a real attribute boundary */
            char prev = (char)b[i - 1];
            if (prev != ' ' && prev != '\t' && prev != '\n' && prev != '\r') continue;
        }
        size_t j = i + alen;
        while (j < n && (b[j] == ' ' || b[j] == '\t')) j++;
        if (j >= n || b[j] != '=') continue;
        j++;
        while (j < n && (b[j] == ' ' || b[j] == '\t' || b[j] == '"' || b[j] == '\'')) j++;
        char buf[64];
        size_t k = 0;
        while (j < n && k + 1 < sizeof buf &&
               ((b[j] >= '0' && b[j] <= '9') || b[j] == '.' || b[j] == '-' || b[j] == '+'))
            buf[k++] = (char)b[j++];
        if (k == 0) return -1;
        buf[k] = '\0';
        /* A unit or a percentage after the number: no intrinsic size. */
        if (j < n && b[j] != '"' && b[j] != '\'' && b[j] != ' ' && b[j] != '\t' &&
            b[j] != '>' && b[j] != '/')
            return -1;
        *out = atof(buf);
        return 0;
    }
    return -1;
}

/* A dimension as an int, refusing what an int cannot hold. */
static int svg_dimension(double d, int *out) {
    if (!(d > 0) || d >= 1e9) return -1;
    *out = (int)(d + 0.5);
    return 0;
}

static int svg_size(const uint8_t *b, size_t n, int *w, int *h) {
    /*
     * Only the root element's start tag is read: a `width=` on a shape inside
     * the drawing is that shape's, not the picture's. The tag is `<svg`
     * followed by whitespace or `>`, and it ends at the first `>` after it.
     */
    size_t head = n < 65536 ? n : 65536;
    size_t open = 0;
    for (open = 0; open + 4 < head; open++) {
        if (memcmp(b + open, "<svg", 4) != 0) continue;
        uint8_t next = b[open + 4];
        if (next == ' ' || next == '\t' || next == '\n' || next == '\r' || next == '>' || next == '/') break;
    }
    if (open + 4 >= head) return -1;
    const uint8_t *close = memchr(b + open, '>', head - open);
    if (!close) return -1;
    b += open;
    head = (size_t)(close - b) + 1;

    double dw = 0, dh = 0;
    if (svg_number(b, head, "width", &dw) == 0 && svg_number(b, head, "height", &dh) == 0 &&
        svg_dimension(dw, w) == 0 && svg_dimension(dh, h) == 0)
        return 0;
    for (size_t i = 0; i + 8 < head; i++) {
        if (memcmp(b + i, "viewBox", 7) != 0) continue;
        size_t j = i + 7;
        while (j < head && (b[j] == ' ' || b[j] == '=' || b[j] == '"' || b[j] == '\'')) j++;
        double v[4] = {0, 0, 0, 0};
        for (int k = 0; k < 4; k++) {
            while (j < head && (b[j] == ' ' || b[j] == ',')) j++;
            char buf[64];
            size_t m = 0;
            while (j < head && m + 1 < sizeof buf &&
                   ((b[j] >= '0' && b[j] <= '9') || b[j] == '.' || b[j] == '-' || b[j] == '+'))
                buf[m++] = (char)b[j++];
            if (m == 0) return -1;
            buf[m] = '\0';
            v[k] = atof(buf);
        }
        if (svg_dimension(v[2], w) != 0 || svg_dimension(v[3], h) != 0) return -1;
        return 0;
    }
    return -1;
}

int mdy_image_size(const uint8_t *bytes, size_t len, int *width, int *height) {
    if (!bytes || !width || !height) return -1;
    *width = *height = 0;
    /* By CONTENT, not by extension — a .png that is really a JPEG still has a
     * size, and a walk that trusted the name would report none. */
    if (png_size(bytes, len, width, height) == 0) return 0;
    if (jpeg_size(bytes, len, width, height) == 0) return 0;
    if (gif_size(bytes, len, width, height) == 0) return 0;
    if (webp_size(bytes, len, width, height) == 0) return 0;
    if (bmp_size(bytes, len, width, height) == 0) return 0;
    if (isobmff_size(bytes, len, width, height) == 0) return 0;
    if (tiff_size(bytes, len, width, height) == 0) return 0;
    if (ico_size(bytes, len, width, height) == 0) return 0;
    if (svg_size(bytes, len, width, height) == 0) return 0;
    *width = *height = 0;
    return -1;
}

/* ---- resizing --------------------------------------------------------------- */

static void collect(void *ctx, void *data, int size) {
    struct { uint8_t *bytes; size_t len; int failed; } *out = ctx;
    if (out->failed) return;
    uint8_t *grown = realloc(out->bytes, out->len + (size_t)size);
    if (!grown) { out->failed = 1; return; }
    memcpy(grown + out->len, data, (size_t)size);
    out->bytes = grown;
    out->len += (size_t)size;
}

uint8_t *mdy_image_resize_png(const uint8_t *bytes, size_t len,
                              int width, int height, size_t *out_len) {
    if (out_len) *out_len = 0;
    if (!bytes || width <= 0 || height <= 0) return NULL;

    int sw = 0, sh = 0, channels = 0;
    /* Four channels always: a PNG may be grey, paletted or RGB, and asking for
     * RGBA makes the resampler's job one case instead of four. */
    /* The stride below is width * 4 in an int, and the buffer is that times
     * the height; a request past either is refused here whatever the caller
     * checked. */
    if (width < 1 || height < 1 || width > INT_MAX / 4 || (size_t)width * 4 > SIZE_MAX / (size_t)height)
        return NULL;
    unsigned char *pixels = stbi_load_from_memory(bytes, (int)len, &sw, &sh, &channels, 4);
    if (!pixels) return NULL;

    unsigned char *scaled;
    if (sw == width && sh == height) {
        scaled = pixels;                            /* already the right size */
    } else {
        scaled = stbir_resize_uint8_srgb(pixels, sw, sh, 0, NULL, width, height, 0, STBIR_RGBA);
        stbi_image_free(pixels);
        if (!scaled) return NULL;
    }

    struct { uint8_t *bytes; size_t len; int failed; } out = { NULL, 0, 0 };
    int ok = stbi_write_png_to_func(collect, &out, width, height, 4, scaled, width * 4);
    if (scaled != pixels) free(scaled); else stbi_image_free(pixels);

    if (!ok || out.failed) { free(out.bytes); return NULL; }
    if (out_len) *out_len = out.len;
    return out.bytes;
}
