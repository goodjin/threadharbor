/**
 * The switch chain as the host actually reaches it: a model request landing on
 * one of this row's routes for a session the row does not drive.
 *
 * The load-bearing properties:
 *
 * - the chain runs in the host's order — judge, plan, hand over, apply — and a
 *   started session continues in a NEW session created on the target preset,
 *   with the conversation primed into its first model request (a DSH fork is
 *   verified to replay the started lock, so fork-then-select is not a route
 *   the mounted path can take);
 * - a second request for a target already switched to says where to go instead
 *   of duplicating the conversation;
 * - an unreadable or oversized conversation refuses before anything is created
 *   — the one outcome this must never produce is a silently truncated history;
 * - every dead end throws by name.
 */

import { describe, expect, it } from 'vitest'
import { declaredContextWindow, estimateTokens, mountSwitchOnForeignModelRequest, splitQuestion, switchDrivenSession } from '../src/switch-mount.ts'
import type { AgentLike } from '../src/dispatch.ts'
import { providerRoute } from '../src/catalog.ts'
import type { CatalogDeps } from '../src/catalog.ts'
import { makeSwitchShared } from '../src/switch-shared.ts'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' },
    'acp-claude': {
      agent: 'claude',
      command: 'claude-agent-acp',
      models: [{ id: 'claude-opus-4', name: 'Claude Opus 4', contextWindow: 100_000 }],
    },
  },
}

const deps: CatalogDeps = {
  modelsOf: presetId => presetId === 'acp-grok'
    ? [{ id: 'grok-4.7', name: 'Grok 4.7' }]
    : [{ id: 'claude-opus-4', name: 'Claude Opus 4', contextWindow: 100_000 }],
  dialectOf: () => undefined,
}

/** The conversation a native request would carry, with this turn's question last. */
const CONVERSATION = [
  { role: 'user', content: [{ type: 'text', text: '第一问' }] },
  { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
  { role: 'user', content: [{ type: 'text', text: '现在的问题' }] },
]

type CreatedRequest = { agentPreset?: string; cwd?: string }

/** The record of a session that has already had one finished turn. */
const SOURCE_LOG = [
  { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'chat' } }, reason: 'initial' } },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '第一问' }] } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第一答' }] }, stream: [] } },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', data: { turn: 2 } },
  { type: 'step/start', data: { turn: 2, step: 1 } },
  { type: 'model/selection', data: { provider: 'deepseek', model: 'chat' } },
]

/** A host context exposing exactly the services named, with recorded effects. */
function hostWith(over: {
  sessions?: Map<string, unknown>
  projection?: (session: unknown, key: string) => unknown
  create?: (request: CreatedRequest) => Promise<unknown>
  prompt?: (request: unknown) => Promise<unknown>
  agents?: Map<string, unknown>
  select?: (agent: unknown, presetId: string) => Promise<unknown>
  /** Per-session logs, as the session query hands them over. */
  logs?: Map<string, readonly unknown[]>
  /** `null` for a host that exposes no session query at all. */
  sessionQuery?: null
} = {}): {
  ctx: object
  shared: ReturnType<typeof makeSwitchShared>
  effects: {
    created: CreatedRequest[]
    prompts: unknown[]
    selections: [unknown, string][]
    appended: { type: string; data: unknown }[]
    /** Every effect in the order it happened, for ordering assertions. */
    order: string[]
  }
} {
  const sessions = over.sessions ?? new Map([['s1', { id: 's1', header: { cwd: '/workspace' } }]])
  // The live-agent registry answers for every session on this host, created
  // sessions included; the new session's agent exists by the time select runs.
  const agents = over.agents ?? new Map([['s1', { id: 's1' }]])
  const logs = over.logs ?? new Map([['s1', SOURCE_LOG]])
  const effects = {
    created: [] as CreatedRequest[],
    prompts: [] as unknown[],
    selections: [] as [unknown, string][],
    appended: [] as { type: string; data: unknown }[],
    order: [] as string[],
  }
  const projection = over.projection ?? (() => undefined)
  const ctx = {
    get: (key: string) => {
      switch (key) {
        case 'sessions': return { get: (id: string) => sessions.get(id) }
        case 'sessionProjections': return { stateOf: (session: unknown, k: string) => projection(session, k) }
        case 'sessionQuery': return over.sessionQuery === null ? undefined : {
          observeSession: async (id: string) => ({
            events: logs.get(id) ?? [],
            [Symbol.dispose]: () => {},
          }),
        }
        case 'sessionController': return {
          create: over.create ?? (async (request: CreatedRequest) => {
            effects.created.push(request)
            effects.order.push('create')
            const id = `created-${effects.created.length}`
            sessions.set(id, {
              id,
              header: { cwd: '/workspace' },
              append(type: string, data: unknown): { seq: number } {
                effects.appended.push({ type, data })
                effects.order.push(`append:${type}`)
                return { seq: effects.appended.length }
              },
            })
            agents.set(id, { id })
            return { sessionId: id, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) }
          }),
          prompt: over.prompt ?? (async (request: unknown) => {
            effects.prompts.push(request)
            effects.order.push('prompt')
            return { accepted: true }
          }),
        }
        case 'agents': return { get: (id: string) => agents.get(id) }
        case 'agentPresets': return {
          select: over.select ?? (async (agent: unknown, presetId: string) => {
            effects.selections.push([agent, presetId])
            effects.order.push(`select:${presetId}`)
            return presetId
          }),
        }
        default: return undefined
      }
    },
  }
  return { ctx, shared: makeSwitchShared({ sessionById: id => sessions.get(id) }), effects }
}

const request = {
  provider: providerRoute('acp-claude'),
  model: 'claude-opus-4',
  sessionId: 's1',
  messages: CONVERSATION,
}

const switchedBoundary = { openTurnStartSeq: 12, lastTurn: 1 }
const untouchedBoundary = { openTurnStartSeq: null, lastTurn: 0 }

describe('declaredContextWindow', () => {
  it('finds the window for a collapsed base pick', () => {
    // The picker collapses base[effort] rows to the base; the window check has
    // to see through the same collapsing or every effort-published model
    // counts as "no window declared" and the too-long refusal never fires.
    const codex: PresetConfig = {
      presets: {
        'acp-codex': {
          agent: 'codex',
          command: 'codex-acp',
          models: [{ id: 'gpt-6-astra[low]', name: 'low', contextWindow: 400_000 }],
        },
      },
    }
    expect(declaredContextWindow(codex, providerRoute('acp-codex'), 'gpt-6-astra')).toBe(400_000)
    expect(declaredContextWindow(codex, providerRoute('acp-codex'), 'gpt-6-astra[low]')).toBe(400_000)
  })
})

describe('mountSwitchOnForeignModelRequest', () => {
  it('refuses by name when the host does not expose the switch services', async () => {
    // A context without even `get`: every service is missing, and the refusal
    // names the whole list, because "nothing happened" is the failure to avoid.
    const handler = mountSwitchOnForeignModelRequest({}, CONFIG, deps, makeSwitchShared(), () => {})
    await expect(handler(request)).rejects.toThrow(
      /does not expose: sessions, sessionProjections, sessionController\.create, sessionController\.prompt, agents, agentPresets/,
    )
  })

  it('refuses when the session is gone', async () => {
    const { ctx, shared } = hostWith()
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    await expect(handler({ ...request, sessionId: 's-gone' })).rejects.toThrow(/s-gone.*not on this host/)
  })

  it('refuses, creating nothing, when the conversation cannot be read', async () => {
    // Creating a session without its history would be the silent truncation
    // this chain exists to prevent.
    const { ctx, shared, effects } = hostWith()
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    const { messages: _unread, ...unreadable } = request
    await expect(handler(unreadable)).rejects.toThrow(/读不到.*对话/)
    expect(effects.created).toEqual([])
  })

  it('says the takeover failed rather than switching a session that is already there', async () => {
    // currentPreset === target is the "our own takeover silently failed" case:
    // switching here would duplicate the conversation to fix nothing.
    const { ctx, shared } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-claude' : switchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    await expect(handler(request)).rejects.toThrow(/takeover did not happen/)
  })

  it('switches a fresh session in place, without creating anything', async () => {
    const { ctx, shared, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : untouchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    await expect(handler(request)).rejects.toThrow(/已就地切换到/)
    expect(effects.created).toEqual([])
    expect(effects.selections).toEqual([[{ id: 's1' }, 'acp-claude']])
  })

  it('carries a started session into a new session on the target preset, with the question', async () => {
    // The fork of a started session replays the started lock, so the mounted
    // switch creates a blank session bound to the target preset instead, and
    // the conversation rides its first model request.
    const { ctx, shared, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    await expect(handler(request)).rejects.toThrow(/新会话 created-1 已带上整段对话历史/)
    expect(effects.created).toEqual([{ agentPreset: 'acp-claude', cwd: '/workspace' }])
    expect(effects.selections).toEqual([])
    // The conversation rides the new session's first model request (the
    // primer), and the question rides the prompt issued to the new session.
    expect(shared.takeHandover('created-1')).toContain('第一问')
    expect(effects.prompts).toHaveLength(1)
    const prompted = effects.prompts[0] as { sessionId: string; content: readonly { text: string }[] }
    expect(prompted.sessionId).toBe('created-1')
    expect(prompted.content[0]!.text).toBe('现在的问题')
  })

  it('shows the conversation again in the new session, before it is asked anything', async () => {
    // The agent reading the history is not the user seeing it: the new session's
    // own record starts empty, which is what made a switch look like it lost
    // everything. The finished turns are copied in, ahead of the question.
    const { ctx, shared, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    await expect(handler(request)).rejects.toThrow(/新会话 created-1/)

    expect(effects.appended.map(entry => entry.type)).toEqual([
      'model/selection',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    // What was copied is the record the user already read — the old agent's
    // header and the switching turn's own start stay behind.
    expect(effects.appended[3]?.data).toEqual({ role: 'user', content: [{ type: 'text', text: '第一问' }] })
    expect(effects.order.indexOf('append:user/message')).toBeLessThan(effects.order.indexOf('prompt'))
  })

  it('switches without the visible copy when the host cannot read the old record, and says so', async () => {
    // Losing the display is not losing the conversation: the agent still reads
    // the whole history through the primer. Saying it out loud is what keeps
    // the degraded switch from reading as a successful one.
    const lines: string[] = []
    const { ctx, shared, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
      sessionQuery: null,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, message => lines.push(message))
    await expect(handler(request)).rejects.toThrow(/新会话 created-1/)

    expect(effects.appended.map(entry => entry.type)).toEqual(['model/selection'])
    expect(lines.join('\n')).toMatch(/sessionQuery[\s\S]*created-1/)
  })

  it('names the created session when the copy is refused half-way', async () => {
    // Half a conversation is the quiet truncation this chain exists to
    // prevent: the session is named, and the question is never asked of a
    // record that is missing its own earlier turns.
    let written = 0
    const { ctx, shared, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
      create: async () => {
        written = 0
        return { sessionId: 'created-1' }
      },
      sessions: new Map<string, unknown>([
        ['s1', { id: 's1', header: { cwd: '/workspace' } }],
        ['created-1', {
          id: 'created-1',
          header: { cwd: '/workspace' },
          append(): { seq: number } {
            written += 1
            if (written === 4) throw new Error('this session will not take that event')
            return { seq: written }
          },
        }],
      ]),
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    await expect(handler(request)).rejects.toThrow(/created-1.*2 of 6 events.*will not take that event/)
    expect(effects.prompts).toEqual([])
  })

  it('keeps switching, and says so, when the new session has nowhere to keep the copy', async () => {
    // No log is not a lost conversation: the agent still reads the whole
    // history. Stopping here would cost the user the answer as well.
    const lines: string[] = []
    const { ctx, shared, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
      create: async () => ({ sessionId: 'created-1' }),
      sessions: new Map<string, unknown>([
        ['s1', { id: 's1', header: { cwd: '/workspace' } }],
        ['created-1', { id: 'created-1', header: { cwd: '/workspace' } }],
      ]),
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, message => lines.push(message))
    await expect(handler(request)).rejects.toThrow(/新会话 created-1/)
    expect(effects.prompts).toHaveLength(1)
    expect(lines.join('\n')).toMatch(/created-1[\s\S]*no log to write to/)
  })

  it('points at the existing new session instead of duplicating the switch', async () => {
    const { ctx, shared, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    await expect(handler(request)).rejects.toThrow(/新会话 created-1/)
    await expect(handler(request)).rejects.toThrow(/此前已切到 acp-claude.*created-1/)
    expect(effects.created).toHaveLength(1)
    expect(effects.prompts).toHaveLength(1)
  })

  it('names the created session when the handover fails part-way', async () => {
    // The worst mid-switch outcome is a stray new session nobody can name.
    const { ctx, shared } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
      prompt: async () => { throw new Error('target unreachable') },
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    await expect(handler(request)).rejects.toThrow(/created-1.*target unreachable/)
  })

  it('refuses to hand a session back to the native agent it cannot name', async () => {
    // Only reachable from a future caller — this hook is invoked for this row's
    // own routes, which always name one of its presets — but the port refuses
    // honestly rather than guessing the host's native preset id.
    const { ctx, shared, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : untouchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    await expect(handler({ ...request, provider: 'deepseek' }))
      .rejects.toThrow(/cannot hand a session back to the native agent/)
    expect(effects.selections).toEqual([])
  })

  it('refuses a conversation larger than the target declares, with the numbers', async () => {
    // The declared context window is the one size the planner may refuse on.
    // A conversation of ~120k estimated tokens against a 100k window with
    // 8k held back for output is too large, and nothing may be created.
    const big = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `消息${index}:`.padEnd(12_000, '字') }],
    }))
    const { ctx, shared, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, shared, () => {})
    await expect(handler({ ...request, messages: big })).rejects.toThrow(/too large for the target/)
    expect(effects.created).toEqual([])
  })
})

describe('splitQuestion', () => {
  it('splits the trailing user messages off as the question', () => {
    const { carried, question } = splitQuestion([
      { role: 'user', text: '一' },
      { role: 'assistant', text: '二' },
      { role: 'user', text: '三' },
      { role: 'user', text: '四' },
    ])
    expect(carried.map(message => message.text)).toEqual(['一', '二'])
    expect(question).toBe('三\n四')
  })

  it('keeps everything when the conversation does not end in user messages', () => {
    const { carried, question } = splitQuestion([
      { role: 'user', text: '一' },
      { role: 'assistant', text: '二' },
    ])
    expect(carried).toHaveLength(2)
    expect(question).toBe('')
  })
})

describe('estimateTokens', () => {
  it('counts nothing for a request without messages', () => {
    expect(estimateTokens(undefined)).toBe(0)
  })

  it('estimates from the conversation the request carried', () => {
    // '{"a":1}' is seven characters; about four characters to a token.
    expect(estimateTokens([{ a: 1 }])).toBe(2)
  })
})

describe('switchDrivenSession — the pick a driven session makes at its turn', () => {
  const pick = { provider: 'acp:acp-claude', model: 'claude-opus-4' }
  const claim = { messages: [{ role: 'user', content: [{ type: 'text', text: '现在的问题' }] }] }

  const agentWith = (transcript: readonly unknown[]): AgentLike => ({
    id: 's1',
    session: {
      id: 's1',
      header: { cwd: '/workspace' },
      deriveMessages: () => transcript,
    },
  }) as never as AgentLike

  const agent = agentWith([
    { role: 'user', content: [{ type: 'text', text: '第一问' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
  ])

  const mounted = (shared: ReturnType<typeof makeSwitchShared>): void => {
    shared.registerPreset('acp-grok', { agent: 'grok', url: 'ws://x' }, [])
    shared.registerPreset(
      'acp-claude',
      { agent: 'claude', command: 'c', models: [{ id: 'claude-opus-4', name: 'Opus' }] },
      [{ id: 'claude-opus-4', name: 'Opus' }],
    )
  }

  it('refuses when the target preset is not mounted on this host', async () => {
    const fixture = hostWith()
    const decision = await switchDrivenSession({
      ctx: fixture.ctx, shared: fixture.shared, presetId: 'acp-grok',
      target: 'acp-claude', selection: pick, agent, decision: claim,
      report: () => {},
    })
    expect(decision).toMatchObject({ kind: 'refuse' })
    expect(decision.kind === 'refuse' && decision.reason).toContain('没有挂载')
    expect(fixture.effects.created).toEqual([])
  })

  it('performs the switch: new session, carried history, question asked', async () => {
    const fixture = hostWith({
      projection: (_session: unknown, key: string) => key === 'turnBoundary' ? switchedBoundary : undefined,
    })
    mounted(fixture.shared)
    const decision = await switchDrivenSession({
      ctx: fixture.ctx, shared: fixture.shared, presetId: 'acp-grok',
      target: 'acp-claude', selection: pick, agent, decision: claim,
      report: () => {},
    })
    expect(decision).toMatchObject({ kind: 'redirected' })
    expect(decision.kind === 'redirected' && decision.sessionId).toBe('created-1')
    expect(decision.kind === 'redirected' && decision.target).toBe('acp-claude')
    expect(decision.kind === 'redirected' && decision.note).toContain('created-1')
    expect(fixture.effects.created).toEqual([{ agentPreset: 'acp-claude', cwd: '/workspace' }])
    expect(fixture.effects.prompts).toHaveLength(1)
    expect(
      (fixture.effects.prompts[0] as { content: readonly { text: string }[] }).content[0]!.text,
    ).toBe('现在的问题')
    // The transcript (minus this turn's claim) travels as the handover; the
    // claim itself rides the prompt.
    const primed = fixture.shared.takeHandover('created-1') ?? ''
    expect(primed).toContain('第一问')
    expect(primed).toContain('第一答')
    expect(primed).not.toContain('现在的问题')
  })

  it('points at the earlier switch instead of making another one', async () => {
    const fixture = hostWith({
      projection: (_session: unknown, key: string) => key === 'turnBoundary' ? switchedBoundary : undefined,
    })
    mounted(fixture.shared)
    const common = {
      ctx: fixture.ctx, shared: fixture.shared, presetId: 'acp-grok',
      target: 'acp-claude', selection: pick, agent, decision: claim,
      report: () => {},
    }
    await switchDrivenSession(common)
    const again = await switchDrivenSession(common)
    expect(again).toMatchObject({ kind: 'redirected' })
    expect(again.kind === 'redirected' && again.note).toContain('此前已切到')
    expect(fixture.effects.created).toHaveLength(1)
  })

  it('refuses, with the sizes, when the history exceeds the declared window', async () => {
    const big = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `消息${index}:`.padEnd(12_000, '字') }],
    }))
    const fixture = hostWith({
      projection: (_session: unknown, key: string) => key === 'turnBoundary' ? switchedBoundary : undefined,
    })
    fixture.shared.registerPreset('acp-grok', { agent: 'grok', url: 'ws://x' }, [])
    fixture.shared.registerPreset(
      'acp-claude',
      { agent: 'claude', command: 'c', models: [{ id: 'claude-opus-4', name: 'Opus', contextWindow: 1_000 }] },
      [{ id: 'claude-opus-4', name: 'Opus', contextWindow: 1_000 }],
    )
    const decision = await switchDrivenSession({
      ctx: fixture.ctx, shared: fixture.shared, presetId: 'acp-grok',
      target: 'acp-claude', selection: pick, agent: agentWith(big), decision: claim,
      report: () => {},
    })
    expect(decision).toMatchObject({ kind: 'refuse' })
    expect(decision.kind === 'refuse' && decision.reason).toContain('too large')
    expect(fixture.effects.created).toEqual([])
  })
})
