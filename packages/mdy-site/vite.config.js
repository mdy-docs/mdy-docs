import {resolve} from 'node:path'
import {defineConfig} from 'vite'

// The engine is packages/mdy-native/build/wasm — outside this package, so
// outside the dev server's default fs-serving root (403). Allow the repo.
const repoRoot = resolve(import.meta.dirname, '../..')

export default defineConfig({
  server: {port: 5173, fs: {allow: [repoRoot]}},
  build: {
    target: 'es2022',
    // Two pages: the landing page, and the language tour it links to.
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        language: resolve(import.meta.dirname, 'language.html')
      }
    }
  }
})
