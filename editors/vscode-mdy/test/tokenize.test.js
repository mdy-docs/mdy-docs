import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import onigurumaDefault from 'vscode-oniguruma';
import tm from 'vscode-textmate';

/*
 * The real thing being tested here is the hand-written control flow in
 * mdy.tmLanguage.json: front matter's begin/end gating (see its own
 * "comment" fields for why it's a same-line heuristic, not a lookahead —
 * vscode-textmate tokenizes one line at a time, so a begin pattern can
 * never see a later line), the --- document-separator's "maybe front
 * matter follows" nested region (and the [^\n]-not-[\s\S] end pattern that
 * makes it defer to the real next line instead of closing itself against
 * vscode-textmate's synthetic per-line trailing newline), the {{ }} / {% %}
 * tag boundaries, and \{{ / \{% escapes.
 *
 * source.js / source.yaml / text.html.markdown (VSCode's own bundled
 * grammars, which our real tag/front-matter/body patterns embed) aren't
 * available outside a real VSCode install, so they're stubbed with empty
 * `patterns` below — enough for `include` to resolve (an unresolved scope
 * poisons the ENTIRE containing rule, not just that one include) without
 * needing to reproduce VSCode's own grammars. What they'd highlight inside
 * those regions isn't this test's concern; where those regions start and
 * end is.
 */

const { Registry, INITIAL, parseRawGrammar } = tm;
const here = dirname(fileURLToPath(import.meta.url));
const grammarPath = join(here, '..', 'syntaxes', 'mdy.tmLanguage.json');

const STUBS = {
  'source.yaml': { scopeName: 'source.yaml', patterns: [] },
  'source.js': { scopeName: 'source.js', patterns: [] },
  'text.html.markdown': { scopeName: 'text.html.markdown', patterns: [] },
};

let grammar;
before(async () => {
  const require = createRequire(import.meta.url);
  const onigWasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  const wasmBin = onigWasm.buffer.slice(onigWasm.byteOffset, onigWasm.byteOffset + onigWasm.byteLength);
  await onigurumaDefault.loadWASM(wasmBin);
  const onigLib = Promise.resolve({
    createOnigScanner: (patterns) => new onigurumaDefault.OnigScanner(patterns),
    createOnigString: (s) => new onigurumaDefault.OnigString(s),
  });

  const registry = new Registry({
    onigLib,
    loadGrammar: async (scopeName) => {
      if (scopeName === 'text.html.markdown.mdy') {
        const content = readFileSync(grammarPath, 'utf8');
        return parseRawGrammar(content, grammarPath);
      }
      return STUBS[scopeName] ?? null;
    },
  });
  grammar = await registry.loadGrammar('text.html.markdown.mdy');
});

/** Tokenize `text` (a multi-line string) and return, per line, the
 * top-of-stack scope name for each token — the detail these tests check. */
function tokenize(text) {
  let state = INITIAL;
  return text.split('\n').map((line) => {
    const r = grammar.tokenizeLine(line, state);
    state = r.ruleStack;
    return r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scope: t.scopes[t.scopes.length - 1] }));
  });
}

test('front matter at the start of a file is scoped meta.frontmatter.mdy, ending at the bare +++ line', () => {
  const lines = tokenize('title: Team Roster\n+++\n# {{ title }}');
  assert.equal(lines[0][0].scope, 'meta.frontmatter.mdy');
  assert.equal(lines[1][0].scope, 'punctuation.definition.frontmatter.mdy');
  assert.ok(!lines[2].some((t) => t.scope.includes('frontmatter')));
});

test('a document with no +++ has no front matter at all — body starting with markdown/HTML is never mistaken for YAML', () => {
  const lines = tokenize('<!doctype html>\n<html lang="en">\n{{ content }}');
  for (const line of lines) {
    assert.ok(!line.some((t) => t.scope.includes('frontmatter')));
  }
});

test('a bare --- line is a document separator, and the next document gets its own front matter through to its own +++', () => {
  const lines = tokenize(
    ['title: Team Roster', '+++', '{% for (const m of $.find({})) { %}', '{% } %}', '---', 'role: member', 'name: Alice', '+++', '### {{ name }}'].join('\n')
  );
  assert.equal(lines[4][0].scope, 'punctuation.definition.separator.mdy'); // ---
  assert.equal(lines[5][0].scope, 'meta.frontmatter.mdy'); // role: member
  assert.equal(lines[6][0].scope, 'meta.frontmatter.mdy'); // name: Alice
  assert.equal(lines[7][0].scope, 'punctuation.definition.frontmatter.mdy'); // +++
  assert.ok(!lines[8].some((t) => t.scope.includes('frontmatter'))); // ### {{ name }}
});

test('--- with no front matter following (next line is body, not key: value) is just a separator', () => {
  const lines = tokenize(['title: X', '+++', 'body', '---', '# a heading, not front matter'].join('\n'));
  assert.equal(lines[3][0].scope, 'punctuation.definition.separator.mdy');
  assert.ok(!lines[4].some((t) => t.scope.includes('frontmatter')));
});

test('{{ }} output tags and {% %} code tags get distinct begin/end punctuation scopes', () => {
  const [line] = tokenize('{{ title }} and {% const x = 1 %}');
  const scopes = line.map((t) => t.scope);
  assert.ok(scopes.includes('punctuation.section.embedded.begin.expression.mdy'));
  assert.ok(scopes.includes('punctuation.section.embedded.end.expression.mdy'));
  assert.ok(scopes.includes('punctuation.section.embedded.begin.statement.mdy'));
  assert.ok(scopes.includes('punctuation.section.embedded.end.statement.mdy'));
});

test('a {% %} tag can span multiple lines, staying embedded throughout', () => {
  const lines = tokenize(['{%', '  const x = 1;', '  const y = 2;', '%}', 'body after'].join('\n'));
  assert.equal(lines[0][0].scope, 'punctuation.section.embedded.begin.statement.mdy');
  assert.equal(lines[1][0].scope, 'meta.embedded.line.mdy');
  assert.equal(lines[2][0].scope, 'meta.embedded.line.mdy');
  assert.equal(lines[3][0].scope, 'punctuation.section.embedded.end.statement.mdy');
  assert.ok(!lines[4].some((t) => t.scope.includes('embedded')));
});

test('$ before a . is scoped as a language variable, not a plain identifier', () => {
  const [line] = tokenize('{% $.emit("x", y) %}');
  assert.ok(line.some((t) => t.text === '$' && t.scope === 'variable.language.dollar.mdy'));
});

test('\\{{ and \\{% are escapes, not tag delimiters', () => {
  const [line] = tokenize('Literal \\{{ and \\{% here.');
  const escapes = line.filter((t) => t.scope === 'constant.character.escape.mdy').map((t) => t.text);
  assert.deepEqual(escapes, ['\\{{', '\\{%']);
  assert.ok(!line.some((t) => t.scope.includes('embedded')));
});
