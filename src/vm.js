import { createLamassu } from '@mdy-docs/lamassu-js';

/*
 * The lamassu VM executor. Templates run inside lamassu-js — a sandboxed
 * JavaScript-subset engine compiled to WebAssembly — never in the host
 * runtime. The engine's current embedding surface is a synchronous REPL-style
 * `eval(source) → string`, where the completion value appears on a line
 * prefixed with "⇒ " and errors appear as bare error text.
 *
 * mdy sends the VM complete, self-contained programs (an IIFE per attempt —
 * nothing leaks into the persistent REPL scope, so one engine instance is
 * shared for all renders) whose completion value is a JSON envelope. See
 * buildProgram in mdy.js for the protocol.
 */

let vmPromise = null;

/** The shared lamassu instance (created lazily on first render). */
export function getVm() {
  vmPromise ??= createLamassu();
  return vmPromise;
}

/**
 * Evaluate one program in the VM and return its completion value (the text
 * after "⇒ "). Engine-level failures (syntax errors, uncaught errors that
 * escaped the program's own try/catch) throw.
 *
 * @param {string} program
 * @returns {Promise<string>} the completion value, raw
 */
export async function runProgram(program) {
  const vm = await getVm();
  const output = vm.eval(program);
  const line = output
    .split('\n')
    .filter((l) => l.startsWith('⇒ '))
    .pop();
  if (line === undefined) {
    throw new Error(`mdy: template engine error: ${output.trim()}`);
  }
  return line.slice(2); // "⇒ " = one char + space
}
