import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import onigurumaDefault from 'vscode-oniguruma';
import tm from 'vscode-textmate';

import { CONSTRUCTS, unhighlighted } from '../../../../test/fixtures/constructs.js';

/*
 * Every construct the language has, painted by this grammar.
 *
 * The list is shared (test/fixtures/constructs.js) with mdy-site's own
 * highlighter, because there is more than one MDY grammar in this repo and
 * they drifted: this one had no typography at all — `...`, `--` and `-->`
 * reached the editor as prose — while the other had a front-matter rule for
 * only one of the two spellings the language has.
 *
 * Neither gap was anybody's fault exactly. A language change lands in
 * src/parse/ and nothing tells a grammar. This test is the telling.
 *
 * It asserts only that a construct's characters come out with SOME scope on
 * them, never which. Pinning scope names would make this a second grammar
 * to maintain, and would fail on a rename that broke nothing.
 */

const ROOT = 'text.html.markdown.mdy';
const here = dirname(fileURLToPath(import.meta.url));
const grammarPath = join(here, '..', 'syntaxes', 'mdy.tmLanguage.json');

let grammar;
before(async () => {
  const require = createRequire(import.meta.url);
  const onigWasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await onigurumaDefault.loadWASM(
    onigWasm.buffer.slice(onigWasm.byteOffset, onigWasm.byteOffset + onigWasm.byteLength),
  );
  const registry = new tm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (p) => new onigurumaDefault.OnigScanner(p),
      createOnigString: (s) => new onigurumaDefault.OnigString(s),
    }),
    loadGrammar: async (scopeName) =>
      scopeName === ROOT
        ? tm.parseRawGrammar(readFileSync(grammarPath, 'utf8'), grammarPath)
        : { scopeName, patterns: [] },
  });
  grammar = await registry.loadGrammar(ROOT);
});

/** Where this grammar painted something, as offsets into `source`. */
function paintedSpans(source) {
  const spans = [];
  let state = tm.INITIAL;
  let offset = 0;
  for (const line of source.split('\n')) {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    for (const token of result.tokens) {
      // Every token carries the root scope; anything more is paint.
      if (token.scopes.some((s) => s !== ROOT)) {
        spans.push({ start: offset + token.startIndex, end: offset + token.endIndex });
      }
    }
    offset += line.length + 1;
  }
  return spans;
}

for (const construct of CONSTRUCTS) {
  test(`grammar paints ${construct.name}`, () => {
    const missing = unhighlighted(construct, paintedSpans(construct.source));
    assert.deepEqual(
      missing,
      [],
      `${construct.name}: ${JSON.stringify(missing)} came out unpainted in ${JSON.stringify(construct.source)}`,
    );
  });
}
