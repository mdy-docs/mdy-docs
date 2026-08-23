# mdy

Parse **MDY** markup into [hast][] (an HTML syntax tree), with [unified][].

MDY is a small markup language in the spirit of Markdown, but it is not
Markdown: indentation is structural, elements are written by opening them and
never closing them, and every inline construct is a toggle rather than a matched
pair of delimiters. Lists and tables are the parts it borrows wholesale, from
Markdown and from GitHub. Documents can also generate themselves, if you let
them (rule 12).

## Install

```sh
npm install mdy
```

## Use

```js
import {mdy} from 'mdy'

String(mdy().processSync('== Hello //there//'))
// → '<h2>Hello <em>there</em></h2>'
```

The parser emits hast directly, so the rest of the pipeline is ordinary
rehype — put any hast transform in between:

```js
import rehypeSlug from 'rehype-slug'
import {mdy} from 'mdy'

const file = mdy().use(rehypeSlug).processSync(document)
```

Or wire it up yourself:

```js
import rehypeStringify from 'rehype-stringify'
import {unified} from 'unified'
import {mdyParse} from 'mdy'

unified().use(mdyParse).use(rehypeStringify).processSync(document)
```

## The language

### 1. Headings

A line starting with `=` is a heading. The number of `=` characters is the
level, so `===` is an `<h3>`. Trailing `=` are decoration and are dropped.
Levels beyond `h6` are clamped, with a warning on the file.

```mdy
= Title
=== Sub-sub-heading ===
```

A line of only `=`, or of **four or more** `-`, under a paragraph underlines it
instead, Setext style. `=` gives an `<h1>`, `----` an `<h2>`:

```mdy
Title
=====

Subtitle
----------
```

One `=` is enough and past four the length says nothing. Three dashes are
deliberately not enough, because a run of dashes already has four meanings and
each of them gets exactly one length:

| Dashes  | Under a paragraph        | On its own               |
| ------- | ------------------------ | ------------------------ |
| `-`     | empty list item (rule 6) | empty list item (rule 6) |
| `--`    | an em dash               | an em dash               |
| `---`   | separator (rule 11)      | separator (rule 11)      |
| `----`  | `<h2>`                   | thematic break (rule 2)  |

With `documents` off — which is the default — `---` is a thematic break in both
columns instead. That is the whole of why an underline starts at four: a line
whose meaning turns on whether an option is set is a line nobody can read, so
`---` is never an underline either way.

The underline wins two ties, which is what makes it usable at all:

- a line of only `=` would otherwise be an empty heading by the rule above
- a line of `-` would otherwise be a thematic break (rule 2)

Both still mean those things with no paragraph above them, so a lone `----` is a
break and a lone `===` is an empty `<h3>`. A multi-line paragraph becomes one
heading, and a dashed line with content after it (`- item`) is still a list.

#### Every heading has an id

Written or underlined, at any level, a heading is given an `id` slugified from
its own text — so it can be linked to without a line of code anywhere:

```mdy
== Rule 5: Elements

See [[ rule 5 | #rule-5-elements ]].
```

```html
<h2 id="rule-5-elements">Rule 5: Elements</h2>
<p>See <a href="#rule-5-elements">rule 5</a>.</p>
```

The slugifier is the one `[[ label ]]` uses, exported as `defaultResolve`, so a
heading and a link written from the same words agree without either of them
being told about the other. Markup comes off first: `= !!Bold!! and //italic//`
is `id="bold-and-italic"`.

Two headings reading the same thing are two places, so the second and each one
after it is numbered — `notes`, `notes-1`, `notes-2`. In a stream (rule 11) that
run is shared across every document, because they land on one page. A heading
that slugifies to nothing gets no `id` rather than an empty one.

```js
mdyToHtml(document, {headingId: false})                      // none at all
mdyToHtml(document, {headingId: {slug: (text) => …}})        // name them yourself
```

An `<h2` written as an element (rule 5) is yours, not the rule's: it keeps the
`id` you gave it, and gets none if you gave it none.

### 2. Thematic breaks

Three or more `-`, `*`, or `_` alone on a line is an `<hr>`. Spaces between them
are allowed, so `- - -` counts too.

```mdy
***
```

Dashes are the ambiguous case, and only past three: with a paragraph above,
**four or more** dashes underline it (rule 1), and everything else breaks.
Exactly `---` always breaks, whatever is above it, because that spelling is the
document separator of rule 11. `*` and `_` are never underlines, so they break
either way.

Three is the minimum for a break, which leaves `-` free to be an empty list item
and `--` free to be an em dash. A break ends a list or a table rather than being
swallowed into one, and the `__` of rule 8 is an inline marker, untouched by
this.

### 3. Paragraphs

Adjacent non-blank lines at the same indentation are joined with a space into
one paragraph. A blank line ends it, and any other block interrupts it.

Indenting a continuation line does not continue the paragraph — see rule 5.

```mdy
These three
lines become
one paragraph.
```

### 4. Code fences

Three or more backticks or tildes fence a block of code:

````mdy
```js
const answer = 6 * 7
```
````

Everything up to the closing fence is content, whatever it looks like, so a
fence can hold headings, pipes, markers — anything. A longer fence holds a
shorter one, a tilde fence holds backticks, and an unclosed fence runs to the
end of whatever encloses it.

The first word after the opening fence names the language, which becomes a class
on the `<code>`. Content keeps whatever indentation it has beyond the fence's
own, so a fence inside an element still holds indented code:

````mdy
<figure
  ```js
  if (ok) {
    go()
  }
  ```
````

#### Colouring

Fenced code is highlighted by [`lowlight`][lowlight], which produces hast
directly rather than a string of HTML — the tokens are real nodes in the tree,
so a transform (rule 12) can see them. The classes are highlight.js's, so its
stylesheets work unchanged:

```html
<pre><code class="language-js hljs"><span class="hljs-keyword">const</span> …
```

The default covers `lowlight`'s common set of 37 languages. A language nothing
knows is not an error: the class still says what it was meant to be, and the
code still reads.

```js
import {all, createLowlight} from 'lowlight'

mdyToHtml(document, {highlight: false})                 // plain, still classed
mdyToHtml(document, {highlight: createLowlight(all)})   // all 192 languages
```

Anything with `registered` and `highlight` on it will do, so a smaller set — or
another highlighter entirely — drops straight in.

### 5. Elements and indentation

A line starting with `<` opens an HTML element. There is no closing tag: the
element holds whatever is indented under it, and closes as soon as the
indentation comes back to its own level or further out.

```mdy
<table style="border: 1px solid red;"
  <tr
    <td>first
    <td>second
```

```html
<table style="border: 1px solid red;">
<tr>
<td>first</td>
<td>second</td>
</tr>
</table>
```

The rules for the opener:

- a bare `<` is a `<div>`
- `<table` names the element, and space between the two means nothing: `< table`
  and `<   table` name it as well, so an opener can be spaced to taste. A `<`
  with only space behind it is still a `<div>`
- attributes follow the name, quoted (`class="a b"`, `title='…'`), unquoted
  (`id=grid`), or bare for booleans (`hidden`); names are mapped onto their hast
  properties, so `class` becomes `className`
- the closing `>` is optional, and anything after it is inline content:
  `<td>first` is a one-line cell
- void elements (`<hr`, `<br`, `<img`) take no content, and are warned about if
  given any
- raw-text elements (`<pre`, `<script`, `<style`, `<textarea`, `<title`) keep
  their content as the text it is, de-indented and read as nothing else. A row
  of underscores in a `<pre` is a row of underscores, and markup inside a
  `<script` is not markup
- `<!doctype html>` is the one line of a document that names no element. It is
  read as the doctype it is rather than becoming a `<div>` named after nothing,
  so a whole HTML page is expressible — and it is dropped when sanitizing,
  which is the mode for input somebody else wrote: a fragment has no business
  declaring what kind of document it is in

**Indentation is structural.** Every two columns is one level of nesting, and a
tab counts as four columns. An indented run with no `<` line to name it gets a
`<div>` anyway:

```mdy
Plain paragraph.

  Indented, so wrapped.
    Indented twice, so wrapped twice.
```

```html
<p>Plain paragraph.</p><div>
<p>Indented, so wrapped.</p>
<div>
<p>Indented twice, so wrapped twice.</p>
</div>
</div>
```

Blank lines never close anything; only a line at a shallower indent does.

Every block rule works at every depth, so headings, lists and tables can all be
nested inside elements. The one exception is inside a list, where indentation
already means list nesting (rule 6).

#### Sanitizing

Because the element name and its attributes are the author's to write, every
opener is checked against a schema before it becomes a node. This is on by
default:

- **elements** must be on an allowlist; anything else becomes a `<div>` and
  keeps its content, so a typo costs you a tag rather than a paragraph
- **`<script>`, `<style>`, `<iframe>`, `<object>`, `<svg>` and friends** are
  stripped along with everything indented under them
- **attributes** must be allowed for that element, plus the global set
  (`class`, `id`, `style`, `title`, `lang`, `dir`, `role`, `hidden`,
  `aria-*`, `data-*`). Event handlers are on nobody's list, so `onerror` and
  its family never survive
- **`href`, `src` and `cite`** must be relative or use an allowed protocol;
  `javascript:` and `data:` are refused, including when whitespace is wedged
  into them to disguise the scheme

Everything removed is reported on the file, with the line it was written on, so
an editor can show it rather than leaving the author to wonder:

```txt
1:1-1:37 warning `onerror` is not allowed on `<img>`, dropping it  sanitize mdy
```

`style` *is* allowed: dressing up output is the point of the rule, and CSS can
restyle a page without acting on it. Drop it from the schema if that trade is
wrong for you.

The schema is data, like the marker table. Widen it, narrow it, or turn the
whole thing off for trusted input:

```js
import {defaultSchema, mdyToHtml} from 'mdy'

// Allow one more element.
mdyToHtml(document, {
  sanitize: {
    tagNames: [...defaultSchema.tagNames, 'video'],
    attributes: {...defaultSchema.attributes, video: ['controls', 'src']}
  }
})

// Trusted input, no checking.
mdyToHtml(document, {sanitize: false})
```

Anything left out of a partial schema falls back to `defaultSchema`, so
narrowing one part cannot quietly open up another. Only what an author writes is
checked — the elements MDY generates for headings, lists and tables are its own
and always survive.

For a second pass over the finished tree, or to reuse a schema you already have,
[`rehype-sanitize`][sanitize] still composes as usual:

```js
mdy().use(rehypeSanitize).processSync(document)
```

### 6. Lists

Lists are Markdown's. `-`, `*`, or `+` for bullets; `1.` or `1)` for numbers.
The marker has to be followed by whitespace, so `---` and `-5` stay prose.

```mdy
- one
- two
  1. nested by indentation
  2. and back out
- three
```

Indentation nests, with a tab counting as four columns. Only the first number
of an ordered list is used, as an `<ol start="…">`; the rest are ignored, so
`1.` all the way down works. Switching between bullets and numbers at the same
depth ends one list and starts its sibling.

A `[ ]` or `[x]` straight after the marker makes the item a task, GitHub style.
The box has to be followed by whitespace, and only a space or an `x` counts:

```mdy
- [x] shipped
- [ ] not yet
```

```html
<ul class="contains-task-list">
<li class="task-list-item"><input type="checkbox" checked disabled> shipped</li>
<li class="task-list-item"><input type="checkbox" disabled> not yet</li>
</ul>
```

The checkbox is disabled, the item carries `task-list-item` and the list carries
`contains-task-list`, matching what `mdast-util-to-hast` emits — so a stylesheet
written for Markdown task lists works here unchanged. Ordered lists take tasks
too, and plain items may sit alongside them.

#### Editable tasks

`{tasks: true}` makes the box live: clicking it submits a form that posts to the
page it is on.

```html
<form method="post" class="task-list-item-form">
  <input type="hidden" name="line" value="12">
  <input type="hidden" name="column" value="4">
  <input type="hidden" name="was" value=" ">
  <button type="submit" name="next" value="x" role="checkbox"
          aria-checked="false" aria-label="feed the cat"
          class="task-list-item-toggle"><span aria-hidden="true">☐</span></button>
</form>
```

The box **is** the submit button, because an `<input type="checkbox">` cannot
send a form on its own — only script or a submit control can, and a page that
needs neither is the point. So the control is a `<button type="submit">` wearing
a checkbox's `role`, `aria-checked` and shape. One click toggles it with no
JavaScript anywhere.

The glyph inside (`☐` / `☑`) means it still looks like a checkbox with no
stylesheet at all, and is hidden from assistive technology, which has the role,
the state and the label instead. A stylesheet is free to replace it — the demo
draws a tick with `::after` and shrinks the glyph away.

The form carries **where to write and what to write**:

| Field    | Meaning                                                        |
| -------- | -------------------------------------------------------------- |
| `line`   | Line of the item in the source, counting from one               |
| `column` | Column of the character between the brackets, counting from one |
| `was`    | What that character is now, `x` or a space                      |
| `next`   | What it should become, which is the other one                   |

Which makes a handler four lines:

```js
const lines = source.split('\n')
const index = Number(body.line) - 1
const column = Number(body.column) - 1

// `was` is what the page was showing. If the file has moved on since, this is
// where you find out, rather than writing over somebody else's edit.
if (lines[index][column] !== body.was) throw new Error('stale')

lines[index] =
  lines[index].slice(0, column) + body.next + lines[index].slice(column + 1)
```

The line is a line **of the file**, not of some slice of it: front matter and
document separators are counted past, so an item in the second document of a
stream reports where it really is. That is true of every node's `position`, not
only a task's. `lineOffset` shifts them all by a fixed amount, for a document
that came out of a larger file.

Generated lines survive this too. `script` runs before anything is parsed, so
the parser sees a document nobody wrote — but every generated line remembers the
line it came from, and positions report that. A task written after a `%` line
still names its own line, and lines produced inside a loop all name the one line
that produced them, which is the only honest answer: that is the line to edit.

The one case with no sensible answer is a task the code invented outright. Its
form will point at the template line that emitted it, so toggling it edits the
template — usually not what anyone wants. Tasks meant to be edited belong in the
document rather than in a loop.

The form has no `action`, which in HTML means the page's own URL. Give it one,
change the method, or ask for a real `<input type="checkbox">` instead — which
sends `next=x` when ticked and nothing when not, and needs script to submit:

```js
mdyToHtml(document, {tasks: {action: '/toggle', method: 'post'}})
mdyToHtml(document, {tasks: {control: 'checkbox'}})
```

#### Sending them without a reload

That form reloads the page, which is the right thing for it to do when nothing
else is available. `mdy/tasks` is the something else: a browser module that
takes the forms over, sends them in the background, and says how each one went.

```js
import {enhanceTasks} from 'mdy/tasks'

const stop = enhanceTasks(document.body, {
  onResult({detail, ok, error}) {
    console.log(detail.line, ok ? 'saved' : error.message)
  }
})
```

It is a separate module, and nothing needs it: leave it out and the forms still
work. Load it and it intercepts the submit, posts the same fields to the same
place with `fetch`, and only then moves the box — so a box that did not save
does not pretend it did.

While a request is in the air the form carries `aria-busy` and
`data-state="pending"`; afterwards `data-state` is `ok` or `error`. A
`role="status"` region inside the form says the same in words, politely enough
that a screen reader finishes its sentence first. A second click is ignored
while the first is still out.

Three ways to hear the result, and you may use all of them:

```js
enhanceTasks(root, {onResult})                       // a callback
root.addEventListener('mdy:task', (event) => {})     // an event
// or read `data-state` off the form
```

Replace the sending entirely with `submit` — anything it throws is a failure, as
is returning `false`. That is how the demo works with no server at all: its
`submit` writes the change straight into the editor, which is exactly what a
handler would do to the file.

```js
enhanceTasks(root, {
  async submit({line, column, was, next}) {
    const response = await fetch('/api/tasks', {
      method: 'PATCH',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({line, column, was, next})
    })

    if (!response.ok) throw new Error(await response.text())
  },
  messages: {pending: 'Saving…', ok: 'Saved', error: 'Could not save'}
})
```

`enhanceTasks` returns a function that undoes it, and it listens on the root you
give it, so re-rendering the content underneath keeps working.


Item text follows rule 3 — adjacent lines join into it:

```mdy
- one
  still item one
- two
```

A blank line inside a list makes it *loose*: every item's content is wrapped in
a `<p>`. A blank line followed by anything that is not an item ends the list, as
does a heading.

Items hold text and nested lists. Indentation inside a list means list nesting,
not the element nesting of rule 5, so tables, headings and elements inside an
item are not supported; a line like that is read as continuation text.

### 7. Tables

Tables are GitHub flavoured, unchanged: a header row, a delimiter row, and any
number of body rows. Framing pipes are optional, colons in the delimiter row set
column alignment, and `\|` puts a literal pipe in a cell.

```mdy
| Marker | Element  |    Note |
| :----- | :------: | ------: |
| !!     | strong   |    bold |
| //     | em       |  italic |
```

The delimiter row must have as many cells as the header, or none of it is a
table. Short body rows are padded with empty cells and long ones are trimmed to
the header's width. A table ends at a blank line, a heading, a thematic break,
or an element opener.

Alignment is emitted as `style="text-align: center"`. Pass
`{tableAlign: 'attribute'}` for the legacy `align="center"` that GitHub and
`remark-gfm` produce instead.

#### Captions

A line of a single cell directly above a table is its caption:

```mdy
| What each marker gives.
| Marker | Element |
| :----- | :------ |
| !!     | strong  |
```

```html
<table>
<caption>What each marker gives.</caption>
<thead>
…
```

It is inline content like any cell, `\|` and markers included, and the framing
pipe on the right is optional as everywhere else.

Above is the only place to write one, for two reasons. HTML puts `<caption>`
first in the table whatever it says, and which side it *shows* on is
`caption-side` in CSS — so writing it above is writing it where it ends up.
Below there would be no telling it from a ragged one-cell row, which is a thing
this grammar already allows.

What makes it a caption rather than a one-column table's header is the line
after it: a header has a delimiter row under it, a caption has a whole table.
So both of these are right, and neither needs a new character to say so:

```mdy
| Name |        <- a header, delimiter under it
| ---- |
| Ada  |

| Everyone here <- a caption, a table under it
| Name |
| ---- |
| Ada  |
```

A single-cell pipe line with no table under it is left as the paragraph it is.
To caption something that is not a table — or to caption a table as a *figure*,
which is what "see Table 3" in the prose really means — write the element
instead, and the caption goes wherever `<figcaption>` may go:

```mdy
<figure
  | Marker | Element |
  | :----- | :------ |
  | !!     | strong  |
  <figcaption>What each marker gives, referred to from the text.
```

Two deliberate differences from GFM, both in the name of predictability:

- a table may interrupt a paragraph, whatever the paragraph's length
- a delimiter row needs at least one `|`, so a bare `---` under a line of prose
  is never a one-column table

### 8. Inline markers

Inline formatting *toggles*. The first occurrence of a sequence opens a span;
the next occurrence of that same sequence closes it, along with everything
opened inside it. Anything still open at the end of a block is closed there,
so markup can never leak across blocks.

| Sequence | Element    |
| -------- | ---------- |
| `!!`     | `<strong>` |
| `//`     | `<em>`     |
| `__`     | `<u>`      |
| `~~`     | `<del>`    |
| `??`     | `<mark>`   |
| `^^`     | `<sup>`    |
| `,,`     | `<sub>`    |
| ` `` `   | `<code>`   |

```mdy
!!bold //and italic!! — the em closes with the strong.
```

Double-backtick spans are raw: nothing inside them is markup. Everywhere else,
a backslash escapes the next character, so `\!!` is a literal `!!`.

The table is data, not grammar — pass your own to change the language:

```js
mdy({markers: [{sequence: '@@', tagName: 'kbd'}]})
```

### 9. Links

#### Bare URLs

URLs in text become links:

```mdy
Docs live at https://example.com/docs, mail team@example.com.
```

```html
<p>Docs live at <a href="https://example.com/docs">https://example.com/docs</a>,
mail <a href="mailto:team@example.com">team@example.com</a>.</p>
```

Matching is [`linkify-it`][linkify]'s, which knows that the comma above closes
the sentence rather than the URL, and that the bracket in
`(https://example.com/a_(b))` closes the URL rather than the sentence.

What counts as a URL:

- anything naming its scheme — `https:`, `http:`, `ftp:`, `mailto:`
- protocol-relative `//cdn.example.com/lib.js`
- bare email addresses, which get a `mailto:`

What does not: bare domains and `www.`-only addresses. A two-letter country code
is a valid suffix, so matching those would turn `README.md`, `node.js` and
`main.rs` into links. Write the scheme.

URLs are found **before** markers and emoji, which is what keeps the `//` in
`https://` from opening a run of emphasis. Nothing is matched inside a raw
`` `` `` span, and `{autolink: false}` turns the rule off.

#### Written links

`[[ ]]` makes a link anywhere in text, with or without somewhere to point:

```mdy
Read [[ Getting Started ]] first, then [[ the API | /docs/api ]].
```

```html
<p>Read <a href="getting-started">Getting Started</a> first,
then <a href="/docs/api">the API</a>.</p>
```

With a `|`, the right-hand side is the URL — including a bare fragment, which
is how you point at a heading on the page:

```mdy
Back to [[ the rules | #the-rules ]].
```

Every heading carries an `id` for exactly this (rule 1).

A URL out to the internet and a fragment of this page are both used exactly as
written. A link to **another page of your own** is lower cased with its spaces
as dashes, and written down on `res.data.links` — see
[links to your own pages](#links-to-your-own-pages).

Without a `|`, the label is slugified: lower cased, spaces hyphenated,
punctuation dropped, and path separators, dots and fragments kept, so
`[[ docs/intro ]]` and `[[ Setup#Install ]]` land where you would expect. That
is the same slugifier a heading's `id` comes from, so `[[ #The Rules ]]` links
to `#the-rules` and says `#The Rules`. Decide it yourself with `resolve`:

```js
mdyToHtml(document, {
  wikiLink: {resolve: (label) => '/wiki/' + defaultResolve(label)}
})
```

The label is inline content of its own, so markers and emoji work inside it. Any
link *within* a label is unwrapped to its text, because an `<a>` inside an `<a>`
is not a thing. `\|` puts a literal pipe in a label, an unclosed `[[` is just
text, and the URL is checked against the sanitizing schema exactly as a
hand-written `<a href>` would be — `[[ x | javascript:… ]]` loses its `href` and
says so on the file.

`{wikiLink: false}` turns the rule off.

#### Tags and mentions

`#tag` and `@user` become links, to wherever you say:

```mdy
Filed under #syntax-trees by @wooorm.
```

```html
<p>Filed under <a href="/tags/syntax-trees">#syntax-trees</a> by
<a href="/users/wooorm">@wooorm</a>.</p>
```

A name starts with a letter or an underscore and runs to a letter, digit or
underscore, so `#tag.` ends the sentence and `#tag-` ends with a hyphen. Both
have to start a word, which keeps `a#b` and `x@y` out of it — and by the time
this runs, a URL and an email address have already been taken whole, so
`https://x.com#frag` and `hello@example.com` are untouched. Non-ASCII names are
encoded into the URL: `#café` links to `/tags/caf%C3%A9`.

The first character is deliberately not a digit. `#42` and `Invoice #57` are
how people write issue and invoice numbers, and every one of them turning into
a link to a tag page that does not exist is worse than the handful of numeric
tags it costs. `@42` is nobody, for the same reason.

Give either a prefix, a whole resolver, or `false`:

```js
mdyToHtml(document, {
  tags: '/topics/',
  mentions: {resolve: (name) => 'https://example.com/@' + name}
})

mdyToHtml(document, {tags: false, mentions: false})
```

The nodes are plain `<a href>` with no class, so style them by where they point:

```css
a[href^="/tags/"] { … }
```

#### Footnotes

A label opening with `^` is a footnote reference rather than a link, and a line
of `[[ ^id ]]: …` defines one:

```mdy
Coffee is good for you[[ ^1 ]], within reason[[ ^2 ]].

[[ ^1 ]]: For a given value of good.
[[ ^2 ]]: Four cups, say.
```

The references become numbered links, and the notes are gathered into a section
at the end of the document, wherever in it they were written:

```html
<p>Coffee is good for you<sup><a href="#user-content-fn-1" id="user-content-fnref-1"
data-footnote-ref aria-describedby="footnote-label">1</a></sup>, …</p>
<section data-footnotes class="footnotes">
<h2 class="sr-only" id="footnote-label">Footnotes</h2>
<ol>
<li id="user-content-fn-1">
<p>For a given value of good. <a href="#user-content-fnref-1" data-footnote-backref
aria-label="Back to content" class="data-footnote-backref">↩</a></p>
</li>
</ol>
</section>
```

The markup is `mdast-util-gfm-footnote`'s, down to the `data-footnote-*`
attributes and the visually-hidden heading that every reference names through
`aria-describedby`, so Markdown footnote styling and tooling apply unchanged.
Note that the section wants a `.sr-only` rule in your stylesheet, or the heading
shows.

How they behave:

- notes are numbered by the order they are **referenced**, not written, and a
  definition may sit above the text that points at it
- a reference nobody defines stays as the text it is, and a definition nobody
  points at is dropped — both as Markdown does it
- referencing one note twice gives it a numbered arrow back to each place
- lines under a definition join onto it, indented or not, which is the one
  place besides a list where indentation is not structural
- ids are prefixed `user-content-` so a note called `content` cannot shadow an
  element on the page

```js
mdyToHtml(document, {footnotes: {label: 'Notes', prefix: 'x-'}})
mdyToHtml(document, {footnotes: false})
```

Links are plain `<a href>`. For `rel="nofollow"` or `target="_blank"`, compose
[`rehype-external-links`][external] as usual:

```js
mdy().use(rehypeExternalLinks, {rel: ['nofollow']}).processSync(document)
```

### 10. Emoji

Emoticons and GitHub's `:shortcode:` names become emoji characters:

```mdy
Shipped it :rocket: and I'm happy about it :)
```

```html
<p>Shipped it 🚀 and I'm happy about it 😃</p>
```

The names come from [`gemoji`][gemoji] (1,900 of them) and the emoticons from
[`emoticon`][emoticon] (300-odd, including `<3`, `:-D`, `>:(` and `o.O`).

An emoticon is only replaced when it stands on its own — the run starts there, a
space precedes it, or a marker was just closed — and the character after it is
not a letter or a number. Without that, the `:/` in `a:/b` would become a face.
A shortcode is only replaced when `gemoji` knows the name, which is what keeps
`12:30:45` a time.

Neither applies inside a raw `` `` `` span, and a backslash escapes either one.
Turn them off together or one at a time:

```js
mdyToHtml(document, {emoji: false})
mdyToHtml(document, {emoji: {emoticons: false}})
```

One rough edge worth knowing: `</3` at the very start of a line is an element
opener (rule 5) before it is a broken heart. Indent it, or put it mid-line.

### 11. Documents and front matter

**Off by default.** A line of exactly `---` starts a new document, YAML style, so
one file can hold a stream of them:

```js
mdyToHtml(source, {documents: true})
```

```mdy
= First

---

= Second
```

```html
<article>
<h1>First</h1>
</article><article>
<h1>Second</h1>
</article>
```

It is off by default because `---` already means a thematic break (rule 2), and
turning this on takes that meaning from it. Nothing else moves: a Setext
underline is four dashes or more (rule 1) precisely so that it never has to
compete with this, whether the option is on or off.

The separator is **exactly three dashes**. `----`, `- - -`, `***` and `___` are
all still breaks on their own, and `----` still underlines, so everything else
stays spellable either way:

```mdy
Still a heading
----

Still a break

***
```

Each document is parsed **on its own**. A script, the transforms it registers
and its footnotes belong to one document and cannot reach the next, and
footnotes number from one in each. Since they all land on one page in the end,
ids after the first document take a distinguishing prefix, so nothing collides.

A leading separator opens the first document rather than making an empty one
before it, and documents holding only whitespace are dropped.

Pass a tag name for the wrapper, or `false` to run the documents together:

```js
mdyToHtml(source, {documents: 'section'})
mdyToHtml(source, {documents: {wrapper: false}})
```

#### Front matter

A `+++` fenced block at the top of a document is YAML. This one is **on** by
default: `+++` means nothing else in MDY, so nothing that parses today changes.

```mdy
+++
title: Hello
tags: [markup, hast]
draft: false
+++

= Body
```

The block is taken off, and the data turns up in three places:

- `tree.data.matter` on the document's root — or on its `<article>` in a stream
- `file.data.matter`, the vfile convention, plus `file.data.documents` holding
  every document's when there is more than one
- **`res.data` in scope for code**, which is where it earns its keep. It is
  there before a line of the document has run, the block having been read off
  the top first:

```mdy
+++
title: Hello
tags: [one, two]
+++

= {{ res.data.title }}

% for (const tag of res.data.tags) {
- #{{ tag }}
% }
```

The bare name `matter` still holds the same object, which is what documents
written before `res` existed reach for.

Two keys are put on it that the block need not name: `tags` and `users`, the
names the document refers to as it goes. That is rule 12's doing and is
described [with `res`](#req-and-res).

The fence has to open on the document's first line, give or take blank ones, and
it has to close — an opening fence with no partner is left as the prose it
probably is, rather than swallowing the rest of the document. YAML that does not
parse is reported on the file and the content is kept.

```js
mdyToHtml(document, {frontmatter: false})
mdyToHtml(document, {frontmatter: '~~~'})
```

To keep them as separate trees instead, split first and parse each yourself:

```js
import {mdyToHast, splitDocuments} from 'mdy'

const trees = splitDocuments(source).map((document) => mdyToHast(document))
```

### 12. Script

**Off by default.** A line starting with `%` is JavaScript, and turning this on
means the document you are processing gets to run code. Do not enable it for
input you did not write.

```js
mdyToHtml(document, {script: true})
```

Every `%` line goes in as the code it is, and every other line becomes output.
So a `%` line that opens a block encloses the content lines under it:

```mdy
% for (let i = 1; i <= 3; i++) {
- item {{ i }}
% }
```

```html
<ul>
<li>item 1</li>
<li>item 2</li>
<li>item 3</li>
</ul>
```

#### Code that is only code

A `%` line is one line of JavaScript, always — what it leaves open encloses the
markup under it, which is the whole of how the loop above works. When there is
no markup to enclose, `%%` says so: it runs on into the lines under it as far as
the line that brings its brackets back to even.

```mdy
%% const rules = [
     {number: 1, name: 'Headings'},
     {number: 2, name: 'Lists'}
   ]
% for (const rule of rules) {
- {{ rule.number }}. {{ rule.name }}
% }
```

Round, square and curly all count, so a function can be written as itself rather
than as a column of sigils:

```mdy
%% transform((tree) => {
     visit(tree, 'element', (node) => {
       if (node.tagName === 'h2') node.properties.id = slug(toText(node))
     })
   })
```

The lines it takes up are code entire: no `{{ … }}`, no markup, nothing but the
JavaScript they hold. Quotes and comments are read as what they are, so a
bracket inside one is a character rather than a bracket.

Nothing is taken unless the closing line is really there. An unclosed bracket —
or another `%` line before the closing one — leaves the `%%` line on its own, to
fail as the one line it is rather than swallow the document behind it.

#### Compiling and running are two things

`compileScript(lines)` turns a document into the program that produces its
lines — `__out`, an array of `[sourceLine, text]` pairs the statements declare
and fill — and knows nothing about who runs it. `expandScript` runs that
program here, in this process, with `new Function`; a host with a sandbox of
its own puts the same statements inside that instead and hands the `__out` it
gets back to `scriptOutput`, which flattens it into lines and the map that
says where each came from.

```js
import {compileScript, scriptOutput} from 'mdy'

const {source} = compileScript(document.split('\n'))
const pairs = await yourSandbox.run(source + '\nreturn __out')
const {lines, map} = scriptOutput(pairs)
```

Neither runner is privileged, which is the point: it is the difference between
a parser that owns its execution model and one that is agnostic about it, and
the agnostic one is what lets this be a dependency at all.
[mdy-docs](https://github.com/mdy-docs/mdy-docs) is the other consumer —
it runs the program inside a WebAssembly sandbox and the parser never knows.

Content lines interpolate `{{ … }}`, which holds any JavaScript expression. It
works with or without a `%` line, so a document can be a plain template. Hand it
values with `scope`:

```js
mdyToHtml(document, {script: {scope: {rules: ['One', 'Two']}}})
```

```mdy
== {{ rules.length }} rules

% for (const rule of rules) {
- {{ rule }}
% }
```

#### `req` and `res`

A document is compiled into a function, and the function is **called with two
arguments**: `req`, what it is answering, and `res`, what it is answering with.

```js
const file = mdy({
  script: {request: {path: url.pathname, query, session}}
}).processSync(document)

file.data.response       // the `res` the document was handed back
```

`req` is the `request` you passed, untouched — a URL, a query, a session,
anything. MDY neither reads it nor cares what shape it is. With no `request`
given it is an empty object, never undefined, so `req.whatever` is safe to
reach for.

`res` starts with two keys of its own:

| On `res` | What it is                                                     |
| -------- | -------------------------------------------------------------- |
| `data`   | The front matter, parsed (rule 11), and always an object.       |
| `doc`    | The finished hast tree. Not before a `transform` — see below.  |

```mdy
+++
title: Notes
tags: [mdy, hast]
+++
= {{ res.data.title }}

% for (const tag of res.data.tags) {
- [[ {{ tag }} ]]
% }
```

**`res.doc` is undefined while the body is running**, and that is not a wrinkle
to work around: code runs before anything is parsed, so the tree the code is
there to produce does not exist yet. It is put on `res` the moment there is
one, which is exactly when the transforms run — so a transform is where a
document meets its own tree, by the argument it is handed or by `res.doc`,
which are the same object:

```mdy
%% transform(() => {
     res.words = toText(res.doc).split(/\s+/).length
   })
```

#### What a document refers to

Three lists are always there, and MDY fills them in as it reads, so a document
can be asked what it is about without being read twice:

| On `res.data` | What goes in it                                          |
| ------------- | -------------------------------------------------------- |
| `tags`        | Every `#tag` the text mentions (rule 9)                  |
| `users`       | Every `@user` it mentions                                |
| `links`       | Every link to **another page of your own** (see below)   |

```mdy
+++
title: Trees
+++
Filed under #syntax-trees and #hast, by @wooorm.

See [[ the API | /docs/api ]] and [[ hast | https://github.com/syntax-tree/hast ]].
```

```js
file.data.matter
// {
//   title: 'Trees',
//   tags: ['syntax-trees', 'hast'],
//   users: ['wooorm'],
//   links: ['/docs/api']
// }
```

The rules of it:

- **the lists exist even when nothing is in them**, and even with no front
  matter at all, so `res.data.tags` is always an array to loop over
- **a list the author wrote is added to, never replaced.** `tags: [draft]` at
  the top plus `#hast` in the text gives `['draft', 'hast']`
- anything under those names that is *not* a list is left exactly as it was
  found — MDY will not overwrite what an author meant
- one entry each, in the order the document reaches them, taken from headings,
  list items and table cells as much as from paragraphs
- a rule that is off collects nothing: `{tags: false}` leaves `tags` empty

#### Links to your own pages

`links` holds the links that go **somewhere else on your own site** — not down
this page, and not out to the internet. Every link is sorted into one of three:

| Written                | Read as    | In `links`? |
| ---------------------- | ---------- | ----------- |
| `https://…`, `mailto:…`, `//host/…` | internet | no  |
| `#some-heading`        | this page  | no          |
| `/docs/api`, `../up`, `guide` | another page | **yes** |

A link to another page is also **tidied on the way through**: lower cased, with
spaces written as the dashes a path would have. A page is a file somewhere in
the end, and `Getting Started` and `getting-started` should not be two of them.

```mdy
<a href="/Docs/API Reference">the API
```

```html
<a href="/docs/api-reference">the API</a>
```

The other two are left exactly as written, and for the same reason in both
cases: a URL belongs to whoever it points at, and a fragment belongs to the id
it names. `[[ … ]]` links and hand-written `<a href>` are read the same way, and
a `#tag` keeps the name it was given — `/tags/` is your prefix and the name is
the author's, so neither is this rule's to tidy.

**The lists fill on the same clock as `res.doc`.** Reading the text is what
finds them, and the body runs before any of it is read, so they are empty while
the body runs and full by the time a transform sees them:

```mdy
%% transform(() => {
     res.doc.children.push(h('p', 'Tagged ' + res.data.tags.join(', ')))
   })
```

#### Reading it back

Anything else the document puts on `res` is yours: it comes back on the file as
`file.data.response`, the way the front matter comes back as `file.data.matter`.
That is the whole of the contract — MDY writes `data` and `doc` and reads
nothing, so `res.status`, `res.headers` or whatever your host wants are the
document's to set and your own to act on.

A `scope` key may shadow any of the toolkit below, but not `req` or `res`:
those are the calling convention rather than a convenience.

Things worth knowing:

- code runs **before** anything is parsed, so what it prints goes through every
  rule above it — generate a table, a list, an element, a footnote, anything
- indentation is preserved, so a loop works inside an element
- `%%` opens a run of code that ends where its brackets balance; `%` is always
  the one line it is written on
- **a `%` line is lifted out before a single column is counted**, so what it is
  indented by is yours to choose and changes nothing about the markup around
  it. Line the code up with the block it opens, with the content it encloses,
  or not at all; an indented `%` line opens no `<div>`, an outdented one closes
  no element, and neither breaks a table or a list apart:

  ```mdy
  <section class="rules"
    % for (const rule of rules) {
    - {{ rule.name }}
    % }
  ```

  is the same document as the one with every `%` hard against the left margin
- a document holding nothing this stage reads — no `%` line, no `{{`, no `\%`
  — is left exactly alone
- `\{{` writes a literal `{{`, and a line opening with `\%` is prose
- **nothing is raw to code — not a `` `` `` span, not a fenced block.** Code
  runs before either of them exists, so a `%` line inside a fence is JavaScript
  rather than a line of the block, and a loop can generate the block itself:

  ````mdy
  ```js
  % for (const name of names) {
  export const {{ name }} = 1
  % }
  ```
  ````

  which is how the editor on the demo site paints it. A span or a block that has
  to *show* `{{ … }}` or a `%` line needs the backslash, exactly as prose does
- `$` is only ever a dollar sign: `${…}` in a document is literal text
- MDY's own `\!!` escapes and `` `` `` spans survive compilation untouched
- a syntax or runtime error is reported on the file rather than thrown, and the
  prose is rendered without the code — a half-written loop is the normal state
  of a document being edited
- **positions point at the generated document, not the one you wrote**, so a
  warning's line number will be off wherever code changed the line count

#### Transforming the tree

Printing markup is only half of it. A document can also register a function to
run on the finished hast tree, before it becomes HTML — which is to say a
document can be its own unified plugin:

```mdy
<div id=toc

% transform((tree) => {
%   const items = []
%   visit(tree, 'element', (node) => {
%     if (node.tagName !== 'h2') return
%     const id = slug(toText(node))
%     node.properties.id = id
%     items.push(h('li', h('a', {href: '#' + id}, toText(node))))
%   })
%   visit(tree, 'element', (node) => {
%     if (node.properties.id === 'toc') node.children = [h('nav', h('ul', items))]
%   })
% })

== First Section
== Second Section
```

The document says where the table of contents goes by leaving an element for it,
and the transform fills it in once every heading exists. The `id` each link
points at is not the transform's doing: every heading has one already (rule 1).

Registered functions run in the order they were registered, after everything
else — including the footnote section — so they see the whole document. Mutate
the tree in place, or return a replacement. A transform that throws is reported
on the file and skipped, like any other error in a document.

These names are in scope for code, alongside anything the host passed:

| Name              | What it is                                              |
| ----------------- | ------------------------------------------------------- |
| `transform(fn)`   | Register `fn` to run on the finished tree                |
| `visit(tree, …)`  | [`unist-util-visit`][visit], for walking the tree        |
| `h(tag, …)`       | [`hastscript`][hastscript], for building nodes           |
| `toText(node)`    | All the text under a node, markup taken off              |
| `slug(text)`      | The same slugifier `[[ label ]]` uses                    |

A `scope` key of the same name shadows any of them, should you want your own.

`new Function` runs the code. It is not a sandbox: there is no isolation, no
timeout, and no way to stop a loop that never ends. Enable it for documents you
control — a site you are building, templates in your own repository — and leave
it off for anything else.

### 13. Comments

A line whose first character is `#`, with a space behind it or nothing at all,
is a comment. It is taken out of the document and leaves nothing itself — no
node, no blank line, no gap the markup can feel.

```mdy
# the rules, in the order they were added
= Rules

- One
# Two was dropped
- Three
```

```html
<h1>Rules</h1>
<ul>
<li>One</li>
<li>Three</li>
</ul>
```

What follows the `#` is the whole of what says a comment was meant: a space, or
the end of the line, so a lone `#` comments out a line and doubles as a spacer
between them. A word against the `#` makes a [tag](#tags-and-mentions) instead,
so `#tag` opens an ordinary paragraph holding one.

**A Markdown heading is a comment here.** MDY writes headings with `=`, so `#`
was free, and `# Title` is a comment rather than an `<h1>` — worth knowing
before pasting Markdown in.

Two more things worth knowing:

- **the indentation is the author's**, exactly as a `%` line's is. A comment is
  lifted out before a column is counted, so an indented one opens no `<div>`, an
  outdented one closes no element, and neither breaks a table or a list apart
- **a fenced block keeps its comments.** `# ` opens a comment in half the
  languages a block might hold, so inside a fence it is a line of the block like
  any other. Fences are found first and whatever they hold is left alone

````mdy
# this one goes

```py
# this one stays
x = 1
```
````

A backslash writes the line rather than commenting it out: `\# shown` is a
paragraph reading `# shown`.

## Typography

Three substitutions happen inside text, all of them the emoji rule's kin: they
skip a raw `` `` `` span, they never reach fenced code, and a backslash on any
character of the sequence opts out.

### Ellipsis

Three dots become an ellipsis:

```mdy
Well... maybe.
```

```html
<p>Well… maybe.</p>
```

Exactly three: `....` is left as the four dots it was written as, since nothing
about a longer run says it was meant as one character. `\...` stays as it was
typed.

Turn it off, or write something else in their place:

```js
mdyToHtml(document, {ellipsis: false})
mdyToHtml(document, {ellipsis: '. . .'})
```

### Em dash

Two dashes become one:

```mdy
Everything below is live -- edit it.
```

```html
<p>Everything below is live — edit it.</p>
```

Exactly two, and this is the reason why: a run of dashes already means three
other things, and each of them is settled a line at a time before any of this
runs.

| Dashes  | What it is                                                  |
| ------- | ----------------------------------------------------------- |
| `-`     | a list item (rule 6)                                        |
| `--`    | an em dash                                                  |
| `---`   | a document separator (rule 11), or a break when that is off |
| `----`  | an `<h2>` under a paragraph (rule 1), a break on its own     |

A longer run that reaches text as text is left as the run it was written as,
so `a --- b` keeps its three dashes. Arrows are matched first, so `-->` keeps
its head. `\--` stays as it was typed.

```js
mdyToHtml(document, {emDash: false})
mdyToHtml(document, {emDash: '–'})   // an en dash instead
```

### Arrows

Arrows drawn with dashes and angles become the characters they draw:

```mdy
MDY --> hast ==> HTML
```

```html
<p>MDY → hast ⇒ HTML</p>
```

| Written | Gives |
| :------ | :---- |
| `-->`   | `→`   |
| `<--`   | `←`   |
| `<-->`  | `↔`   |
| `==>`   | `⇒`   |
| `<==`   | `⇐`   |
| `<==>`  | `⇔`   |

Three characters at least. `->` and `=>` are deliberately not in the table:
`x <= 5` is a comparison and `() => {}` is a function, and both turn up in
ordinary prose, outside the code span that would have protected them. A longer
run is left alone too — `--->` and `<===` are more likely a rule than an arrow
— because an arrow may not sit against another character it is drawn with.

Turn it off, or hand over a table of your own. Spread `defaultArrows` to add to
it rather than replace it, and keep clear of the marker sequences: markers are
matched first, so `~~>` opens a `<del>` before anything looks for an arrow.

```js
mdyToHtml(document, {arrows: false})
mdyToHtml(document, {arrows: {...defaultArrows, '|->': '↦'}})
```

One rough edge, the same one `</3` has: `<--` at the very start of a line is an
element opener (rule 5) before it is an arrow. Indent it, or put it mid-line.

## API

| Export                        | Description                                   |
| ----------------------------- | --------------------------------------------- |
| `mdy(options?)`               | New unified processor: MDY in, HTML out       |
| `mdyToHast(doc, options?)`    | Parse to a hast `Root`                        |
| `mdyToHtml(doc, options?)`    | Compile to an HTML string                     |
| `mdyParse` (plugin)           | Attach the MDY parser to your own processor   |
| `fromMdy(doc, options?)`      | The parser itself, no unified involved        |
| `parseInline(text, options?)` | Inline markers only, returns phrasing content |
| `defaultMarkers`              | The marker table above                        |
| `defaultArrows`               | The arrow table above                         |
| `defaultSchema`               | The sanitizing schema above                    |
| `defaultResolve`              | The `[[ label ]]` slugifier                    |
| `splitDocuments(source)`      | Split a stream into its documents              |
| `compileScript(lines)`        | Compile a document to the program that makes its lines |
| `scriptOutput(pairs)`         | Flatten what that program returned into lines and a map |
| `scriptLines(lines)`          | Which lines of a document are code             |
| `scriptBrackets(lines)`       | Where the brackets of a document's code pair up |

### Options

| Option            | Default          | Description                          |
| ----------------- | ---------------- | ------------------------------------ |
| `markers`         | `defaultMarkers` | Inline marker table                  |
| `maxHeadingDepth` | `6`              | Deeper headings clamp and warn       |
| `headingId`       | `true`           | Headings get an `id` to link to      |
| `autolink`        | `true`           | URLs in text become links            |
| `tags`            | `'/tags/'`       | Where `#tag` links to                |
| `mentions`        | `'/users/'`      | Where `@user` links to               |
| `footnotes`       | `true`           | `[[ ^id ]]` references and notes     |
| `wikiLink`        | `true`           | `[[ label \| url ]]` links           |
| `emoji`           | `true`           | `:)` and `:rocket:` become emoji     |
| `emDash`          | `true`           | `--` becomes `—`                     |
| `ellipsis`        | `true`           | `...` becomes `…`                    |
| `arrows`          | `true`           | `-->` and `<==` become arrows        |
| `documents`       | `false`          | `---` starts a new document          |
| `frontmatter`     | `true`           | `+++` block at the top is YAML       |
| `highlight`       | `true`           | Colouring for fenced code            |
| `tasks`           | `false`          | Wrap task checkboxes in a form       |
| `lineOffset`      | `0`              | Added to every position              |
| `sanitize`        | `true`           | Element and attribute allowlist      |
| `script`          | `false`          | Run `%` lines as JavaScript          |
| `script.request`  | `{}`             | Handed to the document as `req`      |
| `tableAlign`      | `'style'`        | Or `'attribute'` for `align="…"`     |
| `stringify`       | —                | Passed through to `rehype-stringify` |

Block nodes carry `position` information, so warnings and downstream tooling
can point at the source.

## Test

```sh
npm test
```

[hast]: https://github.com/syntax-tree/hast
[emoticon]: https://github.com/wooorm/emoticon
[external]: https://github.com/rehypejs/rehype-external-links
[gemoji]: https://github.com/wooorm/gemoji
[hastscript]: https://github.com/syntax-tree/hastscript
[linkify]: https://github.com/markdown-it/linkify-it
[lowlight]: https://github.com/wooorm/lowlight
[visit]: https://github.com/syntax-tree/unist-util-visit
[sanitize]: https://github.com/rehypejs/rehype-sanitize
[unified]: https://unifiedjs.com
