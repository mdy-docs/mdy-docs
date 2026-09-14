/*
 * YAML, for reading a document's front matter, its ```data fences, and the
 * .yaml files a site is built from.
 *
 * YAML 1.2, core schema. Correct rather than compatible: where an
 * implementation and the specification disagree this follows the
 * specification, and where a construct is not supported it says so with an
 * error instead of guessing. A parser that silently mis-reads data is worse
 * than one that refuses it — the data is what a site is built from.
 *
 * WHAT IT READS
 *
 *   - block mappings and sequences, nested by indentation, including a
 *     sequence at its key's own indent and the compact `- key: value` form
 *   - plain, single-quoted and double-quoted scalars, each of which may run
 *     across lines and fold
 *   - block scalars: literal `|` and folded `>`, with the chomping indicators
 *     `-` and `+` and an explicit indentation indicator
 *   - flow mappings and sequences, nested, and spanning lines
 *   - comments
 *   - the core schema's scalar resolution: null, booleans, integers (decimal,
 *     `0o` octal, `0x` hexadecimal), floats including `.inf` and `.nan`, and
 *     everything else a string. `Yes` is a STRING — that is 1.1's boolean, not
 *     1.2's, and the difference decides real front matter here.
 *
 * WHAT IT REFUSES, with an error naming the line
 *
 *   - anchors, aliases and merge keys (`&`, `*`, `<<`)
 *   - explicit tags (`!`, `!!`)
 *   - explicit keys (`?`) and complex keys
 *   - multiple documents in one stream, and directives (`%YAML`, `%TAG`)
 *
 * None of the four appears anywhere in the corpus this was built for — 179
 * YAML blocks across 4.9 MB were surveyed before a line was written — and each
 * is a feature to add rather than a corner to guess at.
 */
#ifndef MDYYAML_H
#define MDYYAML_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * How deep a flow collection may nest.
 *
 * `a: ` followed by two hundred thousand `[` is one short line and two
 * hundred thousand stack frames in the reader, and two hundred thousand more
 * in everything that walks the value afterwards — the JSON writer here, the
 * binjson encoder, the engine's canonical hash. Past this it is refused with
 * a message naming the line, which is what this reader does with everything
 * it will not guess at.
 */
#define MDY_YAML_MAX_DEPTH 256

typedef enum {
    MDY_YAML_NULL = 0,
    MDY_YAML_BOOL,
    MDY_YAML_NUMBER,
    MDY_YAML_STRING,
    MDY_YAML_SEQUENCE,
    MDY_YAML_MAPPING,
} mdy_yaml_type;

typedef struct mdy_yaml mdy_yaml;
typedef struct mdy_yaml_node mdy_yaml_node;

/*
 * Parse a whole stream. `len` may be 0 for a NUL-terminated string.
 *
 * On failure returns NULL and writes a message into `error` (which may be
 * NULL), of the shape `line 12: what went wrong`. An empty stream is not a
 * failure: it parses to a null node, which is what `parse("")` should give.
 */
/*
 * The exact text written into `error` when the parse stopped because it could
 * not allocate, rather than because it found a fault in the document.
 *
 * It is a constant, and not merely one of the messages, because the caller has
 * to be able to tell the two apart and cannot otherwise: a malformed document
 * is that document's problem and is reported for it, an allocation failure is
 * the whole process's and must stop the build. Every other message begins
 * `line N:`, so this one deliberately does not.
 */
#define MDY_YAML_OOM "out of memory"

mdy_yaml *mdy_yaml_parse(const char *text, size_t len, char *error, size_t error_len);
const mdy_yaml_node *mdy_yaml_root(const mdy_yaml *doc);
void mdy_yaml_free(mdy_yaml *doc);

mdy_yaml_type mdy_yaml_type_of(const mdy_yaml_node *node);

/* A string's bytes (UTF-8, NUL-terminated; `len` may be NULL), or NULL when
 * the node is not a string. */
const char *mdy_yaml_string(const mdy_yaml_node *node, size_t *len);
double mdy_yaml_number(const mdy_yaml_node *node);
int mdy_yaml_bool(const mdy_yaml_node *node);

/* Sequences and mappings, in the order they were written. */
size_t mdy_yaml_count(const mdy_yaml_node *node);
const mdy_yaml_node *mdy_yaml_at(const mdy_yaml_node *node, size_t index);
const char *mdy_yaml_key(const mdy_yaml_node *node, size_t index, size_t *len);
const mdy_yaml_node *mdy_yaml_value(const mdy_yaml_node *node, size_t index);

/* The value for `key`, or NULL. Linear, which is what a front matter block
 * wants; a caller with a large mapping should walk it once instead. */
const mdy_yaml_node *mdy_yaml_get(const mdy_yaml_node *node, const char *key);

/*
 * The tree as JSON, written the way `JSON.stringify` writes it, so two
 * implementations can be compared byte for byte. That is what it is for.
 * Caller frees. NULL on allocation failure.
 */
char *mdy_yaml_to_json(const mdy_yaml_node *node);

/* ---- building one from C, rather than from text ---------------------------
 *
 * A reader needs a writer. Everything above turns text into values; without
 * this, a caller that HAS values — a file's identity, a computed list of tags
 * — can only get them in by printing YAML and parsing it back, and then every
 * one of those values has to be escaped on the way out and can be misread on
 * the way in — a path with a quote in it makes the block unparseable, and the
 * document loses its name, its size and its date on a build that reports
 * success.
 *
 * The document that comes back is an ordinary `mdy_yaml`: `mdy_yaml_root`
 * reads it, `mdy_yaml_free` frees it, and nothing downstream can tell it from
 * a parsed one. That is the point — the merge, the binjson encoder and the
 * canonical hash all keep working on it unchanged.
 *
 * The root is always a MAPPING, and keys go in the order they are put, which
 * is what the merge depends on: `mdy_bj_document` takes a key's place from
 * the first mapping that has it and its value from the last.
 *
 * Every `put` returns 1 on success and 0 if it could not allocate. A failure
 * is remembered, so a caller may put a whole block and check once at the end:
 * `mdy_yaml_builder_done` answers NULL if any step failed, and never a
 * mapping that is missing a key it was asked for. A block that is silently
 * short is the failure mode this whole change exists to remove.
 */
typedef struct mdy_yaml_builder mdy_yaml_builder;

mdy_yaml_builder *mdy_yaml_builder_new(void);
/* Finishes and hands back the document — NULL if any put failed. The builder
 * is freed either way, so it is never left to leak on the failing path. */
mdy_yaml *mdy_yaml_builder_done(mdy_yaml_builder *b);
/* Abandon one without finishing it. */
void mdy_yaml_builder_free(mdy_yaml_builder *b);

/* `len` may be 0 for a NUL-terminated string. Keys and values are copied. */
int mdy_yaml_put_string(mdy_yaml_builder *b, const char *key, const char *value, size_t len);
int mdy_yaml_put_number(mdy_yaml_builder *b, const char *key, double value);
int mdy_yaml_put_bool(mdy_yaml_builder *b, const char *key, int value);
int mdy_yaml_put_null(mdy_yaml_builder *b, const char *key);
/* A sequence of strings, which is the shape `tags` has. `count` of 0 puts an
 * empty sequence rather than nothing, because a document that declared the
 * key and has nothing under it is a different record from one that did not. */
int mdy_yaml_put_strings(mdy_yaml_builder *b, const char *key,
                         const char *const *values, size_t count);

/*
 * A deep copy into an arena of its own. A document is one allocation block,
 * so two owners cannot share one: this is what `strdup` was for the text.
 * NULL if it could not allocate, or if the tree is nested deeper than
 * MDY_YAML_MAX_DEPTH — which a parsed one cannot be.
 */
mdy_yaml *mdy_yaml_clone(const mdy_yaml *doc);

#ifdef __cplusplus
}
#endif
#endif
