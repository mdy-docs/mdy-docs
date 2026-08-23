# sublime-mdy

Sublime Text support for [mdy](../../..) documents: a native
`mdy.sublime-syntax` (front matter, document separators, the MDY block and
inline rules, and `%` / `%%` / `{{ }}` with JS highlighting), headings in the
symbol list (Cmd+R), Toggle Comment, and a render-and-open-in-browser preview
via the mdy CLI.

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

The vscode extension's `mdy.tmLanguage.json` is the canonical grammar, and
this is a hand port of it: same regexes, same scope names, same
approximations (a `%%` block's extent is guessed from where a closing bracket
lands, because a line-based engine cannot count brackets; `{{ }}` closes at
the FIRST `}}` like the compiler's `indexOf`; strings and comments inside it
are guarded against that closer).

This file used to `extends` Sublime's Markdown syntax and inject the template
rules through `prototype`, which was the only way to make tag delimiters
highlight inside the contexts markdown claims for headings, lists and
emphasis — two other conversion routes were tried and abandoned before it. All
of that is gone, and not because a better trick was found: MDY is not
Markdown. Every one of its block rules is anchored to the start of its own
line, so the syntax is a flat list of line matches with no foreign grammar
underneath it and nothing to inject into.

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
- Embedded YAML coloring in front matter resolves against Sublime's own
  YAML syntax.
- A `%%` block's extent is a guess. It ends after the first line whose own
  first character is a closing bracket, and before any line that starts a new
  `%` — so an unusually written block paints a line or two of markup as
  JavaScript, and can never swallow the rest of the file.
- Curly-brace matching is disabled in mdy files (syntax-specific
  `match_brackets_braces: false`): a `%` line legitimately opens a brace it
  closes on a later `%` line, with markup in between, so a character-based
  matcher pairs it with something meaningless. The vscode extension's
  language configuration makes the same call. `( )` and `[ ]` matching stay
  on.
