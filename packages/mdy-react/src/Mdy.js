import { useEffect } from 'react';
import { useMdy } from './hooks.js';

/**
 * `<Mdy source={…} />` — an mdy document as a React subtree.
 *
 * The element it returns is the document itself, unwrapped: no container div,
 * so your own layout and CSS decide the box. Because it is a real element
 * tree rather than an HTML string, React reconciles it — editing one word of
 * a long document patches one text node instead of tearing down and rebuilding
 * the pane, which is what keeps scroll position, focus and any component state
 * inside the output (an open `<details>`, a rendered diagram) alive across
 * edits.
 *
 * Props are useMdy's options, plus:
 *
 * @param {import('react').ReactNode} [props.fallback] shown until the first
 *   render resolves (default: nothing)
 * @param {(error: Error) => import('react').ReactNode} [props.errorFallback]
 *   shown when the *first* render fails, i.e. when there is no good output to
 *   keep showing. Later failures leave the last good output in place and are
 *   reported through `onError` only — see useMdy.
 * @param {(error: Error) => void} [props.onError] called on every failed
 *   render; the place to put your error bar, which is the honest way to
 *   surface a template error without destroying the preview underneath it
 */
export function Mdy({ source, fallback = null, errorFallback, onError, ...options }) {
  const { element, error, pending } = useMdy(source, options);

  useEffect(() => {
    if (error && onError) onError(error);
  }, [error, onError]);

  if (element) return element;
  if (error) return errorFallback ? errorFallback(error) : null;
  return pending ? fallback : null;
}
