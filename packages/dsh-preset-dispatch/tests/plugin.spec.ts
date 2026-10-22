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
import { forgetSession, rememberStepPosition } from '../src/step-position.ts'
import type { AcpTransport } from '@threadharbor/dsh-acp-agent'
import { installAcpDispatch } from '../src/dispatch.ts'
import { switchShared } from '../src/switch-shared.ts'
import { runtimeModels } from '../src/catalog-registration.ts'
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

  it('挂载即注册退出清理：进程退出时收掉全部外部会话', () => {
    // 硬重启会留下孤儿子进程在外空转（2026-10-16 17:31 的重启遗留了一个
    // grok 空转到 17:43）。进程正常退出（含默认信号处理）时必须关掉所有
    // 外部会话；注册入口可注入，便于测试与宿主接管。
    const context = ctx()
    const cleaners: (() => void)[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: () => {},
      onExit: clean => { cleaners.push(clean) },
    })
    expect(cleaners).toHaveLength(1)
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

  it('leaves a zcode session on the native loop and still registers its models', () => {
    const registered: { routes: string[] }[] = []
    const context = {
      ...ctx(),
      get: (key: string) => key === 'llm'
        ? { registerAdapter: (routes: string[]) => { registered.push({ routes }) } }
        : undefined,
    }
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-zcode', {
      agent: 'zcode',
      models: [{ id: 'GLM-5.3', name: 'GLM 5.3' }],
    }, { install: agent => { patched.push(agent) } })
    context.created(session('acp-zcode'))
    expect(patched).toEqual([])
    expect(registered[0]?.routes).toEqual(['acp:acp-zcode'])
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
    let lastFrameAt = Date.now()
    made += 1
    return {
      send: () => {},
      onLine: handler => { line = handler },
      onDeath: handler => { death = handler },
      lastFrameAt: () => lastFrameAt,
      lastDiagnosticAt: () => 0,
      stderrTail: () => [],
      close: () => { closes += 1 },
      die: reason => { death(reason) },
      receive: (frame: string) => { lastFrameAt = Date.now(); line(frame) },
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
  const context = Object.assign(ctx(), {
    get: (key: string) => (key === 'sessions'
      ? { get: () => ({ header: { cwd: '/workspace' } }) }
      : undefined),
  })
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

describe('加载路径的模型报告真的进目录（applyAcpPlugin 端到端）', () => {
  /**
   * An agent the takeover can claim, with a real `step` for the installer to
   * replace — the same shape the loop hands over on `agent/created`.
   */
  class StepfulAgent {
    session: { header: { agentPreset?: string } }
    constructor(preset: string) {
      this.session = { header: { agentPreset: preset } }
    }
    async step(): Promise<{ kind: 'completed' } | null> {
      return { kind: 'completed' }
    }
  }

  /** A scripted transport: records what was sent, replays what is received. */
  function scriptedTransport(): AcpTransport & { sent: string[]; receive(frame: string): void } {
    let line: (frame: string) => void = () => {}
    let lastFrameAt = Date.now()
    const sent: string[] = []
    return {
      send: frame => { sent.push(frame) },
      close: () => {},
      onLine: handler => { line = handler },
      onDeath: () => {},
      // The beacon surface every transport now carries; frames land via
      // receive(), so the frame stamp moves when the script answers.
      lastFrameAt: () => lastFrameAt,
      lastDiagnosticAt: () => 0,
      stderrTail: () => [],
      sent,
      /** Exposed so the test can answer requests the way a live agent would. */
      receive: (frame: string) => { lastFrameAt = Date.now(); line(frame) },
    } as AcpTransport & { sent: string[]; receive(frame: string): void }
  }

  /** Yield long enough for the runner's awaited request to be on the wire. */
  const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

  it('新开的外部会话用这条会话自己的项目目录，不用预设上写死的目录', async () => {
    const project = '/Users/good/qg/nexa-service'
    const pinned = '/Users/good/Documents/deepseek-harness'
    let adapter: { stream?(options: Record<string, unknown>): AsyncIterable<unknown> } | undefined
    const context = {
      ...ctx(),
      get: (key: string) => {
        if (key === 'llm') {
          return { registerAdapter: (_routes: string[], registered: { stream?: (o: Record<string, unknown>) => AsyncIterable<unknown> }) => { adapter = registered } }
        }
        if (key === 'sessions') {
          return { get: (id: string) => (id === 's1' ? { header: { cwd: project } } : undefined) }
        }
        return undefined
      },
    }
    const scripted = scriptedTransport()
    applyAcpPlugin(context, 'acp-codex', { agent: 'codex', command: 'codex-acp', cwd: pinned }, {
      install: () => {},
      transport: () => scripted,
    })
    const chunks = adapter?.stream?.({
      provider: 'acp:acp-codex',
      model: 'gpt-6-astra',
      sessionId: 's1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '看看项目里有什么' }] }],
    })
    void (async () => { for await (const chunk of chunks ?? []) { void chunk } })()
    const answered = new Set<string>()
    let openedIn: string | undefined
    for (let pass = 0; pass < 8 && openedIn === undefined; pass++) {
      await settle()
      for (const frame of scripted.sent) {
        const request = JSON.parse(frame) as { id?: number; method?: string; params?: { cwd?: string } }
        if (request.id === undefined || answered.has(frame)) continue
        answered.add(frame)
        if (request.method === 'initialize') {
          scripted.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }))
        }
        if (request.method === 'session/new') {
          openedIn = request.params?.cwd
          scripted.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'x1' } }))
        }
      }
    }
    expect(openedIn).toBe(project)
  })

  it('会话没有工作区时不开外部会话，预设上的目录也不顶上', async () => {
    let adapter: { stream?(options: Record<string, unknown>): AsyncIterable<unknown> } | undefined
    const context = {
      ...ctx(),
      get: (key: string) => {
        if (key === 'llm') {
          return { registerAdapter: (_routes: string[], registered: { stream?: (o: Record<string, unknown>) => AsyncIterable<unknown> }) => { adapter = registered } }
        }
        if (key === 'sessions') return { get: () => ({ header: {} }) }
        return undefined
      },
    }
    const scripted = scriptedTransport()
    const reports: string[] = []
    applyAcpPlugin(context, 'acp-codex', { agent: 'codex', command: 'codex-acp', cwd: '/Users/good/Documents/deepseek-harness' }, {
      install: () => {},
      transport: () => scripted,
      report: message => { reports.push(message) },
    })
    const chunks = adapter?.stream?.({
      provider: 'acp:acp-codex',
      model: 'gpt-6-astra',
      sessionId: 's1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '看看项目里有什么' }] }],
    })
    await expect((async () => {
      for await (const chunk of chunks ?? []) { void chunk }
    })()).rejects.toThrow(/没有工作区/)
    expect(scripted.sent.some(frame => frame.includes('session/new'))).toBe(false)
    expect(reports.some(message => message.includes('cwd 已忽略'))).toBe(true)
  })

  it('hands the session writer down to the in-place path, so tool cards are recorded', async () => {
    // 装载期这一段是整条链的最后一节：entry 从会话服务取出写入器，经 deps 传到
    // 网关。断了它，网关里的写入器就永远拿不到东西，工具卡片依旧无处可去——
    // 而这一节没有任何报错，正是当初漏掉的那一节。
    const written: { type: string; payload: unknown }[] = []
    let adapter: { stream?(options: Record<string, unknown>): AsyncIterable<unknown> } | undefined
    const context = {
      ...ctx(),
      get: (key: string) => {
        if (key === 'llm') {
          return { registerAdapter: (_routes: string[], registered: { stream?: (o: Record<string, unknown>) => AsyncIterable<unknown> }) => { adapter = registered } }
        }
        if (key === 'sessions') return { get: () => ({ header: { cwd: '/workspace' } }) }
        return undefined
      },
    }
    const scripted = scriptedTransport()
    applyAcpPlugin(context, 'acp-codex', { agent: 'codex', command: 'codex-acp' }, {
      install: () => {},
      sessionAppend: (sessionId: string) => (sessionId === 's1'
        ? ((type: string, payload: unknown) => { written.push({ type, payload }); return { seq: written.length } }) as never
        : undefined),
      transport: () => scripted,
    })

    // 循环自己报出的那一对：网关写工具事件只能用真编号，会话日志是在「打开」
    // 这一刻才按它校验的（session-format 的 requireStep）。没有这一步，网关
    // 只能不写工具事件——那条降级由别的用例钉着。
    rememberStepPosition({}, 's1', { turn: 11, step: 1 })
    // A foreign session's own step asks this model to stream an answer.
    const chunks = adapter?.stream?.({
      provider: 'acp:acp-codex',
      model: 'gpt-6-astra',
      sessionId: 's1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '看看项目里有什么' }] }],
    })
    void (async () => { for await (const chunk of chunks ?? []) { void chunk } })()
    // Answer each request as it goes out: the prompt only leaves after the
    // handshake it follows has been answered, so one pass over what has been
    // sent is not enough.
    const answered = new Set<string>()
    let prompted = false
    let modelSet = false
    for (let pass = 0; pass < 8 && !prompted; pass++) {
      await settle()
      for (const frame of scripted.sent) {
        const request = JSON.parse(frame) as { id?: number; method?: string; params?: { modelId?: string } }
        if (request.id === undefined || answered.has(frame)) continue
        answered.add(frame)
        if (request.method === 'initialize') {
          scripted.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }))
        }
        if (request.method === 'session/new') {
          scripted.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'x1' } }))
        }
        if (request.method === 'session/set_model') {
          modelSet = request.params?.modelId === 'gpt-6-astra'
          scripted.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }))
        }
        if (request.method === 'session/prompt') {
          prompted = true
          scripted.receive(JSON.stringify({
            jsonrpc: '2.0', method: 'session/update',
            params: { sessionId: 'x1', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'execute', rawInput: { command: 'ls' } } },
          }))
          scripted.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } }))
        }
      }
    }
    expect(modelSet).toBe(true)
    expect(prompted).toBe(true)
    await settle()
    await settle()

    expect(written.some(entry => entry.type === 'tool/call')).toBe(true)
    // The loop assembles the answer from the chunks; the gateway must not
    // append a second *answer* message for the same step. The one message it
    // does file is the tool-call announcement the log needs to admit the card
    // — a `tool-call` block and no answer text — not a duplicate of the answer.
    const messages = written.filter(entry => entry.type === 'assistant/message')
    for (const entry of messages) {
      const content = (entry.payload as { message?: { content?: unknown } }).message?.content
      expect(Array.isArray(content)).toBe(true)
      const blocks = content as { type?: string }[]
      expect(blocks.some(block => block.type === 'tool-call')).toBe(true)
      expect(blocks.some(block => block.type === 'text' || block.type === 'reasoning')).toBe(false)
    }
    forgetSession('s1')
  })

  it('一个回合的 session/new 报告经 applyAcpPlugin 到达 listModels', async () => {
    // The loaded entry mounts the row through applyAcpPlugin; if the factory's
    // runtime report had nowhere to land on this path, the picker would
    // silently serve the configured guess forever. So the whole chain runs
    // here: mount → takeover → one turn → the catalog adapter answers.
    const context = ctx()
    let adapter: { listModels(provider: string): Promise<readonly { id: string; name?: string }[]> } | undefined
    const withRegistry = Object.assign(context, {
      get: (key: string) => {
        if (key === 'llm') {
          return { registerAdapter: (_providers: string[], registered: never) => { adapter = registered } }
        }
        if (key === 'sessions') return { get: () => ({ header: { cwd: '/workspace' } }) }
        return undefined
      },
    })

    const transport = scriptedTransport()
    // The same ledger the standalone entry's per-turn gate reads: the report
    // must land HERE, or the picker and the gate would judge different lists.
    const reports = runtimeModels()
    applyAcpPlugin(withRegistry, 'acp-grok', {
      agent: 'grok',
      url: 'ws://127.0.0.1:2419',
      // A configured guess the report must replace once it lands.
      models: [{ id: 'configured-guess', name: 'Configured guess' }],
    }, {
      runtimeModels: reports,
      install: (agent, _presetId, _dialect, table) => {
        installAcpDispatch(agent as never, table, {
          produce: () => [],
          write: () => 1,
          positionOf: () => ({ turn: 1, step: 1 }),
        })
      },
      transport: () => transport,
    })

    const agent = new StepfulAgent('acp-grok')
    context.created(agent)
    const turn = (agent as unknown as { step(d: unknown): Promise<unknown> }).step({ kind: 'enter', messages: [] })
    // Answer every request as it lands, until the turn settles: initialize,
    // then session/new carrying the grok-shaped model list, then the prompt.
    let settled = false
    void turn.then(() => { settled = true }, () => { settled = true })
    for (let guard = 0; guard < 100 && !settled; guard += 1) {
      for (const frame of transport.sent.splice(0)) {
        const request = JSON.parse(frame) as { id?: number; method?: string }
        if (request.id === undefined) continue
        const result = request.method === 'session/new'
          ? { sessionId: 's1', models: { availableModels: [{ modelId: 'm1', name: 'M1' }] } }
          : request.method === 'session/prompt'
            ? { stopReason: 'end_turn' }
            : {}
        transport.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      }
      await settle()
    }
    await turn

    expect(adapter).toBeDefined()
    const models = await adapter!.listModels('acp:acp-grok')
    // The agent's own report replaced the configured guess — through the
    // loaded path, not a side door.
    expect(models.map(model => model.id)).toEqual(['m1'])
    expect(models[0]?.name).toBe('M1')
    expect(reports.modelsOf('acp-grok')?.map(model => model.id)).toEqual(['m1'])
  })
})

describe('一行没有传输方言的模型', () => {
  it('照样注册进切换网，模型才出现在模型列表里', () => {
    // minimaxi 这类行没有子进程也没有 WebSocket 方言：它由 DSH 自己的循环
    // 应答。曾经这里只认 zcode，于是这一行挂上了却什么都不注册，界面上的
    // 表现是「模型在列表里选了却没人应答」。
    switchShared.registerPreset('acp-test-unmount', { agent: 'grok' }, [])
    const context = ctx()
    applyAcpPlugin(context, 'acp-minimaxi', { agent: 'minimaxi' }, { install: () => {} })
    expect(switchShared.config().presets['acp-minimaxi']?.agent).toBe('minimaxi')
  })
})
