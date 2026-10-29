/**
 * grok 的后台任务生命周期（真机抓帧 2026-10-29，grok 1.0.70）。
 *
 * 抓的是一次 `sleep 20 && echo PROBE_DONE` 后台命令：grok 在
 * `session/prompt` 回执前先发 `_x.ai/task_backgrounded`，回执之后任务才结束，
 * 再发 `_x.ai/task_completed`（并自动唤醒一个新回合）。两个方法和子代理词汇
 * 一样是私有的，不认就只剩一屏原始 JSON，用户看不到「有个命令还在跑」。
 *
 * 这里钉三件事：两个方法被方言认领；归一后的 async_task 卡片带命令与状态；
 * 回合结束时任务没收尾，结果文本诚实地说 `[still running]`。
 */

import { describe, expect, it } from 'vitest'
import type { AcpFrame } from '../src/acp-client.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import { projectStepContent, projectToolCallAnnouncement, projectToolCallFrame } from '../src/projection.ts'
import { RawOutputAggregator, classifyRawOutput } from '../src/raw-output.ts'

const ROOT = 'root-session'
const TASK = 'c58f0a09-2848-4d96-a980-53afb700beb9'
const OUTPUT_FILE = '/tmp/grok-sessions/terminal/call-1.log'

/** One frame on a grok-private update method. */
const taskFrame = (method: string, update: Record<string, unknown>): AcpFrame => ({
  jsonrpc: '2.0',
  method,
  params: { sessionId: ROOT, update },
})

/** The real `_x.ai/task_backgrounded` payload, minus machine-local paths. */
const backgrounded = taskFrame('_x.ai/task_backgrounded', {
  sessionUpdate: 'task_backgrounded',
  tool_call_id: 'call-dddca577-d2a7-4e50-bd8f-338de99fa070-1',
  task_id: TASK,
  command: 'sleep 20 && echo PROBE_DONE',
  cwd: '/tmp/grok-bg-probe',
  output_file: OUTPUT_FILE,
  description: 'Start sleep then echo probe marker',
})

/** The real `_x.ai/task_completed` payload for a clean exit. */
const completed = (snapshot: Record<string, unknown> = {}): AcpFrame => taskFrame('_x.ai/task_completed', {
  sessionUpdate: 'task_completed',
  task_snapshot: {
    task_id: TASK,
    command: 'sleep 20 && echo PROBE_DONE',
    output: 'PROBE_DONE\n',
    exit_code: 0,
    signal: null,
    completed: true,
    explicitly_killed: false,
    ...snapshot,
  },
  will_wake: true,
})

const parentAnswer: AcpFrame = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: ROOT, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'BACKGROUND_STARTED' } } },
}

type CallPayload = { name: string; callId: string; arguments: string }
type ResultPayload = { message: { content: { text: string }[]; isError?: boolean } }

const callOf = (events: ReturnType<typeof projectStepContent>): CallPayload =>
  (events.find(event => event.type === 'tool/call')!.payload as CallPayload)
const resultOf = (events: ReturnType<typeof projectStepContent>): ResultPayload =>
  (events.find(event => event.type === 'tool/result')!.payload as ResultPayload)

describe('grok background task frames', () => {
  it('claims its two dedicated methods and leaves other vendor methods alone', () => {
    expect(grokDialect.frameUpdate!(backgrounded)).toMatchObject({ sessionUpdate: 'task_backgrounded' })
    expect(grokDialect.frameUpdate!(completed())).toMatchObject({ sessionUpdate: 'task_completed' })
    expect(grokDialect.frameUpdate!({ method: '_x.ai/something_else', params: { update: { sessionUpdate: 'x' } } })).toBeUndefined()
  })

  it('normalizes the start frame onto an async_task spawn with the command visible', () => {
    expect(grokDialect.normalizeSubagentUpdate!((backgrounded.params as { update: Record<string, unknown> }).update)).toEqual({
      sessionUpdate: 'async_task_spawned',
      asyncTaskId: TASK,
      name: 'Start sleep then echo probe marker',
      taskType: 'bash',
      description: 'sleep 20 && echo PROBE_DONE',
      outputFilePath: OUTPUT_FILE,
    })
  })

  it('normalizes completion onto a settled async task carrying the output', () => {
    expect(grokDialect.normalizeSubagentUpdate!((completed().params as { update: Record<string, unknown> }).update)).toEqual({
      sessionUpdate: 'async_task_state_update',
      asyncTaskId: TASK,
      state: 'completed',
      summary: '后台任务完成（退出码 0）\nPROBE_DONE',
    })
  })

  it('reports a non-zero exit or a kill as a failed/stopped task', () => {
    const failed = grokDialect.normalizeSubagentUpdate!({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: TASK, output: 'boom', exit_code: 2, completed: true, explicitly_killed: false },
    })
    expect(failed).toMatchObject({ state: 'failed' })
    expect((failed as { summary: string }).summary).toContain('退出码 2')

    const killed = grokDialect.normalizeSubagentUpdate!({
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: TASK, completed: false, explicitly_killed: true },
    })
    expect(killed).toMatchObject({ state: 'stopped' })
  })

  it('opens one async_task card and settles it with the output', () => {
    const events = projectStepContent([backgrounded, parentAnswer, completed()], {
      dialect: grokDialect,
      turn: 1,
      step: 1,
    })
    const call = callOf(events)
    expect(call.name).toBe('async_task')
    expect(call.callId).toBe(`task-${TASK}`)
    expect(JSON.parse(call.arguments)).toMatchObject({
      name: 'Start sleep then echo probe marker',
      description: 'sleep 20 && echo PROBE_DONE',
      taskType: 'bash',
    })
    const result = resultOf(events)
    expect(result.message.isError).toBe(false)
    const text = result.message.content.map(part => part.text).join('')
    expect(text).toContain('后台任务完成（退出码 0）')
    expect(text).toContain('PROBE_DONE')
  })

  it('opens the card through the live projectors the moment the start frame arrives', () => {
    const options = { turn: 1, step: 1, dialect: grokDialect }
    const card = projectToolCallFrame(backgrounded, options)
    expect(card).toBeDefined()
    const payload = card!.payload as CallPayload
    expect(payload.name).toBe('async_task')
    expect(payload.callId).toBe(`task-${TASK}`)
    expect(JSON.parse(payload.arguments)).toMatchObject({ name: 'Start sleep then echo probe marker' })

    const announcement = projectToolCallAnnouncement(backgrounded, options)
    expect(announcement).toBeDefined()
    const message = (announcement!.payload as { message: { content: { type: string; id: string; name: string }[] } }).message
    expect(message.content).toContainEqual(expect.objectContaining({
      type: 'tool-call',
      id: `task-${TASK}`,
      name: 'async_task',
    }))
  })

  it('says still running when grok ended the turn before the task finished', () => {
    const events = projectStepContent([backgrounded, parentAnswer], {
      dialect: grokDialect,
      turn: 1,
      step: 1,
    })
    const text = resultOf(events).message.content.map(part => part.text).join('')
    expect(text).toBe('[still running]')
  })

  it('keeps the raw frames out of the unknown-output block', () => {
    expect(classifyRawOutput(backgrounded, { childSession: false })).toBe('mapped')
    expect(classifyRawOutput(completed(), { childSession: false })).toBe('mapped')
  })

  it('shows the background_tasks snapshot live, with its running count', () => {
    const snapshot: AcpFrame = {
      jsonrpc: '2.0',
      method: '_x.ai/session_notification',
      params: {
        sessionId: ROOT,
        update: {
          sessionUpdate: 'background_tasks',
          tasks: [{ task_id: TASK, command: 'sleep 20 && echo PROBE_DONE', status: 'running' }],
        },
      },
    }
    const agg = new RawOutputAggregator()
    expect(agg.observe(snapshot, { turn: 1, step: 1 }, { childSession: false })).toBeUndefined()
    const block = agg.observe(parentAnswer, { turn: 1, step: 1 }, { childSession: false })
    expect(block).toBeDefined()
    expect(block!.kind).toBe('grok 后台任务')
    expect(block!.content).toContain('后台任务（1 个，1 个运行中）')
    expect(block!.content).toContain('「sleep 20 && echo PROBE_DONE」（运行中）')
    // No turn-end tally: this line was already written live.
    expect(agg.summary({ turn: 1, step: 1 })).toEqual([])
  })
})
