/*
 * The engine, which is C.
 *
 * packages/mdy-native is the mdy engine as a C program — the parser this
 * page tours, the template VM, the query engine, the broker and the
 * highlighter, in one binary — and `make wasm` there compiles it with
 * emscripten. Its wrapper drives it as the command line is driven: the
 * source written into the module's filesystem, `main()` called with the
 * arguments `mdy document.mdy --html --sanitize --scope … --response …`
 * would have, the output read back.
 *
 * The module is compiled once and instantiated per render — the engine
 * keeps a little static state a process never had to reset, and a fresh
 * instance of a compiled module costs microseconds where compiling 2 MB of
 * wasm on every keystroke would not.
 */
import {document as renderDocument} from '../../mdy-native/wasm/index.mjs'
import createModule from '../../mdy-native/build/wasm/mdy-native.mjs'

const wasmUrl = new URL('../../mdy-native/build/wasm/mdy-native.wasm', import.meta.url)

let compiled = null

function compile() {
  compiled ||= (async () => {
    const node = typeof process !== 'undefined' && process.versions?.node

    if (!node) {
      try {
        return await WebAssembly.compileStreaming(fetch(wasmUrl))
      } catch {
        /* a server that does not say application/wasm: compile the bytes */
        return WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer())
      }
    }

    // Under node, off the disk — including a test runner's DOM, where the
    // module's URL is the dev server's `/@fs/` spelling of a path.
    const {readFile} = await import('node:fs/promises')
    const {fileURLToPath} = await import('node:url')
    const at = wasmUrl.pathname.indexOf('/@fs/')
    const path =
      wasmUrl.protocol === 'file:'
        ? fileURLToPath(wasmUrl)
        : decodeURIComponent(wasmUrl.pathname.slice(at >= 0 ? at + 4 : 0))

    return WebAssembly.compile(await readFile(path))
  })()

  return compiled
}

/** A module factory over the cached compilation. */
async function factory(options) {
  const module = await compile()

  return createModule({
    ...options,
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then((instance) => done(instance, module))
      return {}
    }
  })
}

/**
 * Render one document as the tour page reads it: a task's box is a form, the
 * sanitizer is on and reports what it drops, the host's values are in scope,
 * and `req` is what the document is answering. A bare `---` starts a second
 * document, as it does everywhere in mdy — the tour shows only the first.
 *
 * @param {string} source
 * @param {{scope?: Record<string, unknown>, request?: Record<string, unknown>}} [options]
 * @returns {Promise<{html: string, data: object | null, warnings: Array<{line: number | null, reason: string, rule: string}>, error: string | null}>}
 */
export async function render(source, {scope, request} = {}) {
  const r = await renderDocument(source, {
    html: true,
    sanitize: true,
    scope,
    data: request,
    response: true,
    createModule: factory
  })
  const error = r.status === 0 ? null : (r.errors || `mdy exited with ${r.status}`).replace(/^mdy: /, '')

  // The command ends its output with a newline, as a file should end; the
  // parser's HTML never had one, and neither does the pane's.
  return {html: r.output.replace(/\n$/, ''), data: r.data, warnings: r.warnings, error}
}
