/*
 * Serve this package's directory so wasm/index.html can load the engine.
 *
 *   make serve-wasm            # then open http://localhost:8080/wasm/
 *
 * A file server and nothing else — no dependency, because the one thing a
 * generic static server gets wrong here is the type of a `.mjs` file, and a
 * module served as text/plain is a blank page with one console line.
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = join(root, normalize(path));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404); res.end('not found'); return; }
  if (!st.isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`http://localhost:${port}/wasm/`);
});
