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
  openDocumentSet,
  renderDocumentSet,
  renderEach,
  render,
  renderToMarkdown,
  createProcessor,
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
  assert.match(html, /<h1 id="[^"]*">Team Roster<\/h1>/);
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

test('createProcessor accepts custom rehype plugins (highlight hook)', async () => {
  // A stand-in for a real highlighter: wrap fenced code text in <mark>.
  const highlight = () => (tree) => {
    const visit = (node) => {
      if (node.tagName === 'code' && node.properties?.className?.includes('language-yaml')) {
        node.children = [{ type: 'element', tagName: 'mark', properties: {}, children: node.children }];
        return;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
  const { render: r } = createProcessor({ rehypePlugins: [highlight] });
  const html = await r('```yaml\nk: v\n```');
  assert.match(html, /<code class="language-yaml"><mark>k: v\s*<\/mark>/);
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
  assert.equal((await renderDocumentSet(src)).trim(), '\\[Bob]'); // normalized markdown escapes the literal bracket
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
  assert.match(html, /<h1 id="[^"]*">Team Roster<\/h1>/);
  assert.match(html, /<h3 id="[^"]*">Alice<\/h3>/);
  assert.match(html, /<h3 id="[^"]*">Bob<\/h3>/);
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

// --- source meta (identity) -----------------------------------------------

test('source meta merges into every document of that source', () => {
  const docs = parseDocuments([
    { text: 'a: 1\n+++\n---\na: 2\n+++\n', meta: { path: 'posts/x.mdy', section: 'posts' } },
    { text: 'a: 3\n+++\n', meta: { path: 'about.mdy' } },
    'a: 4\n+++\n',
  ]);
  assert.deepEqual(docs.map((d) => d.data), [
    { a: 1, path: 'posts/x.mdy', section: 'posts' },
    { a: 2, path: 'posts/x.mdy', section: 'posts' },
    { a: 3, path: 'about.mdy' },
    { a: 4 },
  ]);
});

test('meta wins over front matter (identity is not overridable)', () => {
  const docs = parseDocuments({ text: 'path: forged\n+++\n', meta: { path: 'real.mdy' } });
  assert.equal(docs[0].data.path, 'real.mdy');
});

test('a bare { text } source parses like a plain string', () => {
  assert.deepEqual(
    parseDocuments({ text: 'a: 1\n+++\nbody' }),
    parseDocuments('a: 1\n+++\nbody')
  );
});

test('invalid sources throw', () => {
  assert.throws(() => parseDocuments({ meta: { a: 1 } }), /source must be a string or \{ text, meta \}/);
  assert.throws(() => parseDocuments({ text: 'x', meta: ['no'] }), /`meta` must be a mapping/);
});

test('meta fields are queryable and visible in templates', async () => {
  const out = await renderDocumentSet([
    { text: '{% for (const p of $.find({ section: "posts" })) { %}{{ p.title }}@{{ p.path }};{% } %}' },
    { text: 'title: One\n+++\n---\ntitle: Two\n+++\n', meta: { section: 'posts', path: 'p.mdy' } },
  ]);
  assert.equal(out.trim(), '<One@p.mdy>;<Two@p.mdy>;'); // normalization makes the email-shaped autolinks explicit
});

// --- openDocumentSet ------------------------------------------------------

test('openDocumentSet: one set, many host-side queries and renders', async () => {
  const set = await openDocumentSet([
    { text: 'layout: post\n+++\n# {{ title }}', meta: { kind: 'layout' } },
    { text: 'title: A\n+++\n---\ntitle: B\n+++\n', meta: { kind: 'page' } },
  ]);

  assert.equal(set.docs.length, 3);

  const pages = await set.find({ kind: 'page' });
  assert.deepEqual(pages.map((p) => p.title), ['A', 'B']);

  const out = [];
  for (const p of pages) {
    out.push((await set.render({ layout: 'post' }, p)).trim());
  }
  assert.deepEqual(out, ['# A', '# B']);
});

test('openDocumentSet: find with no query returns all documents in order', async () => {
  const set = await openDocumentSet('a: 1\n+++\n---\na: 2\n+++\n');
  assert.deepEqual((await set.find()).map((d) => d.a), [1, 2]);
});

test('openDocumentSet: findOne returns first match or null', async () => {
  const set = await openDocumentSet('x: 1\n+++\n---\nx: 2\n+++\n');
  assert.equal((await set.findOne({ x: { $gt: 1 } })).x, 2);
  assert.equal(await set.findOne({ x: 99 }), null);
});

test('openDocumentSet: render by index, ctx overrides document data', async () => {
  const set = await openDocumentSet('name: default\n+++\nHi {{ name }}');
  assert.equal((await set.render(0)).trim(), 'Hi default');
  assert.equal((await set.render(0, { name: 'Ada' })).trim(), 'Hi Ada');
});

test('openDocumentSet: render on an unmatched query rejects', async () => {
  const set = await openDocumentSet('just a doc');
  await assert.rejects(set.render({ nope: 1 }), /no document matches/);
});

test('openDocumentSet: templates can still $.find and $.render inside the VM', async () => {
  const set = await openDocumentSet([
    '{% for (const d of $.find({ n: { $gte: 1 } })) { %}{{ $.render({ card: true }, d) }}{% } %}',
    'card: true\n+++\n[{{ n }}]',
    'n: 1\n+++\n---\nn: 2\n+++\n',
  ]);
  assert.equal((await set.render(0)).replace(/\s+/g, ''), '\\[1]\\[2]'); // normalized markdown escapes reference-link lookalikes
});

// --- $.parse / $.stringify --------------------------------------------------

test('$.parse gives the template an mdast tree it can walk', async () => {
  const out = await renderToMarkdown(
    '{% const tree = $.parse("# Title\\n\\nSome text") %}' +
      '{{ tree.children[0].type }}/{{ tree.children[0].depth }}/{{ tree.children[0].children[0].value }}'
  );
  assert.equal(out.trim(), 'heading/1/Title');
});

test('$.parse speaks the render pipeline dialect: GFM tables parse as tables', async () => {
  const out = await renderToMarkdown(
    '{% const tree = $.parse("| a | b |\\n| - | - |\\n| 1 | 2 |") %}{{ tree.children[0].type }}'
  );
  assert.equal(out.trim(), 'table');
});

test('$.stringify turns a hand-built mdast node back into markdown', async () => {
  const out = await renderToMarkdown(
    '{{ $.stringify({ type: "heading", depth: 2, children: [{ type: "text", value: "Built" }] }) }}'
  );
  assert.match(out, /## Built/);
});

test('$.parse → $.stringify round-trips a document', async () => {
  const out = await renderToMarkdown('{{ $.stringify($.parse("# Hi\\n\\n- one\\n- two")) }}');
  assert.match(out, /# Hi/);
  assert.match(out, /[-*] one/);
  assert.match(out, /[-*] two/);
});

test('a template can build a TOC from another document\'s rendered headings', async () => {
  const src = [
    [
      '{% const tree = $.parse($.render(1)) %}',
      '{% for (const n of tree.children) { if (n.type === "heading") { %}',
      '- {{ n.children.map((c) => c.value).join("") }} (h{{ n.depth }})',
      '{% } } %}',
    ].join('\n'),
    '# Alpha\n\ntext\n\n## Beta\n\nmore text\n\n## {{ "Gam" + "ma" }}',
  ];
  const out = await renderToMarkdown(src);
  const lines = out.trim().split('\n');
  assert.deepEqual(lines, ['- Alpha (h1)', '- Beta (h2)', '- Gamma (h2)']);
});

test('$.stringify on a non-node is a template error, not an engine crash', async () => {
  await assert.rejects(renderToMarkdown('{{ $.stringify(null) }}'), /expects an mdast node/);
});

// --- $.transform / $.toc ----------------------------------------------------

test('$.transform mutates the final tree in place (unified convention: return nothing)', async () => {
  const src = [
    '{% $.transform = (tree) => { %}',
    '{%   for (const n of tree.children) { %}',
    '{%     if (n.type === "heading") n.children = [{ type: "text", value: "REPLACED" }] %}',
    '{%   } %}',
    '{% } %}',
    '# Original',
    '',
    'Body text.',
  ].join('\n');
  const md = await renderToMarkdown(src);
  assert.match(md, /# REPLACED/);
  assert.match(md, /Body text\./);
  const html = await render(src);
  assert.match(html, /<h1[^>]*>REPLACED<\/h1>/);
});

test('$.transform may return a whole new tree', async () => {
  const src =
    '{% $.transform = () => ({ type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "swapped" }] }] }) %}anything';
  assert.equal((await renderToMarkdown(src)).trim(), 'swapped');
});

test('$.transform returning a non-node is a template error', async () => {
  await assert.rejects(
    renderToMarkdown('{% $.transform = () => 42 %}x'),
    /must return an mdast node/
  );
});

test('a transformed document embeds into another via $.render as markdown', async () => {
  const set = await openDocumentSet([
    'before / {{ $.render(1) }} / after',
    '{% $.transform = (tree) => { tree.children.push({ type: "paragraph", children: [{ type: "text", value: "appended" }] }) } %}inner',
  ]);
  const out = await set.render(0);
  assert.match(out, /before \/ inner\s+appended\s+\/ after/);
});

test('{{ $.toc() }} resolves to a link list of the document\'s own headings, including generated ones', async () => {
  const src = [
    '{{ $.toc() }}',
    '',
    '# Intro',
    '',
    'text',
    '',
    '## Details',
    '',
    '## {{ "Gener" + "ated" }}',
  ].join('\n');
  const md = await renderToMarkdown(src);
  assert.match(md, /\[Intro\]\(#intro\)/);
  assert.match(md, /\[Details\]\(#details\)/);
  assert.match(md, /\[Generated\]\(#generated\)/);
  // nested: h2 entries sit in a sub-list under the h1 entry
  assert.match(md, /^ +- \[Details\]/m);
});

test('$.toc() anchors land: rendered HTML gives headings matching GitHub-style ids', async () => {
  const html = await render('{{ $.toc() }}\n\n# One Two\n\n## One Two');
  assert.match(html, /<h1 id="one-two">One Two<\/h1>/);
  assert.match(html, /<h2 id="one-two-1">One Two<\/h2>/); // duplicate deduped
  assert.match(html, /<a href="#one-two">One Two<\/a>/);
  assert.match(html, /<a href="#one-two-1">One Two<\/a>/);
});

test('$.toc(target) returns plain entries for the template to render itself', async () => {
  const src = [
    '{% const entries = $.toc($.render(1)) %}{% for (const e of entries) { %}{{ e.depth }}:{{ e.text }}:{{ e.slug }};{% } %}',
    '# Alpha\n\n## Beta Gamma',
  ];
  const out = await renderToMarkdown(src);
  assert.equal(out.trim(), '1:Alpha:alpha;2:Beta Gamma:beta-gamma;');
});

test('$.toc() with no headings just removes the placeholder', async () => {
  const md = await renderToMarkdown('{{ $.toc() }}\n\njust a paragraph');
  assert.equal(md.trim(), 'just a paragraph');
});

// --- openDocumentSet: onQuery -----------------------------------------------

test('onQuery: fires for a template-level $.find, tagged with the rendering document\'s index', async () => {
  const seen = [];
  const set = await openDocumentSet(
    ['{% $.find({ n: { $gte: 1 } }) %}', 'n: 1\n+++\n'],
    { onQuery: (info) => seen.push(info) }
  );
  await set.render(0);
  assert.deepEqual(seen, [{ query: { n: { $gte: 1 } }, docIndex: 0 }]);
});

test('onQuery: fires for $.findOne and $.withTag too, same shape', async () => {
  const seen = [];
  const set = await openDocumentSet(
    ['{% $.findOne({ x: 1 }) %}{% $.withTag("go") %}', 'x: 1\n+++\n'],
    { onQuery: (info) => seen.push(info) }
  );
  await set.render(0);
  assert.deepEqual(seen, [
    { query: { x: 1 }, docIndex: 0 },
    { query: { tags: 'go' }, docIndex: 0 },
  ]);
});

test('onQuery: a template-level $.render-by-query counts as a query too', async () => {
  const seen = [];
  const set = await openDocumentSet(
    ['{{ $.render({ role: "card" }, {}) }}', 'role: card\n+++\nhi'],
    { onQuery: (info) => seen.push(info) }
  );
  await set.render(0);
  assert.deepEqual(seen, [{ query: { role: 'card' }, docIndex: 0 }]);
});

test('onQuery: docIndex tracks whichever document is currently rendering, including nested $.render', async () => {
  const seen = [];
  const set = await openDocumentSet(
    [
      '{{ $.render({ role: "inner" }, {}) }}', // doc 0
      'role: inner\n+++\n{% $.find({ tag: "x" }) %}inner', // doc 1 — its own $.find runs while doc 1 is rendering
    ],
    { onQuery: (info) => seen.push(info) }
  );
  await set.render(0);
  assert.deepEqual(seen, [
    { query: { role: 'inner' }, docIndex: 0 }, // doc 0's own $.render call
    { query: { tag: 'x' }, docIndex: 1 }, // doc 1's $.find, while doc 1 is the one rendering
  ]);
});

test('onQuery: fires for host-side find/findOne/render too, tagged docIndex: null', async () => {
  const seen = [];
  const set = await openDocumentSet(
    ['title: A\n+++\nhi', 'role: card\n+++\ncard'],
    { onQuery: (info) => seen.push(info) }
  );
  await set.find({ title: 'A' });
  await set.findOne({ title: 'A' });
  await set.render({ role: 'card' });
  assert.deepEqual(seen, [
    { query: { title: 'A' }, docIndex: null },
    { query: { title: 'A' }, docIndex: null },
    { query: { role: 'card' }, docIndex: null },
  ]);
});

test('onQuery: render by plain index never counts as a query (nothing to track)', async () => {
  const seen = [];
  const set = await openDocumentSet('hi', { onQuery: (info) => seen.push(info) });
  await set.render(0);
  assert.deepEqual(seen, []);
});

test('onQuery: without the option, nothing breaks (default no-op)', async () => {
  const set = await openDocumentSet('{% $.find({}) %}hi');
  assert.equal((await set.render(0)).trim(), 'hi');
});

// --- openDocumentSet: options.natives ---------------------------------------

test('natives: an embedder-supplied function is callable from a template as $.<name>(...)', async () => {
  const set = await openDocumentSet('{{ $.double(21) }}', {
    natives: { double: (n) => n * 2 },
  });
  assert.equal((await set.render(0)).trim(), '42');
});

test('natives: async natives suspend the VM and resume with the resolved value', async () => {
  const set = await openDocumentSet('{{ $.later() }}', {
    natives: { later: async () => new Promise((r) => setTimeout(() => r('done'), 5)) },
  });
  assert.equal((await set.render(0)).trim(), 'done');
});

test('natives: multiple extra natives, and args/return cross the VM boundary JSON-round-tripped', async () => {
  const set = await openDocumentSet('{{ JSON.stringify($.merge({ a: 1 }, { b: 2 })) }} {{ $.shout("hi") }}', {
    natives: {
      merge: (a, b) => ({ ...a, ...b }),
      shout: (s) => s.toUpperCase(),
    },
  });
  assert.equal((await set.render(0)).trim(), '{"a":1,"b":2} HI');
});

test('natives: coexist with find/findOne/render — no interference either direction', async () => {
  const set = await openDocumentSet(['{{ $.tag($.findOne({ n: 1 }).n) }}', 'n: 1\n+++\n'], {
    natives: { tag: (n) => `#${n}` },
  });
  assert.equal((await set.render(0)).trim(), '\\#1'); // normalized markdown escapes a line-leading #
});

test('natives: an invalid native name rejects with a clear error rather than a broken program', async () => {
  const set = await openDocumentSet('hi', { natives: { 'not valid': () => 1 } });
  await assert.rejects(set.render(0), /invalid native name/);
});

test('natives: without the option, nothing breaks (default: none extra)', async () => {
  const set = await openDocumentSet('{{ $.count }}');
  assert.equal((await set.render(0)).trim(), '1');
});

// --- openDocumentSet: options.onEmit -----------------------------------

test('onEmit: fires with the path and content a template passed to $.emit', async () => {
  const seen = [];
  const set = await openDocumentSet('{% $.emit("out.html", "<p>hi</p>") %}rendered', {
    onEmit: (info) => seen.push(info),
  });
  const out = await set.render(0);
  assert.equal(out.trim(), 'rendered'); // emit is a side effect, not the render's own output
  assert.deepEqual(seen, [{ path: 'out.html', content: '<p>hi</p>', docIndex: 0 }]);
});

test('onEmit: multiple emits from one document, in call order', async () => {
  const seen = [];
  const set = await openDocumentSet(
    '{% $.emit("a.html", "A") %}{% $.emit("b.html", "B") %}',
    { onEmit: (info) => seen.push(info) }
  );
  await set.render(0);
  assert.deepEqual(seen.map((e) => e.path), ['a.html', 'b.html']);
});

test('onEmit: docIndex tracks whichever document is currently rendering, including nested $.render', async () => {
  const seen = [];
  const set = await openDocumentSet(
    ['{% $.emit("outer.html", "outer") %}{{ $.render({ role: "inner" }, {}) }}', 'role: inner\n+++\n{% $.emit("inner.html", "inner") %}'],
    { onEmit: (info) => seen.push(info) }
  );
  await set.render(0);
  assert.deepEqual(seen, [
    { path: 'outer.html', content: 'outer', docIndex: 0 },
    { path: 'inner.html', content: 'inner', docIndex: 1 },
  ]);
});

test('onEmit: content JSON-round-trips like any native call, not limited to strings', async () => {
  const seen = [];
  const set = await openDocumentSet('{% $.emit("data.json", { records: [1, 2, 3] }) %}', {
    onEmit: (info) => seen.push(info),
  });
  await set.render(0);
  assert.deepEqual(seen, [{ path: 'data.json', content: { records: [1, 2, 3] }, docIndex: 0 }]);
});

test('onEmit: coexists with onQuery and natives — no interference in any direction', async () => {
  const queries = [];
  const emits = [];
  const set = await openDocumentSet(
    ['{% $.find({}) %}{% $.emit($.shout("out"), "x") %}', 'y'],
    {
      onQuery: (info) => queries.push(info),
      onEmit: (info) => emits.push(info),
      natives: { shout: (s) => `${s}.html` },
    }
  );
  await set.render(0);
  assert.deepEqual(queries, [{ query: {}, docIndex: 0 }]);
  assert.deepEqual(emits, [{ path: 'out.html', content: 'x', docIndex: 0 }]);
});

test('onEmit: without the option, $.emit is a harmless no-op', async () => {
  const set = await openDocumentSet('{% $.emit("out.html", "x") %}ok');
  assert.equal((await set.render(0)).trim(), 'ok');
});
