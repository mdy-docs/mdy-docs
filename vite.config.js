import { defineConfig } from 'vite';

// The mdy playground (web/) — a whole site (content, layouts, site.yaml)
// edited and built entirely client-side, the same renderSite() the CLI
// uses. Every engine involved (lamassu, nisaba) is WebAssembly, locating
// its .wasm via `new URL("….wasm", import.meta.url)`, which Vite's
// PRODUCTION build statically rewrites and emits as real assets — no
// wasm-specific config needed there. They still work with no config in the
// DEV SERVER too, but only because they're `file:`-linked local packages,
// which Vite's dev-time dependency pre-bundler (esbuild, into
// node_modules/.vite/deps/) doesn't sweep up by default.
//
// @jsquash/png and @jsquash/resize (src/site/images.js's $.resize) are
// real, npm-installed packages, so the dev server's pre-bundler DOES try to
// optimize them — and re-bundling breaks their wasm-bindgen-generated
// `new URL(...)` call: it ends up pointing at node_modules/.vite/deps/
// instead of the package's own directory, so the browser's wasm fetch
// 404s, Vite's dev-server SPA fallback serves index.html instead (200,
// wrong content-type), and WebAssembly.instantiate() fails on `<!do`
// where it expected the wasm magic bytes. `optimizeDeps.exclude` below
// is the fix — skip pre-bundling these specifically, so their own
// import.meta.url resolution stays correct. Production builds (Rollup,
// not esbuild) never hit this; it's dev-server-only, confirmed via a
// real `npm run web` + Playwright run, not assumed.
export default defineConfig({
  root: 'web',
  base: './', // relative asset URLs, so GitHub Pages project sites work

  optimizeDeps: {
    exclude: ['@jsquash/png', '@jsquash/resize', '@jsquash/jpeg'],
  },

  server: {
    port: 8090,
  },
  preview: {
    port: 8090,
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    target: 'esnext', // the engine modules use top-level await
  },
});
