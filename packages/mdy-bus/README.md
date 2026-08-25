# @mdy-docs/mdy-bus

The transport half of `$.publish` — [sukkal](https://github.com/mdy-docs/sukkal-msg)
delivery for [mdy documents](https://github.com/mdy-docs/mdy-docs).

`$.render(name, data)` calls a page now and gives back its tree.
`$.publish(name, data)` is the same call in the other tense: queued,
durable, rendered later. mdy core resolves the name to a page and hands
the message to `onPublish`; it does not send it, and cannot — the package
is bundled for the browser, so no broker client may live in it. This
package is what "send it" means.

```js
import { publishMessages, runBus } from '@mdy-docs/mdy-bus';
import { openScriptSite } from 'mdy-docs';

// sending: what a build collected, flushed once the build succeeded
await publishMessages(messages, { url: 'http://127.0.0.1:8080' });

// receiving: render whichever page each message names
const bus = await runBus(await openScriptSite('./site'), { broker: 'http://127.0.0.1:8080' });
```

Both are wired into mdy's own CLI already: `mdy build --publish` and
`mdy bus`.

## There is no subscribe

A message is addressed to a **page**, and a page is addressable because it
exists. Its name is its path without the extension, `/` written as `.`, so
`handlers/invoice.mdy` answers to `handlers.invoice` — declared nowhere,
registered nowhere, and overridable with `messageName` in front matter.

Delivered, the page renders with the message bound as `req`, exactly as
`$.render` binds it, plus `req.msg` carrying `{ name, index, attempts }`.
Nothing marks it as a handler, so the same page can be rendered inline by
another document and cannot tell which reached it.

## Delivery

One registration covers every page — `PUT /push/>` — because sukkal keys
receipts `<subject>/<consumer>`, making a pattern subscription already "N
ordinary subscriptions discovered by pattern instead of by name". Each
page gets its own receipt, its own lag and its own retry, and the broker
walks its matches round-robin so no page starves behind a busy one.

The HTTP response to a delivery **is** the acknowledgement:

- a render that throws does not ack, so the message comes back — pages
  reached this way have to be idempotent
- a batch is rendered in order and `X-Sukkal-Ack` reports how far it got,
  because a receipt is a high-water mark and cannot say "3 succeeded but
  2 did not"
- a name this set has no page for is acked and dropped, not refused;
  refusing would redeliver it forever

`runBus` takes an already-open document set rather than a directory. The
bus is a transport over *something that renders pages by name* — it has no
business knowing what a site directory is, and that is also what keeps
this package and mdy-docs from depending on each other in a circle.

See mdy-docs' `docs/messaging-plan.md` for why the design has no
`$.subscribe` and no request/reply verb.
