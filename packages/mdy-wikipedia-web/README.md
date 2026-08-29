# @mdy-docs/mdy-wikipedia-web

Read Wikipedia as mdy. An article on the right, the MDY it was converted into
on the left, and every link in it another article away.

```sh
npm run mdy-wikipedia-web          # from the repo root, or from here
# → http://localhost:4400/

npm run mdy-wikipedia-web -- --port 4500 --vault vault
```

## What it is

[`@mdy-docs/mdy-wikipedia`](../mdy-wikipedia/README.md) turns a Wikipedia page
into a document. This is the way to look at what it did — and the quickest way
to find out what a conversion decision actually costs, because both halves are
in front of you at once.

- **Source, left.** [`@mdy-docs/mdy-site`](../mdy-site)'s editor, imported
  rather than copied: the same textarea with a painted copy behind it, the same
  MDY colouring, the same stylesheet. Type in it and the article follows.
- **Article, right.** Not a preview of the conversion — the document itself,
  parsed in the browser by the same parser everything else in the repo uses.
- **Data tab.** The front matter: the infobox as a record, the coordinates, the
  outline, the images.
- **Messages, underneath.** What the conversion could not write, and what the
  parser had to say. For most articles this is empty or close to it, which is
  the point.

**Click a link in the article and it reads that article too** — from memory if
it has been read already, from the vault if it is there, and from Wikipedia
otherwise. The badge beside the title says which of the three it was. Browser
back and forward work, and the address bar carries the page, so a reading is a
link somebody else can open.

## Options

```sh
mdy-wikipedia-web --vault vault --open "Ancient Near East" --wikidata
```

| | |
| --- | --- |
| `--port <n>` | default 4400 |
| `--vault <dir>` | keep documents here, and start from what is already in it |
| `--lang <code>` | which wiki (default `en`) |
| `--open <title>` | the page to show first (default Babylon) |
| `--wikidata`, `--no-images`, `--refs <mode>` | passed to the converter |
| `--dist` | serve the built page rather than vite's |

`--vault` points at a directory the way `mdy-wikipedia --out-dir` writes one, so
a vault built from the command line can be read here and a session's reading
adds to it.

One process serves both the API and the page: vite in development, `dist/` when
vite is not installed. Whether *vite* is there is the test rather than whether
`dist/` is, so one `npm run build` does not quietly leave the dev server serving
yesterday's bundle.

## Two decisions worth knowing about

**Links are converted as full URLs**, always, whatever the converter's default
is. It is the only mode that survives the trip: `[[ babylonia ]]` has lost the
title it came from, and `/wiki/babylonia` has been lower cased by mdy's own
link rule (language rule 9), so neither can say which article to fetch when
somebody clicks it. `https://en.wikipedia.org/wiki/Babylonia` can.

**Script is off.** A converted article is input this page did not write, and
`mdy({script})` runs it with `new Function` rather than in the lamassu sandbox.
The Data tab reads `file.data.matter` instead, which is the front matter itself
and needs nothing executed to show it. To *run* one of these documents as a
template, use the CLI and a document set, where the sandbox is.

## Test

```sh
npm test
```
