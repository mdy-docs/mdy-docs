# obsidian-mdy

Obsidian support for [mdy](../../..) documents. `.mdy` files open in a
dedicated view with two modes, toggled from the view header (or the
"mdy: Toggle source / preview" command):

- **Preview** — the whole document set rendered live by the real engine:
  `---`-split documents, YAML front matter, ` ```data ` fences,
  `#hashtags`, the `$` query API, and `%` / `%%` / `{{ }}` script lines
  executing **sandboxed in WebAssembly**. Template code can reach exactly
  two things — the document's data and `$` — never your vault, never the
  app. Re-renders debounced as you type.
- **Source** — a plain monospace editor. Edits auto-save through
  Obsidian's normal file machinery.

Like the vscode extension's preview and the CLI's file input, a file
renders alone: its own documents form the set, the first is the entry —
no vault walk.

## Install

Not in the community plugin store (yet) — install manually:

```sh
node scripts/build.mjs    # builds + copies the engine into dist/
mkdir -p <vault>/.obsidian/plugins/mdy
cp -R manifest.json main.js styles.css dist <vault>/.obsidian/plugins/mdy/
```

Then enable "mdy" in Settings → Community plugins. Desktop only (the
engine is imported by file URL so its wasm loads from the plugin folder).

## One engine, every host

`dist/` is not built here — `scripts/build.mjs` runs the **vscode
extension's** own `bundle-engine.mjs`, then adapts its output for
Electron's renderer: the ESM bundle becomes `mdy-engine.cjs` (the
renderer blocks dynamic `import()` of file URLs, but Node `require()`
works), and the emscripten glue's `process.type == "renderer"` check is
patched so the wasm loads through Node `fs` instead of a (blocked)
`fetch`. Same engine as vscode, one deliberate conversion layer — see
the header of `scripts/build.mjs` for the full reasoning.

## Roadmap notes

- Source mode is a plain textarea; syntax highlighting would come from
  wiring the shared TextMate grammar into Obsidian's CodeMirror 6 (via
  shiki, as the Monaco editors do) — not done yet.
- Community-store submission needs this repo split or a release pipeline
  producing `main.js`/`manifest.json`/`styles.css` artifacts per release.
