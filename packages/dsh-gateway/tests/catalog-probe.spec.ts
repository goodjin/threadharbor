import { describe, expect, it } from 'vitest'
import { CATALOG_PROBE_IDLE_MS, probeIsExpired } from '../src/catalog-probe.ts'

describe('catalog probe expiry', () => {
  const now = Date.parse('2026-03-01T12:00:00.000Z')
  const ago = (ms: number): string => new Date(now - ms).toISOString()

  it('keeps a probe the user is still reading', () => {
    expect(probeIsExpired(ago(0), now)).toBe(false)
    expect(probeIsExpired(ago(CATALOG_PROBE_IDLE_MS - 1), now)).toBe(false)
  })

  it('closes one that has been unread for the whole window', () => {
    // Exactly at the boundary counts as expired: the window is a promise about
    // how long a probe may sit, and sitting for all of it is sitting too long.
    expect(probeIsExpired(ago(CATALOG_PROBE_IDLE_MS), now)).toBe(true)
    expect(probeIsExpired(ago(CATALOG_PROBE_IDLE_MS + 1), now)).toBe(true)
  })

  it('reclaims a probe it cannot date rather than holding it forever', () => {
    // An unreadable timestamp is not evidence anyone still wants it. Keeping it
    // would hold a remote Agent process indefinitely on a guess.
    expect(probeIsExpired('not-a-date', now)).toBe(true)
  })

  it('uses the window the cost discussion settled on', () => {
    expect(CATALOG_PROBE_IDLE_MS).toBe(30 * 60 * 1000)
  })
})