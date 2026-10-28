/**
 * The gateway: a foreign session's model request answered in place by an
 * external agent, its answer surfacing as the native loop's own chunk stream.
 *
 * The load-bearing properties:
 *
 * - one external conversation per DSH session, opened once, primed once, then
 *   fed only increments — feeding the whole derived history again would make
 *   the agent argue with its own transcript;
 * - the chunk order the loop assembles messages from: block-start, deltas,
 *   block-end, and only then the finish that closes the response;
 * - prompts on one session serialize; two answers never interleave;
 * - the cursor advances when a prompt is delivered, so a failed turn does not
 *   re-feed the user text the external agent already received; a question
 *   never sent (failed open) is still asked in full next time.
 */

import { describe, expect, it, vi } from 'vitest'
import { GatewayConversations, GatewayChunkStream } from '../src/gateway.ts'
import type { AcpSession } from '../src/registry.ts'
import type { RunnerOptions } from '../src/runner.ts'
import type { GatewayChunk, GatewayStepEnd } from '../src/gateway.ts'

const user = (text: string) => ({
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
  id: `u-${text}`,
})
const assistant = (text: string) => ({
  role: 'assistant',
  source: { kind: 'model', provider: 'deepseek', model: 'chat' },
  content: [{ type: 'text', text }],
  id: `a-${text}`,
})
const injected = (text: string, kind = 'agent-instructions') => ({
  role: 'user',
  source: { kind },
  content: [{ type: 'text', text }],
  id: `i-${kind}-${text}`,
})
const tool = (text: string) => ({
  role: 'tool',
  source: { kind: 'tool', callId: 'c1' },
  content: [{ type: 'text', text }],
  id: 't-1',
})
const picture = { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], id: 'u-picture' }
const position = { turn: 1, step: 1 }

/** A session-log append, recording what the gateway asked the session to record. */
function recordingAppend(): {
  readonly written: { type: string; payload: unknown; intent: unknown }[]
  (type: string, payload: unknown, intent?: unknown): { seq: number }
} {
  const written: { type: string; payload: unknown; intent: unknown }[] = []
  const append = (type: string, payload: unknown, intent?: unknown) => {
    written.push({ type, payload, intent })
    return { seq: written.length }
  }
  return Object.assign(append, { written })
}

/**
 * The complete v4 admission contract for one gateway-written system/message row.
 *
 * Mirrored from the host's own checks, all of which run when the session is
 * next opened — a row that passes append but fails any of these makes the
 * whole session unloadable (`stored log is corrupt`). Sources, verified
 * against reference/deepseek-harness:
 * - `session-format-v3-to-v4/src/system-message.ts` `assertV4SystemMessageFields`:
 *   positive turn/step, nonempty id, role 'system', content blocks;
 * - `session-format-v3-to-v4/src/message-sources.ts` `assertV4MessageSources`:
 *   every durable message carries `source` with a nonempty kind that is not
 *   the retired 'plugin' wrapper (2026-10-18 session b60d6fa4, third strike);
 * - `session-format-v3-to-v4/src/relationships.ts` `foldSurface`: the append
 *   carries a surface intent.
 */
function expectV4SystemNote(
  row: { type: string; payload: unknown; intent: unknown } | undefined,
  at: { turn: number; step: number },
): void {
  expect(row).toBeDefined()
  expect(row?.type).toBe('system/message')
  expect(row?.intent).toMatchObject({ surfaceOp: 'append' })
  const data = row?.payload as { turn?: unknown; step?: unknown; message?: Record<string, unknown> }
  expect(data.turn).toBe(at.turn)
  expect(data.step).toBe(at.step)
  const message = data.message
  expect(typeof message?.id).toBe('string')
  expect((message?.id as string).length).toBeGreaterThan(0)
  expect(message?.role).toBe('system')
  expect(Array.isArray(message?.content)).toBe(true)
  for (const block of message?.content as { type?: unknown; text?: unknown }[]) {
    expect(typeof block.type).toBe('string')
    if (block.type === 'text') expect(typeof block.text).toBe('string')
  }
  const source = message?.source as { kind?: unknown } | undefined
  expect(source).toBeDefined()
  // 落盘层对 system/message 的 source 有专用规则：kind 必须恰好是
  // 'system-prompt'（reference/deepseek-harness packages/core/session/src/index.ts:363-366
  // 「message must have system-prompt source」）。会话加载时校验，写错一次整份
  // 日志就永久加载不了——session-3575e031 的 seq 203 就是这么坏的。
  expect(source).toEqual({ kind: 'system-prompt' })
}

/**
 * A session stand-in: records each run's turn context, and answers through
 * whatever the turn's openStream handed back — the same handle production
 * uses, so emitted deltas reach the real chunk stream under test.
 */
function fakeSession() {
  const seen: {
    prompt: string
    primer: string | undefined
    modelId: string | undefined
    reasoningEffort: string | undefined
    signal: AbortSignal | undefined
    positionTurn: number | undefined
    open: () => (GatewayChunkStream | undefined)
  }[] = []
  type Turnish = {
    openStream?: () => { textDelta(t: string): void; reasoningDelta(t: string): void } | undefined
    modelId?: string
    reasoningEffort?: string
    abort?: () => AbortSignal | undefined
    write?: (events: readonly { type: string; payload: unknown }[]) => number | undefined
    position?: { turn: number; step: number }
    promptDelivered?: () => void
  }
  let reply: (turn: Turnish) => Promise<GatewayStepEnd> = async () => ({ kind: 'completed' })
  // 生产里的 runner 每次 run 都从 options.primer 取一次移交文本；桩也一样，
  // 否则「开场失败后重开是否重新 prime」根本无从断言。
  let primerSeam: { take(sessionId: string): string | undefined } | undefined
  // 提示是否真的交到传输层。真机里 applyModel 失败时 request 不会发出，
  // promptDelivered 也就不该响——用这个开关模拟「送之前就失败」。
  let deliver = true
  const closes = { count: 0 }
  // 默认「帧一直新鲜」：旧的活轮次用例靠流口/工具写重置期限，不被帧轮询干扰。
  const diagnosticsState = {
    lastFrameAt: Date.now(),
    lastDiagnosticAt: Date.now(),
    stderrTail: [] as string[],
    // 外部 agent 自己的委托运行还开着几个：0 = 没有子代理在跑。
    liveDelegatedRuns: 0,
    // 最后上报的 agent 状态；缺省表示这个桩没收到过状态帧。
    lastStatus: undefined as { key: string; label: string; working: boolean; notable: boolean; at: number } | undefined,
    // 日志层进度读数；缺省表示这层信号不可用（帧静默就是真静默）。
    progress: undefined as (() => { at: number; key: string; label: string } | undefined) | undefined,
  }
  const endResult = (end: GatewayStepEnd) => ({ frames: [], end })
  const session: AcpSession = {
    run: async (decision: { messages?: unknown }, turn: unknown) => {
      const t = turn as unknown as Turnish
      const primer = primerSeam?.take('s1')
      if (deliver) t.promptDelivered?.()
      seen.push({
        prompt: JSON.stringify(decision.messages),
        primer,
        positionTurn: (turn as unknown as { position?: { turn?: number } }).position?.turn,
        modelId: t.modelId,
        reasoningEffort: t.reasoningEffort,
        signal: t.abort?.(),
        open: () => {
          const handle = t.openStream?.()
          return handle === undefined ? undefined : (handle as unknown as GatewayChunkStream)
        },
      })
      return endResult(await reply(t)) as never
    },
    close: () => { closes.count += 1 },
    onDead: () => {},
    diagnostics: () => ({
      lastFrameAt: diagnosticsState.lastFrameAt,
      lastDiagnosticAt: diagnosticsState.lastDiagnosticAt,
      stderrTail: [...diagnosticsState.stderrTail],
      liveDelegatedRuns: diagnosticsState.liveDelegatedRuns,
      ...(diagnosticsState.lastStatus === undefined ? {} : { lastStatus: diagnosticsState.lastStatus }),
      ...(diagnosticsState.progress === undefined ? {} : { progress: () => diagnosticsState.progress!() }),
    }),
  } as unknown as AcpSession
  return {
    session,
    seen,
    closes,
    diagnosticsState,
    answerWith(next: (turn: Turnish) => Promise<GatewayStepEnd>) { reply = next },
    usePrimer(seam: { take(sessionId: string): string | undefined } | undefined) { primerSeam = seam },
    setDeliver(value: boolean) { deliver = value },
  }
}

describe('GatewayChunkStream — the native loop’s chunk vocabulary', () => {
  it('orders a text block as start, deltas, end, and finishes after', () => {
    const chunks: GatewayChunk[] = []
    const stream = new GatewayChunkStream({ chunk: c => { chunks.push(c) } })
    const port = stream.port()
    port.textDelta('你好')
    port.textDelta('！')
    stream.finish({ kind: 'completed' })
    expect(chunks.map(c => c.type)).toEqual(['block-start', 'text-delta', 'text-delta', 'block-end', 'finish'])
    expect(chunks[0]).toMatchObject({ index: 0, blockType: 'text' })
    expect(chunks[3]).toMatchObject({ block: { type: 'text', text: '你好！' } })
    expect(chunks[4]).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('gives reasoning its own block before the text block', () => {
    const chunks: GatewayChunk[] = []
    const stream = new GatewayChunkStream({ chunk: c => { chunks.push(c) } })
    const port = stream.port()
    port.reasoningDelta('思考')
    port.textDelta('答')
    stream.finish({ kind: 'completed' })
    expect(chunks.filter(c => c.type === 'block-start').map(c => c.blockType)).toEqual(['reasoning', 'text'])
    expect(chunks.filter(c => c.type === 'block-end').map(c => 'block' in c ? c.block.type : '')).toEqual(['reasoning', 'text'])
  })

  it('numbers interleaved blocks 0,1,2 as the kinds switch', () => {
    const chunks: GatewayChunk[] = []
    const stream = new GatewayChunkStream({ chunk: c => { chunks.push(c) } })
    const port = stream.port()
    port.reasoningDelta('思')
    port.textDelta('答')
    port.reasoningDelta('再想')

    // 换向即开新块：回到思考取下一个号，而不是回到它最早那块——
    // 按类占槽会把这个 mid-turn 的思考按 index 折回正文上方。
    const starts = chunks.filter(c => c.type === 'block-start')
    expect(starts.map(c => c.index)).toEqual([0, 1, 2])
    expect(starts.map(c => c.blockType)).toEqual(['reasoning', 'text', 'reasoning'])
  })

  it('emits block-start once per switch, then closes every block in order at finish', () => {
    const chunks: GatewayChunk[] = []
    const stream = new GatewayChunkStream({ chunk: c => { chunks.push(c) } })
    const port = stream.port()
    port.textDelta('你')
    port.textDelta('好')
    port.reasoningDelta('思')
    port.reasoningDelta('考')
    stream.finish({ kind: 'completed' })

    // 同类连续增量续写当前块：block-start 只在换向处出现，一次。
    const starts = chunks.filter(c => c.type === 'block-start')
    expect(starts.map(c => c.index)).toEqual([0, 1])
    expect(starts.map(c => c.blockType)).toEqual(['text', 'reasoning'])
    const deltas = chunks.filter(c => c.type === 'text-delta' || c.type === 'reasoning-delta')
    expect(deltas.map(c => c.index)).toEqual([0, 0, 1, 1])
    // finish 按块序收尾，同类增量并成一整段。
    expect(chunks.filter(c => c.type === 'block-end').map(c => 'block' in c ? c.block : undefined)).toEqual([
      { type: 'text', text: '你好' },
      { type: 'reasoning', text: '思考' },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('maps the step endings onto finish reasons', () => {
    for (const [end, reason] of [
      [{ kind: 'completed' }, { kind: 'stop' }],
      [{ kind: 'max-tokens' }, { kind: 'max-tokens' }],
      [{ kind: 'aborted', reason: 'stopped' }, { kind: 'aborted' }],
      [{ kind: 'error', error: { message: 'nope', code: 'X' } }, { kind: 'error' }],
    ] as const) {
      const chunks: GatewayChunk[] = []
      const stream = new GatewayChunkStream({ chunk: c => { chunks.push(c) } })
      stream.finish(end as GatewayStepEnd)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason })
    }
  })

  // The native loop rebuilds a terminal failure as `new LlmError(message, code)`
  // (reference agent-loop), and that constructor refuses an empty code. A finish
  // chunk whose failure omits the code therefore fails the turn with
  // "LlmError code must be a non-empty string" instead of the agent's own words.
  it('carries a non-empty code on every failing finish reason', () => {
    for (const end of [
      { kind: 'error', error: { message: 'agent died', code: 'ACP_CONNECTION' } },
      { kind: 'error', error: { message: 'agent died' } },
      { kind: 'error' },
      { kind: 'blocked', reason: 'waiting on the user' },
      { kind: 'agent-switch/handover', target: 'acp-cursor', sessionId: 's2', note: 'moved' },
      { kind: 'aborted', reason: 'stopped' },
      { kind: 'aborted' },
    ] as GatewayStepEnd[]) {
      const chunks: GatewayChunk[] = []
      const stream = new GatewayChunkStream({ chunk: c => { chunks.push(c) } })
      stream.finish(end)
      const finish = chunks.at(-1)
      expect(finish).toMatchObject({ type: 'finish' })
      const reason = (finish as { reason: { kind: string; failure?: { message: string; code?: string } } }).reason
      expect(reason.kind === 'error' || reason.kind === 'aborted').toBe(true)
      expect(typeof reason.failure?.message === 'string' && reason.failure.message.length > 0).toBe(true)
      expect(typeof reason.failure?.code === 'string' && reason.failure.code.length > 0).toBe(true)
    }
  })

  it('passes the runner\'s own code through, so the row keeps its diagnosis', () => {
    const chunks: GatewayChunk[] = []
    const stream = new GatewayChunkStream({ chunk: c => { chunks.push(c) } })
    stream.finish({ kind: 'error', error: { message: '外部 agent 连接已断开：acp agent could not run', code: 'ACP_CONNECTION' } })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: '外部 agent 连接已断开：acp agent could not run', code: 'ACP_CONNECTION' } },
    })
  })
})

describe('GatewayConversations — one external conversation per session', () => {
  it('streams the answer and finishes, priming the first request', async () => {
    const fake = fakeSession()
    fake.answerWith(async turn => {
      const s = turn.openStream?.()
      s?.textDelta('回')
      return { kind: 'completed' }
    })
    const opens: string[] = []
    const gate = new GatewayConversations(async (presetId, options) => {
      opens.push(presetId)
      void (options as RunnerOptions)
      return fake.session
    })
    const chunks: GatewayChunk[] = []
    await gate.answer('s1', 'acp-codex', {
      messages: [user('第一问'), assistant('第一答'), user('第二问')],
      position,
    }, { chunk: c => { chunks.push(c) } })
    expect(opens).toEqual(['acp-codex'])
    expect(fake.seen.length).toBe(1)
    expect(fake.seen[0]?.prompt).toContain('第二问')
    expect(chunks.map(c => c.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
  })

  it('把外部 agent 的工具卡片写进会话，助手消息仍留给原生循环写', async () => {
    // 这条路的写入端曾经是空实现，于是外部 agent 跑过的命令在会话里一点痕迹
    // 都没有——回答在，过程不在。工具事件是 log-only，不在原生循环拼消息用的
    // 那套流词汇里，所以没有别人会替它写。而助手消息恰恰是循环的：再写一份
    // 同一步的消息，界面上只会留下最后一份，把循环刚写的抹掉。
    const append = recordingAppend()
    const written = append.written
    const fake = fakeSession()
    fake.answerWith(async turn => {
      // 首帧到达即写调用（runner 的实时卡片），回合末再写结果与正文。
      turn.write?.([{ type: 'tool/call', payload: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{}' } }])
      turn.write?.([
        { type: 'tool/result', payload: { turn: 0, step: 0, message: { role: 'tool', content: [{ type: 'text', text: 'ok' }], toolCallId: 'c1' } } },
        { type: 'assistant/message', payload: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
      ])
      return { kind: 'completed' }
    })
    const gate = new GatewayConversations(
      async () => fake.session,
      () => {},
      sessionId => (sessionId === 's1' ? append : undefined),
      undefined,
      undefined,
      // 实时卡只有配上回合末投影器才允许落盘：结果只能从 produce 的投影来，
      // 没有投影器的卡注定在 step/end 处悬空（见「没有回合末投影器就不写实时卡」）。
      () => (_result: unknown, _at: { turn: number; step: number }) => [],
    )
    await gate.answer('s1', 'acp-codex', { messages: [user('跑个命令')], position }, { chunk: () => {} })

    expect(written.map(entry => entry.type)).toEqual(['tool/call', 'tool/result'])
    // 结果必须指回它回答的那次调用，否则它在会话里是个无主的孤儿。
    const result = written[1]
    expect(result?.intent).toEqual({ surfaceOp: 'append', sourceEventSeqs: [1] })
  })

  it('工具事件按会话真实开着的轮次步数写，不拿 0/0 占位', async () => {
    // 会话日志会按编号校验：tool/call 的 turn/step 必须对上当时开着的那个
    // （session-format 的 requireStep）。0/0 在实时界面上看不出来——界面靠事件
    // 落在哪两个边界之间定位，不看事件自带的编号——但打开会话时才校验，那时
    // 整份日志已经打不开了。所以编号必须是会话真实开着的那一对。
    const append = recordingAppend()
    const fake = fakeSession()
    fake.answerWith(async turn => {
      turn.write?.([{
        type: 'tool/call',
        payload: { turn: turn.position?.turn, step: turn.position?.step, callId: 'c1', name: 'bash', arguments: '{}' },
      }])
      return { kind: 'completed' }
    })
    const gate = new GatewayConversations(
      async () => fake.session,
      () => {},
      sessionId => (sessionId === 's1' ? append : undefined),
      sessionId => (sessionId === 's1' ? { turn: 11, step: 1 } : undefined),
      undefined,
      () => (_result: unknown, _at: { turn: number; step: number }) => [],
    )
    await gate.answer('s1', 'acp-codex', { messages: [user('跑个命令')], position }, { chunk: () => {} })

    expect((append.written[0]?.payload as { turn: number; step: number }).turn).toBe(11)
    expect((append.written[0]?.payload as { turn: number; step: number }).step).toBe(1)
  })

  it('拿不到会话当前位置时宁可不写工具事件，也不写占位编号', async () => {
    // 这是那份日志变砖的直接原因：占位 0/0 看着无害，落盘之后整个会话再也
    // 打不开。回答本身不依赖编号——那是循环的活——所以这里牺牲卡片可见性
    // 换日志可用性，并把这件事说出口，而不是静默写坏。
    const append = recordingAppend()
    const fake = fakeSession()
    fake.answerWith(async turn => {
      turn.write?.([{ type: 'tool/call', payload: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{}' } }])
      return { kind: 'completed' }
    })
    const reports: string[] = []
    const chunks: GatewayChunk[] = []
    const gate = new GatewayConversations(
      async () => fake.session,
      message => { reports.push(message) },
      sessionId => (sessionId === 's1' ? append : undefined),
    )
    await gate.answer('s1', 'acp-codex', { messages: [user('跑个命令')] }, { chunk: c => { chunks.push(c) } })

    expect(append.written).toEqual([])
    expect(reports.some(message => message.includes('no open turn/step'))).toBe(true)
    // 回答照常送达：外部 agent 干完活，结果还是回到会话里。
    expect(chunks.map(c => c.type)).toEqual(['finish'])
  })

  it('会话写入端拿不到时照常作答，只是卡片无处可去', async () => {
    // 没有会话服务的主机上这一路必须照走——把「看不到卡片」变成「整个回合崩掉」
    // 是拿可见性换可用性。
    const fake = fakeSession()
    fake.answerWith(async turn => {
      turn.write?.([{ type: 'tool/call', payload: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{}' } }])
      return { kind: 'completed' }
    })
    const chunks: GatewayChunk[] = []
    const gate = new GatewayConversations(async () => fake.session)
    await gate.answer('s1', 'acp-codex', { messages: [user('跑个命令')], position }, { chunk: c => { chunks.push(c) } })
    expect(chunks.map(c => c.type)).toEqual(['finish'])
  })

  it('reuses the open conversation and feeds only the increment', async () => {
    const fake = fakeSession()
    let opened = 0
    const gate = new GatewayConversations(async () => { opened += 1; return fake.session })
    const sink = { chunk: () => {} }
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问')], position }, sink)
    await gate.answer('s1', 'acp-codex', {
      messages: [user('第一问'), assistant('第一答'), user('第二问')],
      position,
    }, sink)
    expect(opened).toBe(1)
    expect(fake.seen[1]?.prompt).toContain('第二问')
    expect(fake.seen[1]?.prompt).not.toContain('第一问')
  })

  it('续聊只送新增的人类输入：巨型工具结果与注入上下文永不重发', async () => {
    // 2026-10-27 session 8b518c00 的实际形状：第一轮一次 bash 产出 104 万
    // 字符的结果，第二问只有 122 字符，网关却把工具结果、注入上下文和助手
    // 回复一起拼进入，1,221,980 字符超过 codex 的 1,048,576 上限。
    const fake = fakeSession()
    const gate = new GatewayConversations(async () => fake.session)
    const sink = { chunk: () => {} }
    const first = user('看看这个仓库')
    await gate.answer('s1', 'acp-codex', { messages: [first], position }, sink)
    const second = user('继续修')
    await gate.answer('s1', 'acp-codex', {
      messages: [
        first,
        injected('宿主指令'.repeat(200), 'agent-instructions'),
        injected('运行上下文'.repeat(200), 'runtime-context'),
        tool('工具输出'.repeat(100_000)),
        assistant('看完了'),
        second,
      ],
      position,
    }, sink)
    const sent = fake.seen[1]?.prompt ?? ''
    expect(sent).toContain('继续修')
    expect(sent).not.toContain('宿主指令')
    expect(sent).not.toContain('运行上下文')
    expect(sent).not.toContain('工具输出')
    expect(sent).not.toContain('看完了')
    expect(sent.length).toBeLessThan(1_000)
  })

  it('续聊带上附件块，不把图片当成纯文本丢掉', async () => {
    const fake = fakeSession()
    const gate = new GatewayConversations(async () => fake.session)
    const sink = { chunk: () => {} }
    const first = user('先看一眼')
    await gate.answer('s1', 'acp-codex', { messages: [first], position }, sink)
    await gate.answer('s1', 'acp-codex', {
      messages: [first, assistant('好'), picture],
      position,
    }, sink)
    const sent = fake.seen[1]?.prompt ?? ''
    expect(sent).toContain('"type":"image"')
    expect(sent).toContain('aGVsbG8=')
  })

  it('续聊诊断只记模式、条数与长度，不记正文', async () => {
    const reports: string[] = []
    const fake = fakeSession()
    const gate = new GatewayConversations(async () => fake.session, message => { reports.push(message) })
    const sink = { chunk: () => {} }
    const first = user('第一问')
    await gate.answer('s1', 'acp-codex', { messages: [first], position }, sink)
    const secret = '只该出现在提示里的新问题'
    await gate.answer('s1', 'acp-codex', {
      messages: [first, assistant('第一答'), tool('工具正文'.repeat(50)), user(secret)],
      position,
    }, sink)
    const line = reports.find(message => message.includes('feed=next')) ?? ''
    expect(line).toContain('human=1')
    expect(line).toContain('assistant=1')
    expect(line).toContain('tool=1')
    expect(line).toContain(`prompt=${String(secret.length)}ch`)
    expect(line).toContain('cursor=0->3')
    expect(line).toContain('delivered')
    expect(line).not.toContain(secret)
    expect(line).not.toContain('工具正文')
    expect(reports.some(message => message.includes('feed=first'))).toBe(true)
  })

  it('passes the model and effort through for the agent to attach', async () => {
    const fake = fakeSession()
    const gate = new GatewayConversations(async () => fake.session)
    await gate.answer('s1', 'acp-codex', {
      messages: [user('问')],
      position,
      modelId: 'gpt-6-astra',
      reasoningEffort: 'high',
    }, { chunk: () => {} })
    expect(fake.seen[0]?.modelId).toBe('gpt-6-astra')
    expect(fake.seen[0]?.reasoningEffort).toBe('high')
    expect(fake.seen[0]?.positionTurn).toBe(position.turn)
  })

  it('answers without a position instead of crashing the runner on undefined', async () => {
    // Regression: the runner reads position.turn for its card bookkeeping, and
    // the first shipped wire omitted position entirely — the turn died as
    // "Cannot read properties of undefined (reading 'turn')". It still must not
    // die. What it may not do is invent a number: the zero placeholder this
    // test used to pin is exactly what wrote a session log that never opens
    // again. No position means no tool events and an answer that still lands.
    const fake = fakeSession()
    const gate = new GatewayConversations(async () => fake.session)
    const chunks: GatewayChunk[] = []
    await gate.answer('s1', 'acp-codex', {
      messages: [user('问')],
    } as unknown as Parameters<GatewayConversations['answer']>[2], { chunk: c => { chunks.push(c) } })
    expect(fake.seen[0]?.positionTurn).toBeUndefined()
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('提示没送出就失败：游标不前进，重试仍从第一问开始', async () => {
    // 送达的定义是提示真的交给了传输层。开场成功但选型/发送前就失败时，
    // 外部会话里一个字都没有——游标必须留在原地，下一问重新 prime 全量，
    // 否则第一问会永久丢失。
    const fake = fakeSession()
    let opened = 0
    const gate = new GatewayConversations(async (_presetId, options) => {
      opened += 1
      fake.usePrimer(options.primer)
      return fake.session
    })
    fake.setDeliver(false)
    fake.answerWith(async () => ({ kind: 'error', error: { message: 'model application refused' } }))
    const sink = { chunk: () => {} }
    const chunks: GatewayChunk[] = []
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问')], position }, { chunk: c => { chunks.push(c) } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })

    fake.setDeliver(true)
    fake.answerWith(async () => ({ kind: 'completed' }))
    await gate.answer('s1', 'acp-codex', {
      messages: [user('第一问'), user('再试一次')],
      position,
    }, sink)
    expect(opened).toBe(1)
    expect(fake.seen[1]?.primer).toContain('第一问')
    expect(fake.seen[1]?.prompt).toContain('再试一次')
    expect(fake.seen[1]?.prompt).not.toContain('第一问')
  })

  it('serializes concurrent answers on one session', async () => {
    const fake = fakeSession()
    const running: string[] = []
    fake.answerWith(async () => {
      running.push('in')
      await new Promise(resolve => { setTimeout(resolve, 10) })
      running.push('out')
      return { kind: 'completed' }
    })
    const gate = new GatewayConversations(async () => fake.session)
    await Promise.all([
      gate.answer('s1', 'acp-codex', { messages: [user('甲')], position }, { chunk: () => {} }),
      gate.answer('s1', 'acp-codex', { messages: [user('甲'), user('乙')], position }, { chunk: () => {} }),
    ])
    expect(running).toEqual(['in', 'out', 'in', 'out'])
  })

  it('refuses to ask when nothing new arrived', async () => {
    let opened = 0
    const gate = new GatewayConversations(async () => { opened += 1; return fakeSession().session })
    await expect(gate.answer('s1', 'acp-codex', {
      messages: [user('第一问'), assistant('第一答')],
      position,
    }, { chunk: () => {} })).rejects.toThrow(/acp gateway/)
    expect(opened).toBe(0)
  })

  it('closes the conversation and starts over on the next answer', async () => {
    const fake = fakeSession()
    let closed = 0
    const gate = new GatewayConversations(async () => fake.session)
    fake.session.close = () => { closed += 1 }
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问')], position }, { chunk: () => {} })
    gate.close('s1')
    expect(closed).toBe(1)
    await gate.answer('s1', 'acp-codex', { messages: [user('新的一问')], position }, { chunk: () => {} })
    // The second open is a first request again: the cursor reset with the handle.
    expect(fake.seen.length).toBe(2)
    expect(fake.seen[1]?.prompt).toContain('新的一问')
  })

  it('连接类失败自动丢弃会话：下一问开新的外部会话，不再复用卡死的连接', async () => {
    // ACP_CONNECTION 的错误文案向用户承诺「下一次会自动连接新的外部会话」。
    // 握手 60 秒超时（2026-10-16 会话 f60dcf2b，三轮同错）或进程中途死亡都
    // 报这一类。网关曾把 entry 留在表里——重试复用同一个卡死的子进程，每次
    // 都再等满 60 秒，直到重启 dsh 才解脱。这里把承诺兑现：连接类失败即丢
    // 弃 entry（close 连带杀子进程），下一问重新 open、重新握手。
    const first = fakeSession()
    let firstClosed = 0
    first.session.close = () => { firstClosed += 1 }
    const second = fakeSession()
    const opened: AcpSession[] = []
    const gate = new GatewayConversations(async () => {
      const session = opened.length === 0 ? first.session : second.session
      opened.push(session)
      return session
    })
    first.answerWith(async () => ({
      kind: 'error',
      error: { code: 'ACP_CONNECTION', message: '外部 agent 连接已断开：acp agent did not answer within 60000ms' },
    }))
    second.answerWith(async turn => {
      turn.openStream?.()?.textDelta('好了')
      return { kind: 'completed' }
    })
    const failed: GatewayChunk[] = []
    await gate.answer('s1', 'acp-cursor', { messages: [user('hello')], position }, { chunk: c => { failed.push(c) } })
    expect(failed.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(opened).toHaveLength(1)
    const retried: GatewayChunk[] = []
    await gate.answer('s1', 'acp-cursor', { messages: [user('hello')], position }, { chunk: c => { retried.push(c) } })
    expect(opened).toHaveLength(2)
    expect(firstClosed).toBe(1)
    expect(retried.map(c => c.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
  })

  it('closeAll 逐个关闭外部会话：下一次回答重新开场', async () => {
    // 进程退出时的收尾入口：close 连带杀掉子进程，不留孤儿在外空转。
    const fake = fakeSession()
    let closes = 0
    fake.session.close = () => { closes += 1 }
    const opened: AcpSession[] = []
    const gate = new GatewayConversations(async () => {
      opened.push(fake.session)
      return fake.session
    })
    fake.answerWith(async () => ({ kind: 'completed' }))
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问')], position }, { chunk: () => {} })
    gate.closeAll()
    expect(closes).toBe(1)
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问'), user('第二问')], position }, { chunk: () => {} })
    expect(opened).toHaveLength(2)
  })

  it('非连接类失败保留外部会话：agent 自己报的错重试时继续同一场对话', async () => {
    // ACP_ERROR 是 agent 应答里的错误（模型过载之类）——进程和会话都还活着，
    // 重试继续原对话才是对的；只有连接断了才值得付重新 prime 全部历史的代价。
    const fake = fakeSession()
    const opened: AcpSession[] = []
    const gate = new GatewayConversations(async () => {
      opened.push(fake.session)
      return fake.session
    })
    fake.answerWith(async () => ({ kind: 'error', error: { code: 'ACP_ERROR', message: 'model overloaded' } }))
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问')], position }, { chunk: () => {} })
    expect(opened).toHaveLength(1)
    fake.answerWith(async () => ({ kind: 'completed' }))
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问'), user('再试')], position }, { chunk: () => {} })
    expect(opened).toHaveLength(1)
    expect(fake.seen.at(-1)?.prompt).toContain('再试')
  })

  it('提示送达即前进：出错回合之后的下一问只带新消息', async () => {
    // 03067bcc 的实际故障形状：第四轮成功（游标前进）、第五轮已送达但以错误
    // 告终、用户重发。旧游标把第五轮的话再打包一遍，外部代理收到同一句话
    // 两次。提示发出去游标就前进——回合再怎么失败，已送达的话不重发。
    const fake = fakeSession()
    const gate = new GatewayConversations(async () => fake.session)
    fake.answerWith(async () => ({ kind: 'completed' }))
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问')], position }, { chunk: () => {} })
    fake.answerWith(async () => ({ kind: 'error', error: { code: 'ACP_ERROR', message: 'model overloaded' } }))
    await gate.answer('s1', 'acp-codex', {
      messages: [user('第一问'), user('可以，按这个方案实施')],
      position,
    }, { chunk: () => {} })
    fake.answerWith(async () => ({ kind: 'completed' }))
    await gate.answer('s1', 'acp-codex', {
      messages: [user('第一问'), user('可以，按这个方案实施'), user('可以，按这个方案实施')],
      position,
    }, { chunk: () => {} })
    const prompt = fake.seen.at(-1)?.prompt ?? ''
    // 一句归一句：第三次请求只携带新一轮的用户文本，出错那轮已送达的不重发。
    // 只数 text 字段——消息 id 里也带同样的字，整串计数会数出两次。
    expect(prompt.match(/"text":"可以，按这个方案实施"/g)).toHaveLength(1)
  })

  it('开场失败不前进：提示从未发出，重试仍从第一问开始', async () => {
    // 送达的定义是 run 已经把提示交给外部会话；连会话都没开起来时游标留在
    // 原地，下一问重新 prime 全量——那是唯一能保证消息不丢的路径。
    const fake = fakeSession()
    fake.answerWith(async () => ({ kind: 'completed' }))
    const primers: (string | undefined)[] = []
    let openFailures = 1
    const gate = new GatewayConversations(async (_presetId, options) => {
      if (openFailures > 0) {
        openFailures -= 1
        throw new Error('handshake timeout')
      }
      const primer = (options as RunnerOptions & {
        primer?: { take(id: string): string | undefined }
      }).primer
      primers.push(primer?.take('s1'))
      return fake.session
    })
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问')] }, { chunk: () => {} }).catch(() => {})
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问'), user('再试')], position }, { chunk: () => {} })
    // 第二次开场带全量 primer：从未发出的第一问必须还在里面（最后一句
    // 「再试」照常作为 prompt 单独送出）。
    expect(primers.at(-1) ?? '').toContain('第一问')
    expect(fake.seen.at(-1)?.prompt).toContain('再试')
  })

  it('rides the primer through the runner seam once per conversation', async () => {
    const seen: { taken?: string } = {}
    const fake = fakeSession()
    const gate = new GatewayConversations(async (_presetId, options) => {
      const primer = (options as RunnerOptions & {
        primer?: { take(id: string): string | undefined; restore(id: string, text: string): void }
      }).primer
      const text = primer?.take('s1')
      if (text !== undefined) seen.taken = text
      return fake.session
    })
    await gate.answer('s1', 'acp-codex', {
      messages: [user('第一问'), assistant('第一答'), user('第二问')],
      position,
    }, { chunk: () => {} })
    expect(seen.taken).toContain('第一问')
    expect(seen.taken).toContain('第一答')
  })

  it('回答超过期限按错误收尾：中止信号发出、报告留痕、下一轮不被卡死', { timeout: 3000 }, async () => {
    const fake = fakeSession()
    // 外部会话永不返回——挂死的后端重试循环就是这个形状。
    fake.answerWith(() => new Promise(() => {}))
    const reports: string[] = []
    const chunks: GatewayChunk[] = []
    const gate = new GatewayConversations(
      async () => fake.session,
      message => { reports.push(message) },
      undefined,
      undefined,
      () => ({ stallMs: 40 }),
    )
    await gate.answer('s1', 'acp-codex', { messages: [user('你好')] }, { chunk: c => { chunks.push(c) } })

    expect(chunks.at(-1)?.type).toBe('finish')
    expect(reports.some(message => message.includes('answer stalled'))).toBe(true)
    // 中止信号必须已经发出：这是让 runner 把取消传给外部会话的唯一通道。
    expect(fake.seen[0]?.signal?.aborted).toBe(true)
    // tail 链必须已结算——下一轮回答照常进行，不能被上一轮的僵尸挂死。
    fake.answerWith(async () => ({ kind: 'completed' }))
    const second: GatewayChunk[] = []
    await gate.answer('s1', 'acp-codex', { messages: [user('你好'), user('再试')] }, { chunk: c => { second.push(c) } })
    expect(second.at(-1)?.type).toBe('finish')
  })

  it('回答期限按预设解析：该预设的值生效，0 表示这个预设不设期限', { timeout: 3000 }, async () => {
    const wedged = fakeSession()
    wedged.answerWith(() => new Promise(() => {}))
    const healthy = fakeSession()
    healthy.answerWith(async () => ({ kind: 'completed' }))
    const reports: string[] = []
    const gate = new GatewayConversations(
      async presetId => (presetId === 'acp-codex' ? wedged.session : healthy.session),
      message => { reports.push(message) },
      undefined,
      undefined,
      presetId => (presetId === 'acp-codex' ? { stallMs: 40 } : { stallMs: 0 }),
    )
    const first: GatewayChunk[] = []
    await gate.answer('s1', 'acp-codex', { messages: [user('你好')] }, { chunk: c => { first.push(c) } })
    expect(first.at(-1)?.type).toBe('finish')
    expect(reports.some(message => message.includes('answer stalled'))).toBe(true)

    // 0 关闭期限：正常回答照旧，不该出现超时报告。
    const second: GatewayChunk[] = []
    await gate.answer('s2', 'acp-grok', { messages: [user('你好')] }, { chunk: c => { second.push(c) } })
    expect(second.map(c => c.type)).toEqual(['finish'])
    expect(reports.filter(message => message.includes('answer stalled'))).toHaveLength(1)
  })

  it('期限是「无活动」期限：持续输出思考的活轮次跑过期限也不死', { timeout: 3000 }, async () => {
    // 2026-10-16 会话 03067bcc：grok 的第 8/11/12 轮全部精确死在 600 秒——
    // 期限曾是「自发问起算的总时长」，活着的长思考轮次被整轮杀掉，用户只好
    // 换 agent。期限的本意是看住挂死后端（一条帧都不再来的那种），所以改为
    // 每收到一段输出就重置：这里 40ms 期限、每 15ms 吐一段、总时长远超 40ms，
    // 轮次应当正常完成且没有任何超时报告。
    const slow = fakeSession()
    slow.answerWith(async turn => {
      const handle = turn.openStream?.()
      for (let index = 0; index < 8; index++) {
        handle?.textDelta(`段${index}`)
        await new Promise(resolve => { setTimeout(resolve, 15) })
      }
      return { kind: 'completed' }
    })
    const reports: string[] = []
    const chunks: GatewayChunk[] = []
    const gate = new GatewayConversations(async () => slow.session, message => { reports.push(message) }, undefined, undefined, () => ({ stallMs: 40 }))
    await gate.answer('s1', 'acp-grok', { messages: [user('慢慢想')], position }, { chunk: c => { chunks.push(c) } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(reports.some(message => message.includes('answer stalled'))).toBe(false)
  })

  it('工具事件同样算活动：只有工具卡片在动、没有文字流的轮次也不死', { timeout: 3000 }, async () => {
    const busy = fakeSession()
    busy.answerWith(async turn => {
      for (let index = 0; index < 8; index++) {
        turn.write?.([{ type: 'tool/call', payload: { callId: `c${index}`, name: 'bash', arguments: '{}' } }])
        await new Promise(resolve => { setTimeout(resolve, 15) })
      }
      return { kind: 'completed' }
    })
    const reports: string[] = []
    const gate = new GatewayConversations(async () => busy.session, message => { reports.push(message) }, undefined, undefined, () => ({ stallMs: 40 }))
    const chunks: GatewayChunk[] = []
    await gate.answer('s1', 'acp-grok', { messages: [user('跑工具')], position }, { chunk: c => { chunks.push(c) } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(reports.some(message => message.includes('answer stalled'))).toBe(false)
  })
})

describe('GatewayConversations — 用户停止立即收场与宽限杀', () => {
  it('停止信号立即以 aborted 收场；宽限后未了结则杀会话，下一请求重开', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      fake.answerWith(() => new Promise<GatewayStepEnd>(() => {}))
      const opens: string[] = []
      const gate = new GatewayConversations(async presetId => { opens.push(presetId); return fake.session })
      const controller = new AbortController()
      const chunks: GatewayChunk[] = []
      const answering = gate.answer('s1', 'acp-codex', {
        messages: [user('卡住的问题')],
        position,
        signal: controller.signal,
      }, { chunk: c => { chunks.push(c) } })
      await vi.advanceTimersByTimeAsync(1)
      controller.abort()
      const outcome = await Promise.race([
        answering.then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(120_000).then(() => 'still-hanging'),
      ])
      expect(outcome).toBe('resolved')
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
      expect(fake.closes.count).toBe(0)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(fake.closes.count).toBe(1)
      fake.answerWith(async () => ({ kind: 'completed' }))
      await gate.answer('s1', 'acp-codex', { messages: [user('再来一问')], position }, { chunk: () => {} })
      expect(opens).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('宽限期内 run 了结：不 close、会话复用', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      let settle: ((end: GatewayStepEnd) => void) | undefined
      fake.answerWith(() => new Promise<GatewayStepEnd>(resolve => { settle = resolve }))
      const opens: string[] = []
      const gate = new GatewayConversations(async presetId => { opens.push(presetId); return fake.session })
      const controller = new AbortController()
      const answering = gate.answer('s1', 'acp-codex', {
        messages: [user('慢慢来')],
        position,
        signal: controller.signal,
      }, { chunk: () => {} })
      await vi.advanceTimersByTimeAsync(1)
      controller.abort()
      await answering
      settle?.({ kind: 'aborted', reason: 'agent accepted the cancel' })
      await vi.advanceTimersByTimeAsync(3_000)
      expect(fake.closes.count).toBe(0)
      fake.answerWith(async () => ({ kind: 'completed' }))
      await gate.answer('s1', 'acp-codex', { messages: [user('慢慢来'), user('接着用')], position }, { chunk: () => {} })
      expect(opens).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('停止先于送达（signal 已中止）：同样立即收场', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      fake.answerWith(() => new Promise<GatewayStepEnd>(() => {}))
      const gate = new GatewayConversations(async () => fake.session)
      const controller = new AbortController()
      controller.abort()
      const chunks: GatewayChunk[] = []
      const outcome = await Promise.race([
        gate.answer('s1', 'acp-codex', {
          messages: [user('立刻停')],
          position,
          signal: controller.signal,
        }, { chunk: c => { chunks.push(c) } }).then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(120_000).then(() => 'still-hanging'),
      ])
      expect(outcome).toBe('resolved')
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('GatewayConversations — 帧静默超时、提示与诊断包', () => {
  const wedgedSetup = (stallMs: number, warnMs: number) => {
    const fake = fakeSession()
    fake.answerWith(() => new Promise<GatewayStepEnd>(() => {}))
    fake.diagnosticsState.lastFrameAt = Date.now()
    fake.diagnosticsState.stderrTail = ['tls handshake eof']
    const append = recordingAppend()
    const reports: string[] = []
    const opens: string[] = []
    const gate = new GatewayConversations(
      async presetId => { opens.push(presetId); return fake.session },
      message => { reports.push(message) },
      sessionId => (sessionId === 's1' ? append : undefined),
      undefined,
      () => ({ stallMs, warnMs, graceMs: 1_000 }),
    )
    return { fake, append, reports, gate, opens }
  }

  it('帧静默达 stallMs：ACP_STALLED 收场，消息带尾部与会话处置，会话被杀', async () => {
    vi.useFakeTimers()
    try {
      const { fake, append, gate, opens } = wedgedSetup(3_000, 0)
      const chunks: GatewayChunk[] = []
      const outcome = await Promise.race([
        gate.answer('s1', 'acp-codex', { messages: [user('卡住')], position }, { chunk: c => { chunks.push(c) } }).then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(10_000).then(() => 'still-hanging'),
      ])
      expect(outcome).toBe('resolved')
      const finish = chunks.at(-1) as { reason: { kind: string; failure?: { code?: string; message?: string } } }
      expect(finish.reason.kind).toBe('error')
      expect(finish.reason.failure?.code).toBe('ACP_STALLED')
      expect(finish.reason.failure?.message).toContain('tls handshake eof')
      expect(finish.reason.failure?.message).toContain('已终止')
      expect(fake.closes.count).toBe(1)
      expect(append.written.filter(w => w.type === 'system/message')).toHaveLength(0)
      // Review Focus 5：丢弃后同会话的下一请求必须重开新外部会话。
      fake.answerWith(async () => ({ kind: 'completed' }))
      await gate.answer('s1', 'acp-codex', { messages: [user('卡住'), user('重试')], position }, { chunk: () => {} })
      expect(opens).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('静默收场带死因：stderr 有 JSON-RPC 错误码时点明进程已崩溃', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      fake.answerWith(() => new Promise<GatewayStepEnd>(() => {}))
      fake.diagnosticsState.lastFrameAt = Date.now()
      // 2026-10-28 qoder 现场：握手抛 -32601，进程出不了帧，看门狗杀掉时要点明「已崩溃」。
      fake.diagnosticsState.stderrTail = [
        'Error handling notification { jsonrpc: \'2.0\', method: \'initialized\', params: {} }',
        '{ code: -32601, message: \'"Method not found": initialized\', data: { method: \'initialized\' } }',
      ]
      const gate = new GatewayConversations(async () => fake.session, undefined, undefined, undefined, () => ({ stallMs: 3_000 }))
      const chunks: GatewayChunk[] = []
      const outcome = await Promise.race([
        gate.answer('s1', 'acp-qoder', { messages: [user('崩了')], position }, { chunk: c => { chunks.push(c) } }).then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(10_000).then(() => 'still-hanging'),
      ])
      expect(outcome).toBe('resolved')
      const finish = chunks.at(-1) as { reason: { kind: string; failure?: { code?: string; message?: string } } }
      expect(finish.reason.failure?.code).toBe('ACP_STALLED')
      expect(finish.reason.failure?.message).toContain('进程疑似已崩溃')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stderr 行不算进展：诊断时间戳持续前移，静默照常触发', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      fake.answerWith(() => new Promise<GatewayStepEnd>(() => {}))
      const start = Date.now()
      fake.diagnosticsState.lastFrameAt = start
      fake.diagnosticsState.stderrTail = ['retrying']
      const gate = new GatewayConversations(async () => fake.session, undefined, undefined, undefined, () => ({ stallMs: 3_000 }))
      const answering = gate.answer('s1', 'acp-codex', { messages: [user('只打日志不给帧')], position }, { chunk: () => {} })
      // 每个轮询拍点把 lastDiagnosticAt 拨到当下——像极了重试循环的周期警告。
      const diagnosticTicker = setInterval(() => { fake.diagnosticsState.lastDiagnosticAt = Date.now() }, 200)
      const outcome = await Promise.race([
        answering.then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(10_000).then(() => 'still-hanging'),
      ])
      clearInterval(diagnosticTicker)
      expect(outcome).toBe('resolved')
    } finally {
      vi.useRealTimers()
    }
  })

  it('帧到达重置静默：中途来帧，收场相应后移', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      fake.answerWith(() => new Promise<GatewayStepEnd>(() => {}))
      const start = Date.now()
      fake.diagnosticsState.lastFrameAt = start
      const gate = new GatewayConversations(async () => fake.session, undefined, undefined, undefined, () => ({ stallMs: 3_000 }))
      const chunks: GatewayChunk[] = []
      const answering = gate.answer('s1', 'acp-codex', { messages: [user('慢但活着')], position }, { chunk: c => { chunks.push(c) } })
      // 1.5s 时来了一帧（诊断打点前移），本该 3s 死的轮次要活到 4.5s 之后。
      setTimeout(() => { fake.diagnosticsState.lastFrameAt = Date.now() }, 1_500)
      const outcome = await Promise.race([
        answering.then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(4_000).then(() => 'survived-4s'),
      ])
      expect(outcome).toBe('survived-4s')
      const finish = chunks.at(-1)
      expect(finish).toBeUndefined()
      const after = await Promise.race([
        answering.then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(2_000).then(() => 'still-hanging'),
      ])
      expect(after).toBe('resolved')
    } finally {
      vi.useRealTimers()
    }
  })

  it('日志层报进度时重计静默期限：压缩上下文不再被当成卡死', async () => {
    // 2026-10-27 的现场：codex 回合中途 auto-compact，四分钟零帧，日志每 30s
    // 一行 compaction；只有帧的看门狗把一条活得正好的回合杀了。日志有读数
    // 就必须重计时，且只提示一次「仍在推进」。
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      fake.answerWith(() => new Promise<GatewayStepEnd>(() => {}))
      fake.diagnosticsState.lastFrameAt = Date.now()
      fake.diagnosticsState.progress = () => ({ at: Date.now(), key: 'compaction', label: 'codex 正在压缩上下文' })
      const append = recordingAppend()
      const gate = new GatewayConversations(
        async () => fake.session,
        undefined,
        sessionId => (sessionId === 's1' ? append : undefined),
        undefined,
        () => ({ stallMs: 8_000, warnMs: 0 }),
      )
      const chunks: GatewayChunk[] = []
      const answering = gate.answer('s1', 'acp-codex', { messages: [user('压缩中')], position }, { chunk: c => { chunks.push(c) } })
      const outcome = await Promise.race([
        answering.then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(10_000).then(() => 'survived-10s'),
      ])
      expect(outcome).toBe('survived-10s')
      const notes = append.written.filter(w => w.type === 'system/message')
      expect(notes).toHaveLength(1)
      expectV4SystemNote(notes[0], position)
      const text = JSON.stringify(notes[0]?.payload)
      expect(text).toContain('仍在推进')
      expect(text).toContain('codex 正在压缩上下文')
      // 日志不再跳之后，静默期限照常收场；消息里带着最后一条日志进展。
      // 上一次读数把期限重挂到了 t=10s+8s，所以要从第 10 秒再走到 18 秒后。
      fake.diagnosticsState.progress = undefined
      const after = await Promise.race([
        answering.then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(9_000).then(() => 'still-hanging'),
      ])
      expect(after).toBe('resolved')
      const finish = chunks.at(-1) as { reason: { kind: string; failure?: { code?: string; message?: string } } }
      expect(finish.reason.kind).toBe('error')
      expect(finish.reason.failure?.code).toBe('ACP_STALLED')
      expect(finish.reason.failure?.message).toContain('日志：codex 正在压缩上下文')
    } finally {
      vi.useRealTimers()
    }
  })

  it('静默收场的消息带上最后上报的 agent 状态', async () => {
    vi.useFakeTimers()
    try {
      const { fake, gate, reports } = wedgedSetup(3_000, 0)
      fake.diagnosticsState.lastStatus = {
        key: 'codex:active:waitingOnApproval',
        label: 'codex 正在处理（等待审批）',
        working: true,
        notable: true,
        at: Date.now(),
      }
      const chunks: GatewayChunk[] = []
      const answering = gate.answer('s1', 'acp-codex', { messages: [user('卡住')], position }, { chunk: c => { chunks.push(c) } })
      const outcome = await Promise.race([
        answering.then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(10_000).then(() => 'still-hanging'),
      ])
      expect(outcome).toBe('resolved')
      const finish = chunks.at(-1) as { reason: { failure?: { code?: string; message?: string } } }
      expect(finish.reason.failure?.code).toBe('ACP_STALLED')
      expect(finish.reason.failure?.message).toContain('codex 正在处理（等待审批）')
      expect(finish.reason.failure?.message).toContain('前上报')
      expect(reports.some(line => line.includes('last state: codex 正在处理（等待审批）'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('静默提示带上最后状态', async () => {
    vi.useFakeTimers()
    try {
      const { fake, append, gate } = wedgedSetup(5_000, 1_000)
      fake.diagnosticsState.lastStatus = {
        key: 'codex:active',
        label: 'codex 正在处理',
        working: true,
        notable: false,
        at: Date.now(),
      }
      const answering = gate.answer('s1', 'acp-codex', { messages: [user('等等')], position }, { chunk: () => {} })
      await Promise.race([answering.then(() => 'done'), vi.advanceTimersByTimeAsync(1_500).then(() => 't1500')])
      const notes = append.written.filter(w => w.type === 'system/message')
      expect(notes).toHaveLength(1)
      const text = JSON.stringify(notes[0]?.payload)
      expect(text).toContain('已静默')
      expect(text).toContain('最后状态')
      expect(text).toContain('codex 正在处理')
      await vi.advanceTimersByTimeAsync(10_000)
      await answering
    } finally {
      vi.useRealTimers()
    }
  })

  it('静默过 warnMs 写一条 system/message 提示，且只写一条', async () => {
    vi.useFakeTimers()
    try {
      const { append, gate } = wedgedSetup(5_000, 1_000)
      const answering = gate.answer('s1', 'acp-codex', { messages: [user('等等')], position }, { chunk: () => {} })
      await Promise.race([answering.then(() => 'done'), vi.advanceTimersByTimeAsync(900).then(() => 't900')])
      expect(append.written.filter(w => w.type === 'system/message')).toHaveLength(0)
      await Promise.race([answering.then(() => 'done'), vi.advanceTimersByTimeAsync(200).then(() => 't1100')])
      const notes = append.written.filter(w => w.type === 'system/message')
      expect(notes).toHaveLength(1)
      // v4 对 system/message 的准入一次查全，不再一个字段一个字段地炸
      // （同一条提示已连伤 b60d6fa4 两次：先 turn/step，后 id，第三次是
      // source——「format v4 message requires a producer-owned source kind」）。
      expectV4SystemNote(notes[0], position)
      const text = JSON.stringify(notes[0]?.payload)
      expect(text).toContain('已静默')
      expect(text).toContain('tls handshake eof')
      await Promise.race([answering.then(() => 'done'), vi.advanceTimersByTimeAsync(2_000).then(() => 't3100')])
      expect(append.written.filter(w => w.type === 'system/message')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(10_000)
      await answering
    } finally {
      vi.useRealTimers()
    }
  })

  it('warnMs ≥ stallMs 不写提示；stallMs=0 不做静默收场', async () => {
    vi.useFakeTimers()
    try {
      const inverted = wedgedSetup(1_000, 5_000)
      const invertedOutcome = await Promise.race([
        inverted.gate.answer('s1', 'acp-codex', { messages: [user('倒挂')], position }, { chunk: () => {} }).then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(10_000).then(() => 'still-hanging'),
      ])
      expect(invertedOutcome).toBe('resolved')
      expect(inverted.append.written.filter(w => w.type === 'system/message')).toHaveLength(0)

      const disabled = wedgedSetup(0, 1_000)
      const outcome = await Promise.race([
        disabled.gate.answer('s1', 'acp-codex', { messages: [user('不限')], position }, { chunk: () => {} }).then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(30_000).then(() => 'still-hanging'),
      ])
      expect(outcome).toBe('still-hanging')
      expect(disabled.fake.closes.count).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('GatewayConversations — 总上限与统一丢弃', () => {
  it('总上限到点：连续静默满上限才收场（ACP_TIMEOUT 带诊断包、丢弃会话、下一请求重开）', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      // 挂死的后端：一条帧都不来。总上限是「最多连续安静多久」，静默看门狗
      // 给它更长的绳子（60s > 20s），所以先到点的是总上限。
      fake.answerWith(() => new Promise(() => {}))
      fake.diagnosticsState.stderrTail = ['working']
      const opens: string[] = []
      const gate = new GatewayConversations(
        async presetId => { opens.push(presetId); return fake.session },
        undefined, undefined, undefined,
        () => ({ stallMs: 60_000, totalMs: 20_000 }),
      )
      const chunks: GatewayChunk[] = []
      const outcome = await Promise.race([
        gate.answer('s1', 'acp-codex', { messages: [user('跑长任务')], position }, { chunk: c => { chunks.push(c) } }).then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(19_000).then(() => 'at-19s'),
      ])
      expect(outcome).toBe('at-19s')
      await vi.advanceTimersByTimeAsync(2_000)
      const finish = chunks.find(c => c.type === 'finish') as { reason: { kind: string; failure?: { code?: string; message?: string } } }
      // 总上限在 20s 收场：错误码 ACP_TIMEOUT，消息带总上限与诊断。
      expect(finish).toBeDefined()
      expect(finish.reason.kind).toBe('error')
      expect(finish.reason.failure?.code).toBe('ACP_TIMEOUT')
      expect(finish.reason.failure?.message).toContain('总上限')
      expect(finish.reason.failure?.message).toContain('working')
      expect(fake.closes.count).toBe(1)
      // Review Focus 5：总上限丢弃后，下一请求同样重开。
      fake.answerWith(async () => ({ kind: 'completed' }))
      await gate.answer('s1', 'acp-codex', { messages: [user('跑长任务'), user('再跑')], position }, { chunk: () => {} })
      expect(opens).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('总上限不是墙上时钟：一直有上报的回合跑过上限也不死', async () => {
    // 2026-10-20 会话 7165a323：codex 派出 5 个子代理后一边轮询一边等了 26
    // 分钟，30 分钟的固定上限到点把主回合按 ACP_TIMEOUT 杀掉，5 个子代理的
    // 结果全部丢失——那时它明明还在上报。总上限是「最多连续安静多久」：
    // 每来一次上报就重新计时，一直在忙的回合不会因为跑得久而被掐掉。
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      fake.answerWith(async turn => {
        const handle = turn.openStream?.()
        for (;;) {
          handle?.textDelta('还在干')
          await new Promise(resolve => { setTimeout(resolve, 500) })
        }
      })
      const reports: string[] = []
      const chunks: GatewayChunk[] = []
      const gate = new GatewayConversations(
        async () => fake.session,
        message => { reports.push(message) },
        undefined, undefined,
        () => ({ stallMs: 60_000, totalMs: 20_000 }),
      )
      // 这一回合不会自己结束（那正是要验的），所以不 await 它。
      void gate.answer('s1', 'acp-codex', { messages: [user('一直干活')], position }, { chunk: c => { chunks.push(c) } })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(chunks.find(c => c.type === 'finish')).toBeUndefined()
      expect(fake.closes.count).toBe(0)
      expect(reports.some(message => message.includes('exceeded the total cap'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('收场消息带上未收尾的委托运行：说清是卡在等子代理还是自己卡死', async () => {
    // 这个数不参与判定，只回答「为什么停了」——2026-10-20 用户看到的就是
    // 「主会话报超时、子会话还在跑」，这句话当时不在场。
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      fake.diagnosticsState.liveDelegatedRuns = 2
      fake.answerWith(() => new Promise(() => {}))
      const chunks: GatewayChunk[] = []
      const gate = new GatewayConversations(
        async () => fake.session,
        undefined, undefined, undefined,
        () => ({ stallMs: 40, totalMs: 60_000 }),
      )
      const answering = gate.answer('s1', 'acp-codex', { messages: [user('等子代理')], position }, { chunk: c => { chunks.push(c) } })
      await vi.advanceTimersByTimeAsync(200)
      const finish = chunks.find(c => c.type === 'finish') as { reason: { kind: string; failure?: { code?: string; message?: string } } }
      expect(finish).toBeDefined()
      expect(finish.reason.failure?.message).toContain('还有 2 个委托运行未收尾')
      await answering
    } finally {
      vi.useRealTimers()
    }
  })

  it('totalMs=0 不限：帧持续时远超总上限仍挂起，不误杀', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      fake.answerWith(async turn => {
        const handle = turn.openStream?.()
        for (;;) {
          handle?.textDelta('还在干')
          await new Promise(resolve => { setTimeout(resolve, 500) })
        }
      })
      const gate = new GatewayConversations(async () => fake.session, undefined, undefined, undefined, () => ({ stallMs: 5_000, totalMs: 0 }))
      const outcome = await Promise.race([
        gate.answer('s1', 'acp-codex', { messages: [user('不限时长')], position }, { chunk: () => {} }).then(() => 'resolved'),
        vi.advanceTimersByTimeAsync(3_600_000).then(() => 'still-hanging'),
      ])
      expect(outcome).toBe('still-hanging')
      expect(fake.closes.count).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('三类强制收场错误码统一丢弃会话（ACP_CONNECTION / ACP_STALLED / ACP_TIMEOUT）', async () => {
    for (const code of ['ACP_CONNECTION', 'ACP_STALLED', 'ACP_TIMEOUT']) {
      const failing = fakeSession()
      failing.answerWith(async () => ({
        kind: 'error',
        error: { code, message: `外部 agent 错误（${code}）` },
      }))
      const gate = new GatewayConversations(async () => failing.session)
      await gate.answer('s1', 'acp-codex', { messages: [user(`死于 ${code}`)], position }, { chunk: () => {} })
      expect(failing.closes.count, code).toBe(1)
    }
  })
})


describe('GatewayConversations — 停止宽限窗口内的新请求', () => {
  it('不复用漂浮旧 run 的会话：旧对话被弃，新回合不被宽限杀误伤', async () => {
    vi.useFakeTimers()
    try {
      // 每次 open 一个新桩：旧 run 永不结算（停止后漂浮），新 run 正常完成。
      const generations: ReturnType<typeof fakeSession>[] = []
      const opens: string[] = []
      const primers: (string | undefined)[] = []
      const gate = new GatewayConversations(async (presetId, options) => {
        opens.push(presetId)
        primers.push(options.primer.take('s1'))
        const fake = fakeSession()
        generations.push(fake)
        fake.answerWith(generations.length === 1
          ? () => new Promise<GatewayStepEnd>(() => {})
          : async () => ({ kind: 'completed' }))
        return fake.session
      })
      const controller = new AbortController()
      const first = gate.answer('s1', 'acp-codex', {
        messages: [user('第一问')],
        position,
        signal: controller.signal,
      }, { chunk: () => {} })
      await vi.advanceTimersByTimeAsync(1)
      controller.abort()
      await first // 立即收场（Task 3 行为）
      // 停止后 1 秒重问：不得复用还挂着漂浮 run 的旧会话。
      const second = gate.answer('s1', 'acp-codex', {
        messages: [user('第一问'), user('改问这个')],
        position,
      }, { chunk: () => {} })
      await vi.advanceTimersByTimeAsync(1)
      expect(opens).toHaveLength(2)
      expect(generations[0]?.closes.count).toBe(1)
      // 新外部会话里没有旧对话：重开必须重新 prime（第一问在 primer 里），
      // 不能只把「改问这个」当成一次无上下文的续聊。
      expect(primers[1]).toContain('第一问')
      expect(generations[1]?.seen[0]?.prompt).toContain('改问这个')
      expect(generations[1]?.seen[0]?.prompt).not.toContain('第一问')
      // 宽限到点（停止后 3 秒）：杀的只能是旧对话，新回合照常完成。
      await vi.advanceTimersByTimeAsync(3_000)
      expect(generations[1]?.closes.count).toBe(0)
      await second
    } finally {
      vi.useRealTimers()
    }
  })

  it('工具结果随回合收尾落盘：produce 投影进写入，调用不再悬空', async () => {
    // 2026-10-17 的真机教训（session 423817a9 turn 39 起）：实时卡只写
    // 宣告与 tool/call，结果在回合末 produce 的帧投影里，而网关的 produce
    // 返回空数组——每个用了工具的就地回合都留下未闭合调用，会话从此加载
    // 必炸（step/end leaves unresolved tool call）。
    const append = recordingAppend()
    const fake = fakeSession()
    fake.answerWith(async turn => {
      // 与真实 runner 相同的收尾次序：先实时写宣告+调用卡，回合末把
      // produce 的投影交给 write（结果只能从这条路来）。
      turn.write?.([
        { type: 'assistant/message', payload: { turn: 11, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', tool: 'grep', arguments: '{}' }] } } },
        { type: 'tool/call', payload: { turn: 11, step: 1, callId: 'c1', name: 'grep', arguments: '{}' } },
      ] as never)
      const produce = (turn as unknown as { produce?: (result: unknown) => readonly unknown[] }).produce
      const produced = produce?.({ frames: [], end: { kind: 'completed' } })
      if (produced !== undefined && produced.length > 0) turn.write?.(produced as never)
      return { kind: 'completed' }
    })
    const gate = new GatewayConversations(
      async () => fake.session,
      () => {},
      sessionId => (sessionId === 's1' ? append : undefined),
      sessionId => (sessionId === 's1' ? { turn: 11, step: 1 } : undefined),
      undefined,
      () => (_result: unknown, at: { turn: number; step: number }) => [
        { type: 'tool/result', payload: { turn: at.turn, step: at.step, callId: 'c1', message: { role: 'tool', callId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
      ],
    )
    await gate.answer('s1', 'acp-grok', { messages: [user('查一下')] }, { chunk: () => {} })
    const types = append.written.map(w => w.type)
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
  })

  it('收场后到达的迟到写入不再落盘：步子已关，落了就是坏账', async () => {
    // 停止/看门狗先行收场后，漂浮的 run 迟早结算并想做回合末写入——
    // 但循环已经随流结束闭了步，迟到的结果要么被拒、要么落在任何开着的
    // 步之外，两种都是坏账。收场之后，写入端必须闭嘴（卡的中止结果由
    // runner 的停止监听在收场前同步补齐，见 mid-turn-tools.spec.ts）。
    vi.useFakeTimers()
    try {
      const append = recordingAppend()
      let settleRun: ((end: GatewayStepEnd) => void) | undefined
      let held: { write?: (events: readonly { type: string; payload: unknown }[]) => number | undefined } | undefined
      const fake = fakeSession()
      fake.answerWith(turn => {
        held = turn as unknown as typeof held
        return new Promise<GatewayStepEnd>(resolve => { settleRun = resolve })
      })
      const gate = new GatewayConversations(
        async () => fake.session,
        () => {},
        sessionId => (sessionId === 's1' ? append : undefined),
        undefined,
        undefined,
        () => (_result: unknown, _at: { turn: number; step: number }) => [],
      )
      const controller = new AbortController()
      const answering = gate.answer('s1', 'acp-codex', {
        messages: [user('停下来')],
        position,
        signal: controller.signal,
      }, { chunk: () => {} })
      await vi.advanceTimersByTimeAsync(1)
      controller.abort()
      await answering // 立即以 aborted 收场；run 仍漂浮
      const before = append.written.length

      held?.write?.([{
        type: 'tool/result',
        payload: { turn: position.turn, step: position.step, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'late' }] } },
      }] as never)
      settleRun?.({ kind: 'aborted' })
      await vi.advanceTimersByTimeAsync(10)
      expect(append.written.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('没有回合末投影器就不写实时卡：注定悬空的调用一开始就不落盘', async () => {
    // 上一测试的反面：produceOf 缺席时 produce 只能返回空数组，结果永远
    // 追不上实时卡。卡一旦写下，step/end 闭步必留未解调用，会话从此加载
    // 必炸——2026-10-18 桌面 session 928fbb8e turn 19-22（14+96+9 张卡，
    // 零结果）就是旧代码这么写坏的。没有投影器，实时写入端就不该存在。
    const append = recordingAppend()
    const fake = fakeSession()
    fake.answerWith(async turn => {
      turn.write?.([
        { type: 'assistant/message', payload: { turn: 11, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', tool: 'grep', arguments: '{}' }] } } },
        { type: 'tool/call', payload: { turn: 11, step: 1, callId: 'c1', name: 'grep', arguments: '{}' } },
      ] as never)
      return { kind: 'completed' }
    })
    // 五参构造：produceOf 故意缺席。
    const gate = new GatewayConversations(
      async () => fake.session,
      () => {},
      sessionId => (sessionId === 's1' ? append : undefined),
      sessionId => (sessionId === 's1' ? { turn: 11, step: 1 } : undefined),
    )
    await gate.answer('s1', 'acp-grok', { messages: [user('查一下')] }, { chunk: () => {} })
    const types = append.written.map(w => w.type)
    expect(types).not.toContain('tool/call')
    expect(types).not.toContain('assistant/message')
  })
})
