import { nodeFsProvider } from './fs-provider.js';
import { imageSize } from 'image-size';
import { parse as loadYaml } from 'yaml';
import { extractTags } from './mdy.js';

/*
 * vault — a directory of documents as a queryable set.
 *
 * walkVault(root, options) walks a directory of *.mdy files into
 * `{ text, meta }` sources ready for mdy's openDocumentSet(sources) — the
 * whole "directory of documents → queryable set" primitive, and nothing
 * more: meta carries only file identity (path, mtime), never an
 * interpretation of what that path MEANS. A blog wants a pretty URL and a
 * section from it; a notes app wants a folder hierarchy; a wiki wants a
 * page title from the filename. All of those are consumer-specific and
 * belong in the consumer — see edubba's own src/vault.js for the SSG's
 * layer built on top of this (computed URLs/sections/dates, draft
 * filtering, layout-name derivation — none of it belongs here, because
 * none of it is true of documents in general).
 *
 * File access goes through an `options.fs` provider (fs-provider.js) — the
 * real filesystem by default, or an in-memory one for a browser consumer.
 * `options.extensions` (default: ['.mdy']) selects which file extensions
 * to include — passed straight through to the provider's list().
 *
 * walkFiles(root, options), below, is the other half: every file, not just
 * documents, and never their content — a plain inventory (path, name, ext,
 * size, mtime) a consumer can insert into its own document set however it
 * likes (edubba: a `kind: 'file'` record for anything not already a page/
 * layout/data document — see its own src/vault.js).
 */
export async function walkVault(root, options = {}) {
  const fs = options.fs ?? nodeFsProvider();
  const subdir = options.subdir ?? '.';
  const extensions = 'extensions' in options ? options.extensions : ['.mdy'];
  const out = [];
  for (const rel of await fs.list(root, subdir, { extensions })) {
    const relPath = subdir === '.' ? rel : `${subdir}/${rel}`;
    const text = await fs.read(root, relPath);
    const mtime = await fs.mtime(root, relPath);
    out.push({ text, meta: { path: relPath, mtime } });
  }
  return out;
}

/**
 * Walk every file under `root` (or `options.subdir`) recursively — a pure
 * file inventory, deliberately not walkVault: no content is ever read, so
 * this is safe over binary files (images, fonts, anything) that walkVault
 * would corrupt or waste memory reading as text. Returns `{ path, name,
 * ext, size, mtime }` per file — `path` is '/'-separated and relative to
 * `root` (prefixed with `subdir` the same way walkVault's is); `name` is
 * its basename; `ext` is its extension including the dot, or `''` (a
 * dotfile like ".gitignore" has no extension by this reckoning, not a
 * bare name with an empty one).
 *
 * `options.extensions` narrows it the same way it narrows list() — but
 * defaults to `null` (every file, any extension) here, the opposite of
 * walkVault's default of `['.mdy']`: the point of this function is usually
 * "everything", the exception being "only these kinds of files."
 */
export async function walkFiles(root, options = {}) {
  const fs = options.fs ?? nodeFsProvider();
  const subdir = options.subdir ?? '.';
  const extensions = 'extensions' in options ? options.extensions : null;
  const out = [];
  for (const rel of await fs.list(root, subdir, { extensions })) {
    const path = subdir === '.' ? rel : `${subdir}/${rel}`;
    const slash = path.lastIndexOf('/');
    const name = slash === -1 ? path : path.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const ext = dot <= 0 ? '' : name.slice(dot); // dot === 0: a dotfile, not an extension
    const [size, mtime] = await Promise.all([fs.size(root, path), fs.mtime(root, path)]);
    out.push({ path, name, ext, size, mtime });
  }
  return out;
}

// Never treat build output, dependencies, or VCS/editor droppings as source.
const NON_SOURCE = /(^|\/)(dist|node_modules|\.[^/]+)(\/|$)/;

// A placeholder body for anything that isn't a .mdy file — never read as
// text (safe for real binary content); its raw identity (path/name/ext/
// size/mtime) is still a real, queryable document. U+200B (zero-width
// space): survives mdy's own "a whitespace-only document is dropped" check
// while staying invisible if anything ever did render it.
const PLACEHOLDER_BODY = '​';

// Extensions worth trying image-size on — a superset of what $.resize
// (src/images.js) can actually decode: dimensions are cheap
// (header-only, no full decode) and worth having as raw identity for any
// recognizable image, even one $.resize can't process (yet).
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico', '.tiff', '.tif',
]);

/**
 * Walk `root` into the raw `{ text, meta }` sources openDocumentSet expects:
 * every file gets its identity (path/name/ext/size/mtime), plus whatever its
 * own FILE FORMAT means — not a site-building convention like "posts live
 * in posts/" or "url from path" (that's still entirely the entry script's
 * job), but the same kind of thing mdy's own parser already does for
 * `.mdy` (front matter + a live template body) or image-size does for a
 * recognized image (below):
 *
 *   .mdy         real text, compiled as an mdy template (front matter +
 *                `%`/`{{ }}` body) — openDocumentSet's normal job.
 *   .md          real text, but NEVER compiled as a template (the same
 *                reasoning conventional mode's vault.js documents: a bare
 *                `---`/`+++` or a literal `{{ }}` in real prose must not be
 *                misinterpreted) — so `text` here stays the placeholder
 *                (nothing to compile), and the real text lands in
 *                `meta.body` instead, directly `$.find`/`$.findOne`-able;
 *                inline #hashtags are still extracted into `meta.tags`
 *                (a safe standalone scan, not the full mdy parse).
 *   .yaml/.yml   parsed as a YAML mapping, its fields merged into `meta`
 *                directly (identity — path/name/ext/size/mtime — always
 *                wins over anything the file itself declares) — pure data,
 *                no body, `text` stays the placeholder. A parse failure or
 *                non-mapping document degrades to an identity-only record
 *                (a warning, not a build failure) — a whole-directory walk
 *                can't assume every stray .yaml under the root (a CI
 *                config, anything) is even meant to be a data record.
 *   (anything    the placeholder body; a recognized image extension also
 *    else)       gets `width`/`height` (image-size — header-only, no full
 *                decode; corrupt/unsupported just keeps the record without
 *                them, not an error) — so $.resize (images.js) has what it
 *                needs on a raw document with no host-side "kind: 'file'"
 *                convention layered on first.
 *
 * dist/, node_modules/, and dotfiles/dot-directories are excluded
 * (NON_SOURCE, above).
 *
 * This is the "a whole directory IS the document set" primitive — one
 * entry document can `$.find`/`$.render`/`$.emit` against every other file
 * under `root` with no host-side interpretation of what any path means
 * (that's the entry script's own job, in template code). It's what `mdy
 * <directory>` uses (see bin/mdy.js) — a plain directory input needs
 * nothing beyond this plus `openDocumentSet`.
 *
 * @param {string} root
 * @param {{ fs?: object }} [options]
 * @returns {Promise<{ text: string, meta: { path: string, name: string, ext: string, size: number, mtime: number, width?: number, height?: number, body?: string, tags?: string[] } }[]>}
 */
export async function walkRawSources(root, options = {}) {
  const fs = options.fs ?? nodeFsProvider();
  const files = (await walkFiles(root, { fs })).filter((f) => !NON_SOURCE.test(f.path));
  return Promise.all(
    files.map(async (file) => {
      const meta = { path: file.path, name: file.name, ext: file.ext, size: file.size, mtime: file.mtime };
      const ext = file.ext.toLowerCase();

      if (ext === '.mdy') {
        return { text: await fs.read(root, file.path), meta };
      }

      if (ext === '.md') {
        const text = await fs.read(root, file.path);
        const tags = extractTags(text);
        return { text: PLACEHOLDER_BODY, meta: { ...meta, body: text, ...(tags.length > 0 ? { tags } : {}) } };
      }

      if (ext === '.yaml' || ext === '.yml') {
        const text = await fs.read(root, file.path);
        try {
          const parsed = text.trim() === '' ? null : loadYaml(text);
          if (parsed != null) {
            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error(`${file.path} must be a YAML mapping`);
            }
            // Only `path` is structurally required to always be real (other
            // raw-mode code resolves documents by it — entry lookup, etc.).
            // `name`/`ext`/`size`/`mtime` are fallback DEFAULTS, not reserved:
            // a data record commonly declares its own `name` or `size`
            // (Ada Lovelace's `name`, a product's `size`, …), and identity
            // silently shadowing that would make the file's own data
            // unreachable under the field it actually used.
            return { text: PLACEHOLDER_BODY, meta: { ...meta, ...parsed, path: file.path } };
          }
        } catch (err) {
          console.warn(`mdy: ${err.message} — ${file.path} keeps its raw identity, no parsed fields`);
        }
        return { text: PLACEHOLDER_BODY, meta };
      }

      if (IMAGE_EXTENSIONS.has(ext)) {
        try {
          const { width, height } = imageSize(await fs.readBinary(root, file.path));
          meta.width = width;
          meta.height = height;
        } catch {
          // Not decodable (corrupt, truncated, unsupported variant) — still
          // a real file, still gets its raw record; just no width/height.
        }
      }
      return { text: PLACEHOLDER_BODY, meta };
    })
  );
}
