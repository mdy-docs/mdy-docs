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

A shell that serves a site to a navigable preview. Rust owns `mdy://` and, for
each request, asks the webview — which holds the built outputs — through an
asynchronous protocol handler. Running it prints the round trip:

```
[web] listening
[web] request 0 / -> index.html
[web] responded 0
[web] iframe loaded
[web] request 1 /uruk/ -> uruk/index.html
[web] responded 1
```

The second request is the one that matters: a link clicked inside a served page
reached another served page. That is what `srcdoc` cannot do and the reason for
the protocol. The outputs are still a fixed pair of pages — rendering a real
directory is next, and changes only where `outputs` comes from.

Two things this cost a build cycle each, so they are written down:

- **Listening for events needs a capability.** `core:default`, in
  `src-tauri/capabilities/`. Without it `event.listen` rejects; and since the
  preview hangs off that one call, the window sits there doing nothing rather
  than reporting an error.
- **The preview is a different origin from the shell** — `mdy://localhost`
  against `tauri://localhost`. The shell cannot read the iframe's DOM, and
  should not be able to. Anything it needs to know is observed from the serving
  side or sent by postMessage. That is why the check above watches for a second
  request instead of inspecting the page.

## What the Service Worker probe found

The preview design first rested on a Service Worker. **The answer is no, on
macOS and Linux.**

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
