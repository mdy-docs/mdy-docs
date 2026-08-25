/*
 * @mdy-docs/mdy-bus — the transport half of $.publish.
 *
 * mdy core resolves a message's name to a page and hands it to `onPublish`,
 * and forms no opinion about what happens next: src/serve.js records that
 * the package is bundled for the browser and that Rollup rejects a Node
 * builtin merely reached by the bundle, so a broker client cannot live
 * there. This package is one answer to "what happens next" — sukkal — and
 * an embedder that wants a different one writes a different package.
 *
 * Both directions are here:
 *
 *   publishMessages(messages, { url })   send what a build collected
 *   runBus(site, { broker })             receive, and render the page named
 *
 * Note what runBus does NOT take: a directory. It is given an already-open
 * document set (mdy-docs' `openScriptSite`), so this package depends on
 * mdy-docs only to test against — the bus is a transport over "something
 * that can render a page by name", not something that knows how to build a
 * site. That is also what keeps the two packages from depending on each
 * other in a circle.
 */
export { publishMessages } from './publish.js';
export { runBus, createDeliveryHandler, parseDelivery } from './bus.js';
