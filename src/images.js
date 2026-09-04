import decodePng, { init as initPngDecode } from '@jsquash/png/decode.js';
import encodePng, { init as initPngEncode } from '@jsquash/png/encode.js';
import resizeImage, { initResize } from '@jsquash/resize';

/*
 * $.resize — a VM-callable native (mdy-docs' options.natives, see
 * ../mdy.js) that lets a script-defined site's entry document ask for a
 * resized copy of an image (a raw document from walkRawSources — see
 * src/vault.js) and get back where to find it:
 *
 *   % const logo = $.findOne({ path: 'static/logo.png' })
 *   % const thumb = $.resize(logo, { width: 200 })
 *   <img src="{{ thumb.url }}" width="{{ thumb.width }}" height="{{ thumb.height }}">
 *
 * The resized image is a BUILD OUTPUT, never written back into the site
 * root's own static/ on disk — createResizeNative's `registerBinaryOutput`
 * callback is how it reaches script-site.js's `binaryOutputs`. Its output
 * path/url is dist-relative, not site-root-relative like the source
 * document's own `path` — a source under static/ has that prefix stripped
 * (STATIC_PREFIX, below), matching how buildSite/serve.js already flatten
 * static/'s contents straight to the dist root.
 *
 * WASM codecs (@jsquash/*, github.com/jamsinclair/jSquash — Squoosh's
 * codecs repackaged for Node/browser/Deno), not `sharp`: this runs the same
 * way in the CLI and (eventually) the in-browser editor, matching why
 * lamassu/nisaba are wasm in the first place — no native binary to
 * prebuild per platform, no browser-only gap.
 *
 * PNG only for now — @jsquash/jpeg wraps mozjpeg via an Emscripten-style
 * module init that doesn't share PNG/resize's wasm-bindgen init shape
 * (below); wiring it is just adding another CODECS entry, not a design
 * change, but it's real work and out of scope for the first cut.
 */

const CODECS = {
  '.png': { decode: decodePng, encode: encodePng },
};

// build.js's buildSite copies static/'s CONTENTS straight to the dist
// root (static/logo.png → dist/logo.png, not dist/static/logo.png — the
// same convention serve.js's readStatic uses for a live request) — a
// resize output has to land in that same flattened space, or its URL
// wouldn't match how the original file (and every other static asset) is
// actually served.
const STATIC_PREFIX = 'static/';

let readyPromise;

/** jsquash's own default self-init does `fetch(new URL(..., import.meta.url))`
 * — fine in a browser (a real http(s) URL), but Node's fetch doesn't support
 * file:// URLs at all. So in Node, read each codec's .wasm bytes ourselves
 * and init explicitly; in a browser, let jsquash's own default path run
 * (nothing to do here). Runs once per process either way. */
async function ensureCodecsReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      /*
       * The codecs are WebAssembly, so a runtime without it cannot resize at
       * all — packages/mdy-native runs mdy-docs on QuickJS, which has no
       * WebAssembly by design. Said here, where it is true, because the
       * failure otherwise arrives as whatever the codec loader happens to trip
       * over first (a missing node:fs, a module that will not instantiate) and
       * then again, unrecognisably, as a null tree in whatever page used it.
       */
      if (typeof WebAssembly === 'undefined') {
        throw new Error(
          '$.resize needs WebAssembly for its image codecs, and this runtime has none. ' +
            'Resize the image ahead of time, or build on a runtime that does.'
        );
      }
      if (typeof window !== 'undefined') return; // browser: jsquash self-inits lazily
      const [{ readFile }, { fileURLToPath }] = await Promise.all([
        import('node:fs/promises'),
        import('node:url'),
      ]);
      const wasmBytes = async (specifier) =>
        new Uint8Array(await readFile(fileURLToPath(import.meta.resolve(specifier))));
      const [pngWasm, resizeWasm] = await Promise.all([
        wasmBytes('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'),
        wasmBytes('@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm'),
      ]);
      await Promise.all([initPngDecode(pngWasm), initPngEncode(pngWasm), initResize(resizeWasm)]);
    })();
  }
  return readyPromise;
}

/**
 * Build the `resize` native for one renderSite() call. `fs`/`root` read the
 * source image's real bytes; `registerBinaryOutput(path, bytes)` is how a
 * resized image reaches the caller (build.js threads it into a shared,
 * per-render mutable slot — see its `currentBinaryOutputs`, the same
 * pattern `onQuery`/`currentQueries` already uses).
 *
 * Memoized per (source path, output width x height) for the lifetime of
 * this native — many pages resizing the same image the same way only
 * decode/resize/encode it once per build.
 */
export function createResizeNative({ fs, root, registerBinaryOutput }) {
  const memo = new Map();

  return async function resize(fileDoc, options = {}) {
    // Conventional mode's file records carry `kind: 'file'`; a script-
    // defined site's raw documents (walkRawSources) carry no `kind` at all
    // — same identity fields otherwise (path/ext/width/height), so this
    // only requires the shape it actually needs, not edubba's own marker.
    if (!fileDoc || typeof fileDoc.path !== 'string' || typeof fileDoc.ext !== 'string') {
      throw new Error('resize: expected a file document (path/ext, from $.find/$.findOne), not ' + JSON.stringify(fileDoc));
    }
    const ext = String(fileDoc.ext ?? '').toLowerCase();
    const codec = CODECS[ext];
    if (!codec) {
      throw new Error(`resize: unsupported image type ${JSON.stringify(fileDoc.ext)} (supported: ${Object.keys(CODECS).join(', ')})`);
    }
    if (typeof fileDoc.width !== 'number' || typeof fileDoc.height !== 'number') {
      throw new Error(`resize: ${fileDoc.path} has no known width/height (its dimensions could not be read)`);
    }

    let { width, height } = options;
    if (width == null && height == null) {
      throw new Error('resize: pass at least one of { width, height }');
    }
    if (width == null) width = Math.round((height / fileDoc.height) * fileDoc.width);
    if (height == null) height = Math.round((width / fileDoc.width) * fileDoc.height);
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));

    const sourceStem = fileDoc.path.slice(0, fileDoc.path.length - fileDoc.ext.length);
    const stem = sourceStem.startsWith(STATIC_PREFIX) ? sourceStem.slice(STATIC_PREFIX.length) : sourceStem;
    // `outputPath` is dist-relative (post-flattening), not site-root-relative
    // like a kind: 'file' record's own `path` — it's where the resized file
    // actually lands in dist/ and is served from, not where its source lives.
    const outputPath = `${stem}-${width}x${height}${fileDoc.ext}`;

    if (!memo.has(outputPath)) {
      memo.set(outputPath, (async () => {
        await ensureCodecsReady();
        const decoded = await codec.decode(await fs.readBinary(root, fileDoc.path));
        const resized =
          width === fileDoc.width && height === fileDoc.height ? decoded : await resizeImage(decoded, { width, height });
        const bytes = new Uint8Array(await codec.encode(resized));
        registerBinaryOutput(outputPath, bytes);
        return { path: outputPath, url: `/${outputPath}`, width, height };
      })());
    }
    return memo.get(outputPath);
  };
}
