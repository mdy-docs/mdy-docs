import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryFsProvider, openScriptSite } from 'mdy-docs';
import { openInProcessBroker, runLocalBus } from '../src/index.js';

/*
 * Phase 6 of sukkal's docs/wasm-plan.md: the broker in this process.
 *
 * Same delivery handler, same routing table, same store — reached by a
 * function call instead of a socket. What is gone is everything that only
 * existed because there were two processes: the callback server, the
 * bearer token, working out which local address reaches the broker, and
 * the heartbeat that re-registered in case it had forgotten.
 */

const open = (files) => openScriptSite('/', { fs: memoryFsProvider(new Map(files)) });

async function bus(files, options = {}) {
  const site = await open(files);
  const broker = await openInProcessBroker();
  const events = [];
  const running = await runLocalBus(site, broker, {
    ...options,
    onEvent: (e) => events.push(e),
  });
  return { site, broker, running, events };
}

test('a published message renders the page it names, with no socket', async () => {
  const { site, broker, running } = await bus([
    ['handlers/invoice.mdy', '+++\n% $.emit("out", "invoice for " + req.customer)'],
  ]);
  try {
    await broker.publish('handlers.invoice', { customer: 'Ada' });
    await running.drain();
    assert.equal(site.outputs.get('out'), 'invoice for Ada');
  } finally { running.close(); }
});

test('a chain of pages runs to the end in one drain', async () => {
  // A delivered page publishing onward is the next step of a workflow, and
  // that message is due in the same tick — a dev loop should not make you
  // wait a poll interval per link.
  const { site, broker, running } = await bus([
    ['a.mdy', '+++\n% $.publish("b", { from: "a" })'],
    ['b.mdy', '+++\n% $.publish("c", { from: "b" })'],
    ['c.mdy', '+++\n% $.emit("end", "reached via " + req.from)'],
  ]);
  try {
    await broker.publish('a', {});
    await running.drain();
    assert.equal(site.outputs.get('end'), 'reached via b');
  } finally { running.close(); }
});

test('req.msg carries the envelope, exactly as over HTTP', async () => {
  const { site, broker, running } = await bus([
    ['h.mdy', '+++\n% $.emit("out", req.msg.name + "/" + req.msg.index + "/" + req.msg.attempts)'],
  ]);
  try {
    await broker.publish('h', { any: 'thing' });
    await running.drain();
    assert.equal(site.outputs.get('out'), 'h/1/1');
  } finally { running.close(); }
});

test('a page that throws is retried, then dead-lettered to its .dead page', async () => {
  // Attempts, backoff and the dead-letter channel live in the store, not
  // in the pusher — which is why pulling instead of pushing keeps all of
  // them. A zero backoff so the retries land in this test rather than a
  // minute from now.
  const { site, broker, running } = await bus(
    [
      ['flaky.mdy', '+++\n% throw "always"'],
      ['flaky.dead.mdy', '+++\n% $.emit("gave-up", "after " + req.msg.attempts + " attempts")'],
    ],
    { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 }
  );
  try {
    await broker.publish('flaky', { work: 1 });
    // Each drain is one round of attempts; the third finds it dead-lettered.
    for (let i = 0; i < 4; i++) await running.drain();
    assert.ok(site.outputs.has('gave-up'), 'the .dead page handled it');
  } finally { running.close(); }
});

test('nothing is delivered twice: a finished job is not taken again', async () => {
  const { site, broker, running } = await bus([
    ['h.mdy', '+++\n% $.emit("n" + req.msg.index, String(req.msg.index))'],
  ]);
  try {
    await broker.publish('h', {});
    await running.drain();
    await running.drain();
    await running.drain();
    assert.deepEqual([...site.outputs.keys()], ['n1']);
  } finally { running.close(); }
});

test('an edit changes what the next message renders', async () => {
  // setSite is what makes one process worth having: mdy dev rebuilds on
  // save and the bus delivers against the new set without tearing anything
  // down.
  const files = [['h.mdy', '+++\n% $.emit("out", "first")']];
  const { broker, running } = await bus(files);
  try {
    await broker.publish('h', {});
    await running.drain();

    const edited = await open([['h.mdy', '+++\n% $.emit("out", "second")']]);
    running.setSite(edited);
    await broker.publish('h', {});
    await running.drain();
    assert.equal(edited.outputs.get('out'), 'second');
  } finally { running.close(); }
});
