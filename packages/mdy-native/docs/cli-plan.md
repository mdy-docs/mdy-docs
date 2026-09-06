# mdy build to `mdy`: the plan to parity with bin/mdy.js

What it would take for the C binary to do everything `node bin/mdy.js` does,
in the order that pays soonest, with the check that says when each step is
done. Written after the front end, the wasm target and highlighting landed,
so the engine's side of the ledger is nearly closed and what remains is
mostly the command around it.

## Where it stands

The engine — what happens between a directory of documents and a directory of
pages — is at parity but for three things, and each is pinned to a number by
`make check-sites`:

| difference | status |
| --- | --- |
| render memoisation | not implemented; observable as one word in the blog's search index |
| raw HTML through the markdown front end | md4c has no rehype-raw round trip; two `docs-site` files differ by blank lines |
| a resized image's bytes | different codecs on purpose; same dimensions, same paths |

The command is where the distance is. `bin/mdy.js` has three subcommands and a
document mode; `mdy build` has one subcommand with the essentials:

| bin/mdy.js | mdy build |
| --- | --- |
| `mdy build [dir] [--out] [--drafts] [--future] [--entry] [--publish [--broker]]` | `mdy build <dir> --out <dir> [--entry] [--drafts] [--future] [--quiet]` |
| `mdy [path] [-o] [--html] [--emit-js] [-d k=v] [--data-file] [--watch]` | — |
| `mdy dev [dir] [--port] [--broker] [--consumer] [--group] …` | — |
| `mdy dead <name> [--broker] [--requeue]` | — |
| `[read]`/`[write]` lines and a progress bar on a terminal | a summary line |

The JavaScript CLI has 40 tests in `test/cli.test.js`, and they are the
specification: every one of them runs the CLI as a subprocess and asserts on
its output and exit code, which means every one of them can run the C binary
instead. That is the method for the whole of this plan — the same one that
took the parser to 87/87 and the engine to byte-identical sites: **make the
existing tests the harness, measure, and close what they report.**

## Phase 0 — the harness

`scripts-compare-cli.mjs`: runs `test/cli.test.js`'s cases against both
binaries — the node CLI and `build/mdy` — and reports which agree. Not a port
of the tests; a runner that swaps the executable, so a test added upstream is
a test here. The cases that need node-only machinery (none, on reading them)
are listed rather than skipped silently.

`make check-cli` reports `N/40 cases agree`. Everything below moves that
number, and the plan is done at 40/40.

Exit: the harness runs, and the number it prints is the honest starting point
(it will be low — most cases are document mode).

## Phase 1 — `mdy build`, whole

Small, and the first thing a user notices. The binary becomes `mdy` with
`build` as a subcommand (`mdy build` stays as an alias for CI and the golden
checks), and gains what the JavaScript has:

- the site directory defaults to `.` and `--out` to `<site>/dist`;
- `[read] path` per source and `[write] path` per output, through one
  logger, with the progress line beneath them on a terminal and plain lines
  when redirected — exactly `src/progress.js`'s contract, since a pipeline
  reading those lines must not care which binary wrote them;
- the closing line: `✓ built N page(s) → dir (Nms)`;
- messages held: `[hold] name` per message and the "not sent — pass
  --publish" line, so the output is the JavaScript's byte for byte when
  nothing is sent;
- `--help` for the subcommand, with the JavaScript's text.

Exit: `mdy build` cases in check-cli agree; check-sites and the golden checks
unchanged.

## Phase 2 — document mode

The larger half of the CLI's surface, and the one that makes `mdy` a tool
rather than a site builder. The engine already has most of it — `mdy_engine_open`
takes a single source, `mdy_script_source` is what `--emit-js` prints — and the
work is the driver and two engine additions:

- **`mdy [path]`**: a `.mdy` file, a directory, or `-`/nothing for stdin. A
  file renders alone, its own `---` documents with the first as entry, and
  sees no sibling files; a directory is the site walk with `--entry`.
- **`-o`**: a file, or an existing directory under which `$.emit` output
  lands; refuses to overwrite the input; `$.emit` output is reported and not
  written without it.
- **`--html`** against the default of the text the document's code wrote,
  which is what an `.mdy` producing a feed or a `robots.txt` means. The
  engine renders to HTML today; the text form is `scriptOutput` before the
  parse, which `render_tree` already holds and can hand back.
- **`--emit-js`**: every document for a file, the entry for a directory;
  rejects `--html`.
- **`-d k=v` and `--data-file`**: context on `req`, over front matter as an
  explicit fallback. The engine sets booleans on the context today
  (`mdy_engine_set_context_bool`); this needs values — a JSON value, and a
  YAML file through the parser's own reader — so `mdy_engine_set_context_json`
  and a YAML-to-context path over `mdy_yaml_parse`.
- warnings and exit codes as the tests expect: non-`.mdy` input warns and
  proceeds, a missing input exits non-zero with the message, more than one
  positional is rejected.

Exit: every document-mode case in check-cli except `--watch` agrees.

## Phase 3 — render memoisation

The one engine difference that is not a deliberate divergence. The contract
is in `src/mdy.js` and it is precise: a render is reusable when it is a pure
function of the document's code, its own data and `req`, which is any render
that did not query, render another document, read `$.data`, emit, publish or
call an embedder native; the key is a fingerprint of the set's native names,
the document's path, its body and its data, plus the request; two generations,
rotated per build, at most 4096 entries.

The engine knows when a render reached outside — every one of those goes
through a native it owns — so marking impurity is a flag set in each native.
The store is a hash map from fingerprint to a kept tree, and `kept` already
exists for tokens. Layouts are the bulk of what this saves, rendered once per
page today.

Exit: check-sites' blog expectation goes from 1 differing file to 0, and a
93-page build measurably faster (the current 6 s against node's 16 s
re-renders every layout for every page).

## Phase 4 — `--publish` and `mdy dead`

What the JavaScript does is four HTTP requests: `POST /pub/<name>` with an
`application/binjson` body per message after a successful build,
`GET /dead/<name>` and `POST /requeue/<name>?index=N` for `dead`. The broker
is local by default (`http://127.0.0.1:8080`) and there is no TLS.

The body is binjson, which the engine already writes (`mdy_bj_document` in
`src/ingest.c` encodes documents for nisaba; a message's data is the same
encoding). What is missing is an HTTP client: sukkal's vendored http11c is a
server. A minimal HTTP/1.1 client over a socket — request line, a few
headers, a body, read the status line and the body — is a few hundred lines
in C with the same platform split `fsx.c` has (BSD sockets, winsock), and
it is all `--publish`, `dead` and Phase 5's consumer need.

Exit: `mdy build --publish` against a running sukkal sends what the
JavaScript sends (the broker's log agrees); `mdy dead` lists and requeues.

## Phase 5 — `--watch` and `mdy dev`

The most platform work for the least rendering value, so last. Three pieces:

- **A watcher.** `src/fs-provider.js`'s `watch()` is recursive `fs.watch`; the
  JavaScript debounces and rebuilds the whole site on any change. The C
  version starts with a polling watcher — a recursive mtime scan every few
  hundred milliseconds, which is portable, exact enough and one file — with
  FSEvents, inotify and ReadDirectoryChangesW as a later upgrade behind the
  same interface. `--watch` in document mode re-renders the file (or the
  directory) and `--data-file` on change, and survives a render error.
- **A server.** http11c, which is in the tree and platform-clean. `mdy dev`
  renders in memory and serves outputs from the map, `$.resize` results from
  their map and `static/` from disk; injects the reload snippet into every
  page; holds SSE connections on `/__mdy__/events` and sends on rebuild; keeps
  serving the last good build when a rebuild fails. Nothing touches `dist/`.
- **The consumer loop.** With a broker reachable, `dev` registers a consumer
  (`--consumer`, `--group`, the retry knobs) and renders whichever page each
  delivered message addresses with the message as `req`, acknowledging on
  success. Phase 4's client plus http11c's server, since deliveries arrive
  as POSTs to `/mdy/<consumer>`.

Phase 3's memo is what makes a rebuild cheap here — unchanged files come back
from the ingest memo and unchanged renders from the render memo — so this
phase depends on it, which is another reason for the order.

Exit: the `--watch` cases in check-cli agree; `serve.test.js`'s cases, run the
same way against `mdy dev`, agree.

## Phase 6 — the two documented differences

Neither blocks parity as a tool, and both are pinned by check-sites, so they
are last and optional:

- **Raw HTML through markdown.** The difference is blank lines around a raw
  block, which is rehype-raw's HTML5 round trip. Measure first: if the whole
  difference is whitespace placement around raw blocks, a targeted rule in
  `src/parse/markdown.c` closes it; if it is the parser's foster-parenting in
  general, an HTML5 parser in C is the honest answer and a large one.
- **Resized image bytes.** Only the JavaScript's codecs would close it, and
  they are WebAssembly. Leave, documented.

## What this plan does not include

`mdy-web`, `mdy-live-preview` and the desktop shell are the JavaScript
bundle's and Tauri's, per docs/desktop-plan.md, and are not what `bin/mdy.js`
is. Nor does this plan port mdy-docs' 776 library tests: they test the
JavaScript, and the engine is held to it by building real sites both ways.

## Size and order

| phase | what | size |
| --- | --- | --- |
| 0 | the harness over cli.test.js | a day |
| 1 | `mdy build`, whole | a day |
| 2 | document mode | three or four days |
| 3 | render memoisation | two or three days |
| 4 | an HTTP client; `--publish`, `dead` | two days |
| 5 | watcher, `dev` server, consumer loop | a week |
| 6 | the documented differences | measure first |

Phases 1 and 2 make `mdy` a drop-in for everything that is not a dev loop,
which is most uses; 3 is the one engine change and the performance win; 4
and 5 are the messaging and development halves, in dependency order. The
number that says how far along it is comes from Phase 0, and every phase
ends by moving it.
