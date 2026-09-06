/*
 * A watcher, by polling: a snapshot of every file under a set of roots —
 * path, size, mtime — taken again every few hundred milliseconds and diffed.
 *
 * Portable, exact enough, and one file: mdy-docs' watcher is a recursive
 * fs.watch, which has a different native shape on every platform and
 * reports the same edit two or three times, and its consumer debounces the
 * lot into one rebuild anyway. A poll at this rate is the debounce.
 * FSEvents, inotify and ReadDirectoryChangesW can stand behind the same
 * interface later, if a site ever gets large enough for the scan to show.
 *
 * What a build must not retrigger on is left out of the snapshot, as
 * serve.js's IGNORE leaves it out: dist/, node_modules/ and anything
 * dotted.
 */
#ifndef MDY_WATCH_H
#define MDY_WATCH_H

#include <stddef.h>

typedef struct { char *path; double size, mtime; } WatchedFile;
typedef struct { WatchedFile *files; size_t count, cap; } Snapshot;

/* Every file under `root`, recursively, paths relative to it. `only` limits
 * the snapshot to that one basename at the root (a watched single file). */
void snapshot_take(Snapshot *out, const char *root, const char *only);
void snapshot_free(Snapshot *s);

/*
 * The paths that differ between two snapshots — added, removed, or with a
 * different size or mtime — as a NUL-separated, doubly NUL-terminated list.
 * Caller frees. NULL when nothing changed.
 */
char *snapshot_changes(const Snapshot *before, const Snapshot *after);

/* Sleep, in milliseconds. */
void watch_sleep_ms(int ms);

#endif
