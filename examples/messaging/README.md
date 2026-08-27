# examples/messaging

A site that publishes, and pages that are published to.

`$.render(name, data)` calls a page now and gives back its tree.
`$.publish(name, data)` is the same call in the other tense — queued,
durable, rendered later, possibly by another process. There is no
`$.subscribe` here and no handler registry: **a page is addressable
because it exists**, and its name is its path without the extension with
`/` written as `.`.

```
main.mdy                     publishes one message per order
handlers/invoice.mdy         ← handlers.invoice, and publishes onward to
handlers/mailer.mdy          ← handlers.mailer, the end of the chain
handlers/invoice.dead.mdy    ← handlers.invoice.dead, if one ever dies
handlers/flaky.mdy           always throws, to show what failure does
handlers/flaky.dead.mdy      ← where those end up
orders/*.yaml                the data main.mdy reads
layouts/orders.mdy           the page it emits
```

Nothing in any of those files declares a relationship. `handlers.invoice`
finds `handlers/invoice.mdy` because that is where the file is.

## Running it

You need a [sukkal](https://github.com/mdy-docs/sukkal-msg) broker — mdy
collects messages and sends nothing itself, deliberately (see
`docs/messaging-plan.md`). It is one binary with no dependencies beyond
libcurl:

```sh
git clone --recurse-submodules https://github.com/mdy-docs/sukkal-msg.git
make -C sukkal-msg
```

Then two terminals, both on defaults — no flags, no configuration:

```sh
# 1. the broker
sukkal-msg/bin/sukkal serve

# 2. everything else
mdy dev examples/messaging
```

`mdy dev` publishes what the rebuild produced and delivers each message
to the page it names, so the whole loop is one process:

```
➜  Local:   http://localhost:4321/
➜  Broker:  http://127.0.0.1:8080 — publishing and delivering

[send] handlers.invoice (73 bytes)
[send] handlers.invoice (73 bytes)
[deliver] handlers.invoice #1 → rendered handlers/invoice.mdy in 4ms (published 1)
[deliver] handlers.mailer #1 → rendered handlers/mailer.mdy in 2ms
[deliver] handlers.invoice #2 → rendered handlers/invoice.mdy in 3ms (published 1)
[deliver] handlers.mailer #2 → rendered handlers/mailer.mdy in 2ms
```

Four deliveries from two publishes: `handlers/invoice.mdy` publishes to
`handlers/mailer.mdy` while being delivered itself. That second publish
goes out only once the invoice's own render has succeeded — the chain of
pages is the workflow.

**Now edit `handlers/mailer.mdy`.** Serve rebuilds, and the next message
delivered to it renders the version you just saved — no restart. A rebuild
never re-sends what it already sent, so saving a file does not replay the
whole site; adding an order publishes exactly the one new message.

Stop the broker and `mdy dev` still serves the site, listing the
messages it would have sent and holding them. `mdy build --publish` is the
one-shot version, for a build that should send and exit.

## Watching one fail

`handlers/flaky.mdy` always throws. Publish to it and watch the whole
lifecycle:

```sh
sukkal-msg/bin/sukkal pub handlers.flaky "will never render"
```

```
[refuse] handlers.flaky #1 — handlers/flaky.mdy threw after 1ms
[refuse] handlers.flaky #1 — handlers/flaky.mdy threw after 1ms attempt 2/5
...
[dead]   handlers.flaky.dead #1 → rendered handlers/flaky.dead.mdy in 4ms
```

A render that throws does not acknowledge, so the message comes back on a
doubling backoff. When it runs out of attempts the broker republishes it
to `handlers.flaky.dead` — which is a name, so the page called
`handlers/flaky.dead.mdy` handles it. Nothing declares that either.

`--max-attempts 2 --backoff 200` on `mdy dev` makes it happen in about a
second instead of several minutes.

Afterwards:

```sh
mdy dead handlers.flaky                 # what died, and after how many tries
mdy dead handlers.flaky --requeue 1     # put one back
```

## Two things to know

**Pages reached by a message must be idempotent.** A render that fails
part-way will be retried from the start, and a page that emitted or
published before it threw will do so again.

**Publishing is not idempotent either.** `mdy build --publish` twice sends
everything twice — every message gets a fresh index, because `$.publish`
has no dedup key. Run the build once per batch of orders, or make the
receiving pages tolerant of repeats.
