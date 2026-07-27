/*
 * Bundle the mdy engine into dist/ so the packaged extension previews .mdy
 * files in ANY context — no workspace install of mdy-docs required. (The
 * preview still prefers a workspace-resolved engine when one exists; the
 * bundle is the fallback. See src/preview.cjs.)
 *
 * The entry is src/mdy.js, not index.js: the preview needs only
 * openDocumentSet/createProcessor, and index.js would drag the whole
 * static-site and image-codec layer in. Everything JS is bundled into one
 * ESM file; the two Emscripten-built wasm binaries (lamassu — the template
 * sandbox — and nisaba — the query engine) are copied ALONGSIDE it, because
 * their glue code locates them via `new URL("<name>.wasm", import.meta.url)`
 * — which, once the glue is inside the bundle, resolves next to
 * mdy-engine.mjs. Runs from the repo checkout (esbuild resolves the
 * engine's deps from the root node_modules), as `npm test` and
 * `vscode:prepublish` do.
 */
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const outDir = join(here, '..', 'dist');

// Resolve the wasm binaries the way the engine itself would — through the
// root package's own dependency resolution, not hardcoded third_party paths.
const rootRequire = createRequire(join(root, 'package.json'));
const lamassuWasm = rootRequire.resolve('@mdy-docs/lamassu-js/lamassu.wasm');
const nisabaWasm = join(dirname(rootRequire.resolve('@mdy-docs/nisaba-db/wasm')), 'lib', 'nisaba.wasm');

await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [join(root, 'src', 'mdy.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18', // VSCode ^1.90's extension host
  outfile: join(outDir, 'mdy-engine.mjs'),
  logLevel: 'warning',
});
await copyFile(lamassuWasm, join(outDir, 'lamassu.wasm'));
await copyFile(nisabaWasm, join(outDir, 'nisaba.wasm'));
console.log('bundled engine → dist/ (mdy-engine.mjs + lamassu.wasm + nisaba.wasm)');
