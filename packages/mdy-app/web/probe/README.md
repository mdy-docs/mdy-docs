# Probes

Small pages that answer one question about the webview, kept because the
answers can change with an OS or WebKit update and are cheap to re-ask.

Point `frontendDist` at this directory (or open the file in the running app)
and run the binary directly — **not** `tauri dev`, which serves over a
localhost HTTP dev server and will give the wrong answer for anything that
depends on the origin's scheme.

## `sw.js` — can a Service Worker register?

Asked in September 2026: **no**, on macOS. `tauri://localhost` is a custom
scheme and WKWebView requires HTTP or HTTPS. `use_https_scheme` does not help;
it applies to Windows and Android only. The preview uses a Rust custom protocol
instead — see `../../src-tauri/src/main.rs`.
