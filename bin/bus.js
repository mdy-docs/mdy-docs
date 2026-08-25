/*
 * `mdy bus` — the delivery runtime. Pages as endpoints.
 *
 * A document set, an HTTP server, and one registration with a sukkal
 * broker. Per delivered message: resolve its subject to the page of that
 * name, render the page with the message bound as `req`, and answer the
 * broker's POST — which IS the acknowledgement, so a render that throws
 * is a message that is not acked and comes back.
 *
 * There is no subscribe step and nothing to configure per page. A message
 * addressed to `handlers.invoice` renders handlers/invoice.mdy because
 * that file exists and no other document derives that name; the front
 * matter says nothing about messaging. See docs/messaging-plan.md.
 *
 * ONE registration covers every page — `PUT /push/>` — rather than one per
 * page, and this turned out to be strictly better than the lazy per-name
 * consumers the plan proposed. sukkal keys receipts `<subject>/<consumer>`,
 * so a pattern subscription is already "N ordinary subscriptions
 * discovered by pattern instead of by name": each page gets its own
 * receipt, its own lag, and its own retry, and the broker walks its
 * matches round-robin so no page starves behind a busy one. The extra
 * machinery would have bought nothing.
 *
 * Lives in bin/ rather than src/ for the reason src/publish.js gives:
 * this package is bundled for the browser, and the transport does not
 * belong in it. Phase 2 moves this to packages/mdy-bus.
 */
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';

import { openScriptSite } from '../src/script-site.js';
import { publishMessages } from './sukkal.js';

const MEDIA_TYPE = 'application/binjson';

/* The entry log's type byte. A PLAIN payload is the message as published;
 * an ENVELOPE payload is [headers, message]. */
const ENTRY_ENVELOPE = 0x10;

/* How often the registration is re-asserted. Not a poll — it carries no
 * cursor and asks for nothing, it only re-states where to deliver. What
 * it buys is the thing Phase 1 has to prove: a broker that restarted with
 * a rebuilt store has no record of this subscription, and from here
 * silence is indistinguishable from "nothing to send". */
const HEARTBEAT_MS = 30000;

/**
 * Decode one delivery body: the entry log's own batch encoding, forwarded
 * by the broker without re-encoding — an ARRAY of
 * `{ index, term, type, payload }` where `payload` is the published bytes.
 * So it decodes in two steps, and the second gives back exactly what the
 * publisher passed.
 *
 * @param {Uint8Array} body
 * @param {(bytes: Uint8Array) => any} decode
 */
export function parseDelivery(body, decode) {
  const entries = decode(body);
  if (!Array.isArray(entries)) throw new Error('delivery body is not a batch');
  return entries.map((entry) => {
    const payload = entry.payload instanceof Uint8Array ? entry.payload : new Uint8Array(entry.payload);
    const decoded = decode(payload);
    const enveloped = entry.type === ENTRY_ENVELOPE && Array.isArray(decoded) && decoded.length === 2;
    return {
      index: Number(entry.index),
      value: enveloped ? decoded[1] : decoded,
      headers: enveloped ? (decoded[0] ?? null) : null,
      ...(entry.attempts !== undefined ? { attempts: Number(entry.attempts) } : {}),
    };
  });
}

/**
 * The message-handling core, with no HTTP and no broker in it: given a
 * batch for one subject, render the page it is addressed to once per
 * message and report how far it got.
 *
 * Messages are rendered in order and one at a time. That is the order
 * they were published in and the only thing a receipt can express — a
 * receipt is a high-water mark, so "message 3 succeeded but 2 did not"
 * is not a state the broker can be told about.
 *
 * Returns `{ took, error }`. `took` is the index acked up to, which is 0
 * when the first message failed — the broker reads that as "not now" and
 * retries with a backoff rather than immediately.
 *
 * @param {{ site: object, flush: (messages: object[]) => Promise<void>, onEvent?: Function }} deps
 */
export function createDeliveryHandler({ site, flush, onEvent }) {
  const { set, pages, messages } = site;

  return async function deliver(subject, batch) {
    const targets = pages.get(subject) ?? [];
    if (targets.length !== 1) {
      // Undeliverable, and permanently so: refusing would make the broker
      // redeliver forever. Acking the batch lets it move on and lets the
      // message be seen for what it is — a publisher addressing a page
      // that this set does not have, or has twice.
      const why = targets.length === 0 ? 'no page of that name here' : `${targets.length} pages share that name`;
      onEvent?.({ type: 'undeliverable', subject, count: batch.length, why });
      return { took: batch.at(-1)?.index ?? 0, error: null };
    }
    const target = targets[0];

    let took = 0;
    for (const message of batch) {
      // The message's data IS `req`, exactly as $.render(name, data)
      // binds it — the two are the same call in different tenses, so a
      // page cannot tell which one reached it. `msg` is the one reserved
      // key: the delivery envelope, which a page needs to dedupe or to
      // notice it is being retried.
      const data = message.value !== null && typeof message.value === 'object' && !Array.isArray(message.value)
        ? message.value
        : { value: message.value };
      const req = { ...data, msg: { name: subject, index: message.index, attempts: message.attempts ?? 1 } };

      try {
        await set.renderResult(target.index, req);
      } catch (error) {
        // Not acked, so it comes back. Pages reached this way have to be
        // idempotent; a page that emitted or published before it threw
        // will do so again on the retry.
        onEvent?.({ type: 'failed', subject, index: message.index, error });
        return { took, error };
      }

      // Whatever the page published while rendering, flushed only now
      // that its render has succeeded — the same deferral $.publish has
      // during a build (src/publish.js), one message deep instead of one
      // build deep.
      const produced = messages.splice(0);
      if (produced.length > 0) await flush(produced);

      took = message.index;
      onEvent?.({ type: 'delivered', subject, index: message.index, published: produced.length });
    }
    return { took, error: null };
  };
}

/*
 * One request to the broker, with the path built BY HAND rather than
 * through URL/fetch.
 *
 * fetch percent-encodes a path, and the broker matches it raw: the
 * catch-all registration `PUT /push/>` arrives as `/push/%3E` and is
 * rejected as a bad pattern. (sukkal's own client carries the same note,
 * and its README records both its Node and Python clients hitting this.)
 * Only the query is escaped, which the broker does decode.
 *
 * bin/sukkal.js can use fetch quite safely for the same broker, because a
 * publish addresses a NAME and every character a name may contain is
 * URL-safe. Only patterns have this problem.
 */
function brokerRequest(brokerUrl, method, path) {
  const { protocol, hostname, port, pathname } = new URL(brokerUrl);
  if (protocol !== 'http:') {
    throw new Error(`bus: only http:// brokers are supported (got ${protocol}//)`);
  }
  const prefix = pathname.replace(/\/$/, '');
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: hostname, port: Number(port) || 80, method, path: prefix + path },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString().trim() }));
      }
    );
    req.on('error', () => reject(new Error(`bus: cannot reach the sukkal broker at ${brokerUrl}`)));
    req.end();
  });
}

/** Read a request body into one Uint8Array. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

/**
 * Which of this host's addresses reaches the broker — what the callback
 * URL has to advertise. Asked by opening a socket to the broker and
 * reading the local end, rather than guessed, so this works unconfigured
 * on one machine and on a real network alike.
 */
function localAddressFor(brokerUrl) {
  const { hostname, port } = new URL(brokerUrl);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) || 80 }, () => {
      const address = socket.localAddress;
      socket.destroy();
      resolve(address);
    });
    socket.on('error', () => reject(new Error(`bus: cannot reach the sukkal broker at ${brokerUrl}`)));
  });
}

/**
 * Run the bus until stopped.
 *
 *   root              the site directory
 *   options.broker    broker URL (default http://127.0.0.1:8080)
 *   options.port      port to receive deliveries on (default 0 — any free one)
 *   options.consumer  durable consumer name (default 'mdy-bus'). Naming it
 *                     is what makes the subscription survive a restart:
 *                     the broker keeps the receipt, so rejoining delivers
 *                     only what was missed.
 *   options.onEvent   every delivery, failure and registration, for logging
 *
 * Returns `{ url, consumer, pages, close }`.
 */
export async function runBus(root, options = {}) {
  const broker = (options.broker ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const consumer = options.consumer ?? 'mdy-bus';
  const onEvent = options.onEvent;
  const token = randomBytes(16).toString('hex');

  const { ready, encode, decode } = await import('@mdy-docs/nisaba-db/wasm');
  await ready();

  const site = await openScriptSite(root, { onSource: options.onSource });

  // Deliveries for different subjects arrive as separate concurrent POSTs
  // (the broker walks its matches round-robin), and they share one
  // document set — including the one `messages` array $.publish appends
  // to. Rendering one batch at a time keeps that array unambiguous, and
  // costs nothing worth having: the VM pool is 4 instances and a
  // suspended one cannot be re-entered anyway (src/vm.js).
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
  };

  const deliver = createDeliveryHandler({
    site,
    flush: (produced) => publishMessages(produced, { url: broker }),
    onEvent,
  });

  const server = createServer(async (req, res) => {
    const reply = (status, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/plain', ...headers });
      res.end('');
    };
    if (req.method !== 'POST' || req.url !== `/mdy/${consumer}`) return reply(404);
    // The token proves the POST came from the broker we registered with:
    // anything that can reach this port can connect to it, and a runtime
    // that rendered whatever arrived would take messages from anywhere.
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401);

    let batch;
    const subject = req.headers['x-sukkal-subject'];
    try {
      batch = parseDelivery(await readBody(req), decode);
    } catch {
      return reply(400);
    }
    if (typeof subject !== 'string' || batch.length === 0) return reply(400);

    const { took } = await serialize(() => deliver(subject, batch));
    reply(200, { 'X-Sukkal-Ack': String(took) });
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port ?? 0, resolve);
  });
  const port = server.address().port;
  const host = await localAddressFor(broker);
  const callback = `http://${host.includes(':') ? `[${host}]` : host}:${port}/mdy/${consumer}`;

  const register = async () => {
    const query = new URLSearchParams({ consumer, callback, token });
    const { status, text } = await brokerRequest(broker, 'PUT', `/push/>?${query}`);
    if (status < 200 || status >= 300) {
      throw new Error(`bus: the broker refused the registration (${status}${text ? ` — ${text}` : ''})`);
    }
  };

  await register();
  onEvent?.({ type: 'registered', callback, consumer, broker });

  // Re-assert periodically. A broker that was restarted onto a rebuilt
  // store has no record of this subscription, and from this side that is
  // indistinguishable from having nothing to send.
  const heartbeat = setInterval(() => {
    register().catch((error) => onEvent?.({ type: 'error', error }));
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  const close = async () => {
    clearInterval(heartbeat);
    // The registration is left in place on purpose: a named consumer's
    // receipt is what makes a restart resume rather than replay, and the
    // broker goes on queueing while the bus is down.
    await new Promise((resolve) => {
      server.close(resolve);
      // The broker holds its delivery connection open — that is the
      // design — and close() waits for every open connection to end of
      // its own accord. Without this it waits forever.
      server.closeAllConnections?.();
    });
  };

  return { url: callback, consumer, broker, pages: site.pages, close, encode };
}

export { MEDIA_TYPE };
