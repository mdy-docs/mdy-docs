# The engine in a browser

The fourth target. `build/mdy` is C with one platform surface — POSIX
file access in `src/fsx.c` — and its document store is memory already, so the
same sources compile with emscripten unchanged and run against an in-memory
filesystem. A build in the browser is: put the site's files into that
filesystem, run `main()` as the command line would, read `dist/` back out.

```sh
make wasm          # build/wasm/mdy-native.mjs + .wasm, needs emcc (emsdk 5.0.7)
make check-wasm    # the golden sites through it under node, byte for byte
make serve-wasm    # then open http://localhost:8080/wasm/
```

What is here:

    index.mjs          the wrapper: `build(files, { site }) -> { files, log, status }`
    check-golden.mjs   what `make check-wasm` runs — the same bar as check-golden
    index.html         a page: pick a directory, build it, look at the output
    serve.mjs          a file server that knows what a .mjs file is

## Using it

```js
import { build, text } from './wasm/index.mjs';

const site = new Map([
  ['main.mdy',       '% $.emit("index.html", "<h1>hello</h1>")\n'],
  ['static/x.css',   'body { margin: 0 }'],
]);
const { files, log, status } = await build(site);
text(files.get('index.html'));   // '<h1>hello</h1>'
```

`files` in and `files` out are the same shape: a path relative to the site,
and bytes (or text, going in). Nothing is fetched and nothing is served; the
page in `index.html` reads a picked directory with the File API and everything
after that is memory.

Each call instantiates the module afresh. That is cheap next to a build, and
it is the honest way to promise that two builds share nothing: the engine
keeps a little static state that a process never had to reset.

**A site that imports a package by relative path** — `fixture-pkg` imports
`"../fixture-style"` — needs the package mounted beside it. Mount the tree
that holds both and name the site with `site: 'fixture-pkg'`;
`check-golden.mjs` does exactly that, and the page's second box is the same
thing.

## What it is held to

`make check-wasm` builds the three golden sites through the wasm engine and
diffs them against `golden/`, which is what the native binary is checked
against on every platform. It is the same bar and the same files, so a
difference there belongs to the wasm build alone. CI runs it as a job of its
own, next to the three native platforms.

The module is about 1.8 MB, everything included — both engines, the front
end, the image codecs — and a golden site builds in a few milliseconds under
node.

## Where it stops

The page previews a built page as itself, in a frame, but a page's links to
its siblings and its stylesheet are relative paths into a `dist/` that exists
only in memory, so they do not resolve from a blob URL. The list on the left
is the navigation. Serving the built tree from a Service Worker — the shape
docs/desktop-plan.md describes for the JavaScript bundle — is the step after
this one, and it is a page's concern rather than the engine's.

`$.resize` works here as it does natively, over stb, with the same caveat:
the bytes of a resized image differ from what mdy-docs' Squoosh codecs write.
