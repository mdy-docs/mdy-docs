# What is lamassu-js?

lamassu-js is a JavaScript engine written in C, covering a deliberately
restricted subset of the language, compiled to WebAssembly. It exists to run
**untrusted scripts** — for example, expressions and small snippets inside a
web-framework templating language — without giving them access to anything
outside the sandbox.

It ships as:

- **[`@mdy-docs/lamassu-js`](/api/npm-package)** — an npm package exposing the
  engine as a WebAssembly ES module, for use in Node or the browser.
- A native C library (`liblamassu`) and a command-line tool (`lamassu`), for
  embedders working directly in C — see the
  **[C embedding API](/api/c-embedding)**.
- A [browser playground](https://mdy-docs.github.io/lamassu-js/) with a
  persistent-VM REPL, so you can try the language without installing
  anything.

## Why a subset?

Full ECMAScript conformance is not the goal — matching Node closely enough
for the shared subset is. Every feature that's missing (see
[Deviations from real JS](/guide/deviations) and the non-goals in
[Supported syntax](/guide/language)) is a scoping decision made for one of
two reasons: it isn't needed for a templating workload, or it would
meaningfully complicate the "safe to run untrusted code" story (`eval`, the
`Function` constructor, and sloppy mode are the clearest examples of the
latter).

## Quick example

```js
// via @mdy-docs/lamassu-js
import { createLamassu } from "@mdy-docs/lamassu-js";

const engine = await createLamassu();
const output = await engine.eval(`
  const items = [{ name: "a", qty: 2 }, { name: "b", qty: 5 }];
  items.map(i => \`\${i.name}: \${i.qty}\`).join(", ");
`);
console.log(output); // "⇒ a: 2, b: 5"
```

Guest code can also call back out to the host — see
[Async & host calls](/guide/async) for how a native function can run
something that takes real time (a database query, a fetch) while the guest
sees an ordinary call.

## Where to go next

- **[Supported syntax](/guide/language)** — what JavaScript constructs
  compile, and which ones are deliberately rejected.
- **[Built-ins](/guide/builtins)** — the global objects and methods
  available to guest code.
- **[Deviations from real JS](/guide/deviations)** — places the subset's
  behavior differs from Node's, tracked so differential testing has a
  baseline.
- **[API Reference](/api/)** — embedding the engine, from JavaScript or C.
