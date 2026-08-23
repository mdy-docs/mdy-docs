// @vitest-environment happy-dom
import {mdy} from 'mdy-docs/parse'
import {beforeEach, describe, expect, test, vi} from 'vitest'
import {followFragments, headingAnchors, reveal} from '../src/anchor.js'

/**
 * @param {string} source
 * @returns {string}
 */
function run(source) {
  return String(mdy().use(headingAnchors).processSync(source))
}

/**
 * A preview pane holding `html`, with `scrollIntoView` counted rather than
 * done: happy-dom has no layout to scroll.
 *
 * @param {string} html
 */
function pane(html) {
  const root = document.createElement('div')

  root.innerHTML = html
  document.body.append(root)

  const scrolled = []

  for (const node of root.querySelectorAll('[id]')) {
    node.scrollIntoView = vi.fn(() => scrolled.push(node.id))
  }

  return {root, scrolled}
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('a heading is a link to itself', () => {
  test('the whole heading is inside the anchor', () => {
    expect(run('== The Rules')).toBe(
      '<h2 id="the-rules"><a href="#the-rules" class="heading-anchor">' +
        'The Rules<span class="heading-sign" aria-hidden="true">§</span>' +
        '</a></h2>'
    )
  })

  test('at every level, and the id stays on the heading', () => {
    const html = run('= One\n\n=== Three')

    expect(html).toContain('<h1 id="one"><a href="#one"')
    expect(html).toContain('<h3 id="three"><a href="#three"')
  })

  test('inline markup inside the heading is kept', () => {
    expect(run('== !!Bold!! Heading')).toContain(
      '<strong>Bold</strong> Heading<span class="heading-sign"'
    )
  })

  test('the sign is hidden from a screen reader, the link is not', () => {
    const html = run('== Notes')

    expect(html).toContain('aria-hidden="true">§')
    expect(html).not.toContain('aria-hidden="true" href')
  })

  test('a heading with no id is left alone', () => {
    expect(run('== Notes', {headingId: false})).toBeTruthy()
    expect(String(mdy({headingId: false}).use(headingAnchors).processSync('== Notes')))
      .toBe('<h2>Notes</h2>')
  })

  test('the footnotes heading is not a place to link to', () => {
    const html = String(
      mdy({footnotes: true})
        .use(headingAnchors)
        .processSync('Text[[ ^1 ]]\n\n[[ ^1 ]]: note')
    )

    expect(html).toContain('<h2 class="sr-only" id="footnote-label">Footnotes</h2>')
  })
})

describe('following a fragment inside the pane', () => {
  test('scrolls to the heading and leaves a shareable URL', () => {
    const {root, scrolled} = pane(run('== The Rules'))
    const replaceState = vi.fn()

    followFragments(root, {history: {replaceState}, location: {hash: ''}})
    root.querySelector('a').dispatchEvent(new Event('click', {bubbles: true}))

    expect(scrolled).toEqual(['the-rules'])
    expect(replaceState).toHaveBeenCalledWith(undefined, '', '#the-rules')
  })

  test('a link to nothing is left to the browser', () => {
    const {root} = pane('<p><a href="#nowhere">go</a></p>')
    const replaceState = vi.fn()

    followFragments(root, {history: {replaceState}, location: {hash: ''}})
    root.querySelector('a').dispatchEvent(new Event('click', {bubbles: true}))

    expect(replaceState).not.toHaveBeenCalled()
  })

  test('a link someone shared is followed once the content is there', () => {
    const {root, scrolled} = pane(run('== The Rules'))

    followFragments(root, {
      history: {replaceState() {}},
      location: {hash: '#the-rules'}
    })

    expect(scrolled).toEqual(['the-rules'])
  })

  test('an id that is not a valid selector still resolves', () => {
    // Slugs begin with a digit and hold dots, which `#id` could not express.
    const {root, scrolled} = pane(run('== 12. Script'))

    expect(reveal(root, '12.-script', 'auto')).toBe(true)
    expect(scrolled).toEqual(['12.-script'])
  })

  test('an unknown hash on the way in does nothing', () => {
    const {root, scrolled} = pane(run('== The Rules'))

    followFragments(root, {
      history: {replaceState() {}},
      location: {hash: '#no-such-thing'}
    })

    expect(scrolled).toEqual([])
  })
})
