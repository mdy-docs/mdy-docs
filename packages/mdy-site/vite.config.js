import {resolve} from 'node:path'
import {defineConfig} from 'vite'

export default defineConfig({
  server: {port: 5173},
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
