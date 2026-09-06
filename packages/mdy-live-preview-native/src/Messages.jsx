/*
 * What the document sent, and what it caused — the engine's `--publish`
 * log, parsed by its wrapper: a send with the index it landed at, a
 * delivery with the output of the page that rendered it, a refusal with
 * the error the page threw and where the message went, a dead letter
 * rendered by its `.dead` page.
 *
 * Only present when the source actually publishes. The engine's broker is
 * sukkal, the same C a native `sukkal serve` answers from, linked into the
 * module over a directory in memory — so a message here has exactly the
 * lifetime of one render, which is what a preview should promise.
 */
import DOMPurify from 'dompurify';

const LABEL = { send: 'send', deliver: 'deliver', refuse: 'refuse', dead: 'dead' };

export function Messages({ active, messages, running, error }) {
  if (!active) return null;

  return (
    <section className="mdy-messages" aria-label="Messages">
      <header>
        <strong>messages</strong>
        <span className="mdy-messages-note">a sukkal broker inside the engine — no server, no socket</span>
        {running && <span className="mdy-messages-run">running…</span>}
      </header>

      {error && <pre className="mdy-error-block">{error}</pre>}

      {!error && messages.length === 0 && !running && (
        <p className="mdy-messages-empty">Nothing published yet.</p>
      )}

      <ol>
        {messages.map((m, i) => (
          <li key={i} className={`mdy-msg mdy-msg-${m.kind}`}>
            <code className="mdy-msg-kind">[{LABEL[m.kind] ?? m.kind}]</code>{' '}
            <code className="mdy-msg-name">{m.name}</code>
            <span className="mdy-msg-index"> #{m.index}</span>
            {m.page ? <span className="mdy-msg-page"> → {m.page}</span> : null}
            {m.published ? <span className="mdy-msg-detail"> (published {m.published})</span> : null}
            {m.detail && <span className="mdy-msg-detail"> — {m.detail}</span>}
            {m.error && (
              <pre className="mdy-msg-output mdy-msg-error">
                {m.error}
                {m.verdict ? `\n${m.verdict}` : ''}
              </pre>
            )}
            {m.output && (
              <div
                className="mdy-msg-output markdown-body"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(m.output) }}
              />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
