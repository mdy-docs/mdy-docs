import mermaid from 'mermaid';

/*
 * A mermaid diagram from its source — a DOM node, drawn once per
 * (source, theme) and remembered, so that re-setting the pane's HTML on
 * the next keystroke costs a lookup rather than a layout.
 *
 * Not a component: the pane is an HTML string (Preview.jsx), so diagrams
 * are found in it after the fact, which is what the JavaScript demo's
 * React port did away with. Here the trade goes the other way — the
 * engine writes the page, and a diagram is a repair to it — and the cache
 * is what keeps that repair from being paid for twice.
 */
const drawn = new Map();
let serial = 0;

export async function drawMermaid(code, theme) {
  const key = `${theme} ${code}`;
  if (!drawn.has(key)) {
    drawn.set(
      key,
      (async () => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
        });
        try {
          const { svg } = await mermaid.render(`mermaid-${++serial}`, code);
          return svg;
        } catch (err) {
          return { error: err?.message ?? 'Unable to render Mermaid chart.' };
        }
      })(),
    );
  }
  const result = await drawn.get(key);
  if (typeof result === 'string') {
    const div = document.createElement('div');
    div.className = 'mermaid';
    div.innerHTML = result;
    return div;
  }
  const pre = document.createElement('pre');
  pre.className = 'mermaid mermaid-error';
  pre.textContent = `Mermaid render error: ${result.error}`;
  return pre;
}
