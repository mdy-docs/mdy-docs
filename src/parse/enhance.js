/**
 * Browser side of editable tasks.
 *
 * The forms work on their own: a click submits, the page reloads, the box has
 * moved. This takes that over and does it without the reload, and — because
 * anything over a network can fail — says how it went.
 *
 * Nothing here is needed for the feature to work, which is the point of it
 * being a separate module.
 *
 * @module
 */

const formClass = 'task-list-item-form'
const glyphs = {x: '☑', ' ': '☐'}

/**
 * @typedef Detail
 * @property {HTMLFormElement} form
 *   The form that was sent.
 * @property {number} line
 *   Line of the item in the source, counting from one.
 * @property {number} column
 *   Column of the character between the brackets, counting from one.
 * @property {string} was
 *   What that character is now.
 * @property {string} next
 *   What it should become.
 * @property {string} action
 *   Where the form posts.
 * @property {string} method
 *   How it posts.
 *
 * @typedef Result
 * @property {Detail} detail
 *   What was asked for.
 * @property {boolean} ok
 *   Whether it worked.
 * @property {Error} [error]
 *   Why it did not.
 *
 * @typedef Options
 * @property {(detail: Detail) => Promise<unknown>} [submit]
 *   Sends the change. Anything it throws is a failure, as is returning `false`.
 *   Defaults to posting the form's own fields to its own action.
 * @property {(result: Result) => void} [onResult]
 *   Called after every attempt, successful or not.
 * @property {{pending?: string, ok?: string, error?: string}} [messages]
 *   What the status region says.
 */

const defaultMessages = {
  pending: 'Saving…',
  ok: 'Saved',
  error: 'Could not save'
}

/**
 * Take over the task forms under `root`.
 *
 * @param {ParentNode & EventTarget} root
 * @param {Options} [options]
 * @returns {() => void}
 *   Undoes it.
 */
export function enhanceTasks(root, options = {}) {
  const submit = options.submit ?? post
  const messages = {...defaultMessages, ...options.messages}

  root.addEventListener('submit', onSubmit)
  // A real checkbox cannot send a form on its own, so this is what wires one
  // up for pages that asked for `control: 'checkbox'`.
  root.addEventListener('change', onChange)

  return () => {
    root.removeEventListener('submit', onSubmit)
    root.removeEventListener('change', onChange)
  }

  /** @param {Event} event */
  function onChange(event) {
    const control = /** @type {HTMLInputElement} */ (event.target)

    if (control?.type !== 'checkbox' || control.name !== 'next') return

    const form = control.form

    if (form?.classList.contains(formClass)) form.requestSubmit()
  }

  /** @param {SubmitEvent} event */
  async function onSubmit(event) {
    const form = /** @type {HTMLFormElement} */ (event.target)

    if (!form?.classList?.contains(formClass)) return

    event.preventDefault()

    // A second click while the first is still in the air would race it.
    if (form.dataset.state === 'pending') return

    const detail = read(form, event.submitter)

    state(form, 'pending', messages.pending)

    /** @type {Result} */
    let result

    try {
      if ((await submit(detail)) === false) {
        throw new Error(messages.error)
      }

      apply(form, detail)
      state(form, 'ok', messages.ok)
      result = {detail, ok: true}
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))

      state(form, 'error', failure.message || messages.error)
      result = {detail, ok: false, error: failure}
    }

    options.onResult?.(result)
    form.dispatchEvent(
      new CustomEvent('mdy:task', {detail: result, bubbles: true})
    )
  }
}

/**
 * What the form is asking for.
 *
 * @param {HTMLFormElement} form
 * @param {HTMLElement | null} [submitter]
 * @returns {Detail}
 */
function read(form, submitter) {
  const control = form.querySelector('[name="next"]')
  const checkbox =
    control instanceof HTMLInputElement && control.type === 'checkbox'

  return {
    form,
    line: Number(form.elements.namedItem('line')?.value),
    column: Number(form.elements.namedItem('column')?.value),
    was: String(form.elements.namedItem('was')?.value ?? ''),
    // A button says what to write; a checkbox says it by being ticked or not.
    next: checkbox
      ? control.checked
        ? 'x'
        : ' '
      : String(submitter?.value ?? control?.value ?? 'x'),
    action: form.getAttribute('action') || location.href,
    method: (form.getAttribute('method') || 'post').toUpperCase()
  }
}

/**
 * Post the form the way the browser would have.
 *
 * @param {Detail} detail
 * @returns {Promise<Response>}
 */
async function post(detail) {
  const body = new FormData(detail.form)

  body.set('next', detail.next)

  const response = await fetch(detail.action, {method: detail.method, body})

  if (!response.ok) {
    throw new Error(response.status + ' ' + response.statusText)
  }

  return response
}

/**
 * Move the box to where it now is, so the page agrees with the file.
 *
 * @param {HTMLFormElement} form
 * @param {Detail} detail
 * @returns {undefined}
 */
function apply(form, detail) {
  const was = form.elements.namedItem('was')
  const control = form.querySelector('[name="next"]')

  if (was) was.value = detail.next

  if (control instanceof HTMLInputElement) {
    control.checked = detail.next === 'x'
    return
  }

  if (!control) return

  // The button carries the opposite of the state it shows: what a click does.
  control.value = detail.next === 'x' ? ' ' : 'x'
  control.setAttribute('aria-checked', String(detail.next === 'x'))

  const glyph = control.querySelector('span')

  if (glyph) glyph.textContent = glyphs[detail.next] ?? glyphs[' ']
}

/**
 * Say how it is going, in the markup and out loud.
 *
 * @param {HTMLFormElement} form
 * @param {string} value
 * @param {string} message
 * @returns {undefined}
 */
function state(form, value, message) {
  form.dataset.state = value
  form.setAttribute('aria-busy', String(value === 'pending'))

  let status = form.querySelector('.task-list-item-status')

  if (!status) {
    status = form.ownerDocument.createElement('span')
    status.className = 'task-list-item-status'
    // Polite, so a screen reader finishes what it was saying first.
    status.setAttribute('role', 'status')
    form.append(status)
  }

  status.textContent = message
}
