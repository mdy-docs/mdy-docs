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
 * @param {string} program
 * @param {Record<string, Function>} [natives] host functions for `__hostcall`
 * @returns {Promise<string>} the completion value, raw
 */
export async function runProgram(program, natives = {}) {
  const vm = await acquire();
  try {
    vm.setNatives(natives);
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
    release(vm);
  }
}
