# sublime-mdy

Sublime Text support for [mdy](../../..) documents: a native
`mdy.sublime-syntax` (front matter, document separators, `{{ }}` / `{% %}`
tags with JS highlighting — including inside headings and list items),
headings in the symbol list (Cmd+R), Toggle Comment, and a
render-and-open-in-browser preview via the mdy CLI.

## Install

Copy (or symlink) this directory into Sublime's `Packages/` folder:

```sh
# macOS
ln -s "$(pwd)" ~/Library/Application\ Support/Sublime\ Text/Packages/sublime-mdy
# Linux
ln -s "$(pwd)" ~/.config/sublime-text/Packages/sublime-mdy
```

`.mdy` files pick up the syntax automatically. For the preview command,
the mdy CLI must be reachable — `npx mdy` by default, but GUI-launched
Sublime doesn't inherit your shell PATH, so in practice set absolute
paths in your **User** `mdy.sublime-settings`:

```json
{
    "mdy_command": ["/absolute/path/to/node", "/path/to/mdy-docs/bin/mdy.js"]
}
```

## The grammar: a native port, deliberately

The vscode extension's `mdy.tmLanguage.json` is the canonical grammar. A
mechanical tmLanguage→plist conversion was tried first and abandoned:
Sublime's TextMate compatibility layer has no `injections` support, and
that table is load-bearing — without it the embedded markdown grammar
claims every body context and tags never highlight at all. A
`with_prototype` wrapper was tried next and hit Sublime's compiler
recursion limit. The working design is the one Sublime's own PHP syntax
uses to embed HTML: `extends` the whole Markdown syntax and inject the
mdy rules through the `prototype` context (`meta_prepend`) — so this
package hand-ports the grammar natively: same regexes,
same scope names, same engine-mirroring rules (tags close at the FIRST
`}}` / `%}` like the engine's `indexOf`; strings/comments are guarded
against the closer; the real JS syntax is NOT embedded inside `{% %}`
because its brace regions would swallow the closer of a tag whose braces
deliberately don't balance).

**This is a second grammar and can drift.** When `mdy.tmLanguage.json`
changes, update `mdy.sublime-syntax` to match. `syntax_test_mdy.mdy` pins
the important behavior — open it in Sublime and run Build (Cmd+B) to
execute the assertions.

The plugin needs Sublime's modern plugin host — `.python-version` (3.8)
is part of the package; don't delete it (the legacy 3.3 host lacks
`subprocess.run`).

## Preview

`mdy: Open Live Preview in Browser` (command palette) opens a browser page
that re-renders AS YOU TYPE — saved or not: the plugin ships a small Node
server (`preview_server.mjs`) that imports the engine once, receives the
buffer on every (debounced) modification, and streams rendered HTML to the
page over SSE, swapped in place with no reloads. Like the vscode preview
and the CLI's file input, the file renders alone: its own `---`-split
documents, first document as entry, no site walk. Render errors show in
the page; plugin errors land in an output panel.

The live path needs `mdy_command` pointing at a checkout
(`["node", "/path/to/mdy-docs/bin/mdy.js"]`) so the server can import the
engine. With the `npx` default it falls back to a one-shot snapshot
render.

## Known limitations

- Front matter at the very start of a file is recognized by a one-line
  heuristic (first line looks like `key:`, or is `+++`), the same
  approximation the vscode grammar documents — a TextMate-style engine
  tokenizes line by line and cannot confirm a later `+++`.
- Embedded markdown/YAML coloring resolves against Sublime's own
  Markdown and YAML syntaxes.
- Curly-brace matching is disabled in mdy files (syntax-specific
  `match_brackets_braces: false`): a `{% %}` tag legitimately opens a JS
  brace it closes in a later tag, so a character-based matcher pairs it
  with the `}` of `%}`. The vscode extension's language configuration
  makes the same call — its bracket pairs are `{% %}`/`{{ }}`, never lone
  braces (Sublime has no multi-character pairs, hence the off switch).
  `( )` and `[ ]` matching stay on.
