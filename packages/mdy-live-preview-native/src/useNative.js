import { useEffect, useRef, useState } from 'react';
import { render } from './native.js';

/**
 * The document, rendered by the C engine — as the state the app places
 * itself: the last GOOD html, the current error if the latest render
 * failed, and whether a render is in flight.
 *
 * A stale result is dropped rather than raced: renders are numbered, and
 * one that finishes after a newer one started says nothing.
 */
export function useNative(source) {
  const [state, setState] = useState({ html: '', messages: [], error: null, pending: true });
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setState((prev) => (prev.pending ? prev : { ...prev, pending: true }));
    render(source).then(
      (r) => {
        if (mine !== seq.current) return;
        setState((prev) => ({
          html: r.error ? prev.html : r.html,
          messages: r.error ? prev.messages : r.messages,
          error: r.error,
          pending: false,
        }));
      },
      (err) => {
        if (mine !== seq.current) return;
        setState((prev) => ({ ...prev, error: String(err?.message ?? err), pending: false }));
      },
    );
  }, [source]);

  return state;
}
