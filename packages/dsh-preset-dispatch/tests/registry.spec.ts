/**
 * Turning configuration into the preset table the dispatcher consults.
 *
 * Only ACP presets belong in this table. A native preset must be absent, not
 * present-and-skipped: absence is what lets the dispatcher leave those sessions
 * completely alone.
 */

import { beforeEach, describe, expect, it } from 'vitest'

let closed = 0
beforeEach(() => { closed = 0 })
import { buildPresetTable, cwdForOpen, sessionsRegistry } from '../src/registry.ts'
import type { AcpSessionFactory, AcpSession } from '../src/registry.ts'
import type { AcpDialect } from '@threadharbor/dsh-acp-agent'

/** A dialect is only ever read as an opaque handle by the registry. */
const stubDialect = (id: string): AcpDialect =>
  ({ id, foldTool: () => ({ callId: '', name: '', arguments: {} }), toolOutput: () => '', readModels: () => [], readReplyUsage: () => undefined, isContent: () => true }) as unknown as AcpDialect

const CONFIG = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419', model: 'grok-4.7' },
    'acp-claude': { agent: 'claude', command: 'claude-agent-acp', mode: 'default' },
  },
} as const

/** One session a test can kill, wired the way the factory really wires it. */
type KillableSession = {
  run: () => Promise<{ frames: never[]; end: { kind: 'completed' } }>
  close: () => void
  onDead: (handler: (reason: string) => void) => void
  diagnostics: () => { lastFrameAt: number; lastDiagnosticAt: number; stderrTail: readonly string[] }
  die: (reason: string) => void
}

function killableSession(): KillableSession {
  let death: (reason: string) => void = () => {}
  return {
    run: async () => ({ frames: [], end: { kind: 'completed' } }),
    close: () => { closed += 1 },
    onDead: handler => { death = handler },
    diagnostics: () => ({ lastFrameAt: Date.now(), lastDiagnosticAt: Date.now(), stderrTail: [] }),
    die: reason => { death(reason) },
  }
}

/** A session directory the tests that are not about workspaces can open in. */
const inProject = { cwdOfSession: () => '/workspace' }

function killableFactory(): AcpSessionFactory & { built: string[]; sessions: KillableSession[] } {
  const built: string[] = []
  const sessions: KillableSession[] = []
  return {
    built,
    sessions,
    dialectFor: presetId => stubDialect(presetId),
    open: presetId => {
      built.push(presetId)
      const session = killableSession()
      sessions.push(session)
      return Promise.resolve(session)
    },
  }
}

describe('buildPresetTable', () => {
  it('includes exactly the configured ACP presets', () => {
    const table = buildPresetTable(CONFIG, killableFactory(), sessionsRegistry())
    expect([...table.keys()].sort()).toEqual(['acp-claude', 'acp-grok'])
  })

  it('says nothing about a preset naming an agent it does not drive', () => {
    // A native session must not be taken over, and it can reach this config.
    // The check is on the agent, not on the preset being listed.
    const factory: AcpSessionFactory = {
      dialectFor: (presetId, config) => config.agent === 'native' ? undefined : stubDialect(presetId),
      open: () => Promise.resolve(killableSession()),
    }
    const table = buildPresetTable({ presets: { dsh: { agent: 'native' }, 'acp-grok': CONFIG.presets['acp-grok'] } }, factory, sessionsRegistry())
    expect(table.has('dsh')).toBe(false)
    expect(table.has('acp-grok')).toBe(true)
  })

  it('opens one agent per session, not one per turn', async () => {
    const factory = killableFactory()
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry(), inProject)
    const binding = table.get('acp-grok')!
    const decision = { kind: 'enter' as const, messages: [] }

    await binding.run(decision, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: r => [], write: () => 1 })
    await binding.run(decision, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: r => [], write: () => 1 })

    expect(factory.built).toEqual(['acp-grok'])
  })

  it('gives each preset its own agent', async () => {
    const factory = killableFactory()
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry(), inProject)
    await table.get('acp-grok')!.run({ kind: 'enter', messages: [] }, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    await table.get('acp-claude')!.run({ kind: 'enter', messages: [] }, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    expect(factory.built).toEqual(['acp-grok', 'acp-claude'])
  })

  it('carries the configured model and mode through to the agent', async () => {
    // Dropping them would run the agent on its own defaults while the UI shows
    // the configured ones.
    const opened: { presetId: string; modelId?: string; modeId?: string }[] = []
    const factory: AcpSessionFactory = {
      dialectFor: () => stubDialect('x'),
      open: (presetId, options) => {
        opened.push({ presetId, ...(options.modelId === undefined ? {} : { modelId: options.modelId }), ...(options.modeId === undefined ? {} : { modeId: options.modeId }) })
        return Promise.resolve(killableSession())
      },
    }

    const table = buildPresetTable(CONFIG, factory, sessionsRegistry(), inProject)
    await table.get('acp-grok')!.run({ kind: 'enter', messages: [] }, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    await table.get('acp-claude')!.run({ kind: 'enter', messages: [] }, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    expect(opened).toContainEqual({ presetId: 'acp-grok', modelId: 'grok-4.7' })
    expect(opened).toContainEqual({ presetId: 'acp-claude', modeId: 'default' })
  })

  it('ignores a preset whose configuration names no agent', () => {
    const table = buildPresetTable({ presets: { broken: {} } } as never, killableFactory(), sessionsRegistry())
    expect(table.size).toBe(0)
  })

  it('opens only in the session project, and refuses when that session has none', async () => {
    const opened: string[] = []
    const factory: AcpSessionFactory = {
      dialectFor: () => stubDialect('x'),
      open: (_presetId, options) => {
        opened.push(options.cwd)
        return Promise.resolve(killableSession())
      },
    }
    const table = buildPresetTable(
      { presets: { 'acp-grok': { agent: 'grok', cwd: '/Users/good/Documents/deepseek-harness' } } },
      factory,
      sessionsRegistry(),
      { cwdOfSession: id => (id === 's1' ? '/Users/good/qg/nexa-service' : undefined) },
    )
    const turn = (sessionId: string) => ({ sessionId, position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    await table.get('acp-grok')!.run({ kind: 'enter', messages: [] }, turn('s1'))
    await expect(table.get('acp-grok')!.run({ kind: 'enter', messages: [] }, turn('s2'))).rejects.toThrow(/没有工作区/)
    // The directory pinned on the preset is not a place to open.
    expect(opened).toEqual(['/Users/good/qg/nexa-service'])
  })

  it('cwdForOpen uses only the session directory', () => {
    expect(cwdForOpen('/proj')).toBe('/proj')
    expect(() => cwdForOpen(undefined)).toThrow(/没有工作区/)
    expect(() => cwdForOpen('')).toThrow(/没有工作区/)
  })
})

describe('连接死亡后的自愈', () => {
  const decision = { kind: 'enter' as const, messages: [] }
  const turnOf = (sessionId: string) => ({ sessionId, position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

  it('连接死了就丢掉那条会话，下一回合开的是新连接，并如实上报', async () => {
    // The whole point of the self-heal: the registry used to hand the same dead
    // connection back forever, and fixing it needed a button that reached the
    // host from the browser — a button that could never work. Dropping on death
    // needs no button at all.
    const factory = killableFactory()
    const dropped: { presetId: string; sessionId: string; reason: string }[] = []
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry(), {
      ...inProject,
      onDropped: event => { dropped.push(event) },
    })
    const binding = table.get('acp-grok')!

    await binding.run(decision, turnOf('s1'))
    expect(factory.built).toEqual(['acp-grok'])

    factory.sessions[0]!.die('acp agent exited (code=1)')
    expect(dropped).toEqual([{ presetId: 'acp-grok', sessionId: 's1', reason: 'acp agent exited (code=1)' }])

    await binding.run(decision, turnOf('s1'))
    expect(factory.built).toEqual(['acp-grok', 'acp-grok'])
  })

  it('一个会话的连接死了，别的会话的连接不受影响', async () => {
    const factory = killableFactory()
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry(), inProject)
    const binding = table.get('acp-grok')!

    await binding.run(decision, turnOf('s1'))
    await binding.run(decision, turnOf('s2'))
    expect(factory.built).toEqual(['acp-grok', 'acp-grok'])

    factory.sessions[0]!.die('socket closed')
    await binding.run(decision, turnOf('s2'))
    // s2's connection was alive, so its next turn must not pay for a reopen.
    expect(factory.built).toEqual(['acp-grok', 'acp-grok'])

    await binding.run(decision, turnOf('s1'))
    expect(factory.built).toEqual(['acp-grok', 'acp-grok', 'acp-grok'])
  })

  it('连接没死时下一回合照旧复用，不无故重开', async () => {
    const factory = killableFactory()
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry(), inProject)
    const binding = table.get('acp-grok')!
    await binding.run(decision, turnOf('s1'))
    await binding.run(decision, turnOf('s1'))
    expect(factory.built).toEqual(['acp-grok'])
  })

  it('死亡事件在注册监听之后才来的场景下也接得住——开连接前注册，而非开连接后', async () => {
    // A connection that dies between turns must still drop the entry: the next
    // turn would otherwise reuse a corpse that fails only mid-turn.
    const factory = killableFactory()
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry(), inProject)
    const binding = table.get('acp-grok')!
    await binding.run(decision, turnOf('s1'))
    factory.sessions[0]!.die('process exited between turns')
    await binding.run(decision, turnOf('s1'))
    expect(factory.built).toEqual(['acp-grok', 'acp-grok'])
  })
})

describe('buildPresetTable — runSteps 透传', () => {
  const decision = { kind: 'enter' as const, messages: [] }
  const turnOf = (sessionId: string) => ({ sessionId, position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

  /** 在 killable 工厂开出的会话上补一段可断言的 runSteps，其余接线照旧。 */
  function factoryWithRunSteps(runSteps: NonNullable<AcpSession['runSteps']>): AcpSessionFactory & { built: string[] } {
    const base = killableFactory()
    return {
      ...base,
      open: (presetId, options) => base.open(presetId, options).then(session => ({ ...session, runSteps })),
    }
  }

  it('binding 带出会话的 runSteps，first 原样透传，段与段之间复用同一条连接', async () => {
    // 接管路径一段一次调用；段之间重开连接，外部会话的上下文就散了——开连接
    // 的记账必须由 run 与 runSteps 共用，first 标记不得在半路丢失或改写。
    const firsts: boolean[] = []
    const factory = factoryWithRunSteps(async (_decision, _turn, at) => {
      firsts.push(at.first)
      return at.first ? null : { kind: 'completed' as const }
    })
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry(), inProject)
    const binding = table.get('acp-grok')!
    expect(binding.runSteps).toBeTypeOf('function')

    expect(await binding.runSteps!(decision, turnOf('s1'), { first: true })).toBeNull()
    expect(await binding.runSteps!(decision, turnOf('s1'), { first: false })).toEqual({ kind: 'completed' })
    expect(firsts).toEqual([true, false])
    expect(factory.built).toEqual(['acp-grok'])
  })

  it('会话没带 runSteps 时回落单发 run，把真实结束原因当末段返回', async () => {
    // 自备工厂（或旧测试桩）的会话只有 run。binding 仍要接得住接管路径的按段
    // 调用：一次调用跑完整个回合，结束原因从 run 的结果里来——对外表现与单步
    // 路径一致。
    const factory = killableFactory()
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry(), inProject)
    const binding = table.get('acp-grok')!
    expect(binding.runSteps).toBeTypeOf('function')

    await expect(binding.runSteps!(decision, turnOf('s1'), { first: true })).resolves.toEqual({ kind: 'completed' })
    expect(factory.built).toEqual(['acp-grok'])
  })
})