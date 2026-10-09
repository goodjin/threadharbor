/**
 * Tabs publishing what they host.
 *
 * Presence alone only says which machines are open. A roll-up that stops there
 * is a list of hosts and nothing to click, so each tab also publishes the
 * sessions it holds — and republishes when those change, because a conversation
 * started in one tab has to show up in the others without a reload.
 */

import { describe, expect, it } from 'vitest'
import { HostFederation } from '../src/federation.ts'
import type { FederationBus, HostSession } from '../src/federation.ts'
import type { HostIdentity } from '../src/identity.ts'

const ME: HostIdentity = { hostId: 'alpha', hostTitle: 'Alpha box', derived: false }
const THEM: HostIdentity = { hostId: 'beta', hostTitle: 'Beta box', derived: false }

function bus() {
  const posted: unknown[] = []
  const listeners = new Set<(message: unknown) => void>()
  const port: FederationBus = {
    post: message => { posted.push(message) },
    subscribe: listener => { listeners.add(listener) },
  }
  return {
    posted,
    port,
    deliver: (message: unknown) => { for (const listener of listeners) listener(message) },
  }
}

const session = (sessionId: string, projectId = 'w1'): HostSession => ({
  projectId, sessionId, title: `会话 ${sessionId}`,
})

describe('publishing sessions', () => {
  it('publishes its sessions so another tab can list them', () => {
    const channel = bus()
    const fed = new HostFederation(ME, channel.port, {
      staleMs: 1_000,
      listSessions: () => [session('s1'), session('s2')],
    })
    fed.start()

    channel.deliver({ kind: 'hello', hostId: 'gamma', hostTitle: 'G', at: 0 })
    // The observer sees what this tab holds, not the local list — the local
    // `listSessions` belongs to *this* host's own roll-up row.
    expect(sessionOf(fed, 'alpha').map(s => s.sessionId)).toEqual(['s1', 's2'])
  })

  it('carries a published session list to another tab', () => {
    const channel = bus()
    const fed = new HostFederation(ME, channel.port, { staleMs: 1_000 })
    fed.start()

    fed.publishSessions([session('s1'), session('s2')])

    const published = channel.posted.find(m => (m as { kind: string }).kind === 'sessions') as
      { kind: string; hostId: string; sessions: HostSession[] } | undefined
    expect(published?.sessions.map(s => s.sessionId)).toEqual(['s1', 's2'])
  })

  it('shows another host’s sessions once it has published them', () => {
    const channel = bus()
    const fed = new HostFederation(ME, channel.port, { staleMs: 1_000 })
    fed.start()
    channel.deliver({ kind: 'hello', hostId: 'beta', hostTitle: 'Beta', at: 0 })

    expect(sessionOf(fed, 'beta')).toEqual([])
    channel.deliver({ kind: 'sessions', hostId: 'beta', hostTitle: 'Beta', at: 0, sessions: [session('b1')] })
    expect(sessionOf(fed, 'beta').map(s => s.sessionId)).toEqual(['b1'])
  })

  it('replaces a host’s list when it publishes again', () => {
    const channel = bus()
    const fed = new HostFederation(ME, channel.port, { staleMs: 1_000 })
    fed.start()
    channel.deliver({ kind: 'sessions', hostId: 'beta', hostTitle: 'Beta', at: 0, sessions: [session('b1')] })

    channel.deliver({ kind: 'sessions', hostId: 'beta', hostTitle: 'Beta', at: 1, sessions: [session('b2')] })
    // Replacing, not accumulating: a session that was closed must disappear.
    expect(sessionOf(fed, 'beta').map(s => s.sessionId)).toEqual(['b2'])
  })

  it('keeps its own published list separate from the one it receives', () => {
    const channel = bus()
    const fed = new HostFederation(ME, channel.port, {
      staleMs: 1_000,
      listSessions: () => [session('mine')],
    })
    fed.start()
    fed.publishSessions([session('mine')])
    // Its own publication comes back on the channel and must not be treated as
    // a foreign host's report.
    expect(fed.foreignHosts().map(h => h.hostId)).toEqual([])
  })

  it('drops the sessions of a host that goes quiet', () => {
    const channel = bus()
    const fed = new HostFederation(ME, channel.port, { staleMs: 1_000 })
    fed.start()
    channel.deliver({ kind: 'sessions', hostId: 'beta', hostTitle: 'Beta', at: 0, sessions: [session('b1')] })

    fed.expire(1_001)
    expect(fed.rollUp().hosts.some(h => h.hostId === 'beta')).toBe(false)
  })

  it('ignores a session list it cannot read', () => {
    // A malformed publication must not take the roll-up down for every tab.
    const channel = bus()
    const fed = new HostFederation(ME, channel.port, { staleMs: 1_000 })
    fed.start()
    channel.deliver({ kind: 'sessions', hostId: 'beta', hostTitle: 'Beta', at: 0, sessions: 'nope' })
    expect(sessionOf(fed, 'beta')).toEqual([])
  })

  it('drops a session entry that names no session', () => {
    const channel = bus()
    const fed = new HostFederation(ME, channel.port, { staleMs: 1_000 })
    fed.start()
    channel.deliver({
      kind: 'sessions', hostId: 'beta', hostTitle: 'Beta', at: 0,
      sessions: [{ projectId: 'w1', sessionId: '', title: 'x' }, session('b1')],
    })
    expect(sessionOf(fed, 'beta').map(s => s.sessionId)).toEqual(['b1'])
  })

  it('counts a session publication as the host being alive', () => {
    // A host that keeps publishing is alive even if its heartbeat was missed;
    // treating the publication as stale would empty a busy host's roll-up row.
    const channel = bus()
    const fed = new HostFederation(ME, channel.port, { staleMs: 1_000 })
    fed.start()
    channel.deliver({ kind: 'hello', hostId: 'beta', hostTitle: 'Beta', at: 0 })

    channel.deliver({ kind: 'sessions', hostId: 'beta', hostTitle: 'Beta', at: 900, sessions: [] })
    fed.expire(1_500)
    expect(fed.foreignHosts().map(h => h.hostId)).toEqual(['beta'])
  })
})

function sessionOf(fed: HostFederation, hostId: string): HostSession[] {
  const host = fed.rollUp().hosts.find(h => h.hostId === hostId)
  return host === undefined ? [] : [...host.sessions]
}