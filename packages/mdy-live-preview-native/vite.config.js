import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The engine is packages/mdy-native/build/wasm — outside this package, so
// outside the dev server's default fs-serving root (403). Allow the repo.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// target esnext: the emscripten module and its wrapper use top-level await,
// and `new URL('mdy-native.wasm', import.meta.url)` is how the .wasm is
// found — an asset on build, a /@fs/ path in development.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 8092,
    fs: { allow: [repoRoot] },
  },
  preview: {
    port: 8092,
  },
  build: {
    target: 'esnext',
  },
});
