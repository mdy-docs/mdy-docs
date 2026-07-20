import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize } from '../src/site/search.js';

// --- tokenize ---------------------------------------------------------------
// buildSearchIndex (the host-side batch indexer over openVault's
// pages/bodies) was removed with the conventional content/layouts/site.yaml
// pipeline — a script-defined site builds its own search-index.json
// entirely in template code via this same tokenize() as the $.tokenize
// native (see script-site.js and examples/blog/index.mdy).

test('tokenize: lowercases, strips punctuation, dedupes, drops short words and stopwords', () => {
  assert.deepEqual(
    tokenize('The Quick, Brown Fox! jumps over the lazy fox.'),
    ['quick', 'brown', 'fox', 'jumps', 'over', 'lazy']
  );
});

test('tokenize: empty or all-stopword input yields no tokens', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('the and a to'), []);
});
