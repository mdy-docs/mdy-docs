/*
 * sukkal's copy of binjson-structures, renamed.
 *
 * sukkal vendors bjfile.c and bplustree.c at a different version from the
 * ones nisaba links into this binary, and 41 names are defined by both:
 * an exact-duplicate link error, or — worse — one library's calls bound to
 * the other's implementation. This header is -include'd into every one of
 * sukkal's translation units, so its copies keep their own names and
 * nisaba's keep theirs. The same shape as NIS_RENAME in the Makefile.
 *
 * Regenerate when either upstream moves: the list is the intersection of
 * `nm --defined-only` over the two sets of objects (see the Makefile).
 */
#ifndef MDY_SUKKAL_RENAME_H
#define MDY_SUKKAL_RENAME_H
#define bjfile_append sk_bjfile_append
#define bjfile_append_header sk_bjfile_append_header
#define bjfile_append_protected sk_bjfile_append_protected
#define bjfile_check_header sk_bjfile_check_header
#define bjfile_check_tail sk_bjfile_check_tail
#define bjfile_commit sk_bjfile_commit
#define bjfile_crc32 sk_bjfile_crc32
#define bjfile_discard sk_bjfile_discard
#define bjfile_dispose sk_bjfile_dispose
#define bjfile_init sk_bjfile_init
#define bjfile_len sk_bjfile_len
#define bjfile_read_record sk_bjfile_read_record
#define bjfile_scan_commits sk_bjfile_scan_commits
#define bjfile_set_len sk_bjfile_set_len
#define bpt_add sk_bpt_add
#define bpt_boundaries sk_bpt_boundaries
#define bpt_compact sk_bpt_compact
#define bpt_create sk_bpt_create
#define bpt_cursor_close sk_bpt_cursor_close
#define bpt_cursor_next sk_bpt_cursor_next
#define bpt_cursor_next_batch sk_bpt_cursor_next_batch
#define bpt_cursor_open sk_bpt_cursor_open
#define bpt_delete sk_bpt_delete
#define bpt_entries sk_bpt_entries
#define bpt_file_len sk_bpt_file_len
#define bpt_free sk_bpt_free
#define bpt_height sk_bpt_height
#define bpt_is_snapshot sk_bpt_is_snapshot
#define bpt_next_id sk_bpt_next_id
#define bpt_open sk_bpt_open
#define bpt_open_at sk_bpt_open_at
#define bpt_order sk_bpt_order
#define bpt_out sk_bpt_out
#define bpt_range sk_bpt_range
#define bpt_reset sk_bpt_reset
#define bpt_rewind sk_bpt_rewind
#define bpt_root sk_bpt_root
#define bpt_search sk_bpt_search
#define bpt_size sk_bpt_size
#define bpt_snapshot sk_bpt_snapshot
#define bpt_verify sk_bpt_verify
#endif
