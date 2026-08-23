/**
 * @typedef Marker
 *   An inline toggle marker.
 * @property {string} sequence
 *   Literal characters that toggle the span (matched verbatim, longest first).
 * @property {string} tagName
 *   hast element produced while the marker is open.
 * @property {boolean} [raw=false]
 *   When true, nothing inside the span is markup: every other sequence is
 *   literal text until this marker's own closing sequence.
 * @property {string} [label]
 *   Human readable name, used by the demo site's cheat sheet.
 */

/**
 * Default inline markers.
 *
 * MDY inline formatting is *toggling*, not nesting: the first occurrence of a
 * sequence opens the span, the next occurrence of the same sequence closes it.
 * Change this table (or pass `markers` to the parser) to reshape the language.
 *
 * @type {ReadonlyArray<Marker>}
 */
export const defaultMarkers = Object.freeze([
  { sequence: '!!', tagName: 'strong', label: 'strong' },
  { sequence: '**', tagName: 'strong', label: 'strong' },
  { sequence: '//', tagName: 'em', label: 'emphasis' },
  { sequence: '__', tagName: 'u', label: 'underline' },
  { sequence: '~~', tagName: 'del', label: 'strikethrough' },
  { sequence: '??', tagName: 'mark', label: 'highlight' },
  { sequence: '^^', tagName: 'sup', label: 'superscript' },
  { sequence: ',,', tagName: 'sub', label: 'subscript' },
  { sequence: '``', tagName: 'code', label: 'code', raw: true }
])

/**
 * Normalise a marker table: validate, default, and sort so that longer
 * sequences win over shorter ones that prefix them.
 *
 * @param {ReadonlyArray<Marker>} [markers]
 * @returns {Array<Marker>}
 */
export function normalizeMarkers(markers) {
  const list = (markers ?? defaultMarkers).map((marker) => {
    if (!marker || typeof marker.sequence !== 'string' || !marker.sequence) {
      throw new TypeError('Expected every marker to have a non-empty `sequence`')
    }

    if (typeof marker.tagName !== 'string' || !marker.tagName) {
      throw new TypeError(
        'Expected marker `' + marker.sequence + '` to have a `tagName`'
      )
    }

    return {
      sequence: marker.sequence,
      tagName: marker.tagName,
      raw: marker.raw === true,
      label: marker.label ?? marker.tagName
    }
  })

  const seen = new Set()

  for (const marker of list) {
    if (seen.has(marker.sequence)) {
      throw new TypeError('Duplicate marker sequence `' + marker.sequence + '`')
    }

    seen.add(marker.sequence)
  }

  return list.sort((a, b) => b.sequence.length - a.sequence.length)
}
