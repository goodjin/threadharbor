/**
 * The plugin that actually runs inside a preset.
 *
 * An agent preset is a composition: selecting one mounts its rows. So the
 * behaviour of an external agent has to come from a row inside that
 * composition, which is what this entry is — one row per agent, configured
 * with that agent's transport and dialect.
 *
 * The scope is the filter. A row only sees the agents mounted with it, so a
 * session on some other preset is simply not seen here and keeps its own
 * behaviour with nothing to undo.
 */

import { describe, expect, it, vi } from 'vitest'
import { applyAcpPlugin, type AcpPluginContext } from '../src/plugin.ts'
import type { AcpTransport } from '@threadharbor/dsh-acp-agent'
import { installAcpDispatch } from '../src/dispatch.ts'
import type { AcpPresetBinding } from '../src/dispatch.ts'

/** A context carrying only what this entry touches. */
function ctx(): AcpPluginContext & {
  created(agent: unknown): void
  stopped(sessionId: string): void
  selected(sessionId: string, preset: string): void
  handlers: Map<string, ((...payload: never[]) => void)[]>
} {
  const handlers = new Map<string, ((...payload: never[]) => void)[]>()
  const record = (event: string, handler: (...payload: never[]) => void): void => {
    const list = handlers.get(event) ?? []
    list.push(handler)
    handlers.set(event, list)
  }
  return {
    handlers,
    on: ((event: string, handler: (...payload: never[]) => void) => { record(event, handler) }) as AcpPluginContext['on'],
    created: (agent) => {
      for (const handler of handlers.get('agent/created') ?? []) handler({ agent } as never)
    },
    stopped: (sessionId) => {
      for (const handler of handlers.get('workspace/session-stop') ?? []) handler({ sessionId } as never)
    },
    selected: (sessionId, preset) => {
      for (const handler of handlers.get('session/event') ?? []) {
        handler(
          { id: sessionId } as never,
          { type: 'agent-preset/selected', data: { agentPreset: preset } } as never,
        )
      }
    },
  }
}

const session = (preset?: string) => ({
  id: 's1',
  header: preset === undefined ? {} : { agentPreset: preset },
  session: { header: preset === undefined ? {} : { agentPreset: preset } },
})

const CONFIG = { agent: 'grok', url: 'ws://127.0.0.1:2419' }

describe('applyAcpPlugin', () => {
  it('takes over a session created on this preset', () => {
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
    })
    context.created(session('acp-grok'))
    expect(patched).toHaveLength(1)
  })

  it('falls back to the session header before the projection is written', () => {
    // The projection is the truth about which preset a session is on now, but it
    // is only written once the preset has been selected — and `agent/created`
    // fires before that write lands. A resolver that returns nothing at that
    // moment would leave every session on a real host unclaimed, silently.
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
      presetOf: () => undefined,
    })
    context.created(session('acp-grok'))
    expect(patched).toHaveLength(1)
  })

  it('trusts the projection over a header left by an earlier preset', () => {
    // The header records the preset a session was created with and never
    // changes afterwards, so once a session has moved it is the wrong answer.
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
      presetOf: () => 'standard',
    })
    context.created(session('acp-grok'))
    expect(patched).toHaveLength(0)
  })

  it('leaves a session on another preset alone', () => {
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
    })
    context.created(session('acp-claude'))
    expect(patched).toEqual([])
  })

  it('leaves a session with no preset alone', () => {
    // The native agent's sessions must keep their own step, with nothing to undo
    // afterwards — that is what keeps native presets behaving as they did.
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
    })
    context.created(session())
    expect(patched).toEqual([])
  })

  it('tells the installer which preset and dialect this row is', () => {
    const context = ctx()
    const install = vi.fn()
    applyAcpPlugin(context, 'acp-grok', CONFIG, { install })
    context.created(session('acp-grok'))
    expect(install).toHaveBeenCalledWith(
      expect.anything(),
      'acp-grok',
      expect.objectContaining({ id: 'grok' }),
      expect.any(Map),
    )
  })

  it('ignores a preset it was not configured for', () => {
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
    })
    context.created(session('acp-codex'))
    expect(patched).toEqual([])
  })

  it('reports an unknown agent rather than taking the session over', () => {
    // A typo in the config must leave the session on the native agent rather
    // than hand it to a dialect that does not exist.
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', { agent: 'nonesuch' }, {
      install: agent => { patched.push(agent) },
    })
    context.created(session('acp-grok'))
    expect(patched).toEqual([])
  })

  it('does not stop working after one session throws', () => {
    const context = ctx()
    let calls = 0
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: () => { calls++; if (calls === 1) throw new Error('one bad session') },
    })
    expect(() => context.created(session('acp-grok'))).not.toThrow()
    context.created(session('acp-grok'))
    expect(calls).toBe(2)
  })

  it('registers its model route with the host catalog', () => {
    // The catalogue is what makes the agent's models appear in the picker;
    // mounted here because this is the function the loaded entry calls.
    const registered: { routes: string[] }[] = []
    const context = {
      ...ctx(),
      get: (key: string) => key === 'llm'
        ? { registerAdapter: (routes: string[]) => { registered.push({ routes }) } }
        : undefined,
    }
    applyAcpPlugin(context, 'acp-grok', {
      agent: 'grok',
      url: 'ws://127.0.0.1:2419',
      models: [{ id: 'grok-4.7', name: 'Grok 4.7' }],
    }, { install: () => {} })
    expect(registered).toHaveLength(1)
    expect(registered[0]?.routes).toEqual(['acp:acp-grok'])
  })

  it('mounts anyway when the host has no model registry', () => {
    // Dispatch works without the picker; the missing catalogue must not take
    // the row down with it.
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
    })
    context.created(session('acp-grok'))
    expect(patched).toHaveLength(1)
  })
})

describe('预设是建会话之后才选上的（界面的选择器路径）', () => {
  // The interface's preset selector runs on a session whose agent already
  // exists: selecting rebinds that agent to the new composition and appends
  // `agent-preset/selected`, and nothing fires `agent/created` again. The row
  // must pick the takeover up from the event, or the turn right after a
  // selection runs the native agent — with no error anywhere.

  /** The row wired to a host whose live agents are `live`. */
  function rowWith(live: Map<string, unknown>): {
    context: ReturnType<typeof ctx>
    patched: unknown[]
    said: string[]
  } {
    const context = ctx()
    const wired = {
      ...context,
      get: (key: string) => key === 'agents' ? { get: (id: string) => live.get(id) } : undefined,
    } as AcpPluginContext & ReturnType<typeof ctx>
    const patched: unknown[] = []
    const said: string[] = []
    applyAcpPlugin(wired, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
      report: message => { said.push(message) },
    })
    return { context, patched, said }
  }

  it('接管选择事件指向的这个会话的活 agent', () => {
    const agent = { session: { header: { agentPreset: 'standard' } } }
    const { context, patched } = rowWith(new Map([['s1', agent]]))
    context.selected('s1', 'acp-grok')
    expect(patched).toEqual([agent])
  })

  it('选的是别的 preset 时不动', () => {
    const agent = { session: { header: { agentPreset: 'standard' } } }
    const { context, patched } = rowWith(new Map([['s1', agent]]))
    context.selected('s1', 'acp-claude')
    expect(patched).toEqual([])
  })

  it('会话还没有活 agent 时安静放过（冷会话的正常状态）', () => {
    const { context, patched } = rowWith(new Map())
    expect(() => context.selected('s1', 'acp-grok')).not.toThrow()
    expect(patched).toEqual([])
  })

  it('宿主没有 agents 注册表时说一声，而不是假装接管了', () => {
    // The selector's select call resolves the agent first, so at event time the
    // agent is live on any host that can select at all. A structurally missing
    // registry is therefore never the normal case — quiet here is how a takeover
    // that never happens looks exactly like one that did.
    const context = ctx()
    const said: string[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: () => {},
      report: message => { said.push(message) },
    })
    context.selected('s1', 'acp-grok')
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('agents')
  })

  it('同一个 preset 已持有这个 agent 时不重复安装', () => {
    // Selecting the same preset twice re-announces it twice. The second event
    // must not stack a second wrapper (or log a second takeover): the row asks
    // the dispatcher whether this binding already holds the agent.
    const agent = { session: { header: { agentPreset: 'standard' } }, step: async () => null }
    const context = ctx()
    const wired = {
      ...context,
      get: (key: string) => key === 'agents'
        ? { get: (id: string) => (id === 's1' ? agent : undefined) }
        : undefined,
    } as AcpPluginContext & ReturnType<typeof ctx>
    let installs = 0
    applyAcpPlugin(wired, 'acp-grok', CONFIG, {
      install: (a, _presetId, _dialect, table) => {
        installs += 1
        installAcpDispatch(a, table, { produce: () => [], write: () => undefined, presetOf: () => 'acp-grok', positionOf: () => ({ turn: 1, step: 1 }) })
      },
    })
    context.selected('s1', 'acp-grok')
    context.selected('s1', 'acp-grok')
    expect(installs).toBe(1)
  })

  it('选择事件与本行无关时，别的行的事件照常放行', () => {
    // The bus is shared: events for other presets reach this listener too, and
    // must be dropped by type/data, not by throwing.
    const agent = { session: { header: { agentPreset: 'standard' } } }
    const { context, patched } = rowWith(new Map([['s1', agent]]))
    expect(() => context.selected('s1', 'standard')).not.toThrow()
    expect(() => context.selected('s1', 'acp-grok')).not.toThrow()
    expect(patched).toEqual([agent])
  })
})

/** A transport a test can kill, counting how many connections were opened. */
function transportCounter(): { transport: () => AcpTransport & { die(reason: string): void; receive(frame: string): void }; count: () => number; closes: () => number } {
  let made = 0
  let closes = 0
  const make = (): AcpTransport & { die(reason: string): void; receive(frame: string): void } => {
    let line: (frame: string) => void = () => {}
    let death: (reason: string) => void = () => {}
    made += 1
    return {
      send: () => {},
      onLine: handler => { line = handler },
      onDeath: handler => { death = handler },
      close: () => { closes += 1 },
      die: reason => { death(reason) },
      receive: (frame: string) => { line(frame) },
    }
  }
  return { transport: make, count: () => made, closes: () => closes }
}

/** Install the row, capture the preset table, and hand back the driving handles. */
function installedRow(deps: { transport: () => AcpTransport & { die(reason: string): void }; report?: (message: string) => void }): {
  /** Start a turn; the connection is opened synchronously, the handshake may hang. */
  startTurn(sessionId: string): Promise<unknown>
  stop(sessionId: string): void
  transports: readonly (AcpTransport & { die(reason: string): void })[]
} {
  let captured: ReadonlyMap<string, AcpPresetBinding> | undefined
  const context = ctx()
  const transports: (AcpTransport & { die(reason: string): void })[] = []
  applyAcpPlugin(context, 'acp-grok', { agent: 'grok', url: 'ws://127.0.0.1:2419' }, {
    install: (_agent, _presetId, _dialect, table) => { captured = table },
    ...(deps.report === undefined ? {} : { report: deps.report }),
    transport: () => {
      const made = deps.transport()
      transports.push(made)
      return made
    },
  })
  context.created({ session: { header: { agentPreset: 'acp-grok' } } })
  const table = captured ?? new Map<string, AcpPresetBinding>()
  return {
    transports,
    // The registry opens the connection and caches it before its first await,
    // so a started turn is enough to have a live connection to stop or kill —
    // the handshake itself would wait on an agent no test stands in for.
    startTurn: sessionId => table.get('acp-grok')!.run(
      { kind: 'enter', messages: [] },
      { sessionId, position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 },
    ),
    stop: sessionId => { context.stopped(sessionId) },
  }
}

describe('会话停下来的善后', () => {
  it('会话被归档停止时，它的外部连接被关掉、缓存被丢弃', async () => {
    // The probe (and an operator archiving a session) ends the DSH session with
    // a stop request. The external connection outlives that event unless this
    // row lets go: an open socket or child process per archived session is the
    // leak that would otherwise grow with every probe.
    const counters = transportCounter()
    const row = installedRow({ transport: counters.transport })
    row.startTurn('probe-1').catch(() => {})
    // Opening is async now (grok's serve must be ready before it is dialed), so
    // the session lands in the registry one microtask after the turn starts —
    // yield before acting on the connection it opened.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(counters.count()).toBe(1)

    row.stop('probe-1')

    expect(counters.closes()).toBe(1)
    // The dropped entry means the next turn cannot reuse the closed
    // connection — a fresh one is opened instead.
    row.startTurn('probe-2').catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(counters.count()).toBe(2)
  })

  it('停的是别的会话时，这条连接原样留着', () => {
    const counters = transportCounter()
    const row = installedRow({ transport: counters.transport })
    row.startTurn('probe-1').catch(() => {})
    row.stop('some-other-session')
    expect(counters.closes()).toBe(0)
  })

  it('连接死亡的自愈上报走 report，说得出会话和原因', async () => {
    const counters = transportCounter()
    const said: string[] = []
    const row = installedRow({ transport: counters.transport, report: message => { said.push(message) } })
    row.startTurn('s1').catch(() => {})
    // The death listener is wired once the async open resolves; yield so the
    // die() lands on a session that is actually being watched.
    await new Promise(resolve => setTimeout(resolve, 0))
    row.transports[0]!.die('socket died')
    expect(said.some(message => message.includes('s1') && message.includes('socket died'))).toBe(true)
  })

  it('这条行只登记事件监听，不再往上下文写句柄表', () => {
    // The old design parked probe/restart handles on the host context for the
    // browser to read back by id — a reading that was always empty, because a
    // browser page's context is not the host's. Nothing is parked any more:
    // the only things this row registers are event subscriptions.
    const context = ctx()
    applyAcpPlugin(context, 'acp-grok', { agent: 'grok', url: 'ws://127.0.0.1:2419' }, {
      install: () => {},
      transport: transportCounter().transport,
    })
    expect([...context.handlers.keys()].sort())
      .toEqual(['agent/created', 'session/event', 'workspace/session-stop'])
  })
})

