/*
 * The delivery runtime. Pages as endpoints.
 *
 * Driven by `mdy dev`, which runs it alongside the dev server so that
 * publishing, delivering and editing are one process (there is no separate
 * `mdy bus` command — serve already built the set and already rebuilds it
 * on save, which is most of what this needs). An embedder can drive it
 * directly: `runBus(site, options)`.
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
 * page. sukkal keys receipts `<subject>/<consumer>`, so a pattern
 * registration is already "N ordinary subscriptions discovered by pattern
 * instead of by name": each page gets its own receipt, its own lag and its
 * own retry, and the broker walks its matches round-robin so no page
 * starves behind a busy one.
 *
 * That registration names a queue GROUP, which is what makes a message
 * that cannot be rendered survivable. A plain push subscription retries a
 * failing callback forever — deliberately, since giving up would decide on
 * the subscriber's behalf that its messages no longer matter — and has
 * nowhere to put one it can never deliver. A group has attempts, doubling
 * backoff, and `<name>.dead`. The cost is ordering: jobs finish
 * independently, so messages for one page are no longer strictly ordered
 * against each other. For "render the page this names" that is the better
 * trade — the alternative is one unrenderable message standing in front of
 * every later one, forever.
 *
 * A dead-letter channel is delivered like anything else, and needs no new
 * concept: `<name>.dead` is a name, so a page called `<name>.dead` handles
 * it. handlers/invoice.dead.mdy is where messages that died on
 * handlers/invoice.mdy arrive. With no such page they are reported and
 * finished, and stay in the log for `mdy dead` to read.
 *
 * Lives outside mdy-docs for the reason its src/publish.js gives: core
 * resolves a name and hands the message to `onPublish`, and a broker
 * client cannot live in a package that is bundled for the browser.
 */
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';

import { publishMessages } from './publish.js';

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

/** A page whose name ends in this is a dead-letter handler. */
const DEAD_SUFFIX = '.dead';

/**
 * The message-handling core, with no HTTP and no broker in it: given a
 * batch for one subject, render the page it is addressed to once per
 * message and report which ones succeeded.
 *
 * Jobs are acknowledged INDIVIDUALLY — `{ done, failed }`, not a
 * high-water mark. That is the difference queue-group delivery makes: a
 * message that fails is returned on its own, retried on its own backoff,
 * and dead-lettered on its own, instead of standing in front of every
 * later message for its page.
 *
 * @param {{ site: object, flush: (messages: object[]) => Promise<void>, now?: () => number, onEvent?: Function }} deps
 */
export function createDeliveryHandler({ site, flush, now = () => Date.now(), onEvent }) {
  // `site` may be a function, for a host that rebuilds while running:
  // `mdy dev` replaces the whole document set on every save, and a
  // delivery has to render against the CURRENT one or editing a page would
  // not change what the next message does. Read once per delivery, not per
  // message — a batch that started against one build finishes against it,
  // rather than rendering half against each.
  const current = typeof site === 'function' ? site : () => site;

  return async function deliver(subject, batch) {
    const { set, pages, messages } = current();
    const targets = pages.get(subject) ?? [];

    if (targets.length !== 1) {
      // A dead-letter channel with no page to handle it is not a failure:
      // `<name>.dead` is where sukkal republishes what this bus already
      // gave up on, and returning those would loop. They are reported and
      // finished; the entries stay in the log for `mdy dead` to read.
      if (subject.endsWith(DEAD_SUFFIX)) {
        for (const message of batch) {
          onEvent?.({ type: 'dead', subject, index: message.index, data: message.value, handled: false });
        }
        return { done: batch.map((m) => m.index), failed: [] };
      }
      // Anything else addressed to a page this set does not have — or has
      // twice — is RETURNED, not discarded. Phase 1 acked and dropped it,
      // because refusing a push subscription meant redelivering forever;
      // a queue group has somewhere for it to go, so the message is
      // preserved and ends up in `<name>.dead` where it can be looked at
      // and requeued. Silent discard was the weaker half of that design.
      const why = targets.length === 0 ? 'no page of that name here' : `${targets.length} pages share that name`;
      onEvent?.({ type: 'undeliverable', subject, count: batch.length, why });
      return { done: [], failed: batch.map((m) => m.index) };
    }
    const target = targets[0];
    const isDeadHandler = subject.endsWith(DEAD_SUFFIX);

    const done = [];
    const failed = [];
    for (const message of batch) {
      // The message's data IS `req`, exactly as $.render(name, data)
      // binds it — the two are the same call in different tenses, so a
      // page cannot tell which one reached it. `msg` is the one reserved
      // key: the delivery envelope, which a page needs to dedupe or to
      // notice it is being retried.
      const data = message.value !== null && typeof message.value === 'object' && !Array.isArray(message.value)
        ? message.value
        : { value: message.value };
      const attempts = message.attempts ?? 1;
      const req = { ...data, msg: { name: subject, index: message.index, attempts } };

      const started = now();
      try {
        await set.renderResult(target.index, req);
      } catch (error) {
        // Returned, so it comes back on its own backoff and dead-letters
        // once it runs out of attempts. Pages reached this way have to be
        // idempotent: one that emitted or published before it threw will
        // do so again on the retry.
        failed.push(message.index);
        onEvent?.({
          type: 'failed',
          subject, index: message.index, attempts, error,
          path: target.data?.path,
          ms: now() - started,
        });
        continue;
      }

      // Whatever the page published while rendering, flushed only now
      // that its render has succeeded — the same deferral $.publish has
      // during a build (mdy-docs' src/publish.js), one message deep
      // instead of one build deep.
      const produced = messages.splice(0);
      if (produced.length > 0) await flush(produced);

      done.push(message.index);
      onEvent?.({
        type: isDeadHandler ? 'dead' : 'delivered',
        subject, index: message.index, attempts,
        path: target.data?.path,
        ms: now() - started,
        published: produced.length,
        ...(isDeadHandler ? { handled: true } : {}),
      });
    }
    return { done, failed };
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
 * publish.js can use fetch quite safely for the same broker, because a
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
 *   site              an OPEN document set — mdy-docs' `openScriptSite`
 *                     return value (or `renderScriptSite`'s, which carries
 *                     the same fields), swappable later via `setSite`
 *                     return value, or anything with the same three
 *                     fields: `set.renderResult(index, data)`,
 *                     `pages` (Map<name, doc[]>), and the `messages`
 *                     array $.publish appends to. Passed in rather than
 *                     built here: this package is a transport over
 *                     something that renders pages by name, and does not
 *                     need to know what a site directory is.
 *   options.broker    broker URL (default http://127.0.0.1:8080)
 *   options.group     queue group (default 'mdy'). Delivery is a queue
 *                     group rather than a plain subscription because that
 *                     is where sukkal keeps attempts, backoff and the
 *                     dead-letter channel: a plain push subscription
 *                     retries a failing callback forever and has nowhere
 *                     to put a message it can never deliver. It also means
 *                     several buses on one group share the work.
 *   options.maxAttempts / options.backoffMs / options.maxBackoffMs
 *                     the retry policy, applied per page name the first
 *                     time a message for it arrives
 *   options.port      port to receive deliveries on (default 0 — any free one)
 *   options.consumer  durable consumer name (default 'mdy-bus'). Naming it
 *                     is what makes the subscription survive a restart:
 *                     the broker keeps the receipt, so rejoining delivers
 *                     only what was missed.
 *   options.onEvent   every delivery, failure and registration, for logging
 *
 * Returns `{ url, consumer, pages, close }`.
 */
export async function runBus(site, options = {}) {
  const broker = (options.broker ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const consumer = options.consumer ?? 'mdy-bus';
  const group = options.group ?? 'mdy';
  const policy = {
    max_attempts: options.maxAttempts ?? 5,
    backoff_ms: options.backoffMs ?? 1000,
    max_backoff_ms: options.maxBackoffMs ?? 300000,
  };
  const onEvent = options.onEvent;
  const token = randomBytes(16).toString('hex');

  const { ready, decode } = await import('@mdy-docs/nisaba-db/wasm');
  await ready();

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

  // The retry policy is set per subject, and a subject only exists once
  // something has been published to it — so it is applied on the first
  // delivery for a name rather than at startup, where most of it would be
  // 404s for pages nobody ever writes to. The first delivery is attempt 1,
  // so this is always in place before any attempt can be spent.
  const policied = new Set();
  const applyPolicy = async (subject) => {
    if (policied.has(subject)) return;
    policied.add(subject);
    const query = new URLSearchParams({ group, ...Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, String(v)])) });
    try {
      const { status, text } = await brokerRequest(broker, 'PUT', `/queue/${subject}?${query}`);
      if (status < 200 || status >= 300) onEvent?.({ type: 'error', error: new Error(`policy for ${subject}: ${status} ${text}`) });
    } catch (error) {
      policied.delete(subject);
      onEvent?.({ type: 'error', error });
    }
  };

  // The site is held in a box rather than captured, so a caller that
  // rebuilds — `mdy dev` — can swap it without tearing down the
  // registration and losing its place in the broker's queue.
  let currentSite = site;
  const deliver = createDeliveryHandler({
    site: () => currentSite,
    flush: (produced) => publishMessages(produced, { url: broker }),
    onEvent,
  });

  const pageCount = () => currentSite.pages.size;

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

    await applyPolicy(subject);
    const { done, failed } = await serialize(() => deliver(subject, batch));

    // A job batch is acknowledged by naming what finished: jobs complete
    // independently, so a high-water mark cannot say which. The broker
    // returns whatever the list omits, and a delivery where nothing
    // succeeded is a 500, which returns all of them.
    if (done.length === 0) return reply(500);
    if (failed.length > 0) return reply(200, { 'X-Sukkal-Done': done.join(',') });
    reply(200);
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port ?? 0, resolve);
  });
  const port = server.address().port;
  const host = await localAddressFor(broker);
  const callback = `http://${host.includes(':') ? `[${host}]` : host}:${port}/mdy/${consumer}`;

  const register = async () => {
    const query = new URLSearchParams({ consumer, callback, token, group });
    const { status, text } = await brokerRequest(broker, 'PUT', `/push/>?${query}`);
    if (status < 200 || status >= 300) {
      throw new Error(`bus: the broker refused the registration (${status}${text ? ` — ${text}` : ''})`);
    }
  };

  await register();
  onEvent?.({ type: 'registered', callback, consumer, group, broker, policy, pages: pageCount() });

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

  return {
    url: callback,
    consumer,
    group,
    broker,
    get pages() { return currentSite.pages; },
    /** Deliver against a newly built set from here on. In-flight
     * deliveries finish against the one they started with. */
    setSite: (next) => { currentSite = next; },
    close,
  };
}

export { MEDIA_TYPE };


/* ---- the same runtime, in one process ---------------------------------- */

/**
 * Run the bus against an in-process broker: no socket, no registration, no
 * callback server, no token, no heartbeat.
 *
 * The delivery handler is the same one the HTTP path uses — it takes a
 * subject and a batch and says which messages were rendered — so a page
 * cannot tell which way it was reached. What changes is only how a batch
 * arrives: claimed from the broker rather than pushed to a URL.
 *
 * `drain` repeats until a pass yields nothing, because a delivered page
 * may publish onward and that message is due in this same tick. The chain
 * of pages is the workflow, and a dev loop should not make you wait a
 * poll interval per link in it.
 *
 * @param {object} site     an open document set (mdy-docs' openScriptSite)
 * @param {object} broker   from openInProcessBroker()
 */
export async function runLocalBus(site, broker, options = {}) {
  const onEvent = options.onEvent;
  const policy = {
    maxAttempts: options.maxAttempts ?? 5,
    backoffMs: options.backoffMs ?? 1000,
    maxBackoffMs: options.maxBackoffMs ?? 300000,
  };

  let currentSite = site;
  const policied = new Set();

  const flush = async (produced) => {
    for (const m of produced) {
      const { index, bytes } = await broker.publish(m.name, m.data);
      onEvent?.({ type: 'sent', name: m.name, index, bytes });
    }
  };

  const deliver = createDeliveryHandler({ site: () => currentSite, flush, onEvent });

  /* One pass over every subject that has work. Returns how many messages
   * were handled, so the caller knows whether to go round again. */
  const pass = async () => {
    let handled = 0;
    for (const subject of await broker.subjects()) {
      if (!policied.has(subject)) {
        policied.add(subject);
        await broker.setPolicy(subject, policy);
      }
      const jobs = await broker.take(subject);
      if (jobs.length === 0) continue;

      const { done, failed } = await deliver(subject, jobs);
      for (const index of done) await broker.done(subject, index);
      for (const index of failed) await broker.fail(subject, index);
      handled += jobs.length;
    }
    return handled;
  };

  const drain = async () => {
    /* Bounded, so a page that publishes to itself cannot spin this loop
     * forever inside one tick — it simply continues on the next. */
    for (let round = 0; round < 32; round++) {
      if (await pass() === 0) return;
    }
    onEvent?.({ type: 'error', error: new Error('bus: still draining after 32 rounds; continuing next tick') });
  };

  onEvent?.({ type: 'registered', broker: 'in-process', pages: site.pages.size, policy: { max_attempts: policy.maxAttempts } });

  return {
    setSite: (next) => { currentSite = next; },
    drain,
    close: () => broker.close(),
  };
}
