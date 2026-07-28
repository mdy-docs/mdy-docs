// Live-preview server for the Sublime package: a long-lived Node process
// that imports the mdy engine ONCE (wasm init is the expensive part, ~50ms
// renders after that), accepts buffer pushes from the editor, and streams
// rendered HTML to the browser over SSE — the page swaps content in place,
// no reloads. The same shape as the vscode extension's webview preview and
// mdy-web's live loop, reduced to one file.
//
//   node preview_server.mjs --engine /path/to/mdy-docs
//
// Binds 127.0.0.1 on an ephemeral port and prints "PORT=<n>" on stdout —
// the Sublime plugin reads that line. Endpoints:
//   GET  /         the preview page (connects to /events)
//   GET  /events   SSE; new clients get the latest render immediately
//   PUT  /buffer   raw mdy text (X-Mdy-Title header names the tab);
//                  renders and broadcasts, render errors broadcast as an
//                  error panel instead of killing anything
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const engineArg = process.argv.indexOf('--engine');
if (engineArg === -1 || !process.argv[engineArg + 1]) {
  console.error('usage: node preview_server.mjs --engine <mdy-docs dir>');
  process.exit(2);
}
const { render } = await import(pathToFileURL(join(process.argv[engineArg + 1], 'index.js')).href);

let last = { title: 'mdy preview', html: '<p class="waiting">Waiting for content from Sublime…</p>' };
let renderVersion = 0;
const clients = new Set();

const broadcast = () => {
  const data = `data: ${JSON.stringify(last)}\n\n`;
  for (const res of clients) res.write(data);
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mdy preview</title>
<style>
  body { margin: 0 auto; max-width: 780px; padding: 2rem 1.5rem 4rem;
         font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2328; }
  @media (prefers-color-scheme: dark) { body { background: #1b1b1f; color: rgba(255,255,245,.86); }
    a { color: #7a9df0; } pre { background: #161618 !important; } code { background: #26262b; } }
  pre { background: #f6f6f7; padding: 1em 1.2em; border-radius: 8px; overflow-x: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  table { border-collapse: collapse; } th, td { border: 1px solid #8884; padding: .35em .8em; }
  .waiting { color: #888; font-style: italic; }
  .mdy-error { color: #c0392b; white-space: pre-wrap; }
  img { max-width: 100%; }
</style>
</head>
<body>
<div id="content"><p class="waiting">Connecting…</p></div>
<script>
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const { title, html } = JSON.parse(e.data);
    document.title = title + ' — mdy preview';
    document.getElementById('content').innerHTML = html;
  };
</script>
</body>
</html>
`;

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 500\n\n');
    res.write(`data: ${JSON.stringify(last)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'PUT' && req.url === '/buffer') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const title = req.headers['x-mdy-title'] || 'mdy preview';
      const version = ++renderVersion;
      let html;
      try {
        html = await render(text);
      } catch (err) {
        html = `<pre class="mdy-error">${String(err && err.message ? err.message : err)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
      }
      if (version === renderVersion) {
        // a fast typist can outrun the renderer; only the newest wins
        last = { title, html };
        broadcast();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(0, '127.0.0.1', () => {
  console.log(`PORT=${server.address().port}`);
});
