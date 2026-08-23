import {describe, expect, test} from 'vitest'
import {draftKey, fingerprint} from '../src/draft.js'

/** The parts of the Storage API `draftKey` uses. */
function storage(entries = {}) {
  const map = new Map(Object.entries(entries))

  return {
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index],
    removeItem: (name) => map.delete(name),
    has: (name) => map.has(name),
    names: () => [...map.keys()]
  }
}

describe('fingerprint', () => {
  test('is stable for the same string', () => {
    expect(fingerprint('= MDY')).toBe(fingerprint('= MDY'))
  })

  test('changes when the string does', () => {
    expect(fingerprint('= MDY')).not.toBe(fingerprint('= MDY\n\n<nav id=toc'))
  })

  test('survives an empty string', () => {
    expect(typeof fingerprint('')).toBe('string')
  })
})

describe('draftKey', () => {
  test('names the key after the sample', () => {
    const store = storage()

    expect(draftKey(store, 'a')).toBe('mdy:playground:' + fingerprint('a'))
  })

  test('keeps a draft of the sample it is given', () => {
    const sample = '= MDY'
    const key = 'mdy:playground:' + fingerprint(sample)
    const store = storage({[key]: 'my edits'})

    expect(draftKey(store, sample)).toBe(key)
    expect(store.has(key)).toBe(true)
  })

  test('clears a draft of a sample that has changed', () => {
    const store = storage({
      ['mdy:playground:' + fingerprint('old sample')]: 'stale edits'
    })

    const key = draftKey(store, 'new sample')

    expect(store.has(key)).toBe(false)
    expect(store.names()).toEqual([])
  })

  test('clears the key used before drafts were versioned', () => {
    const store = storage({'mdy:playground': 'very stale'})

    draftKey(store, 'sample')

    expect(store.has('mdy:playground')).toBe(false)
  })

  test('leaves keys belonging to anything else alone', () => {
    const store = storage({'other:thing': 'keep me', 'mdy:playground': 'go'})

    draftKey(store, 'sample')

    expect(store.names()).toEqual(['other:thing'])
  })

  test('clears every stale draft, not just the first', () => {
    const store = storage({
      ['mdy:playground:' + fingerprint('one')]: 'a',
      ['mdy:playground:' + fingerprint('two')]: 'b',
      ['mdy:playground:' + fingerprint('three')]: 'c'
    })

    draftKey(store, 'four')

    expect(store.names()).toEqual([])
  })
})
