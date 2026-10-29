/**
 * One shared agent process serving several DSH sessions.
 *
 * 这几条测的都是「一条连接、许多会话」才有的东西：帧、终端输出、看门狗信标
 * 与日志进度必须按 ACP 会话 id 归位。单会话路径上它们本来就不会串，所以这
 * 些用例全部用一条注入的传输、两个会话同时在线来写——真把 `grok agent serve`
 * 拉起来会把测试变成与版本赛跑的活测。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grokDialect } from '@threadharbor/dsh-acp-agent'
import type { AcpTransport } from '@threadharbor/dsh-acp-agent'
import { makeSessionFactory } from '../src/factory.ts'
import type { AcpSession } from '../src/registry.ts'

const CONFIG = { presets: { 'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' } } }

type Wire = AcpTransport & { readonly sent: string[]; receive(frame: unknown): void }

type Harness = {
  readonly transport: Wire
  readonly answered: Set<number>
  /** Open sessions through one shared agent, as the registry does. */
  openTwo(): Promise<{ agent: { kill(reason: string): void }; s1: AcpSession; s2: AcpSession }>
}

function harness(): Harness {
  const sent: string[] = []
  let line: (line: string) => void = () => {}
  const transport: Wire = {
    sent,
    send: (frame: string) => { sent.push(frame) },
    onLine: handler => { line = handler },
    onDeath: () => {},
    lastFrameAt: () => 0,
    lastDiagnosticAt: () => 0,
    stderrTail: () => [],
    close: () => {},
    receive: frame => { line(JSON.stringify(frame)) },
  }
  const factory = makeSessionFactory(CONFIG, {
    answerPermission: async () => ({ outcome: 'allow' }),
    transport: () => transport,
  })
  return {
    transport,
    answered: new Set(),
    openTwo: async () => {
      const agent = await factory.openShared('acp-grok')
      const s1 = await agent.openSession({ dshSessionId: 'd1', cwd: '/p1', dialect: grokDialect })
      const s2 = await agent.openSession({ dshSessionId: 'd2', cwd: '/p2', dialect: grokDialect })
      return { agent, s1, s2 }
    },
  }
}

const decision = { kind: 'enter' as const, messages: [] }

/** A turn context; `written` collects every event the runner puts on the log. */
function turnOf(sessionId: string, written: string[]) {
  return {
    sessionId,
    position: { turn: 1, step: 1 },
    produce: () => [],
    write: (events: readonly unknown[]) => { written.push(JSON.stringify(events)); return 1 },
  }
}

const update = (sessionId: string, text: string) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
})

const toolCall = (sessionId: string, callId: string, command: string) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId,
    update: { sessionUpdate: 'tool_call', toolCallId: callId, title: 'run_terminal_command', rawInput: { command }, status: 'pending' },
  },
})

const spawned = (sessionId: string, childId: string) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId,
    update: { sessionUpdate: 'subagent_spawned', child_session_id: childId, subagent_type: 'explorer', description: 'look around' },
  },
})

/** Every request the client sent, in order. */
function sentFrames(wire: Wire): { id?: number; method?: string; params?: unknown; result?: unknown }[] {
  return wire.sent.map(line => JSON.parse(line) as { id?: number; method?: string; params?: unknown; result?: unknown })
}

/**
 * Answer every request the client sent that `handle` recognizes, and nothing
 * else — prompts stay in flight so frames can be injected mid-turn.
 */
async function answerEach(
  h: Harness,
  handle: (method: string, params: Record<string, unknown>) => { result: unknown } | undefined,
): Promise<void> {
  for (let round = 0; round < 100; round += 1) {
    let handled = 0
    for (const frame of sentFrames(h.transport)) {
      if (typeof frame.id !== 'number' || frame.method === undefined) continue
      if (h.answered.has(frame.id)) continue
      const reply = handle(frame.method, (frame.params ?? {}) as Record<string, unknown>)
      if (reply === undefined) continue
      h.answered.add(frame.id)
      h.transport.receive({ jsonrpc: '2.0', id: frame.id, result: reply.result })
      handled += 1
    }
    if (handled === 0) return
    await flush()
  }
}

/** Open both sessions: initialize, then session/new keyed by the cwd. */
async function openBoth(h: Harness, s1: AcpSession, s2: AcpSession) {
  const written1: string[] = []
  const written2: string[] = []
  const run1 = s1.run(decision, turnOf('d1', written1) as never)
  const run2 = s2.run(decision, turnOf('d2', written2) as never)
  await answerEach(h, (method, params) => {
    if (method === 'initialize') return { result: {} }
    if (method === 'session/new') return { result: { sessionId: params['cwd'] === '/p1' ? 'ext-1' : 'ext-2' } }
    return undefined
  })
  // The prompt follows the open on the same microtask chain; frames injected
  // before it would land in the pre-prompt queue and be cleared.
  await waitFor(() => sentFrames(h.transport).filter(frame => frame.method === 'session/prompt').length === 2, 2_000)
  return { run1, run2, written1, written2 }
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const finishPrompts = async (h: Harness) => {
  await answerEach(h, method => (method === 'session/prompt' ? { result: { stopReason: 'end_turn' } } : undefined))
}

describe('一条连接上的两个会话', () => {
  it('帧只到达它的会话：正文、回执与信标各归各的', async () => {
    const h = harness()
    const { agent, s1, s2 } = await h.openTwo()
    try {
      const { run1, run2 } = await openBoth(h, s1, s2)

      h.transport.receive(update('ext-1', '只属于会话一'))
      h.transport.receive(update('ext-2', '只属于会话二'))
      await flush()

      // 信标：会话二的帧动了会话二的信标，会话一的不动。
      const beacon1 = s1.diagnostics().lastFrameAt
      await waitFor(() => false, 5) // 让 Date.now() 至少前进一格
      h.transport.receive(update('ext-2', '再一条会话二的帧'))
      await flush()
      expect(s2.diagnostics().lastFrameAt).toBeGreaterThan(beacon1)

      const beacon1After = s1.diagnostics().lastFrameAt
      const beacon2After = s2.diagnostics().lastFrameAt
      // 不带会话 id 的通知广播给每个会话，但不点亮任何人的信标：谁在动只有
      // 带 id 的帧说得清（否则一个全局握手就能让所有会话的超时永不触发）。
      h.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } })
      await flush()
      expect(s1.diagnostics().lastFrameAt).toBe(beacon1After)
      expect(s2.diagnostics().lastFrameAt).toBe(beacon2After)

      await finishPrompts(h)
      const [result1, result2] = await Promise.all([run1, run2])
      const frames1 = JSON.stringify(result1.frames)
      const frames2 = JSON.stringify(result2.frames)
      expect(frames1).toContain('只属于会话一')
      expect(frames1).not.toContain('只属于会话二')
      expect(frames2).toContain('只属于会话二')
      expect(frames2).not.toContain('只属于会话一')
    } finally {
      agent.kill('test over')
    }
  }, 20_000)

  it('子代理首帧先于出生帧到达时，认领后补投给父会话，不串给别人', async () => {
    const h = harness()
    const { agent, s1, s2 } = await h.openTwo()
    try {
      const { run1, run2 } = await openBoth(h, s1, s2)

      // 子会话帧先到（此时还没有人认领 child-1），出生帧后到并认领它。
      h.transport.receive(update('child-1', '子代理先到的正文'))
      h.transport.receive(spawned('ext-1', 'child-1'))
      h.transport.receive(update('child-1', '子代理后到的正文'))
      await flush()

      await finishPrompts(h)
      const [result1, result2] = await Promise.all([run1, run2])
      const frames1 = JSON.stringify(result1.frames)
      expect(frames1).toContain('子代理先到的正文')
      expect(frames1).toContain('子代理后到的正文')
      expect(JSON.stringify(result2.frames)).not.toContain('子代理')
    } finally {
      agent.kill('test over')
    }
  }, 20_000)

  it('终端输出按 terminal/create 上写明的会话投递，不落进另一个会话的工具卡', async () => {
    const h = harness()
    const { agent, s1, s2 } = await h.openTwo()
    try {
      const { run1, run2, written1, written2 } = await openBoth(h, s1, s2)

      // 两个会话各有一张开着的终端命令卡：若输出按「最后注册的处理器」投递，
      // 会话一的输出会写进会话二的卡片。
      h.transport.receive(toolCall('ext-1', 'call-1', 'printf one'))
      h.transport.receive(toolCall('ext-2', 'call-2', 'printf two'))
      await flush()

      h.transport.receive({
        jsonrpc: '2.0', id: 900, method: 'terminal/create',
        params: { sessionId: 'ext-1', command: 'printf routed', cwd: '/tmp' },
      })
      await waitFor(() => written1.join('').includes('routed') || written2.join('').includes('routed'), 3_000)

      expect(written1.join('')).toContain('routed')
      expect(written2.join('')).not.toContain('routed')

      const created = sentFrames(h.transport).find(frame => frame.id === 900)
      const terminalId = (created?.result as { terminalId?: string } | undefined)?.terminalId
      if (terminalId !== undefined) {
        h.transport.receive({ jsonrpc: '2.0', id: 901, method: 'terminal/release', params: { sessionId: 'ext-1', terminalId } })
        await flush()
      }

      await finishPrompts(h)
      await Promise.all([run1, run2])
    } finally {
      agent.kill('test over')
    }
  }, 20_000)

  it('共享连接上也按会话读日志进度：grok 压缩只有它的会话看得见', async () => {
    const home = mkdtempSync(join(tmpdir(), 'threadharbor-grok-shared-'))
    const previous = process.env['GROK_HOME']
    process.env['GROK_HOME'] = home
    const h = harness()
    const { agent, s1, s2 } = await h.openTwo()
    try {
      const { run1, run2 } = await openBoth(h, s1, s2)
      await finishPrompts(h)
      await Promise.all([run1, run2])

      // 会话一自己的 updates.jsonl 记了一次自动压缩；会话二没有日志。
      const dir = join(home, 'sessions', 'proj', 'ext-1')
      mkdirSync(dir, { recursive: true })
      const nowSeconds = Math.floor(Date.now() / 1000)
      writeFileSync(join(dir, 'updates.jsonl'), `${JSON.stringify({
        timestamp: nowSeconds,
        params: { update: { sessionUpdate: 'auto_compact_started', tokens_used: 238_000, context_window: 256_000, percentage: 93 } },
      })}\n`)

      const reading = s1.diagnostics().progress?.()
      expect(reading?.label).toContain('压缩')
      expect(s2.diagnostics().progress?.()).toBeUndefined()
    } finally {
      agent.kill('test over')
      if (previous === undefined) delete process.env['GROK_HOME']
      else process.env['GROK_HOME'] = previous
    }
  }, 20_000)

  it('journaled 会话在共享连接上走 session/resume，不另开新会话', async () => {
    const h = harness()
    const agent = await makeSessionFactory(CONFIG, {
      answerPermission: async () => ({ outcome: 'allow' }),
      transport: () => h.transport,
    }).openShared('acp-grok')
    try {
      const session = await agent.openSession({
        dshSessionId: 'd1', cwd: '/p1', dialect: grokDialect, resumeOf: () => 'journaled-1',
      })
      const run = session.run(decision, turnOf('d1', []) as never)
      await answerEach(h, (method, params) => {
        if (method === 'initialize') return { result: {} }
        if (method === 'session/resume') return { result: { sessionId: params['sessionId'] } }
        if (method === 'session/prompt') return { result: { stopReason: 'end_turn' } }
        return undefined
      })
      await run

      const methods = sentFrames(h.transport).map(frame => frame.method)
      expect(methods).toContain('session/resume')
      expect(methods).not.toContain('session/new')
      const prompt = sentFrames(h.transport).find(frame => frame.method === 'session/prompt')
      expect((prompt?.params as { sessionId?: string } | undefined)?.sessionId).toBe('journaled-1')
    } finally {
      agent.kill('test over')
    }
  }, 20_000)
})
