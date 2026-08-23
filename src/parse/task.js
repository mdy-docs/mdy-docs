/**
 * @typedef Settings
 * @property {'button' | 'checkbox'} control
 *   What the box is. `button` is a submit button wearing a checkbox's clothes,
 *   which is the only way a single click can send a form with no script behind
 *   it. `checkbox` is a real `<input type="checkbox">`, which cannot submit by
 *   itself — for pages that will wire it up.
 * @property {string} method
 *   How the form submits.
 * @property {string | undefined} action
 *   Where it submits. Left off by default, which in HTML means the page's own
 *   URL — the document that holds the task is the thing that can edit it.
 */

const glyphs = {on: '☑', off: '☐'}

/**
 * Resolve the `tasks` option.
 *
 * Off by default. A form is a promise that something is listening, and a
 * markup processor is in no position to make it.
 *
 * @param {boolean | Partial<Settings> | undefined} tasks
 * @returns {Settings | undefined}
 */
export function normalizeTasks(tasks) {
  if (!tasks) return
  if (tasks === true) {
    return {control: 'button', method: 'post', action: undefined}
  }

  return {
    control: tasks.control === 'checkbox' ? 'checkbox' : 'button',
    method: tasks.method ?? 'post',
    action: tasks.action
  }
}

/**
 * Build the form that toggles one task.
 *
 * It carries where to write and what to write there: the line the item is on,
 * the column of the character between its brackets, what that character is
 * now, and what it should become.
 *
 *     - [ ] feed the cat
 *       ^   line 1, column 4, was " ", next "x"
 *
 * `was` is what the page was showing. A handler that checks it will notice a
 * form sent from a copy of the file that has since moved on, rather than
 * writing over whatever happened in between.
 *
 * @param {Settings} settings
 * @param {{checked: boolean, line: number, column: number, label: string}} task
 * @returns {import('hast').Element}
 */
export function taskForm(settings, task) {
  const next = task.checked ? ' ' : 'x'
  /** @type {Array<import('hast').ElementContent>} */
  const children = [
    hidden('line', String(task.line)),
    hidden('column', String(task.column)),
    hidden('was', task.checked ? 'x' : ' '),
    settings.control === 'checkbox' ? checkbox(task) : button(task, next)
  ]

  /** @type {import('hast').Properties} */
  const properties = {method: settings.method}

  if (settings.action !== undefined) properties.action = settings.action

  properties.className = ['task-list-item-form']

  return {type: 'element', tagName: 'form', properties, children}
}

/**
 * A submit button that reads and behaves as a checkbox.
 *
 * The glyph inside means the control still looks like what it is with no
 * stylesheet at all; a stylesheet is free to replace it. It is hidden from
 * assistive technology, which has the role, the state and the label instead.
 *
 * @param {{checked: boolean, label: string}} task
 * @param {string} next
 * @returns {import('hast').Element}
 */
function button(task, next) {
  return {
    type: 'element',
    tagName: 'button',
    properties: {
      type: 'submit',
      name: 'next',
      value: next,
      role: 'checkbox',
      ariaChecked: task.checked ? 'true' : 'false',
      ariaLabel: task.label || undefined,
      className: ['task-list-item-toggle']
    },
    children: [
      {
        type: 'element',
        tagName: 'span',
        properties: {ariaHidden: 'true'},
        children: [{type: 'text', value: task.checked ? glyphs.on : glyphs.off}]
      }
    ]
  }
}

/**
 * @param {{checked: boolean, label: string}} task
 * @returns {import('hast').Element}
 */
function checkbox(task) {
  return {
    type: 'element',
    tagName: 'input',
    properties: {
      type: 'checkbox',
      name: 'next',
      value: 'x',
      checked: task.checked,
      ariaLabel: task.label || undefined
    },
    children: []
  }
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {import('hast').Element}
 */
function hidden(name, value) {
  return {
    type: 'element',
    tagName: 'input',
    properties: {type: 'hidden', name, value},
    children: []
  }
}
