// mdy as a native application — the shell.
//
// The webview builds the site and holds the outputs; this serves them. That
// split is deliberate and is the whole design (docs/desktop-plan.md): the
// document engine, the query engine and the site layer are the browser bundle,
// unchanged, and Rust does the two things a page cannot do for itself — open a
// window, and answer a URL.
//
// Answering a URL is the part that needs explaining. A preview has to be
// navigable: click a link in a rendered page and land on another rendered page,
// with relative `static/` URLs resolving. `srcdoc` cannot do that. A Service
// Worker could, and was the first design, but WKWebView refuses to register one
// on the custom scheme Tauri serves a built app from — see the package README
// for the probe that settled it.
//
// So the shell registers `mdy://` and, for each request, asks the webview which
// already has the page. The handler is ASYNCHRONOUS so it can wait for that
// answer without blocking the webview that has to produce it. A reader
// navigates one page at a time, so this is about one round trip per navigation
// rather than copying every output across the boundary on every rebuild.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{http::Response, Emitter, Manager, UriSchemeResponder};

/// Requests the shell has asked the webview about and not yet heard back on.
///
/// A responder can only be used once and cannot be cloned, so it is parked here
/// under an id until the answer arrives. Nothing expires an entry: a webview
/// that never answers leaves a pending request and a spinning iframe, which is
/// a bug in the frontend rather than a state the shell should paper over.
#[derive(Default)]
struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, UriSchemeResponder>>,
}

/// What the webview sends back for one request.
#[tauri::command]
fn respond(
    pending: tauri::State<'_, Pending>,
    id: u64,
    status: u16,
    content_type: String,
    body: Vec<u8>,
) {
    let responder = pending.waiting.lock().unwrap().remove(&id);
    let Some(responder) = responder else {
        // Answered twice, or after a rebuild dropped the request. Not fatal:
        // the response is simply no longer wanted.
        return;
    };
    let response = Response::builder()
        .status(status)
        .header("content-type", content_type)
        // The preview is a different origin from the app that renders it, and
        // asks for its own pages from inside an iframe.
        .header("access-control-allow-origin", "*")
        .body(body)
        .expect("a response with a valid status builds");
    responder.respond(response);
}

/// A line from the webview, printed as it happens. `report` ends the run;
/// this one does not, so the frontend can narrate what it is doing while it
/// still has the chance — a window that stops responding says nothing at all
/// otherwise.
#[tauri::command]
fn log(msg: String) {
    println!("[web] {msg}");
}

/// What the frontend saw, printed where a terminal can read it. The window is
/// checked by running it, and a check nobody can read is not a check.
#[tauri::command]
fn report(result: String) {
    println!("--- mdy-app ---");
    println!("{result}");
    std::process::exit(0);
}

fn main() {
    tauri::Builder::default()
        .manage(Pending::default())
        .register_asynchronous_uri_scheme_protocol("mdy", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let pending = app.state::<Pending>();
            let id = pending.next.fetch_add(1, Ordering::Relaxed);
            pending.waiting.lock().unwrap().insert(id, responder);

            // The path as the site knows it — `mdy://localhost/uruk/` is
            // `/uruk/`, which the frontend turns into `uruk/index.html` the
            // same way src/serve.js does.
            let path = request.uri().path().to_string();
            if app.emit("mdy://request", (id, path)).is_err() {
                // No window to ask. Take the responder back and fail the
                // request rather than leaving the load hanging.
                if let Some(r) = pending.waiting.lock().unwrap().remove(&id) {
                    r.respond(
                        Response::builder()
                            .status(503)
                            .header("content-type", "text/plain; charset=utf-8")
                            .body(b"mdy: no window to serve from".to_vec())
                            .expect("a 503 builds"),
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![respond, report, log])
        .run(tauri::generate_context!())
        .expect("mdy-app failed to start");
}
