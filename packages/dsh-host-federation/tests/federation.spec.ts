/**
 * Seeing several hosts from one page.
 *
 * The shape decided for phase 4: one browser tab per host, and a page that
 * sums them up. A tab has no way to know another tab closed cleanly, so presence
 * is heartbeat-based rather than goodbye-based — a tab that vanishes mid-write
 * would otherwise keep contributing its sessions forever.
 *
 * The broadcast channel is a port, so all of this runs without a browser.
 */

import { describe, expect, it } from 'vitest'
import { HostFederation } from '../src/federation.ts'
import type { FederationBus, HostIdentity } from '../src/federation.ts'

const ME: HostIdentity = { hostId: 'alpha', hostTitle: 'Alpha box' }
const THEM: HostIdentity = { hostId: 'beta', hostTitle: 'Beta box' }

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
    // goodbye, and its sessions must not linger in the roll-up forever.
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
})

describe('HostFederation roll-up', () => {
  const sessionsOf = (hostId: string) => hostId === 'beta'
    ? [{ projectId: 'p1', sessionId: 's2', title: 'From beta' }]
    : [{ projectId: 'p1', sessionId: 's1', title: 'From alpha' }]

  function withSessions() {
    const bus = fakeBus()
    const fed = new HostFederation(ME, bus, {
      staleMs: 1_000,
      listSessions: hostId => sessionsOf(hostId),
    })
    fed.start()
    return { bus, fed }
  }

  it('groups sessions under the host they came from', () => {
    const { fed } = withSessions()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    const roll = fed.rollUp()
    expect(roll.hosts.map(h => ({ hostId: h.hostId, sessions: h.sessions.map(s => s.sessionId) })))
      .toEqual([
        { hostId: 'alpha', sessions: ['s1'] },
        { hostId: 'beta', sessions: ['s2'] },
      ])
  })

  it('groups projects under the host, then sessions under the project', () => {
    const { fed } = withSessions()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    const beta = fed.rollUp().hosts.find(h => h.hostId === 'beta')!
    expect(beta.projects.map(p => p.projectId)).toEqual(['p1'])
    expect(beta.projects[0]!.sessions.map(s => s.sessionId)).toEqual(['s2'])
  })

  it('drops a host’s sessions when it stops announcing', () => {
    // Otherwise the roll-up keeps advertising sessions that no longer exist.
    const { fed } = withSessions()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    fed.expire(1_001)
    expect(fed.rollUp().hosts.map(h => h.hostId)).toEqual(['alpha'])
  })

  it('does not list a host twice when two tabs share its id', () => {
    const { fed } = withSessions()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    fed.receive({ kind: 'hello', ...THEM, at: 1 })
    expect(fed.rollUp().hosts.map(h => h.hostId)).toEqual(['alpha', 'beta'])
  })
})