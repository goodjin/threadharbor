import { describe, expect, it } from 'vitest'
import { COMPOSER_DRAFTS_KEY, readComposerDrafts, withComposerDraft, writeComposerDrafts } from '../src/client/composer-drafts.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    dump: () => Object.fromEntries(map),
  }
}

describe('composer drafts', () => {
  it('keeps one draft per session so switching sessions does not carry text along', () => {
    let drafts = withComposerDraft({}, 'a', '给 A 的话')
    drafts = withComposerDraft(drafts, 'b', '给 B 的话')
    expect(drafts['a']).toBe('给 A 的话')
    expect(drafts['b']).toBe('给 B 的话')
    // Sending clears only that session's draft.
    drafts = withComposerDraft(drafts, 'a', '')
    expect(drafts).toEqual({ b: '给 B 的话' })
  })

  it('round-trips through storage and ignores garbage', () => {
    const store = memoryStorage()
    writeComposerDrafts({ a: 'x', b: 'y' }, store)
    expect(readComposerDrafts(store)).toEqual({ a: 'x', b: 'y' })
    expect(readComposerDrafts(memoryStorage({ [COMPOSER_DRAFTS_KEY]: 'not json' }))).toEqual({})
    expect(readComposerDrafts(memoryStorage({ [COMPOSER_DRAFTS_KEY]: '{"a":"","b":3,"c":"ok"}' }))).toEqual({ c: 'ok' })
    expect(readComposerDrafts(undefined)).toEqual({})
  })

  it('caps the number of remembered sessions, dropping the oldest', () => {
    let drafts = {}
    for (let index = 0; index < 55; index += 1) drafts = withComposerDraft(drafts, `s${index}`, `t${index}`)
    const keys = Object.keys(drafts)
    expect(keys).toHaveLength(50)
    expect(keys[0]).toBe('s5')
    expect(keys.at(-1)).toBe('s54')
  })
})
