/*
 * dead.js — reading and replaying what could not be delivered.
 *
 * A message that runs out of attempts is republished by the broker to
 * `<name>.dead` with an envelope saying what happened to it. That channel
 * is a subject like any other, which is the whole reason this file is
 * short: there is no separate dead-letter store to model, and a bus
 * running against the same broker is delivered `<name>.dead` messages the
 * way it is delivered any others — so the *live* way to react to a death
 * is to write a page called `<name>.dead` (see bus.js).
 *
 * What is here is the other way: looking at the ones that already died,
 * after the fact, and putting one back.
 */

/**
 * The dead-letter envelopes for `name`, newest last.
 *
 * `GET /dead/<name>` answers for the CHANNEL rather than for the subject,
 * so this is `<name>`'s dead letters — not the dead letters of a subject
 * that happens to end in `.dead`.
 *
 * @param {string} broker broker URL
 * @param {string} name the page's message name
 * @param {{ from?: number, max?: number, decode?: Function }} [options]
 */
export async function deadLetters(broker, name, options = {}) {
  const url = broker.replace(/\/+$/, '');
  const decode = options.decode ?? (await loadCodec()).decode;
  const query = new URLSearchParams();
  if (options.from !== undefined) query.set('from', String(options.from));
  if (options.max !== undefined) query.set('max', String(options.max));

  const response = await fetch(`${url}/dead/${name}${query.size ? `?${query}` : ''}`);
  if (!response.ok) {
    throw new Error(`dead: ${name} — ${response.status} ${(await response.text().catch(() => '')).trim()}`);
  }
  const entries = decode(new Uint8Array(await response.arrayBuffer()));
  if (!Array.isArray(entries)) return [];

  return entries.map((entry) => {
    // The envelope carries why it died, not just what did — which is the
    // point of a dead-letter record over a copy of the message.
    const value = entry.payload === undefined ? entry : decode(toBytes(entry.payload));
    return {
      index: Number(entry.index ?? 0),
      ...(value && typeof value === 'object' ? value : { value }),
    };
  });
}

/**
 * Put one dead letter back on its original subject, where the bus will be
 * delivered it again.
 *
 * The dead-letter record stays where it is: it is republished, not moved,
 * so the history of what failed survives its own repair. The new message
 * gets a new index, because reusing the old one would misrepresent the
 * ordering of a log that has moved on since.
 *
 * @param {string} broker
 * @param {string} name
 * @param {number} index the index INTO `<name>.dead`
 */
export async function requeueDead(broker, name, index) {
  const url = broker.replace(/\/+$/, '');
  const response = await fetch(`${url}/requeue/${name}?index=${encodeURIComponent(index)}`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`requeue: ${name}#${index} — ${response.status} ${(await response.text().catch(() => '')).trim()}`);
  }
  const { decode } = await loadCodec();
  return decode(new Uint8Array(await response.arrayBuffer()));
}

const toBytes = (payload) => (payload instanceof Uint8Array ? payload : new Uint8Array(payload));

let codec;
async function loadCodec() {
  if (!codec) {
    const wasm = await import('@mdy-docs/nisaba-db/wasm');
    await wasm.ready();
    codec = wasm;
  }
  return codec;
}
