/*
 * $.publish — a VM-callable native (mdy-docs' options.natives, see
 * ./mdy.js) that lets a document call ANOTHER document later, durably,
 * instead of inline:
 *
 *   % $.render('invoice', order)    // now: renders, returns a tree
 *   % $.publish('invoice', order)   // later: queued, survives a restart
 *
 * Two tenses of one operation, which is why a message is addressed to a
 * PAGE and not to a topic. There is no $.subscribe to go with this and
 * there will not be one: a render is one-shot — the pooled VM instance is
 * reset and released when the eval returns (src/vm.js) — so a guest
 * closure cannot be parked across renders the way a hast tree can, and
 * any callback-registration API would be fighting the engine rather than
 * the transport. Nothing registers anything; a name resolves to a page or
 * it doesn't. See docs/messaging-plan.md for the whole argument.
 *
 * This module is the NAMING half: what a page is called, and what a legal
 * name is. The native itself is fixed in ./mdy.js beside $.emit, which is
 * where the address book lives because that is where the documents are.
 *
 * Nothing here or there is a broker client, deliberately. src/serve.js
 * already records that this package is bundled for the browser and that
 * Rollup statically rejects a Node builtin merely REACHED by the bundle,
 * so a transport in src/ breaks it. Core resolves a name and hands the
 * message to `onPublish`; who sends it, where, and whether at all belongs
 * to the embedder — the same split $.emit has with onEmit, for the same
 * reason (mdy has no opinion on what "produce an output" means, and none
 * on what "send" means either). @mdy-docs/mdy-bus is one such embedder.
 *
 * Publishes are DEFERRED, which is not fastidiousness. `mdy dev` reruns the
 * entry from scratch on every save (script-site.js); a publish that went out
 * during the render would re-fire on every keystroke. Nor does the render
 * memo quietly swallow one: a render that publishes is never stored, so its
 * effect is always made afresh (src/mdy.js). The hook only ever
 * collects, and the caller flushes once the whole build has succeeded.
 * That is also why $.publish returns null instead of the message's index
 * in the log: at call time there is no index yet, because nothing has
 * been sent.
 */

/*
 * sukkal's subject grammar, which a name has to land inside as-is so that
 * nothing needs escaping on the wire: 1–128 bytes of [A-Za-z0-9_.-], no
 * leading or trailing dot, no "..". A subject there is a file name (one
 * <subject>.elog per name), which is where the grammar comes from.
 */
const NAME_CHARS = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * A document's message name: `messageName` from its front matter if it
 * declares one, else its path with the extension dropped and directory
 * separators turned into dots — `handlers/invoice.mdy` → `handlers.invoice`.
 *
 * Deliberately NOT `data.name`, which looks like the obvious key and is
 * already taken twice over: every raw source carries `name` as its file's
 * base name (src/vault.js's walkRawSources), and a YAML data record
 * commonly declares its own (a person's name, a product's). Reusing it
 * would make an author's data silently readdress their messages.
 *
 * Returns null for a document with no usable path, which is not an error
 * here — most documents in a set are never published to, and a name is
 * only required of the ones that are.
 *
 * @param {object} data a document's data
 * @returns {string | null}
 */
export function messageName(data) {
  const declared = data?.messageName;
  if (typeof declared === 'string' && declared !== '') return declared;
  const path = data?.path;
  if (typeof path !== 'string' || path === '') return null;
  return path.replace(/\.[^./]*$/, '').replace(/\//g, '.');
}

/**
 * Why `name` is not a legal message name, or null if it is. Split out from
 * the native so a host can check a name it derived itself (script-site.js
 * skips documents whose path cannot make one) without going through a
 * publish.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function nameProblem(name) {
  if (typeof name !== 'string' || name === '') return 'must be a non-empty string';
  if (!NAME_CHARS.test(name)) {
    return `may only contain letters, digits, "_", "." and "-", and must be 1–128 characters (got ${JSON.stringify(name)})`;
  }
  if (name.startsWith('.') || name.endsWith('.')) return 'must not start or end with "."';
  if (name.includes('..')) return 'must not contain ".."';
  return null;
}
