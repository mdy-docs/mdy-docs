No front matter here, no `+++` line — this file is `.md`, not `.mdy`, so it is
never compiled as a script: what is written is what renders, in CommonMark,
verbatim. Below is a thematic break, which in `.mdy` land would be mdy's own
document separator:

---

That `---` above did **not** split this file in two. Neither does a literal
script line: `% this stays exactly as typed` and so does `{{ this too }}`.
Markdown has no idea those mean anything, and nothing reaches in to tell it —
this file goes through its own front end and comes out as a tree, the same kind
of tree an `.mdy` file makes, having never been anything else along the way.

A fenced code sample, the way any real post would actually use one:

```js
const config = { retries: 3 };
```

The `}` in that snippet does not do anything special either.

Still taggable, though: #wet clay and #history, spotted the ordinary way.
