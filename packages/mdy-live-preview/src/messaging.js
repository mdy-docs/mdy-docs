/*
 * messaging.js — the message loop, in the tab.
 *
 * `$.render(name, data)` calls a page now; `$.publish(name, data)` is the
 * same call queued, durable and delivered later. Everywhere else that
 * "later" needs a broker process; here there isn't one. sukkal compiles to
 * WebAssembly, so the broker runs beside the template VM and the query
 * engine — three WASM modules in a browser tab, and the whole stack with
 * no server behind it.
 *
 * What that demonstrates is not "it also works in a browser". It is that
 * publishing has no transport in it: the routing table a native `sukkal
 * serve` answers from is the one being called here, by name, in process.
 *
 * The set is opened here rather than shared with the preview pane, which
 * renders through @mdy-docs/react's own processor. Two sets for one source
 * is real duplication and it is bounded: `usesMessaging` below means a
 * document that never publishes never pays for any of this.
 */
import { openDocumentSet } from 'mdy-docs';

/** Cheap enough to run on every keystroke, and it decides whether anything
 * else here runs at all. */
export const usesMessaging = (source) => /\$\.publish\s*\(/.test(source);

let brokerPromise = null;

/* One broker for the page's lifetime. In memory, deliberately: a preview
 * that remembered yesterday's messages would be lying about what the
 * document in the editor does. */
function broker() {
  brokerPromise ||= (async () => {
    /* The /inprocess entry rather than the package root: the root also
     * exports the HTTP runtime, which reaches for node:http and node:net,
     * and a browser cannot follow it there. */
    const { openInProcessBroker } = await import('@mdy-docs/mdy-bus/inprocess');
    return openInProcessBroker();
  })();
  return brokerPromise;
}

/**
 * Render `source`, send whatever it published, and deliver each message to
 * the page it names — following the chain as far as it goes.
 *
 * Returns a log of what happened, newest last: what was sent, what
 * rendered, what refused. The output of a delivered page is included,
 * because in a preview the interesting thing about a message is what it
 * caused.
 *
 * @returns {Promise<{ log: Array, error: string | null }>}
 */
export async function runMessages(source, { maxRounds = 8 } = {}) {
  const log = [];
  let bus;
  try {
    bus = await broker();
  } catch (err) {
    return { log, error: `no broker: ${err.message}` };
  }

  /* A fresh set per run: the source changed, so every page did. Messages
   * published during the entry's own render are collected, not sent — the
   * same deferral the CLI has, for the same reason (a keystroke must not
   * re-fire what the last one sent). */
  const pending = [];
  let set;
  try {
    set = await openDocumentSet(source, {
      onPublish: ({ name, data }) => pending.push({ name, data }),
    });
    await set.renderTree(0, {});
  } catch (err) {
    return { log, error: err.message };
  }

  const send = async (messages) => {
    for (const m of messages) {
      try {
        const { index } = await bus.publish(m.name, m.data);
        log.push({ kind: 'send', name: m.name, index });
      } catch (err) {
        log.push({ kind: 'error', name: m.name, detail: err.message });
      }
    }
  };

  /* Drained rather than read: the same array collects what a DELIVERED
   * page publishes, and anything left in it would be attributed to
   * whichever message happened to arrive next. */
  await send(pending.splice(0));

  /* Deliver, following the chain: a delivered page may publish onward and
   * that message is due now, not on some later tick. */
  for (let round = 0; round < maxRounds; round++) {
    let handled = 0;
    for (const subject of await bus.subjects()) {
      const jobs = await bus.take(subject);
      if (jobs.length === 0) continue;
      handled += jobs.length;

      const targets = set.messagePages.get(subject) ?? [];
      for (const job of jobs) {
        if (targets.length !== 1) {
          // No page of that name, or two. Returned rather than dropped, so
          // it ends up in <subject>.dead where it can be seen.
          log.push({ kind: 'undeliverable', name: subject, index: job.index });
          await bus.fail(subject, job.index);
          continue;
        }
        const data = job.value && typeof job.value === 'object' && !Array.isArray(job.value)
          ? job.value
          : { value: job.value };
        const req = { ...data, msg: { name: subject, index: job.index, attempts: job.attempts } };

        try {
          const rendered = await set.renderText(targets[0].index, req);
          log.push({
            kind: 'deliver',
            name: subject,
            index: job.index,
            /* A path when the set came from files. A set typed into one
             * editor pane has none, and a bare document index tells a
             * reader nothing — so say nothing. */
            page: targets[0].data?.path ?? null,
            output: rendered.trim(),
          });
          await bus.done(subject, job.index);
          /* Whatever this page published while rendering, sent only now
           * that its render has succeeded. */
          await send(pending.splice(0));
        } catch (err) {
          log.push({ kind: 'refuse', name: subject, index: job.index, detail: String(err.message ?? err) });
          await bus.fail(subject, job.index);
        }
      }
    }
    if (handled === 0) break;
  }

  return { log, error: null };
}
