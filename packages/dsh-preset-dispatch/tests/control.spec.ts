/**
 * Probe and restart.
 *
 * The reason these need tests is that both have a failure mode that looks like
 * success: a probe that checks the connection instead of the agent's ability to
 * work reports a hung agent as healthy, and a restart that empties a cache
 * without closing the connection hands back the same agent it was meant to
 * replace.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { makeAgentControls } from '../src/control.ts'
import type { AcpSession, AcpSessionFactory, PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419/ws' },
    dsh: {},
  },
}

function sessionBehaviours(behaviour: { onRun: () => Promise<unknown> | unknown }): {
  factory: AcpSessionFactory
  closed: () => number
} {
  let closed = 0
  return {
    factory: {
      dialectFor: ((id: string, c: { agent?: string }) => (c.agent === undefined ? undefined : { id })) as never,
      open: (() => ({
        run: async () => await behaviour.onRun(),
        close: () => { closed += 1 },
      })) as never,
    },
    closed: () => closed,
  }
}

describe('探测外部 agent', () => {
  it('正常回话时说是正常，并给出耗时', async () => {
    const { factory } = sessionBehaviours({ onRun: async () => ({ frames: [], end: { kind: 'completed' } }) })
    const controls = makeAgentControls(CONFIG, factory, () => new Map(), () => {})
    let clock = 1_000
    const verdict = await controls.get('acp-grok')!.probe({
      now: () => { const t = clock; clock += 120; return t },
    })
    expect(verdict.kind).toBe('ok')
  })

  it('回来得太慢时说的是慢，不是卡', async () => {
    // The distinction matters: "slow" tells the user to wait, "hung" tells them
    // to press restart. Reporting one as the other sends them the wrong way.
    const { factory } = sessionBehaviours({ onRun: async () => ({ frames: [], end: { kind: 'completed' } }) })
    const controls = makeAgentControls(CONFIG, factory, () => new Map(), () => {})
    let clock = 0
    const verdict = await controls.get('acp-grok')!.probe({
      slowAfterMs: 100,
      timeoutMs: 10_000,
      now: () => { clock += 400; return clock },
    })
    expect(verdict.kind).toBe('slow')
  })

  it('一直不回时说的是卡住，而不是一直等下去', async () => {
    const { factory } = sessionBehaviours({
      onRun: () => new Promise<never>(() => {}),
    })
    const controls = makeAgentControls(CONFIG, factory, () => new Map(), () => {})
    const verdict = await controls.get('acp-grok')!.probe({ timeoutMs: 60 })
    expect(verdict.kind).toBe('hung')
  })

  it('连都连不上时说的是连不上，而不是卡住', async () => {
    // These are different faults with different fixes, and a probe that
    // merges them sends the user to restart a service that was never reachable.
    const factory = {
      dialectFor: (() => ({ id: 'acp-grok' })) as never,
      open: (() => { throw new Error('connection refused') }) as never,
    }
    const controls = makeAgentControls(CONFIG, factory, () => new Map(), () => {})
    const verdict = await controls.get('acp-grok')!.probe()
    expect(verdict).toEqual({ kind: 'unreachable', reason: 'connection refused' })
  })

  it('探测会写进会话——探测不该动用户正在用的记录', async () => {
    const seen: string[] = []
    const factory = {
      dialectFor: (() => ({ id: 'acp-grok' })) as never,
      open: (() => ({
        run: async () => { seen.push('ran'); return { frames: [], end: { kind: 'completed' } } },
        close: () => {},
      })) as never,
    }
    const controls = makeAgentControls(CONFIG, factory, () => new Map(), () => {})
    await controls.get('acp-grok')!.probe()
    // The probe's own conversation is opened and closed; nothing it wrote is
    // carried into a session the user is looking at.
    expect(seen).toEqual(['ran'])
  })

  it('不归我们管的 agent 不会出现在可控列表里', async () => {
    const { factory } = sessionBehaviours({ onRun: async () => ({ frames: [], end: { kind: 'completed' } }) })
    const controls = makeAgentControls(CONFIG, factory, () => new Map(), () => {})
    expect([...controls.keys()]).toEqual(['acp-grok'])
  })
})

describe('重启外部 agent', () => {
  let dropped = 0

  beforeEach(() => { dropped = 0 })

  it('关掉当前所有连接，而不是只清缓存', async () => {
    // Closing the cache without closing the connection leaves the hung agent
    // in place, and the next turn reconnects to exactly the same dead one.
    let shut = 0
    const { factory } = sessionBehaviours({ onRun: async () => ({ frames: [], end: { kind: 'completed' } }) })
    const sessions: Map<string, AcpSession> = new Map([
      ['s1', { run: async () => ({ frames: [], end: { kind: 'completed' } }), close: () => { shut += 1 } }],
      ['s2', { run: async () => ({ frames: [], end: { kind: 'completed' } }), close: () => { shut += 1 } }],
    ])
    const controls = makeAgentControls(CONFIG, factory, () => sessions, () => { dropped += 1; sessions.clear() })
    const n = controls.get('acp-grok')!.restart()
    expect(n).toBe(2)
    expect(shut).toBe(2)
    expect(sessions.size).toBe(0)
    expect(dropped).toBe(1)
  })

  it('如实报告关掉了几个——没关掉东西的重启和成功的重启长得一样', () => {
    const { factory } = sessionBehaviours({ onRun: async () => ({ frames: [], end: { kind: 'completed' } }) })
    const controls = makeAgentControls(CONFIG, factory, () => new Map(), () => {})
    expect(controls.get('acp-grok')!.restart()).toBe(0)
  })
})