Empty for now.

This directory held `markdown.tmLanguage.json`, VSCode's own bundled markdown
grammar, vendored so tokenize.test.js could exercise the mdy grammar against
the real host grammar it injected into. That grammar is gone: MDY is not
Markdown, every one of its block rules is anchored to the start of its own
line, and `mdy.tmLanguage.json` no longer includes or injects into anything.
There is no host grammar left to be honest about.
