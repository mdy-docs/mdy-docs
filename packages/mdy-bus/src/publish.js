/*
 * The CLI's sukkal adapter — the half of $.publish that mdy itself
 * refuses to hold.
 *
 * src/publish.js collects messages and hands them back; nothing in src/
 * knows what a broker is, and that is a design decision rather than an
 * omission (see docs/messaging-plan.md, and src/serve.js on this package
 * being bundled for the browser). Sending belongs to whoever called the
 * build. For `mdy build --publish`, that is this file.
 *
 * The wire format is binjson, encoded with the codec mdy already depends
 * on through nisaba (@mdy-docs/nisaba-db/wasm exports `encode`) — the
 * same value model the document store itself uses, so a message and a
 * database record are the same kind of thing. No broker client library is
 * involved: a publish is one POST, and `fetch` can do a POST.
 *
 * Imported lazily by bin/mdy.js, only when --publish is actually passed,
 * so a plain `mdy build` never loads nisaba's wasm to decide it had
 * nothing to send.
 */

/**
 * Publish every collected message to a sukkal broker, in call order,
 * stopping at the first failure.
 *
 * In order, and not in parallel, on purpose: a document that publishes
 * two messages is usually describing a sequence, and sukkal assigns each
 * subject's index from its own entry log as it accepts them. Racing them
 * would make the order they land in depend on the network.
 *
 * @param {Array<{ name: string, data: any }>} messages from buildSite
 * @param {{ url?: string, onSend?: (info: object) => void }} [options]
 * @returns {Promise<{ sent: number }>}
 */
export async function publishMessages(messages, options = {}) {
  if (messages.length === 0) return { sent: 0 };

  const url = (options.url ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const { ready, encode } = await import('@mdy-docs/nisaba-db/wasm');
  await ready();

  let sent = 0;
  for (const message of messages) {
    const body = encode(message.data);
    let response;
    try {
      response = await fetch(`${url}/pub/${message.name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/binjson' },
        body,
      });
    } catch (cause) {
      // A broker that isn't running is the overwhelmingly common case
      // here, and "fetch failed" on its own does not say which broker.
      throw new Error(`publish: cannot reach the sukkal broker at ${url} (${cause.message ?? cause})`);
    }
    if (!response.ok) {
      // sukkal answers errors as text/plain precisely so this is readable.
      const detail = (await response.text().catch(() => '')).trim();
      throw new Error(`publish: ${message.name} refused with ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    sent++;
    options.onSend?.({ name: message.name, bytes: body.length });
  }
  return { sent };
}
