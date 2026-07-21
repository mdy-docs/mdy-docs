import { createLamassu } from '@mdy-docs/lamassu-js';

/*
 * The lamassu VM executor. Templates run inside lamassu-js — a sandboxed
 * JavaScript-subset engine compiled to WebAssembly — never in the host
 * runtime. `$` methods that need the host (find / findOne / render) are
 * real host calls: the guest invokes `__hostcall`, the whole VM execution
 * suspends (Asyncify) while the host's async native runs (a nisaba query, a
 * nested render), and resumes with its result.
 *
 * Instances are pooled: a suspended instance must not be re-entered
 * (Asyncify is not reentrant), so each concurrently running program — and
 * each nesting level of $.render — holds its own instance for the duration
 * of its eval. Instances are cheap-ish (16MB initial, growable) and reused.
 */

const POOL_MAX = 4;
const pool = [];

async function acquire() {
  return pool.pop() ?? createLamassu();
}

function release(vm) {
  vm.setNatives({});
  if (pool.length < POOL_MAX) pool.push(vm);
}

/**
 * Evaluate one program in a pooled VM instance with the given natives
 * installed, and return its completion value (the text after "⇒ ").
 * Engine-level failures (syntax errors, uncaught errors that escaped the
 * program's own try/catch) throw.
 *
 * `options.loadModule` / `options.canonicalizeModule` wire the engine's ES
 * module loader (see lamassu-js's createLamassu docs) for THIS eval only —
 * they power guest-side dynamic `import()`. An instance whose module
 * registry got populated is reset before returning to the pool: the
 * registry caches evaluated module source per canonical specifier for the
 * VM's lifetime, and a pooled instance outlives any one render — without
 * the reset, a watch-mode rebuild after editing a .js module could be
 * served the stale cached copy by whichever instance loaded it first.
 *
 * @param {string} program
 * @param {Record<string, Function>} [natives] host functions for `__hostcall`
 * @param {{
 *   loadModule?: (specifier: string, referrer: string) => string | Promise<string>,
 *   canonicalizeModule?: (specifier: string, referrer: string) => string,
 * }} [options]
 * @returns {Promise<string>} the completion value, raw
 */
export async function runProgram(program, natives = {}, options = {}) {
  const vm = await acquire();
  let loadedModules = false;
  try {
    vm.setNatives(natives);
    if (options.loadModule) {
      vm.setModuleLoader((specifier, referrer) => {
        loadedModules = true;
        return options.loadModule(specifier, referrer);
      }, options.canonicalizeModule);
    }
    const output = await vm.eval(program);
    const line = output
      .split('\n')
      .filter((l) => l.startsWith('⇒ '))
      .pop();
    if (line === undefined) {
      throw new Error(`mdy: template engine error: ${output.trim()}`);
    }
    return line.slice(2); // "⇒ " = one char + space
  } finally {
    vm.setModuleLoader();
    if (loadedModules) vm.reset();
    release(vm);
  }
}
