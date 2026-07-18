import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import vm from 'node:vm';

import {
  compileTemplate,
  compileTemplateSource,
  contextBindings,
  splitDocuments,
  parseDocuments,
  extractTags,
  renderDocumentSet,
  renderEach,
  render,
  renderToMarkdown,
  createProcessor,
  MarkdownIt,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const example = (name) => readFileSync(join(here, '..', 'examples', name), 'utf8');

// --- compileTemplate ------------------------------------------------------

test('emits literal text and interpolated expressions', () => {
  const gen = compileTemplate('Hello {{ name.toUpperCase() }}, {{ 2 + 2 }}');
  assert.equal(gen({ name: 'ada' }), 'Hello ADA, 4');
});

test('{% code %} runs without emitting, {{ }} emits', () => {
  const gen = compileTemplate('{% let x = 3 %}x is {{ x }}');
  assert.equal(gen({}), 'x is 3');
});

test('shared scope across tags: loops build output', () => {
  const gen = compileTemplate(
    '{% for (const n of nums) { %}[{{ n }}]{% } %}'
  );
  assert.equal(gen({ nums: [1, 2, 3] }), '[1][2][3]');
});

test('variables declared in one tag persist to later tags', () => {
  const gen = compileTemplate('{% let total = 0 %}{% total += 10 %}{% total *= 2 %}{{ total }}');
  assert.equal(gen({}), '20');
});

test('\\{{ and \\{% are literals', () => {
  const gen = compileTemplate('output looks like \\{{ x }} and code like \\{% y %} in mdy');
  assert.equal(gen({}), 'output looks like {{ x }} and code like {% y %} in mdy');
});

test('unclosed tags throw', () => {
  assert.throws(() => compileTemplate('oops {{ x'), /unclosed "\{\{"/);
  assert.throws(() => compileTemplate('oops {% if (x) {'), /unclosed "\{%"/);
});

test('standalone {% %} lines collapse (no blank lines in output)', () => {
  const tpl = [
    '{% for (const n of nums) { %}',
    '- item {{ n }}',
    '{% } %}',
    'done',
  ].join('\n');
  const gen = compileTemplate(tpl);
  assert.equal(gen({ nums: [1, 2] }), '- item 1\n- item 2\ndone');
});

// --- compileTemplateSource ------------------------------------------------

test('compileTemplateSource exposes the generated JS statements (no `with`)', () => {
  const src = compileTemplateSource('Hi {{ name }}{% let n = 1 %}{{ n }}');
  assert.doesNotMatch(src, /with \(/);
  assert.match(src, /__out \+= \(name\)/);
  assert.match(src, /let n = 1/);
  // an embedder binds the context keys, runs the statements, reads __out:
  const fn = new Function('__ctx', `${contextBindings({ name: '' })}\n${src}\nreturn __out;`);
  assert.equal(fn({ name: 'ada' }), 'Hi ada1');
});

test('a compiled template carries its source', () => {
  const gen = compileTemplate('x={{ x }}');
  assert.equal(gen.source, compileTemplateSource('x={{ x }}'));
  assert.equal(gen({ x: 5 }), 'x=5');
});

test('contextBindings skips non-identifier and reserved keys', () => {
  const bindings = contextBindings({ ok: 1, 'not ok': 2, for: 3, JSON: 4 });
  assert.match(bindings, /let ok = __ctx\["ok"\];/);
  assert.doesNotMatch(bindings, /not ok|let for|let JSON/);
});

test('compiled source runs in a node:vm sandbox', () => {
  const src = compileTemplateSource('Hello {{ who }}, {{ 2 + 3 }}');
  const fn = vm.runInNewContext(
    `(function (__ctx) {\n${contextBindings({ who: '' })}\n${src}\nreturn __out;\n})`,
    {}
  );
  assert.equal(fn({ who: 'sandbox' }), 'Hello sandbox, 5');
});

// --- parseDocuments -------------------------------------------------------

test('front matter before +++ is parsed as YAML and stripped from the body', () => {
  const src = 'title: Hi\nn: 2\n+++\n# {{ title }}';
  const [doc] = parseDocuments(src);
  assert.deepEqual(doc.data, { title: 'Hi', n: 2 });
  assert.ok(!doc.content.includes('title: Hi'));
  assert.ok(doc.content.includes('# {{ title }}'));
});

test('a document with no +++ is all body and has empty data', () => {
  const [doc] = parseDocuments('just some markdown');
  assert.deepEqual(doc.data, {});
  assert.equal(doc.content, 'just some markdown');
});

test('an empty front matter block (leading +++) means no data', () => {
  const [doc] = parseDocuments('+++\nbody text');
  assert.deepEqual(doc.data, {});
  assert.equal(doc.content, 'body text');
});

test('blank lines after +++ are preserved (the body is plain markdown)', () => {
  const [doc] = parseDocuments('a: 1\n+++\n\n\nbody');
  assert.deepEqual(doc.data, { a: 1 });
  assert.equal(doc.content, '\n\nbody');
});

test('nest in YAML to group values', () => {
  const [doc] = parseDocuments('cfg:\n  x: 9\n+++\nbody');
  assert.deepEqual(doc.data, { cfg: { x: 9 } });
});

test('non-mapping front matter throws', () => {
  assert.throws(() => parseDocuments('- 1\n- 2\n+++\nbody'), /YAML mapping/);
});

test('```yaml fences are body content, not data', () => {
  const [doc] = parseDocuments('```yaml\ntitle: Hi\n```');
  assert.deepEqual(doc.data, {});
  assert.ok(doc.content.includes('```yaml'));
});

// --- splitDocuments -------------------------------------------------------

test('splitDocuments: no separators => one chunk; --- separates documents', () => {
  assert.deepEqual(splitDocuments('only one doc'), ['only one doc']);
  assert.deepEqual(
    splitDocuments('a: 1\n+++\nbody A\n---\nb: 2\n+++\nbody B'),
    ['a: 1\n+++\nbody A', 'b: 2\n+++\nbody B']
  );
});

test('splitDocuments: text before the first separator is a leading document', () => {
  assert.deepEqual(
    splitDocuments('preamble\n---\na: 1\n+++\nbody'),
    ['preamble', 'a: 1\n+++\nbody']
  );
});

test('splitDocuments ignores --- that is not alone on its line', () => {
  // markdown table separators / setext etc. start with other characters
  assert.deepEqual(splitDocuments('| --- | --: |\ntext'), ['| --- | --: |\ntext']);
});

test('splitDocuments drops whitespace-only documents', () => {
  // leading, trailing, and doubled --- contribute nothing
  assert.deepEqual(splitDocuments('---\na\n---'), ['a']);
  assert.deepEqual(splitDocuments('a\n---\n---\nb'), ['a', 'b']);
  assert.deepEqual(splitDocuments('   \n---\n\n'), []);
});

// --- data fences ----------------------------------------------------------

test('```data fences are parsed as YAML, merged into data, and stripped', async () => {
  const src = 'x is {{ x }}\n\n```data\nx: 1\n```\n';
  const [doc] = parseDocuments(src);
  assert.equal(doc.data.x, 1);
  assert.ok(!doc.content.includes('```data'));
  assert.equal((await renderToMarkdown(src)).trim(), 'x is 1');
});

test('later data fences win over earlier ones and over front matter', () => {
  const src = 'a: 1\nb: 1\n+++\n```data\nb: 2\nc: 2\n```\n\n```data\nc: 3\n```\n';
  const [doc] = parseDocuments(src);
  assert.deepEqual(doc.data, { a: 1, b: 2, c: 3 });
});

test('data fences are order-independent: a template above may use them', async () => {
  const out = await renderToMarkdown('total: {{ n * 2 }}\n\n```data\nn: 21\n```\n');
  assert.equal(out.trim(), 'total: 42');
});

test('an empty ```data fence contributes nothing', () => {
  const [doc] = parseDocuments('```data\n```\nbody');
  assert.deepEqual(doc.data, {});
});

test('a non-mapping ```data fence throws', () => {
  assert.throws(() => parseDocuments('```data\n- 1\n- 2\n```\n'), /YAML mapping/);
});

test('a ```data example inside a longer outer fence is display, not data', () => {
  const [doc] = parseDocuments('````\n```data\nx: 1\n```\n````\n');
  assert.deepEqual(doc.data, {});
  assert.ok(doc.content.includes('```data'));
});

test('tags from data fences union with front matter tags and body hashtags', () => {
  const src = 'tags: [alpha]\n+++\nabout #beta\n\n```data\ntags: [Gamma]\n```\n';
  const [doc] = parseDocuments(src);
  assert.deepEqual(doc.data.tags, ['alpha', 'gamma', 'beta']);
});

test('order-independent example: data fences below feed the template above', async () => {
  const out = await renderToMarkdown(example('order-independent.mdy'));
  assert.match(out, /Invoice #42/);
  assert.match(out, /Grace Hopper/);
  assert.match(out, /Order total: \$54\.47/); // 3*9.99 + 24.50
  assert.doesNotMatch(out, /```data/);
});

// --- hashtags -------------------------------------------------------------

test('extractTags finds #tags mid-text and at line start, lowercased and deduped', () => {
  assert.deepEqual(
    extractTags('this is about topic #Fred blah\n#wilma and #fred again'),
    ['fred', 'wilma']
  );
});

test('extractTags: headings, issue numbers, and URL fragments are not tags', () => {
  assert.deepEqual(extractTags('# A Heading\nsee issue #42\nhttps://x.com/page#top'), []);
});

test('extractTags allows digits, underscores, and hyphens after the first letter', () => {
  assert.deepEqual(extractTags('plans for #budget-2026 and #q3_review'), ['budget-2026', 'q3_review']);
});

test('extractTags skips code fences, inline code, and template tags', () => {
  const body = [
    '```sh',
    '# a comment, and #fenced too',
    '```',
    'inline `#code` span',
    '{{ style.color /* #hex */ }}',
    '{% let n = 1 // #note %}',
    'but #real counts',
  ].join('\n');
  assert.deepEqual(extractTags(body), ['real']);
});

test('markdown-escaped \\#tag is not a tag', () => {
  assert.deepEqual(extractTags('literally \\#fred'), []);
});

test('body hashtags land in data.tags, unioned with front matter tags', () => {
  const [doc] = parseDocuments('tags: [Alpha]\n+++\nabout #beta and #alpha');
  assert.deepEqual(doc.data.tags, ['alpha', 'beta']);
});

test('a single-string front matter tags is one tag', () => {
  const [doc] = parseDocuments('tags: solo\n+++\nbody');
  assert.deepEqual(doc.data.tags, ['solo']);
});

test('non-list front matter tags throws', () => {
  assert.throws(() => parseDocuments('tags: { a: 1 }\n+++\nbody'), /`tags` must be a list/);
});

test('an untagged document gets no tags key', () => {
  const [doc] = parseDocuments('just some markdown');
  assert.deepEqual(doc.data, {});
});

test('tags are available in the template context', async () => {
  const out = await renderToMarkdown('about #fred and #wilma\n\ntags: {{ tags.join(", ") }}');
  assert.match(out, /tags: fred, wilma/);
});

test('$.withTag finds tagged documents (case-insensitive)', async () => {
  const src = [
    '{% for (const d of $.withTag("Fred")) { %}',
    '- {{ d.name }}',
    '{% } %}',
    '---',
    'name: one',
    '+++',
    'a note about #fred',
    '---',
    'name: two',
    '+++',
    'a note about #wilma',
    '---',
    'name: three',
    '+++',
    'more on #Fred and #wilma',
  ].join('\n');
  assert.equal((await renderToMarkdown(src)).trim(), '- one\n- three');
});

test('hashtags example: entry composes the docs tagged #fred', async () => {
  const out = await renderToMarkdown(example('hashtags.mdy'));
  assert.match(out, /# Notes about fred/);
  assert.match(out, /\*\*Kickoff\*\* — tags: fred, budget-2026/);
  assert.match(out, /\*\*Pairing notes\*\* — tags: wilma, fred/);
  assert.doesNotMatch(out, /Unrelated/);
});

// --- end to end -----------------------------------------------------------

test('roster example: front matter drives the template, yaml block survives', async () => {
  const html = await render(example('roster.mdy'));
  assert.match(html, /<h1>Team Roster<\/h1>/);
  assert.match(html, /Ada Lovelace/);
  assert.match(html, /team lead/);
  assert.match(html, /2 of 3 are team leads/);
  // ```yaml block rendered as a code block, not consumed:
  assert.match(html, /<pre><code class="language-yaml">/);
  // escape sequence:
  assert.match(html, /\{\{ this stays as-is \}\}/);
});

test('invoice example: nested front matter and computed totals', async () => {
  const out = await renderToMarkdown(example('invoice.mdy'));
  assert.match(out, /Invoice #42/);
  assert.match(out, /Grace Hopper/);
  assert.match(out, /Order total: \$54\.47/); // 3*9.99 + 24.50
});

test('shared-scope example computes across tags', async () => {
  const out = await renderToMarkdown(example('shared-scope.mdy'));
  assert.match(out, /1, 1, 2, 3, 5/);
  assert.match(out, /sum is 12/);
});

test('createProcessor accepts a custom markdown-it (highlight hook)', async () => {
  const custom = new MarkdownIt({
    highlight: (code) => `<HL>${code.trim()}</HL>`,
  });
  const { render: r } = createProcessor({ md: custom });
  const html = await r('```yaml\nk: v\n```');
  assert.match(html, /<HL>k: v<\/HL>/);
});

test('extraContext is available to the template and overrides data', async () => {
  const src = 'who: world\n+++\nHello {{ who }} from {{ where }}';
  const out = await renderToMarkdown(src, { where: 'mdy', who: 'everyone' });
  assert.equal(out.trim(), 'Hello everyone from mdy');
});

test('templates run sandboxed in the VM: no process, no Function', async () => {
  const out = await renderToMarkdown('{{ typeof process }}/{{ typeof Function }}');
  assert.equal(out.trim(), 'undefined/undefined');
});

// --- multi-document sets --------------------------------------------------

test('$.find selects documents by data attributes, in document order', async () => {
  const src = [
    '{% for (const p of $.find({ kind: "person" })) { %}',
    '- {{ p.name }}',
    '{% } %}',
    '---',
    'kind: person',
    'name: Alice',
    '+++',
    '---',
    'kind: place',
    'name: Uluru',
    '+++',
    '---',
    'kind: person',
    'name: Bob',
    '+++',
  ].join('\n');
  assert.equal((await renderDocumentSet(src)).trim(), '- Alice\n- Bob');
});

test('$.find supports MongoDB query operators', async () => {
  const src = [
    '{% for (const p of $.find({ age: { $gt: 35 } })) { %}[{{ p.name }}]{% } %}',
    '---', 'name: Alice', 'age: 30', '+++',
    '---', 'name: Bob', 'age: 41', '+++',
  ].join('\n');
  assert.equal((await renderDocumentSet(src)).trim(), '[Bob]');
});

test('$.findOne returns the first match or null', async () => {
  const src = [
    'first={{ $.findOne({ kind: "x" }).name }} none={{ $.findOne({ kind: "z" }) === null }}',
    '---', 'kind: x', 'name: a', '+++',
    '---', 'kind: x', 'name: b', '+++',
  ].join('\n');
  assert.equal((await renderDocumentSet(src)).trim(), 'first=a none=true');
});

test('$.render selects its template document by query', async () => {
  const src = [
    '{% for (const m of $.find({ role: "member" })) { %}',
    '{{ $.render({ template: "card" }, m) }}',
    '{% } %}',
    '---',
    'template: card',
    '+++',
    '- {{ name }} is {{ age }}',
    '---',
    'role: member',
    'name: Alice',
    'age: 30',
    '+++',
    '---',
    'role: member',
    'name: Bob',
    'age: 41',
    '+++',
  ].join('\n');
  assert.equal((await renderDocumentSet(src)).trim(), '- Alice is 30\n- Bob is 41');
});

test('$.render by index still works (positional)', async () => {
  const src = [
    '{% for (const m of $.documents.slice(2)) { %}',
    '{{ $.render(1, m.data) }}',
    '{% } %}',
    '---',
    '- {{ name }} is {{ age }}',
    '---',
    'name: Alice',
    'age: 30',
    '+++',
    '---',
    'name: Bob',
    'age: 41',
    '+++',
  ].join('\n');
  assert.equal((await renderDocumentSet(src)).trim(), '- Alice is 30\n- Bob is 41');
});

test('$.render on an unmatched query rejects', async () => {
  await assert.rejects(
    renderToMarkdown('{{ $.render({ nope: 1 }) }}'),
    /no document matches/
  );
});

test('$.data and $.count expose the document set', async () => {
  const src = 'count={{ $.count }} second={{ $.data(1).x }}\n---\nx: 42\n+++\nsecond doc';
  assert.equal((await renderToMarkdown(src)).trim(), 'count=2 second=42');
});

test('$.render on a missing index rejects', async () => {
  await assert.rejects(renderToMarkdown('{{ $.render(9) }}'), /no document at index 9/);
});

test('cyclic $.render is caught by the depth guard', async () => {
  // two docs that each render the other
  const src = '{{ $.render(1) }}\n---\n{{ $.render(0) }}';
  await assert.rejects(renderToMarkdown(src), /render depth exceeded/);
});

test('entry index selects which document renders', async () => {
  const src = 'doc zero\n---\nx: 7\n+++\nsecond doc x={{ x }}';
  assert.equal((await renderToMarkdown(src, {}, 0)).trim(), 'doc zero');
  assert.equal((await renderToMarkdown(src, {}, 1)).trim(), 'second doc x=7');
});

test('document-set example: entry composes cards over members by query', async () => {
  const html = await render(example('document-set.mdy'));
  assert.match(html, /<h1>Team Roster<\/h1>/);
  assert.match(html, /<h3>Alice<\/h3>/);
  assert.match(html, /<h3>Bob<\/h3>/);
  assert.match(html, /go, rust/);
});

// --- multi-source sets & renderEach ---------------------------------------

test('an array of sources parses as one combined document set', () => {
  const docs = parseDocuments(['a: 1\n+++\ntemplate', 'b: 2\n+++\n---\nc: 3\n+++\n']);
  assert.deepEqual(docs.map((d) => d.data), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('$ addresses documents across sources', async () => {
  const template = 'count={{ $.count }}{% for (const d of $.find({ x: { $gte: 1 } })) { %} x={{ d.x }}{% } %}';
  const data = 'x: 1\n+++\n---\nx: 2\n+++\n';
  assert.equal((await renderDocumentSet([template, data])).trim(), 'count=3 x=1 x=2');
});

test('renderEach applies the entry template to each other document', async () => {
  const out = await renderEach(['Hi {{ name }}!', 'name: Ada\n+++\n---\nname: Bob\n+++\n']);
  assert.deepEqual(out.map((s) => s.trim()), ['Hi Ada!', 'Hi Bob!']);
});

test('renderEach: entry data is defaults, doc data overrides, extraContext wins', async () => {
  const template = 'greeting: Hello\nname: nobody\n+++\n{{ greeting }} {{ name }}';
  const data = 'name: Ada\n+++\n';
  assert.deepEqual((await renderEach([template, data])).map((s) => s.trim()), ['Hello Ada']);
  assert.deepEqual(
    (await renderEach([template, data], { greeting: 'Yo' })).map((s) => s.trim()),
    ['Yo Ada']
  );
});

test('renderEach with no sibling documents renders the entry once with its own data', async () => {
  const out = await renderEach('who: world\n+++\nhi {{ who }}');
  assert.deepEqual(out.map((s) => s.trim()), ['hi world']);
});

test('renderEach on a missing entry index rejects', async () => {
  await assert.rejects(renderEach('only one doc', {}, 5), /no document at index 5/);
});

test('invoice template applies to each invoice-data record', async () => {
  const out = await renderEach([example('invoice.mdy'), example('invoice-data.mdy')]);
  assert.equal(out.length, 2);
  assert.match(out[0], /Invoice #57/);
  assert.match(out[0], /Ada Lovelace/);
  assert.match(out[0], /Order total: \$40\.25/); // 2*12.00 + 5*3.25
  assert.match(out[1], /Invoice #58/);
  assert.match(out[1], /Order total: \$20\.99/); // 10*1.10 + 9.99
});
