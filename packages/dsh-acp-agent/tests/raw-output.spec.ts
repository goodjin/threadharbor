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
    expect(classifyRawOutput(update('mystery_update', { a: 1 }), { childSession: false }))
      .toEqual({ kind: 'mystery_update', format: 'json', line: JSON.stringify({ sessionUpdate: 'mystery_update', a: 1 }) })
    expect(classifyRawOutput({ method: 'grok/private_update', params: { a: 1 } }, { childSession: false }))
      .toEqual({ kind: 'grok/private_update', format: 'json', line: JSON.stringify({ method: 'grok/private_update', params: { a: 1 } }) })
  })

  it('认得的会话更新给可读行：计划、用量、标题、模式', () => {
    const plan = classifyRawOutput(update('plan', {
      entries: [
        { content: '读代码', status: 'completed' },
        { content: '改代码', status: 'in_progress' },
        { content: '跑测试', status: 'pending' },
      ],
    }), { childSession: false })
    expect(plan).toMatchObject({ kind: 'plan', format: 'text' })
    expect((plan as { line: string }).line).toBe('计划（3 项）：✓ 读代码  ▶ 改代码  ○ 跑测试')

    const usage = classifyRawOutput(update('usage_update', { used: 86_780, size: 258_400 }), { childSession: false })
    expect((usage as { line: string }).line).toBe('用量：86,780 / 258,400 tokens（33.6%）')

    const title = classifyRawOutput(update('session_info_update', { title: '修超时' }), { childSession: false })
    expect((title as { line: string }).line).toBe('会话标题：修超时')

    const status = classifyRawOutput(update('session_info_update', {
      _meta: { codex: { threadStatus: { type: 'active', activeFlags: ['waitingOnApproval'] } } },
    }), { childSession: false })
    expect((status as { line: string }).line).toBe('codex 状态：active（waitingOnApproval）')

    const mode = classifyRawOutput(update('current_mode_update', { currentModeId: 'agent' }), { childSession: false })
    expect((mode as { line: string }).line).toBe('模式切换：agent')
  })

  it('压缩上下文与计划清除也有可读行', () => {
    const compacting = classifyRawOutput(update('compaction_update', { status: 'in_progress' }), { childSession: false })
    expect(compacting).toMatchObject({ kind: 'compaction_update', format: 'text' })
    expect((compacting as { line: string }).line).toBe('上下文压缩进行中')

    const failed = classifyRawOutput(update('compaction_update', { status: 'failed', error: 'boom' }), { childSession: false })
    expect((failed as { line: string }).line).toBe('上下文压缩失败：boom')

    const removed = classifyRawOutput(update('plan_removed', { planId: 'p1' }), { childSession: false })
    expect((removed as { line: string }).line).toBe('计划已清除（p1）')
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
    expect(agg.observe(update('plan', { entries: [{ content: 'a', status: 'pending' }] }), AT, { childSession: false })).toBeUndefined()
    expect(agg.observe(update('plan', { entries: [{ content: 'b', status: 'pending' }] }), AT, { childSession: false })).toBeUndefined()
    expect(agg.observe(update('plan', { entries: [{ content: 'c', status: 'pending' }] }), AT, { childSession: false })).toBeUndefined()
    const block = agg.flush(AT)
    expect(block).toBeDefined()
    expect(block!.count).toBe(3)
    expect(block!.kind).toBe('plan')
    expect(block!.format).toBe('text')
    const lines = linesOf(block!)
    expect(lines[0]).toBe('（3 帧）')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toBe('计划（1 项）：○ a')
    expect(lines[3]).toBe('计划（1 项）：○ c')
  })

  it('种类切换时先交出前一块，新段从切换帧起', () => {
    const agg = new RawOutputAggregator()
    expect(agg.observe(update('plan'), AT, { childSession: false })).toBeUndefined()
    const closed = agg.observe(update('config_option_update'), AT, { childSession: false })
    expect(closed).toBeDefined()
    expect(closed!.kind).toBe('plan')
    expect(closed!.count).toBe(1)
    const second = agg.flush(AT)
    expect(second).toBeDefined()
    expect(second!.kind).toBe('config_option_update')
    expect(second!.count).toBe(1)
  })

  it('已映射帧闭合当前段，自身不入块', () => {
    const agg = new RawOutputAggregator()
    agg.observe(update('plan'), AT, { childSession: false })
    const closed = agg.observe(content('正文'), AT, { childSession: false })
    expect(closed).toBeDefined()
    expect(closed!.count).toBe(1)
    expect(closed!.content).not.toContain('正文')
    expect(agg.flush(AT)).toBeUndefined()
  })

  it('应答与审批请求不闭段也不入块', () => {
    const agg = new RawOutputAggregator()
    agg.observe(update('plan'), AT, { childSession: false })
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
    const first = update('mystery_update', { pad: 'A'.repeat(24) })
    const second = update('mystery_update', { pad: 'B'.repeat(24) })
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
    agg.observe(update('plan'), { turn: 1, step: 1 }, { childSession: false })
    const closed = agg.observe(update('config_option_update'), { turn: 1, step: 2 }, { childSession: false })
    expect(closed).toMatchObject({ turn: 1, step: 1, kind: 'plan' })
    const second = agg.flush({ turn: 1, step: 2 })
    expect(second).toMatchObject({ turn: 1, step: 2, kind: 'config_option_update' })
  })

  it('遥测帧不实时出块、不打断连续段，回合末按种类汇总', () => {
    const agg = new RawOutputAggregator()
    expect(agg.observe(update('usage_update', { a: 1 }), AT, { childSession: false })).toBeUndefined()
    expect(agg.observe(update('session_info_update', { t: 'x' }), AT, { childSession: false })).toBeUndefined()
    // 遥测帧夹在同类未知帧之间，不得把那段拆开。
    expect(agg.observe(update('plan', { p: 1 }), AT, { childSession: false })).toBeUndefined()
    expect(agg.observe(update('usage_update', { a: 2 }), AT, { childSession: false })).toBeUndefined()
    expect(agg.observe(update('plan', { p: 2 }), AT, { childSession: false })).toBeUndefined()
    // 步骤末封的是非遥测段，遥测不在这里出现。
    const closed = agg.flush(AT)
    expect(closed).toMatchObject({ kind: 'plan', count: 2 })
    // 回合末汇总：每种遥测一块，全部帧都算进去。
    const summary = agg.summary(AT)
    expect(summary.map(block => [block.kind, block.count])).toEqual([
      ['usage_update', 2],
      ['session_info_update', 1],
    ])
    expect(summary[0]!.content).toContain('（2 帧）')
  })

  it('current_mode_update 属遥测：不实时出块、回合末汇总（cursor 的模式切换）', () => {
    const agg = new RawOutputAggregator()
    expect(agg.observe(update('current_mode_update', { mode: 'agent' }), AT, { childSession: false })).toBeUndefined()
    expect(agg.flush(AT)).toBeUndefined()
    const summary = agg.summary(AT)
    expect(summary.map(block => block.kind)).toEqual(['current_mode_update'])
  })

  it('压缩上下文的帧实时成块，不拖到回合末', () => {
    // 压缩是「为什么这几分钟没帧」的现场解释，回合末才说就晚了。
    const agg = new RawOutputAggregator()
    expect(agg.observe(update('compaction_update', { status: 'in_progress' }), AT, { childSession: false })).toBeUndefined()
    const block = agg.flush(AT)
    expect(block).toMatchObject({ kind: 'compaction_update', count: 1, format: 'text' })
    expect(block!.content).toContain('上下文压缩进行中')
    expect(agg.summary(AT)).toEqual([])
  })

  it('cursor/update_todos 格式化为可读的待办行', () => {
    const frame = {
      method: 'cursor/update_todos',
      params: {
        toolCallId: 'call_125',
        todos: [
          { id: '1', content: 'Set up project structure', status: 'completed' },
          { id: '2', content: 'Add authentication', status: 'in_progress' },
          { id: '3', content: 'Write unit tests', status: 'pending' },
          { id: '4', content: 'Deprecated step', status: 'cancelled' },
        ],
        merge: true,
      },
    }
    const classified = classifyRawOutput(frame as never, { childSession: false })
    expect(classified).toMatchObject({ kind: 'cursor 待办', format: 'text' })
    expect((classified as { line: string }).line).toContain('✓ Set up project structure')
    expect((classified as { line: string }).line).toContain('▶ Add authentication')
    expect((classified as { line: string }).line).toContain('○ Write unit tests')
    expect((classified as { line: string }).line).toContain('✗ Deprecated step')
    expect((classified as { line: string }).line).toContain('合并')
  })

  it('cursor/task 是专用方法：派发已有子代理卡片，不再出一块「任务完成」', () => {
    const frame = {
      method: 'cursor/task',
      params: { toolCallId: 'call_126', description: 'Explore codebase', prompt: 'Find auth paths.', subagentType: 'explore', durationMs: 12300 },
    }
    expect(classifyRawOutput(frame as never, { childSession: false })).toBeUndefined()
  })

  it('cursor/generate_image 格式化为生成图片行', () => {
    const frame = {
      method: 'cursor/generate_image',
      params: { toolCallId: 'call_127', description: 'App icon', filePath: '/tmp/icon.png' },
    }
    const classified = classifyRawOutput(frame as never, { childSession: false })
    expect(classified).toMatchObject({ kind: 'cursor 生成图片', format: 'text' })
    expect((classified as { line: string }).line).toContain('App icon')
    expect((classified as { line: string }).line).toContain('/tmp/icon.png')
  })

  it('cursor/create_plan 是专用流程，不是未知输出', () => {
    expect(classifyRawOutput({ id: 5, method: 'cursor/create_plan', params: {} }, { childSession: false })).toBeUndefined()
  })

  it('summary 盖写出时的位置：遥测汇总在末段写出，就必须带末段的步骤号', () => {
    const agg = new RawOutputAggregator()
    agg.observe(update('usage_update', { a: 1 }), { turn: 1, step: 1 }, { childSession: false })
    agg.observe(update('session_info_update', { b: 1 }), { turn: 1, step: 1 }, { childSession: false })
    const blocks = agg.summary({ turn: 1, step: 2 })
    expect(blocks.map(block => ({ kind: block.kind, turn: block.turn, step: block.step }))).toEqual([
      { kind: 'usage_update', turn: 1, step: 2 },
      { kind: 'session_info_update', turn: 1, step: 2 },
    ])
  })

  it('summary 之后空段 flush 不出块', () => {
    const agg = new RawOutputAggregator()
    agg.observe(update('usage_update', { a: 1 }), AT, { childSession: false })
    expect(agg.summary(AT)).toHaveLength(1)
    expect(agg.summary(AT)).toHaveLength(0)
  })

  it('空段 flush 不出块', () => {
    const agg = new RawOutputAggregator()
    expect(agg.flush(AT)).toBeUndefined()
    agg.observe(REPLY, AT, { childSession: false })
    expect(agg.flush(AT)).toBeUndefined()
  })
})
