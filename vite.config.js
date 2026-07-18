import { defineConfig } from 'vite';

// The mdy playground (web/) — the full pipeline running client-side. Both
// engines' Emscripten modules locate their .wasm via
// `new URL("….wasm", import.meta.url)`, which Vite statically rewrites and
// emits as assets, so no wasm-specific configuration is needed.
export default defineConfig({
  root: 'web',
  base: './', // relative asset URLs, so GitHub Pages project sites work

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
