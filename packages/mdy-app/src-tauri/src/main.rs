// Phase 1, first move: find out whether the webview will register a Service
// Worker under Tauri's own origin. See docs/desktop-plan.md — the preview
// design rests on one, the check that proved the model ran over http://, and
// Tauri does not serve the app over http:// on macOS or Linux.
//
// The window does nothing else. It reports what the webview said and exits, so
// the answer arrives in a terminal rather than needing somebody to look at it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn report(origin: String, result: String) {
    println!("--- service worker probe ---");
    println!("origin: {origin}");
    println!("result: {result}");
    std::process::exit(0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![report])
        .run(tauri::generate_context!())
        .expect("mdy-app failed to start");
}
