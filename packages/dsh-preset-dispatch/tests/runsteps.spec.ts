/**
 * 段落驱动 runSteps：外部回合一段一个 DSH 步骤。
 *
 * 接管路径的替换步骤返回 null 时，原生循环会补上下一步边界再调一次——runSteps
 * 把这个机制用起来：每次调用只消费外部回合的一个段落，段闭合时投影落盘并返回
 * null；末段（应答落定/中止/失败）才返回真实结束原因。段边界由 AcpSegmenter
 * 给出：工具批次全部收尾后的第一条新内容帧闭合上一段，且该帧归新段。
 *
 * 两条裁定随行验证：
 * - 子会话帧（params.sessionId ≠ 外部会话 id）不进父泵的流与切段，只在投影时
 *   折进子代理卡片的结果（Task 1 遗留 minor 的收口）；
 * - 实时结果写前带 settled 自守卫，同一 callId 的第二个收尾帧不再重复写。
 */

import type { AcpFrame } from '@threadharbor/dsh-acp-agent'
import { claudeDialect, projectStepContent } from '@threadharbor/dsh-acp-agent'
import { describe, expect, it } from 'vitest'
import type { StepDecisionLike, TurnContext, TurnStreamHandle } from '../src/dispatch.ts'
import { makeContentWriter } from '../src/content-writer.ts'
import type { ContentWriter } from '../src/content-writer.ts'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort, RunnerOptions } from '../src/runner.ts'

const DECISION: StepDecisionLike = {
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

/** 外部（父）会话上的一条 `session/update`；子会话帧由第二个参数改名。 */
const update = (fields: Record<string, unknown>, sessionId = 'ext'): AcpFrame['params'] => ({ sessionId, update: fields })

const textFrame = (text: string): AcpFrame => ({
  jsonrpc: '2.0', method: 'session/update',
  params: update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }),
})
const toolOpen = (id: string, title = 'Bash'): AcpFrame => ({
  jsonrpc: '2.0', method: 'session/update',
  params: update({ sessionUpdate: 'tool_call', toolCallId: id, title, status: 'in_progress' }),
})
const toolDone = (id: string, output: string): AcpFrame => ({
  jsonrpc: '2.0', method: 'session/update',
  params: update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'text', text: output }] }),
})
const spawnFrame = (childId: string): AcpFrame => ({
  jsonrpc: '2.0', method: 'session/update',
  params: update({ sessionUpdate: 'subagent_spawned', subagentSessionId: childId, name: 'Researcher', task: 'find docs', capabilities: {} }),
})
const childChunk = (childId: string, text: string): AcpFrame => ({
  jsonrpc: '2.0', method: 'session/update',
  params: update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, childId),
})
const childSettled = (childId: string): AcpFrame => ({
  jsonrpc: '2.0', method: 'session/update',
  params: update({ sessionUpdate: 'subagent_state_update', subagentSessionId: childId, state: 'completed' }),
})
/**
 * `session/prompt` 的应答帧。真实客户端在解决 request promise 之前先把它镜像给
 * onFrame（client.ts「replies included」），用法就挂在这一帧上被 accumulate 读走。
 */
const replyFrame = (usage?: Record<string, number>): AcpFrame => ({
  jsonrpc: '2.0', id: 9,
  result: { stopReason: 'end_turn', ...(usage === undefined ? {} : { usage }) },
})

/**
 * session/prompt 返回手动 resolve 的 promise、onFrame 句柄可捕获的假客户端——
 * 测试用它手工控制「帧先到、应答后落定」的真实时序。
 */
function fakePromptClient() {
  const calls: { method: string; params: unknown }[] = []
  const notifications: { method: string; params: unknown }[] = []
  let deliver: ((frame: AcpFrame) => void) | undefined
  let settlePrompt: ((value: unknown) => void) | undefined
  let failPrompt: ((error: Error) => void) | undefined
  const client: AcpClientPort = {
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'session/new') {
        return { sessionId: 'ext', models: { availableModels: [{ modelId: 'm1', name: 'M1' }] } }
      }
      if (method === 'session/prompt') {
        return new Promise((resolve, reject) => { settlePrompt = resolve; failPrompt = reject })
      }
      return {}
    },
    notify: (method, params) => { notifications.push({ method, params }) },
    onFrame: handler => { deliver = handler },
  }
  return {
    client, calls, notifications,
    deliver: (frame: AcpFrame) => deliver!(frame),
    resolvePrompt: () => settlePrompt!({ stopReason: 'end_turn' }),
    rejectPrompt: (error: Error) => failPrompt!(error),
  }
}

type Append = { type: string; payload: Record<string, unknown>; intent?: { surfaceOp?: string; sourceEventSeqs?: readonly number[] } }

/** 记录每次 append 的写入器，形状同 mid-turn-tools 的 recordingWrite。 */
function recordingWrite(): { write: ContentWriter; appends: Append[] } {
  const appends: Append[] = []
  const write = makeContentWriter((type, payload, intent) => {
    appends.push({ type, payload: payload as Record<string, unknown>, ...(intent === undefined ? {} : { intent }) })
    return { seq: appends.length }
  })
  return { write, appends }
}

/** 记录增量与收尾的流句柄：每次 runSteps 调用各开一个，可断言增量走了哪个。 */
function recordingStream(): TurnStreamHandle & {
  log: {
    deltas: string[]
    reasonings: string[]
    ended: { kind: 'settled'; seq: number } | { kind: 'abandoned' } | undefined
  }
} {
  const log = {
    deltas: [] as string[],
    reasonings: [] as string[],
    ended: undefined as { kind: 'settled'; seq: number } | { kind: 'abandoned' } | undefined,
  }
  return {
    log,
    start: () => {},
    textDelta: text => { log.deltas.push(text) },
    reasoningDelta: text => { log.reasonings.push(text) },
    records: () => [],
    settle: (_eventType, commit) => { log.ended = { kind: 'settled', seq: commit() } },
    abandon: () => { log.ended = { kind: 'abandoned' } },
  }
}

type Harness = {
  runner: AcpTurnRunner
  turnOf: (step: number) => TurnContext
  appends: Append[]
  streams: ReturnType<typeof recordingStream>[]
  deliver: (frame: AcpFrame) => void
  resolvePrompt: () => void
  rejectPrompt: (error: Error) => void
  calls: { method: string; params: unknown }[]
  notifications: { method: string; params: unknown }[]
  /** 应答已发出、泵已进入等待后才放行测试投帧。 */
  started: () => Promise<void>
}

/** 真投影（claude 方言、真 projectStepContent）+ 记录写入器 + 记录流句柄。 */
function segmentHarness(options: { abort?: () => AbortSignal; primer?: RunnerOptions['primer'] } = {}): Harness {
  const fake = fakePromptClient()
  const { write, appends } = recordingWrite()
  const streams: ReturnType<typeof recordingStream>[] = []
  const runner = new AcpTurnRunner(fake.client, {
    cwd: '/tmp',
    dialect: claudeDialect,
    ...(options.abort === undefined ? {} : { abort: options.abort }),
    ...(options.primer === undefined ? {} : { primer: options.primer }),
  })
  const turnOf = (step: number): TurnContext => ({
    sessionId: 'dsh1',
    position: { turn: 4, step },
    produce: result => projectStepContent(result.frames, {
      turn: 4,
      step,
      dialect: claudeDialect,
      ...(result.stream === undefined ? {} : { stream: result.stream }),
    }),
    write,
    openStream: () => {
      const stream = recordingStream()
      streams.push(stream)
      return stream
    },
  })
  let markStarted: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  // request 里 session/prompt 一被调用就点亮 started。
  const originalRequest = fake.client.request.bind(fake.client)
  fake.client.request = async (method, params) => {
    if (method === 'session/prompt') markStarted()
    return originalRequest(method, params)
  }
  return {
    runner,
    turnOf,
    appends,
    streams,
    deliver: fake.deliver,
    resolvePrompt: fake.resolvePrompt,
    rejectPrompt: fake.rejectPrompt,
    calls: fake.calls,
    notifications: fake.notifications,
    started: () => started.then(() => new Promise<void>(resolve => { setTimeout(resolve, 0) })),
  }
}

/** 让泵上的微任务全部跑完（投帧/中止都经微任务驱动的泵处理）。 */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('runSteps — 段落推进', () => {
  it('text→tool→text 序列：第一次调用在第二条 text 前返回 null，已写事件全部 step=1；第二次在 reply 后返回 completed，末段消息 step=2 且带 usage', async () => {
    const h = segmentHarness()
    const first = h.runner.runSteps(DECISION, h.turnOf(1), { first: true })
    await h.started()
    h.deliver(textFrame('a'))
    h.deliver(toolOpen('t1'))
    h.deliver(toolDone('t1', 'ok'))
    // 第二条 text 是段边界帧：它属于新段，留在队里等下一次调用。
    h.deliver(textFrame('b'))
    expect(await first).toBeNull()

    // 段 1 的已写事件：公告+卡+实时结果+段消息，全部 step=1。
    expect(h.appends.map(append => append.type)).toEqual(['assistant/message', 'tool/call', 'tool/result', 'assistant/message'])
    for (const append of h.appends) expect(append.payload['step']).toBe(1)
    // 段 1 的流收到第一条增量；边界帧的增量不属于它。
    expect(h.streams[0]!.log.deltas).toEqual(['a'])
    expect(h.streams[0]!.log.ended).toEqual({ kind: 'settled', seq: 4 })

    h.deliver(replyFrame({ inputTokens: 10, outputTokens: 5 }))
    h.resolvePrompt()
    const second = await h.runner.runSteps(DECISION, h.turnOf(2), { first: false })

    expect(second).toEqual({ kind: 'completed' })
    // 边界帧归新段：它的增量走第二个流句柄，末段消息 step=2、内嵌该段文本与 usage。
    expect(h.streams[1]!.log.deltas).toEqual(['b'])
    expect(h.streams[1]!.log.ended?.kind).toBe('settled')
    const messages = h.appends.filter(append => append.type === 'assistant/message')
    const final = messages.at(-1)!
    expect(final.payload['step']).toBe(2)
    expect((final.payload as { message: { content: { text: string }[] } }).message.content).toEqual([{ type: 'text', text: 'b' }])
    expect(final.payload['usage']).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('微任务间隙帧：两次调用之间到达的文本由第二次调用处理，增量走第二个流句柄', async () => {
    const h = segmentHarness()
    const first = h.runner.runSteps(DECISION, h.turnOf(1), { first: true })
    await h.started()
    h.deliver(textFrame('a'))
    h.deliver(toolOpen('t1'))
    h.deliver(toolDone('t1', 'ok'))
    h.deliver(textFrame('b'))
    expect(await first).toBeNull()

    // 第一次调用已返回、第二次还没开始：这一帧只能排队等下一次调用。
    h.deliver(textFrame('c'))

    const second = h.runner.runSteps(DECISION, h.turnOf(2), { first: false })
    h.deliver(replyFrame())
    h.resolvePrompt()
    expect(await second).toEqual({ kind: 'completed' })

    // 间隙帧与边界帧同段：增量都走第二个句柄，消息合并两段文本。
    expect(h.streams[1]!.log.deltas).toEqual(['b', 'c'])
    const messages = h.appends.filter(append => append.type === 'assistant/message')
    expect((messages.at(-1)!.payload as { message: { content: { text: string }[] } }).message.content)
      .toEqual([{ type: 'text', text: 'bc' }])
  })

  it('中止半段：当前段写已到内容并以 aborted 收场，后续帧全部丢弃', async () => {
    const abort = new AbortController()
    const h = segmentHarness({ abort: () => abort.signal })
    const first = h.runner.runSteps(DECISION, h.turnOf(1), { first: true })
    await h.started()
    h.deliver(textFrame('a'))
    h.deliver(toolOpen('t1'))
    abort.abort()
    expect(await first).toEqual({ kind: 'aborted', reason: 'the turn was stopped; the agent was asked to cancel' })

    // 外部 agent 没收到取消前还在说话：这些帧一律丢弃。
    h.deliver(textFrame('late'))
    h.deliver(toolOpen('t2'))
    h.resolvePrompt()
    await flush()

    // notify 里只有握手 initialized 和给外部 agent 的取消：中止必须发 session/cancel。
    expect(h.notifications.filter(notification => notification.method !== 'initialized'))
      .toEqual([{ method: 'session/cancel', params: { sessionId: 'ext' } }])
    expect(h.appends.map(append => append.type)).toEqual(['assistant/message', 'tool/call', 'assistant/message', 'tool/result'])
    const texts = h.appends
      .filter(append => append.type === 'assistant/message')
      .map(append => (append.payload as { message: { content: { text?: string }[] } }).message.content)
      .flat()
      .map(block => block.text ?? '')
      .join('')
    expect(texts).toContain('a')
    expect(texts).not.toContain('late')
    expect(h.appends.some(append => append.payload['callId'] === 't2')).toBe(false)
  })

  it('未收尾工具 + reply：单末段成对写卡+结果，无 [still running]', async () => {
    const h = segmentHarness()
    const first = h.runner.runSteps(DECISION, h.turnOf(1), { first: true })
    await h.started()
    h.deliver(toolOpen('t1'))
    // 工具没收尾，段不该闭合；应答落定才把整段当末段收编。
    h.deliver(replyFrame())
    h.resolvePrompt()

    expect(await first).toEqual({ kind: 'completed' })
    // 一次调用直接收尾（无 null 中间态）：实时公告+卡，末段补配对结果；卡已被
    // 实时写、其公告块从末段消息里剥离，消息只剩公告——普通工具不写 still running。
    expect(h.appends.map(append => append.type)).toEqual(['assistant/message', 'tool/call', 'tool/result'])
    expect(JSON.stringify(h.appends)).not.toContain('[still running]')
    expect(h.appends[2]!.intent?.sourceEventSeqs).toEqual([2])
    expect((h.appends[2]!.payload as { message: { toolCallId: string } }).message.toolCallId).toBe('t1')
  })

  it('prompt 失败：first 调用返回分类错误原因，无段落事件', async () => {
    const h = segmentHarness()
    const first = h.runner.runSteps(DECISION, h.turnOf(1), { first: true })
    await h.started()
    h.rejectPrompt(new Error('acp error: {"code":-32000,"message":"authentication required"}'))

    const end = await first
    expect(end).toMatchObject({ kind: 'error', error: { code: 'ACP_PERMISSION' } })
    expect((end as { error: { message: string } }).error.message).toContain('授权')
    expect(h.appends).toEqual([])
    expect(h.streams[0]!.log.ended).toEqual({ kind: 'abandoned' })
  })

  it('回合中途应答被拒：已到内容按末段投影，返回分类错误原因', async () => {
    const h = segmentHarness()
    const first = h.runner.runSteps(DECISION, h.turnOf(1), { first: true })
    await h.started()
    h.deliver(textFrame('a'))
    h.rejectPrompt(new Error('acp error: {"code":-32603,"message":"Internal error"}'))

    const end = await first
    expect(end).toMatchObject({ kind: 'error', error: { code: 'ACP_ERROR' } })
    expect((end as { error: { message: string } }).error.message).toContain('Internal error')
    const messages = h.appends.filter(append => append.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    expect((messages[0]!.payload as { message: { content: { text: string }[] } }).message.content)
      .toEqual([{ type: 'text', text: 'a' }])
  })

  it('首段职责只执行一次：两次调用只发一次 session/prompt，primer 只取一次，user 事件不归它写', async () => {
    const takes: string[] = []
    const h = segmentHarness({
      primer: { take: id => { takes.push(id); return '【移交记录】' }, restore: () => {} },
    })
    const first = h.runner.runSteps(DECISION, h.turnOf(1), { first: true })
    await h.started()
    h.deliver(textFrame('a'))
    h.deliver(toolOpen('t1'))
    h.deliver(toolDone('t1', 'ok'))
    h.deliver(textFrame('b'))
    expect(await first).toBeNull()

    h.deliver(replyFrame())
    h.resolvePrompt()
    expect(await h.runner.runSteps(DECISION, h.turnOf(2), { first: false })).toEqual({ kind: 'completed' })

    expect(h.calls.filter(call => call.method === 'session/prompt')).toHaveLength(1)
    expect(h.calls.filter(call => call.method === 'session/new')).toHaveLength(1)
    expect(takes).toEqual(['dsh1'])
    expect((h.calls.find(call => call.method === 'session/prompt')!.params as { prompt: { text: string }[] }).prompt[0]!.text)
      .toBe('【移交记录】\n\nhello')
    expect(h.appends.some(append => append.type === 'user/message')).toBe(false)
  })

  it('纯聊天：单段，一次调用直接返回 completed（与 run() 行为等价）', async () => {
    const h = segmentHarness()
    const first = h.runner.runSteps(DECISION, h.turnOf(1), { first: true })
    await h.started()
    h.deliver(textFrame('hi'))
    h.deliver(replyFrame({ inputTokens: 3, outputTokens: 2 }))
    h.resolvePrompt()

    // 没有工具就永远不切段：一次调用收下整段并给出结束原因。
    expect(await first).toEqual({ kind: 'completed' })
    expect(h.appends.map(append => append.type)).toEqual(['assistant/message'])
    const message = h.appends[0]!.payload as { step: number; usage?: unknown; message: { content: { text: string }[] } }
    expect(message.message.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(message.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(h.streams[0]!.log.deltas).toEqual(['hi'])
    expect(h.streams[0]!.log.ended?.kind).toBe('settled')
  })
})

describe('runSteps — 泵内两条裁定', () => {
  it('子会话帧不闭父段也不进父流：只在投影时折进子代理结果（裁定 1）', async () => {
    const h = segmentHarness()
    let settled = false
    const first = h.runner.runSteps(DECISION, h.turnOf(1), { first: true }).then(end => { settled = true; return end })
    await h.started()
    h.deliver(textFrame('a'))
    h.deliver(toolOpen('t1'))
    h.deliver(toolDone('t1', 'ok'))
    h.deliver(spawnFrame('child-1'))
    // 父批次已收尾，子代 chunk 若进父分段器会在此提前闭段——它不许。
    h.deliver(childChunk('child-1', 'child reply'))
    h.deliver(childSettled('child-1'))
    await flush()
    expect(settled).toBe(false)

    // 闭合只发生在父会话自己的新内容帧上。
    h.deliver(textFrame('b'))
    expect(await first).toBeNull()
    // 子代文本不进父流；子代理卡片实时开卡，结果在段末成对补写。
    expect(h.streams[0]!.log.deltas).toEqual(['a'])
    expect(h.appends.map(append => append.type)).toEqual([
      'assistant/message', 'tool/call', 'tool/result', 'assistant/message', 'tool/call', 'assistant/message', 'tool/result',
    ])
    const childResult = h.appends.at(-1)!
    expect((childResult.payload as { message: { content: { text: string }[] } }).message.content)
      .toEqual([{ type: 'text', text: 'child reply' }])
    expect(childResult.intent?.sourceEventSeqs).toEqual([5])
  })

  it('同一 callId 的第二个收尾帧不再重复实时写结果（裁定 2）', async () => {
    const h = segmentHarness()
    const first = h.runner.runSteps(DECISION, h.turnOf(1), { first: true })
    await h.started()
    h.deliver(textFrame('a'))
    h.deliver(toolOpen('t1'))
    h.deliver(toolDone('t1', 'ok'))
    h.deliver(toolDone('t1', 'ok-again'))
    h.deliver(textFrame('b'))
    expect(await first).toBeNull()

    const results = h.appends.filter(append => append.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect((results[0]!.payload as { message: { content: { text: string }[] } }).message.content)
      .toEqual([{ type: 'text', text: 'ok' }])
  })
})
