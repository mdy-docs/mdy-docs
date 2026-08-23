/**
 * Light or dark, and remembering which.
 *
 * The colours are the stylesheet's business: it writes every token as
 * `light-dark(…)` and lets `color-scheme` pick a side. So all this has to do
 * is say which side, by putting `data-theme` on the html element — and when
 * nobody has said, leave the attribute off and let the system answer.
 */

// Also read by the small script in `index.html`, which applies the choice
// before the first paint so the page does not start in the wrong theme.
const key = 'mdy:theme'

/**
 * Wire up the button that flips the page over.
 *
 * @param {HTMLElement} button
 * @param {Storage} storage
 *   Where the choice is kept, handed in the way `draftKey` takes it.
 */
export function setupTheme(button, storage) {
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const stored = read(storage)

  if (stored) document.documentElement.dataset.theme = stored

  describe()

  // Only reaches the label: with no choice stored the stylesheet has already
  // followed the system across on its own.
  dark.addEventListener('change', describe)

  button.addEventListener('click', () => {
    const next = other()

    document.documentElement.dataset.theme = next

    try {
      storage.setItem(key, next)
    } catch {
      // A browser that refuses to store it still gets to switch.
    }

    describe()
  })

  /** The theme in force, chosen or inherited from the system. */
  function current() {
    return document.documentElement.dataset.theme || (dark.matches ? 'dark' : 'light')
  }

  /** The one the button leads to. */
  function other() {
    return current() === 'dark' ? 'light' : 'dark'
  }

  // The button carries an icon and no words, so the words go here. Both are
  // set: the title for a pointer, the label for everything else.
  function describe() {
    const text = 'Switch to the ' + other() + ' theme'

    button.setAttribute('aria-label', text)
    button.title = text
  }
}

/**
 * @param {Storage} storage
 * @returns {string | undefined}
 */
function read(storage) {
  try {
    const value = storage.getItem(key)

    return value === 'light' || value === 'dark' ? value : undefined
  } catch {
    return undefined
  }
}
