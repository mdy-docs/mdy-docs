import { useEffect, useState } from 'react';
import { runMessages, usesMessaging } from './messaging.js';

/*
 * What the document sent, and what it caused.
 *
 * Only present when the source actually publishes — a document that never
 * calls $.publish never opens a broker, and the pane stays out of the way.
 */
const LABEL = {
  send: 'send',
  deliver: 'deliver',
  refuse: 'refuse',
  undeliverable: 'return',
  error: 'error',
};

export function Messages({ source }) {
  const [state, setState] = useState({ log: [], error: null, running: false });
  const active = usesMessaging(source);

  useEffect(() => {
    if (!active) {
      setState({ log: [], error: null, running: false });
      return;
    }
    let live = true;
    setState((prev) => ({ ...prev, running: true }));

    // Debounced: a broker round trip per keystroke would be noise, and the
    // interesting state is where the typing lands.
    const timer = setTimeout(() => {
      runMessages(source).then(
        (result) => live && setState({ ...result, running: false }),
        (error) => live && setState({ log: [], error: String(error.message ?? error), running: false }),
      );
    }, 300);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, active]);

  if (!active) return null;

  return (
    <section className="mdy-messages" aria-label="Messages">
      <header>
        <strong>messages</strong>
        <span className="mdy-messages-note">
          a sukkal broker in this tab — no server, no socket
        </span>
        {state.running && <span className="mdy-messages-run">running…</span>}
      </header>

      {state.error && <pre className="mdy-error-block">{state.error}</pre>}

      {!state.error && state.log.length === 0 && !state.running && (
        <p className="mdy-messages-empty">Nothing published yet.</p>
      )}

      <ol>
        {state.log.map((e, i) => (
          <li key={i} className={`mdy-msg mdy-msg-${e.kind}`}>
            <code className="mdy-msg-kind">[{LABEL[e.kind] ?? e.kind}]</code>{' '}
            <code className="mdy-msg-name">{e.name}</code>
            {e.index !== undefined && <span className="mdy-msg-index"> #{e.index}</span>}
            {e.page ? <span className="mdy-msg-page"> → {e.page}</span> : null}
            {e.detail && <span className="mdy-msg-detail"> — {e.detail}</span>}
            {e.output && <pre className="mdy-msg-output">{e.output}</pre>}
          </li>
        ))}
      </ol>
    </section>
  );
}
