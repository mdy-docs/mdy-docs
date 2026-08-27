import {describe, expect, test} from 'vitest'

import {CONSTRUCTS, unhighlighted} from '../../../test/fixtures/constructs.js'
import {highlightMdy} from '../src/syntax.js'

/*
 * Every construct the language has, painted by this highlighter.
 *
 * The same list the vscode-mdy grammar asserts against
 * (test/fixtures/constructs.js). There is more than one MDY grammar in this
 * repo and they had drifted in opposite directions — that one had no
 * typography, this one knew only the fenced spelling of front matter and not
 * the split-on-first-`+++` one every example in the repo uses.
 *
 * The point of sharing the list is not that the two agree on token names.
 * It is that a construct the language has cannot be invisible in either,
 * and that adding one to src/parse/ fails here until it is painted.
 */

/** Where this highlighter painted something, as offsets into `source`. */
function paintedSpans(html) {
  const spans = []
  let offset = 0
  let depth = 0
  let index = 0

  const decode = (text) =>
    text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')

  while (index < html.length) {
    if (html[index] === '<') {
      const close = html.indexOf('>', index)
      const tag = html.slice(index, close + 1)
      if (tag.startsWith('</')) depth -= 1
      else if (!tag.endsWith('/>')) depth += 1
      index = close + 1
      continue
    }

    const next = html.indexOf('<', index)
    const text = decode(html.slice(index, next === -1 ? html.length : next))
    if (depth > 0 && text.length > 0) {
      spans.push({start: offset, end: offset + text.length})
    }
    offset += text.length
    index = next === -1 ? html.length : next
  }

  return spans
}

describe('every construct is painted', () => {
  for (const construct of CONSTRUCTS) {
    test(construct.name, () => {
      const missing = unhighlighted(construct, paintedSpans(highlightMdy(construct.source)))
      expect(missing, `unpainted in ${JSON.stringify(construct.source)}`).toEqual([])
    })
  }
})
