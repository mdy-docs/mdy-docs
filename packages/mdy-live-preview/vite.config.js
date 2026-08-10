import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// mdy-docs (and through it both wasm engines) is a file: link into this
// repo, so the real .wasm paths live outside this package — outside the
// dev server's default fs-serving root (403). Allow the whole repo.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Config carried over from the repo's earlier web/ playground, which ran
// the same wasm engines under Vite:
//
// - optimizeDeps.exclude: @jsquash/* (reached via mdy-docs' $.resize) are
//   real npm packages, so the dev server's pre-bundler would sweep them up
//   and break their wasm-bindgen `new URL(...)` resolution — the wasm
//   fetch 404s into the SPA fallback and instantiation fails on HTML
//   bytes. Excluding them keeps their import.meta.url resolution correct.
//   (mdy-docs itself is a file: link, which the pre-bundler skips anyway.)
// - target esnext: the engine modules use top-level await.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // @mdy-docs/react is a file: link and carries React in its own
    // devDependencies, so it resolves to packages/mdy-react/node_modules/react
    // — a second copy, and two copies of React means every hook it calls
    // throws "invalid hook call". Deduping pins both sides to this package's
    // copy. Any file: linked React library needs this.
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    exclude: ['@jsquash/png', '@jsquash/resize', '@jsquash/jpeg'],
  },
  server: {
    port: 8091,
    fs: { allow: [repoRoot] },
  },
  preview: {
    port: 8091,
  },
  build: {
    target: 'esnext',
  },
});
