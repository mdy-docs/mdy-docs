import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import structure from '../src/structure.cjs';
import { parseDocuments } from '../../../../src/mdy.js';

const { scanDocuments, foldingRanges } = structure;
const here = dirname(fileURLToPath(import.meta.url));

/*
 * scanDocuments/foldingRanges (behind extension.cjs's folding and outline
 * providers) re-state the engine's document rules — bare --- splits, front
 * matter is a +++ … +++ fence, whitespace-only chunks drop. The
 * targeted tests below pin the line geometry; the sweep at the bottom pins
 * the re-statement to the engine itself, using parseDocuments as the
 * oracle over every real example file: same document COUNT means the
 * outline's `#index` details are exactly the indexes a template passes to
 * $.render(i) / $.data(i).
 */

const lines = (text) => text.split('\n');

test('an empty source is one empty document, matching the engine', () => {
  // splitDocuments' rule: nothing surviving the whitespace filter means ONE
  // empty document (index 0), never zero — an empty file renders to
  // nothing rather than erroring, and the outline agrees.
  for (const text of ['', '   \n---\n\n']) {
    const docs = scanDocuments(lines(text));
    assert.equal(docs.length, 1);
    assert.equal(docs[0].index, 0);
    assert.equal(parseDocuments(text).length, 1);
  }
});

test('one document per --- chunk, with engine indexes, separator anchors, and front-matter titles', () => {
  const docs = scanDocuments(
    lines('+++\ntitle: Roster\n+++\nbody one\n---\n+++\ntitle: Alice\nrole: member\n+++\nbody two')
  );
  assert.equal(docs.length, 2);
  assert.deepEqual(docs[0], {
    index: 0, startLine: 0, endLine: 3, separatorLine: null,
    frontMatterStartLine: 0, frontMatterEndLine: 2, title: 'Roster', titleLine: 1,
  });
  assert.deepEqual(docs[1], {
    index: 1, startLine: 5, endLine: 9, separatorLine: 4,
    frontMatterStartLine: 5, frontMatterEndLine: 8, title: 'Alice', titleLine: 6,
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
  const docs = scanDocuments(lines('just a body\ntitle: not really\n---\n+++\ntitle: an opener with no partner'));
  assert.equal(docs[0].frontMatterEndLine, null);
  assert.equal(docs[0].title, null);
  // A lone +++ used to mean empty front matter. Under the fence it is an
  // opener with nothing closing it, which parseDocument leaves as prose —
  // so there is no front matter here either, and no title.
  assert.equal(docs[1].frontMatterStartLine, null);
  assert.equal(docs[1].frontMatterEndLine, null);
  assert.equal(docs[1].title, null);
});

test('a quoted title is unquoted for the outline label', () => {
  const docs = scanDocuments(lines('+++\ntitle: "Quoted: with a colon"\n+++\nbody'));
  assert.equal(docs[0].title, 'Quoted: with a colon');
});

test('folding: front matter folds to its +++, and nothing else — no per-document ranges (see foldingRanges doc)', () => {
  const ranges = foldingRanges(
    lines('+++\ntitle: Roster\n+++\nbody one\nmore\n---\n+++\ntitle: Alice\n+++\nbody two')
  );
  assert.deepEqual(ranges, [
    { start: 0, end: 2, kind: 'frontmatter' },
    { start: 6, end: 8, kind: 'frontmatter' },
  ]);
});

test('folding: no front matter (or empty front matter) yields no ranges', () => {
  assert.deepEqual(foldingRanges(lines('only a body\nmore body')), []);
  assert.deepEqual(foldingRanges(lines('+++\nbody')), []); // an opener with no partner is prose
  assert.deepEqual(foldingRanges(lines('+++\n+++\nbody')), []); // empty, but nothing between the fences
});

// --- sweep: the engine itself is the oracle over every example file -------

const examplesDir = join(here, '..', '..', '..', '..', 'examples');
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
