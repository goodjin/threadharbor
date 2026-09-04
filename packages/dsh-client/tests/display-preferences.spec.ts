import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DISPLAY_PREFERENCES,
  MAX_AUTO_HIDE_AFTER_DAYS,
  MAX_SESSIONS_PER_PROJECT_LIMIT,
  applyLimitToSessions,
  archiveCutoff,
  readDisplayPreferences,
  subscribeDisplayPreferences,
  writeDisplayPreferences,
} from '../src/client/display-preferences.ts'

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

describe('display preferences persistence', () => {
  it('returns defaults when nothing has been stored', () => {
    expect(readDisplayPreferences()).toEqual(DEFAULT_DISPLAY_PREFERENCES)
  })

  it('round-trips a written value', () => {
    writeDisplayPreferences({ sessionsPerProjectLimit: 12, autoHideSessionsAfterDays: 7 })
    expect(readDisplayPreferences()).toEqual({ sessionsPerProjectLimit: 12, autoHideSessionsAfterDays: 7 })
  })

  it('returns defaults when the stored JSON is corrupted', () => {
    window.localStorage.setItem('dsh.remote-agent.display-preferences', '{not json')
    expect(readDisplayPreferences()).toEqual(DEFAULT_DISPLAY_PREFERENCES)
  })

  it('returns defaults when the stored value is not an object', () => {
    window.localStorage.setItem('dsh.remote-agent.display-preferences', JSON.stringify([1, 2, 3]))
    expect(readDisplayPreferences()).toEqual(DEFAULT_DISPLAY_PREFERENCES)
  })

  it('falls back per-field when individual fields are missing or invalid', () => {
    window.localStorage.setItem('dsh.remote-agent.display-preferences', JSON.stringify({ sessionsPerProjectLimit: 'no' }))
    expect(readDisplayPreferences()).toEqual(DEFAULT_DISPLAY_PREFERENCES)
  })

  it('clamps the limit into [1, MAX_SESSIONS_PER_PROJECT_LIMIT]', () => {
    window.localStorage.setItem(
      'dsh.remote-agent.display-preferences',
      JSON.stringify({ sessionsPerProjectLimit: -3, autoHideSessionsAfterDays: 999 }),
    )
    const prefs = readDisplayPreferences()
    expect(prefs.sessionsPerProjectLimit).toBe(DEFAULT_DISPLAY_PREFERENCES.sessionsPerProjectLimit)
    expect(prefs.autoHideSessionsAfterDays).toBe(MAX_AUTO_HIDE_AFTER_DAYS)
  })

  it('treats fractional numbers as floor-rounded integers', () => {
    writeDisplayPreferences({ sessionsPerProjectLimit: 12.9, autoHideSessionsAfterDays: 5.4 })
    expect(readDisplayPreferences()).toEqual({ sessionsPerProjectLimit: 12, autoHideSessionsAfterDays: 5 })
  })

  it('honors the auto-hide cap at 0 (turn the feature off)', () => {
    writeDisplayPreferences({ sessionsPerProjectLimit: 4, autoHideSessionsAfterDays: 0 })
    expect(readDisplayPreferences().autoHideSessionsAfterDays).toBe(0)
  })
})

describe('display preferences subscription', () => {
  it('fires listeners on write but never on read', () => {
    const listener = vi.fn()
    subscribeDisplayPreferences(listener)
    readDisplayPreferences()
    expect(listener).not.toHaveBeenCalled()
    writeDisplayPreferences({ sessionsPerProjectLimit: 4, autoHideSessionsAfterDays: 14 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops firing after the unsubscribe handle is invoked', () => {
    const listener = vi.fn()
    const off = subscribeDisplayPreferences(listener)
    off()
    writeDisplayPreferences({ sessionsPerProjectLimit: 4, autoHideSessionsAfterDays: 14 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('isolates listener exceptions so a faulty subscriber cannot break the loop', () => {
    const faulty = vi.fn(() => { throw new Error('boom') })
    const healthy = vi.fn()
    subscribeDisplayPreferences(faulty)
    subscribeDisplayPreferences(healthy)
    writeDisplayPreferences({ sessionsPerProjectLimit: 4, autoHideSessionsAfterDays: 14 })
    expect(healthy).toHaveBeenCalledTimes(1)
  })
})

describe('applyLimitToSessions', () => {
  type Row = { readonly sessionId: string; readonly parentSessionId?: string }
  const make = (id: string, parent?: string): Row => ({ sessionId: id, parentSessionId: parent })

  it('returns everything unchanged when the cap is disabled', () => {
    const rows = [make('a'), make('b'), make('c')]
    expect(applyLimitToSessions(rows, 0, false)).toEqual({ visible: rows, overflow: 0, showToggle: false })
  })

  it('does not show a toggle when the row count fits inside the cap', () => {
    const rows = [make('a'), make('b')]
    expect(applyLimitToSessions(rows, 8, false)).toEqual({ visible: rows, overflow: 0, showToggle: false })
  })

  it('keeps children of the visible roots after the cap and folds children of overflowed roots too', () => {
    const rows = [
      make('a'),
      make('a-1', 'a'),
      make('b'),
      make('b-1', 'b'),
      make('c'),
      make('c-1', 'c'),
    ]
    const result = applyLimitToSessions(rows, 2, false)
    // Cap = 2 → render roots 'a' and 'b'; 'b-1' is a child of 'b', so it
    // stays visible. 'c' and its child 'c-1' are folded behind the toggle.
    expect(result.visible.map(item => item.sessionId)).toEqual(['a', 'a-1', 'b', 'b-1'])
    expect(result.overflow).toBe(1)
    expect(result.showToggle).toBe(true)
  })

  it('shows everything when expanded is true even past the cap', () => {
    const rows = [make('a'), make('b'), make('c'), make('d'), make('e')]
    const result = applyLimitToSessions(rows, 2, true)
    expect(result.visible.map(item => item.sessionId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(result.overflow).toBe(0)
    expect(result.showToggle).toBe(false)
  })

  it('returns an empty result when there are no sessions', () => {
    expect(applyLimitToSessions([], 8, false)).toEqual({ visible: [], overflow: 0, showToggle: false })
  })

  it('only counts root sessions toward the overflow tally', () => {
    const rows = [
      make('a'),
      make('a-1', 'a'),
      make('a-2', 'a'),
      make('b'),
      make('b-1', 'b'),
    ]
    const result = applyLimitToSessions(rows, 1, false)
    // cap = 1 → render 'a' as the only visible root; 'b' overflows.
    expect(result.visible.map(item => item.sessionId)).toEqual(['a', 'a-1', 'a-2'])
    expect(result.overflow).toBe(1)
    expect(result.showToggle).toBe(true)
  })
})

describe('archiveCutoff', () => {
  const NOW = Date.UTC(2026, 8, 4, 12, 0, 0) // 2026-09-04T12:00:00Z

  it('returns null when auto-archive is disabled (0 days)', () => {
    expect(archiveCutoff(NOW, 0)).toBeNull()
  })

  it('subtracts the configured number of days from now', () => {
    const cutoff = archiveCutoff(NOW, 30)
    expect(cutoff).toBe('2026-08-05T12:00:00.000Z')
  })

  it('respects the cap at one full day', () => {
    expect(archiveCutoff(NOW, 1)).toBe('2026-09-03T12:00:00.000Z')
  })
})