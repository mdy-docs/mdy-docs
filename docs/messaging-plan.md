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
`.`, overridable by `name:` in front matter.

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
name: handlers.invoice
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
name: handlers.invoice
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

## Registration is the runtime's business, and it should be lazy

Nothing declares itself, so the runtime cannot enumerate "the pages that
receive" — every page is addressable in principle, and registering a sukkal
consumer for all N pages of a site would be absurd.

The resolution is **lazy per-name consumers**: the runtime holds one catch-all
push registration for discovery, and the first time a message actually arrives
for a name, it creates that name's durable consumer and routes to it from then
on. The set of live endpoints is discovered from traffic rather than declared.

The alternative — route everything through the single catch-all and keep
receipts host-side — is simpler but couples every page's retry and lag into
one ordered stream, where one poisoned message stalls unrelated work. The lazy
form keeps sukkal's per-consumer receipts, independent retry and per-name lag,
at no cost in document-side API. Take the lazy form.

## Publishes are deferred and flushed on success

`$.publish` **buffers per render** and the host flushes only after the render
completes without throwing — the same collect-then-apply shape as the
`outputs` Map in [../src/script-site.js](../src/script-site.js).

This is not fastidiousness. A script-defined site has no incremental cache, so
[../src/serve.js](../src/serve.js) re-walks the directory and reruns the entry
from scratch on every save. Immediate publishing means every keystroke in watch
mode re-fires every publish in the site. Consequently:

- **`build` and `serve` do not publish.** The default is a no-op that logs what
  would have gone out. Publishing is opt-in and belongs to the delivery runtime.
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

## Phases

### Phase 0 — `$.publish` through `options.natives` (no core change)

`options.natives` already merges any `{ name: fn }` into every render *and*
wires `$.<name>(...)` into the generated program (`buildDocumentSet` in
[../src/mdy.js](../src/mdy.js)), and Asyncify lets the host function be async
while the guest sees an ordinary call. So `$.publish` is one entry in
`buildNatives` in [../src/script-site.js](../src/script-site.js), with name
resolution and the deferred flush. Exit: a document in `examples/` publishes on
build with `--publish`, and the ergonomics have been felt before anything is
frozen.

### Phase 1 — `mdy bus`, pages as endpoints

Catch-all registration, lazy per-name consumers, render-per-message,
ack-by-reply. Exit: two pages, one publishing to the other across a broker
restart, with nothing in either page's front matter but its name.

### Phase 2 — promote to a fixed native

`publish` becomes a fixed native with an `onPublish` hook, name resolution moves
into core beside `resolveIndex`, adapter moves to `packages/mdy-bus`. Exit:
core has the primitive and no network dependency, and the browser bundle still
builds.

### Phase 3 — retries, dead letters, and looking at them

Retry policy per name, `/dead/<name>` reachable from a document, requeue. A
dead-letter dashboard is a page over a query, which is the kind of thing this
stack should make trivial — and it is the natural first proof that the
messaging state is just more data.

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
- **Is `mdy bus` a separate process at all?** The receiving set and the site
  set are the same set. If they stay the same, `mdy serve --bus` may beat a
  third command.
- **Binjson across `__call`.** Worth doing for messaging alone? Probably not.
  Worth doing for `$.find` returning real dates? Different question, same
  change — decide them together.
