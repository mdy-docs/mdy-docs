import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import preview from '../src/preview.cjs';
import * as engine from '../../../../src/mdy.js';

const {
  resolveEnginePackage,
  engineEntry,
  renderPreview,
  rewriteResourceUrls,
  escapeHtml,
  errorHtml,
  emitNoteHtml,
  previewShellHtml,
} = preview;

const here = dirname(fileURLToPath(import.meta.url));

/*
 * The preview's contract is "what `mdy <file> --html` prints": the render
 * tests below run preview.cjs's pipeline against the REAL engine (the same
 * import the structure tests use as their oracle) and, for the multi-
 * document case, against a real example file. The rest pins the pure
 * machinery: engine resolution over a fake filesystem, resource-URL
 * rewriting, and the webview shell's CSP/nonce wiring.
 */

// --- renderPreview: the CLI's file-input pipeline

test('renders the entry document: front matter feeds {{ }} tags, markdown becomes HTML', async () => {
  const { html, emittedPaths } = await renderPreview(engine, 'title: Hello\n+++\n# {{ self.title }}\n');
  assert.match(html, /<h1 id="[^"]*">Hello<\/h1>/);
  assert.deepEqual(emittedPaths, []);
});

test('multi-document files render document 0 as the entry, with $.find reaching the others', async () => {
  const source = [
    'title: Index',
    '+++',
    '{% for (const d of $.find({ role: "member" })) { %}',
    '- {{ d.title }}',
    '{% } %}',
    '---',
    'title: Alice',
    'role: member',
    '+++',
    'unused body',
  ].join('\n');
  const { html } = await renderPreview(engine, source);
  assert.match(html, /<li>Alice<\/li>/);
  assert.doesNotMatch(html, /unused body/); // only the entry renders
});

test('extra context (the CLI -d flag) arrives as arg, front matter as self — never merged', async () => {
  const source = 'title: Hello\n+++\n# {{ arg.title ?? self.title }}\n';
  const { html } = await renderPreview(engine, source, { title: 'Override' });
  assert.match(html, /<h1 id="[^"]*">Override<\/h1>/); // arg wins when passed
  const { html: bare } = await renderPreview(engine, source);
  assert.match(bare, /<h1 id="[^"]*">Hello<\/h1>/); // self is the fallback with no context
});

test('$.emit output is collected, not lost', async () => {
  const { emittedPaths } = await renderPreview(engine, "{% $.emit('out/a.txt', 'hi') %}ok\n");
  assert.deepEqual(emittedPaths, ['out/a.txt']);
});

test('a real example file renders', async () => {
  const source = readFileSync(join(here, '..', '..', '..', '..', 'examples', 'document-set.mdy'), 'utf8');
  const { html } = await renderPreview(engine, source);
  assert.ok(html.length > 0);
});

test('the BUNDLED engine (dist/, built by pretest) renders standalone — sandbox and query wasm included', async () => {
  const bundled = await import('../dist/mdy-engine.mjs');
  const source = 'title: Bundled\n+++\n# {{ self.title }}\n\n{% for (const d of $.find({})) { %}- {{ d.title }}\n{% } %}';
  const { html } = await renderPreview(bundled, source);
  assert.match(html, /<h1 id="[^"]*">Bundled<\/h1>/); // lamassu.wasm ran the template
  assert.match(html, /<li>Bundled<\/li>/); // nisaba.wasm answered $.find
});

// --- resolveEnginePackage: eslint-style walk-up over an injected filesystem

const fakeIo = (files) => ({
  isFile: (p) => Object.hasOwn(files, p),
  readText: (p) => files[p],
});
// Build absolute paths portably (the walk uses node:path, so tests must too).
const abs = (...parts) => join(sep, ...parts);

test('nearest node_modules/mdy-docs wins', () => {
  const io = fakeIo({
    [abs('proj', 'node_modules', 'mdy-docs', 'package.json')]: '{"name":"mdy-docs"}',
    [abs('node_modules', 'mdy-docs', 'package.json')]: '{"name":"mdy-docs"}',
  });
  assert.equal(
    resolveEnginePackage(abs('proj', 'docs', 'deep'), io),
    abs('proj', 'node_modules', 'mdy-docs')
  );
});

test('a checkout of mdy-docs itself counts as the engine (what previews examples/ in this repo)', () => {
  const io = fakeIo({
    [abs('repo', 'package.json')]: '{"name":"mdy-docs"}',
  });
  assert.equal(resolveEnginePackage(abs('repo', 'examples'), io), abs('repo'));
});

test('other packages and unparseable package.json files are walked past; nothing found is null', () => {
  const io = fakeIo({
    [abs('proj', 'package.json')]: 'not json',
    [abs('other', 'package.json')]: '{"name":"other"}',
  });
  assert.equal(resolveEnginePackage(abs('proj', 'src'), io), null);
  assert.equal(resolveEnginePackage(abs('other'), io), null);
});

test('this repo resolves to itself, and engineEntry prefers src/mdy.js', () => {
  const io = {
    isFile: (p) => {
      try {
        return readFileSync(p) != null;
      } catch {
        return false;
      }
    },
    readText: (p) => readFileSync(p, 'utf8'),
  };
  const pkg = resolveEnginePackage(here, io);
  assert.equal(pkg, join(here, '..', '..', '..', '..'));
  assert.equal(engineEntry(pkg, io), join(pkg, 'src', 'mdy.js'));
});

// --- rewriteResourceUrls

test('relative and root-absolute resource URLs are handed to rewrite; schemed ones pass through', () => {
  const html =
    '<img src="./a.png"> <img src="sub/b.png"> <img src="/root.png"> ' +
    '<img src="https://x/c.png"> <img src="data:image/png;base64,xx"> <img src="#frag">' +
    "<video poster='p.png'></video>";
  const out = rewriteResourceUrls(html, (src) => `W(${src})`);
  assert.match(out, /src="W\(\.\/a\.png\)"/);
  assert.match(out, /src="W\(sub\/b\.png\)"/);
  assert.match(out, /src="W\(\/root\.png\)"/);
  assert.match(out, /src="https:\/\/x\/c\.png"/);
  assert.match(out, /src="data:image\/png;base64,xx"/);
  assert.match(out, /src="#frag"/);
  assert.match(out, /poster='W\(p\.png\)'/);
});

test('links are not resources — a[href] stays as authored', () => {
  const html = '<a href="./other.mdy">other</a>';
  assert.equal(rewriteResourceUrls(html, () => 'REWRITTEN'), html);
});

// --- shell, error, and note HTML

test('the shell embeds the initial body, the nonce on both CSP and script, and the webview csp source', () => {
  const html = previewShellHtml({ body: '<h1>Hi</h1>', nonce: 'NONCE123', cspSource: 'vscode-resource:' });
  assert.match(html, /<main id="content"><h1>Hi<\/h1><\/main>/);
  assert.match(html, /script-src 'nonce-NONCE123'/);
  assert.match(html, /<script nonce="NONCE123">/);
  assert.match(html, /img-src vscode-resource: https: data:/);
});

test('error and emit-note HTML escape their inputs', () => {
  assert.match(errorHtml('<b>&boom'), /<pre>&lt;b&gt;&amp;boom<\/pre>/);
  assert.match(emitNoteHtml(['a<b.txt']), /a&lt;b\.txt/);
  assert.equal(emitNoteHtml([]), '');
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
});
