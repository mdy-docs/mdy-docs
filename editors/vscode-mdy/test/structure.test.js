import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import structure from '../src/structure.cjs';
import { parseDocuments } from '../../../src/mdy.js';

const { scanDocuments, foldingRanges } = structure;
const here = dirname(fileURLToPath(import.meta.url));

/*
 * scanDocuments/foldingRanges (behind extension.cjs's folding and outline
 * providers) re-state the engine's document rules — bare --- splits,
 * first bare +++ ends front matter, whitespace-only chunks drop. The
 * targeted tests below pin the line geometry; the sweep at the bottom pins
 * the re-statement to the engine itself, using parseDocuments as the
 * oracle over every real example file: same document COUNT means the
 * outline's `#index` details are exactly the indexes a template passes to
 * $.render(i) / $.data(i).
 */

const lines = (text) => text.split('\n');

test('one document per --- chunk, with engine indexes, separator anchors, and front-matter titles', () => {
  const docs = scanDocuments(lines('title: Roster\n+++\nbody one\n---\ntitle: Alice\nrole: member\n+++\nbody two'));
  assert.equal(docs.length, 2);
  assert.deepEqual(docs[0], {
    index: 0, startLine: 0, endLine: 2, separatorLine: null,
    frontMatterEndLine: 1, title: 'Roster', titleLine: 0,
  });
  assert.deepEqual(docs[1], {
    index: 1, startLine: 4, endLine: 7, separatorLine: 3,
    frontMatterEndLine: 6, title: 'Alice', titleLine: 4,
  });
});

test('whitespace-only chunks are dropped, so indexes stay the ENGINE indexes (leading/trailing/double ---)', () => {
  const docs = scanDocuments(lines('---\nfirst\n---\n\n---\nsecond\n---'));
  assert.equal(docs.length, 2);
  assert.equal(docs[0].index, 0);
  assert.equal(docs[0].startLine, 1);
  assert.equal(docs[1].index, 1);
  assert.equal(docs[1].startLine, 5);
  assert.equal(docs[1].separatorLine, 4);
});

test('no front matter: no title, no front-matter fold — a `title:`-looking line in the BODY is not a title', () => {
  const docs = scanDocuments(lines('just a body\ntitle: not really\n---\n+++\ntitle: also in body, after an empty front matter'));
  assert.equal(docs[0].frontMatterEndLine, null);
  assert.equal(docs[0].title, null);
  assert.equal(docs[1].frontMatterEndLine, 3); // empty front matter, explicitly allowed
  assert.equal(docs[1].title, null); // title is BELOW the +++, in the body
});

test('a quoted title is unquoted for the outline label', () => {
  const docs = scanDocuments(lines('title: "Quoted: with a colon"\n+++\nbody'));
  assert.equal(docs[0].title, 'Quoted: with a colon');
});

test('folding: front matter folds to its +++, and nothing else — no per-document ranges (see foldingRanges doc)', () => {
  const ranges = foldingRanges(lines('title: Roster\n+++\nbody one\nmore\n---\ntitle: Alice\n+++\nbody two'));
  assert.deepEqual(ranges, [
    { start: 0, end: 1, kind: 'frontmatter' },
    { start: 5, end: 6, kind: 'frontmatter' },
  ]);
});

test('folding: no front matter (or empty front matter) yields no ranges', () => {
  assert.deepEqual(foldingRanges(lines('only a body\nmore body')), []);
  assert.deepEqual(foldingRanges(lines('+++\nbody')), []); // empty front matter: nothing to fold away
});

// --- sweep: the engine itself is the oracle over every example file -------

const examplesDir = join(here, '..', '..', '..', 'examples');
const exampleFiles = readdirSync(examplesDir, { recursive: true })
  .filter((p) => p.endsWith('.mdy'))
  .sort();

for (const rel of exampleFiles) {
  test(`sweep: scanDocuments agrees with the engine's parseDocuments on examples/${rel}`, () => {
    const text = readFileSync(join(examplesDir, rel), 'utf8');
    const docs = scanDocuments(text.split('\n'));
    const parsed = parseDocuments(text);
    assert.equal(docs.length, parsed.length, 'document count (outline #indexes must be engine indexes)');
    docs.forEach((d, i) => {
      assert.equal(d.index, i);
      if (d.title !== null) {
        assert.equal(String(parsed[i].data.title), d.title, `front-matter title of document ${i}`);
      }
    });
  });
}
