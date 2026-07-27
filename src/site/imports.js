import { walkRawSources } from '../vault.js';
import { openDocumentSet } from '../mdy.js';

// Pure, POSIX-only path math — NOT node:path. A resolved import's absDir
// can be a real disk path (nodeFsProvider) or a virtual one like "/" or
// "/blog-style-x" (memoryFsProvider, web/'s in-browser playground — see
// fs-provider.js's root-prefix support), and node:path is a Vite
// browser-external stub with no real implementation client-side (the
// bug this replaced: "join is not a function" in the browser bundle).
// Every root this package ever deals with is POSIX-shaped (this whole
// project has no Windows-path handling anywhere else either), so plain
// string math is both correct and portable here in a way importing the
// real module isn't.
function dirnameOf(p) {
  const idx = p.lastIndexOf('/');
  if (idx < 0) return '.';
  return idx === 0 ? '/' : p.slice(0, idx);
}
function joinPaths(...parts) {
  return parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}
function resolvePath(base, spec) {
  const combined = spec.startsWith('/') ? spec : joinPaths(base, spec);
  const absolute = combined.startsWith('/');
  const stack = [];
  for (const seg of combined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return (absolute ? '/' : '') + stack.join('/');
}

/*
 * Importing another mdy project — "just like a normal JavaScript import,
 * but the thing being imported is a package's own main.mdy, compiled to
 * JS, that the importing script can choose to run" (docs/site-plan.md has
 * the fuller design history). This is how a script-defined site pulls in
 * another package's files — a style/theme, or anything else — without any
 * host-side convention: the import is a line the SCRIPT writes, not
 * config.
 *
 *   {% import style from "../blog-style-x" %}
 *   {% const page = style.render({ path: "layouts/base.mdy" }, { content: html, site: site }) %}
 *
 * `style` is bound to an object shaped exactly like openDocumentSet's own
 * return value (render/find/findOne), plus `resize` (images.js's native,
 * since it's the one existing native whose behavior depends on which
 * directory its source file actually lives in) — everything under
 * "../blog-style-x" is walked and compiled into its OWN document set, not
 * merged into the importer's, so the imported package's own $.find/$.render
 * calls keep working exactly as if it were rendered standalone (its
 * "layouts/base.mdy" doesn't collide with the importer's own file of the
 * same name, and neither package needs to know it's importable ahead of
 * time). The importer reaches into it explicitly, by calling style's own
 * methods — that's the whole feature; there is no flat merged pool of every
 * file from every package.
 *
 * `import` is parsed by extractImports below, NOT the underlying JS engine
 * — a real `import` statement isn't legal inside a function body (which is
 * what every compiled {% %} block ultimately is; see mdy.js's
 * compileTemplateSource/buildProgram), so this is mdy's own tag-level
 * preprocessing, symmetrical to extractDataBlocks' ```data fences: a
 * recognized shape gets rewritten to ordinary (VM-legal) JS before the rest
 * of the compiler ever sees it.
 */

// `{% import name from "spec" %}` — and nothing else in that tag; a tag
// mixing an import with other code isn't recognized (import/from aren't
// legal as ordinary expression code, so mixing them would surface as a
// template compile error instead — a clear signal, not a silent misparse).
const IMPORT_TAG = /\{%\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+(["'])([^"']+)\2\s*;?\s*%\}/g;

/**
 * Scan a document's raw template text for `{% import name from "spec" %}`
 * declarations, returning the specs found (in source order) and the text
 * with each one rewritten to a plain object literal the VM can actually run:
 *
 *   const name = {
 *     render:   (target, ctx) => $.__importRender(spec, target, ctx),
 *     find:     (query) => $.__importFind(spec, query),
 *     findOne:  (query) => $.__importFindOne(spec, query),
 *     resize:   (record, options) => $.__importResize(spec, record, options),
 *   };
 *
 * `$.__import*` are wired up by buildImportGraph, below — generic natives,
 * not specific to any one import; `spec` (the literal string the script
 * wrote) is what tells them which resolved package to dispatch to (see
 * buildImportGraph's `lookupImport`).
 *
 * Pure string transform, no filesystem access — resolving `spec` into a
 * real directory is buildImportGraph's job.
 *
 * @param {string} text
 * @returns {{ imports: { name: string, spec: string }[], text: string }}
 */
export function extractImports(text) {
  const imports = [];
  const rewritten = text.replace(IMPORT_TAG, (_match, name, _quote, spec) => {
    imports.push({ name, spec });
    const specLiteral = JSON.stringify(spec);
    return `{%
  const ${name} = {
    render: (target, ctx) => $.__importRender(${specLiteral}, target, ctx === undefined ? {} : ctx),
    find: (query) => $.__importFind(${specLiteral}, query === undefined ? {} : query),
    findOne: (query) => $.__importFindOne(${specLiteral}, query === undefined ? {} : query),
    resize: (record, options) => $.__importResize(${specLiteral}, record, options === undefined ? {} : options),
  };
%}`;
  });
  return { imports, text: rewritten };
}

/**
 * Build a document set for `absDir`, resolving every `{% import %}` it (or
 * anything it imports, transitively) declares first — each resolved package
 * gets its OWN document set, built the same way, recursively.
 *
 * `ctx.buildNatives(absDir)` — the natives every document set needs
 * regardless of imports (script-site.js's resize/tokenize/rfc822/markdown),
 * built per-directory since `resize` reads real files relative to `absDir`.
 * `ctx.onEmit`/`ctx.onSource` — passed straight through to every level's
 * own openDocumentSet, so a $.emit from an IMPORTED package's own code
 * contributes to the same outputs as the top-level site, and every file
 * under every resolved import is reported through the same onSource hook
 * (see script-site.js/bin/mdy.js's "[read] <path>" logging).
 * `ctx.cache` (`Map<absDir, Promise<set>>`) dedupes an import resolved more
 * than once (the same package imported from two different files, or two
 * different packages importing a shared common one) to a single build —
 * this is a normal "diamond" (two files importing the same thing), not a
 * cycle, so it must be checked separately from cycle detection, below.
 * `ctx.roots` (array, mutated) collects every resolved directory in
 * post-order (an import's own root lands before the thing that imported
 * it) — build.js's static/ passthrough copies in this order, so a site's
 * own static/ (added last, after everything it imports) wins any filename
 * collision, matching Hugo/Jekyll's "site overrides theme" precedence.
 *
 * `ancestors` (recursive-call-only, not part of `ctx` — every caller
 * outside this file omits it) is the chain of directories from the root
 * down to whoever is calling this: a REAL cycle (A imports B imports A)
 * has `absDir` reappear in ITS OWN ancestor chain; a diamond (two files in
 * the same directory, or two different directories, both importing the
 * same third package) does not — `absDir` there is a fresh, unrelated
 * lookup that should just dedupe via `ctx.cache`, not error. Checking a
 * flat "currently resolving anywhere" set instead of this per-path chain
 * was tried first and is wrong: two sibling files importing the same
 * package both start resolving it before either finishes, and a flat set
 * can't tell that apart from real self-import.
 *
 * @param {string} absDir
 * @param {{
 *   fs: import('../fs-provider.js').FsProvider,
 *   buildNatives: (absDir: string) => Record<string, Function>,
 *   onEmit?: Function,
 *   onSource?: (meta: object) => void,
 *   cache: Map<string, Promise<any>>,
 *   roots: string[],
 * }} ctx
 * @param {Set<string>} [ancestors]
 * @returns {Promise<{ docs, find, findOne, render, resize, root: string }>}
 */
export async function buildImportGraph(absDir, ctx, ancestors = new Set()) {
  const { fs, buildNatives, onEmit, onSource, cache, roots } = ctx;

  if (ancestors.has(absDir)) {
    throw new Error(`mdy: import cycle detected — ${[...ancestors, absDir].join(' -> ')}`);
  }
  if (cache.has(absDir)) return cache.get(absDir);

  const building = (async () => {
    const childAncestors = new Set([...ancestors, absDir]);

    const rawSources = await walkRawSources(absDir, { fs });
    // sourcePath -> [{ name, spec }]
    const importsBySourcePath = new Map();
    const sources = rawSources.map(({ text, meta }) => {
      const { imports, text: rewritten } = extractImports(text);
      if (imports.length > 0) importsBySourcePath.set(meta.path, imports);
      return { text: rewritten, meta };
    });
    if (onSource) for (const { meta } of sources) onSource(meta);

    // Resolve every declared import relative to the FILE that declared
    // it (not absDir itself) — same as a real relative JS import.
    // sourcePath -> Map<spec, Promise<set>>
    const resolvedBySourcePath = new Map();
    for (const [sourcePath, imports] of importsBySourcePath) {
      const fileDir = dirnameOf(joinPaths(absDir, sourcePath));
      const bySpec = new Map();
      for (const { spec } of imports) {
        const childAbsDir = resolvePath(fileDir, spec);
        bySpec.set(spec, buildImportGraph(childAbsDir, ctx, childAncestors));
      }
      resolvedBySourcePath.set(sourcePath, bySpec);
    }
    await Promise.all(
      [...resolvedBySourcePath.values()].flatMap((bySpec) => [...bySpec.values()])
    );

    const lookupImport = (spec, docData) => {
      const bySpec = resolvedBySourcePath.get(docData.path);
      const handlePromise = bySpec?.get(spec);
      if (!handlePromise) {
        throw new Error(`mdy: import ${JSON.stringify(spec)} was not resolved (declared in ${docData.path})`);
      }
      return handlePromise; // already-settled by the Promise.all above
    };

    const extraNatives = {
      ...buildNatives(absDir),
      // renderRaw, not render: a cross-package render is an EMBEDDING (its
      // result lands inside the importing template's own output, possibly
      // raw XML/HTML) — byte-exact, same semantics as the in-set $.render.
      __importRender: async (spec, target, importCtx, _i, docData) =>
        (await lookupImport(spec, docData)).renderRaw(target, importCtx),
      __importFind: async (spec, query, _i, docData) => (await lookupImport(spec, docData)).find(query),
      __importFindOne: async (spec, query, _i, docData) => (await lookupImport(spec, docData)).findOne(query),
      __importResize: async (spec, record, options, _i, docData) =>
        (await lookupImport(spec, docData)).resize(record, options),
    };

    /*
     * JS modules: `{% const util = await import("./lib/util.js") %}` — the
     * OTHER kind of import, real ES modules (engine-instantiated, with
     * their own static import graphs) rather than mdy packages. A template's
     * own import resolves relative to the FILE that wrote it (referrer ""
     * — same rule as `{% import %}` specs above); a module's imports
     * resolve relative to the importing module. The canonicalizer makes
     * every specifier an absolute vault path, which becomes the module's
     * registry identity — so "./util.js" from two different directories is
     * two different modules, and the same file reached by two spellings is
     * one. Modules stay INSIDE this package's own directory, mirroring the
     * package-import design: an imported package's templates load their own
     * modules through their own set's loader (its absDir), and nothing here
     * reaches across package roots or outside the graph entirely.
     */
    const modulePrefix = absDir.endsWith('/') ? absDir : absDir + '/';
    const canonicalizeModule = (specifier, referrer, _i, docData) => {
      const baseDir = referrer !== '' ? dirnameOf(referrer) : dirnameOf(joinPaths(absDir, docData.path));
      return resolvePath(baseDir, specifier);
    };
    const loadModule = async (specifier) => {
      if (!/\.m?js$/i.test(specifier)) {
        throw new Error(`only .js/.mjs modules can be imported (got ${JSON.stringify(specifier)})`);
      }
      if (!specifier.startsWith(modulePrefix)) {
        throw new Error(`module ${JSON.stringify(specifier)} is outside this package (${absDir})`);
      }
      try {
        return await fs.read('/', specifier.replace(/^\/+/, ''));
      } catch {
        throw new Error(`module not found: ${specifier}`);
      }
    };

    const set = await openDocumentSet(sources, { natives: extraNatives, onEmit, loadModule, canonicalizeModule });
    roots.push(absDir);
    return { ...set, resize: extraNatives.resize, root: absDir };
  })();

  cache.set(absDir, building);
  return building;
}
