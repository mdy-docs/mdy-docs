import { nodeFsProvider } from './fs-provider.js';

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
