/**
 * 未知输出聚合器：没被投影成内容/卡片的帧，按「连续同类」聚成块。
 *
 * 这里钉的是用户能感知的规则：块只在连续同类时合并（界面时间顺序不能被聚合打乱）、
 * 已映射帧与协议应答不进入块、块携带段起点的位置、块落在哪个步骤。
 */

import { describe, expect, it } from 'vitest'
import type { AcpFrame } from '../src/acp-client.ts'
import { RawOutputAggregator, classifyRawOutput } from '../src/raw-output.ts'

const AT = { turn: 1, step: 1 }

/** One session/update frame with a given kind and extra fields. */
function update(kind: string, extra: Record<string, unknown> = {}): AcpFrame {
  return { method: 'session/update', params: { update: { sessionUpdate: kind, ...extra } } }
}

/** A mapped content frame: its text is projected into the transcript already. */
function content(text: string): AcpFrame {
  return update('agent_message_chunk', { content: { type: 'text', text } })
}

/** A protocol reply: an id with no method. */
const REPLY: AcpFrame = { id: 1, result: {} }

/** A permission request: rendered by the approval card already. */
const PERMISSION: AcpFrame = { id: 2, method: 'session/request_permission', params: {} }

/** A client-capability request: the agent asked us to read a file. */
const FS_READ: AcpFrame = { id: 3, method: 'fs/read_text_file', params: { path: '/tmp/x' } }

function linesOf(block: { content: string }): string[] {
  return block.content.split('\n')
}

describe('classifyRawOutput', () => {
  it('协议应答、审批与提问请求不是输出', () => {
    expect(classifyRawOutput(REPLY, { childSession: false })).toBeUndefined()
    expect(classifyRawOutput(PERMISSION, { childSession: false })).toBeUndefined()
    expect(
      classifyRawOutput({ id: 4, method: 'cursor/ask_question', params: {} }, { childSession: false }),
    ).toBeUndefined()
  })

  it('已映射的帧归 mapped，两处上下文一致', () => {
    for (const kind of [
      'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update',
      'subagent_spawned', 'subagent_state_update', 'async_task_spawned',
      'async_task_progress', 'async_task_state_update', 'user_message_chunk',
    ]) {
      expect(classifyRawOutput(update(kind), { childSession: false })).toBe('mapped')
      expect(classifyRawOutput(update(kind), { childSession: true })).toBe('mapped')
    }
  })

  it('客户端能力请求生成摘要行', () => {
    const classified = classifyRawOutput(FS_READ, { childSession: false })
    expect(classified).toEqual({ kind: 'fs/read_text_file', format: 'text', line: JSON.stringify({ method: 'fs/read_text_file', params: { path: '/tmp/x' } }) })
  })

  it('未知会话更新与厂商私有方法走 JSON 行', () => {
    expect(classifyRawOutput(update('session_info_update', { title: 'x' }), { childSession: false }))
      .toEqual({ kind: 'session_info_update', format: 'json', line: JSON.stringify({ sessionUpdate: 'session_info_update', title: 'x' }) })
    expect(classifyRawOutput({ method: 'grok/private_update', params: { a: 1 } }, { childSession: false }))
      .toEqual({ kind: 'grok/private_update', format: 'json', line: JSON.stringify({ method: 'grok/private_update', params: { a: 1 } }) })
  })

  it('私有方法包装的已映射种类仍归 mapped', () => {
    // grok 的私有包装里可能带 sessionUpdate 种类；它已被投影吸收，不能在未知块里重复。
    const wrapped: AcpFrame = { method: 'x/grok_update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } }
    expect(classifyRawOutput(wrapped, { childSession: false })).toBe('mapped')
  })
})

describe('RawOutputAggregator', () => {
  it('连续同类三帧只在 flush 时出一块', () => {
    const agg = new RawOutputAggregator()
    expect(agg.observe(update('session_info_update', { a: 1 }), AT, { childSession: false })).toBeUndefined()
    expect(agg.observe(update('session_info_update', { a: 2 }), AT, { childSession: false })).toBeUndefined()
    expect(agg.observe(update('session_info_update', { a: 3 }), AT, { childSession: false })).toBeUndefined()
    const block = agg.flush(AT)
    expect(block).toBeDefined()
    expect(block!.count).toBe(3)
    expect(block!.kind).toBe('session_info_update')
    const lines = linesOf(block!)
    expect(lines[0]).toBe('（3 帧）')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain('"a":1')
    expect(lines[3]).toContain('"a":3')
  })

  it('种类切换时先交出前一块，新段从切换帧起', () => {
    const agg = new RawOutputAggregator()
    expect(agg.observe(update('usage_update'), AT, { childSession: false })).toBeUndefined()
    const closed = agg.observe(update('session_info_update'), AT, { childSession: false })
    expect(closed).toBeDefined()
    expect(closed!.kind).toBe('usage_update')
    expect(closed!.count).toBe(1)
    const second = agg.flush(AT)
    expect(second).toBeDefined()
    expect(second!.kind).toBe('session_info_update')
    expect(second!.count).toBe(1)
  })

  it('已映射帧闭合当前段，自身不入块', () => {
    const agg = new RawOutputAggregator()
    agg.observe(update('available_commands_update'), AT, { childSession: false })
    const closed = agg.observe(content('正文'), AT, { childSession: false })
    expect(closed).toBeDefined()
    expect(closed!.count).toBe(1)
    expect(closed!.content).not.toContain('正文')
    expect(agg.flush(AT)).toBeUndefined()
  })

  it('应答与审批请求不闭段也不入块', () => {
    const agg = new RawOutputAggregator()
    agg.observe(update('session_info_update'), AT, { childSession: false })
    expect(agg.observe(REPLY, AT, { childSession: false })).toBeUndefined()
    expect(agg.observe(PERMISSION, AT, { childSession: false })).toBeUndefined()
    const block = agg.flush(AT)
    expect(block!.count).toBe(1)
  })

  it('fs 请求独自成块，格式为 text', () => {
    const agg = new RawOutputAggregator()
    expect(agg.observe(FS_READ, AT, { childSession: false })).toBeUndefined()
    const block = agg.flush(AT)
    expect(block!.kind).toBe('fs/read_text_file')
    expect(block!.format).toBe('text')
    expect(block!.content).toContain('"/tmp/x"')
  })

  it('超过上限时在同一连续段内切块，且不丢行', () => {
    const agg = new RawOutputAggregator({ maxBytes: 40 })
    const first = update('usage_update', { pad: 'A'.repeat(24) })
    const second = update('usage_update', { pad: 'B'.repeat(24) })
    expect(agg.observe(first, AT, { childSession: false })).toBeUndefined()
    const closed = agg.observe(second, AT, { childSession: false })
    expect(closed).toBeDefined()
    expect(closed!.count).toBe(1)
    expect(closed!.content).toContain('AAAA')
    const rest = agg.flush(AT)
    expect(rest).toBeDefined()
    expect(rest!.count).toBe(1)
    expect(rest!.content).toContain('BBBB')
  })

  it('块携带段起点的位置（跨步骤不换起点）', () => {
    const agg = new RawOutputAggregator()
    agg.observe(update('usage_update'), { turn: 1, step: 1 }, { childSession: false })
    const closed = agg.observe(update('session_info_update'), { turn: 1, step: 2 }, { childSession: false })
    expect(closed).toMatchObject({ turn: 1, step: 1, kind: 'usage_update' })
    const second = agg.flush({ turn: 1, step: 2 })
    expect(second).toMatchObject({ turn: 1, step: 2, kind: 'session_info_update' })
  })

  it('空段 flush 不出块', () => {
    const agg = new RawOutputAggregator()
    expect(agg.flush(AT)).toBeUndefined()
    agg.observe(REPLY, AT, { childSession: false })
    expect(agg.flush(AT)).toBeUndefined()
  })
})
