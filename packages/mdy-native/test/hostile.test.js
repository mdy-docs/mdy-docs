/*
 * A hostile-input corpus, run through the AddressSanitizer build.
 *
 * The four content-triggered crashes the 2026 review found — a heap overflow
 * in URI normalization, an OOM from quadratic list growth, and stack overflows
 * in the YAML block parser and the raw-HTML walk — all survived the suite,
 * because every other test feeds WELL-FORMED input. This one does the opposite:
 * deep nesting, ill-formed UTF-8, truncation, embedded NUL, and outsized token
 * counts, each fed to the sanitizer binary. The only contract is that the tool
 * DEGRADES GRACEFULLY: it may render, or it may exit non-zero with a message,
 * but it must not die on a signal and AddressSanitizer must stay silent.
 *
 * Runs against build/mdy-asan (or $MDY_ASAN). It is deliberately not part of
 * check-cli: only the sanitizer build makes a memory bug observable, and the
 * point is to catch the NEXT one of these before it ships, not to hold two
 * binaries to one answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.env.MDY_ASAN ?? join(here, '..', 'build', 'mdy-asan');
const dir = mkdtempSync(join(tmpdir(), 'mdy-hostile-'));

const rep = (s, n) => Buffer.from(s.repeat(n));
const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const FF = (n) => Buffer.alloc(n, 0xff); /* ill-formed UTF-8 continuation bytes */

/*
 * Each case names an extension (so the file dispatch reads it as md / mdy /
 * yaml) and the argv after the path. Sizes are chosen to reach the failure a
 * fix guards against while staying under a few seconds — the depth-capped and
 * length-fixed paths now return fast even at the full pathological size; the
 * cases whose only fix would be a section-4 cursor (wiki links, raw-HTML
 * attributes) are kept moderate so they cannot hang the run.
 */
const CORPUS = [
  // ---- the four crashes this corpus exists to guard ----
  ['deep-yaml-block', 'yaml', [], bytes(rep('- ', 400000), 'x')],
  ['deep-yaml-flow', 'yaml', [], bytes('a: ', rep('[', 200000), rep(']', 200000))],
  ['bad-utf8-link-dest', 'md', ['--html'], bytes('[x](', FF(4000), ')\n')],
  ['bad-utf8-footnote', 'md', ['--html'],
    bytes('text[^', FF(4000), ']\n\n[^', FF(4000), ']: note\n')],
  ['deep-raw-html', 'md', ['--html'], rep('<b>', 200000)],
  ['huge-class-list', 'md', ['--html'], bytes('<div class="', rep('a ', 60000), '">x</div>')],

  // ---- deep nesting, every shape ----
  ['deep-md-list', 'md', ['--html'],
    bytes(Array.from({ length: 300 }, (_, i) => '  '.repeat(i) + '- x').join('\n'))],
  ['deep-blockquotes', 'md', ['--html'], bytes(rep('>', 500), ' hi\n')],
  ['deep-mdy-elements', 'mdy', ['--html'],
    bytes(Array.from({ length: 400 }, (_, i) => '  '.repeat(i) + '<d>').join('\n'))],
  ['deep-mdy-frontmatter', 'mdy', ['--html'],
    bytes('+++\ndeep:\n ', rep('- ', 400000), 'x\n+++\n= hi\n')],
  ['deep-brackets', 'md', ['--html'], bytes(rep('[', 50000), 'x', rep(']', 50000))],
  ['deep-emphasis', 'md', ['--html'], rep('*', 100000)],

  // ---- ill-formed UTF-8 elsewhere ----
  ['bad-utf8-image', 'md', ['--html'], bytes('![x](', FF(4000), ')\n')],
  ['bad-utf8-heading', 'md', ['--html'], bytes('# ', FF(2000), '\n')],
  ['bad-utf8-body', 'md', ['--html'], FF(20000)],

  // ---- truncation ----
  ['truncated-link', 'md', ['--html'], Buffer.from('[x](')],
  ['truncated-frontmatter', 'mdy', ['--html'], Buffer.from('+++\ntitle: x')],
  ['truncated-fence', 'md', ['--html'], Buffer.from('```data\nx: 1')],
  ['truncated-utf8', 'md', ['--html'], bytes('text ', Buffer.from([0xf0, 0x9f]))],

  // ---- embedded NUL ----
  ['nul-in-md', 'md', ['--html'], bytes('before', Buffer.from([0]), 'after\n')],
  ['nul-in-mdy', 'mdy', ['--html'], bytes('+++\n+++\nbefore', Buffer.from([0]), 'after\n')],
  ['nul-in-yaml', 'yaml', [], bytes('a: before', Buffer.from([0]), 'after\n')],
  ['nul-in-link', 'md', ['--html'], bytes('[x](a', Buffer.from([0]), 'b)\n')],

  // ---- outsized counts ----
  ['huge-attributes', 'md', ['--html'],
    bytes('<div ', Buffer.from(Array.from({ length: 20000 }, (_, i) => `data-a${i}`).join(' ')), '>x</div>')],
  ['long-line', 'md', ['--html'], rep('a', 5000000)],
  ['long-heading', 'md', ['--html'], bytes('# ', rep('word ', 2000), '\n')],
  ['wiki-links-open', 'mdy', ['--html'], bytes('+++\n+++\n', rep('[', 20000))],

  // ---- pathological YAML / numbers ----
  ['long-float', 'yaml', [], bytes('x: 1.', rep('0', 2000), 'e9\n')],
  ['huge-yaml-key', 'yaml', [], bytes(rep('k', 2000000), ': v\n')],
  ['deep-yaml-map', 'yaml', [], bytes('a: ', rep('{x: ', 200000), '1', rep('}', 200000))],
  ['big-ordered-marker', 'md', ['--html'], Buffer.from('123456789012345678901234567890. item\n')],

  // ---- stdin, which takes --md ----
  ['stdin-bad-utf8', null, ['-', '--md', '--html'], bytes('[x](', FF(2000), ')\n')],
];

for (const [name, ext, args, input] of CORPUS) {
  test(`hostile: ${name} degrades gracefully`, () => {
    let argv;
    if (ext === null) {
      argv = args; /* stdin: the path is "-" inside args */
    } else {
      const path = join(dir, `${name}.${ext}`);
      writeFileSync(path, input);
      argv = [path, ...args];
    }
    const r = spawnSync(bin, argv, {
      input: ext === null ? input : undefined,
      encoding: 'buffer',
      timeout: 60000,
      maxBuffer: 256 * 1024 * 1024,
      /* abort_on_error so a caught SEGV becomes a visible abort with a report,
       * and detect_leaks off — a hard exit on hostile input is fine, a leak is
       * not what this is looking for. */
      env: { ...process.env, ASAN_OPTIONS: 'abort_on_error=1:detect_leaks=0' },
    });

    const stderr = r.stderr ? r.stderr.toString('latin1') : '';
    assert.equal(r.signal, null, `killed by ${r.signal}\n${stderr.slice(0, 400)}`);
    assert.doesNotMatch(stderr, /AddressSanitizer|runtime error:|stack-overflow|heap-buffer-overflow/,
      stderr.slice(0, 600));
    /* A signal that comes back as a status (128+n) instead of r.signal. */
    assert.ok(r.status === null || r.status < 128,
      `exit ${r.status}\n${stderr.slice(0, 400)}`);
  });
}
