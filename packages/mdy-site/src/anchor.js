/**
 * Headings you can point someone at.
 *
 * The parser gives every heading an `id` (rule 1); these two make them worth
 * having on a page whose content is rendered into a pane rather than being the
 * document itself. One turns each heading into a link to itself, the other
 * makes such a link scroll the pane and leave a shareable URL behind.
 */

import {h} from 'hastscript'
import {visit} from 'unist-util-visit'

/**
 * Make every heading a link to itself.
 *
 * The whole heading is the target rather than a marker beside it, so the way to
 * a link worth sharing is to click the words already in front of you. A `§`
 * turns up alongside on hover to say the heading is clickable at all, and the
 * stylesheet is what makes the anchor fill the row.
 *
 * @returns {(tree: import('hast').Root) => void}
 */
export function headingAnchors() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (!/^h[1-6]$/.test(node.tagName)) return

      const id = node.properties?.id

      // The footnotes heading names its section rather than marking a place
      // anyone would link to, and it is only there for screen readers.
      if (!id || id === 'footnote-label') return

      node.children = [
        h('a', {href: '#' + id, class: 'heading-anchor'}, [
          ...node.children,
          h('span', {class: 'heading-sign', ariaHidden: 'true'}, '§')
        ])
      ]
    })
  }
}

/**
 * Make fragment links work inside `root`, and say so in the address bar.
 *
 * `root` scrolls on its own, so the browser's jump would move the wrong thing —
 * and on the way in there was nothing to jump to yet, the content not having
 * been rendered. Both are handled here.
 *
 * @param {HTMLElement} root
 * @param {{history?: History, location?: Location}} [where]
 *   The two globals it writes to and reads from, so a test can hand it others.
 * @returns {void}
 */
export function followFragments(root, where = {}) {
  const past = where.history ?? globalThis.history
  const here = where.location ?? globalThis.location

  root.addEventListener('click', (event) => {
    const anchor = event.target.closest?.('a[href^="#"]')

    if (!anchor) return

    const id = decodeURIComponent(anchor.getAttribute('href').slice(1))

    if (!reveal(root, id, 'smooth')) return

    event.preventDefault()

    // The address bar is what makes a link shareable, and the jump was ours
    // rather than the browser's, so the URL has to be told. `replaceState`
    // rather than `pushState`: the point is a link to copy, not a trail to walk
    // back along.
    past.replaceState(undefined, '', '#' + encodeURIComponent(id))
  })

  // A link someone shared names a heading that did not exist when the browser
  // did its own jump. So it is done again, now that it can be.
  if (here.hash) reveal(root, decodeURIComponent(here.hash.slice(1)), 'auto')
}

/**
 * Scroll `root` to whatever carries `id`.
 *
 * @param {HTMLElement} root
 * @param {string} id
 * @param {ScrollBehavior} behavior
 * @returns {boolean}
 *   Whether anything was there to scroll to.
 */
export function reveal(root, id, behavior) {
  // Attribute selector, not `#id`: slugs may start with a digit or hold a dot.
  const target = id && root.querySelector('[id="' + CSS.escape(id) + '"]')

  if (!target) return false

  target.scrollIntoView?.({behavior, block: 'start'})

  return true
}
