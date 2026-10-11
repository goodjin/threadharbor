/**
 * Seeing several hosts from one page.
 *
 * The shape decided for phase 4: one browser tab per host, and a page that
 * sums them up. A tab has no way to know another tab closed cleanly, so presence
 * is heartbeat-based rather than goodbye-based — a tab that vanishes mid-write
 * would otherwise keep its row online forever.
 *
 * The broadcast channel is a port, so all of this runs without a browser.
 */

import { describe, expect, it } from 'vitest'
import { HostFederation } from '../src/federation.ts'
import type { FederationBus } from '../src/federation.ts'
import type { HostIdentity } from '../src/identity.ts'

const ME: HostIdentity = { hostId: 'alpha', hostTitle: 'Alpha box', derived: false }
const THEM: HostIdentity = { hostId: 'beta', hostTitle: 'Beta box', derived: false }

/** A bus with a manual clock, standing in for a same-origin channel. */
function fakeBus() {
  const listeners = new Set<(message: unknown) => void>()
  let tick = 0
  const bus: FederationBus & { deliver(message: unknown): void; tick(): number } = {
    post: message => { for (const listener of listeners) listener(message) },
    subscribe: listener => { listeners.add(listener) },
    deliver: message => { for (const listener of listeners) listener(message) },
    tick: () => ++tick,
  }
  return bus
}

function setup(options: { staleMs?: number } = {}) {
  const bus = fakeBus()
  const fed = new HostFederation(ME, bus, { staleMs: options.staleMs ?? 1_000 })
  return { bus, fed }
}

describe('HostFederation presence', () => {
  it('counts itself as present', () => {
    const { fed } = setup()
    fed.start()
    expect(fed.hosts().map(h => h.hostId)).toEqual(['alpha'])
  })

  it('does not treat itself as someone else', () => {
    const { fed } = setup()
    fed.start()
    expect(fed.foreignHosts().map(h => h.hostId)).toEqual([])
  })

  it('picks up another host when it announces itself', () => {
    const { fed } = setup()
    fed.start()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    expect(fed.hosts().map(h => h.hostId).sort()).toEqual(['alpha', 'beta'])
  })

  it('shows the other host’s title, not just its id', () => {
    const { fed } = setup()
    fed.start()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    expect(fed.foreignHosts()[0]!.hostTitle).toBe('Beta box')
  })

  it('keeps a host that keeps announcing itself', () => {
    const { fed } = setup()
    fed.start()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    fed.receive({ kind: 'heartbeat', ...THEM, at: 500 })
    fed.receive({ kind: 'heartbeat', ...THEM, at: 900 })
    expect(fed.foreignHosts().map(h => h.hostId)).toEqual(['beta'])
  })

  it('drops a host that stops announcing itself', () => {
    // The load-bearing case: a tab that crashes or is closed never says
    // goodbye, and its row must not linger online forever.
    const { fed } = setup()
    fed.start()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    fed.expire(1_001)
    expect(fed.hosts().map(h => h.hostId)).toEqual(['alpha'])
  })

  it('keeps a host that is still announcing itself at the edge of the window', () => {
    const { fed } = setup({ staleMs: 1_000 })
    fed.start()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    fed.receive({ kind: 'heartbeat', ...THEM, at: 1_000 })
    fed.expire(2_000)
    expect(fed.foreignHosts().map(h => h.hostId)).toEqual(['beta'])
  })

  it('removes a host immediately when it says goodbye', () => {
    const { fed } = setup()
    fed.start()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    fed.receive({ kind: 'bye', ...THEM, at: 10 })
    expect(fed.hosts().map(h => h.hostId)).toEqual(['alpha'])
  })

  it('counts one entry when two tabs carry the same host id', () => {
    // Reloading a tab briefly runs two with one identity; listing the host
    // twice would double every session under it in the roll-up.
    const { fed } = setup()
    fed.start()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    fed.receive({ kind: 'hello', ...THEM, at: 1 })
    expect(fed.hosts().map(h => h.hostId).sort()).toEqual(['alpha', 'beta'])
  })

  it('ignores its own announcements arriving back from the channel', () => {
    const { fed } = setup()
    fed.start()
    fed.receive({ kind: 'hello', ...ME, at: 0 })
    expect(fed.hosts()).toHaveLength(1)
  })

  it('ignores a malformed announcement rather than dropping out', () => {
    const { fed } = setup()
    fed.start()
    fed.receive({ kind: 'hello', hostId: 42, at: 0 })
    expect(fed.hosts().map(h => h.hostId)).toEqual(['alpha'])
  })

  it('stops announcing after it stops', () => {
    const { fed, bus } = setup()
    fed.start()
    fed.dispose()
    fed.emitHeartbeat()
    // Nothing of ours should be left on the channel for others to see.
    expect(fed.hosts().map(h => h.hostId)).toEqual(['alpha'])
  })

  it('drops a legacy session announcement instead of listing from it', () => {
    // 2026-10-11 面板改为主机列表后，'sessions' 报文不再有读者，协议里已撤掉；
    // 收到这类报文（理论上只剩旧构建的标签页）必须当作坏报文丢弃，而不是据此
    // 把一台主机加进列表。
    const { fed } = setup()
    fed.start()
    fed.receive({ kind: 'sessions', ...THEM, at: 0, sessions: [{ projectId: 'p1', sessionId: 's1', title: 'x' }] })
    expect(fed.hosts().map(h => h.hostId)).toEqual(['alpha'])
  })
})
