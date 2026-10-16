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
 * - a failed or aborted answer advances nothing, so a retry asks the same
 *   thing instead of silently skipping the question.
 */

import { describe, expect, it } from 'vitest'
import { GatewayConversations, GatewayChunkStream } from '../src/gateway.ts'
import type { AcpSession } from '../src/registry.ts'
import type { RunnerOptions } from '../src/runner.ts'
import type { GatewayChunk, GatewayStepEnd } from '../src/gateway.ts'

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], id: `u-${text}` })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], id: `a-${text}` })
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
 * A session stand-in: records each run's turn context, and answers through
 * whatever the turn's openStream handed back — the same handle production
 * uses, so emitted deltas reach the real chunk stream under test.
 */
function fakeSession() {
  const seen: {
    prompt: string
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
  }
  let reply: (turn: Turnish) => Promise<GatewayStepEnd> = async () => ({ kind: 'completed' })
  const endResult = (end: GatewayStepEnd) => ({ frames: [], end })
  const session: AcpSession = {
    run: async (decision: { messages?: unknown }, turn: unknown) => {
      const t = turn as unknown as Turnish
      seen.push({
        prompt: JSON.stringify(decision.messages),
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
    close: () => {},
    onDead: () => {},
  } as unknown as AcpSession
  return {
    session,
    seen,
    answerWith(next: (turn: Turnish) => Promise<GatewayStepEnd>) { reply = next },
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
    )
    await gate.answer('s1', 'acp-codex', { messages: [user('跑个命令')], position }, { chunk: () => {} })

    expect(written.map(entry => entry.type)).toEqual(['tool/call', 'tool/result'])
    // 结果必须指回它回答的那次调用，否则它在会话里是个无主的孤儿。
    const result = written[1]
    expect(result?.intent).toEqual({ surfaceOp: 'append', sourceEventSeqs: [1] })
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
    // "Cannot read properties of undefined (reading 'turn')". A missing
    // position must degrade to the zero placeholder.
    const fake = fakeSession()
    const gate = new GatewayConversations(async () => fake.session)
    const chunks: GatewayChunk[] = []
    await gate.answer('s1', 'acp-codex', {
      messages: [user('问')],
    } as unknown as Parameters<GatewayConversations['answer']>[2], { chunk: c => { chunks.push(c) } })
    expect(fake.seen[0]?.positionTurn).toBe(0)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('does not advance on failure, so a retry asks the same question', async () => {
    const fake = fakeSession()
    fake.answerWith(async () => ({ kind: 'error', error: { message: 'agent died' } }))
    const gate = new GatewayConversations(async () => fake.session)
    const sink = { chunk: () => {} }
    const chunks: GatewayChunk[] = []
    await gate.answer('s1', 'acp-codex', { messages: [user('第一问')], position }, { chunk: c => { chunks.push(c) } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    fake.answerWith(async () => ({ kind: 'completed' }))
    await gate.answer('s1', 'acp-codex', {
      messages: [user('第一问'), user('再试一次')],
      position,
    }, sink)
    // The cursor stayed where it was, so the retry still carries the question
    // (the prior turn rides the primer seam, not the prompt).
    expect(fake.seen[1]?.prompt).toContain('再试一次')
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
})
