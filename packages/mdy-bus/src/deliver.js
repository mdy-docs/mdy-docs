/*
 * deliver.js — rendering the page a message names.
 *
 * The half of the runtime with the decisions in it, and the half with no
 * transport: given a subject and a batch, render the page of that name once
 * per message and say which ones succeeded. Both runtimes use it unchanged
 * — an HTTP delivery pushed to a callback (bus.js) and a job claimed from
 * an in-process broker (inprocess.js) — which is what makes it true that a
 * page cannot tell how it was reached.
 *
 * Its own file because bus.js reaches for node:http and a browser cannot
 * follow it there.
 */

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

