import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readTranscriptScrollMemory, writeTranscriptScrollMemory } from '../src/client/transcript-scroll-memory.ts'

const STORAGE_KEY = 'dsh.remote-agent.transcript-scroll'

beforeEach(() => {
  const local = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => { local.set(key, value) },
      removeItem: (key: string) => { local.delete(key) },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('transcript scroll memory', () => {
  it('returns undefined when nothing has been persisted for the session', () => {
    expect(readTranscriptScrollMemory('session-a')).toBeUndefined()
  })

  it('round-trips a written memory entry', () => {
    writeTranscriptScrollMemory('session-a', { scrollTop: 480, followBottom: false })
    expect(readTranscriptScrollMemory('session-a')).toEqual({ scrollTop: 480, followBottom: false })
    expect(readTranscriptScrollMemory('session-b')).toBeUndefined()
  })

  it('persists multiple sessions independently in one storage record', () => {
    writeTranscriptScrollMemory('session-a', { scrollTop: 120, followBottom: true })
    writeTranscriptScrollMemory('session-b', { scrollTop: 600, followBottom: false })
    expect(readTranscriptScrollMemory('session-a')).toEqual({ scrollTop: 120, followBottom: true })
    expect(readTranscriptScrollMemory('session-b')).toEqual({ scrollTop: 600, followBottom: false })
  })

  it('clamps a negative stored scrollTop to zero when reading', () => {
    const raw = JSON.stringify({ 'session-a': { scrollTop: -42, followBottom: false } })
    window.localStorage.setItem(STORAGE_KEY, raw)
    expect(readTranscriptScrollMemory('session-a')).toEqual({ scrollTop: 0, followBottom: false })
  })

  it('returns undefined when the persisted entry is missing required fields', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'session-a': { scrollTop: 100 } }))
    expect(readTranscriptScrollMemory('session-a')).toBeUndefined()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'session-a': { scrollTop: 'oops', followBottom: false } }))
    expect(readTranscriptScrollMemory('session-a')).toBeUndefined()
  })

  it('returns undefined when the storage record is corrupted', () => {
    window.localStorage.setItem(STORAGE_KEY, 'not-json')
    expect(readTranscriptScrollMemory('session-a')).toBeUndefined()
  })

  it('overwrites a corrupted storage record instead of throwing', () => {
    window.localStorage.setItem(STORAGE_KEY, 'not-json')
    expect(() => writeTranscriptScrollMemory('session-a', { scrollTop: 50, followBottom: true })).not.toThrow()
    expect(readTranscriptScrollMemory('session-a')).toEqual({ scrollTop: 50, followBottom: true })
  })
})