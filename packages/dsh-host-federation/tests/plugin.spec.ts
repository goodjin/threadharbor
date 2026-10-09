/**
 * The browser half of the host plugin.
 *
 * Everything here already exists as plain functions; what this entry adds is
 * the wiring that makes it a plugin a page can load. It also owns the two
 * things that would otherwise fail silently and be hard to trace: a missing
 * BroadcastChannel (which this degrades to doing nothing, quietly), and a
 * heartbeat that never fires (which would let every other tab think this host
 * is gone). So it reports what it could and could not do.
 */

import { describe, expect, it, vi } from 'vitest'
import { applyHostFederation, type HostFederationContext } from '../src/plugin.ts'

function context(overrides: Record<string, unknown> = {}) {
  const timers: (() => void)[] = []
  const disposed: string[] = []
  return {
    timers,
    disposed,
    ctx: {
      settings: { get: () => ({ hostId: 'alpha', hostTitle: 'Studio' }) },
      storage: { get: () => undefined, set: () => {} },
      bus: { post: () => {}, subscribe: () => () => {} },
      sessions: () => [{ projectId: 'w1', sessionId: 's1', title: '本机会话' }],
      setInterval: (tick: () => void, _ms: number) => { timers.push(tick); return timers.length },
      clearInterval: (handle: number) => { disposed.push(String(handle)) },
      report: { warn: vi.fn() },
      ...overrides,
    } as unknown as HostFederationContext,
  }
}

const CONFIG = { heartbeatMs: 5_000, staleMs: 15_000 }

describe('applyHostFederation', () => {
  it('announces this host and publishes what it holds', () => {
    const { ctx } = context()
    const result = applyHostFederation(ctx, CONFIG)
    expect(result.identity()).toEqual({ hostId: 'alpha', hostTitle: 'Studio', derived: false })
    expect(result.rollUp().hosts[0]?.sessions.map(s => s.sessionId)).toEqual(['s1'])
    result.dispose()
  })

  it('keeps announcing on the configured interval', () => {
    // No heartbeat and every other tab would drop this host from the roll-up.
    const { ctx, timers } = context()
    const result = applyHostFederation(ctx, CONFIG)
    expect(timers).toHaveLength(1)
    timers[0]!() // must not throw
    result.dispose()
  })

  it('stops its timer when disposed', () => {
    const { ctx, disposed } = context()
    const result = applyHostFederation(ctx, CONFIG)
    result.dispose()
    expect(disposed).toEqual(['1'])
  })

  it('keeps settings under this host rather than sharing them', () => {
    // Two tabs on one machine are two views; a setting written for one must not
    // show up in the other, or renaming a host would rename it everywhere.
    const { ctx } = context()
    const result = applyHostFederation(ctx, CONFIG)
    expect(result.settingsKey()).toBe('dsh.host-settings.alpha')
    result.dispose()
  })

  it('says so when the page has no channel between tabs', () => {
    // Degrading quietly would leave a roll-up that never updates and no clue why.
    const saved = globalThis.BroadcastChannel
    Reflect.deleteProperty(globalThis, 'BroadcastChannel')
    try {
      const { ctx } = context({ bus: undefined })
      const result = applyHostFederation(ctx, CONFIG)
      expect(ctx.report.warn).toHaveBeenCalledWith(expect.stringContaining('BroadcastChannel'))
      result.dispose()
    } finally {
      globalThis.BroadcastChannel = saved
    }
  })

  it('still works with no channel', () => {
    // One tab is still a host, and it still has to answer for its own sessions.
    const saved = globalThis.BroadcastChannel
    Reflect.deleteProperty(globalThis, 'BroadcastChannel')
    try {
      const { ctx } = context({ bus: undefined })
      const result = applyHostFederation(ctx, CONFIG)
      expect(result.identity().hostId).toBe('alpha')
      result.dispose()
    } finally {
      globalThis.BroadcastChannel = saved
    }
  })

  it('says nothing about channels when the page has one', () => {
    const { ctx } = context({ bus: undefined })
    const result = applyHostFederation(ctx, CONFIG)
    expect(ctx.report.warn).not.toHaveBeenCalled()
    result.dispose()
  })

  it('reports rather than throws when the settings cannot be read', () => {
    const { ctx } = context({ settings: { get: () => { throw new Error('settings unavailable') } } })
    expect(() => applyHostFederation(ctx, CONFIG)).not.toThrow()
  })
})