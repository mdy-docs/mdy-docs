import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  compileTemplate,
  extractData,
  splitDocuments,
  renderDocumentSet,
  render,
  renderToMarkdown,
  createProcessor,
  MarkdownIt,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const example = (name) => readFileSync(join(here, '..', 'examples', name), 'utf8');
const md = new MarkdownIt();

// --- compileTemplate ------------------------------------------------------

test('emits literal text and interpolated expressions', () => {
  const gen = compileTemplate('Hello {{= name.toUpperCase() }}, {{= 2 + 2 }}');
  assert.equal(gen({ name: 'ada' }), 'Hello ADA, 4');
});

test('{{ code }} runs without emitting, {{= }} emits', () => {
  const gen = compileTemplate('{{ let x = 3 }}x is {{= x }}');
  assert.equal(gen({}), 'x is 3');
});

test('shared scope across braces: loops build output', () => {
  const gen = compileTemplate(
    '{{ for (const n of nums) { }}[{{= n }}]{{ } }}'
  );
  assert.equal(gen({ nums: [1, 2, 3] }), '[1][2][3]');
});

test('variables declared in one brace persist to later braces', () => {
  const gen = compileTemplate('{{ let total = 0 }}{{ total += 10 }}{{ total *= 2 }}{{= total }}');
  assert.equal(gen({}), '20');
});

test('\\{{ is a literal {{', () => {
  const gen = compileTemplate('code looks like \\{{ x }} in mdy');
  assert.equal(gen({}), 'code looks like {{ x }} in mdy');
});

test('unclosed brace throws', () => {
  assert.throws(() => compileTemplate('oops {{= x'), /unclosed/i);
});

test('standalone control-flow lines collapse (no blank lines in output)', () => {
  const tpl = [
    '{{ for (const n of nums) { }}',
    '- item {{= n }}',
    '{{ } }}',
    'done',
  ].join('\n');
  const gen = compileTemplate(tpl);
  assert.equal(gen({ nums: [1, 2] }), '- item 1\n- item 2\ndone');
});

// --- extractData ----------------------------------------------------------

test('```data fences are parsed as YAML and stripped', () => {
  const src = '```data\ntitle: Hi\nn: 2\n```\n\n# {{= title }}';
  const { data, template } = extractData(src, md);
  assert.deepEqual(data, { title: 'Hi', n: 2 });
  assert.ok(!template.includes('```data'));
  assert.ok(template.includes('# {{= title }}'));
});

test('```yaml fences are left untouched (render normally)', () => {
  const src = '```yaml\ntitle: Hi\n```';
  const { data, template } = extractData(src, md);
  assert.deepEqual(data, {});
  assert.ok(template.includes('```yaml'));
});

test('multiple ```data fences merge', () => {
  const src = '```data\na: 1\n```\n\n```data\nb: 2\n```';
  const { data } = extractData(src, md);
  assert.deepEqual(data, { a: 1, b: 2 });
});

test('nest in YAML to group values (no named fences)', () => {
  const src = '```data\ncfg:\n  x: 9\n```';
  const { data } = extractData(src, md);
  assert.deepEqual(data, { cfg: { x: 9 } });
});

test('a non-mapping ```data fence throws', () => {
  assert.throws(() => extractData('```data\n- 1\n- 2\n```', md), /YAML mapping/);
});

// --- end to end -----------------------------------------------------------

test('roster example: data drives the template, yaml block survives', () => {
  const html = render(example('roster.mdy'));
  assert.match(html, /<h1>Team Roster<\/h1>/);
  assert.match(html, /Ada Lovelace/);
  assert.match(html, /team lead/);
  assert.match(html, /2 of 3 are team leads/);
  // ```yaml block rendered as a code block, not consumed:
  assert.match(html, /<pre><code class="language-yaml">/);
  // escape sequence:
  assert.match(html, /\{\{ this stays as-is \}\}/);
});

test('order-independent example: data below the template still resolves', () => {
  const out = renderToMarkdown(example('order-independent.mdy'));
  assert.match(out, /Invoice #42/);
  assert.match(out, /Grace Hopper/);
  assert.match(out, /Order total: \$54\.47/); // 3*9.99 + 24.50
});

test('shared-scope example computes across braces', () => {
  const out = renderToMarkdown(example('shared-scope.mdy'));
  assert.match(out, /1, 1, 2, 3, 5/);
  assert.match(out, /sum is 12/);
});

test('createProcessor accepts a custom markdown-it (highlight hook)', () => {
  const custom = new MarkdownIt({
    highlight: (code) => `<HL>${code.trim()}</HL>`,
  });
  const { render: r } = createProcessor({ md: custom });
  const html = r('```yaml\nk: v\n```');
  assert.match(html, /<HL>k: v<\/HL>/);
});

test('extraContext is available to the template and overrides data', () => {
  const src = '```data\nwho: world\n```\nHello {{= who }} from {{= where }}';
  const out = renderToMarkdown(src, { where: 'mdy', who: 'everyone' });
  assert.equal(out.trim(), 'Hello everyone from mdy');
});

// --- multi-document sets --------------------------------------------------

test('splitDocuments splits on bare --- lines; no separators => one doc', () => {
  assert.deepEqual(splitDocuments('only one doc'), ['only one doc']);
  assert.deepEqual(splitDocuments('a\n---\nb\n---\nc'), ['a', 'b', 'c']);
});

test('splitDocuments ignores --- that is not alone on its line', () => {
  // markdown table separators / setext etc. start with other characters
  assert.deepEqual(splitDocuments('| --- | --: |\ntext'), ['| --- | --: |\ntext']);
});

test('$.render applies a template document to sibling data by index', () => {
  const src = [
    '{{ for (const m of $.documents.slice(2)) { }}',
    '{{= $.render(1, m.data) }}',
    '{{ } }}',
    '---',
    '- {{= name }} is {{= age }}',
    '---',
    '```data',
    'name: Alice',
    'age: 30',
    '```',
    '---',
    '```data',
    'name: Bob',
    'age: 41',
    '```',
  ].join('\n');
  const out = renderDocumentSet(src, md).trim();
  assert.equal(out, '- Alice is 30\n- Bob is 41');
});

test('$.data and $.count expose the document set', () => {
  const src = 'count={{= $.count }} second={{= $.data(1).x }}\n---\n```data\nx: 42\n```';
  assert.equal(renderToMarkdown(src).trim(), 'count=2 second=42');
});

test('$.render on a missing index throws', () => {
  assert.throws(() => renderToMarkdown('{{= $.render(9) }}'), /no document at index 9/);
});

test('cyclic $.render is caught by the depth guard', () => {
  // two docs that each render the other
  const src = '{{= $.render(1) }}\n---\n{{= $.render(0) }}';
  assert.throws(() => renderToMarkdown(src), /render depth exceeded/);
});

test('entry index selects which document renders', () => {
  const src = 'doc zero\n---\n```data\nx: 7\n```\nsecond doc x={{= x }}';
  assert.equal(renderToMarkdown(src, {}, 0).trim(), 'doc zero');
  assert.equal(renderToMarkdown(src, {}, 1).trim(), 'second doc x=7');
});

test('document-set example: entry composes per-item template over records', () => {
  const html = render(example('document-set.mdy'));
  assert.match(html, /<h1>Team Roster<\/h1>/);
  assert.match(html, /<h3>Alice<\/h3>/);
  assert.match(html, /<h3>Bob<\/h3>/);
  assert.match(html, /go, rust/);
});
