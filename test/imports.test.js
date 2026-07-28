import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractImports } from '../src/site/imports.js';
import { renderScriptSite } from '../src/site/script-site.js';
import { memoryFsProvider } from '../src/fs-provider.js';
import { buildSite } from '../src/site/build.js';

// `{% import name from "spec" %}` — see src/site/imports.js's own doc
// comment for the full design (why it's a tag-level rewrite, not real JS;
// why cross-package dispatch is a namespaced handle, not a flat merged
// document set; why cycle detection has to walk a per-path ancestor chain
// rather than a single flat "currently building" set).

// --- extractImports: a pure string transform, no filesystem -----------------

test('extractImports: rewrites a bare import tag into a callable object literal, and reports the spec', () => {
  const { imports, text } = extractImports('before\n{% import style from "../blog-style-x" %}\nafter');
  assert.deepEqual(imports, [{ name: 'style', spec: '../blog-style-x' }]);
  assert.match(text, /const style = \{/);
  assert.match(text, /\$\.__importRender\("\.\.\/blog-style-x", target, ctx/);
  assert.match(text, /\$\.__importFind\("\.\.\/blog-style-x", query/);
  assert.match(text, /\$\.__importFindOne\("\.\.\/blog-style-x", query/);
  assert.match(text, /\$\.__importResize\("\.\.\/blog-style-x", record, options/);
  assert.match(text, /^before\n/);
  assert.match(text, /\nafter$/);
});

test('extractImports: multiple imports in one document, in source order', () => {
  const { imports } = extractImports('{% import a from "./a" %}\n{% import b from "./b" %}');
  assert.deepEqual(imports, [
    { name: 'a', spec: './a' },
    { name: 'b', spec: './b' },
  ]);
});

test('extractImports: text with no import tags is returned unchanged', () => {
  const text = 'title: X\n+++\n{% const x = 1 %}\n{{ x }}';
  assert.deepEqual(extractImports(text), { imports: [], text });
});

test("extractImports: a tag mixing an import with other code isn't recognized (import must be a tag's sole content)", () => {
  const text = '{% import style from "../x"; const y = 1; %}';
  assert.deepEqual(extractImports(text), { imports: [], text });
});

test('extractImports: single-quoted specs work the same as double-quoted', () => {
  const { imports } = extractImports("{% import style from '../blog-style-x' %}");
  assert.deepEqual(imports, [{ name: 'style', spec: '../blog-style-x' }]);
});

// --- integration: real sibling directories on disk --------------------------
// (memoryFsProvider is deliberately a single flat vault with no per-root
// isolation — see its own doc comment — so it can't model two SEPARATE
// packages the way imports need; these tests use real mkdtemp directories,
// same as build.test.js/cli.test.js's own end-to-end coverage.)

async function makeSite(files) {
  const dir = await mkdtemp(join(tmpdir(), 'mdy-import-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

test('a script can render another package via an import, and reach its other files by find/findOne', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mdy-import-parent-'));
  try {
    await mkdir(join(parent, 'site'), { recursive: true });
    await mkdir(join(parent, 'style', 'layouts'), { recursive: true });
    await writeFile(
      join(parent, 'site', 'main.mdy'),
      [
        '+++',
        '{% import style from "../style" %}',
        '{% const meta = style.findOne({ path: "meta.yaml" }) %}',
        '{% const page = style.render({ path: "layouts/base.mdy" }, { content: "hi" }) %}',
        '{{ page }} ({{ meta.license }})',
      ].join('\n')
    );
    await writeFile(join(parent, 'style', 'layouts', 'base.mdy'), '<html>{{ arg.content }}</html>');
    await writeFile(join(parent, 'style', 'meta.yaml'), 'license: CC0\n');

    const { output } = await renderScriptSite(join(parent, 'site'));
    assert.equal(output.trim(), '<html>hi</html> (CC0)');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('the SAME import declared by two different files in one package is only walked/built once (a diamond, not a cycle)', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mdy-import-diamond-'));
  try {
    await mkdir(join(parent, 'site'), { recursive: true });
    await mkdir(join(parent, 'style'), { recursive: true });
    await writeFile(
      join(parent, 'site', 'main.mdy'),
      '+++\n{% import style from "../style" %}\n{% const a = style.render({ path: "main.mdy" }, {}) %}\n' +
        '{% const other = $.render({ path: "about.mdy" }, {}) %}\n{{ a }} / {{ other }}'
    );
    await writeFile(
      join(parent, 'site', 'about.mdy'),
      '+++\n{% import style from "../style" %}\n{{ style.render({ path: "main.mdy" }, {}) }}'
    );
    await writeFile(join(parent, 'style', 'main.mdy'), '+++\nstyled');

    const seen = [];
    const { output } = await renderScriptSite(join(parent, 'site'), {
      onSource: (meta) => seen.push(meta.path),
    });
    assert.equal(output.trim(), 'styled / styled');
    // style/main.mdy is a distinct absolute path from site's own — walked
    // (and reported via onSource) exactly once despite two importers.
    assert.equal(seen.filter((p) => p === 'main.mdy').length, 2); // site's own + style's own — same relative name, different roots, both real
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('import cycle (A imports B imports A) throws a clear error instead of hanging', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mdy-import-cycle-'));
  try {
    await mkdir(join(parent, 'a'), { recursive: true });
    await mkdir(join(parent, 'b'), { recursive: true });
    await writeFile(join(parent, 'a', 'main.mdy'), '{% import b from "../b" %}\n{{ b.render({ path: "main.mdy" }, {}) }}');
    await writeFile(join(parent, 'b', 'main.mdy'), '{% import a from "../a" %}\n{{ a.render({ path: "main.mdy" }, {}) }}');

    await assert.rejects(renderScriptSite(join(parent, 'a')), /import cycle detected/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('an import spec that resolves to an empty/missing directory surfaces a clear error, not a silent empty render', async () => {
  // walkRawSources treats a missing directory as zero sources, not an
  // error (existing, documented behavior) — so "ghost" builds successfully
  // as an EMPTY document set, and the failure surfaces where it actually
  // happens: trying to render something that isn't in it.
  const dir = await makeSite({
    'main.mdy': '{% import ghost from "./does-not-exist" %}\n{{ ghost.render({ path: "main.mdy" }, {}) }}',
  });
  try {
    await assert.rejects(renderScriptSite(dir), /no document matches/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildSite copies an imported package's static/ too, with the importing site's own static/ winning any filename collision", async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mdy-import-static-'));
  const outDir = await mkdtemp(join(tmpdir(), 'mdy-import-static-out-'));
  try {
    await mkdir(join(parent, 'site', 'static'), { recursive: true });
    await mkdir(join(parent, 'style', 'static'), { recursive: true });
    await writeFile(join(parent, 'site', 'main.mdy'), '+++\n{% import style from "../style" %}\n{% $.emit("index.html", "ok") %}');
    await writeFile(join(parent, 'site', 'static', 'shared.txt'), 'from site');
    await writeFile(join(parent, 'style', 'static', 'shared.txt'), 'from style');
    await writeFile(join(parent, 'style', 'static', 'style-only.txt'), 'only in style');

    await buildSite(join(parent, 'site'), { outDir });

    assert.equal(readFileSync(join(outDir, 'shared.txt'), 'utf8'), 'from site'); // site overrides its import
    assert.ok(existsSync(join(outDir, 'style-only.txt'))); // still gets style's own, non-colliding files
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

// --- JS module imports: `await import("./lib.js")` --------------------------
// The OTHER kind of import (real ES modules, engine-instantiated), distinct
// from `{% import %}`'s whole-package imports above — see the loadModule /
// canonicalizeModule wiring in src/site/imports.js and the async-IIFE
// program shape in src/mdy.js's buildProgram.

test('a template can await import() a JS module, and the module can import its own dependencies', async () => {
  const dir = await makeSite({
    'main.mdy': '+++\n{% const util = await import("./lib/util.js") %}\n{{ util.shout("hi") }}',
    'lib/util.js': 'import { upper } from "./case.js";\nexport const shout = (s) => upper(s) + "!";\n',
    'lib/case.js': 'export const upper = (s) => s.toUpperCase();\n',
  });
  try {
    const { output } = await renderScriptSite(dir);
    assert.equal(output.trim(), 'HI!');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a template's own import resolves relative to the FILE that wrote it, not the site root", async () => {
  const dir = await makeSite({
    'main.mdy': '+++\n{{ $.render({ path: "pages/about.mdy" }, {}) }}',
    'util.js': 'export const who = "root";\n',
    'pages/util.js': 'export const who = "pages";\n',
    'pages/about.mdy': '+++\n{% const u = await import("./util.js") %}\n{{ u.who }}',
  });
  try {
    const { output } = await renderScriptSite(dir);
    assert.equal(output.trim(), 'pages');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an imported package's own templates load modules from the PACKAGE's directory, through its own set's loader", async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mdy-import-jsmod-'));
  try {
    await mkdir(join(parent, 'site'), { recursive: true });
    await mkdir(join(parent, 'style', 'layouts'), { recursive: true });
    await mkdir(join(parent, 'style', 'lib'), { recursive: true });
    await writeFile(
      join(parent, 'site', 'main.mdy'),
      '+++\n{% import style from "../style" %}\n{{ style.render({ path: "layouts/base.mdy" }, { content: "x" }) }}'
    );
    await writeFile(
      join(parent, 'style', 'layouts', 'base.mdy'),
      '+++\n{% const fmt = await import("../lib/fmt.js") %}\n{{ fmt.wrap(arg.content) }}'
    );
    await writeFile(join(parent, 'style', 'lib', 'fmt.js'), 'export const wrap = (s) => "[" + s + "]";\n');

    const { output } = await renderScriptSite(join(parent, 'site'));
    assert.equal(output.trim(), '\\[x]'); // normalized markdown escapes the literal bracket
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('editing a JS module between renders is picked up — no stale module registry in the pooled VMs', async () => {
  const dir = await makeSite({
    'main.mdy': '+++\n{% const u = await import("./util.js") %}\n{{ u.version }}',
    'util.js': 'export const version = "v1";\n',
  });
  try {
    assert.equal((await renderScriptSite(dir)).output.trim(), 'v1');
    await writeFile(join(dir, 'util.js'), 'export const version = "v2";\n');
    assert.equal((await renderScriptSite(dir)).output.trim(), 'v2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a module import escaping the package directory is rejected, even when the file exists', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mdy-import-escape-'));
  try {
    await mkdir(join(parent, 'site'), { recursive: true });
    await writeFile(join(parent, 'site', 'main.mdy'), '+++\n{% const s = await import("../secret.js") %}\n{{ s.x }}');
    await writeFile(join(parent, 'secret.js'), 'export const x = "leaked";\n');

    await assert.rejects(renderScriptSite(join(parent, 'site')), /outside this package/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('a missing module rejects with a clear error a template can catch', async () => {
  const dir = await makeSite({
    'main.mdy': '+++\n{% let msg; try { await import("./nope.js") } catch (e) { msg = "" + e } %}\n{{ msg }}',
  });
  try {
    const { output } = await renderScriptSite(dir);
    assert.match(output, /module not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only .js/.mjs files can be imported as modules', async () => {
  const dir = await makeSite({
    'main.mdy': '+++\n{% const d = await import("./meta.yaml") %}\n{{ d }}',
    'meta.yaml': 'license: CC0\n',
  });
  try {
    await assert.rejects(renderScriptSite(dir), /only \.js\/\.mjs modules/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JS module imports work through memoryFsProvider too — the browser playground path, both memory roots', async () => {
  const files = new Map([
    ['main.mdy', '+++\n{% import style from "/style-pkg" %}\n{% const u = await import("./lib/util.js") %}\n{{ u.exclaim(style.render({ path: "base.mdy" }, { content: "m" })) }}'],
    ['lib/util.js', 'export const exclaim = (s) => s + "!";'],
    ['style-pkg/base.mdy', '+++\n{% const fmt = await import("./fmt.js") %}\n{{ fmt.wrap(arg.content) }}'],
    ['style-pkg/fmt.js', 'export const wrap = (s) => "<" + s + ">";'],
  ]);
  const { output } = await renderScriptSite('/', { fs: memoryFsProvider(files) });
  assert.equal(output.trim(), '<m>!');
});
