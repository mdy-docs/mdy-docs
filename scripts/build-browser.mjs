/*
 * Bundle mdy-docs for a browser, and put the WASM engines next to it.
 *
 * The package is already browser-shaped — every dependency is pure JavaScript
 * or WebAssembly, node builtins are reached through lazy dynamic imports so a
 * bundler never has to resolve them, and the site layer takes its filesystem as
 * an argument (memoryFsProvider, or a host's own). This turns that into an
 * artifact: one ESM bundle plus the `.wasm` files its engines load at runtime.
 *
 * The wasm copy is the part worth being careful about. Emscripten's loader
 * fetches `lamassu.wasm` relative to the module that asked for it, which after
 * bundling is the bundle itself — so the files have to sit beside it. Vite does
 * this automatically and esbuild does not, which means a bundle built here and
 * shipped without them fails at RUNTIME, in a webview, with a fetch error. So
 * this resolves them through the package graph rather than by hardcoded path,
 * and throws if a package that should have one does not.
 *
 * node builtins stay external. A browser cannot resolve them and does not need
 * to: `buildSite` and `serveSite` are the only things that reach for one, they
 * import it lazily, and a webview calls `renderSite(root, { fs })` instead.
 */

import { createRequire } from 'node:module';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages whose WASM has to travel with the bundle. */
const WASM_PACKAGES = ['@mdy-docs/lamassu-js', '@mdy-docs/nisaba-db'];

/** The directory a package resolves to — the nearest ancestor of its entry
 * point holding a package.json. Not `require.resolve(pkg + '/package.json')`,
 * which several of these deliberately do not export. */
function packageRoot(name) {
  let dir = dirname(require.resolve(name));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`build-browser: no package root above ${require.resolve(name)}`);
}

/** Every .wasm under `dir`, skipping node_modules and build scratch. */
async function findWasm(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await findWasm(p, found);
    else if (entry.name.endsWith('.wasm')) found.push(p);
  }
  return found;
}

export async function buildBrowser({ outDir = join(root, 'dist', 'browser'), minify = true } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [join(root, 'index.js')],
    outfile: join(outDir, 'mdy.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify,
    // See the file comment: nothing in a browser path reaches one, and the
    // few host-only functions import theirs lazily.
    external: ['node:*'],
    logLevel: 'silent',
    metafile: true,
  });

  const copied = [];
  for (const name of WASM_PACKAGES) {
    const found = await findWasm(packageRoot(name));
    if (found.length === 0) {
      throw new Error(
        `build-browser: ${name} has no .wasm — the engines are loaded at runtime by ` +
          `filename beside the bundle, so a missing one fails in the browser, not here. ` +
          `Has the package been built?`
      );
    }
    for (const src of found) {
      const dest = join(outDir, src.slice(src.lastIndexOf('/') + 1));
      await cp(src, dest);
      copied.push({ file: dest.slice(outDir.length + 1), bytes: (await stat(dest)).size });
    }
  }

  const bundle = join(outDir, 'mdy.js');
  const bundleBytes = (await stat(bundle)).size;

  // A manifest, so a consumer (the desktop shell, a test, a packaging step)
  // can find out what has to ship without re-deriving it.
  await writeFile(
    join(outDir, 'manifest.json'),
    `${JSON.stringify({ bundle: 'mdy.js', bytes: bundleBytes, wasm: copied }, null, 2)}\n`
  );

  return { outDir, bundle, bundleBytes, wasm: copied, metafile: result.metafile };
}

// Run directly: `node scripts/build-browser.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  const out = await buildBrowser();
  console.log(`mdy.js          ${kb(out.bundleBytes)}`);
  for (const w of out.wasm) console.log(`${w.file.padEnd(15)} ${kb(w.bytes)}`);
  console.log(`→ ${out.outDir}`);
}
