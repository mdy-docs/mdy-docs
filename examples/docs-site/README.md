# docs-site — a VitePress-style docs site, built by mdy

The lamassu-js documentation site (originally a VitePress site), rebuilt as
an mdy script-defined site. What VitePress got from `.vitepress/config.mts`
plus its default theme, this site defines entirely in
[`main.mdy`](main.mdy) — the entry script: the config lives in its front
matter (nav, sidebar, social links, edit link, footer), and the script body
decides every page, URL, and layout via `$.find`/`$.render`/`$.emit`.

```sh
npm run dev     # mdy serve .  → http://localhost:4321, watch + live reload
npm run build   # mdy build . --out dist
```

## What maps to what

| VitePress | here |
| --- | --- |
| `.vitepress/config.mts` (title, nav, sidebar, editLink, footer…) | `main.mdy` front matter |
| routing convention (`guide/language.md` → a page) | the `main.mdy` script: every `.md` file becomes `/<stem>/index.html` |
| default theme layout (navbar, sidebar, "On this page", prev/next) | `layouts/base.mdy` + fragment builders in `lib/html.js` |
| `layout: home` hero + features front matter | [`index.mdy`](index.mdy) — a data-only mdy document; `index.html` is generated from it via `layouts/home.mdy` |
| `::: tip` / `::: warning` containers | `lib/md.js` `transformContainers` (text transform before `$.markdown`) |
| shiki syntax highlighting, copy buttons | `static/docs.js` (small client-side regex highlighter) |
| local search (minisearch) | `$.tokenize` → `search-index.json` + widget in `static/docs.js` |
| dark/light theme | CSS variables in `static/style.css` + toggle in `static/docs.js` |
| lastUpdated | file `mtime` from the raw document record |
| `public/` static assets | `static/` passthrough |

Notes on the mdy side of the port:

- **`main.mdy` is the entry script; `index.mdy` is the home page.** The
  entry defines the site; `index.mdy` is just data — its hero/features
  front matter is parsed by mdy's own document parser, and the script
  renders it through `layouts/home.mdy` into `index.html`.
- The guide/api content pages are plain `.md` files, byte-identical to what
  VitePress rendered. mdy never compiles `.md` as templates — their raw
  text arrives as `meta.body`, and the script does the interpreting.
- The `lib/*.js` modules run inside the sandboxed VM via
  `await import("./lib/…")` — plain string work, written against the
  engine's JS subset (no `new`, constructor-free).
- URLs are directory-style (`/guide/language/`) rather than VitePress's
  `.html` URLs; `lib/md.js` `rewriteLinks` adds the trailing slash to the
  content's internal `/guide/language`-style links.
