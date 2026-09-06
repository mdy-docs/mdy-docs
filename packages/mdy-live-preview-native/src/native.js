/*
 * native.js — the engine, which is C.
 *
 * packages/mdy-native is the mdy engine as a C program: the same template
 * VM (lamassu) and query engine (nisaba) the JavaScript uses, and with them
 * the broker (sukkal) and the highlighter, linked into one binary. `make
 * wasm` compiles that binary with emscripten, and its wrapper drives it as
 * the command line is driven: files in, main() run, files out.
 *
 * What this file adds is the one thing a preview needs that a command does
 * not: the module is COMPILED once. Each render still instantiates a fresh
 * instance — the engine keeps a little static state a process never had to
 * reset — but instantiating a compiled module is microseconds, where
 * compiling 2 MB of wasm on every keystroke would not be.
 */
import { document as renderDocument } from '../../mdy-native/wasm/index.mjs';
import createModule from '../../mdy-native/build/wasm/mdy-native.mjs';

const wasmUrl = new URL('../../mdy-native/build/wasm/mdy-native.wasm', import.meta.url);

let compiled = null;
function compile() {
  compiled ||= WebAssembly.compileStreaming(fetch(wasmUrl)).catch(async () => {
    /* a server that does not say application/wasm: compile the bytes */
    const bytes = await (await fetch(wasmUrl)).arrayBuffer();
    return WebAssembly.compile(bytes);
  });
  return compiled;
}

/* A module factory over the cached compilation. emscripten's
 * `instantiateWasm` hook takes the imports and hands back the instance. */
async function factory(options) {
  const module = await compile();
  return createModule({
    ...options,
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then((instance) => done(instance, module));
      return {};
    },
  });
}

/** Cheap enough to run on every keystroke, and it decides whether a run
 * publishes at all — a document that never publishes never opens a broker. */
export const usesMessaging = (source) => /\$\.publish\s*\(/.test(source);

/**
 * Render `source` as `mdy <file> --html` would — and, when it publishes,
 * as `mdy <file> --html --publish` would: each message to the broker in
 * the module, delivered to the page it names, that page's output under
 * its line.
 *
 * @returns {Promise<{ html: string, messages: Array<object>, error: string | null }>}
 */
export async function render(source) {
  const r = await renderDocument(source, {
    html: true,
    publish: usesMessaging(source),
    createModule: factory,
  });
  const error = r.status === 0 ? null : (r.errors || `mdy exited with ${r.status}`).replace(/^mdy: /, '');
  return { html: r.output, messages: r.messages, error };
}
