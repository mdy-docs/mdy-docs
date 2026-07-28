import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
 * text.html.markdown is VSCode's REAL bundled markdown grammar, vendored
 * into fixtures/ — this is what makes these tests honest. The markdown
 * grammar claims headings, list items, emphasis, tables, quotes… as its
 * own begin/end contexts, and inside those contexts the mdy grammar's
 * top-level tag patterns are never consulted — only the `injections`
 * entry reaches in there. Against an empty markdown stub every tag
 * highlights trivially and none of that is exercised (the shipped 0.0.1
 * passed its tests while dropping `# {{ self.title }}`'s delimiters in real
 * VSCode — exactly this gap).
 *
 * source.js / source.yaml (and everything ELSE the markdown grammar
 * embeds — text.html.derivative, per-language fence scopes, …) stay
 * stubbed with empty `patterns`: enough for `include` to resolve (an
 * unresolved scope poisons the ENTIRE containing rule, not just that one
 * include). What those grammars would highlight inside their regions
 * isn't this test's concern; where regions start and end is.
 */

const { Registry, INITIAL, parseRawGrammar } = tm;
const here = dirname(fileURLToPath(import.meta.url));
const grammarPath = join(here, '..', 'syntaxes', 'mdy.tmLanguage.json');

const markdownGrammarPath = join(here, 'fixtures', 'markdown.tmLanguage.json');

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
      if (scopeName === 'text.html.markdown') {
        const content = readFileSync(markdownGrammarPath, 'utf8');
        return parseRawGrammar(content, markdownGrammarPath);
      }
      // Everything else (source.js, source.yaml, text.html.derivative, the
      // markdown grammar's dozens of per-language fence scopes, …): an
      // empty stub, so every `include` resolves — see the header comment.
      return { scopeName, patterns: [] };
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
  const lines = tokenize('title: Team Roster\n+++\n# {{ self.title }}');
  assert.equal(lines[0][0].scope, 'meta.frontmatter.mdy');
  assert.equal(lines[1][0].scope, 'markup.heading.frontmatter.mdy') // top-of-stack; punctuation.definition.frontmatter.mdy sits beneath it;
  assert.ok(!lines[2].some((t) => t.scope.includes('frontmatter')));
});

test('a document with no +++ has no front matter at all — body starting with markdown/HTML is never mistaken for YAML', () => {
  const lines = tokenize('<!doctype html>\n<html lang="en">\n{{ arg.content }}');
  for (const line of lines) {
    assert.ok(!line.some((t) => t.scope.includes('frontmatter')));
  }
});

test('a bare --- line is a document separator, and the next document gets its own front matter through to its own +++', () => {
  const lines = tokenize(
    ['title: Team Roster', '+++', '{% for (const m of $.find({})) { %}', '{% } %}', '---', 'role: member', 'name: Alice', '+++', '### {{ self.name }}'].join('\n')
  );
  assert.equal(lines[4][0].scope, 'markup.heading.separator.mdy') // top-of-stack; punctuation.definition.separator.mdy sits beneath it (space-separated scopes); // ---
  assert.equal(lines[5][0].scope, 'meta.frontmatter.mdy'); // role: member
  assert.equal(lines[6][0].scope, 'meta.frontmatter.mdy'); // name: Alice
  assert.equal(lines[7][0].scope, 'markup.heading.frontmatter.mdy') // top-of-stack; punctuation.definition.frontmatter.mdy sits beneath it; // +++
  assert.ok(!lines[8].some((t) => t.scope.includes('frontmatter'))); // ### {{ self.name }}
});

test('--- with no front matter following (next line is body, not key: value) is just a separator', () => {
  const lines = tokenize(['title: X', '+++', 'body', '---', '# a heading, not front matter'].join('\n'));
  assert.equal(lines[3][0].scope, 'markup.heading.separator.mdy') // top-of-stack; punctuation.definition.separator.mdy sits beneath it (space-separated scopes);
  assert.ok(!lines[4].some((t) => t.scope.includes('frontmatter')));
});

test('{{ }} output tags and {% %} code tags get distinct begin/end punctuation scopes', () => {
  const [line] = tokenize('{{ self.title }} and {% const x = 1 %}');
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

// --- markdown-context injection: tags inside constructs markdown claims -----
// These fail without the grammar's `injections` entry: the real markdown
// grammar opens its own contexts for headings/lists/emphasis, and the
// top-level tag patterns are never consulted inside them.

/** All (line, col, kind) delimiter positions actually tokenized, where kind
 * is e.g. "begin.expression" — from the punctuation scope suffix. */
function delimiterTokens(text) {
  let state = INITIAL;
  const found = [];
  text.split('\n').forEach((line, ln) => {
    const r = grammar.tokenizeLine(line, state);
    state = r.ruleStack;
    for (const t of r.tokens) {
      const scope = t.scopes.find((s) => s.startsWith('punctuation.section.embedded.'));
      if (scope) {
        found.push({ line: ln, col: t.startIndex, kind: scope.replace('punctuation.section.embedded.', '').replace(/\.mdy$/, '') });
      }
    }
  });
  return found;
}

test('a tag inside a markdown heading keeps its delimiters (injection, not top-level patterns)', () => {
  const found = delimiterTokens('# {{ self.title }}');
  assert.deepEqual(found, [
    { line: 0, col: 2, kind: 'begin.expression' },
    { line: 0, col: 16, kind: 'end.expression' },
  ]);
});

test('tags inside list items and emphasis keep their delimiters', () => {
  const found = delimiterTokens('- **{{ d.title }}** — tags: {{ d.tags.join(", ") }}');
  assert.equal(found.filter((f) => f.kind === 'begin.expression').length, 2);
  assert.equal(found.filter((f) => f.kind === 'end.expression').length, 2);
});

test('a code tag opening an unbalanced { still finds its %} — no JS brace region may swallow the closer', () => {
  const found = delimiterTokens('{% for (const m of $.find({})) { %}\n- {{ m.name }}\n{% } %}');
  assert.deepEqual(found, [
    { line: 0, col: 0, kind: 'begin.statement' },
    { line: 0, col: 33, kind: 'end.statement' },
    { line: 1, col: 2, kind: 'begin.expression' },
    { line: 1, col: 12, kind: 'end.expression' },
    { line: 2, col: 0, kind: 'begin.statement' },
    { line: 2, col: 5, kind: 'end.statement' },
  ]);
});

test('strings and comments inside a tag stop at the closer, exactly like the engine indexOf does', () => {
  // The engine closes {% %} at the FIRST %}, even mid-string/mid-comment —
  // the grammar must not let a string/comment construct span past it.
  for (const text of ['{% const s = "a %} b" %}', '{% // trailing %} comment', '{% /* open %} */']) {
    const found = delimiterTokens(text);
    assert.equal(found[1]?.kind, 'end.statement', `no end delimiter in ${JSON.stringify(text)}`);
    assert.equal(found[1].col, text.indexOf('%}'), `end not at first %} in ${JSON.stringify(text)}`);
  }
});

// --- sweep: every example file in the repo, against the engine's own scan ---
// The oracle mirrors src/mdy.js exactly: splitDocuments' bare --- rule,
// parseDocument's first-bare-+++ front matter rule, and
// compileTemplateSource's nextOpen/indexOf tag scan (first unescaped {{ or
// {%, closed at the FIRST }} / %}, wherever it is). Every delimiter the
// ENGINE would honor must carry a tag punctuation scope — and nothing else
// may. Real example files, the real markdown grammar: this is the net that
// catches whatever construct the next example invents.

function expectedTagSpans(text) {
  const spans = [];
  const lines = text.split('\n');
  const docRanges = [];
  let docStart = 0;
  lines.forEach((line, ln) => {
    if (/^---[ \t]*$/.test(line)) { docRanges.push([docStart, ln]); docStart = ln + 1; }
  });
  docRanges.push([docStart, lines.length]);

  for (const [s, e] of docRanges) {
    const docLines = lines.slice(s, e);
    const sep = docLines.findIndex((l) => /^\+\+\+[ \t]*$/.test(l));
    const bodyStartLine = s + (sep === -1 ? 0 : sep + 1);
    const body = lines.slice(bodyStartLine, e).join('\n');
    const toPos = (offset, kind) => {
      const before = body.slice(0, offset);
      const ln = (before.match(/\n/g) ?? []).length;
      const col = offset - (before.lastIndexOf('\n') + 1);
      spans.push({ line: bodyStartLine + ln, col, kind });
    };

    let pos = 0;
    for (;;) {
      let open = null;
      for (let i = pos; ; ) {
        const out = body.indexOf('{{', i);
        const stmt = body.indexOf('{%', i);
        const idx = out === -1 ? stmt : stmt === -1 ? out : Math.min(out, stmt);
        if (idx === -1) break;
        if (idx > 0 && body[idx - 1] === '\\') { i = idx + 2; continue; }
        open = { idx, isOutput: idx === out };
        break;
      }
      if (!open) break;
      const close = body.indexOf(open.isOutput ? '}}' : '%}', open.idx + 2);
      if (close === -1) break; // the engine throws "unclosed" here; no example does this
      toPos(open.idx, open.isOutput ? 'begin.expression' : 'begin.statement');
      toPos(close, open.isOutput ? 'end.expression' : 'end.statement');
      pos = close + 2;
    }
  }
  return spans;
}

const examplesDir = join(here, '..', '..', '..', '..', 'examples');
const exampleFiles = readdirSync(examplesDir, { recursive: true })
  .filter((p) => p.endsWith('.mdy'))
  .sort();

test('sweep: examples exist to sweep', () => {
  assert.ok(exampleFiles.length >= 5, `only found ${exampleFiles.length} example .mdy files`);
});

for (const rel of exampleFiles) {
  test(`sweep: every engine-honored tag delimiter in examples/${rel} is highlighted, and no others`, () => {
    const text = readFileSync(join(examplesDir, rel), 'utf8');
    assert.deepEqual(delimiterTokens(text), expectedTagSpans(text));
  });
}

test('tag delimiters are NOT inside the JavaScript-mapped scope — only tag content is (bracket colorization)', () => {
  // meta.embedded.line.mdy maps to javascript in package.json's
  // embeddedLanguages. If a delimiter token carried it, VSCode would treat
  // {{ }} / {% %} as JS-language braces and bracket-pair-colorize them as
  // nested code pairs — template punctuation, rainbow-painted. contentName
  // (not name) on the tag regions keeps the delimiters mdy-language, where
  // language-configuration.json's "colorizedBracketPairs": [] applies.
  let state = INITIAL;
  const r = grammar.tokenizeLine('{{ self.title }} and {% const x = 1 %}', state);
  for (const t of r.tokens) {
    const isDelimiter = t.scopes.some((s) => s.startsWith('punctuation.section.embedded.'));
    const isJsMapped = t.scopes.includes('meta.embedded.line.mdy');
    if (isDelimiter) assert.ok(!isJsMapped, `delimiter token carries the JS-mapped scope: ${JSON.stringify(t.scopes)}`);
  }
  const content = r.tokens.filter((t) => t.scopes.includes('meta.embedded.line.mdy'));
  assert.ok(content.length >= 2, 'tag content should still carry the JS-mapped scope');
});
