import {common, createLowlight} from 'lowlight'

/** @type {ReturnType<createLowlight> | undefined} */
let shared

/**
 * Resolve the `highlight` option.
 *
 * `true` (the default) uses [`lowlight`][lowlight] with its common set of 37
 * languages, built once and reused. Anything with `registered` and `highlight`
 * on it is used as given, which is how to swap in a smaller set — or a larger
 * one:
 *
 * ```js
 * import {all, createLowlight} from 'lowlight'
 *
 * mdy({highlight: createLowlight(all)})
 * ```
 *
 * [lowlight]: https://github.com/wooorm/lowlight
 *
 * @param {boolean | {registered: (name: string) => boolean, highlight: Function} | undefined} highlight
 * @returns {{registered: (name: string) => boolean, highlight: Function} | undefined}
 */
export function normalizeHighlight(highlight) {
  if (highlight === false) return
  if (highlight === undefined || highlight === true) {
    return (shared ??= createLowlight(common))
  }

  return highlight
}

/**
 * Colour a block of code, or leave it as the text it is.
 *
 * A language nothing knows is not an error: the class still says what it was
 * meant to be, and the code still reads.
 *
 * @param {string} value
 * @param {string} language
 * @param {ReturnType<normalizeHighlight>} highlighter
 * @returns {{children: Array<import('hast').ElementContent>, highlighted: boolean}}
 */
export function highlightCode(value, language, highlighter) {
  if (!highlighter || !language || !highlighter.registered(language)) {
    return {children: [{type: 'text', value}], highlighted: false}
  }

  try {
    return {children: highlighter.highlight(language, value).children, highlighted: true}
  } catch {
    return {children: [{type: 'text', value}], highlighted: false}
  }
}
