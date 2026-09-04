# @mdy-docs/mdy-app

mdy as a native application: a window on the system webview, the browser bundle
inside it, and the filesystem reached through Tauri. See
[docs/desktop-plan.md](../../docs/desktop-plan.md) for why this shape and not
Electron, a bundled runtime, or a rewrite.

```sh
npm install
npm run dev      # tauri dev — serves the frontend over a localhost dev server
npm run build    # tauri build
```

## What is here right now

A shell that does one thing: report whether the webview will register a Service
Worker. That was Phase 1's first question, because the preview design depended
on the answer, and it is cheaper to ask than to assume.

**The answer is no, on macOS and Linux.**

```
origin: tauri://localhost
result: REFUSED — TypeError: serviceWorker.register() must be called with a
        script URL whose protocol is either HTTP or HTTPS
```

Tauri serves a built application from `<scheme>://localhost`, and WKWebView
will not register a worker on a custom scheme. It is not configurable:
`use_https_scheme` in tauri-utils applies to **Windows and Android only**.

### The trap worth remembering

Under `npm run dev` the same probe reports:

```
origin: http://127.0.0.1:1431
result: REGISTERED — scope http://127.0.0.1:1431/
```

`tauri dev` serves the frontend from a localhost HTTP dev server, so anything
that depends on the origin's scheme behaves differently there than in a real
build. Run the binary directly — `cd src-tauri && cargo run` — to see what the
application will actually do.

## Where this goes next

The preview becomes a custom protocol handled in Rust, with the outputs staying
in JavaScript and the handler asking for one page at a time. `tauriFsProvider`
implements the nine methods in [../../src/fs-provider.js](../../src/fs-provider.js)
against Tauri's `fs` plugin. Then the editor, then watching. The plan has the
order and the reasoning.

## Notes

`src-tauri/icons/icon.png` is a placeholder — a solid square, generated, because
`tauri::generate_context!()` will not link without one and requires **RGBA**
specifically. Phase 4 needs a real icon set (`.icns`, `.ico`, and the several
PNG sizes) before anything is bundled.
