import { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { drawMermaid } from './Mermaid.jsx';

/**
 * The rendered document set, as the C engine wrote it.
 *
 * The JavaScript demo's pane is a React subtree — a hast tree from its own
 * processor, reconciled on each edit. The C engine writes HTML, the same
 * HTML `mdy --html` writes to a file, so this pane is that string set as
 * the pane's content: the honest shape of the bridge, and the reason this
 * file is short.
 *
 * Two things follow. Anyone can type anything into the pane on the left,
 * so the string is sanitized before it is parsed — DOMPurify, where the
 * JavaScript demo sanitized the tree. And a mermaid fence is
 * `<pre><code class="language-mermaid">` in the HTML, as it is in the
 * file, so after each render the pane looks for those and draws them —
 * with the drawings cached by their source, so an edit elsewhere on the
 * page does not redraw a diagram that did not change.
 *
 * The error is the app's to place: it keeps the last good HTML underneath
 * an error bar rather than replacing the document with a stack trace.
 */
export function Preview({ html, theme }) {
  const host = useRef(null);

  useEffect(() => {
    const pane = host.current;
    if (!pane) return;
    pane.innerHTML = DOMPurify.sanitize(html);
    let live = true;
    for (const code of pane.querySelectorAll('pre > code.language-mermaid')) {
      const pre = code.parentElement;
      drawMermaid(code.textContent, theme).then((node) => {
        if (live && pre.isConnected) pre.replaceWith(node);
      });
    }
    return () => {
      live = false;
    };
  }, [html, theme]);

  return <div ref={host} />;
}
