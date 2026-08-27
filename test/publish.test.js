import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryFsProvider } from '../index.js';
import { renderSite } from '../src/build.js';
import { messageName, nameProblem } from '../src/publish.js';

// $.publish — a render deferred and addressed to a page (src/publish.js,
// docs/messaging-plan.md). Nothing here touches a broker: the whole point
// of the design is that mdy collects messages and has no opinion on what
// sending one means, so what is testable in this package is the collecting
// — name derivation, resolution, and the deferral itself. The transport
// lives in @mdy-docs/mdy-bus, and examples/messaging exercises it end to end.

const site = (files) => renderSite('/', { fs: memoryFsProvider(new Map(files)) });

const ENTRY = (body) => ['main.mdy', `+++\n${body}`];

test('messageName: a path becomes a name, extension dropped and "/" written as "."', () => {
  assert.equal(messageName({ path: 'handlers/invoice.mdy' }), 'handlers.invoice');
  assert.equal(messageName({ path: 'invoice.mdy' }), 'invoice');
  assert.equal(messageName({ path: 'a/b/c/d.md' }), 'a.b.c.d');
  // No extension at all is fine; only the LAST dotted segment is stripped.
  assert.equal(messageName({ path: 'handlers/invoice' }), 'handlers.invoice');
  assert.equal(messageName({ path: 'posts/2026-07-hello.mdy' }), 'posts.2026-07-hello');
});

test('messageName: messageName in front matter wins, and `name` is deliberately ignored', () => {
  assert.equal(messageName({ path: 'a/b.mdy', messageName: 'orders.new' }), 'orders.new');
  // `name` is every raw source's own file base name (src/vault.js) and is
  // commonly redefined by a YAML data record — honouring it here would let
  // an author's data silently readdress their messages.
  assert.equal(messageName({ path: 'a/b.mdy', name: 'something-else' }), 'a.b');
});

test('messageName: no usable path is null rather than an error', () => {
  assert.equal(messageName({}), null);
  assert.equal(messageName(undefined), null);
});

test('nameProblem: sukkal\'s subject grammar is enforced before anything is queued', () => {
  assert.equal(nameProblem('handlers.invoice'), null);
  assert.equal(nameProblem('a-b_c.1'), null);
  assert.ok(nameProblem('has space'));
  assert.ok(nameProblem('has/slash'));
  assert.ok(nameProblem('.leading'));
  assert.ok(nameProblem('trailing.'));
  assert.ok(nameProblem('double..dot'));
  assert.ok(nameProblem(''));
  assert.ok(nameProblem('x'.repeat(129)));
});

test('$.publish queues a message addressed to a page, and returns null', async () => {
  const { messages } = await site([
    ENTRY('% const r = $.publish("handlers.invoice", { id: 7 })\n% $.emit("i.html", "ok:" + (r === null))'),
    ['handlers/invoice.mdy', '+++\ntitle: Invoice\n+++\nInvoice {{ req.id }}'],
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].name, 'handlers.invoice');
  assert.deepEqual(messages[0].data, { id: 7 });
  assert.equal(messages[0].fromName, 'main');
});

test('$.publish sends nothing during the render — messages only come back from the build', async () => {
  // The deferral is the contract: a publish that went out mid-render would
  // re-fire on every watch-mode rebuild (script-site.js has no incremental
  // cache). All a document can do is append.
  const { messages, outputs } = await site([
    ENTRY('% $.publish("h", { n: 1 })\n% $.publish("h", { n: 2 })\n% $.emit("i.html", "rendered")'),
    ['h.mdy', 'handler'],
  ]);
  assert.equal(outputs.get('i.html'), 'rendered');
  assert.deepEqual(messages.map((m) => m.data.n), [1, 2]);
});

test('a build that throws publishes nothing at all', async () => {
  await assert.rejects(
    site([
      ENTRY('% $.publish("h", { n: 1 })\n% throw "boom"'),
      ['h.mdy', 'handler'],
    ]),
    // The messages array never escapes a failed build, which is the whole
    // reason publishing is deferred rather than immediate.
    (err) => /boom/.test(String(err))
  );
});

test('$.publish to a name no page answers to throws, like $.render', async () => {
  await assert.rejects(
    site([ENTRY('% $.publish("handlers.nope", {})\n% $.emit("i.html", "x")')]),
    /no document is named "handlers\.nope"/
  );
});

test('$.publish rejects a name outside the subject grammar before resolving it', async () => {
  await assert.rejects(
    site([ENTRY('% $.publish("handlers/invoice", {})\n% $.emit("i.html", "x")')]),
    /a message name may only contain/
  );
});

test('two paths collapsing to one name is an error at publish, not last-one-wins', async () => {
  // a/b/c.mdy and a.b/c.mdy both derive a.b.c. Silently picking one would
  // deliver somebody's messages to the wrong page.
  await assert.rejects(
    site([
      ENTRY('% $.publish("a.b.c", {})\n% $.emit("i.html", "x")'),
      ['a/b/c.mdy', 'one'],
      ['a.b/c.mdy', 'two'],
    ]),
    /is ambiguous — 2 documents share it/
  );
});

test('messageName in front matter is how a collision gets resolved', async () => {
  const { messages } = await site([
    ENTRY('% $.publish("a.b.c", {})\n% $.publish("the-other-one", {})\n% $.emit("i.html", "x")'),
    ['a/b/c.mdy', 'one'],
    ['a.b/c.mdy', '+++\nmessageName: the-other-one\n+++\ntwo'],
  ]);
  assert.deepEqual(messages.map((m) => m.name), ['a.b.c', 'the-other-one']);
});

test('only renderable documents are addressable — a data record or an asset is not', async () => {
  // A message delivered to a page renders it, and a .yaml record has
  // nothing to run. Restricting the index this way is also what stops
  // static/logo.png and static/logo.jpg from colliding on static.logo.
  await assert.rejects(
    site([
      ENTRY('% $.publish("orders.a-1001", {})\n% $.emit("i.html", "x")'),
      ['orders/a-1001.yaml', 'id: a-1001\ncustomer: Ada\n'],
    ]),
    /no document is named "orders\.a-1001"/
  );
});

test('a published page is an ordinary page — $.render reaches the same document inline', async () => {
  // The two tenses of one operation: whether the caller waited is not the
  // page's business, so nothing marks handlers/invoice.mdy as a handler.
  const { outputs, messages } = await site([
    ENTRY(
      '% $.publish("handlers.invoice", { id: 7, customer: "Ada" })\n' +
        '% $.emit("i.html", $.render({ path: "handlers/invoice.mdy" }, { id: 7, customer: "Ada" }))'
    ),
    ['handlers/invoice.mdy', '+++\ntitle: Invoice\n+++\nInvoice {{ req.id }} for {{ req.customer }}'],
  ]);
  assert.match(outputs.get('i.html'), /Invoice 7 for Ada/);
  assert.equal(messages[0].name, 'handlers.invoice');
});

test('$.publish with no data queues {} rather than undefined', async () => {
  const { messages } = await site([
    ENTRY('% $.publish("h")\n% $.emit("i.html", "x")'),
    ['h.mdy', 'handler'],
  ]);
  assert.deepEqual(messages[0].data, {});
});
