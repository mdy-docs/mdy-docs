No front matter here, no `+++` line — this file is `.md`, not `.mdy`, so
it's never compiled as a template: what's written is what renders,
verbatim. Below is a thematic break, which in `.mdy` land would be mdy's
own document separator:

---

That `---` above did **not** split this file in two. Neither does a
literal template tag rendering as text: `{{ this stays exactly as typed }}`
and so does `{% this too %}`.

A fenced code sample, the way any real post would actually use one:

```js
const config = { retries: 3 };
```

The `}` in that snippet, and the one two paragraphs up, don't do anything
special — this whole document went straight to the markdown renderer with no
template pass at all.

Still taggable, though: #wet clay and #history, spotted the ordinary way.
