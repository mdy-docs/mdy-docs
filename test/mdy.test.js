import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import vm from 'node:vm';

import {
  compileTemplate,
  compileTemplateSource,
  splitDocuments,
  parseDocuments,
  extractTags,
  openDocumentSet,
  renderDocumentSet,
  renderEach,
  render,
  createProcessor,
  toHtml,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const example = (name) => readFileSync(join(here, '..', 'examples', name), 'utf8');

// The text a document's own code wrote, for the many tests below that are
// about what the script layer produced rather than what the parser made of
// it. renderDocumentSet gives HTML; this is the other half of the same
// render (see openDocumentSet's renderText).
const renderText = async (source, ctx = {}, entry = 0) => {
  const set = await openDocumentSet(source);
  return set.renderText(entry, ctx);
};

// --- compileTemplate ------------------------------------------------------

test('emits literal text and interpolated expressions', () => {
  const gen = compileTemplate('Hello {{ req.name.toUpperCase() }}, {{ 2 + 2 }}');
  assert.equal(gen({ name: 'ada' }), 'Hello ADA, 4');
});

test('generate takes (req, res): two separate bindings, both defaulting to empty', () => {
  const gen = compileTemplate('{{ res.data.x }}/{{ req.x }}/{{ req.x ?? res.data.x }}');
  assert.equal(gen({ x: 'passed' }, { data: { x: 'mine' } }), 'mine/passed/passed');
  assert.equal(gen({}, { data: { x: 'mine' } }), 'mine/undefined/mine');
  assert.equal(gen(), 'undefined/undefined/undefined');
});

test('a % line runs without emitting, {{ }} emits', () => {
  const gen = compileTemplate('% let x = 3\nx is {{ x }}');
  assert.equal(gen(), 'x is 3');
});

test('shared scope across code lines: loops build output', () => {
  const gen = compileTemplate('% for (const n of req.nums) {\n[{{ n }}]\n% }');
  assert.equal(gen({ nums: [1, 2, 3] }), '[1]\n[2]\n[3]');
});

test('variables declared on one code line persist to later ones', () => {
  const gen = compileTemplate('% let total = 0\n% total += 10\n% total *= 2\n{{ total }}');
  assert.equal(gen(), '20');
});

test('a % line may be indented anywhere without moving the markup it encloses', () => {
  const gen = compileTemplate(
    ['      % for (const n of req.nums) {', '  - item {{ n }}', '% }'].join('\n')
  );
  assert.equal(gen({ nums: [1, 2] }), '  - item 1\n  - item 2');
});

test('%% runs on until its brackets come back to even', () => {
  const gen = compileTemplate(
    ['%% const label = ((n) => {', '  return "n=" + n', '})(7)', '{{ label }}'].join('\n')
  );
  assert.equal(gen(), 'n=7');
});

test('\\% and \\{{ are literals', () => {
  const gen = compileTemplate('\\% not code\noutput looks like \\{{ x }} in mdy');
  assert.equal(gen(), '% not code\noutput looks like {{ x }} in mdy');
});

test('an unclosed {{ is left as the text it is, not an error', () => {
  assert.equal(compileTemplate('oops {{ x')(), 'oops {{ x');
});

test('code lines leave no blank lines behind them', () => {
  const tpl = ['% for (const n of req.nums) {', '- item {{ n }}', '% }', 'done'].join('\n');
  const gen = compileTemplate(tpl);
  assert.equal(gen({ nums: [1, 2] }), '- item 1\n- item 2\ndone');
});

// --- compileTemplateSource ------------------------------------------------

test('compileTemplateSource exposes the generated JS statements (no `with`)', () => {
  const src = compileTemplateSource('Hi {{ req.name }}\n% let n = 1\n{{ n }}');
  assert.doesNotMatch(src, /with \(/);
  assert.match(src, /\$\{ req\.name \}/);
  assert.match(src, /let n = 1/);
  // an embedder declares the two bindings — `req` (what the caller is asking
  // with) and `res` (what the document answers on) — runs the statements,
  // and reads the [line, text] pairs off __out:
  const fn = new Function('req', 'res', `${src}\nreturn __out;`);
  assert.deepEqual(fn({ name: 'ada' }, { data: {} }), [
    [0, 'Hi ada'],
    [2, '1'],
  ]);
});

test('every output line remembers the source line it was written on', () => {
  const src = compileTemplateSource(['% for (const n of [1, 2]) {', 'row {{ n }}', '% }'].join('\n'));
  const fn = new Function('req', 'res', `${src}\nreturn __out;`);
  // Both rows point at line 1 — the one line anybody could go and edit.
  assert.deepEqual(fn({}, { data: {} }), [
    [1, 'row 1'],
    [1, 'row 2'],
  ]);
});

test('a compiled template carries its source', () => {
  const gen = compileTemplate('x={{ req.x }}');
  assert.equal(gen.source, compileTemplateSource('x={{ req.x }}'));
  assert.equal(gen({ x: 5 }), 'x=5');
});

test('non-identifier and reserved-word keys are reachable via req[...]', () => {
  const gen = compileTemplate('{{ req.ok }}/{{ req["not ok"] }}/{{ req["for"] }}/{{ req.JSON }}');
  assert.equal(gen({ ok: 1, 'not ok': 2, for: 3, JSON: 4 }), '1/2/3/4');
});

test('compiled source runs in a node:vm sandbox', () => {
  const src = compileTemplateSource('Hello {{ req.who }}, {{ 2 + 3 }}');
  const fn = vm.runInNewContext(`(function (req, res) {\n${src}\nreturn __out;\n})`, {});
  // The array comes from the sandbox's own realm, so compare by value.
  assert.deepEqual(JSON.parse(JSON.stringify(fn({ who: 'sandbox' }, { data: {} }))), [
    [0, 'Hello sandbox, 5'],
  ]);
});

// --- parseDocuments -------------------------------------------------------

test('front matter before +++ is parsed as YAML and stripped from the body', () => {
  const src = '+++\ntitle: Hi\nn: 2\n+++\n# {{ res.data.title }}';
  const [doc] = parseDocuments(src);
  assert.deepEqual(doc.data, { title: 'Hi', n: 2 });
  assert.ok(!doc.content.includes('title: Hi'));
  assert.ok(doc.content.includes('# {{ res.data.title }}'));
});

test('a document with no +++ is all body and has empty data', () => {
  const [doc] = parseDocuments('just some markdown');
  assert.deepEqual(doc.data, {});
  assert.equal(doc.content, 'just some markdown');
});

test('an empty front matter block (leading +++) means no data', () => {
  const [doc] = parseDocuments('body text');
  assert.deepEqual(doc.data, {});
  assert.equal(doc.content, 'body text');
});

test('blank lines after +++ are preserved (the body is plain markdown)', () => {
  const [doc] = parseDocuments('+++\na: 1\n+++\n\n\nbody');
  assert.deepEqual(doc.data, { a: 1 });
  assert.equal(doc.content, '\n\nbody');
});

test('nest in YAML to group values', () => {
  const [doc] = parseDocuments('+++\ncfg:\n  x: 9\n+++\nbody');
  assert.deepEqual(doc.data, { cfg: { x: 9 } });
});

test('non-mapping front matter throws', () => {
  assert.throws(() => parseDocuments('+++\n- 1\n- 2\n+++\nbody'), /YAML mapping/);
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
    splitDocuments('+++\na: 1\n+++\nbody A\n---\n+++\nb: 2\n+++\nbody B'),
    ['+++\na: 1\n+++\nbody A', '+++\nb: 2\n+++\nbody B']
  );
});

test('splitDocuments: text before the first separator is a leading document', () => {
  assert.deepEqual(
    splitDocuments('preamble\n---\n+++\na: 1\n+++\nbody'),
    ['preamble', '+++\na: 1\n+++\nbody']
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
});

test('an empty source is one empty document, and renders to nothing', async () => {
  // NOT zero documents: an empty file must render (to an empty string),
  // never error with "no document at index 0" — an editor's brand-new
  // buffer is the canonical case.
  assert.deepEqual(splitDocuments(''), ['']);
  assert.deepEqual(splitDocuments('   \n---\n\n'), ['']);
  assert.deepEqual(parseDocuments(''), [{ data: {}, content: '', format: 'mdy' }]);
  assert.equal(await render(''), '');
  assert.equal(await render('  \n \n'), '');
});

// --- data fences ----------------------------------------------------------

test('```data fences are parsed as YAML, merged into data, and stripped', async () => {
  const src = 'x is {{ res.data.x }}\n\n```data\nx: 1\n```\n';
  const [doc] = parseDocuments(src);
  assert.equal(doc.data.x, 1);
  assert.ok(!doc.content.includes('```data'));
  assert.equal((await renderText(src)).trim(), 'x is 1');
});

test('later data fences win over earlier ones and over front matter', () => {
  const src = '+++\na: 1\nb: 1\n+++\n```data\nb: 2\nc: 2\n```\n\n```data\nc: 3\n```\n';
  const [doc] = parseDocuments(src);
  assert.deepEqual(doc.data, { a: 1, b: 2, c: 3 });
});

test('data fences are order-independent: a template above may use them', async () => {
  const out = await renderText('total: {{ res.data.n * 2 }}\n\n```data\nn: 21\n```\n');
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
  const src = '+++\ntags: [alpha]\n+++\nabout #beta\n\n```data\ntags: [Gamma]\n```\n';
  const [doc] = parseDocuments(src);
  assert.deepEqual(doc.data.tags, ['alpha', 'gamma', 'beta']);
});

test('order-independent example: data fences below feed the template above', async () => {
  const out = await renderText(example('order-independent.mdy'));
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
    '% let n = 1 // #note',
    'but #real counts',
  ].join('\n');
  assert.deepEqual(extractTags(body), ['real']);
});

test('markdown-escaped \\#tag is not a tag', () => {
  assert.deepEqual(extractTags('literally \\#fred'), []);
});

test('body hashtags land in data.tags, unioned with front matter tags', () => {
  const [doc] = parseDocuments('+++\ntags: [Alpha]\n+++\nabout #beta and #alpha');
  assert.deepEqual(doc.data.tags, ['alpha', 'beta']);
});

test('a single-string front matter tags is one tag', () => {
  const [doc] = parseDocuments('+++\ntags: solo\n+++\nbody');
  assert.deepEqual(doc.data.tags, ['solo']);
});

test('non-list front matter tags throws', () => {
  assert.throws(() => parseDocuments('+++\ntags: { a: 1 }\n+++\nbody'), /`tags` must be a list/);
});

test('an untagged document gets no tags key', () => {
  const [doc] = parseDocuments('just some markdown');
  assert.deepEqual(doc.data, {});
});

test('tags are available in the template context', async () => {
  const out = await renderText('about #fred and #wilma\n\ntags: {{ res.data.tags.join(", ") }}');
  assert.match(out, /tags: fred, wilma/);
});

test('$.withTag finds tagged documents (case-insensitive)', async () => {
  const src = [
    '% for (const d of $.withTag("Fred")) {',
    '- {{ d.name }}',
    '% }',
    '---',
    '+++',
    'name: one',
    '+++',
    'a note about #fred',
    '---',
    '+++',
    'name: two',
    '+++',
    'a note about #wilma',
    '---',
    '+++',
    'name: three',
    '+++',
    'more on #Fred and #wilma',
  ].join('\n');
  assert.equal((await renderText(src)).trim(), '- one\n- three');
});

test('hashtags example: entry composes the docs tagged #fred', async () => {
  const out = await renderText(example('hashtags.mdy'));
  assert.match(out, /= Notes about fred/);
  assert.match(out, /!!Kickoff!! — tags: fred, budget-2026/);
  assert.match(out, /!!Pairing notes!! — tags: wilma, fred/);
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
  assert.match(html, /<pre><code class="language-yaml[^"]*">/);
  // escape sequence:
  assert.match(html, /\{\{ this stays as-is \}\}/);
});

test('invoice example: nested front matter and computed totals', async () => {
  const out = await renderText(example('invoice.mdy'));
  assert.match(out, /Invoice #42/);
  assert.match(out, /Grace Hopper/);
  assert.match(out, /Order total: \$54\.47/); // 3*9.99 + 24.50
});

test('shared-scope example computes across tags', async () => {
  const out = await renderText(example('shared-scope.mdy'));
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
  const { render: r } = createProcessor({ rehypePlugins: [highlight], });
  const html = await r('```yaml\nk: v\n```');
  assert.match(html, /<mark>/);
  assert.match(html, /hljs-attr/);
});

test('createProcessor accepts a custom compiler, and passes its value through uncoerced', async () => {
  // The extension point @mdy-docs/react is built on: everything up to the
  // compiler is output-agnostic, so retargeting mdy at a renderer that is not
  // a string means replacing the last step and nothing else. A compiler
  // returning a non-string must survive intact — a String() on the way out
  // would turn a React element into "[object Object]".
  const countingCompiler = function () {
    this.compiler = (tree) => {
      let n = 0;
      const visit = (node) => {
        if (node.type === 'element') n++;
        for (const child of node.children ?? []) visit(child);
      };
      visit(tree);
      return { elements: n };
    };
  };

  const { render: r, renderMarkdown, renderTree } = createProcessor({ compiler: countingCompiler });

  // Both entry points — the string path and the tree path (a document that
  // ended in tree form) — have to reach the same compiler.
  assert.deepEqual(await renderMarkdown('# a\n\n- b\n- c\n'), { elements: 4 });
  assert.deepEqual(await r('+++\ntitle: T\n+++\n= {{ res.data.title }}'), { elements: 1 });
  assert.deepEqual(await renderTree({ type: 'root', children: [] }), { elements: 0 });
});

test('extraContext arrives on arg; the document\'s own data stays on self, never merged', async () => {
  // Both carry `who` with different values: the bindings stay separate, and
  // "extraContext wins" is the template's own explicit `req.x ?? res.data.x`.
  const src = '+++\nwho: world\n+++\n{{ res.data.who }}/{{ req.who }}/{{ req.who ?? res.data.who }}/{{ req.where }}';
  const out = await renderText(src, { where: 'mdy', who: 'everyone' });
  assert.equal(out.trim(), 'world/everyone/everyone/mdy');
});

test('an entry document\'s own front matter is self, not arg', async () => {
  // The contradiction the split resolves: with nothing passed in, arg is {}
  // — the document's front matter never leaks onto it.
  const out = await renderText('+++\ntitle: Hi\n+++\narg={{ req.title }} self={{ res.data.title }}');
  assert.equal(out.trim(), 'arg=undefined self=Hi');
});

test('templates run sandboxed in the VM: no process, no Function', async () => {
  const out = await renderText('{{ typeof process }}/{{ typeof Function }}');
  assert.equal(out.trim(), 'undefined/undefined');
});

// --- multi-document sets --------------------------------------------------

test('$.find selects documents by data attributes, in document order', async () => {
  const src = [
    '% for (const p of $.find({ kind: "person" })) {',
    '- {{ p.name }}',
    '% }',
    '---',
    '+++',
    'kind: person',
    'name: Alice',
    '+++',
    '---',
    '+++',
    'kind: place',
    'name: Uluru',
    '+++',
    '---',
    '+++',
    'kind: person',
    'name: Bob',
    '+++',
  ].join('\n');
  assert.equal((await renderText(src)).trim(), '- Alice\n- Bob');
});

test('$.find supports MongoDB query operators', async () => {
  const src = [
    '% for (const p of $.find({ age: { $gt: 35 } })) {\n[{{ p.name }}]\n% }',
    '---', '+++', 'name: Alice', 'age: 30', '+++',
    '---', '+++', 'name: Bob', 'age: 41', '+++',
  ].join('\n');
  assert.equal((await renderText(src)).trim(), '[Bob]');
});

test('$.findOne returns the first match or null', async () => {
  const src = [
    'first={{ $.findOne({ kind: "x" }).name }} none={{ $.findOne({ kind: "z" }) === null }}',
    '---', '+++', 'kind: x', 'name: a', '+++',
    '---', '+++', 'kind: x', 'name: b', '+++',
  ].join('\n');
  assert.equal((await renderText(src)).trim(), 'first=a none=true');
});

test('$.render selects its template document by query', async () => {
  const src = [
    '% for (const m of $.find({ role: "member" })) {',
    '{{ $.render({ template: "card" }, m) }}',
    '% }',
    '---',
    '+++',
    'template: card',
    '+++',
    '- {{ req.name }} is {{ req.age }}',
    '---',
    '+++',
    'role: member',
    'name: Alice',
    'age: 30',
    '+++',
    '---',
    '+++',
    'role: member',
    'name: Bob',
    'age: 41',
    '+++',
  ].join('\n');
  // A nested render is a tree, so what comes back is HTML: two cards, each
  // its own list, composed into the page in query order.
  const html = await renderDocumentSet(src);
  assert.match(html, /<li>Alice is 30<\/li>[\s\S]*<li>Bob is 41<\/li>/);
});

test('$.render renders a $.find/$.findOne result directly — a document reference, not a query', async () => {
  const src = [
    '% const card = $.findOne({ template: "card" })',
    '% for (const m of $.find({ role: "member" })) {',
    '{{ $.render(card, m) }}',
    '% }',
    '---',
    '+++',
    'template: card',
    '+++',
    '- {{ req.name }}',
    '---',
    '+++',
    'role: member',
    'name: Alice',
    '+++',
  ].join('\n');
  assert.match(await renderDocumentSet(src), /<li>Alice<\/li>/);
});

test('$.render of a reference resolves by identity: no query fires for the render itself', async () => {
  const seen = [];
  const set = await openDocumentSet(
    '% const card = $.findOne({ t: "card" })\n{{ $.render(card) }}\n---\n+++\nt: card\n+++\nhi',
    { onQuery: (info) => seen.push(info.query) }
  );
  assert.equal((await set.render(0)).trim(), '<p>hi</p>');
  assert.deepEqual(seen, [{ t: 'card' }]); // just the findOne — the render added none
});

test('$.render(null) — a missed $.findOne — is a clear template error', async () => {
  await assert.rejects(
    renderText('{{ $.render($.findOne({ t: "nope" })) }}\n---\n+++\nt: card\n+++\nhi'),
    /target is null\/undefined/
  );
});

test('$.render of a reference from another set (unknown _id) is a clear error', async () => {
  await assert.rejects(
    renderText('{{ $.render({ _id: "deadbeef" }) }}\n---\n+++\nt: card\n+++\nhi'),
    /not a document of this set/
  );
});

test('$.render by index still works (positional)', async () => {
  const src = [
    '% for (const m of $.find({}).slice(2)) {',
    '{{ $.render(1, m) }}',
    '% }',
    '---',
    '- {{ req.name }} is {{ req.age }}',
    '---',
    '+++',
    'name: Alice',
    'age: 30',
    '+++',
    '---',
    '+++',
    'name: Bob',
    'age: 41',
    '+++',
  ].join('\n');
  assert.match(await renderDocumentSet(src), /<li>Alice is 30<\/li>[\s\S]*<li>Bob is 41<\/li>/);
});

test('$.render needs no indent: the tree lands inside whatever element is open', async () => {
  // The argument that used to exist answered a question the tree already
  // knows. A `<section` line opens an element and the indentation closes it,
  // so at the point the token sits the parser knows exactly which element is
  // open — the returned subtree becomes its child, at no column at all.
  const src = ['< section class="wrap"', '  {{ $.render(1) }}', '---', '= Inside', '', 'and prose'].join('\n');
  const html = await renderDocumentSet(src);
  assert.match(html, /<section class="wrap">[\s\S]*<h1 id="inside">Inside<\/h1>[\s\S]*<p>and prose<\/p>[\s\S]*<\/section>/);
});

test('a paragraph holding nothing but a render is replaced by that document, not wrapped in one', async () => {
  const html = await renderDocumentSet('before\n\n{{ $.render(1) }}\n\nafter\n---\n= A heading\n');
  assert.match(html, /<p>before<\/p><h1 id="a-heading">A heading<\/h1><p>after<\/p>/);
});

test('a render in the middle of a sentence gives up its block wrappers', async () => {
  // A paragraph inside a paragraph is not a thing hast can hold, so the
  // spliced document lends its content rather than its wrapper.
  const html = await renderDocumentSet('says {{ $.render(1) }} loudly\n---\n!!boo!!\n');
  assert.equal(html, '<p>says <strong>boo</strong> loudly</p>');
});

test('an element left open in one document cannot reach another', async () => {
  // The containment property the tree model exists for: three documents, one
  // of which opens a <div> and indents nothing under it.
  const src = [
    '{{ $.render(1) }}', '', 'ENTRY PROSE', '', '{{ $.render(2) }}',
    '---', '< div class="oops"', '  inside',
    '---', '= Sibling heading',
  ].join('\n');
  const html = await renderDocumentSet(src);
  assert.match(html, /<div class="oops">[\s\S]*<p>inside<\/p>[\s\S]*<\/div>/);
  // …and both of the others are outside it, where they were written.
  assert.match(html, /<\/div><p>ENTRY PROSE<\/p><h1 id="sibling-heading">Sibling heading<\/h1>$/);
});

test('$.render on an unmatched query rejects', async () => {
  await assert.rejects(
    renderText('{{ $.render({ nope: 1 }) }}'),
    /no document matches/
  );
});

test('$.data and $.count expose the document set', async () => {
  const src = 'count={{ $.count }} second={{ $.data(1).x }}\n---\n+++\nx: 42\n+++\nsecond doc';
  assert.equal((await renderText(src)).trim(), 'count=2 second=42');
});

test('$.render on a missing index rejects', async () => {
  await assert.rejects(renderText('{{ $.render(9) }}'), /no document at index 9/);
});

test('cyclic $.render is caught by the depth guard', async () => {
  // two docs that each render the other
  const src = '{{ $.render(1) }}\n---\n{{ $.render(0) }}';
  await assert.rejects(renderText(src), /render depth exceeded/);
});

test('entry index selects which document renders', async () => {
  const src = 'doc zero\n---\n+++\nx: 7\n+++\nsecond doc x={{ res.data.x }}';
  assert.equal((await renderText(src, {}, 0)).trim(), 'doc zero');
  assert.equal((await renderText(src, {}, 1)).trim(), 'second doc x=7');
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
  const docs = parseDocuments(['+++\na: 1\n+++\ntemplate', '+++\nb: 2\n+++\n---\n+++\nc: 3\n+++\n']);
  assert.deepEqual(docs.map((d) => d.data), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('$ addresses documents across sources', async () => {
  const template = 'count={{ $.count }}\n% for (const d of $.find({ x: { $gte: 1 } })) {\n x={{ d.x }}\n% }';
  const data = '+++\nx: 1\n+++\n---\n+++\nx: 2\n+++\n';
  assert.equal((await renderText([template, data])).trim(), 'count=3\n x=1\n x=2');
});

test('renderEach applies the entry template to each other document', async () => {
  const out = await renderEach(['Hi {{ req.name }}!', '+++\nname: Ada\n+++\n---\n+++\nname: Bob\n+++\n']);
  assert.deepEqual(out.map((s) => s.trim()), ['<p>Hi Ada!</p>', '<p>Hi Bob!</p>']);
});

test('renderEach: the record is req, template front matter is res.data; defaults are explicit req.x ?? res.data.x', async () => {
  // The record never merges with the template's own data: res.data.name stays
  // "nobody" even while req.name is "Ada". extraContext merges into the
  // record (and wins) before arriving as req.
  const template =
    '+++\ngreeting: Hello\nname: nobody\n+++\n{{ req.greeting ?? res.data.greeting }} {{ req.name ?? res.data.name }}/{{ res.data.name }}';
  const data = '+++\nname: Ada\n+++\n';
  assert.deepEqual((await renderEach([template, data])).map((s) => s.trim()), ['<p>Hello Ada/nobody</p>']);
  assert.deepEqual(
    (await renderEach([template, data], { greeting: 'Yo' })).map((s) => s.trim()),
    ['<p>Yo Ada/nobody</p>']
  );
});

test('renderEach with no sibling documents renders the entry once with req = {}', async () => {
  // The same explicit fallback keeps a template file working standalone: its
  // own front matter is on res.data, and there is no record to be req.
  const out = await renderEach('+++\nwho: world\n+++\nhi {{ req.who ?? res.data.who }}');
  assert.deepEqual(out.map((s) => s.trim()), ['<p>hi world</p>']);
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
    { text: '+++\na: 1\n+++\n---\n+++\na: 2\n+++\n', meta: { path: 'posts/x.mdy', section: 'posts' } },
    { text: '+++\na: 3\n+++\n', meta: { path: 'about.mdy' } },
    '+++\na: 4\n+++\n',
  ]);
  assert.deepEqual(docs.map((d) => d.data), [
    { a: 1, path: 'posts/x.mdy', section: 'posts' },
    { a: 2, path: 'posts/x.mdy', section: 'posts' },
    { a: 3, path: 'about.mdy' },
    { a: 4 },
  ]);
});

test('meta wins over front matter (identity is not overridable)', () => {
  const docs = parseDocuments({ text: '+++\npath: forged\n+++\n', meta: { path: 'real.mdy' } });
  assert.equal(docs[0].data.path, 'real.mdy');
});

test('a bare { text } source parses like a plain string', () => {
  assert.deepEqual(
    parseDocuments({ text: '+++\na: 1\n+++\nbody' }),
    parseDocuments('+++\na: 1\n+++\nbody')
  );
});

test('invalid sources throw', () => {
  assert.throws(() => parseDocuments({ meta: { a: 1 } }), /source must be a string or \{ text, meta \}/);
  assert.throws(() => parseDocuments({ text: 'x', meta: ['no'] }), /`meta` must be a mapping/);
});

test('meta fields are queryable and visible in templates', async () => {
  const out = await renderText([
    { text: '% for (const p of $.find({ section: "posts" })) {\n{{ p.title }} in {{ p.path }};\n% }' },
    { text: '+++\ntitle: One\n+++\n---\n+++\ntitle: Two\n+++\n', meta: { section: 'posts', path: 'p.mdy' } },
  ]);
  assert.equal(out.trim(), 'One in p.mdy;\nTwo in p.mdy;');
});

// --- openDocumentSet ------------------------------------------------------

test('openDocumentSet: one set, many host-side queries and renders', async () => {
  const set = await openDocumentSet([
    { text: '+++\nlayout: post\n+++\n# {{ req.title }}', meta: { kind: 'layout' } },
    { text: '+++\ntitle: A\n+++\n---\n+++\ntitle: B\n+++\n', meta: { kind: 'page' } },
  ]);

  assert.equal(set.docs.length, 3);

  const pages = await set.find({ kind: 'page' });
  assert.deepEqual(pages.map((p) => p.title), ['A', 'B']);

  const out = [];
  for (const p of pages) {
    out.push((await set.renderText({ layout: 'post' }, p)).trim());
  }
  assert.deepEqual(out, ['# A', '# B']);
});

test('openDocumentSet: find with no query returns all documents in order', async () => {
  const set = await openDocumentSet('+++\na: 1\n+++\n---\n+++\na: 2\n+++\n');
  assert.deepEqual((await set.find()).map((d) => d.a), [1, 2]);
});

test('openDocumentSet: findOne returns first match or null', async () => {
  const set = await openDocumentSet('+++\nx: 1\n+++\n---\n+++\nx: 2\n+++\n');
  assert.equal((await set.findOne({ x: { $gt: 1 } })).x, 2);
  assert.equal(await set.findOne({ x: 99 }), null);
});

test('openDocumentSet: render by index — ctx is arg, document data is self', async () => {
  const set = await openDocumentSet('+++\nname: default\n+++\nHi {{ req.name ?? res.data.name }}');
  assert.equal((await set.renderText(0)).trim(), 'Hi default');
  assert.equal((await set.renderText(0, { name: 'Ada' })).trim(), 'Hi Ada');
});

test('openDocumentSet: render on an unmatched query rejects', async () => {
  const set = await openDocumentSet('just a doc');
  await assert.rejects(set.renderText({ nope: 1 }), /no document matches/);
});

test('openDocumentSet: templates can still $.find and $.render inside the VM', async () => {
  const set = await openDocumentSet([
    '% for (const d of $.find({ n: { $gte: 1 } })) {\n{{ $.render({ card: true }, d) }}\n% }',
    '+++\ncard: true\n+++\n[{{ req.n }}]',
    '+++\nn: 1\n+++\n---\n+++\nn: 2\n+++\n',
  ]);
  assert.equal((await set.render(0)).replace(/\s+/g, ''), '<p>[1]</p><p>[2]</p>');
});

// --- $.parse / $.markdown / $.node / $.html --------------------------------

test('$.parse gives the document a hast tree it can walk', async () => {
  const out = await renderText(
    '% const tree = $.parse("= Title\\n\\nSome text")\n' +
      '{{ tree.children[0].tagName }}/{{ tree.children[0].children[0].value }}/{{ tree.children[1].tagName }}'
  );
  assert.equal(out.trim(), 'h1/Title/p');
});

test('$.parse speaks the same grammar the document itself came through', async () => {
  const out = await renderText(
    '% const tree = $.parse("| a | b |\\n| - | - |\\n| 1 | 2 |")\n{{ tree.children[0].tagName }}'
  );
  assert.equal(out.trim(), 'table');
});

test('$.markdown is the OTHER front end: markdown text in, a tree to splice out', async () => {
  const html = await renderDocumentSet('% const note = $.markdown("# Hi\\n\\n- one\\n- two")\n{{ note }}');
  assert.match(html, /<h1 id="hi">Hi<\/h1>/);
  assert.match(html, /<li>one<\/li>/);
});

test('$.node splices a tree the document built itself', async () => {
  const html = await renderDocumentSet(
    '% const badge = h("span.badge", "new")\ntagged {{ $.node(badge) }} today'
  );
  assert.equal(html, '<p>tagged <span class="badge">new</span> today</p>');
});

test('$.node on a non-node is a document error, not an engine crash', async () => {
  await assert.rejects(renderText('{{ $.node("nope") }}'), /expects a hast node/);
});

test('$.html writes a tree — or a rendered document — out as HTML text', async () => {
  const out = await renderText('{{ $.html($.parse("= Hi")) }}|{{ $.html($.render(1)) }}\n---\n!!bold!!\n');
  assert.equal(out.trim(), '<h1 id="hi">Hi</h1>|<p><strong>bold</strong></p>');
});

// --- $.table ----------------------------------------------------------------

test('$.table turns a 2-D array into a table (first row is the header)', async () => {
  const html = await renderDocumentSet('{{ $.table([["name", "age"], ["ann", 33], ["ben", 4]]) }}');
  assert.match(html, /<thead><tr><th[^>]*>name<\/th><th[^>]*>age<\/th><\/tr><\/thead>/);
  assert.match(html, /<td[^>]*>ann<\/td><td[^>]*>33<\/td>/);
  assert.match(html, /<td[^>]*>ben<\/td><td[^>]*>4<\/td>/);
});

test('$.table aligns columns; full words and initials both work', async () => {
  const html = await renderDocumentSet('{{ $.table([["a", "b", "c"], [1, 2, 3]], ["l", "center", "R"]) }}');
  assert.match(html, /<th style="text-align: left">a<\/th>/);
  assert.match(html, /<th style="text-align: center">b<\/th>/);
  assert.match(html, /<th style="text-align: right">c<\/th>/);
});

test('$.table cells keep inline markup; null reads as empty', async () => {
  const html = await renderDocumentSet('{{ $.table([["h"], ["!!bold!!"], ["a|b"], [null]]) }}');
  assert.match(html, /<td[^>]*><strong>bold<\/strong><\/td>/);
  assert.match(html, /<td[^>]*>a\|b<\/td>/); // a pipe in a CELL is a character, not a column
  assert.match(html, /<td[^>]*><\/td>/);
});

test('$.table on a non-array is a document error, not an engine crash', async () => {
  await assert.rejects(renderText('{{ $.table("nope") }}'), /expects an array of row arrays/);
});

test('a document can build a list from another document\'s rendered headings', async () => {
  const src = [
    [
      '% for (const e of $.toc($.render(1))) {',
      '- {{ e.text }} (h{{ e.depth }}) → #{{ e.slug }}',
      '% }',
    ].join('\n'),
    '= Alpha\n\ntext\n\n== Beta\n\nmore text\n\n== {{ "Gam" + "ma" }}',
  ];
  const out = await renderText(src);
  assert.deepEqual(out.trim().split('\n'), [
    '- Alpha (h1) → #alpha',
    '- Beta (h2) → #beta',
    '- Gamma (h2) → #gamma',
  ]);
});

// --- graceful missing data --------------------------------------------------

test('a missing data key reads as undefined instead of erroring', async () => {
  // Both bindings are plain objects, so a missing key is ordinary property
  // access reading undefined — ?? and ternary fallbacks work, on res.data (a
  // document's own optional data) and req (a record a shared layout
  // references but the caller may not carry) alike.
  assert.equal(await renderText('+++\nx: 1\n+++\nv={{ res.data.missing }}'), 'v=undefined');
  assert.equal(await renderText('+++\nx: 1\n+++\n{{ res.data.age ?? "n/a" }}'), 'n/a');
  assert.equal(await renderText('+++\nx: 1\n+++\n{{ res.data.age ? res.data.age : "none" }}'), 'none');
  assert.equal(await renderText('+++\nx: 1\n+++\n{{ (res.data.skills ?? []).join(", ") }}'), '');
  // and on req, which is {} here because nothing was passed in
  assert.equal(await renderText('+++\nx: 1\n+++\nv={{ req.missing }}'), 'v=undefined');
  // several distinct missing keys in one document
  assert.equal(await renderText('{{ req.a ?? 1 }}/{{ res.data.b ?? 2 }}/{{ req.c ?? res.data.c ?? 3 }}'), '1/2/3');
});

test('a shared layout renders records that lack referenced properties', async () => {
  const src = [
    '+++',
    'title: T',
    '+++',
    '% for (const m of $.find({ role: "member" })) {',
    '{{ $.render({ template: "card" }, m) }}',
    '% }',
    '---',
    '+++',
    'template: card',
    '+++',
    '=== {{ req.name ?? "(unnamed)" }} — {{ req.age ?? "?" }} — {{ (req.skills ?? []).join("/") }}',
    '---',
    '+++',
    'role: member',
    'name: Alice',
    'age: 30',
    'skills: [js]',
    '+++',
    '---',
    '+++',
    'role: member',
    'name: Bob',
    '+++',
  ].join('\n');
  const html = await renderDocumentSet(src);
  assert.match(html, /<h3 id="[^"]*">Alice — 30 — js<\/h3>/);
  assert.match(html, /<h3 id="[^"]*">Bob — \? —<\/h3>/);
});

test('an undeclared bare identifier is a genuine document error', async () => {
  // only res.data.*/req.* property access is graceful — a bare identifier the
  // document never declared is a real ReferenceError
  await assert.rejects(renderText('{{ nope }}'), /document 0 failed.*nope is not defined/);
  // and property access on a missing key's undefined is a real TypeError
  await assert.rejects(renderText('{{ req.missing.prop }}'), /document 0 failed/);
});

test('$.html on a non-node is a document error, not an engine crash', async () => {
  await assert.rejects(renderText('{{ $.html(null) }}'), /expects a hast node/);
});

// --- transform / $.toc ------------------------------------------------------

test('transform changes the final tree in place (unified convention: return nothing)', async () => {
  const src = [
    '%% transform((tree) => {',
    '  visit(tree, "h1", (node) => {',
    '    node.children = [{ type: "text", value: "REPLACED" }]',
    '  })',
    '})',
    '= Original',
    '',
    'Body text.',
  ].join('\n');
  const html = await renderDocumentSet(src);
  assert.match(html, /<h1[^>]*>REPLACED<\/h1>/);
  assert.match(html, /Body text\./);
});

test('a transform sees the finished tree on res.doc as well as in its argument', async () => {
  const src = [
    '%% transform((tree) => {',
    '  tree.children.push(h("p", "there were " + res.doc.children.length + " blocks"))',
    '})',
    '= One',
    '',
    'two',
  ].join('\n');
  assert.match(await renderDocumentSet(src), /<p>there were 2 blocks<\/p>/);
});

test('transform may return a whole new tree', async () => {
  const src = '%% transform(() => ({ type: "root", children: [h("p", "swapped")] }))\nanything';
  assert.equal((await renderDocumentSet(src)).trim(), '<p>swapped</p>');
});

test('transform returning a non-node is a document error', async () => {
  await assert.rejects(renderText('% transform(() => 42)\nx'), /must return a hast node/);
});

test('a transformed document embeds into another as the tree it ended as', async () => {
  const set = await openDocumentSet([
    'before\n\n{{ $.render(1) }}\n\nafter',
    '%% transform((tree) => {\n  tree.children.push(h("p", "appended"))\n})\ninner',
  ]);
  const html = await set.render(0);
  assert.match(html, /<p>before<\/p><p>inner<\/p><p>appended<\/p><p>after<\/p>/);
});

test('{{ $.toc() }} resolves to a link list of the document\'s own headings, including generated ones', async () => {
  const src = [
    '{{ $.toc() }}',
    '',
    '= Intro',
    '',
    'text',
    '',
    '== Details',
    '',
    '== {{ "Gener" + "ated" }}',
  ].join('\n');
  const html = await renderDocumentSet(src);
  assert.match(html, /<a href="#intro">Intro<\/a>/);
  assert.match(html, /<a href="#details">Details<\/a>/);
  assert.match(html, /<a href="#generated">Generated<\/a>/);
  // nested: the h2 entries sit in a sub-list under the h1 entry
  assert.match(html, /<a href="#intro">Intro<\/a><ul><li><a href="#details">/);
});

test('the contents list is built after the transforms, on the tree they left', async () => {
  const src = [
    '%% transform((tree) => {',
    '  tree.children.push(h("h2#late", "Late heading"))',
    '})',
    '{{ $.toc() }}',
    '',
    '= Intro',
  ].join('\n');
  assert.match(await renderDocumentSet(src), /<a href="#late">Late heading<\/a>/);
});

test('$.toc() anchors land: the ids are the ones the parser gave the headings', async () => {
  const html = await renderDocumentSet('{{ $.toc() }}\n\n= One Two\n\n== One Two');
  assert.match(html, /<h1 id="one-two">One Two<\/h1>/);
  assert.match(html, /<h2 id="one-two-1">One Two<\/h2>/); // duplicate deduped
  assert.match(html, /<a href="#one-two">One Two<\/a>/);
  assert.match(html, /<a href="#one-two-1">One Two<\/a>/);
});

test('$.toc(target) returns plain entries for the document to render itself', async () => {
  const src = [
    '% const entries = $.toc($.render(1))\n% for (const e of entries) {\n{{ e.depth }}:{{ e.text }}:{{ e.slug }};\n% }',
    '= Alpha\n\n== Beta Gamma',
  ];
  const out = await renderText(src);
  assert.equal(out.trim(), '1:Alpha:alpha;\n2:Beta Gamma:beta-gamma;');
});

test('$.toc() with no headings just removes the placeholder', async () => {
  const html = await renderDocumentSet('{{ $.toc() }}\n\njust a paragraph');
  assert.equal(html.trim(), '<p>just a paragraph</p>');
});

test('> [!WARNING] blockquotes render as GitHub alert boxes — in the MARKDOWN front end', async () => {
  // Alerts are remark-github-blockquote-alert's, so they belong to `.md`.
  // MDY has its own grammar and does not borrow this one.
  const { renderMarkdown } = createProcessor();
  const html = await renderMarkdown('> [!WARNING]\n> Careful **here**.');
  assert.match(html, /class="markdown-alert markdown-alert-warning"/);
  assert.match(html, /markdown-alert-title/);
  assert.match(html, /Careful <strong>here<\/strong>/);
});

// --- openDocumentSet: onQuery -----------------------------------------------

test('onQuery: fires for a template-level $.find, tagged with the rendering document\'s index', async () => {
  const seen = [];
  const set = await openDocumentSet(
    ['% $.find({ n: { $gte: 1 } })', '+++\nn: 1\n+++\n'],
    { onQuery: (info) => seen.push(info) }
  );
  await set.renderText(0);
  assert.deepEqual(seen, [{ query: { n: { $gte: 1 } }, docIndex: 0 }]);
});

test('onQuery: fires for $.findOne and $.withTag too, same shape', async () => {
  const seen = [];
  const set = await openDocumentSet(
    ['% $.findOne({ x: 1 })\n\n% $.withTag("go")', '+++\nx: 1\n+++\n'],
    { onQuery: (info) => seen.push(info) }
  );
  await set.renderText(0);
  assert.deepEqual(seen, [
    { query: { x: 1 }, docIndex: 0 },
    { query: { tags: 'go' }, docIndex: 0 },
  ]);
});

test('onQuery: a template-level $.render-by-query counts as a query too', async () => {
  const seen = [];
  const set = await openDocumentSet(
    ['{{ $.render({ role: "card" }, {}) }}', '+++\nrole: card\n+++\nhi'],
    { onQuery: (info) => seen.push(info) }
  );
  await set.renderText(0);
  assert.deepEqual(seen, [{ query: { role: 'card' }, docIndex: 0 }]);
});

test('onQuery: docIndex tracks whichever document is currently rendering, including nested $.render', async () => {
  const seen = [];
  const set = await openDocumentSet(
    [
      '{{ $.render({ role: "inner" }, {}) }}', // doc 0
      '+++\nrole: inner\n+++\n% $.find({ tag: "x" })\ninner', // doc 1 — its own $.find runs while doc 1 is rendering
    ],
    { onQuery: (info) => seen.push(info) }
  );
  await set.renderText(0);
  assert.deepEqual(seen, [
    { query: { role: 'inner' }, docIndex: 0 }, // doc 0's own $.render call
    { query: { tag: 'x' }, docIndex: 1 }, // doc 1's $.find, while doc 1 is the one rendering
  ]);
});

test('onQuery: fires for host-side find/findOne/render too, tagged docIndex: null', async () => {
  const seen = [];
  const set = await openDocumentSet(
    ['+++\ntitle: A\n+++\nhi', '+++\nrole: card\n+++\ncard'],
    { onQuery: (info) => seen.push(info) }
  );
  await set.find({ title: 'A' });
  await set.findOne({ title: 'A' });
  await set.renderText({ role: 'card' });
  assert.deepEqual(seen, [
    { query: { title: 'A' }, docIndex: null },
    { query: { title: 'A' }, docIndex: null },
    { query: { role: 'card' }, docIndex: null },
  ]);
});

test('onQuery: render by plain index never counts as a query (nothing to track)', async () => {
  const seen = [];
  const set = await openDocumentSet('hi', { onQuery: (info) => seen.push(info) });
  await set.renderText(0);
  assert.deepEqual(seen, []);
});

test('onQuery: without the option, nothing breaks (default no-op)', async () => {
  const set = await openDocumentSet('% $.find({})\nhi');
  assert.equal((await set.renderText(0)).trim(), 'hi');
});

// --- openDocumentSet: options.natives ---------------------------------------

test('natives: an embedder-supplied function is callable from a template as $.<name>(...)', async () => {
  const set = await openDocumentSet('{{ $.double(21) }}', {
    natives: { double: (n) => n * 2 },
  });
  assert.equal((await set.renderText(0)).trim(), '42');
});

test('natives: async natives suspend the VM and resume with the resolved value', async () => {
  const set = await openDocumentSet('{{ $.later() }}', {
    natives: { later: async () => new Promise((r) => setTimeout(() => r('done'), 5)) },
  });
  assert.equal((await set.renderText(0)).trim(), 'done');
});

test('natives: multiple extra natives, and args/return cross the VM boundary JSON-round-tripped', async () => {
  const set = await openDocumentSet('{{ JSON.stringify($.merge({ a: 1 }, { b: 2 })) }} {{ $.shout("hi") }}', {
    natives: {
      merge: (a, b) => ({ ...a, ...b }),
      shout: (s) => s.toUpperCase(),
    },
  });
  assert.equal((await set.renderText(0)).trim(), '{"a":1,"b":2} HI');
});

test('natives: coexist with find/findOne/render — no interference either direction', async () => {
  const set = await openDocumentSet(['{{ $.tag($.findOne({ n: 1 }).n) }}', '+++\nn: 1\n+++\n'], {
    natives: { tag: (n) => `#${n}` },
  });
  assert.equal((await set.renderText(0)).trim(), '#1');
});

test('data fences are found wherever CommonMark allows one to open', async () => {
  // extractDataBlocks skips its CommonMark parse when the body cannot hold a
  // data fence. The test that decides is deliberately looser than 'a line
  // starting with a fence' — a fence can open inside a blockquote or a nested
  // list, and missing one there would silently drop a document's data.
  const cases = [
    ['plain', '+++\ntitle: t\n+++\n```data\nn: 1\n```\n'],
    ['blockquote', '+++\ntitle: t\n+++\n> ```data\n> n: 1\n> ```\n'],
    ['nested list', '+++\ntitle: t\n+++\n- a\n  - b\n    ```data\n    n: 1\n    ```\n'],
    ['tildes', '+++\ntitle: t\n+++\n~~~data\nn: 1\n~~~\n'],
    ['four backticks', '+++\ntitle: t\n+++\n````data\nn: 1\n````\n'],
    ['spaced info string', '+++\ntitle: t\n+++\n```   data\nn: 1\n```\n'],
  ];
  for (const [label, src] of cases) {
    const set = await openDocumentSet(src);
    assert.equal(set.docs[0].data.n, 1, `data fence not picked up: ${label}`);
  }
});

test('a fence that only looks like data is left as display content', async () => {
  const a = await openDocumentSet('+++\ntitle: t\n+++\n```database\nnot: data\n```\n');
  assert.equal(a.docs[0].data.not, undefined);
  const b = await openDocumentSet('+++\ntitle: t\n+++\n```data extra\nnot: data\n```\n');
  assert.equal(b.docs[0].data.not, undefined);
});

test('natives: an invalid native name rejects with a clear error rather than a broken program', async () => {
  // At set construction, not at the first render: the name is a fact about the
  // embedder's natives, and a render served from the render memo never reaches
  // the code that builds a program at all.
  await assert.rejects(
    openDocumentSet('hi', { natives: { 'not valid': () => 1 } }),
    /invalid native name/
  );
});

test('natives: without the option, nothing breaks (default: none extra)', async () => {
  const set = await openDocumentSet('{{ $.count }}');
  assert.equal((await set.renderText(0)).trim(), '1');
});

// --- openDocumentSet: options.onEmit -----------------------------------

test('onEmit: fires with the path and content a template passed to $.emit', async () => {
  const seen = [];
  const set = await openDocumentSet('% $.emit("out.html", "<p>hi</p>")\nrendered', {
    onEmit: (info) => seen.push(info),
  });
  const out = await set.renderText(0);
  assert.equal(out.trim(), 'rendered'); // emit is a side effect, not the render's own output
  assert.deepEqual(seen, [{ path: 'out.html', content: '<p>hi</p>', docIndex: 0 }]);
});

test('onEmit: multiple emits from one document, in call order', async () => {
  const seen = [];
  const set = await openDocumentSet(
    '% $.emit("a.html", "A")\n\n% $.emit("b.html", "B")',
    { onEmit: (info) => seen.push(info) }
  );
  await set.renderText(0);
  assert.deepEqual(seen.map((e) => e.path), ['a.html', 'b.html']);
});

test('onEmit: docIndex tracks whichever document is currently rendering, including nested $.render', async () => {
  const seen = [];
  const set = await openDocumentSet(
    ['% $.emit("outer.html", "outer")\n{{ $.render({ role: "inner" }, {}) }}', '+++\nrole: inner\n+++\n% $.emit("inner.html", "inner")'],
    { onEmit: (info) => seen.push(info) }
  );
  await set.renderText(0);
  assert.deepEqual(seen, [
    { path: 'outer.html', content: 'outer', docIndex: 0 },
    { path: 'inner.html', content: 'inner', docIndex: 1 },
  ]);
});

test('onEmit: content JSON-round-trips like any native call, not limited to strings', async () => {
  const seen = [];
  const set = await openDocumentSet('% $.emit("data.json", { records: [1, 2, 3] })', {
    onEmit: (info) => seen.push(info),
  });
  await set.renderText(0);
  assert.deepEqual(seen, [{ path: 'data.json', content: { records: [1, 2, 3] }, docIndex: 0 }]);
});

test('onEmit: coexists with onQuery and natives — no interference in any direction', async () => {
  const queries = [];
  const emits = [];
  const set = await openDocumentSet(
    ['% $.find({})\n\n% $.emit($.shout("out"), "x")', 'y'],
    {
      onQuery: (info) => queries.push(info),
      onEmit: (info) => emits.push(info),
      natives: { shout: (s) => `${s}.html` },
    }
  );
  await set.renderText(0);
  assert.deepEqual(queries, [{ query: {}, docIndex: 0 }]);
  assert.deepEqual(emits, [{ path: 'out.html', content: 'x', docIndex: 0 }]);
});

test('onEmit: without the option, $.emit is a harmless no-op', async () => {
  const set = await openDocumentSet('% $.emit("out.html", "x")\nok');
  assert.equal((await set.renderText(0)).trim(), 'ok');
});
