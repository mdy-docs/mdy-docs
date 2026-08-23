// @vitest-environment happy-dom
import {beforeEach, describe, expect, test} from 'vitest'
import {setupTheme} from '../src/theme.js'

const key = 'mdy:theme'

/** The parts of the Storage API `setupTheme` uses. */
function storage(entries = {}) {
  const map = new Map(Object.entries(entries))

  return {
    getItem: (name) => map.get(name) ?? null,
    setItem: (name, value) => map.set(name, value),
    read: (name) => map.get(name)
  }
}

/**
 * Say what the system asks for, which is what the page follows until the
 * reader says otherwise.
 *
 * @param {boolean} dark
 */
function system(dark) {
  window.matchMedia = (query) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener() {},
    removeEventListener() {}
  })
}

function button() {
  const element = document.createElement('button')

  document.body.append(element)

  return element
}

beforeEach(() => {
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
  system(true)
})

describe('with nothing stored', () => {
  test('leaves the attribute off, so the system decides', () => {
    setupTheme(button(), storage())

    expect(document.documentElement.dataset.theme).toBe(undefined)
  })

  test('the label offers the other one', () => {
    const dark = button()

    setupTheme(dark, storage())
    expect(dark.getAttribute('aria-label')).toBe('Switch to the light theme')

    system(false)

    const light = button()

    setupTheme(light, storage())
    expect(light.getAttribute('aria-label')).toBe('Switch to the dark theme')
  })
})

describe('with a choice stored', () => {
  test('applies it, against the system', () => {
    setupTheme(button(), storage({[key]: 'light'}))

    expect(document.documentElement.dataset.theme).toBe('light')
  })

  test('ignores anything that is not a theme', () => {
    setupTheme(button(), storage({[key]: 'mauve'}))

    expect(document.documentElement.dataset.theme).toBe(undefined)
  })
})

describe('the button', () => {
  test('flips the page and remembers', () => {
    const element = button()
    const store = storage()

    setupTheme(element, store)
    element.click()

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(store.read(key)).toBe('light')
    expect(element.getAttribute('aria-label')).toBe('Switch to the dark theme')

    element.click()

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(store.read(key)).toBe('dark')
  })

  test('still switches when the store will not have it', () => {
    const element = button()
    const refusing = {
      getItem: () => null,
      setItem() {
        throw new Error('nope')
      }
    }

    setupTheme(element, refusing)
    element.click()

    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
