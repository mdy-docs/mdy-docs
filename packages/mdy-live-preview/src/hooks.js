import { useCallback, useEffect, useRef, useState } from 'react';

const PREFIX = 'mdy-live-preview.';

// Same keys as the pre-React app, so a returning user keeps their document,
// their theme and their scroll-sync setting.
export const storage = {
  get(key) {
    try {
      return localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, value);
    } catch {
      // Private browsing, quota, a blocked origin — none of it is worth
      // interrupting the editor over.
    }
  },
};

/** State that writes through to localStorage. */
export function useStored(key, initial, { encode = String, decode = (v) => v } = {}) {
  const [value, setValue] = useState(() => {
    const stored = storage.get(key);
    return stored === null ? initial : decode(stored);
  });

  const update = useCallback(
    (next) => {
      setValue(next);
      storage.set(key, encode(next));
    },
    [key, encode],
  );

  return [value, update];
}

/**
 * Trail `value` by `delay`, so a fast typist does not queue one full VM render
 * per keystroke. React's reconciliation makes each render cheaper than the old
 * innerHTML swap, but the template still has to run — the debounce is about
 * the engine, not the DOM.
 */
export function useDebounced(value, delay) {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}

/** A value that reverts to its default after `delay` — "Copied!" and the like. */
export function useTemporary(initial, delay) {
  const [value, setValue] = useState(initial);
  const timer = useRef(null);

  const flash = useCallback(
    (next) => {
      setValue(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setValue(initial), delay);
    },
    [initial, delay],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return [value, flash];
}
