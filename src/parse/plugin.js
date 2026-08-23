import {fromMdy} from './block.js'

/**
 * Plugin to add support for parsing MDY.
 *
 * Attaches a parser that turns an MDY document straight into hast, so the rest
 * of a unified pipeline is ordinary rehype: `.use(mdyParse).use(rehypeStringify)`,
 * with any hast transform in between.
 *
 * @this {import('unified').Processor}
 * @param {import('./block.js').Options} [options]
 * @returns {undefined}
 */
export default function mdyParse(options) {
  const self = this

  self.parser = parser

  /**
   * @param {string} document
   * @param {import('vfile').VFile} file
   * @returns {import('hast').Root}
   */
  function parser(document, file) {
    return fromMdy(document, {...options, file})
  }
}
