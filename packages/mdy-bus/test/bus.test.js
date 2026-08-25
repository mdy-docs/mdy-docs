import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryFsProvider, openScriptSite } from 'mdy-docs';
import { createDeliveryHandler, parseDelivery } from '../src/index.js';

// `mdy bus` — pages as endpoints (src/bus.js; mdy-docs' docs/messaging-plan.md).
//
// The runtime is deliberately split so the part with the decisions in it
// has neither HTTP nor a broker in it: createDeliveryHandler takes an
// already-parsed batch and returns how far it got. That is what is tested
// here. The socket half is exercised end to end against a real broker by
// mdy-docs' examples/messaging, which needs a built sukkal binary and so does not
// belong in this suite.

const open = (files) => openScriptSite('/', { fs: memoryFsProvider(new Map(files)) });

/** One batch entry as the broker would send it, already decoded. */
const entry = (index, value, attempts) => ({ index, value, headers: null, ...(attempts ? { attempts } : {}) });

/** A handler plus the messages its renders published. */
function handlerFor(site, onEvent) {
  const flushed = [];
  const deliver = createDeliveryHandler({
    site,
    flush: async (produced) => { flushed.push(...produced); },
    onEvent,
  });
  return { deliver, flushed };
}

test('a delivered message renders the page of that name, with the message as req', async () => {
  const site = await open([
    ['handlers/invoice.mdy', 'title: Invoice\n+++\n% $.emit("out", "invoice for " + req.customer + " #" + req.id)'],
  ]);
  const { deliver } = handlerFor(site);

  const { done, failed } = await deliver('handlers.invoice', [entry(1, { id: 7, customer: 'Ada' })]);
  assert.deepEqual(done, [1]);
  assert.deepEqual(failed, []);
  assert.equal(site.outputs.get('out'), 'invoice for Ada #7');
});

test('req.msg carries the envelope: name, index, attempts', async () => {
  const site = await open([
    ['h.mdy', '+++\n% $.emit("out", req.msg.name + "/" + req.msg.index + "/" + req.msg.attempts)'],
  ]);
  const { deliver } = handlerFor(site);

  await deliver('h', [entry(12, { any: 'thing' }, 3)]);
  assert.equal(site.outputs.get('out'), 'h/12/3');
});

test('attempts defaults to 1 when the broker did not say', async () => {
  const site = await open([['h.mdy', '+++\n% $.emit("out", String(req.msg.attempts))']]);
  const { deliver } = handlerFor(site);
  await deliver('h', [entry(1, {})]);
  assert.equal(site.outputs.get('out'), '1');
});

test('a batch is rendered in order, and every message is acked on its own', async () => {
  const site = await open([
    ['h.mdy', '+++\n% $.emit("out-" + req.n, String(req.n))'],
  ]);
  const { deliver } = handlerFor(site);

  const { done } = await deliver('h', [entry(4, { n: 1 }), entry(5, { n: 2 }), entry(6, { n: 3 })]);
  assert.deepEqual(done, [4, 5, 6]);
  assert.deepEqual([...site.outputs.keys()].sort(), ['out-1', 'out-2', 'out-3']);
});

test('one message failing returns only that message — the rest still run', async () => {
  // The difference queue-group delivery makes. Under a plain subscription
  // an ack is a high-water mark, so a failure had to stop the batch and
  // drag every later message back with it; jobs are held and returned
  // individually, so a message that cannot render blocks nothing.
  const site = await open([
    ['h.mdy', '+++\n% if (req.n === 2) { throw "boom" }\n% $.emit("out-" + req.n, "ok")'],
  ]);
  const { deliver } = handlerFor(site);

  const { done, failed } = await deliver('h', [entry(4, { n: 1 }), entry(5, { n: 2 }), entry(6, { n: 3 })]);
  assert.deepEqual(done, [4, 6]);
  assert.deepEqual(failed, [5]);
  assert.deepEqual([...site.outputs.keys()].sort(), ['out-1', 'out-3']);
});

test('a delivery where nothing succeeded returns everything', async () => {
  const site = await open([['h.mdy', '+++\n% throw "always"']]);
  const { deliver } = handlerFor(site);

  const { done, failed } = await deliver('h', [entry(9, {}), entry(10, {})]);
  assert.deepEqual(done, []);
  assert.deepEqual(failed, [9, 10]);
});

test('a failure reports the attempt it was on, so a retry is distinguishable', async () => {
  const events = [];
  const site = await open([['h.mdy', '+++\n% throw "nope"']]);
  const { deliver } = handlerFor(site, (e) => events.push(e));

  await deliver('h', [entry(1, {}, 3)]);
  assert.equal(events[0].type, 'failed');
  assert.equal(events[0].attempts, 3);
  assert.equal(events[0].path, 'h.mdy');
});

test('a delivery reports the page it rendered and how long it took', async () => {
  // The CLI logs a delivery the way it logs a re-render, which it can only
  // do if the event says which page and how long.
  const events = [];
  const site = await open([['handlers/invoice.mdy', '+++\nhi']]);
  const { deliver } = handlerFor(site, (e) => events.push(e));

  await deliver('handlers.invoice', [entry(1, {})]);
  assert.equal(events[0].type, 'delivered');
  assert.equal(events[0].path, 'handlers/invoice.mdy');
  assert.equal(typeof events[0].ms, 'number');
});

test('what a delivered page publishes is flushed only after its own render succeeded', async () => {
  const site = await open([
    ['h.mdy', '+++\n% $.publish("next", { from: req.n })'],
    ['next.mdy', '+++\nnext'],
  ]);
  const { deliver, flushed } = handlerFor(site);

  await deliver('h', [entry(1, { n: 'a' }), entry(2, { n: 'b' })]);
  assert.deepEqual(flushed.map((m) => m.name), ['next', 'next']);
  assert.deepEqual(flushed.map((m) => m.data.from), ['a', 'b']);
});

test('a page that publishes and then throws publishes nothing', async () => {
  const site = await open([
    ['h.mdy', '+++\n% $.publish("next", { n: 1 })\n% throw "after"'],
    ['next.mdy', '+++\nnext'],
  ]);
  const { deliver, flushed } = handlerFor(site);

  const { done } = await deliver('h', [entry(1, {})]);
  assert.deepEqual(done, []);
  assert.deepEqual(flushed, []);
  // ...and nothing leaks into the next delivery either.
  await deliver('h', [entry(2, {})]);
  assert.deepEqual(flushed, []);
});

test('a message for a name this set has no page for is returned, so it dead-letters', async () => {
  // Phase 1 acked and dropped these, because refusing a push subscription
  // meant redelivering forever. A queue group has somewhere for them to
  // go, so the message is kept and ends up in <name>.dead rather than
  // being silently discarded.
  const events = [];
  const site = await open([['h.mdy', '+++\nhere']]);
  const { deliver } = handlerFor(site, (e) => events.push(e));

  const { done, failed } = await deliver('not.here', [entry(3, {}), entry(4, {})]);
  assert.deepEqual(done, []);
  assert.deepEqual(failed, [3, 4]);
  assert.equal(events[0].type, 'undeliverable');
  assert.match(events[0].why, /no page of that name/);
});

test('an ambiguous name is returned rather than delivered to a guess', async () => {
  const events = [];
  const site = await open([
    ['a/b/c.mdy', '+++\none'],
    ['a.b/c.mdy', '+++\ntwo'],
  ]);
  const { deliver } = handlerFor(site, (e) => events.push(e));

  const { failed } = await deliver('a.b.c', [entry(1, {})]);
  assert.deepEqual(failed, [1]);
  assert.match(events[0].why, /2 pages share that name/);
});

test('a dead-letter channel with no page is kept, not returned — returning it would loop', async () => {
  // <name>.dead is where the broker republishes what this bus already gave
  // up on. Failing those would send them round again forever.
  const events = [];
  const site = await open([['h.mdy', '+++\nhere']]);
  const { deliver } = handlerFor(site, (e) => events.push(e));

  const { done, failed } = await deliver('h.dead', [entry(1, { why: 'boom' })]);
  assert.deepEqual(done, [1]);
  assert.deepEqual(failed, []);
  assert.equal(events[0].type, 'dead');
  assert.equal(events[0].handled, false);
});

test('a dead-letter handler is just a page called <name>.dead', async () => {
  // No new concept: <name>.dead is a name, so it is addressable the same
  // way every other page is.
  const events = [];
  const site = await open([
    ['handlers/invoice.mdy', '+++\nlive'],
    ['handlers/invoice.dead.mdy', '+++\n% $.emit("alerted", "died: " + req.why)'],
  ]);
  const { deliver } = handlerFor(site, (e) => events.push(e));

  const { done } = await deliver('handlers.invoice.dead', [entry(2, { why: 'boom' })]);
  assert.deepEqual(done, [2]);
  assert.equal(site.outputs.get('alerted'), 'died: boom');
  assert.equal(events[0].type, 'dead');
  assert.equal(events[0].handled, true);
  assert.equal(events[0].path, 'handlers/invoice.dead.mdy');
});

test('a non-object message body still reaches the page, under `value`', async () => {
  const site = await open([['h.mdy', '+++\n% $.emit("out", "got " + req.value)']]);
  const { deliver } = handlerFor(site);
  await deliver('h', [entry(1, 'a string')]);
  assert.equal(site.outputs.get('out'), 'got a string');
});

test('the same page renders identically inline and on delivery', async () => {
  // Two tenses of one operation: nothing marks a page as a handler, so
  // $.render and a delivery cannot produce different results.
  const site = await open([
    ['h.mdy', '+++\nHello {{ req.who }}'],
    ['main.mdy', '+++\n% $.emit("inline.html", $.render({ path: "h.mdy" }, { who: "Ada" }))'],
  ]);
  const entryIndex = site.set.docs.find((d) => d.data.path === 'main.mdy').index;
  await site.set.renderResult(entryIndex, {});
  const inline = site.outputs.get('inline.html');

  const { deliver } = handlerFor(site);
  await deliver('h', [entry(1, { who: 'Ada' })]);
  assert.match(inline, /Hello Ada/);
});

test('parseDelivery unwraps the entry log batch, PLAIN and ENVELOPE alike', () => {
  // The body is the log's own encoding forwarded verbatim, so it decodes
  // in two steps: the batch, then each payload.
  const payloads = new Map();
  const fakeDecode = (bytes) => {
    if (payloads.has(bytes)) return payloads.get(bytes);
    return bytes;
  };
  const plain = new Uint8Array([1]);
  const enveloped = new Uint8Array([2]);
  payloads.set(plain, { id: 1 });
  payloads.set(enveloped, [{ h: 'x' }, { id: 2 }]);
  const batch = [
    { index: 1n, term: 0, type: 0x01, payload: plain },
    { index: 2n, term: 0, type: 0x10, payload: enveloped, attempts: 2 },
  ];
  payloads.set(batch, batch);

  const parsed = parseDelivery(batch, fakeDecode);
  assert.deepEqual(parsed[0], { index: 1, value: { id: 1 }, headers: null });
  assert.deepEqual(parsed[1], { index: 2, value: { id: 2 }, headers: { h: 'x' }, attempts: 2 });
});

test('parseDelivery rejects a body that is not a batch', () => {
  assert.throws(() => parseDelivery(new Uint8Array([1]), () => ({ not: 'an array' })), /not a batch/);
});
