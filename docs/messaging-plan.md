# Messaging — implementation plan

Documents can already query a database and render each other through `$`.
This adds the third thing: **a document can call another document later.**

Not a topic bus with subscribers. `$.render(target, data)` is a synchronous
call to a page; messaging is the same call made **asynchronously, durably and
out of process**. The subject *is* the page. There is no registration step,
because there is nothing to register — a name resolves to a page or it
doesn't, the same way `$.render` already resolves one.

```js
% $.render('invoice', order)   // now, inline, returns a tree
% $.publish('invoice', order)  // later, queued, survives a restart
```

Two tenses of one operation. Everything below follows from that.

There is deliberately no third call, and in particular no request/reply verb.
Request/reply already exists here and is spelled `$.render` — see
[Request/reply is `$.render`](#requestreply-is-render).

## What this buys, and what it costs

**Buys:** no `$.subscribe`, no boot-time registration pass, no reconciling
subscriptions across restarts, no pattern language, no second namespace to
learn. A message endpoint is a page — the same page that can also be rendered
inline, with no marker in its front matter saying so. The addressing story is
one story.

**Costs:** one message reaches one page. Broker-level fan-out — publish once,
N independent subscribers — is not available, and that is a real semantic
choice rather than an oversight. It is recoverable where it is wanted:

```js
% for (const h of $.find({ handles: 'order.placed' })) $.publish(h.name, order)
```

Fan-out relocates from broker configuration into a document, where it is
queryable, testable and visible in the source. For this stack that is the
better place for it, and it is the same trade the script-defined site made in
[site-plan.md](site-plan.md) — the host supplies primitives, the document
decides policy.

## Names must be durable, which rules out most render targets

`$.render` accepts an index, a `$.find` result carrying its store `_id`, or a
query. **None of those may be a message target.** Indexes and `_id`s come
from a `MemoryStorageProvider` built fresh on every run; a queued message can
outlive the process that sent it, so an identity that is only meaningful
inside one build is not an address.

A message target is therefore a **name**: a stable string, derived by default
from the document's `data.path` with the extension dropped and `/` mapped to
`.`, overridable by `messageName:` in front matter.

Not `name:`, which is the obvious spelling and is already taken twice
over: every raw source carries `name` as its file's base name
(`walkRawSources` in [../src/vault.js](../src/vault.js)), and a YAML data
record commonly declares its own — a person's name, a product's. Honouring
it would let an author's data silently readdress their messages.

```
handlers/invoice.mdy   →  handlers.invoice
```

That mapping is chosen to land inside sukkal's subject grammar as-is — 1–128
bytes of `[A-Za-z0-9_.-]`, no leading or trailing dot, no `..` — so a name
needs no escaping on the wire. A path outside that grammar is an error at
publish time, not a silent mangling.

**An unresolvable name throws**, matching `$.render`'s existing
`no document matches …`. The document set is the world; a typo'd name is a
bug the publisher should hear about immediately rather than a message that dies
quietly in a queue. (When messaging between *separately deployed* sets becomes
real, that check needs an explicit escape hatch — see Open questions.)

## Architecture — one native, one hook, no broker in core

```
┌─────────────────────────────────────────────────┐
│ document code          $.publish                │  sandboxed, JSON in/out
├─────────────────────────────────────────────────┤
│ mdy-docs core          fixed native + onPublish │  no network, no broker,
│                        name resolution          │  browser-bundlable
├─────────────────────────────────────────────────┤
│ packages/mdy-bus       broker adapter +         │  sukkal client, callback
│                        the delivery runtime     │  server, render-per-message
└─────────────────────────────────────────────────┘
```

Messaging mirrors `$.emit`, for the reason recorded in its own doc comment:
*"produce a named output as a side effect of rendering" is generic to any
mdy-docs consumer, and mdy has no opinion on what producing an output means.*
Calling a page later is the same kind of fact — core knows how to resolve a
name and hand the call to a hook, and nothing more.

The bottom layer being separate is not tidiness. [../src/serve.js](../src/serve.js)
documents that core is bundled for the browser and that Rollup statically
rejects a Node builtin reaching it even when nothing calls it; a broker client
in core breaks that bundle. Keeping the transport in an adapter also means
**the choice of broker is not a decision core has to make** — an adapter is on
the order of a hundred lines, and a second one lands without touching the
engine.

Core's surface is one native and one hook:

```js
$.publish(name, data)            // → null
onPublish({ name, data, docIndex })
```

Without the hook, `$.publish` resolves the name (so typos still throw) and is
otherwise a no-op — which is what a static build wants.

## The receiving side is not a new concept

A delivered message renders the named page with the message as `req`. That is
`$.render(target, data)`'s existing binding, unchanged. There is no handler
type, no lifecycle, no registration:

```yaml
messageName: handlers.invoice
+++
% const order = req.data
% $.publish('handlers.mailer', { to: order.email, total: order.total })
```

`req.msg` carries the delivery envelope alongside it — `{ name, index,
attempts }`, where `index` is the entry log's own contiguous index, so a page
that needs to dedupe has a natural key without inventing one.

A page reached by `$.publish` renders **for its effects**: it emits, or it
publishes onward, or it writes to a database. Its rendered output is
discarded, because there is nobody waiting to receive it.

## Request/reply is `$.render`

Every messaging system grows a request/reply verb, because a broker has no
other way to get a value back to a caller. This one is not missing that verb.
It has had it since before there was any messaging at all:

```js
% const invoice = $.render('invoice', order)
```

The request is `(name, data)`. The reply is what the page rendered. It is
synchronous, it is in-process, and there is no broker, no reply address, no
correlation id and no timeout anywhere in it.

So the API is two verbs and one question:

| | |
| --- | --- |
| **Do you need the answer?** | `$.render` — request/reply, now |
| **Do you not?** | `$.publish` — durable, retried, fire-and-forget |

A queued call that waits for its answer would sit between them and be worse
than both. It returns exactly what `$.render` returns, having first paid for a
broker round trip, an entry-log write and fsync, a delivery callback, a second
VM instance pinned for the duration on the receiving side, and a timeout the
caller has to invent. It also reintroduces a deadlock `$.render` cannot have:
a cycle of such calls suspends instances at both ends, and the render-depth
counter in [../src/mdy.js](../src/mdy.js) never sees it, because from its
point of view nothing recursed.

And the durability it appears to add is not real. Durability pays only when
**the caller does not wait**. A render blocked on an answer dies with its
process no matter how safely the message was stored — the guarantee is bought
and immediately discarded.

### A published page that publishes onward is not replying

The tempting middle case is a page that publishes an answer back to a name the
caller passed in. That is worth naming precisely, because it looks like reply
and isn't:

```yaml
messageName: handlers.invoice
+++
% $.publish('handlers.mailer', { invoice: id })
```

Nobody is waiting. This is the next step of a workflow, and the chain of pages
*is* the workflow. Calling it a reply imports a request-shaped mental model
into code that has no request in it, and pushes authors toward carrying reply
addresses around to emulate something `$.render` does in one line.

### The cross-set case is about reach, not replies

The one place `$.render` genuinely cannot go today is a page in another
document set, in another process. That is worth solving eventually, and it is
not a messaging problem: what is missing is not a way to send answers back,
but **an address space** — `$.render` resolving a name outside the local set,
with the same semantics and the same return value, over whatever transport.

Which is the strongest argument against a request verb: the honest version of
it would be `$.render` with a worse name.

## Transport: sukkal

Use [sukkal](https://github.com/mdy-docs/sukkal-msg). Don't build a third thing, and
don't take NATS into this repo.

| | |
| --- | --- |
| **Push, not poll** | a receiver *is* an HTTP server, and the delivery runtime is already one |
| **A subject is an entry log** | one durable file per name — which is now one file per page, a mapping that needs no explanation |
| **One binary** | broker and client in the same executable; no cluster, no ops story |
| **binjson wire format** | the same value model nisaba stores, so host↔broker↔db carries dates, binary and int64 without JSON coercion |
| **Ours** | the semantics can move to fit this use, which a third-party broker's cannot |

One honest limit on that fourth row. The guest↔host boundary is
`JSON.parse(__hostcall(m, JSON.stringify(args)))` (`buildProgram` in
[../src/mdy.js](../src/mdy.js)), so a `Date` in a message still reaches
document code as a string no matter what the transport does. The binjson
fidelity win is real between host, broker and database; it does **not** reach
template code unless `__call` is changed to a binjson codec, which is separate
work with its own reasons for and against.

Note also how much of sukkal's surface this design does *not* use: no
patterns, no `>` wildcards, no per-subscriber groups in document code. Names
are exact and one-to-one. That is a smaller contract to keep working than the
one sukkal currently offers, which is the right direction for a dependency.

## Registration is the runtime's business, and it is one line ✅

Nothing declares itself, so the runtime cannot enumerate "the pages that
receive" — every page is addressable in principle, and registering a sukkal
consumer for all N pages of a site would be absurd.

This plan proposed **lazy per-name consumers** to get around that: a catch-all
for discovery, and a durable consumer created per name on first traffic.
Building it showed that was solving a problem sukkal does not have. Receipts
there are keyed `<subject>/<consumer>`, so one catch-all registration —
`PUT /push/>` — is *already* "N ordinary subscriptions discovered by pattern
instead of by name". Each page gets its own receipt, its own lag and its own
retry, and the broker walks its matches round-robin so no page starves behind
a busy one. The lazy machinery would have bought precisely nothing.

So registration is one `PUT` at startup, re-asserted on a timer. The
heartbeat is not a poll — it carries no cursor and asks for nothing, it only
re-states where to deliver — and it exists because a broker that came back on
a rebuilt store has no record of the subscription, which from the runtime's
side is indistinguishable from having nothing to send.

## Publishes are deferred and flushed on success

`$.publish` **buffers per render** and the host flushes only after the render
completes without throwing — the same collect-then-apply shape as the
`outputs` Map in [../src/script-site.js](../src/script-site.js).

This is not fastidiousness. A script-defined site has no incremental cache, so
[../src/serve.js](../src/serve.js) re-walks the directory and reruns the entry
from scratch on every save. Immediate publishing means every keystroke in watch
mode re-fires every publish in the site. Consequently:

- **`build` and `serve` do not publish.** Both report what would have gone
  out instead — `build` lists it, `serve` names each page once and then
  counts them on the rebuild line, the way it already treats `[read]`, since
  a site that publishes on every rebuild would otherwise drown out what
  changed. Publishing is opt-in and belongs to the delivery runtime.
- `$.publish` returns `null`. The broker-assigned index exists only after the
  flush, so it is not available to the caller. Fire-and-forget is the whole
  contract; a page whose caller needs an answer should have been rendered.

## The delivery runtime — `mdy bus`

1. Build the document set; resolve every page's name.
2. Start the callback HTTP server and take the catch-all registration.
3. Per delivered message, resolve the name to a page and render it with `req`
   bound.
4. Reply to the broker's POST: `2xx` acks, anything else refuses.

Step 4 is where reliability comes from and where the sharp edges live:

- **A render that throws is a message that is not acked**, so sukkal redelivers
  it. That is the behaviour worth having, and it means pages reached by
  `$.publish` must be idempotent. A page that emitted before it threw will emit
  again.
- **Concurrency is capped by the VM pool.** `POOL_MAX` in
  [../src/vm.js](../src/vm.js) is 4, and a suspended Asyncify instance cannot
  be re-entered, so delivery parallelism is bounded by pool size and needs to
  become configurable.
- **A slow page holds an instance.** A nested `$.render` inside a delivered
  page takes a second instance for its depth, so the pool must exceed the
  deepest such render or the runtime deadlocks against itself.
- **A name that resolved at publish time may not resolve at delivery time** — the
  set was rebuilt, the page was renamed. This is the one case that genuinely
  belongs in sukkal's `/dead/<name>`, and it is the reason the dead-letter work
  in Phase 3 is not optional.

## `mdy serve` is the whole loop ✅

The dev server publishes and delivers, in one process, with no flag. It
already builds the set and already rebuilds on save, so the two things the
bus needs it had anyway; what it lacked was somewhere for a message to go.

There is no `--bus` switch because a broker on the other end is the only
thing that makes delivery mean anything, and that is a fact to discover
rather than a mode to select: serve asks `/health` once, and if nothing
answers it behaves exactly as before — holding messages and saying so.

Editing a page changes what the next message renders. `runBus` holds its
site in a box rather than capturing it, so a rebuild swaps it without
tearing down the registration and losing its place in the queue; a delivery
reads the site once, so a batch that started against one build finishes
against it instead of rendering half against each.

Two things had to be got right, both of which only appear once the halves
share a process:

  - **A rebuild must not re-send.** There is no incremental cache, so every
    keystroke reruns the entry. A message is sent at most once per run,
    fingerprinted on name and data. Deliberately per-process rather than a
    broker-level dedup key: it needs no decision about where a durable id
    would come from (below), and a restart resending is right for a dev
    loop.
  - **The two halves must not share a message queue.** `messages` is one
    array per built set, and both the entry's own `$.publish` calls and a
    delivered page's land in it. The bus flushes whatever it finds there
    after a render, so anything left behind was attributed to the first
    message that happened to arrive and re-sent under its name — an invoice
    publishing itself. Serve drains the array as it publishes.

`mdy bus` remains, and is what you deploy: no watch, no live reload, no
page serving, and it never runs the entry document — a worker rather than a
dev server.

## Phases

### Phase 0 — `$.publish` through `options.natives` (no core change) ✅

`options.natives` already merges any `{ name: fn }` into every render *and*
wires `$.<name>(...)` into the generated program (`buildDocumentSet` in
[../src/mdy.js](../src/mdy.js)), and Asyncify lets the host function be async
while the guest sees an ordinary call. So `$.publish` is one entry in
`buildNatives` in [../src/script-site.js](../src/script-site.js), with name
resolution and the deferred flush. Exit: a document in `examples/` publishes on
build with `--publish`, and the ergonomics have been felt before anything is
frozen.

**Done.** [../src/publish.js](../src/publish.js) derives and validates names
and collects messages; [../src/script-site.js](../src/script-site.js) wires
the native and returns `messages` alongside `outputs`; `buildSite` hands them
back after every write has succeeded; `mdy build --publish [--broker <url>]`
sends them from `@mdy-docs/mdy-bus` — outside `src/`, so no
transport reaches the browser bundle. binjson comes from nisaba's own codec,
which mdy already depends on, so no broker client library was needed:
a publish is one POST. See [../examples/messaging](../examples/messaging),
verified end to end against a real broker.

Three things the implementation settled that the plan had guessed at:

  - `name:` had to become `messageName:`, above.
  - Only `.mdy`/`.md` documents are addressable. A message renders a page,
    and a `.yaml` record or a `.png` has nothing to run — and indexing every
    file would make `static/logo.png` and `static/logo.jpg` collide on
    `static.logo` before either could be published to.
  - Colliding names are an error at publish rather than last-one-wins:
    `a/b/c.mdy` and `a.b/c.mdy` both derive `a.b.c`, and silently choosing
    one would deliver somebody's messages to the wrong page.

### Phase 1 — `mdy bus`, pages as endpoints ✅

Catch-all registration, render-per-message, ack-by-reply. Exit: two pages, one
publishing to the other across a broker restart, with nothing in either page's
front matter but its name.

**Done.** [../packages/mdy-bus](../packages/mdy-bus) is the runtime and `mdy bus` runs it;
[../src/script-site.js](../src/script-site.js) gained `openScriptSite` — a
site built but not run, which is what a process that renders on demand needs
and a build does not. The entry document is never rendered by the bus, because
nothing in this design registers anything.

Verified against a real broker: `mdy build --publish` sends two orders,
each delivery renders `handlers/invoice.mdy`, which publishes onward to
`handlers/mailer.mdy`, which is delivered in turn. The broker was then killed
and restarted on its store: delivery resumed with **no replay** of what had
already been acked (`acked: 5, lag: 0`), which is the receipt doing its job.

What the implementation settled:

  - **Lazy per-name consumers were unnecessary** — see above.
  - **`fetch` cannot register the catch-all.** It percent-encodes the path, so
    `PUT /push/>` arrives as `/push/%3E` and is refused as a bad pattern. The
    registration builds its path by hand over `node:http`; sukkal's own client
    carries the same note, and its README records both its clients hitting
    this. The publish side may keep using `fetch`, because a publish addresses
    a *name* and every character a name may contain is URL-safe.
  - **An undeliverable message is acked and dropped, not refused.** Refusing
    would redeliver it forever. A name this set has no page for — or has two
    pages for — is logged and discarded, which is the one case that genuinely
    belongs in a dead-letter channel (Phase 3).
  - **`req.msg` is the one reserved key.** A delivered page gets the message
    as `req`, exactly as `$.render(name, data)` binds it, plus `msg` carrying
    `{ name, index, attempts }` — which is what a page needs to dedupe or to
    notice it is being retried.

### Phase 2 — promote to a fixed native ✅

`publish` becomes a fixed native with an `onPublish` hook, name resolution moves
into core beside `resolveIndex`, adapter moves to `packages/mdy-bus`. Exit:
core has the primitive and no network dependency, and the browser bundle still
builds.

**Done.** `$.publish` is a fixed native in [../src/mdy.js](../src/mdy.js)
beside `$.emit`, with the address book — message name → document — built where
the documents are and exposed as `set.messagePages`, so a host that delivers
messages resolves names exactly the way `$.publish` does rather than keeping a
second opinion. [../src/publish.js](../src/publish.js) keeps the naming rules
and nothing else. The transport is `@mdy-docs/mdy-bus`.

Exit criterion met on both counts: nothing under `src/` reaches a broker, and
`packages/mdy-site`'s vite build still produces a browser bundle.

What the implementation settled:

  - **`runBus` takes an open document set, not a directory.** Had the package
    imported `openScriptSite`, mdy-docs and mdy-bus would each depend on the
    other. Injecting the site removes the cycle and is the better contract
    anyway: the bus is a transport over *something that renders pages by
    name*, and has no business knowing what a site directory is.
  - **`onPublish` had to be threaded through the import graph** beside
    `onEmit` ([../src/imports.js](../src/imports.js)). An imported package's
    documents run in their own set, and a hook the graph does not forward is
    a hook half the documents cannot reach.
  - **Core's hook reports `docIndex`, not a name.** Which document published
    is core's to know; what that document is *called* is the same derivation
    the address book already does, so script-site adds `fromName` on the way
    past rather than core computing it twice.

### Phase 3 — retries, dead letters, and looking at them ✅

Retry policy per name, `/dead/<name>` reachable from a document, requeue. A
dead-letter dashboard is a page over a query, which is the kind of thing this
stack should make trivial — and it is the natural first proof that the
messaging state is just more data.

**Done**, and it required changing how the bus is registered. Phase 1's plain
push subscription cannot do any of this: sukkal retries a failing callback
*forever*, deliberately — giving up would decide on the subscriber's behalf
that its messages no longer matter — and has nowhere to put a message it can
never deliver. Attempts, doubling backoff and `<name>.dead` are queue-group
features, so the registration now names a group.

  - **Retry policy per name** is `PUT /queue/<name>`, applied the first time a
    message for that name arrives (a subject does not exist until something is
    published to it, and the first delivery is attempt 1, so nothing is
    missed). `--max-attempts`, `--backoff`, `--max-backoff`.
  - **A dead-letter handler is a page called `<name>.dead`**, and that needed
    no new concept at all: `handlers.invoice.dead` is a name, so
    `handlers/invoice.dead.mdy` is addressable exactly like every other page.
    Nothing declares the relationship. With no such page the message is
    reported and kept.
  - **`mdy dead <name>` lists what died, `--requeue <index>` puts one back.**
    The dead record stays put — it is republished, not moved — so the history
    of what failed survives its own repair.

The cost, stated plainly: **messages for one page are no longer strictly
ordered against each other.** Jobs are held and returned individually, which
is exactly what stops one unrenderable message standing in front of every
later one; a high-water-mark ack cannot express "3 succeeded but 2 did not",
and under Phase 1's subscription a single poison message blocked its page
forever. For "render the page this names" that is the better trade, but it is
a trade.

It also fixed the weaker half of Phase 1: a message for a name this set has no
page for used to be acked and **discarded**, because refusing meant
redelivering forever. It is now returned, and ends up in `<name>.dead` where it
can be looked at and requeued.

Verified end to end: a page that always throws is retried on a doubling
backoff with the attempt counter climbing, dead-letters when it runs out,
and the dead letter is delivered to `handlers/flaky.dead.mdy` and rendered.
`mdy dead` then lists both deaths and requeues one.

**Logging.** A delivery *is* a re-render — the same page, the same engine,
reached by a message instead of by a file changing — so `mdy bus` logs it the
way `mdy serve` logs a rebuild: what it rendered, and how long it took.

```
11:41:16 PM [deliver] handlers.invoice #1 → rendered handlers/invoice.mdy in 54ms (published 1)
11:41:35 PM [refuse]  handlers.flaky #1 — handlers/flaky.mdy threw after 1ms attempt 2/3
11:42:30 PM [dead]    handlers.flaky.dead #2 → rendered handlers/flaky.dead.mdy in 4ms
```

The attempt counter is on the line because without it a retry is
indistinguishable from the same message being delivered twice.

## Open questions

- **Cross-set messaging.** Throwing on an unresolvable name assumes publisher and
  receiver share a document set. The moment two independently deployed sets
  talk, that check has to become opt-out, and "the page exists or it doesn't"
  stops being answerable at publish time. Worth deciding whether that is ever in
  scope before the check hardens into a guarantee people rely on.
- **`$.emit` from a delivered page.** In a build it writes a file. In the bus
  there is no output directory. Either it is an error, or it writes somewhere
  the runtime names — and "somewhere the runtime names" is a convention core
  would be inventing, which is the thing this design has otherwise avoided.
- **Publishing is not idempotent, and a rebuild resends everything.** Running
  Phase 1 made this obvious: `mdy build --publish` twice publishes every
  message twice, because `$.publish` has no dedup key and each send gets a
  fresh index. sukkal already supports `POST /pub/<subject>?id=<key>` and
  collapses a repeat, so the mechanism exists — what is missing is a decision
  about where the key comes from. Nothing in a document is naturally unique,
  so it probably has to be the publisher's to supply:
  `$.publish(name, data, { id })`. Until then, pages reached by a rebuild must
  be idempotent themselves.
- **Binjson across `__call`.** Worth doing for messaging alone? Probably not.
  Worth doing for `$.find` returning real dates? Different question, same
  change — decide them together.
