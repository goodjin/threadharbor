import { describe, expect, it } from 'vitest'
import { foldAcpProcess, pendingBlocks, ACP_PROCESS_DATA } from '../src/acp-process-segments.ts'
import type { AcpProcessState } from '../src/acp-process-segments.ts'
import { AcpProcessNodes, withAcpProcessNodes } from '../src/acp-process-view.ts'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'

const initial = (): AcpProcessState => ({ turn: 1, steps: new Map() })
const event = (type: string, time: number, data: object, seq = time) => ({ type, time, seq, surfaceOp: 'append', data: { turn: 1, step: 1, ...data } })
const chunk = (time: number, text: string, index = 0, kind = 'reasoning') => event('assistant/live-chunk', time, { chunk: { type: `${kind}-delta`, index, text } })
const call = (time: number, callId = 'c1', name = 'bash') => event('tool/call', time, { callId, name })
const announce = event('assistant/message', 1, { message: { source: { provider: 'acp-codex' }, content: [{ type: 'tool-call', id: 'c1' }] } })
const run = (kind: string, index: number, texts: string[], time0: number, dt: number[] = []) => ({ type: `${kind}-chunks`, index, texts, time0, dt })
const content = [{ type: 'reasoning', text: 'beforeafter' }, { type: 'text', text: 'progressanswer' }]
const stream = [run('reasoning', 0, ['before'], 5), run('text', 1, ['progress'], 6), run('reasoning', 2, ['after'], 15), run('text', 3, ['answer'], 25)]
const final = (records: unknown[] = stream, provider = 'acp:acp-codex') => event('assistant/message', 30, { message: { source: { provider }, content }, stream: records })
const fold = (events: unknown[]) => events.reduce<AcpProcessState>(foldAcpProcess, initial())

function timeline(state: AcpProcessState, closed = true): ConversationTimelineSnapshot {
  const turn = { turn: 1, status: closed ? 'closed' : 'open', data: { get: (key: string) => key === ACP_PROCESS_DATA ? state : undefined }, steps: [] }
  return { turnOrder: [1], turns: new Map([[1, turn]]) } as unknown as ConversationTimelineSnapshot
}
function assistant(state: AcpProcessState): ChatNode<'assistant-step'> {
  const turn = timeline(state).turns.get(1)!
  return {
    key: 'assistant:1:1', id: '1:1', kind: 'assistant-step', target: 'chat', anchorSeq: 1, visibility: 'visible',
    location: { kind: 'turn', turn },
    data: { turn: 1, step: 1, status: 'settled', time: 30, blocks: content.map(b => ({ kind: b.type, text: b.text })) },
  } as ChatNode<'assistant-step'>
}

describe('ACP prose is sealed when the tool starts', () => {
  it('keeps preceding reasoning and commentary together; later prose gets another group', () => {
    const state = fold([announce, chunk(5, 'before'), chunk(6, 'progress', 1, 'text'), call(10), chunk(15, 'after', 2), call(20, 'c2'), chunk(25, 'answer', 3, 'text')])
    const step = state.steps.get(1)!
    expect(step.segments.map(s => s.blocks)).toEqual([
      [{ kind: 'reasoning', text: 'before' }, { kind: 'text', text: 'progress' }],
      [{ kind: 'reasoning', text: 'after' }],
    ])
    expect(step.segments.map(s => s.anchorSeq)).toEqual([9.9, 19.9])
    expect(pendingBlocks(step)).toEqual([{ kind: 'text', text: 'answer' }])
  })
  it('replays compact historical streams to exactly the same groups as live', () => {
    const live = fold([announce, chunk(5, 'before'), chunk(6, 'progress', 1, 'text'), call(10), chunk(15, 'after', 2), call(20, 'c2'), chunk(25, 'answer', 3, 'text')])
    const historical = fold([announce, call(10), call(20, 'c2'), final()])
    expect(historical.steps.get(1)!.usable).toBe(true)
    expect(historical.steps.get(1)!.segments).toEqual(live.steps.get(1)!.segments)
    expect(pendingBlocks(historical.steps.get(1)!)).toEqual(pendingBlocks(live.steps.get(1)!))
  })
  it('splits even when old compact runs reused one block index across tools', () => {
    const state = fold([announce, call(10), call(20, 'c2'), final([
      run('reasoning', 0, ['before', 'after'], 5, [10]), run('text', 1, ['progress', 'answer'], 6, [19]),
    ])])
    // Records cannot be assumed globally timestamp-sorted: old per-kind runs may overlap.
    expect(state.steps.get(1)!.usable).toBe(true)
    expect(state.steps.get(1)!.segments[0]!.blocks.map(b => b.text).join('')).toBe('beforeprogress')
  })
  it('uses explicit block boundaries when queued prose arrives after the tool in the same millisecond', () => {
    const announced = event('assistant/message', 10, { message: {
      source: { provider: 'acp-codex', replayState: { response: { threadharborAcpBoundary: { version: 1, beforeBlock: 1 } } } },
      content: [{ type: 'tool-call', id: 'c1' }],
    } })
    const live = fold([announced, call(10), chunk(10, 'before', 0), chunk(10, 'after', 1)])
    const step = live.steps.get(1)!
    expect(step.segments[0]!.blocks).toEqual([{ kind: 'reasoning', text: 'before' }])
    expect(pendingBlocks(step)).toEqual([{ kind: 'reasoning', text: 'after' }])
    const message = event('assistant/message', 20, { message: {
      source: { provider: 'acp:acp-codex' }, content: [{ type: 'reasoning', text: 'beforeafter' }],
    }, stream: [run('reasoning', 0, ['before'], 10), run('reasoning', 1, ['after'], 10)] })
    const historical = fold([announced, call(10), message]).steps.get(1)!
    expect(historical.usable).toBe(true)
    expect(historical.segments).toEqual(step.segments)
    expect(pendingBlocks(historical)).toEqual(pendingBlocks(step))
    const toolArrivesLate = fold([chunk(10, 'before', 0), chunk(10, 'after', 1), announced, call(10)]).steps.get(1)!
    expect(toolArrivesLate.segments[0]!.blocks).toEqual(step.segments[0]!.blocks)
    expect(pendingBlocks(toolArrivesLate)).toEqual(pendingBlocks(step))
    expect(toolArrivesLate.anchorSeq).toBeGreaterThan(10)
  })
  it('ignores result updates, repeated calls, empty calls and telemetry as boundaries', () => {
    const state = fold([announce, chunk(5, 'before'), call(10), chunk(15, 'after'), call(16),
      event('tool/result', 17, { message: { toolCallId: 'c1' } }), call(18, 'usage', '外部输出 · usage_update')])
    expect(state.steps.get(1)!.segments).toHaveLength(1)
    expect(pendingBlocks(state.steps.get(1)!)).toEqual([{ kind: 'reasoning', text: 'after' }])
  })
  it('does not append block-end bodies twice, including late closing frames', () => {
    const state = fold([announce, chunk(5, 'before'), call(10), event('assistant/live-chunk', 12, { chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'before' } } })])
    expect(state.steps.get(1)!.segments[0]!.blocks).toEqual([{ kind: 'reasoning', text: 'before' }])
    expect(pendingBlocks(state.steps.get(1)!)).toEqual([])
  })
  it('leaves incomplete historical streams and native provider output intact', () => {
    const missing = fold([announce, call(10), final([])])
    expect(missing.steps.get(1)!.usable).toBe(false)
    const nodes = new AcpProcessNodes(), original = assistant(missing)
    expect(nodes.replace([original], timeline(missing))).toEqual([original])
    const native = fold([call(10), final(stream, 'deepseek')]), ordinary = assistant(native)
    expect(nodes.replace([ordinary], timeline(native))).toEqual([ordinary])
  })
  it('keeps partial prose on stop and discards old groups on a real retry', () => {
    const state = fold([announce, chunk(5, 'before'), call(10), chunk(15, 'after')])
    const nodes = new AcpProcessNodes(), original = assistant(state)
    const first = nodes.replace([original], timeline(state))
    expect(first).toHaveLength(2)
    expect(first[0]!.anchorSeq).toBeLessThan(10)
    expect(first[1]!.data).toMatchObject({ blocks: [{ kind: 'reasoning', text: 'after' }] })
    const retried = foldAcpProcess(state, event('llm/retry', 20, {}))
    const updates = nodes.apply([], timeline(retried))
    expect(updates.some(n => n.key === first[0]!.key && n.visibility === 'hidden')).toBe(true)
  })
  it('separates groups in the native chat layout without modifying message storage', () => {
    const state = fold([announce, call(10), call(20, 'c2'), final()]), original = assistant(state)
    const saved = structuredClone(original.data)
    const projected = new AcpProcessNodes().replace([original], timeline(state))
    expect(projected.map(n => n.anchorSeq)).toEqual([9.9, 19.9, 20.1])
    expect(projected.at(-1)!.data).toMatchObject({ blocks: [{ kind: 'text', text: 'answer' }] })
    expect(original.data).toEqual(saved)
    expect(projected[0]!.data).toMatchObject({ status: 'settled', acpProcessSegment: { callId: 'c1' } })
  })
  it('forwards builder lifecycle and grouping with their original receiver', () => {
    const received: unknown[] = []
    const base = {
      empty: null,
      replace(input: unknown) { expect(this).toBe(base); received.push(input); return null },
      apply(input: unknown) { expect(this).toBe(base); received.push(input); return null },
      publish() { expect(this).toBe(base) },
      groupInput() { expect(this).toBe(base); return { kind: 'replace' } as never },
    }
    const view = withAcpProcessNodes(base)
    view.replace({ nodes: [], timeline: timeline(initial()) }); view.apply({ upserts: [], timeline: timeline(initial()) })
    view.publish?.(); view.groupInput?.()
    expect(received).toHaveLength(2)
  })
})
