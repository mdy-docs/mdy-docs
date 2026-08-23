import { useEffect, useMemo, useRef, useState } from 'react';
import { createReactProcessor } from './processor.js';

const EMPTY = {};

const shallowEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is(a[k], b[k]));
};

/**
 * A reference that only changes when the value is shallowly different, so an
 * inline `components={{ code: CodeBlock }}` prop does not rebuild the
 * processor — and re-trigger the render effect — on every single render. One
 * level deep: keep plugin arrays (whose entries are often `[plugin, options]`
 * tuples) as module-level constants.
 */
const useShallow = (value) => {
  const ref = useRef(value);
  if (!shallowEqual(ref.current, value)) ref.current = value;
  return ref.current;
};

/**
 * The same, by JSON identity — for document data, which is JSON by
 * construction (it has to cross into the sandboxed VM) and is usually nested
 * deeply enough that a shallow compare would not help.
 */
const useJson = (value) => {
  const key = JSON.stringify(value ?? null);
  const ref = useRef({ key, value });
  if (ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
};

/**
 * Render an mdy source to a React element, asynchronously (the template layer
 * runs in a WASM VM, so there is no synchronous answer to give).
 *
 * Built for the live-editor case, which is what mdy documents in a browser
 * mostly are:
 *
 *   - **The last good render stays on screen.** A keystroke that leaves the
 *     document mid-sentence — an unclosed `{%`, a half-typed `$.find` — sets
 *     `error` and leaves `element` alone, so the preview does not strobe
 *     between content and a stack trace as you type.
 *   - **Stale renders are dropped.** Renders are async and can finish out of
 *     order; only the newest one is ever committed.
 *   - **`pending` is advisory**, for a spinner or a dimmed pane. It does not
 *     blank the output.
 *
 * @param {string | string[]} source
 * @param {object} [options] as createReactProcessor, plus `data` (the entry
 *   document's `req`) and `entry` (which document to render, default 0)
 * @returns {{ element: import('react').ReactElement | null, error: Error | null, pending: boolean }}
 */
export function useMdy(source, options = {}) {
  const { data = EMPTY, entry = 0, components, passNode, rehypePlugins, sanitize } = options;

  const config = useShallow({ components, passNode, rehypePlugins, sanitize });
  const stableData = useJson(data);
  const processor = useMemo(() => createReactProcessor(config), [config]);

  const [state, setState] = useState({ element: null, error: null, pending: true });
  const latest = useRef(0);

  useEffect(() => {
    const id = ++latest.current;
    const current = () => id === latest.current;
    setState((prev) => (prev.pending ? prev : { ...prev, pending: true }));

    processor.render(source, stableData, entry).then(
      (element) => current() && setState({ element, error: null, pending: false }),
      (error) => current() && setState((prev) => ({ element: prev.element, error, pending: false })),
    );

    // Bumping the counter is the cancellation: an unmount or a superseded run
    // can no longer commit, and there is nothing in the VM to abort.
    return () => {
      latest.current++;
    };
  }, [processor, source, stableData, entry]);

  return state;
}
