// mdy live preview — Monaco on the left, the rendered document set on the
// right. Based on mdy-docs/mdy-live-preview (itself a fork of tanabe's
// markdown-live-preview), ported to the current mdy-docs engine: `render` is
// async (the query engine and template VM are WebAssembly), documents split on
// `---`, front matter on `+++`, and the editor is seeded with
// examples/document-set.mdy — the "one entry document composes its siblings by
// query" example.
//
// The preview pane renders through @mdy-docs/react, so the document is a React
// subtree rather than an HTML string assigned to innerHTML. See Preview.jsx.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
