# API Reference

lamassu-js has two embedding surfaces:

- **[npm package](/api/npm-package)** — `@mdy-docs/lamassu-js`, the engine
  compiled to a WebAssembly ES module with a small JS wrapper. Use this from
  Node or the browser.
- **[C embedding API](/api/c-embedding)** — the native `liblamassu` C library
  (`include/lamassu.h`), for embedders working directly in C, or building their
  own bindings for another host environment.

Both sit on top of the same core: a portable C11 interpreter with no static
globals — every function takes a `JsVm` or `JsContext` handle explicitly, so
multiple independent engine instances can coexist in one process. The npm
package is a thin Emscripten-compiled wrapper around exactly this C API; if
you're embedding from C directly, the [C embedding API](/api/c-embedding)
page is the ground truth.

See [Async & host calls](/guide/async) for how the two relate on the async
side: the npm package's `__hostcall` is a synchronous-looking guest call
built on Emscripten Asyncify (it suspends the whole WASM call stack), while
the C API's `js_promise_new`/`js_resolve`/`js_run_jobs` is the lower-level,
host-neutral mechanism behind ordinary guest-level `await` of a
native-returned promise — two complementary mechanisms, not one built on
the other.
