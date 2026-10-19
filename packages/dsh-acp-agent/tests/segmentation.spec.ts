/**
 * The frame segmenter against real captures and hand-built sequences.
 *
 * An external turn arrives as one long frame stream, and the whole-turn
 * projection packs it into a single DSH step — the live view loses the true
 * ordering of thinking, tool calls and text. `AcpSegmenter` walks the frames
 * and marks the boundary where one burst of model work (its thought/text plus
 * the batch of tool calls it issued) has fully settled and fresh content
 * begins, so a caller can drive one DSH step per segment. The boundary frame
 * itself belongs to the NEW segment: `observe` returns true for it, and the
 * caller closes the old segment first.
 *
 * The codex interleave is the brief's real capture
 * (`fixtures/captured-subagent-frames.json`, 2026-10-20): eleven text chunks,
 * a subagent delegation, a tool call, more text, the subagent state, the tool
 * completing, then the answer. The hand-built sequences cover the states the
 * captures happen not to show (a half-settled tool batch, empty text deltas).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AcpSegmenter } from '../src/segmentation.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import type { AcpDialect } from '../src/dialects/types.ts'
import type { AcpFrame } from '../src/acp-client.ts'

/** Whole-turn captures bucketed by phase, as they arrived on the wire. */
const captured = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/captured-frames.json', import.meta.url)), 'utf8'),
) as Record<string, Record<string, AcpFrame[]>>

/** Whole-turn captures of subagent delegations, one `frames` array per agent. */
const subagentCaptured = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/captured-subagent-frames.json', import.meta.url)), 'utf8'),
) as Record<string, { frames: AcpFrame[] }>

/** One root `session/update` frame carrying `fields` as its update. */
const update = (fields: Record<string, unknown>): AcpFrame => ({
  method: 'session/update',
  params: { update: fields },
})

const text = (value: string) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
const thought = (value: string) => update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value } })
// codex opens a call with `tool_call` already carrying `in_progress` (real
// capture) and settles it with a `tool_call_update`.
const toolOpen = (id: string) => update({ sessionUpdate: 'tool_call', toolCallId: id, status: 'in_progress' })
const toolSettled = (id: string, status = 'completed') => update({ sessionUpdate: 'tool_call_update', toolCallId: id, status })

/** Run one sequence through a fresh segmenter; the result indexes with the frames. */
const observeAll = (dialect: AcpDialect, frames: readonly AcpFrame[]): boolean[] => {
  const segmenter = new AcpSegmenter(dialect)
  return frames.map(frame => segmenter.observe(frame))
}

/** The indexes whose frame declared the previous segment closed. */
const closeIndexes = (flags: readonly boolean[]): number[] =>
  flags.flatMap((closed, index) => (closed ? [index] : []))

/** The update kind one frame carries, for pinning where a close landed. */
const kindOf = (frame: AcpFrame): string => {
  const params = typeof frame.params === 'object' && frame.params !== null
    ? frame.params as Record<string, unknown>
    : {}
  const inner = typeof params['update'] === 'object' && params['update'] !== null
    ? params['update'] as Record<string, unknown>
    : {}
  return typeof inner['sessionUpdate'] === 'string' ? inner['sessionUpdate'] : ''
}

describe('AcpSegmenter', () => {
  it('codex 真实帧：文本×11 → 子代理 → 工具 → 文本 → 状态 → 收尾 → 文本，只在收尾后的文本帧闭合一次', () => {
    const frames = subagentCaptured['codex']!.frames
    const flags = observeAll(codexDialect, frames)

    // The single close lands on the first text chunk AFTER the tool batch
    // settled (frame 22) — not on the completion frame, not earlier.
    expect(closeIndexes(flags)).toEqual([24])
    expect(kindOf(frames[24]!)).toBe('agent_message_chunk')
    // The completion frame itself does not close; the segment waits for text.
    expect(flags[22]).toBe(false)
    // Subagent lifecycle frames neither close nor disturb the tool batch.
    expect(kindOf(frames[14]!)).toBe('subagent_spawned')
    expect(flags[14]).toBe(false)
    expect(kindOf(frames[21]!)).toBe('subagent_state_update')
    expect(flags[21]).toBe(false)
  })

  it('codex-failed / claude-failed 真实帧：多工具回合也只在收尾后的文本处闭合一次', () => {
    const codexFrames = subagentCaptured['codex-failed']!.frames
    expect(closeIndexes(observeAll(codexDialect, codexFrames))).toEqual([22])
    expect(kindOf(codexFrames[22]!)).toBe('agent_message_chunk')

    const claudeFrames = subagentCaptured['claude-failed']!.frames
    expect(closeIndexes(observeAll(claudeDialect, claudeFrames))).toEqual([21])
    expect(kindOf(claudeFrames[21]!)).toBe('agent_message_chunk')
  })

  it('grok 真实帧：私有方法上的子代理帧不参与，闭合仍在工具收尾后的文本处', () => {
    const frames = subagentCaptured['grok']!.frames
    const flags = observeAll(grokDialect, frames)

    // grok rides its subagent lifecycle on `_x.ai/session_notification`; the
    // dialect's frameUpdate hook admits those frames, but they are neither
    // tool nor content — the close still waits for the post-tool text.
    expect(kindOf(frames[59]!)).toBe('subagent_spawned')
    expect(flags[59]).toBe(false)
    expect(kindOf(frames[74]!)).toBe('subagent_finished')
    expect(flags[74]).toBe(false)
    expect(closeIndexes(flags)).toEqual([76])
    expect(kindOf(frames[76]!)).toBe('agent_message_chunk')
  })

  it('手工：text → tool(in_progress) → 收尾 → text（reply 前终止），第二条 text 闭合一次', () => {
    const flags = observeAll(codexDialect, [text('计划好了'), toolOpen('t1'), toolSettled('t1'), text('开始执行')])
    expect(flags).toEqual([false, false, false, true])
  })

  it('手工：工具连工具不闭合，批次全部收尾后的 text 才闭合一次', () => {
    const flags = observeAll(codexDialect, [
      toolOpen('a'), toolOpen('b'), toolSettled('a'), toolSettled('b'), text('汇总'),
    ])
    expect(flags).toEqual([false, false, false, false, true])
  })

  it('手工：仍有工具未收尾时新文本不闭合，段继续等', () => {
    expect(observeAll(codexDialect, [text('计划'), toolOpen('t1'), text('边跑边说')]))
      .toEqual([false, false, false])
    // One call of the batch settled, another still open: keep waiting too.
    expect(observeAll(codexDialect, [toolOpen('a'), toolSettled('a'), toolOpen('b'), text('还没完')]))
      .toEqual([false, false, false, false])
  })

  it('纯聊天（thought/text 连发）零闭合', () => {
    expect(observeAll(codexDialect, [text('一'), text('二'), text('三')])).toEqual([false, false, false])
    // Real capture: claude's whole turn of thought and message chunks, no tools.
    expect(observeAll(claudeDialect, [
      ...(captured['claude']!.thought as AcpFrame[]),
      ...(captured['claude']!.message as AcpFrame[]),
    ]).some(Boolean)).toBe(false)
  })

  it('空文本增量（content.text === \'\'）不触发闭合', () => {
    // The empty delta must neither close nor consume the settled state: the
    // next non-empty chunk is the one that starts the new segment.
    const flags = observeAll(codexDialect, [
      toolOpen('t1'), toolSettled('t1'), text(''), thought(''), text('新段第一句'),
    ])
    expect(flags).toEqual([false, false, false, false, true])
  })

  it('杂讯帧（usage_update 等）不影响状态', () => {
    // Real capture noise (auth status, command list, session info, usage)
    // plus draft async-task lifecycle frames: none of them opens, settles
    // or closes anything.
    const noise: AcpFrame[] = [
      ...(captured['codex']!.noise as AcpFrame[]),
      update({ sessionUpdate: 'async_task_spawned', asyncTaskId: 'task-7', name: 'watch build' }),
      update({ sessionUpdate: 'async_task_state_update', asyncTaskId: 'task-7', state: 'completed', summary: 'watch exited 0' }),
    ]
    const flags = observeAll(codexDialect, [
      toolOpen('t1'), ...noise, toolSettled('t1'), ...noise, text('新段'),
    ])
    const settledIndex = 1 + noise.length
    expect(flags[settledIndex]).toBe(false)
    expect(closeIndexes(flags)).toEqual([settledIndex + 1 + noise.length])
  })
})
