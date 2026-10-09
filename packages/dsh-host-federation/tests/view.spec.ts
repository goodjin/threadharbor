/**
 * Tying host identity to the roll-up.
 *
 * The page gets its host identity from the host's settings form, and that value
 * can change while the page is open — an operator edits the title, or fixes an
 * id that was wrong. The roll-up then has to re-announce under the new identity;
 * simply swapping the label would leave the old entry present and add a second
 * one for the same machine.
 */

import { describe, expect, it } from 'vitest'
import { startHostView } from '../src/view.ts'
import type { IdentityForm, SettingsSource } from '../src/view.ts'

/** A settings form standing in for the host's. */
function form(initial: { hostId?: string; hostTitle?: string } = {}): IdentityForm & { set(next: Record<string, unknown>): void } {
  let value: Record<string, unknown> = { ...initial }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ base: value, user: undefined, revision: 0, writable: true, mode: 'host' as const }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: next => { value = { ...value, ...next }; for (const listener of listeners) listener() },
  }
}

/** A channel that records what was posted, so announcements can be inspected. */
function recordingChannel() {
  const posted: { kind: string; hostId: string }[] = []
  const listeners = new Set<(message: unknown) => void>()
  return {
    posted,
    bus: {
      post: (message: unknown) => {
        const record = message as { kind: string; hostId: string }
        posted.push({ kind: record.kind, hostId: record.hostId })
      },
      subscribe: (listener: (message: unknown) => void) => { listeners.add(listener) },
    },
    deliver: (message: unknown) => { for (const listener of listeners) listener(message) },
  }
}

function sources(origin = 'http://alpha.example:8080'): SettingsSource {
  return {
    origin,
    pathname: '/',
    userAgent: 'test',
    listSessions: () => [],
    heartbeatMs: 50,
    staleMs: 1_000,
    now: () => 0,
  }
}

describe('startHostView', () => {
  it('uses the identity the host configured', () => {
    const { bus } = recordingChannel()
    const view = startHostView(form({ hostId: 'alpha', hostTitle: 'Alpha box' }), bus, sources())
    expect(view.identity().hostId).toBe('alpha')
    expect(view.identity().hostTitle).toBe('Alpha box')
    view.dispose()
  })

  it('derives an identity when the host configured none', () => {
    const { bus } = recordingChannel()
    const view = startHostView(form(), bus, sources())
    expect(view.identity().derived).toBe(true)
    view.dispose()
  })

  it('announces itself when it starts', () => {
    const { bus, posted } = recordingChannel()
    const view = startHostView(form({ hostId: 'alpha' }), bus, sources())
    // The start announces presence and then what it hosts; a tab that only said
    // hello would leave its row empty everywhere else.
    expect(posted).toEqual([{ kind: 'hello', hostId: 'alpha' }, { kind: 'sessions', hostId: 'alpha' }])
    view.dispose()
  })

  it('announces under the new identity when the host’s own identity changes', () => {
    // Otherwise the old entry stays in every other tab's roll-up and a second
    // one appears for the same machine.
    const settings = form({ hostId: 'alpha', hostTitle: 'Old name' })
    const { bus, posted } = recordingChannel()
    const view = startHostView(settings, bus, sources())

    settings.set({ hostId: 'renamed' })

    expect(posted.map(p => `${p.kind}:${p.hostId}`))
      .toEqual(['hello:alpha', 'sessions:alpha', 'bye:alpha', 'hello:renamed', 'sessions:renamed'])
    expect(view.identity().hostId).toBe('renamed')
    view.dispose()
  })

  it('does not re-announce when only the title changes', () => {
    // Same machine, same id: re-announcing would churn every other tab.
    const settings = form({ hostId: 'alpha', hostTitle: 'Old name' })
    const { bus, posted } = recordingChannel()
    const view = startHostView(settings, bus, sources())

    settings.set({ hostTitle: 'New name' })

    // Same machine, same id: only the title moved, so nothing is re-announced.
    expect(posted.map(p => p.kind)).toEqual(['hello', 'sessions'])
    expect(view.identity().hostTitle).toBe('New name')
    view.dispose()
  })

  it('says goodbye when disposed', () => {
    const { bus, posted } = recordingChannel()
    const view = startHostView(form({ hostId: 'alpha' }), bus, sources())
    view.dispose()
    expect(posted.map(p => p.kind)).toEqual(['hello', 'sessions', 'bye'])
  })

  it('stops heartbeating after disposal', () => {
    const { bus, posted } = recordingChannel()
    const view = startHostView(form({ hostId: 'alpha' }), bus, sources())
    view.dispose()
    const after = posted.length
    view.tick()
    expect(posted).toHaveLength(after)
  })

  it('picks up another host that announces itself', () => {
    const { bus, deliver } = recordingChannel()
    const view = startHostView(form({ hostId: 'alpha' }), bus, sources())

    deliver({ kind: 'hello', hostId: 'beta', hostTitle: 'Beta box', at: 0 })
    expect(view.foreignHosts().map(h => h.hostId)).toEqual(['beta'])
    view.dispose()
  })

  it('drops a host that stops announcing itself', () => {
    const { bus, deliver } = recordingChannel()
    const view = startHostView(form({ hostId: 'alpha' }), bus, sources())
    deliver({ kind: 'hello', hostId: 'beta', hostTitle: 'Beta box', at: 0 })

    view.expire(1_001)
    expect(view.foreignHosts()).toEqual([])
    view.dispose()
  })

  it('publishes what it hosts when it starts', () => {
    // A tab that only said hello would leave its row empty until something else
    // asked, and nothing is going to ask.
    const { bus, posted } = recordingChannel()
    const source = { ...sources(), listSessions: () => [{ projectId: 'w1', sessionId: 's1', title: '本机的会话' }] }
    const view = startHostView(form({ hostId: 'alpha' }), bus, source)
    const published = posted.filter(p => p.kind === 'sessions')
    expect(published).toHaveLength(1)
    view.dispose()
  })

  it('republishes when the host says its sessions changed', () => {
    const { bus, posted } = recordingChannel()
    const view = startHostView(form({ hostId: 'alpha' }), bus, sources())
    const before = posted.filter(p => p.kind === 'sessions').length

    view.publishSessions([{ projectId: 'w1', sessionId: 's1', title: '新会话' }])
    expect(posted.filter(p => p.kind === 'sessions')).toHaveLength(before + 1)
    view.dispose()
  })

  it('does not publish after disposal', () => {
    const { bus, posted } = recordingChannel()
    const view = startHostView(form({ hostId: 'alpha' }), bus, sources())
    view.dispose()
    const after = posted.length

    view.publishSessions([{ projectId: 'w1', sessionId: 's1', title: 'x' }])
    expect(posted).toHaveLength(after)
  })

  it('survives a settings form that reports a snapshot it cannot read', () => {
    // A malformed host document must not take the page's host view down.
    const broken = {
      getSnapshot: () => ({ base: 'not an object', user: undefined, revision: 0, writable: true, mode: 'host' as const }),
      subscribe: () => () => {},
    }
    const { bus } = recordingChannel()
    const view = startHostView(broken as never, bus, sources())
    expect(view.identity().derived).toBe(true)
    view.dispose()
  })
})