/*
 * Bundle the app's frontend into web/dist, with the WASM engines beside it.
 *
 * The frontend is the whole of mdy-docs plus a filesystem provider and about a
 * hundred lines of application, so it needs a bundler for the same reason any
 * page does: bare specifiers. Tauri's `frontendDist` points here, and
 * `generate_context!` embeds whatever it finds at COMPILE time — so this has
 * to run before cargo does, which is what the npm scripts arrange.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

import { buildBrowser } from '../../../scripts/build-browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web', 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// mdy-docs' own browser build, for the .wasm files it knows how to find.
// Reused rather than reimplemented: it already fails loudly when an engine is
// missing, which is the failure this would otherwise discover in a webview.
const { outDir: mdyOut, wasm } = await buildBrowser({ minify: true });
for (const w of wasm) await cp(join(mdyOut, w.file), join(out, w.file));

await esbuild.build({
  entryPoints: [join(root, 'web', 'app.js')],
  outfile: join(out, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  // Not minified, and with a sourcemap: an error in the app should name a
  // line somebody can open. The bundle is only read by the webview next door.
  minify: false,
  sourcemap: 'inline',
  external: ['node:*'],
  logLevel: 'info',
});

await cp(join(root, 'web', 'index.html'), join(out, 'index.html'));
console.log(`→ ${out}`);
