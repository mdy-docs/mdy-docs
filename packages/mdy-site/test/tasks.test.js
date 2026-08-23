// @vitest-environment happy-dom
import {beforeEach, describe, expect, test, vi} from 'vitest'
import {enhanceTasks} from 'mdy-docs/tasks'
import {mdyToHtml} from 'mdy-docs/parse'

/**
 * Render a document into the page, the way a browser would meet it.
 *
 * @param {string} source
 * @param {object} [options]
 */
function render(source, options = {tasks: true}) {
  document.body.innerHTML = '<div id="root">' + mdyToHtml(source, options) + '</div>'

  return document.querySelector('#root')
}

/** @param {Element} root */
function toggle(root) {
  return root.querySelector('[name="next"]')
}

/** @param {Element} root */
function status(root) {
  return root.querySelector('.task-list-item-status')?.textContent
}

/** Wait for the handler's promise chain to settle. */
function settled() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('enhanceTasks', () => {
  test('sends what the form was carrying', async () => {
    const root = render('- [ ] feed the cat')
    const submit = vi.fn(async () => true)

    enhanceTasks(root, {submit})
    toggle(root).click()
    await settled()

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toMatchObject({
      line: 1,
      column: 4,
      was: ' ',
      next: 'x',
      method: 'POST'
    })
  })

  test('does not let the browser submit it', async () => {
    const root = render('- [ ] a')
    let defaultPrevented = false

    enhanceTasks(root, {submit: async () => true})
    // Registered second, so it runs after the handler has had its say.
    root.addEventListener('submit', (event) => {
      defaultPrevented = event.defaultPrevented
    })
    toggle(root).click()
    await settled()

    expect(defaultPrevented).toBe(true)
  })

  test('moves the box once the change has landed', async () => {
    const root = render('- [ ] a')

    enhanceTasks(root, {submit: async () => true})

    expect(toggle(root).getAttribute('aria-checked')).toBe('false')

    toggle(root).click()
    await settled()

    expect(toggle(root).getAttribute('aria-checked')).toBe('true')
    expect(toggle(root).value).toBe(' ')
    expect(toggle(root).querySelector('span').textContent).toBe('☑')
    expect(root.querySelector('[name="was"]').value).toBe('x')
  })

  test('leaves the box alone when it fails', async () => {
    const root = render('- [ ] a')

    enhanceTasks(root, {
      submit: async () => {
        throw new Error('server said no')
      }
    })
    toggle(root).click()
    await settled()

    expect(toggle(root).getAttribute('aria-checked')).toBe('false')
    expect(toggle(root).value).toBe('x')
  })

  test('reports success', async () => {
    const root = render('- [ ] a')
    const onResult = vi.fn()

    enhanceTasks(root, {submit: async () => true, onResult})
    toggle(root).click()
    await settled()

    expect(onResult.mock.calls[0][0].ok).toBe(true)
    expect(status(root)).toBe('Saved')
    expect(root.querySelector('form').dataset.state).toBe('ok')
  })

  test('reports failure, with the reason', async () => {
    const root = render('- [ ] a')
    const onResult = vi.fn()

    enhanceTasks(root, {
      submit: async () => {
        throw new Error('server said no')
      },
      onResult
    })
    toggle(root).click()
    await settled()

    const result = onResult.mock.calls[0][0]

    expect(result.ok).toBe(false)
    expect(result.error.message).toBe('server said no')
    expect(status(root)).toBe('server said no')
    expect(root.querySelector('form').dataset.state).toBe('error')
  })

  test('treats a returned false as a refusal', async () => {
    const root = render('- [ ] a')
    const onResult = vi.fn()

    enhanceTasks(root, {submit: async () => false, onResult})
    toggle(root).click()
    await settled()

    expect(onResult.mock.calls[0][0].ok).toBe(false)
  })

  test('says it is working while it works', async () => {
    const root = render('- [ ] a')
    let release

    enhanceTasks(root, {
      submit: () => new Promise((resolve) => (release = resolve))
    })
    toggle(root).click()
    await settled()

    expect(root.querySelector('form').dataset.state).toBe('pending')
    expect(root.querySelector('form').getAttribute('aria-busy')).toBe('true')
    expect(status(root)).toBe('Saving…')

    release(true)
    await settled()

    expect(root.querySelector('form').getAttribute('aria-busy')).toBe('false')
  })

  test('ignores a second click while the first is in the air', async () => {
    const root = render('- [ ] a')
    const submit = vi.fn(() => new Promise(() => {}))

    enhanceTasks(root, {submit})
    toggle(root).click()
    await settled()
    toggle(root).click()
    await settled()

    expect(submit).toHaveBeenCalledTimes(1)
  })

  test('announces politely', async () => {
    const root = render('- [ ] a')

    enhanceTasks(root, {submit: async () => true})
    toggle(root).click()
    await settled()

    expect(
      root.querySelector('.task-list-item-status').getAttribute('role')
    ).toBe('status')
  })

  test('fires an event anything can listen for', async () => {
    const root = render('- [ ] a')
    const seen = []

    root.addEventListener('mdy:task', (event) => seen.push(event.detail))
    enhanceTasks(root, {submit: async () => true})
    toggle(root).click()
    await settled()

    expect(seen).toHaveLength(1)
    expect(seen[0].ok).toBe(true)
    expect(seen[0].detail.line).toBe(1)
  })

  test('takes the messages it says', async () => {
    const root = render('- [ ] a')

    enhanceTasks(root, {
      submit: async () => true,
      messages: {ok: 'Written'}
    })
    toggle(root).click()
    await settled()

    expect(status(root)).toBe('Written')
  })

  test('posts to the form action by default', async () => {
    const root = render('- [ ] a', {tasks: {action: '/toggle'}})
    const fetched = []

    globalThis.fetch = vi.fn(async (url, init) => {
      fetched.push({url, next: init.body.get('next')})
      return {ok: true, status: 200, statusText: 'OK'}
    })

    enhanceTasks(root)
    toggle(root).click()
    await settled()

    expect(fetched).toEqual([{url: '/toggle', next: 'x'}])
  })

  test('a failing response is a failure', async () => {
    const root = render('- [ ] a', {tasks: {action: '/toggle'}})
    const onResult = vi.fn()

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Server Error'
    }))

    enhanceTasks(root, {onResult})
    toggle(root).click()
    await settled()

    expect(onResult.mock.calls[0][0].ok).toBe(false)
    expect(status(root)).toBe('500 Server Error')
  })

  test('submits a real checkbox when it changes', async () => {
    const root = render('- [ ] a', {tasks: {control: 'checkbox'}})
    const submit = vi.fn(async () => true)

    enhanceTasks(root, {submit})

    const box = toggle(root)

    box.checked = true
    box.dispatchEvent(new Event('change', {bubbles: true}))
    await settled()

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0].next).toBe('x')
  })

  test('stops when told to', async () => {
    const root = render('- [ ] a')
    const submit = vi.fn(async () => true)
    const stop = enhanceTasks(root, {submit})

    stop()
    toggle(root).click()
    await settled()

    expect(submit).not.toHaveBeenCalled()
  })

  test('leaves other forms alone', async () => {
    const root = render('- [ ] a')
    const submit = vi.fn(async () => true)

    root.insertAdjacentHTML('beforeend', '<form id="other"></form>')
    enhanceTasks(root, {submit})
    root.querySelector('#other').dispatchEvent(
      new Event('submit', {bubbles: true, cancelable: true})
    )
    await settled()

    expect(submit).not.toHaveBeenCalled()
  })
})
