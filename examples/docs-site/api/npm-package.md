# npm package

```sh
npm install @mdy-docs/lamassu-js
```

```js
import { createLamassu } from "@mdy-docs/lamassu-js";

const engine = await createLamassu();
console.log(await engine.eval("1 + 2 * 3")); // "⇒ 7"
```

The package is the engine's REPL surface compiled to a WebAssembly ES
module, wrapped in a small friendly API. It works the same way in Node and
the browser; in native ESM the sibling `.wasm` is located automatically via
`import.meta.url`.

## `createLamassu(options?)`

```ts
function createLamassu(options?: {
  wasmUrl?: string;
  print?: (text: string) => void;
  natives?: Record<string, (...args: any[]) => any>;
}): Promise<Lamassu>;
```

- **`wasmUrl`** — explicit URL for `lamassu.wasm`. Only needed when a
  bundler (Vite, webpack, …) relocates the module — import it with
  `import wasmUrl from "@mdy-docs/lamassu-js/lamassu.wasm?url"` and pass it
  through. Omit for plain native ESM.
- **`print`** — sink for the engine's *internal* stdout. Rarely needed;
  a script's `print(...)` calls are captured and returned by `eval` anyway.
- **`natives`** — an object of host functions callable from guest code via
  `__hostcall(name, argsJson)`. Any of them may be `async` — see
  [Async & host calls](/guide/async#2-hostcall-name-argsjson-synchronous-looking-asyncify-powered).

Resolves to a `Lamassu` instance:

## `engine.eval(source)`

```ts
eval(source: string): Promise<string>;
```

Evaluates `source` in a **persistent REPL context** — top-level `let`,
`const`, and `function` declarations carry across calls, so a sequence of
`eval` calls behaves like a REPL session, not independent scripts.

The resolved string is the script's `print(...)` output, followed by:

- `"⇒ " + <completion value>` on success, or
- `"Uncaught " + <error>` if the script threw.

`eval` never rejects for a *guest* error (a thrown exception inside the
script) — it resolves with the `"Uncaught ..."` line either way. It's
`async` because a guest `__hostcall` may suspend WASM execution while a
native runs.

```js
await engine.eval("let x = 40;");
await engine.eval("print('hi'); x + 2;");
// => "hi\n⇒ 42"
```

## `engine.setNatives(next)`

```ts
setNatives(next?: Record<string, (...args: any[]) => any>): void;
```

Replaces the natives table wholesale — useful for swapping in a different
set of host functions per request/task without recreating the engine.

## `engine.reset()`

```ts
reset(): void;
```

Discards all REPL state (every persistent global, every module) and starts
from a fresh VM + context. The natives table is untouched.

## `engine.module`

The underlying Emscripten module object (`M` from
`createLamassuModule(...)`), for advanced use — e.g. calling an exported C
function directly via `module.ccall`/`module.cwrap` that isn't wrapped by
this API yet.

## Errors vs. exceptions

A **syntax error** in `source` and a **runtime exception** thrown by the
guest script both surface the same way: as an `"Uncaught ..."` /
`"SyntaxError: ..."` line in the resolved string, never as a rejected
promise. The promise only rejects for a genuine host-side failure (e.g. the
WASM module failing to instantiate).
