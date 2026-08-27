/*
 * inprocess.js — the broker in this process, with no socket anywhere.
 *
 * sukkal compiles to WASM (its docs/wasm-plan.md), which means the same
 * routing table `sukkal serve` answers from can be *called*. Publishing
 * becomes `POST /pub/<name>` as a function call; receiving becomes reading
 * the log the publish just appended to.
 *
 * What that retires is the point. Delivering across a process boundary
 * needed a callback URL, which needed an HTTP server, which needed to know
 * which local address reaches the broker, and a bearer token so the server
 * would only take work from it, and a heartbeat in case the broker was
 * restarted onto a store that had forgotten the registration. Every one of
 * those is transport, none of it is messaging, and in one process none of
 * it exists.
 *
 * Delivery here is a PULL rather than a push, and that is not a downgrade:
 * push exists so a subscriber does not have to poll a network, and there
 * is no network. Pulling through the queue-group routes — take, done,
 * fail — keeps everything that matters, because attempts, backoff and the
 * dead-letter channel live in the store rather than in the pusher.
 */

const CONSUMER_GROUP = 'mdy';

/* How many jobs one drain claims per subject, and how long it holds them.
 * The lease only matters if this process dies mid-render: the broker hands
 * the work to whoever asks next once it expires. */
const TAKE_MAX = 16;
const LEASE_MS = 30000;

/**
 * Open an in-process broker.
 *
 * @param {object} [options]
 * @param {string} [options.dir]  a directory to keep messages in. Omitted,
 *   the broker is in memory and forgets everything when the process ends —
 *   which is right for a dev loop and wrong for anything else, so it is
 *   the caller's choice rather than a default that hides.
 */
export async function openInProcessBroker(options = {}) {
  const sukkal = await import('@mdy-docs/sukkal-wasm');
  const { Broker } = await import('@mdy-docs/sukkal-wasm/broker');

  const provider = options.dir
    ? await sukkal.nodeStorageProvider(options.dir)
    : new sukkal.MemoryStorageProvider();

  const broker = await new Broker(provider).open();
  return new InProcess(broker, sukkal);
}

class InProcess {
  #broker;
  #codec;

  constructor(broker, codec) {
    this.#broker = broker;
    this.#codec = codec;
  }

  get durable() { return true; }

  close() { this.#broker.close(); }

  /** Publish one message. The same route, the same binjson body, no POST. */
  async publish(name, data) {
    const body = this.#codec.encode(data);
    const res = await this.#broker.request('POST', `/pub/${name}`, {
      body,
      contentType: 'application/binjson',
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`publish: ${name} refused with ${res.status}`);
    }
    return { ...this.#codec.decode(res.body), bytes: body.length };
  }

  /** Which subjects exist, so a drain knows where to look. */
  async subjects() {
    const res = await this.#broker.request('GET', '/subjects');
    if (res.status !== 200) return [];
    return this.#codec.decode(res.body);
  }

  /**
   * Claim up to TAKE_MAX jobs from one subject. Returns them decoded, each
   * with the attempt count the broker is tracking — which is what lets a
   * page notice it is being retried.
   */
  async take(subject) {
    const res = await this.#broker.request('POST', `/take/${subject}`, {
      query: `group=${CONSUMER_GROUP}&max=${TAKE_MAX}&lease=${LEASE_MS}`,
    });
    if (res.status !== 200) return [];
    const jobs = this.#codec.decode(res.body);
    if (!Array.isArray(jobs)) return [];
    return jobs.map((j) => ({
      index: Number(j.index),
      attempts: Number(j.attempts ?? 1),
      value: this.#codec.decode(j.payload instanceof Uint8Array ? j.payload : new Uint8Array(j.payload)),
    }));
  }

  /** This job is finished: the broker may forget it. */
  async done(subject, index) {
    await this.#broker.request('POST', `/done/${subject}`, {
      query: `group=${CONSUMER_GROUP}&index=${index}`,
    });
  }

  /**
   * This job failed. It comes back after a backoff, and dead-letters to
   * `<subject>.dead` once it runs out of attempts — all of which the store
   * decides, exactly as it does for a native broker.
   */
  async fail(subject, index) {
    await this.#broker.request('POST', `/fail/${subject}`, {
      query: `group=${CONSUMER_GROUP}&index=${index}`,
    });
  }

  /** The retry policy for one subject, applied on first sight of it. */
  async setPolicy(subject, { maxAttempts, backoffMs, maxBackoffMs }) {
    const q = new URLSearchParams({
      group: CONSUMER_GROUP,
      max_attempts: String(maxAttempts),
      backoff_ms: String(backoffMs),
      max_backoff_ms: String(maxBackoffMs),
    });
    await this.#broker.request('PUT', `/queue/${subject}`, { query: String(q) });
  }
}
