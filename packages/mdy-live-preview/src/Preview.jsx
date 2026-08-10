import { useEffect, useMemo } from 'react';
import { useMdy } from '@mdy-docs/react';
import { Mermaid } from './Mermaid.jsx';

// All the text inside a hast node, for handing a fence's body to a component.
const textOf = (node) =>
  node.type === 'text' ? node.value : (node.children ?? []).map(textOf).join('');

const isMermaidFence = (node) =>
  node?.tagName === 'code' && [].concat(node.properties?.className ?? []).includes('language-mermaid');

/**
 * The rendered document set.
 *
 * The old version of this was `outputElement.innerHTML = DOMPurify.sanitize(html)`
 * followed by two repair passes over the DOM it had just built. Now the
 * document is a React subtree, so:
 *
 *   - **Editing patches, it does not rebuild.** One changed word updates one
 *     text node; scroll position, focus and diagram state all survive.
 *   - **A mermaid fence *is* a component.** No post-hoc rewrite of
 *     `pre > code.language-mermaid`, no debounced sweep, no version counter.
 *   - **A broken keystroke does not blank the pane.** The last good render
 *     stays up and the error is reported upward, to a bar above readable
 *     output rather than in place of it.
 *
 * `useMdy` rather than `<Mdy>` precisely because of that last point: this app
 * wants to place the error and staleness UI itself, which means it wants the
 * state, not a component's own rendering of it.
 */
export function Preview({ source, theme, onStatus }) {
  const mermaidTheme = theme === 'dark' ? 'dark' : 'default';

  // Memoized because the identity of `components` is what decides whether the
  // processor is rebuilt: it should change when the mermaid theme does, and
  // never for any other reason.
  const components = useMemo(
    () => ({
      // Overriding `pre` rather than `code` so the diagram replaces the whole
      // block, `<pre>` wrapper and all. `node` is the hast node — this is what
      // it is for.
      pre({ node, children, ...props }) {
        const fence = node.children?.[0];
        if (isMermaidFence(fence)) {
          return <Mermaid code={textOf(fence)} theme={mermaidTheme} />;
        }
        return <pre {...props}>{children}</pre>;
      },
    }),
    [mermaidTheme],
  );

  const { element, error, pending } = useMdy(source, {
    components,
    // Anyone can type anything into the pane on the left, which is exactly the
    // case that needs a schema. This replaces the DOMPurify pass, one stage
    // earlier: the tree is sanitized before it becomes elements, rather than
    // the HTML string being re-parsed to be cleaned and parsed again to be
    // shown.
    sanitize: true,
  });

  useEffect(() => {
    onStatus({ error, pending });
  }, [error, pending, onStatus]);

  // Only when the very first render fails is there nothing better to show.
  if (!element && error) return <pre className="mdy-error-block">{error.message}</pre>;
  return element;
}
