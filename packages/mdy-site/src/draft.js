const prefix = 'mdy:playground:'
const legacy = 'mdy:playground'

/**
 * A short, stable stand-in for a string's contents (FNV-1a).
 *
 * @param {string} value
 * @returns {string}
 */
export function fingerprint(value) {
  let hash = 2166136261

  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(36)
}

/**
 * Where this sample's draft is kept, clearing out drafts of samples that no
 * longer exist.
 *
 * Keying by content is what stops a saved draft outliving the document it was
 * a draft of: change the sample and the editor shows the new one, rather than a
 * copy of a version nobody can see any more. A draft of *this* sample still
 * survives a reload, which is the point of saving one at all.
 *
 * @param {Storage} storage
 * @param {string} sample
 * @returns {string}
 */
export function draftKey(storage, sample) {
  const key = prefix + fingerprint(sample)
  /** @type {Array<string>} */
  const stale = []

  // Collect first: removing while walking the store moves the ground underneath
  // the index.
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index)

    if (name === legacy || (name.startsWith(prefix) && name !== key)) {
      stale.push(name)
    }
  }

  for (const name of stale) storage.removeItem(name)

  return key
}
