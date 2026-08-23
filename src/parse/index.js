import rehypeStringify from 'rehype-stringify'
import {unified} from 'unified'
import mdyParse from './plugin.js'

export {defaultMarkers, normalizeMarkers} from './markers.js'
export {defaultArrows} from './arrows.js'
export {splitDocuments} from './documents.js'
export {parseInline} from './inline.js'
export {defaultSchema, normalizeSchema} from './sanitize.js'
export {defaultResolve} from './wiki.js'
export {fromMdy} from './block.js'
export {compileScript, scriptBrackets, scriptLines, scriptOutput} from './script.js'
export {default as mdyParse} from './plugin.js'

/**
 * Create a unified processor that reads MDY and writes HTML.
 *
 * A fresh, unfrozen processor each call, so you can `.use(...)` more hast
 * plugins onto it before processing.
 *
 * @param {import('./block.js').Options & {stringify?: import('rehype-stringify').Options}} [options]
 * @returns {import('unified').Processor}
 */
export function mdy(options = {}) {
  const {stringify, ...parse} = options

  return unified().use(mdyParse, parse).use(rehypeStringify, stringify)
}

/**
 * Parse MDY into a hast tree.
 *
 * @param {string} document
 * @param {import('./block.js').Options} [options]
 * @returns {import('hast').Root}
 */
export function mdyToHast(document, options) {
  return mdy(options).parse(document)
}

/**
 * Compile MDY to an HTML string.
 *
 * @param {string} document
 * @param {import('./block.js').Options & {stringify?: import('rehype-stringify').Options}} [options]
 * @returns {string}
 */
export function mdyToHtml(document, options) {
  return String(mdy(options).processSync(document))
}
