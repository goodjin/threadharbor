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
import { buildPresetTable, sessionsRegistry } from '../src/registry.ts'
import type { AcpSessionFactory } from '../src/registry.ts'
import type { AcpDialect } from '@threadharbor/dsh-acp-agent'

/** A dialect is only ever read as an opaque handle by the registry. */
const stubDialect = (id: string): AcpDialect =>
  ({ id, foldTool: () => ({ callId: '', name: '', arguments: {} }), toolOutput: () => '', readModels: () => [], readUpdateTokens: () => undefined, isContent: () => true }) as unknown as AcpDialect

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
  die: (reason: string) => void
}

function killableSession(): KillableSession {
  let death: (reason: string) => void = () => {}
  return {
    run: async () => ({ frames: [], end: { kind: 'completed' } }),
    close: () => { closed += 1 },
    onDead: handler => { death = handler },
    die: reason => { death(reason) },
  }
}

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
      return session
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
      open: () => killableSession(),
    }
    const table = buildPresetTable({ presets: { dsh: { agent: 'native' }, 'acp-grok': CONFIG.presets['acp-grok'] } }, factory, sessionsRegistry())
    expect(table.has('dsh')).toBe(false)
    expect(table.has('acp-grok')).toBe(true)
  })

  it('opens one agent per session, not one per turn', async () => {
    const factory = killableFactory()
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry())
    const binding = table.get('acp-grok')!
    const decision = { kind: 'enter' as const, messages: [] }

    await binding.run(decision, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: r => [], write: () => 1 })
    await binding.run(decision, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: r => [], write: () => 1 })

    expect(factory.built).toEqual(['acp-grok'])
  })

  it('gives each preset its own agent', async () => {
    const factory = killableFactory()
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry())
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
        return killableSession()
      },
    }

    const table = buildPresetTable(CONFIG, factory, sessionsRegistry())
    await table.get('acp-grok')!.run({ kind: 'enter', messages: [] }, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    await table.get('acp-claude')!.run({ kind: 'enter', messages: [] }, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    expect(opened).toContainEqual({ presetId: 'acp-grok', modelId: 'grok-4.7' })
    expect(opened).toContainEqual({ presetId: 'acp-claude', modeId: 'default' })
  })

  it('ignores a preset whose configuration names no agent', () => {
    const table = buildPresetTable({ presets: { broken: {} } } as never, killableFactory(), sessionsRegistry())
    expect(table.size).toBe(0)
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
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry())
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
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry())
    const binding = table.get('acp-grok')!
    await binding.run(decision, turnOf('s1'))
    await binding.run(decision, turnOf('s1'))
    expect(factory.built).toEqual(['acp-grok'])
  })

  it('死亡事件在注册监听之后才来的场景下也接得住——开连接前注册，而非开连接后', async () => {
    // A connection that dies between turns must still drop the entry: the next
    // turn would otherwise reuse a corpse that fails only mid-turn.
    const factory = killableFactory()
    const table = buildPresetTable(CONFIG, factory, sessionsRegistry())
    const binding = table.get('acp-grok')!
    await binding.run(decision, turnOf('s1'))
    factory.sessions[0]!.die('process exited between turns')
    await binding.run(decision, turnOf('s1'))
    expect(factory.built).toEqual(['acp-grok', 'acp-grok'])
  })
})