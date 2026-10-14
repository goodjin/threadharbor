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
import { fetchRemoteSessions } from '../src/host-remote-sessions.ts'
import type { FederationBus } from '../src/federation.ts'
import type { HostIdentity } from '../src/identity.ts'

const ME: HostIdentity = { hostId: 'alpha', hostTitle: 'Alpha box', derived: false }
const THEM: HostIdentity = { hostId: 'beta', hostTitle: 'Beta box', derived: false }

/** A bus with a manual clock, standing in for a same-origin channel. */
function fakeBus() {
  const listeners = new Set<(message: unknown) => void>()
  let tick = 0
  // 发出去的报文按实际内容记录（announce 只发普通对象），测试直接读字段。
  const posted: { kind: string; hostId: string; hostTitle: string; at: number }[] = []
  const bus: FederationBus & {
    deliver(message: unknown): void
    tick(): number
    posted: { kind: string; hostId: string; hostTitle: string; at: number }[]
  } = {
    posted,
    post: message => {
      posted.push(JSON.parse(JSON.stringify(message)))
      for (const listener of listeners) listener(message)
    },
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

  it('drops a sessions publication on the floor: the channel is presence-only', () => {
    // 2026-10-14 撤会话树：`sessions` 报文不再存在，收到了也只当噪音丢掉，
    // 不得把一个只剩半截的旧报文当成有效在场来源。
    const { fed } = setup()
    fed.start()
    fed.receive({ kind: 'sessions', ...THEM, at: 0, sessions: [{ projectId: 'p1', sessionId: 's1', title: 'x' }] })
    expect(fed.hosts().map(h => h.hostId)).toEqual(['alpha'])
  })
})

describe('HostFederation renameSelf', () => {
  it('改名：本机在场快照立刻换新名字，且播报带新名字出去', () => {
    // 面板改名保存后主行要立刻变：行读的是在场快照，快照不动名字就永远
    // 是旧的（这曾是真 bug——头部换了名，列表行不改）。
    const { fed, bus } = setup()
    fed.start()
    const before = bus.posted.length
    fed.renameSelf('Alpha 新名字')
    expect(fed.hosts()[0]?.hostTitle).toBe('Alpha 新名字')
    expect(bus.posted.at(-1)?.kind).toBe('heartbeat')
    expect(bus.posted.at(-1)?.hostTitle).toBe('Alpha 新名字')
    expect(bus.posted).toHaveLength(before + 1)
  })

  it('改名不退场：频道上没有 bye，别的标签页看到的是同一个 id 的新名字', () => {
    const { fed, bus } = setup()
    fed.start()
    fed.receive({ kind: 'hello', ...THEM, at: 0 })
    fed.renameSelf('Renamed')
    expect(bus.posted.some(message => message.kind === 'bye')).toBe(false)
    expect(fed.hosts().map(h => h.hostId)).toEqual(['alpha', 'beta'])
  })
})

describe('远端会话拉取（host-remote-sessions）', () => {
  const stubFetch = (handler: (url: string) => { status: number; body?: unknown } | undefined): void => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const found = handler(String(input))
      if (found === undefined) return new Response('not found', { status: 404 })
      if (found.status !== 200) return new Response('err', { status: found.status })
      return Response.json(found.body)
    }) as typeof fetch
  }

  it('launchUrl 缺 token：返回空清单并说明原因，不请求网络', async () => {
    const calls: string[] = []
    stubFetch(url => { calls.push(url); return undefined })
    const snap = await fetchRemoteSessions('http://127.0.0.1:4000/')
    expect(snap.sessions).toEqual([])
    expect(snap.note).toContain('token')
    expect(calls).toEqual([])
  })

  it('launchUrl 无效：空清单 + 说明，不抛', async () => {
    stubFetch(() => undefined)
    const snap = await fetchRemoteSessions('::::not-a-url')
    expect(snap.sessions).toEqual([])
    expect(snap.note).toContain('无效')
  })

  it('两个候选端点先 404 后 200：解析出会话与项目名', async () => {
    stubFetch(url => {
      if (url.includes('/api/workspace/list')) return { status: 404 }
      if (url.includes('/api/workspaces')) {
        return { status: 200, body: { workspaces: [{ workspaceId: 'w1', title: '研究', path: '/r', sessionIds: ['s1', 's2'] }] } }
      }
      return undefined
    })
    const snap = await fetchRemoteSessions('http://127.0.0.1:4000/?token=tk')
    expect(snap.sessions.map(s => s.sessionId)).toEqual(['s1', 's2'])
    expect(snap.sessions.every(s => s.projectId === 'w1')).toBe(true)
  })

  it('两个端点都失败：空清单 + 原始状态码说明', async () => {
    stubFetch(() => ({ status: 500 }))
    const snap = await fetchRemoteSessions('http://127.0.0.1:4000/?token=tk')
    expect(snap.sessions).toEqual([])
    expect(snap.note).toContain('500')
  })
})
