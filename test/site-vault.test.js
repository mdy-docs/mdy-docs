import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDate, rfc822, slugify } from '../src/format.js';

// src/format.js used to also hold openVault (computed fields, draft/
// future filtering, .md/.yaml interpretation, kind: 'file' inventory,
// metadata sidecars) for the conventional content/layouts/site.yaml
// pipeline — removed along with that pipeline (every site is now a
// script-defined site; see docs/site-plan.md's "Toward a script-defined
// site"). These three date/string utilities survive because they're
// genuinely generic, still used by script-site.js.

// --- normalizeDate ----------------------------------------------------------

test('normalizeDate: canonical form is YYYY-MM-DD', () => {
  assert.equal(normalizeDate(new Date(Date.UTC(2026, 6, 18))), '2026-07-18');
  assert.equal(normalizeDate('2026-07-18'), '2026-07-18');
  assert.equal(normalizeDate('2026-07-18T09:30:00Z'), '2026-07-18');
  assert.equal(normalizeDate('2026-07'), '2026-07-01');
  assert.equal(normalizeDate('yesterday'), undefined);
  assert.equal(normalizeDate(undefined), undefined);
});

// --- slugify ------------------------------------------------------------

test('slugify: lowercase, hyphens, trimmed', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  spaced  out  '), 'spaced-out');
});

// --- rfc822 -----------------------------------------------------------------

test('rfc822: canonical date → RFC 822 string for RSS pubDate', () => {
  assert.equal(rfc822('2026-07-18'), 'Sat, 18 Jul 2026 00:00:00 GMT');
});
