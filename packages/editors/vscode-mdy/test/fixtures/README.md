`markdown.tmLanguage.json` is VSCode's own bundled markdown grammar
(microsoft/vscode, extensions/markdown-basics — MIT licensed), vendored so
tokenize.test.js exercises the mdy grammar against the REAL host grammar it
injects into inside VSCode, instead of an empty stub. An empty stub passes
trivially: nothing competes for `# {{ self.title }}` or `- {{ self.x }}`, so the tag
rules always win — precisely the false confidence that let headings/lists
swallow tag delimiters in the shipped extension. Refresh by copying from a
current VSCode install; no local edits.
