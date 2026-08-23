import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import onigurumaDefault from 'vscode-oniguruma';
import tm from 'vscode-textmate';

import { scriptLines } from '../../../../src/parse/index.js';

/*
 * What is actually being tested here is the hand-written control flow in
 * mdy.tmLanguage.json: front matter's begin/end gating (see its own
 * "comment" fields for why it is a same-line heuristic, not a lookahead —
 * vscode-textmate tokenizes one line at a time, so a begin pattern can never
 * see a later line), the --- document-separator's "maybe front matter
 * follows" nested region (and the [^\n]-not-[\s\S] end pattern that makes it
 * defer to the real next line instead of closing itself against
 * vscode-textmate's synthetic per-line trailing newline), where a `%` line's
 * code starts and stops, and where `{{ }}` opens and closes.
 *
 * The markdown grammar is gone from these tests because it is gone from the
 * grammar: MDY has its own block rules, every one of them anchored to the
 * start of a line, so there are no foreign begin/end contexts to inject into
 * and nothing to be swallowed by. That removes a whole class of bug the old
 * grammar had to be tested against — and the sweep at the bottom is now
 * checked against the PARSER's own answer (scriptLines) rather than against a
 * scan reimplemented here.
 *
 * source.yaml stays stubbed with empty `patterns`: enough for `include` to
 * resolve (an unresolved scope poisons the ENTIRE containing rule, not just
 * that one include). What YAML highlighting would do inside front matter is
 * not this test's concern; where front matter starts and ends is.
 */

const { Registry, INITIAL, parseRawGrammar } = tm;
const here = dirname(fileURLToPath(import.meta.url));
const grammarPath = join(here, '..', 'syntaxes', 'mdy.tmLanguage.json');

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
        return parseRawGrammar(readFileSync(grammarPath, 'utf8'), grammarPath);
      }
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
    return r.tokens.map((t) => ({
      text: line.slice(t.startIndex, t.endIndex),
      scope: t.scopes[t.scopes.length - 1],
      scopes: t.scopes,
    }));
  });
}

/** Every scope on every token of a line, flattened — for "does this line
 * carry X anywhere" questions. */
const scopesOf = (line) => line.flatMap((t) => t.scopes);

// --- documents, front matter, separators -----------------------------------

test('front matter at the start of a file is scoped meta.frontmatter.mdy, ending at the bare +++ line', () => {
  const lines = tokenize('title: Team Roster\n+++\n= {{ res.data.title }}');
  assert.equal(lines[0][0].scope, 'meta.frontmatter.mdy');
  assert.equal(lines[1][0].scope, 'markup.heading.frontmatter.mdy'); // top-of-stack; punctuation.definition.frontmatter.mdy sits beneath it
  assert.ok(!lines[2].some((t) => t.scope.includes('frontmatter')));
});

test('a document with no +++ has no front matter at all — a body opening with an element is never mistaken for YAML', () => {
  const lines = tokenize('<!doctype html>\n< html lang="en"\n  {{ req.content }}');
  for (const line of lines) {
    assert.ok(!line.some((t) => t.scope.includes('frontmatter')));
  }
});

test('a bare --- line is a document separator, and the next document gets its own front matter through to its own +++', () => {
  const lines = tokenize(
    ['title: Team Roster', '+++', '% for (const m of $.find({})) {', '% }', '---', 'role: member', 'name: Alice', '+++', '=== {{ res.data.name }}'].join('\n')
  );
  assert.equal(lines[4][0].scope, 'markup.heading.separator.mdy'); // ---
  assert.equal(lines[5][0].scope, 'meta.frontmatter.mdy'); // role: member
  assert.equal(lines[6][0].scope, 'meta.frontmatter.mdy'); // name: Alice
  assert.equal(lines[7][0].scope, 'markup.heading.frontmatter.mdy'); // +++
  assert.ok(!lines[8].some((t) => t.scope.includes('frontmatter')));
});

test('--- with no front matter following (next line is body, not key: value) is just a separator', () => {
  const lines = tokenize(['title: X', '+++', 'body', '---', '= a heading, not front matter'].join('\n'));
  assert.equal(lines[3][0].scope, 'markup.heading.separator.mdy');
  assert.ok(!lines[4].some((t) => t.scope.includes('frontmatter')));
});

// --- code lines -------------------------------------------------------------

test('a % line is code from the sigil to the end of the line, and nothing after it is', () => {
  const lines = tokenize('% const x = 1\nplain text');
  assert.equal(lines[0][0].text, '%');
  assert.equal(lines[0][0].scope, 'keyword.control.script.mdy');
  assert.ok(scopesOf(lines[0]).includes('meta.embedded.line.mdy'));
  assert.ok(!scopesOf(lines[1]).includes('meta.embedded.line.mdy'));
});

test('a % line may be indented anywhere — the indent carries no meaning and neither does the markup around it', () => {
  const lines = tokenize(['      % for (const n of xs) {', '  - item', '% }'].join('\n'));
  assert.ok(scopesOf(lines[0]).includes('meta.embedded.line.mdy'));
  assert.ok(!scopesOf(lines[1]).includes('meta.embedded.line.mdy'));
  assert.ok(scopesOf(lines[1]).includes('markup.list.unnumbered.mdy'));
  assert.ok(scopesOf(lines[2]).includes('meta.embedded.line.mdy'));
});

test("a %% block runs on into the lines under it, and the closer's line is the last of it", () => {
  const lines = tokenize(['%% transform((tree) => {', '  visit(tree, "h1", rename)', '})', '= after'].join('\n'));
  assert.ok(scopesOf(lines[0]).includes('meta.embedded.block.mdy'));
  assert.ok(scopesOf(lines[1]).includes('meta.embedded.line.mdy'));
  assert.ok(scopesOf(lines[2]).includes('meta.embedded.block.mdy'));
  assert.ok(!scopesOf(lines[3]).includes('meta.embedded.block.mdy'));
  assert.ok(scopesOf(lines[3]).includes('markup.heading.mdy'));
});

test('a %% block that never closes still gives way to the next % line rather than eating the file', () => {
  // The grammar cannot count brackets — see the rule's own comment. What it
  // guarantees instead is that the damage is bounded.
  const lines = tokenize(['%% open((', 'prose that is really markup', '% back to a code line', '= a heading'].join('\n'));
  assert.ok(scopesOf(lines[2]).includes('meta.embedded.line.mdy'));
  assert.ok(!scopesOf(lines[3]).includes('meta.embedded.line.mdy'));
});

test('$ before a . is scoped as a language variable; req and res are too', () => {
  const [line] = tokenize('% $.emit("x", res.data.y)');
  assert.ok(line.some((t) => t.text === '$' && t.scope === 'variable.language.dollar.mdy'));
  assert.ok(line.some((t) => t.text === 'res' && t.scope === 'variable.language.mdy'));
});

test('a code line inside a fenced block is still code — the script stage runs before the grammar does', () => {
  const lines = tokenize(['```mdy', '% const x = 1', '```'].join('\n'));
  assert.ok(scopesOf(lines[1]).includes('meta.embedded.line.mdy'));
});

// --- interpolation ----------------------------------------------------------

test('{{ }} gets distinct begin/end punctuation scopes, and closes at the first }}', () => {
  const [line] = tokenize('{{ res.data.title }} and {{ 1 + 1 }}');
  const scopes = line.map((t) => t.scope);
  assert.equal(scopes.filter((s) => s === 'punctuation.section.embedded.begin.expression.mdy').length, 2);
  assert.equal(scopes.filter((s) => s === 'punctuation.section.embedded.end.expression.mdy').length, 2);
});

test('a string inside {{ }} stops at the closer, exactly as the compiler indexOf does', () => {
  const text = '{{ "a }} b" }}';
  const [line] = tokenize(text);
  const end = line.find((t) => t.scope === 'punctuation.section.embedded.end.expression.mdy');
  assert.ok(end);
  assert.equal(line.indexOf(end), line.findIndex((t) => t.text === '}}'));
});

test('interpolation reaches inside every block rule, because none of them opens a foreign context', () => {
  for (const source of ['= {{ x }}', '- {{ x }}', '| {{ x }} |', '< div class="{{ x }}"', '  {{ x }}']) {
    const [line] = tokenize(source);
    assert.ok(
      scopesOf(line).includes('punctuation.section.embedded.begin.expression.mdy'),
      `no interpolation in ${JSON.stringify(source)}`
    );
  }
});

test('\\% and \\{{ are escapes, not delimiters', () => {
  const [code] = tokenize('\\% not a code line');
  assert.equal(code[0].scope, 'constant.character.escape.mdy');
  assert.ok(!scopesOf(code).includes('meta.embedded.line.mdy'));

  const [output] = tokenize('Literal \\{{ x }} here.');
  assert.ok(output.some((t) => t.scope === 'constant.character.escape.mdy'));
  assert.ok(!scopesOf(output).includes('punctuation.section.embedded.begin.expression.mdy'));
});

test('delimiters are NOT inside the JavaScript-mapped scope — only content is (bracket colorization)', () => {
  // meta.embedded.line.mdy maps to javascript in package.json's
  // embeddedLanguages. If a delimiter token carried it, VSCode would treat
  // {{ }} as JS-language braces and bracket-pair-colorize them as nested code
  // pairs — template punctuation, rainbow-painted. contentName (not name) on
  // the region keeps the delimiters mdy-language, where
  // language-configuration.json's "colorizedBracketPairs": [] applies.
  const r = grammar.tokenizeLine('{{ res.data.title }}', INITIAL);
  for (const t of r.tokens) {
    const isDelimiter = t.scopes.some((s) => s.startsWith('punctuation.section.embedded.'));
    if (isDelimiter) assert.ok(!t.scopes.includes('meta.embedded.line.mdy'));
  }
  assert.ok(r.tokens.some((t) => t.scopes.includes('meta.embedded.line.mdy')));
});

// --- the block rules --------------------------------------------------------

test('= is a heading, and its level is the run of =', () => {
  const [one] = tokenize('= Title');
  assert.equal(one[0].text, '=');
  assert.ok(scopesOf(one).includes('markup.heading.mdy'));
  const [three] = tokenize('=== Sub ===');
  assert.equal(three[0].text, '===');
  assert.equal(three.at(-1).scope, 'punctuation.definition.heading.mdy'); // the decoration
});

test('an element opener names its tag and its attributes, with no closing tag to find', () => {
  const [line] = tokenize('< table class="grid" hidden');
  assert.equal(line[0].scope, 'punctuation.definition.tag.begin.mdy');
  assert.ok(line.some((t) => t.text === 'table' && t.scope === 'entity.name.tag.mdy'));
  assert.ok(line.some((t) => t.text === 'class' && t.scope === 'entity.other.attribute-name.mdy'));
  assert.ok(line.some((t) => t.text === '"grid"' && t.scope === 'string.quoted.mdy'));
  assert.ok(line.some((t) => t.text === 'hidden' && t.scope === 'entity.other.attribute-name.mdy'));
});

test('content after an opener\'s > is inline, not attributes', () => {
  const [line] = tokenize('<td>first !!and!! second');
  assert.ok(line.some((t) => t.text === '>' && t.scope === 'punctuation.definition.tag.end.mdy'));
  assert.ok(scopesOf(line).includes('markup.bold.mdy'));
});

test('a doctype is the one line of a document that names no element', () => {
  const [line] = tokenize('<!doctype html>');
  assert.equal(line[0].scope, 'entity.name.tag.doctype.mdy');
});

test('a # with whitespace after it is a comment; #tag has none and is a reference', () => {
  const [comment] = tokenize('# a note nobody renders');
  assert.equal(comment[0].scope, 'comment.line.number-sign.mdy');
  const [bare] = tokenize('#');
  assert.equal(bare[0].scope, 'comment.line.number-sign.mdy');
  const [tag] = tokenize('about #history today');
  assert.ok(tag.some((t) => t.text === 'history' && t.scope === 'variable.other.reference.mdy'));
});

test('a number is not a reference — that is how issues are written', () => {
  const [line] = tokenize('Invoice #42 and @42');
  assert.ok(!scopesOf(line).includes('variable.other.reference.mdy'));
});

test('list markers, task boxes and table delimiter rows each get their own scope', () => {
  const [item] = tokenize('- [x] shipped');
  assert.ok(scopesOf(item).includes('markup.list.unnumbered.mdy'));
  assert.ok(item.some((t) => t.text === 'x' && t.scope === 'constant.language.task.mdy'));

  const [numbered] = tokenize('1. first');
  assert.ok(scopesOf(numbered).includes('markup.list.numbered.mdy'));

  const [delim] = tokenize('| :--- | ---: |');
  assert.equal(delim[0].scope, 'markup.heading.table.mdy');
});

test('four dashes underline, three separate documents, and neither is a thematic break', () => {
  const lines = tokenize(['para', '----', '---', '***'].join('\n'));
  assert.ok(scopesOf(lines[1]).includes('markup.heading.underline.mdy'));
  assert.ok(scopesOf(lines[2]).includes('punctuation.definition.separator.mdy'));
  assert.ok(scopesOf(lines[3]).includes('markup.heading.break.mdy'));
});

test('a wiki link separates its label from where it points', () => {
  const [line] = tokenize('Read [[ the API | /docs/api ]] first.');
  assert.ok(line.some((t) => t.text === ' the API ' && t.scope === 'string.other.link.title.mdy'));
  assert.ok(line.some((t) => t.text === ' /docs/api ' && t.scope === 'markup.underline.link.mdy'));
});

test('a URL is taken whole, before the markers get a look at its //', () => {
  const [line] = tokenize('Docs at https://example.com/a_(b) and //not-emphasis');
  assert.ok(line.some((t) => t.text.startsWith('https://') && t.scope === 'markup.underline.link.mdy'));
});

test('nothing inside a raw code span is markup', () => {
  const [line] = tokenize('a ``!!literal!!`` span');
  assert.ok(line.some((t) => t.text === '``!!literal!!``' && t.scope === 'markup.inline.raw.mdy'));
});

// --- sweep: every example file in the repo, against the parser's own answer --
// The oracle is not a scan reimplemented here — it is scriptLines, the same
// function the parser and the demo editor's highlighter both ask. Every line
// the PARSER treats as code must be highlighted as code, and no other line
// may be.

const examplesDir = join(here, '..', '..', '..', '..', 'examples');
const exampleFiles = readdirSync(examplesDir, { recursive: true })
  .filter((p) => p.endsWith('.mdy'))
  .sort();

test('sweep: examples exist to sweep', () => {
  assert.ok(exampleFiles.length >= 5, `only found ${exampleFiles.length} example .mdy files`);
});

for (const rel of exampleFiles) {
  test(`sweep: every code line in examples/${rel} is highlighted as code, and no others`, () => {
    const text = readFileSync(join(examplesDir, rel), 'utf8');
    const source = text.split('\n');
    const expected = scriptLines(source);
    const got = tokenize(text).map((line) => scopesOf(line).some((s) => s.startsWith('meta.embedded.')));

    // Front matter is YAML, not code, and scriptLines is only ever handed a
    // body — so compare from the first document's +++ onward, where both
    // sides agree about what they are looking at.
    const from = source.findIndex((line) => /^\+\+\+[ \t]*$/.test(line)) + 1;

    for (let i = from; i < source.length; i += 1) {
      // An interpolation is embedded too, and is not a code LINE.
      if (!expected[i] && source[i].includes('{{')) continue;
      assert.equal(got[i], expected[i], `line ${i + 1} of ${rel}: ${JSON.stringify(source[i])}`);
    }
  });
}
