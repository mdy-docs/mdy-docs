/*
 * mdy as a dynamic page engine behind Express.
 *
 * One .mdy file holds every page; openDocumentSet parses and compiles it
 * ONCE at startup, then each request is just: select a page document by
 * query, pass the request's info in as render context (front matter is the
 * page's defaults, caller data wins), markdown → HTML through the shared
 * processor, and wrap it in the `shell` document — rendered with
 * renderRaw, the byte-exact embedding path, because the shell's output is
 * raw HTML, not markdown to be normalized.
 *
 * Run from the repo root:            npm run example:express
 * Then:                              curl localhost:3000/profile?name=Ada
 *   curl -s localhost:3000/invoice -H 'content-type: application/json' \
 *     -d '{ "number": 42, "items": [{ "name": "Tablets", "price": 19.5 }] }'
 *
 * (Outside this repo you would `npm install mdy-docs express` and import
 * from 'mdy-docs' instead of the relative path.)
 *
 * Notes for real use:
 *  - Render context crosses the wasm sandbox as JSON — plain data only.
 *  - Query-string values arrive as strings (or arrays); coerce in the
 *    template or the route. JSON bodies keep their types.
 *  - Raw HTML passes through the pipeline by design, so escape or
 *    sanitize any END-USER text you pass in; the sandbox protects the
 *    host, not the page.
 *  - The set is compiled once; restart (or re-open the set on a file
 *    watcher, e.g. mdy's watchByPolling) to pick up edits to pages.mdy.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { openDocumentSet, createProcessor } from '../../index.js';

const source = readFileSync(new URL('./pages.mdy', import.meta.url), 'utf8');
const set = await openDocumentSet(source);
const { renderMarkdown } = createProcessor();

/** Render one page document with the caller's info, wrapped in the shell. */
async function renderPage(name, info) {
  const meta = await set.findOne({ page: name });
  if (!meta || name === 'shell') return null;
  const content = await renderMarkdown(await set.render({ page: name }, info));
  return set.renderRaw({ page: 'shell' }, { title: meta.title, content });
}

const app = express();
app.use(express.json());

app.get('/', (req, res, next) => {
  renderPage('home', req.query)
    .then((html) => res.type('html').send(html))
    .catch(next);
});

// GET /profile?name=Ada — query params as info; POST /invoice — JSON body as info.
app.all('/:page', (req, res, next) => {
  const info = req.method === 'POST' ? req.body : req.query;
  renderPage(req.params.page, info)
    .then((html) => (html === null ? res.status(404).send('no such page') : res.type('html').send(html)))
    .catch(next);
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`mdy pages on http://localhost:${port}`));
