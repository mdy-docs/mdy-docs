# vscode-mdy

VSCode support for `.mdy` documents: syntax highlighting, front-matter
folding, an outline of the file's documents, and a live rendered preview.

An `.mdy` file is markdown with optional YAML front matter (split from the
body by a bare `+++` line, not `---`) and embedded JS template tags —
`{{ expr }}` output tags and `{% ... %}` code tags (see the root
[README](../../README.md) and [src/mdy.js](../../src/mdy.js)). A single
file may hold several documents, split on bare `---` lines.

What the extension provides:

- **Highlighting** — mdy's own syntax (front matter, `---` separators,
  tag delimiters, `\{{`/`\{%` escapes) recognized by a hand-written
  TextMate grammar; markdown body and YAML front matter highlighted by
  VSCode's own bundled grammars via the standard `include` mechanism. Tag
  interiors get a deliberately small, self-contained JS ruleset — see
  "Why tags don't embed the real JS grammar" below. `---` and `+++`
  lines carry a `markup.heading.*` scope on top of their punctuation
  scope, so themes render the file's structural seams bold instead of
  dim.
- **Folding** — each front-matter block folds to its first line.
  (Per-document folding was tried and removed: whole-document ranges
  nested awkwardly with markdown's own folding — navigating between
  documents is the outline's job.)
- **Outline / breadcrumbs / Ctrl+Shift+O** — one symbol per document,
  named by its front-matter `title:` (`document N` otherwise), with the
  engine's document index as the detail — the same `i` a template passes
  to `$.render(i)` / `$.data(i)`.
- **Preview** — a rendered view of the file beside the editor, live as
  you type. See below.

## Preview

The preview buttons in the editor title open a webview — beside the
editor (`mdy: Open Preview to the Side`, `Ctrl+K V` / `Cmd+K V`) or
full-size in the editor's own group (`mdy: Open Preview`,
`Ctrl+Shift+V` / `Cmd+Shift+V`), the same pair the built-in markdown
preview offers. Either way it shows exactly what
`mdy <file> --html` prints: the file's own `---`-split documents form a
set, the FIRST document is the entry, and its output renders through the
same rendering pipeline. Like the CLI's file input, the file
renders alone — no site walk, no access to sibling files. Templates run
in the engine's usual wasm sandbox, so re-rendering on every keystroke
(debounced, like `--watch`) is safe.

Worth knowing:

- **Any `.mdy` file previews, engine or no engine.** The extension
  bundles the engine (`dist/mdy-engine.mjs` plus the lamassu and nisaba
  wasm binaries, built by `scripts/bundle-engine.mjs` at package time),
  so a file in a workspace with no mdy-docs anywhere — or an unsaved
  buffer — still renders. When the previewed file's project DOES carry
  the engine (the nearest `node_modules/mdy-docs` walking up from the
  file, or a checkout of mdy-docs itself — which is what makes this
  repo's `examples/` previewable), that copy is preferred over the
  bundle, the way the eslint/prettier extensions resolve their library:
  the preview then matches the engine version the project actually
  builds with.
- **Errors render in place** — a failing template shows the engine's
  message where the content would be, and the next keystroke re-renders,
  same as `--watch`.
- **`$.emit` output is reported, not written** — a footnote lists the
  emitted paths, mirroring the CLI's "not written" notice when no
  `--out` directory is given.
- **Relative image/media paths resolve against the file** (root-absolute
  ones against the workspace folder), rewritten to webview URIs so they
  actually load.

Implementation: [src/preview.cjs](src/preview.cjs) (pure: engine
resolution, the render pipeline, URL rewriting, the webview shell —
unit-tested in [test/preview.test.js](test/preview.test.js) with the real
engine as the oracle); [extension.cjs](extension.cjs) only adapts it to
the webview API.

## Install locally

```sh
cd packages/editors/vscode-mdy
npx @vscode/vsce package
code --install-extension vscode-mdy-<version>.vsix
```

Or, for local iteration without packaging: open this folder in VSCode and
press F5 to launch an Extension Development Host with it loaded.

## How the grammar works

[syntaxes/mdy.tmLanguage.json](syntaxes/mdy.tmLanguage.json) is a
TextMate grammar. Three things are worth understanding before touching it.

**Line-at-a-time tokenization.** A `begin` pattern can never look ahead
into a later line to check, say, whether a bare `+++` eventually shows up
(which is the *real* rule `src/mdy.js`'s `FRONT_MATTER_SEPARATOR` uses).
Front matter detection here is therefore a same-line heuristic (does
*this* line look like a YAML `key:` entry, or is it `+++` itself — an
explicitly-allowed empty front-matter block) rather than the real rule.
The one case this gets wrong: a body with no front matter at all whose
very first line happens to read like `Key: value`. See
`document-separator`'s comment in the grammar for why its `end` pattern
is `(?=[^\n])` and not the more obvious `(?=[\s\S])`.

**The injection is load-bearing.** The markdown grammar claims headings,
list items, emphasis, tables, quotes… as its own begin/end contexts, and
inside those contexts the mdy grammar's top-level patterns are never
consulted — `# {{ title }}` would lose its tag delimiters entirely. The
grammar's `injections` entry re-injects the escape/tag/separator rules
with `L:` priority into every markdown context (excluding open tags and
front matter, where `{{ }}` is literal YAML).

**Why tags don't embed the real JS grammar.** mdy deliberately allows
unbalanced braces across tags (`{% for (...) { %}` … `{% } %}`), and the
real `source.js` grammar opens a brace-block *region* on that `{` which
swallows the `%}` — a region's end pattern is only consulted while it is
top-of-stack. Tag interiors instead use a small region-free JS ruleset
(keywords, strings, comments, numbers, `$`) whose string/comment rules
are guarded so nothing can span a closer: the tag closes at the FIRST
`%}` / `}}`, exactly like the engine's `indexOf`. Relatedly, the JS
language mapping (`meta.embedded.line.mdy` → javascript in
`embeddedLanguages`) is applied via `contentName`, so the delimiters
themselves stay mdy-language punctuation — which, with
`colorizedBracketPairs: []` in the language configuration, keeps
bracket-pair colorization from painting `{{ }}` as nested code braces
while real JS braces inside a tag keep JavaScript's own bracket behavior.

## Folding and outline

[extension.cjs](extension.cjs) registers a `FoldingRangeProvider` and a
`DocumentSymbolProvider`; all real logic is in
[src/structure.cjs](src/structure.cjs), a pure engine-mirroring scan
(bare `---` splits, first bare `+++` ends front matter, whitespace-only
chunks drop — so the outline's `#index` details are exactly the engine's
document indexes).

## Testing

No VSCode install required — `npm test` runs everything headless:

- `test/tokenize.test.js` drives the compiled grammar with
  `vscode-textmate`/`vscode-oniguruma` (the same engine VSCode uses)
  against VSCode's REAL bundled markdown grammar, vendored into
  `test/fixtures/` — an empty markdown stub passes trivially (nothing
  competes for `# {{ title }}`) and is exactly the false confidence that
  shipped 0.0.1's missing-delimiter bugs. Unrelated embedded scopes
  (`source.js`, `source.yaml`, fence languages…) stay stubbed empty: an
  unresolved `include` poisons its entire containing rule, and where
  regions start/end is what's under test, not their interior coloring.
- Both test files end in a **sweep over every `examples/**/*.mdy`** in
  the repo, with the engine as the oracle: tokenize asserts every tag
  delimiter `compileTemplateSource` would honor is highlighted (and no
  others), structure asserts `scanDocuments` agrees with
  `parseDocuments` on document counts and titles.

```sh
npm install
npm test
```

## Installing

- **VS Code**: install the `.vsix` (`code --install-extension vscode-mdy-<version>.vsix`), or from the Marketplace if published there.
- **Cursor / Windsurf / VSCodium / Theia** and other Open VSX consumers:
  search for "mdy" once published, or install the same `.vsix` directly —
  it is the identical artifact.

## Publishing to Open VSX

The registry [open-vsx.org](https://open-vsx.org) serves VS Code-compatible
editors that don't use Microsoft's marketplace. One-time setup:

1. Log in at open-vsx.org (GitHub auth), sign the Eclipse publisher
   agreement, and create the `mdy-docs` namespace:
   `npx ovsx create-namespace mdy-docs -p <token>`.
2. Generate an access token in your Open VSX user settings.

Then each release:

```sh
npm run package                       # builds vscode-mdy-<version>.vsix (bundles the engine first)
OVSX_PAT=<token> npm run publish:open-vsx
```

`ovsx publish` re-packages from the working tree by default; it verifies
the `publisher` field matches the namespace. Bump `version` in
package.json for every publish — registries reject re-used versions.
