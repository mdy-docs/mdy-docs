/*
 * A file-system provider abstracts how a vault is read (and, now, written
 * and watched) — the real filesystem (nodeFsProvider, the default
 * everywhere), an in-memory one (memoryFsProvider, for a browser consumer
 * with no persistence), or a real origin-private one (opfsFsProvider, for a
 * browser consumer that wants edits to survive a reload).
 *
 * This is what makes a whole document-set pipeline runnable client-side:
 * once file access goes through this interface instead of calling node:fs
 * directly, a consumer works identically against real files, an in-memory
 * `Map<path, text>`, or OPFS — edubba's web/ editor (a consumer of this
 * package, not part of it) is built on exactly that. Note on why
 * nodeFsProvider imports node:fs/node:path LAZILY, inside its methods,
 * rather than at module scope: a browser bundler's static import
 * validation rejects a named import of a browser-externalized Node
 * builtin even when nothing calls it, so this file must not import them
 * at the top level — this package needs to bundle cleanly for the browser
 * itself (mdy-docs' own web/ playground), independent of any consumer.
 *
 * Interface — list/read/mtime are required, every provider below has them.
 * write/remove/watch are OPTIONAL capabilities: check for the method before
 * calling it (`fs.watch?.(...)`). memoryFsProvider has no watch — nothing
 * outside the same JS heap can mutate its Map, so there is nothing to
 * detect; a caller that mutates it already knows to re-render, no
 * notification needed.
 *
 *   list(root, subdir, options?)
 *                          → matching file paths under `${root}/${subdir}`,
 *                            relative to it, '/'-separated, sorted.
 *                            subdir '.' means root itself. Missing subdir
 *                            → []. `options.extensions` (default: ['.mdy'])
 *                            selects which file extensions match — a
 *                            consumer recognizing more than one document
 *                            shape (edubba: .mdy templates, plain .md,
 *                            data-only .yaml/.yml) passes its own list;
 *                            walkVault() threads this through.
 *                            `options.extensions: null` means no filter —
 *                            every file, any extension (a file browser over
 *                            a whole vault, not just its documents).
 *   read(root, relPath)   → Promise<string> file contents, decoded as UTF-8
 *                            text — wrong for a genuinely binary file (an
 *                            image); use readBinary for those.
 *   readBinary(root, relPath) → Promise<Uint8Array> raw bytes, undecoded.
 *                            memoryFsProvider's Map may hold either a
 *                            string or a Uint8Array per path; read()/
 *                            readBinary() convert either way as needed
 *                            (UTF-8 encode/decode), so a consumer never has
 *                            to know which one a given entry actually is.
 *   mtime(root, relPath)  → Promise<Date>
 *   size(root, relPath)   → Promise<number> byte size (memoryFsProvider has
 *                            no real bytes for a text entry — its text
 *                            length stands in, the same "no real X in
 *                            memory" convention as mtime; a Uint8Array
 *                            entry's real length is exact)
 *   write(root, relPath, text) → Promise<void>, creates parent dirs as needed
 *   writeBinary(root, relPath, bytes: Uint8Array) → Promise<void>, same as
 *                            write() but for raw bytes
 *   remove(root, relPath) → Promise<void>, missing path is not an error
 *   watch(root, callback, options?)
 *                          → Promise<{ close() }>. callback gets
 *                            `{ type: 'create'|'modify'|'delete'|'rename'|
 *                            'unknown', path }` per change, recursively,
 *                            for as long as `root` exists — not just files
 *                            present at watch-start. `options.extensions`
 *                            narrows the polling fallback the same way it
 *                            narrows list(); native watchers report every
 *                            path and let the caller filter.
 */

/** The real filesystem, via node:fs/promises. */
export function nodeFsProvider() {
  let node; // { fsp, path }, loaded once on first use
  const ensure = async () => {
    if (!node) {
      const [fsp, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      node = { fsp, path };
    }
    return node;
  };

  return {
    async list(root, subdir, options = {}) {
      const extensions = 'extensions' in options ? options.extensions : ['.mdy'];
      const { fsp, path } = await ensure();
      const dir = path.join(root, subdir);
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true, recursive: true });
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
      return entries
        .filter((e) => e.isFile() && (!extensions || extensions.some((ext) => e.name.endsWith(ext))))
        .map((e) => path.join(e.parentPath ?? e.path, e.name))
        .map((p) => p.slice(dir.length + 1).split(path.sep).join('/'))
        .sort();
    },
    async read(root, relPath) {
      const { fsp, path } = await ensure();
      return fsp.readFile(path.join(root, ...relPath.split('/')), 'utf8');
    },
    async readBinary(root, relPath) {
      const { fsp, path } = await ensure();
      return fsp.readFile(path.join(root, ...relPath.split('/'))); // no encoding → a Buffer (a Uint8Array)
    },
    async mtime(root, relPath) {
      const { fsp, path } = await ensure();
      return (await fsp.stat(path.join(root, ...relPath.split('/')))).mtime;
    },
    async size(root, relPath) {
      const { fsp, path } = await ensure();
      return (await fsp.stat(path.join(root, ...relPath.split('/')))).size;
    },
    async write(root, relPath, text) {
      const { fsp, path } = await ensure();
      const full = path.join(root, ...relPath.split('/'));
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, text, 'utf8');
    },
    async writeBinary(root, relPath, bytes) {
      const { fsp, path } = await ensure();
      const full = path.join(root, ...relPath.split('/'));
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, bytes);
    },
    async remove(root, relPath) {
      const { fsp, path } = await ensure();
      await fsp.rm(path.join(root, ...relPath.split('/')), { force: true });
    },
    /** Native fs.watch(root, {recursive:true}) — one watcher for the whole
     * tree, proven in edubba's own serve.js. 'rename' covers both create
     * and delete (Node doesn't distinguish); callers that care stat the
     * path themselves. */
    async watch(root, callback) {
      const [fsSync, path] = await Promise.all([import('node:fs'), import('node:path')]);
      const watcher = fsSync.watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        callback({ type: eventType === 'rename' ? 'rename' : 'modify', path: filename.split(path.sep).join('/') });
      });
      return { close: () => watcher.close() };
    },
  };
}

/**
 * An in-memory provider over a flat `Map<path, string | Uint8Array>`. Keys
 * are '/'-separated paths relative to the vault root, e.g. "notes/today.mdy".
 * `root` of `/`, `.`, or `''` means "the whole map, no prefix" (the original,
 * single-vault behavior — every existing caller uses one of these and sees
 * no change); any OTHER root is treated as a NAMESPACE PREFIX into the same
 * flat map (`root: "blog-style-x"` reads/writes keys under
 * `"blog-style-x/…"`) — this is what lets ONE memoryFsProvider instance back
 * more than one root, which importing another mdy project (src/site/
 * imports.js) needs: the importED package's files just live in the same Map
 * under their own prefix, and `walkRawSources(resolvedChildDir, {fs})`
 * resolving to a non-'/' root naturally finds only its own slice. `files` is
 * held BY REFERENCE: mutate it (an editor typing into a textarea,
 * write()/writeBinary()) and the next call sees the change — no
 * rebuild-the-provider step needed. A value may be either a plain string
 * (the common case — text documents) or a Uint8Array (real binary content,
 * e.g. an image written via writeBinary); read()/readBinary() convert
 * either way as needed, so a caller never has to know which one a given
 * entry actually holds. There are no real mtimes in memory; callers that
 * need a fallback date get "now".
 */
export function memoryFsProvider(files) {
  const matches = (p, extensions) => !extensions || extensions.some((ext) => p.endsWith(ext));
  const rootPrefix = (root) => {
    const trimmed = String(root ?? '').replace(/^\/+|\/+$/g, '');
    return trimmed === '' || trimmed === '.' ? '' : `${trimmed}/`;
  };

  return {
    async list(root, subdir, options = {}) {
      const extensions = 'extensions' in options ? options.extensions : ['.mdy'];
      const rp = rootPrefix(root);
      const keys = [...files.keys()].filter((p) => p.startsWith(rp)).map((p) => p.slice(rp.length));
      if (subdir === '.' || subdir === '') {
        return keys.filter((p) => matches(p, extensions)).sort();
      }
      const prefix = subdir.endsWith('/') ? subdir : `${subdir}/`;
      return keys
        .filter((p) => p.startsWith(prefix) && matches(p, extensions))
        .map((p) => p.slice(prefix.length))
        .sort();
    },
    async read(root, relPath) {
      const key = rootPrefix(root) + relPath;
      if (!files.has(key)) {
        throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
      }
      const value = files.get(key);
      return value instanceof Uint8Array ? new TextDecoder().decode(value) : value;
    },
    async readBinary(root, relPath) {
      const key = rootPrefix(root) + relPath;
      if (!files.has(key)) {
        throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
      }
      const value = files.get(key);
      return value instanceof Uint8Array ? value : new TextEncoder().encode(value);
    },
    async mtime() {
      return new Date();
    },
    async size(root, relPath) {
      return files.get(rootPrefix(root) + relPath)?.length ?? 0; // text length (or a Uint8Array's real length) stands in — see interface doc
    },
    async write(root, relPath, text) {
      files.set(rootPrefix(root) + relPath, text);
    },
    async writeBinary(root, relPath, bytes) {
      files.set(rootPrefix(root) + relPath, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    },
    async remove(root, relPath) {
      files.delete(rootPrefix(root) + relPath);
    },
    // No watch(): nothing outside this JS heap can mutate `files`, so
    // there is no change for a watcher to ever observe.
  };
}

/**
 * The origin-private file system (OPFS) — a real, persistent filesystem
 * available to a browser page with no user-facing picker, scoped to the
 * page's origin. `root` is a '/'-separated path *within* OPFS (so several
 * vaults can share one origin without colliding), created on first access.
 *
 * write/remove/watch make this usable as the browser editor's real backing
 * store instead of memoryFsProvider: edits survive a reload, and another
 * tab's edits (or a worker's) are visible here via watch().
 *
 * watch() prefers the native FileSystemObserver API
 * (https://developer.mozilla.org/en-US/docs/Web/API/FileSystemObserver,
 * `observe(handle, {recursive:true})`) where it exists — Chrome/Edge 133+
 * and some Opera builds, as of this writing roughly a fifth of global
 * browser share (caniuse: mdn-api_filesystemobserver). It is still marked
 * experimental and the WHATWG spec (github.com/whatwg/fs/pull/165) isn't
 * finalized. Everywhere else (Firefox, Safari including iOS — no support
 * at all today) it falls back to polling: list() + mtime() on an interval,
 * diffed against the previous snapshot by (path, mtime). Same public
 * shape either way — a consumer never needs to know which one is running.
 */
export function opfsFsProvider() {
  let originPromise;
  const getOrigin = () => {
    if (!originPromise) originPromise = navigator.storage.getDirectory();
    return originPromise;
  };

  const resolveDir = async (dirHandle, relDir, { create = false } = {}) => {
    let dir = dirHandle;
    for (const segment of relDir.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  };

  const resolveRoot = (root, options) => getOrigin().then((origin) => resolveDir(origin, root, options));

  const resolveFile = async (rootHandle, relPath, { create = false } = {}) => {
    const segments = relPath.split('/').filter(Boolean);
    const name = segments.pop();
    const dir = await resolveDir(rootHandle, segments.join('/'), { create });
    return dir.getFileHandle(name, { create });
  };

  async function* walk(dirHandle, prefix) {
    for await (const [name, handle] of dirHandle.entries()) {
      const relPath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        yield* walk(handle, relPath);
      } else {
        yield relPath;
      }
    }
  }

  const provider = {
    async list(root, subdir, options = {}) {
      const extensions = 'extensions' in options ? options.extensions : ['.mdy'];
      const rootHandle = await resolveRoot(root, { create: true });
      let dirHandle;
      try {
        dirHandle = subdir === '.' || subdir === '' ? rootHandle : await resolveDir(rootHandle, subdir);
      } catch (err) {
        if (err.name === 'NotFoundError') return [];
        throw err;
      }
      const out = [];
      for await (const relPath of walk(dirHandle, '')) {
        if (!extensions || extensions.some((ext) => relPath.endsWith(ext))) out.push(relPath);
      }
      return out.sort();
    },
    async read(root, relPath) {
      const rootHandle = await resolveRoot(root, { create: true });
      const fileHandle = await resolveFile(rootHandle, relPath);
      return (await fileHandle.getFile()).text();
    },
    async readBinary(root, relPath) {
      const rootHandle = await resolveRoot(root, { create: true });
      const fileHandle = await resolveFile(rootHandle, relPath);
      return new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());
    },
    async mtime(root, relPath) {
      const rootHandle = await resolveRoot(root, { create: true });
      const fileHandle = await resolveFile(rootHandle, relPath);
      return new Date((await fileHandle.getFile()).lastModified);
    },
    async size(root, relPath) {
      const rootHandle = await resolveRoot(root, { create: true });
      const fileHandle = await resolveFile(rootHandle, relPath);
      return (await fileHandle.getFile()).size;
    },
    async write(root, relPath, text) {
      const rootHandle = await resolveRoot(root, { create: true });
      const fileHandle = await resolveFile(rootHandle, relPath, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(text);
      await writable.close();
    },
    async writeBinary(root, relPath, bytes) {
      const rootHandle = await resolveRoot(root, { create: true });
      const fileHandle = await resolveFile(rootHandle, relPath, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
    },
    async remove(root, relPath) {
      const rootHandle = await resolveRoot(root, { create: true });
      const segments = relPath.split('/').filter(Boolean);
      const name = segments.pop();
      const dir = await resolveDir(rootHandle, segments.join('/'));
      await dir.removeEntry(name, { recursive: true });
    },
    async watch(root, callback, options = {}) {
      const rootHandle = await resolveRoot(root, { create: true });
      if (typeof FileSystemObserver !== 'undefined') {
        const observer = new FileSystemObserver((records) => {
          for (const record of records) {
            callback({
              type: mapObserverType(record.type),
              path: (record.relativePathComponents ?? []).join('/'),
            });
          }
        });
        await observer.observe(rootHandle, { recursive: true });
        return { close: () => observer.disconnect() };
      }
      return watchByPolling(provider, root, callback, options);
    },
  };
  return provider;
}

function mapObserverType(type) {
  switch (type) {
    case 'appeared':
      return 'create';
    case 'disappeared':
      return 'delete';
    case 'modified':
      return 'modify';
    case 'moved':
      return 'rename';
    default:
      return 'unknown';
  }
}

/** Polling fallback for watch(): no FileSystemObserver, or any other
 * provider that only exposes list/mtime. Exported so its diffing logic is
 * unit-testable in Node against a fake provider, without a real browser. */
export async function watchByPolling(provider, root, callback, options = {}) {
  const intervalMs = options.pollMs ?? 1000;
  const extensions = 'extensions' in options ? options.extensions : ['.mdy'];

  const snapshot = async () => {
    const next = new Map();
    for (const path of await provider.list(root, '.', { extensions })) {
      next.set(path, (await provider.mtime(root, path)).getTime());
    }
    return next;
  };

  let seen = await snapshot();
  let stopped = false;
  let timer;

  const tick = async () => {
    if (stopped) return;
    try {
      const next = await snapshot();
      for (const [path, time] of next) {
        if (!seen.has(path)) callback({ type: 'create', path });
        else if (seen.get(path) !== time) callback({ type: 'modify', path });
      }
      for (const path of seen.keys()) {
        if (!next.has(path)) callback({ type: 'delete', path });
      }
      seen = next;
    } catch {
      // transient read error mid-poll — try again next tick
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);

  return { close: () => { stopped = true; clearTimeout(timer); } };
}
