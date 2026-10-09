/**
 * Translate Grok ACP session updates into DSH session events.
 *
 * This is the part of the port that carries the real risk, so the mapping is
 * kept pure and separately testable: ACP frames in, DSH `Session.append`
 * calls out. Frame shapes were read off a live `grok agent serve`, not guessed:
 *
 *   session/update → { update: { sessionUpdate, content: { type, text } },
 *                      _meta: { totalTokens, eventId, promptId, ... } }
 *
 * `agent_thought_chunk` becomes a `reasoning` content block and
 * `agent_message_chunk` a `text` block — the same two block types DSH's own
 * loop emits. Token counts survive in `_meta.totalTokens`, which the native
 * path drops on cross-agent carry.
 */

import { randomUUID } from 'node:crypto'
import type { AcpFrame } from './acp-client.ts'

/** The DSH event names this projection writes. */
export type ProjectionEvent = { readonly type: string; readonly payload: unknown }

/** One tool call reported by the external agent, carried as-is. */
export type ReportedToolCall = {
  readonly callId: string
  /** Tool identity, taken from the opening `tool_call` only. */
  name: string
  /** Raw arguments exactly as the external agent produced them. */
  arguments: unknown
  /** Human-readable activity line, which later updates overwrite the title with. */
  title?: string | undefined
  status?: string | undefined
  /** Output text harvested from the final update. */
  output: string
}

type Accumulator = {
  thought: string[]
  text: string[]
  /** Tool calls seen in this turn, keyed by ACP toolCallId. */
  readonly tools: Map<string, ReportedToolCall>
  totalTokens?: number
}

function newAccumulator(): Accumulator {
  return { thought: [], text: [], tools: new Map() }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOf(content: unknown): string {
  const record = recordOf(content)
  return typeof record['text'] === 'string' ? record['text'] : ''
}

/**
 * Harvest the tool's output text from an ACP content list.
 *
 * Grok nests one extra level: `[{ type: 'content', content: { type: 'text',
 * text } }]`. Both that and a flat `[{ type: 'text', text }]` are accepted, and
 * an empty in-progress chunk yields '' so the previous output is kept.
 */
function outputText(content: unknown): string {
  if (!Array.isArray(content)) return textOf(content)
  const parts: string[] = []
  for (const item of content) {
    const record = recordOf(item)
    const inner = record['content'] === undefined ? record : recordOf(record['content'])
    const text = textOf(inner)
    if (text.length > 0) parts.push(text)
  }
  return parts.join('')
}

/**
 * Fold one turn's ACP updates into the events that describe it.
 *
 * Returns an ordered event list; an empty list means the frame carried nothing
 * the session log records. The caller appends them in order.
 */
export function projectTurn(frames: readonly AcpFrame[], options: { readonly turn: number }): ProjectionEvent[] {
  const acc = newAccumulator()
  for (const frame of frames) {
    if (frame.method !== 'session/update') continue
    const params = recordOf(frame.params)
    const update = recordOf(params['update'])
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind === 'agent_thought_chunk') acc.thought.push(textOf(update['content']))
    else if (kind === 'agent_message_chunk') acc.text.push(textOf(update['content']))
    else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : randomUUID()
      const existing = acc.tools.get(toolCallId)
      // The opening `tool_call` carries the tool identity; every later
      // `tool_call_update` overwrites `title` with a human-readable activity
      // line ("Execute `echo ...`"), so only the first one may set `name`.
      const name = existing?.name ?? (typeof update['title'] === 'string' ? update['title'] : 'tool')
      const text = outputText(update['content'])
      acc.tools.set(toolCallId, {
        callId: toolCallId,
        name,
        arguments: update['rawInput'] ?? existing?.arguments ?? {},
        title: typeof update['title'] === 'string' ? update['title'] : existing?.title,
        status: typeof update['status'] === 'string' ? update['status'] : existing?.status,
        output: text.length > 0 ? text : (existing?.output ?? ''),
      })
    }
    const meta = recordOf(params['_meta'])
    if (typeof meta['totalTokens'] === 'number') acc.totalTokens = meta['totalTokens']
  }

  const events: ProjectionEvent[] = []
  events.push({ type: 'turn/start', payload: { turn: options.turn } })
  events.push({ type: 'step/start', payload: { turn: options.turn, step: 1 } })

  if (acc.thought.length > 0) {
    events.push(assistantEvent(acc, [{ type: 'reasoning', text: acc.thought.join('') }], options.turn))
  }
  if (acc.text.length > 0) {
    events.push(assistantEvent(acc, [{ type: 'text', text: acc.text.join('') }], options.turn))
  }
  for (const tool of acc.tools.values()) {
    events.push({
      type: 'tool/call',
      payload: { turn: options.turn, step: 1, callId: tool.callId, name: tool.name, arguments: JSON.stringify(tool.arguments) },
    })
    const isError = tool.status === 'failed'
    events.push({
      type: 'tool/result',
      payload: {
        turn: options.turn,
        step: 1,
        message: {
          id: randomUUID(),
          role: 'tool',
          content: tool.output.length > 0 ? [{ type: 'text', text: tool.output }] : [],
          source: { kind: 'tool', callId: tool.callId },
          toolCallId: tool.callId,
          isError,
        },
        error: isError ? { name: 'tool', code: tool.status ?? 'failed', reason: tool.title } : undefined,
      },
    })
  }

  events.push({ type: 'step/end', payload: { turn: options.turn, step: 1 } })
  events.push({ type: 'turn/end', payload: { turn: options.turn } })
  return events
}

function assistantEvent(
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
        source: { provider: 'grok-acp', model: 'grok' },
      },
      stream: [],
      usage: acc.totalTokens === undefined ? undefined : { inputTokens: 0, outputTokens: acc.totalTokens },
    },
  }
}

/** The user turn's own event, appended before the agent starts work. */
export function projectUserMessage(text: string, turn: number): ProjectionEvent[] {
  return [
    { type: 'user/message', payload: { turn, message: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { source: 'user' } } } },
    { type: 'turn/start', payload: { turn } },
  ]
}