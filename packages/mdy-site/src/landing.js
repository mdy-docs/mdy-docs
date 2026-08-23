/**
 * The landing page.
 *
 * Static HTML, unlike its sibling: nothing here is live, so the only work is
 * the theme toggle and painting the samples. Both come from the same modules
 * the editor uses, so a sample on this page and the same text typed into the
 * tour are coloured by one implementation rather than two.
 */

import './style.css'
import {embed, highlightMdy} from './syntax.js'
import {setupTheme} from './theme.js'

setupTheme(document.querySelector('#theme'), localStorage)

// `textContent` rather than `innerHTML`: the source is written into the page
// with `<` and `&` escaped, and the painter wants the characters an author
// typed.
for (const sample of document.querySelectorAll('.sample')) {
  const source = sample.textContent.replace(/\s+$/, '')
  const language = sample.dataset.lang

  sample.innerHTML = language
    ? embed(source, language)
    : highlightMdy(source)
}
