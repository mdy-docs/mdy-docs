// mdy live preview, native — Monaco on the left, the rendered document set
// on the right, and the engine on the right is C: packages/mdy-native
// compiled to WebAssembly, driven as its command line is. A copy of
// ../mdy-live-preview (itself a fork of tanabe's markdown-live-preview)
// with the JavaScript engine taken out: the same chrome, the same seeded
// examples/document-set.mdy, the same messages pane — and one module in
// place of three, since the template VM, the query engine, the broker and
// the highlighter are all linked into the one binary.
//
// The preview pane is the HTML the engine wrote, sanitized and set as the
// pane's content — not a React subtree. See Preview.jsx for what that
// changes and native.js for the bridge.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
