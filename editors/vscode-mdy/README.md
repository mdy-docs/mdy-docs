# vscode-mdy

Syntax highlighting for `.mdy` documents in VSCode.

An `.mdy` file is markdown with optional YAML front matter (split from the
body by a bare `+++` line, not `---`) and embedded JS template tags —
`{{ expr }}` output tags and `{% ... %}` code tags (see the root
[README](../../README.md) and [src/mdy.js](../../src/mdy.js)). This
extension doesn't reimplement markdown, YAML, or JS highlighting — it's a
thin grammar that recognizes mdy's own syntax (front matter, `---` document
separators, tag delimiters, `\{{`/`\{%` escapes) and, everywhere else,
composes VSCode's own bundled `markdown`/`yaml`/`javascript` grammars via
the standard TextMate `include` mechanism. `{% %}` tag contents get real
JS-aware highlighting, not an approximation.

## Install locally

```sh
cd editors/vscode-mdy
npx @vscode/vsce package
code --install-extension vscode-mdy-0.0.1.vsix
```

Or, for local iteration without packaging: open this folder in VSCode and
press F5 to launch an Extension Development Host with it loaded.

## How the grammar works

[syntaxes/mdy.tmLanguage.json](syntaxes/mdy.tmLanguage.json) is a
TextMate grammar. The one thing worth understanding before touching it:
**VSCode tokenizes one line at a time** — a `begin` pattern can never look
ahead into a later line to check, say, whether a bare `+++` eventually
shows up (which is the *real* rule `src/mdy.js`'s `FRONT_MATTER_SEPARATOR`
uses). Front matter detection here is therefore a same-line heuristic
(does *this* line look like a YAML `key:` entry, or is it `+++` itself —
an explicitly-allowed empty front-matter block) rather than the real rule.
The one case this gets wrong: a body with no front matter at all whose
very first line happens to read like `Key: value` (e.g. `Note: see
below`). Not seen anywhere in this repo's own examples, and the same
class of trade-off long-standing Jekyll/Hugo-style "YAML front matter"
grammars make for the same reason.

`---`-separated multi-document `.mdy` files (see
[examples/document-set.mdy](../../examples/document-set.mdy)) get their
own per-chunk front matter, using the same heuristic re-armed right after
each separator — see `document-separator`'s comment in the grammar for
why its `end` pattern is `(?=[^\n])` and not the more obvious `(?=[\s\S])`
(vscode-textmate appends a synthetic trailing newline to every line it
hands to the tokenizer, which `[\s\S]` would match, closing the region one
line too early).

## Testing

`test/tokenize.test.js` drives the compiled grammar directly with
`vscode-textmate`/`vscode-oniguruma` (the same engine VSCode uses) and
asserts on the resulting token scopes — no VSCode install required. It
stubs `source.js`/`source.yaml`/`text.html.markdown` with empty pattern
lists (an unresolved `include` poisons its *entire* containing rule, so a
stub is needed for those to resolve at all) — those regions' own internal
highlighting is VSCode's bundled grammars' job, not this one's; what's
under test is where *our* regions start and end.

```sh
npm install
npm test
```
