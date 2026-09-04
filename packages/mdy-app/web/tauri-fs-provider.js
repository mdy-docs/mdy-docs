/*
 * The filesystem, reached through Tauri.
 *
 * mdy-docs takes its filesystem as an argument — `renderSite(root, { fs })` —
 * and ships two providers of its own: the real one over node:fs, and an
 * in-memory one for a browser. This is the third, and it is the only piece of
 * the application that has to exist at all: everything above it, the parser,
 * the document engine, the query engine and the site layer, is the unmodified
 * browser bundle.
 *
 * The contract is documented in ../../../src/fs-provider.js. Nine methods, of
 * which `watch` is optional at every call site (`fs.watch?.(…)`).
 *
 * Two differences from the Node provider are worth stating, because they are
 * properties of the boundary rather than of this code:
 *
 *   - Every call is IPC. Node's `readdir` with `{ recursive: true }` is one
 *     syscall; here it is a round trip per directory, so `list` walks
 *     breadth-first and reads each level's directories concurrently.
 *   - Paths are joined with `/`. Tauri's fs accepts it on every platform, and
 *     the provider contract speaks `/`-separated relative paths regardless of
 *     what the host underneath calls a separator.
 */

import {
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  stat,
  watchImmediate,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';

/** `root` and a `/`-separated relative path, as one path for the host. */
const at = (root, relPath) => {
  const base = String(root).replace(/\/+$/, '');
  const rel = String(relPath ?? '').replace(/^\/+/, '');
  return rel === '' ? base : `${base}/${rel}`;
};

/** True when a missing path is the reason a call failed. Tauri surfaces the
 * OS message rather than a code, so this matches on the text — narrow enough
 * not to swallow a permission error, which must not read as "not there". */
const isMissing = (err) => /no such file|not found|cannot find|NotFound|os error 2/i.test(String(err));

export function tauriFsProvider() {
  return {
    /**
     * Every file under `root/subdir`, recursively, as sorted `/`-separated
     * relative paths. Missing directory → []. `options.extensions` defaults to
     * ['.mdy']; `null` means every file whatever its extension.
     */
    async list(root, subdir, options = {}) {
      const extensions = 'extensions' in options ? options.extensions : ['.mdy'];
      const base = at(root, subdir === '.' ? '' : subdir);

      const found = [];
      // Breadth-first, a level at a time: readDir is one IPC call per
      // directory, so the levels are read concurrently rather than in turn.
      let level = [''];
      while (level.length > 0) {
        const results = await Promise.all(
          level.map(async (dir) => {
            try {
              return { dir, entries: await readDir(dir === '' ? base : `${base}/${dir}`) };
            } catch (err) {
              if (isMissing(err)) return { dir, entries: [] };
              throw err;
            }
          })
        );
        const next = [];
        for (const { dir, entries } of results) {
          for (const entry of entries) {
            const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
            if (entry.isDirectory) next.push(rel);
            else if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) found.push(rel);
          }
        }
        level = next;
      }
      return found.sort();
    },

    async read(root, relPath) {
      return readTextFile(at(root, relPath));
    },

    async readBinary(root, relPath) {
      return readFile(at(root, relPath));
    },

    async mtime(root, relPath) {
      const info = await stat(at(root, relPath));
      // Tauri reports it as a Date already on some platforms and as epoch
      // milliseconds on others; the contract says Date.
      return info.mtime instanceof Date ? info.mtime : new Date(info.mtime ?? 0);
    },

    async size(root, relPath) {
      return (await stat(at(root, relPath))).size;
    },

    async write(root, relPath, text) {
      await ensureParent(root, relPath);
      await writeTextFile(at(root, relPath), text);
    },

    async writeBinary(root, relPath, bytes) {
      await ensureParent(root, relPath);
      await writeFile(at(root, relPath), bytes);
    },

    /** A missing path is not an error — the contract says so. */
    async remove(root, relPath) {
      try {
        await remove(at(root, relPath));
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    },

    /**
     * Recursive watch. `watchImmediate` rather than `watch` because the
     * debounced variant coalesces events and this layer has its own debounce
     * upstream; two of them only add latency.
     */
    async watch(root, callback) {
      const stop = await watchImmediate(
        String(root),
        (event) => {
          for (const path of event.paths ?? []) callback({ type: kindOf(event), path });
        },
        { recursive: true }
      );
      return { close: () => stop() };
    },
  };
}

/** Create the directory a file is about to be written into. */
async function ensureParent(root, relPath) {
  const rel = String(relPath).replace(/^\/+/, '');
  const cut = rel.lastIndexOf('/');
  if (cut === -1) return;
  const dir = at(root, rel.slice(0, cut));
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
}

/** Tauri's event shape to the contract's `type`. Anything unrecognised is
 * 'unknown' rather than a guess — a caller that rebuilds on any change does
 * not care, and one that does care should not be misled. */
function kindOf(event) {
  const t = event?.type;
  if (typeof t === 'string') {
    if (t === 'any' || t === 'other') return 'unknown';
    return t;
  }
  if (t && typeof t === 'object') {
    if ('create' in t) return 'create';
    if ('modify' in t) {
      const mode = t.modify?.kind;
      return mode === 'rename' ? 'rename' : 'modify';
    }
    if ('remove' in t) return 'delete';
  }
  return 'unknown';
}
