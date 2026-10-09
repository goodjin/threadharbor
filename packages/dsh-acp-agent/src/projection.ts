/**
 * Translate one turn of ACP session updates into DSH session events.
 *
 * The projection itself is agent-agnostic: every field-reading decision is
 * delegated to an `AcpDialect`, because the three agents we drive disagree
 * about where a tool's name lives, where its output lives, and how it reports
 * tokens. What lives here is the shape of a DSH turn, which is fixed.
 */

import { randomUUID } from 'node:crypto'
import type { AcpFrame } from './acp-client.ts'
import type { AcpDialect, ToolCall } from './dialects/types.ts'

/** The DSH event names this projection writes. */
export type ProjectionEvent = { readonly type: string; readonly payload: unknown }

type Accumulator = {
  thought: readonly string[]
  text: readonly string[]
  readonly tools: Map<string, ToolCall>
  totalTokens?: number | undefined
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOf(content: unknown): string {
  const entry = recordOf(content)
  return typeof entry['text'] === 'string' ? (entry['text'] as string) : ''
}

function assistantEvent(
  dialect: AcpDialect,
  acc: Accumulator,
  content: readonly { type: 'text' | 'reasoning'; text: string }[],
  turn: number,
): ProjectionEvent {
  return {
    type: 'assistant/message',
    payload: {
      turn,
      step: 1,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content,
        source: { provider: `acp-${dialect.id}`, model: dialect.id },
      },
      stream: [],
      usage: acc.totalTokens === undefined ? undefined : { inputTokens: 0, outputTokens: acc.totalTokens },
    },
  }
}

/**
 * Fold one turn's ACP frames into the events that describe it.
 *
 * Returns an ordered event list; an empty list means the frames carried
 * nothing the session log records. The caller appends them in order.
 */
export function projectTurn(
  frames: readonly AcpFrame[],
  options: { readonly turn: number; readonly dialect: AcpDialect },
): ProjectionEvent[] {
  const { dialect, turn } = options
  return [
    { type: 'turn/start', payload: { turn } },
    { type: 'step/start', payload: { turn, step: 1 } },
    ...contentEvents(accumulate(frames, dialect), { dialect, turn, step: 1 }),
    { type: 'step/end', payload: { turn, step: 1 } },
    { type: 'turn/end', payload: { turn } },
  ]
}

/**
 * The model-visible events of one step, without the boundaries around them.
 *
 * For a plugin that replaces the loop's `step`: the surrounding native loop still
 * appends `step/start` before the call and `step/end` in its finally, so emitting
 * boundaries here too would write each one twice into the session log.
 */
export function projectStepContent(
  frames: readonly AcpFrame[],
  options: { readonly turn: number; readonly step: number; readonly dialect: AcpDialect },
): ProjectionEvent[] {
  const { dialect, turn, step } = options
  return contentEvents(accumulate(frames, dialect), { dialect, turn, step })
}

function accumulate(frames: readonly AcpFrame[], dialect: AcpDialect): Accumulator {
  const thought: string[] = []
  const text: string[] = []
  const tools = new Map<string, ToolCall>()
  let totalTokens: number | undefined

  for (const frame of frames) {
    if (frame.method !== 'session/update') continue
    const params = recordOf(frame.params)
    const update = recordOf(params['update'])
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind === 'agent_thought_chunk') thought.push(textOf(update['content']))
    else if (kind === 'agent_message_chunk') text.push(textOf(update['content']))
    else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const carried = typeof update['toolCallId'] === 'string' ? tools.get(update['toolCallId']) : undefined
      const call = dialect.foldTool(carried, update)
      tools.set(call.callId, call)
    } else if (!dialect.isContent(update)) {
      // chatter — setup phases, command lists, context-window updates
    }
    const reported = dialect.readUpdateTokens(params)
    if (reported !== undefined) totalTokens = reported
  }

  return { thought, text, tools, totalTokens }
}

function contentEvents(
  acc: Accumulator,
  options: { readonly dialect: AcpDialect; readonly turn: number; readonly step: number },
): ProjectionEvent[] {
  const { dialect, turn, step } = options
  const { thought, text, tools, totalTokens } = acc
  const events: ProjectionEvent[] = []
  if (thought.length > 0) {
    events.push(assistantEvent(dialect, acc, [{ type: 'reasoning', text: thought.join('') }], turn))
  }
  if (text.length > 0) {
    events.push(assistantEvent(dialect, acc, [{ type: 'text', text: text.join('') }], turn))
  }
  for (const tool of tools.values()) {
    events.push({
      type: 'tool/call',
      payload: { turn, step, callId: tool.callId, name: tool.name, arguments: JSON.stringify(tool.arguments) },
    })
    const isError = tool.status === 'failed'
    events.push({
      type: 'tool/result',
      payload: {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'tool',
          content: tool.output.length > 0 ? [{ type: 'text', text: tool.output }] : [],
          source: { kind: 'tool', callId: tool.callId },
          toolCallId: tool.callId,
          isError,
        },
        ...(isError ? { error: { name: 'tool', code: tool.status ?? 'failed', reason: tool.title } } : {}),
      },
    })
  }
  return events
}

/** The user turn's own event, appended before the agent starts work. */
export function projectUserMessage(text: string, turn: number): ProjectionEvent[] {
  return [
    { type: 'user/message', payload: { turn, message: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { source: 'user' } } } },
    { type: 'turn/start', payload: { turn } },
  ]
}