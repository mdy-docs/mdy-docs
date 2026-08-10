import { useEffect, useId, useRef, useState } from 'react';
import mermaid from 'mermaid';

// A mermaid diagram that owns its own lifecycle.
//
// Before the React port this was three globals and a scheduler: a pass that
// rewrote `pre > code.language-mermaid` into `pre.mermaid` after every render,
// a debounced sweep of the whole output pane, and a `mermaidRenderVersion`
// counter to stop a slow diagram from painting over a newer one. All of it
// existed because the preview was an HTML string: the pane was destroyed and
// rebuilt on each keystroke, so every diagram in it had to be found and
// re-rendered from scratch, whether or not it had changed.
//
// As a component there is no sweep and no version counter. React keeps this
// instance alive across edits and re-runs the effect only when the diagram's
// own source or the theme actually changes — so editing the paragraph above a
// diagram no longer re-renders the diagram at all.
export function Mermaid({ code, theme }) {
  const host = useRef(null);
  const [error, setError] = useState(null);
  // Mermaid puts this in the DOM and into CSS selectors; React's own ids
  // contain characters that are not valid there.
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  useEffect(() => {
    let cancelled = false;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });

    mermaid.render(id, code).then(
      ({ svg, bindFunctions }) => {
        if (cancelled || !host.current) return;
        // The one honest innerHTML in the app: mermaid hands back an SVG
        // string, so someone has to parse it. The difference from before is
        // the blast radius — this node is React-empty and owned entirely by
        // this component, rather than being the whole preview pane.
        host.current.innerHTML = svg;
        bindFunctions?.(host.current);
        setError(null);
      },
      (renderError) => {
        if (!cancelled) setError(renderError);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [code, theme, id]);

  if (error) {
    return (
      <pre className="mermaid mermaid-error">
        Mermaid render error: {error.message ?? 'Unable to render Mermaid chart.'}
      </pre>
    );
  }

  return <div className="mermaid" ref={host} />;
}
