# mdy

Markdown documents with embedded data (`data` fences) and a JavaScript template
layer (`{{ … }}`). A document carries its own data and renders itself.

Files using these capabilities use the **`.mdy`** extension.

## Pipeline

1. **Extract data** — every ` ```data ` fence is parsed as YAML, merged into one
   data object, and stripped from the source. All other fences (` ```yaml `,
   ` ```js `, …) are left alone and render as normal code blocks.
2. **Compile** — the remaining text becomes a single JavaScript function, so all
   `{{ … }}` share one scope.
3. **Run** the function with the extracted data, producing markdown.
4. **Render** the markdown to HTML with markdown-it.

## Template syntax

| Syntax | Meaning |
| --- | --- |
| `{{= expr }}` | append the expression's value to the output |
| `{{ code }}` | run statements, append nothing (loops, `if`, `let`, …) |
| `\{{` | a literal `{{` |

- **Shared scope**: a `let`/`const` in one brace is visible to every later brace.
- **Order-independent data**: all `data` fences are collected before the template
  runs, so template code may reference data declared anywhere — even below it.
- **Whitespace control**: a control-flow tag alone on its line leaves no blank
  line, so generated tables and lists stay contiguous.

## Usage

```js
import { render, renderToMarkdown, createProcessor } from 'mdy';

const html = render(documentSource);           // → HTML
const md   = renderToMarkdown(documentSource); // → generated markdown (pre-HTML)

// Custom markdown-it (e.g. a syntax highlighter for ```yaml blocks):
import MarkdownIt from 'markdown-it';
const { render: r } = createProcessor({
  md: new MarkdownIt({ highlight: (code, lang) => myHighlight(code, lang) }),
});
```

## CLI

```
mdy [input] [options]

  input                 .mdy template; reads stdin if omitted or "-"
  -o, --out <file>      write output to <file> (default: stdout)
      --html            emit HTML instead of generated markdown
      --doc <index>     render document <index> of a multi-document file (default 0)
  -d, --data <k=v>      add a context value (repeatable; JSON-parsed if possible)
      --data-file <f>   merge a YAML/JSON file into the context
  -h, --help            show help
```

```sh
mdy report.mdy                        # → generated markdown on stdout
mdy report.mdy --html -o report.html  # → HTML file
mdy report.mdy -o report.md -d env=prod --data-file overrides.yaml
cat report.mdy | mdy - --html         # stdin → HTML on stdout
```

- Output goes to **stdout**; pass `-o` to write a file (it won't overwrite the input).
- A non-`.mdy` input is processed but **warns** on stderr.
- Context from `--data` / `--data-file` overrides a document's `data` fences.

## Data fences

Every ` ```data ` fence must be a YAML mapping; all fences in a document merge
into one object (later keys win). To group values, nest them in YAML:

````
```data
report:
  title: "Invoice #42"
  owner: Grace Hopper
```
````

## Multiple documents in one file

A file may hold several documents separated by a bare `---` line (YAML-stream
style). Documents are **anonymous and positional** — text before the first `---`
is document 0. Each document is a standard mdy unit (its own `data` fences +
template), exactly as if it were a separate file.

Templates get a `$` helper to address sibling documents **by index**:

| Call | Result |
| --- | --- |
| `$.render(i, data)` | run document `i` with `data` (overriding its own), returns markdown |
| `$.data(i)` | document `i`'s extracted data |
| `$.documents` | `[{ index, data }, …]` for slicing / iteration |
| `$.count` | number of documents |

Document 0 (the entry) is rendered by default; it composes the rest via `$`. Pass
`--doc <index>` (or the `entry` argument to `render`/`renderToMarkdown`) to render
a different one. This lets one document act as a per-item template applied across
sibling data records — see
[`examples/document-set.mdy`](examples/document-set.mdy):

````
```data
title: Team Roster
```
# {{= title }}

{{ for (const m of $.documents.slice(2)) { }}
{{= $.render(1, m.data) }}
{{ } }}

---
### {{= name }}
- Age: {{= age }}

---
```data
name: Alice
age: 30
```
````

Because splitting happens on `---` lines *before* markdown parsing, use `***` or
`___` for a thematic break (`<hr>`) inside a document.

See [`examples/`](examples/) for runnable documents and
[`test/mdy.test.js`](test/mdy.test.js) for behavior.

## Security

Template code runs via `new Function` with full runtime access. **Only process
trusted documents**, or sandbox with `node:vm` / `isolated-vm`.

## Test

```
npm test
```
