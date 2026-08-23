/*
 * The handful of `expect(...)` matchers the parser's own tests are written
 * with, over `node:assert`.
 *
 * The parser arrived here with ~460 tests written for vitest. Rewriting every
 * assertion into `assert.equal(actual, expected)` would have touched all of
 * them to say the same thing, and a mechanical edit that large is exactly
 * where a real assertion quietly turns into a passing one. This maps the
 * matchers instead, so the tests read as they were written and the repo keeps
 * one test runner.
 *
 * Only what is used, deliberately: an unknown matcher should be a missing
 * method rather than something that silently passes.
 */

import assert from 'node:assert/strict'

/**
 * Whether `haystack` holds `needle`, for a string or anything iterable.
 *
 * @param {string | Iterable<unknown>} haystack
 * @param {unknown} needle
 * @returns {boolean}
 */
function holds(haystack, needle) {
  if (typeof haystack === 'string') return haystack.includes(String(needle))

  return [...haystack].includes(needle)
}

/**
 * Whether every key of `expected` is present and deeply equal in `actual`.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 * @returns {boolean}
 */
function covers(actual, expected) {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(actual, expected)
  }

  if (actual === null || typeof actual !== 'object') return false

  for (const [key, value] of Object.entries(expected)) {
    if (!covers(actual[key], value)) return false
  }

  return true
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function show(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/**
 * @param {unknown} actual
 * @returns {Record<string, Function> & {not: Record<string, Function>}}
 */
export function expect(actual) {
  const api = build(false)

  api.not = build(true)

  return api

  /**
   * @param {boolean} negated
   */
  function build(negated) {
    /**
     * @param {boolean} ok
     * @param {string} what
     */
    const check = (ok, what) => {
      assert.ok(
        negated ? !ok : ok,
        'expected ' + show(actual) + (negated ? ' not ' : ' ') + what
      )
    }

    return {
      /** @param {unknown} expected */
      toBe(expected) {
        if (negated) return check(Object.is(actual, expected), 'to be ' + show(expected))

        assert.strictEqual(actual, expected)
      },
      /** @param {unknown} expected */
      toEqual(expected) {
        if (negated) {
          return assert.notDeepStrictEqual(actual, expected)
        }

        assert.deepStrictEqual(actual, expected)
      },
      /** @param {unknown} needle */
      toContain(needle) {
        check(holds(actual, needle), 'to contain ' + show(needle))
      },
      /** @param {RegExp | string} pattern */
      toMatch(pattern) {
        const ok =
          typeof pattern === 'string'
            ? String(actual).includes(pattern)
            : pattern.test(String(actual))

        check(ok, 'to match ' + pattern)
      },
      /** @param {object} expected */
      toMatchObject(expected) {
        check(covers(actual, expected), 'to cover ' + JSON.stringify(expected))
      },
      /** @param {number} length */
      toHaveLength(length) {
        check(
          actual !== null && actual !== undefined && actual.length === length,
          'to have length ' + length
        )
      },
      toBeUndefined() {
        check(actual === undefined, 'to be undefined')
      },
      /** @param {number} value */
      toBeGreaterThan(value) {
        check(Number(actual) > value, 'to be greater than ' + value)
      },
      /** @param {number} value */
      toBeLessThan(value) {
        check(Number(actual) < value, 'to be less than ' + value)
      },
      /** @param {RegExp | string} [pattern] */
      toThrow(pattern) {
        let thrown

        try {
          /** @type {Function} */ (actual)()
        } catch (error) {
          thrown = error
        }

        if (!thrown) return check(false, 'to throw')

        if (pattern === undefined) return check(true, 'to throw')

        const message = thrown instanceof Error ? thrown.message : String(thrown)
        const ok =
          typeof pattern === 'string'
            ? message.includes(pattern)
            : pattern.test(message)

        assert.ok(
          negated ? !ok : ok,
          'expected the thrown ' + show(message) + ' to match ' + pattern
        )
      }
    }
  }
}
