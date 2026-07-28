// Build = borrow, then adapt for Electron's renderer: the engine is the
// SAME bundle the vscode extension builds (see
// ../vscode-mdy/scripts/bundle-engine.mjs), but Obsidian plugins run in
// the RENDERER process, where the vscode loading strategy fails twice
// over:
//
//  - dynamic import() of a file:// URL goes through Chromium's fetch
//    machinery, which refuses file URLs ("Failed to fetch dynamically
//    imported module") — so the ESM bundle is converted to CommonJS,
//    which the renderer's Node require() loads happily;
//  - the emscripten glue detects `process.type == "renderer"` and takes
//    its BROWSER path, fetch()ing the .wasm — same file-URL wall. The
//    renderer has full Node fs, so the check is patched to let the glue
//    use its Node path (readFileSync) instead.
//
// import.meta.url (how the engine finds its wasm, gone in CJS) is shimmed
// to the module's own file URL via a banner + define.
//
//   node scripts/build.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vscodePkg = join(here, '..', '..', 'vscode-mdy');
const dist = join(here, '..', 'dist');

execFileSync('node', [join(vscodePkg, 'scripts', 'bundle-engine.mjs')], { stdio: 'inherit' });
mkdirSync(dist, { recursive: true });

const esbuild = await import(join(vscodePkg, 'node_modules', 'esbuild', 'lib', 'main.js')).then((m) => m.default ?? m);
await esbuild.build({
  entryPoints: [join(vscodePkg, 'dist', 'mdy-engine.mjs')],
  outfile: join(dist, 'mdy-engine.cjs'),
  format: 'cjs',
  platform: 'node',
  bundle: false,
  logLevel: 'silent',
  define: { 'import.meta.url': '__mdy_import_meta_url' },
  banner: { js: "const __mdy_import_meta_url = require('url').pathToFileURL(__filename).href;" },
});

// Patch the renderer exclusion (see header). Count-checked so a glue
// update that changes the wording fails the build instead of silently
// shipping a bundle that fetch()es wasm in Obsidian.
const cjsPath = join(dist, 'mdy-engine.cjs');
let cjs = readFileSync(cjsPath, 'utf8');
const marker = ' && globalThis.process?.type != "renderer"';
const hits = cjs.split(marker).length - 1;
if (hits < 1) throw new Error('renderer-check marker not found in engine glue — bundling changed, revisit this patch');
cjs = cjs.split(marker).join('');
writeFileSync(cjsPath, cjs);
console.log(`wrote dist/mdy-engine.cjs (renderer check patched ×${hits})`);

for (const f of ['lamassu.wasm', 'nisaba.wasm']) {
  copyFileSync(join(vscodePkg, 'dist', f), join(dist, f));
  console.log(`copied dist/${f}`);
}
