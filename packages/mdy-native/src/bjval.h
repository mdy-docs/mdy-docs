/*
 * A binjson value as a tree, for reading what a broker answers: an index, an
 * error, an attempt count. The engine decodes binjson into VM values for
 * documents; the command wants a few fields out of a reply and has no VM in
 * hand, and this is the few hundred bytes of decoder that reads them.
 */
#ifndef MDY_BJVAL_H
#define MDY_BJVAL_H

#include <stddef.h>
#include <stdint.h>

typedef enum { BJV_NULL, BJV_BOOL, BJV_NUMBER, BJV_STRING, BJV_BINARY, BJV_ARRAY, BJV_OBJECT } bjv_type;

typedef struct bjv {
    bjv_type type;
    double number;           /* BJV_NUMBER, BJV_BOOL (0/1) */
    char *string;            /* BJV_STRING, NUL-terminated */
    uint8_t *bytes;          /* BJV_BINARY */
    size_t len;              /* bytes' length */
    struct bjv **items;      /* BJV_ARRAY, BJV_OBJECT: the values */
    char **keys;             /* BJV_OBJECT: the keys, parallel to items */
    size_t count, cap;
} bjv;

/* One value from the front of `data`; NULL when it is not binjson. */
bjv *bjv_decode(const uint8_t *data, size_t len);
void bjv_free(bjv *v);

/* A field of an object, or NULL. */
const bjv *bjv_get(const bjv *object, const char *key);
/* A field as a number, or `fallback`. */
double bjv_number(const bjv *object, const char *key, double fallback);
/* A field as a string, or NULL. */
const char *bjv_string(const bjv *object, const char *key);
/* The value as JSON text (binary as an array of byte values). Caller frees. */
char *bjv_to_json(const bjv *v);

#endif
