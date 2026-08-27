# @mdy-docs/mdy-web

A web-based site editor for [mdy](../..) script-defined sites — the
`mdy dev` dev loop, but with the browser as the editor and rebuilds
triggered by web saves instead of a filesystem watcher.

```sh
mdy-web [site-dir]        # default: the current directory; PORT=3000
# from this repo's root:
npm run mdy-web           # serves examples/blog
```

Then open `http://localhost:3000/__edit`. The site itself is served at `/`,
straight from the in-memory build.

## What it does

- **Edit any source file in Monaco** (vscode's editor component, bundled
  locally by the server — no CDN), tokenized by the SAME
  `mdy.tmLanguage.json` TextMate grammar the
  [vscode-mdy](../editors/vscode-mdy) extension contributes: shiki's
  pure-JS engine executes the grammar, `@shikijs/monaco` adapts it to
  Monaco's tokenizer and dark-plus theme. One grammar, every editor.
- **Live preview while typing**: the unsaved buffer is rebuilt through an
  overlay fs-provider (nothing touches disk), and every open page —
  including the editor's preview pane — live-reloads over SSE. Works for
  brand-new files too: the page exists before the file does.
- **Save = persist**: writes the file, rebuilds from disk. Optimistic
  concurrency — a file that changed on disk since it was loaded (an IDE,
  another tab) answers 409 with the disk state instead of being clobbered.
- **Upload binary assets** (images, fonts): raw-body PUT, extension
  allowlisted, then the usual rebuild.
- **Combined metadata view** for binary files: the raw-document record
  exactly as the site's document set sees it (identity + image
  width/height, via the engine's own `walkRawSources`), the file's
  `<path>.mdy` sidecar (front matter + body), and the two merged — with
  one-click create/edit of the sidecar.
- A failed rebuild (typing mid-statement, saving a broken template) keeps
  serving the last good build; the error comes back in the preview/save
  response.

No native dialogs anywhere (webviews suppress them) — all prompts are an
inline ask-bar.

## Boundaries

- Everything is consumed through package boundaries: the engine as
  `mdy-docs`, the grammar as `vscode-mdy` — both `file:` links while the
  APIs settle, the same pattern the engine uses for its own wasm
  submodules. The `file:` deps are also the publish guard: this package
  can't go to npm until they point at published versions.
- **No auth**: anyone who can reach the server can edit the site. Put auth
  in front of `/__edit` before exposing it beyond localhost.
- Only files under the site root are editable (never an imported theme
  package's), only with text/asset extensions, never through `..`.
