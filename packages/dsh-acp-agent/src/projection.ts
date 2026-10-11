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
import type { AcpDialect, ToolCall, TurnUsage } from './dialects/types.ts'

/**
 * One packed run of deltas, as the durable message embeds it.
 *
 * Lives here rather than with the stream writer: it is part of the message
 * shape on the wire, and the projection that writes that shape must not have to
 * depend on the package that streams it.
 */
export type StreamRecord =
  | { readonly type: 'text-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly texts: readonly string[] }
  | { readonly type: 'reasoning-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly texts: readonly string[] }

/** The DSH event names this projection writes. */
export type ProjectionEvent = { readonly type: string; readonly payload: unknown }

type Accumulator = {
  thought: readonly string[]
  text: readonly string[]
  readonly tools: Map<string, ToolCall>
  /** The turn's usage, when the agent reported one complete enough to write. */
  usage?: TurnUsage | undefined
  /** The compacted live stream, filled in when the turn ran with streaming on. */
  stream?: readonly StreamRecord[]
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
  step: number,
): ProjectionEvent {
  // DSH's `TokenUsage` requires the input/output pair; anything less is
  // not a usage but a fragment, and DSH's own token projection computes
  // its uncached-input bucket straight from `usage.inputTokens` — a
  // fragment there turned that bucket into `NaN` and made every later
  // history load of the session fail. Optional buckets ride along only
  // when the agent reported them; a missing report is never written as 0.
  const usage = writableUsage(acc.usage)
  return {
    type: 'assistant/message',
    payload: withoutNonFinite({
      turn,
      step,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content,
        // The host's own replay validation (core/session `assertMessageEventShape`)
        // requires a model source: `kind: 'model'` plus provider and model. A
        // source without `kind` appends fine but fails the session at fork time.
        source: { kind: 'model', provider: `acp-${dialect.id}`, model: dialect.id },
      },
      stream: acc.stream ?? [],
      ...(usage === undefined ? {} : { usage }),
    }),
  }
}

/**
 * The usage as the session log may carry it, or nothing.
 *
 * The required pair must both be finite non-negative integers — that is the
 * same bar DSH's own token meter applies before it believes a usage. One
 * missing or broken half means the agent reported no usable usage, and a
 * fragment must not be written: there is no honest way to fill it in.
 */
function writableUsage(usage: TurnUsage | undefined): TurnUsage | undefined {
  if (usage === undefined) return undefined
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return undefined
  const buckets = {
    ...optionalBucket(usage.cacheReadTokens, 'cacheReadTokens'),
    ...optionalBucket(usage.cacheWriteTokens, 'cacheWriteTokens'),
    ...optionalBucket(usage.reasoningTokens, 'reasoningTokens'),
    ...optionalBucket(usage.totalTokens, 'totalTokens'),
  }
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...buckets }
}

/** DSH's own bar for a believable count: a safe, finite, non-negative integer. */
function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/** One optional bucket, kept only when the agent reported a believable count. */
function optionalBucket(value: number | undefined, name: keyof TurnUsage): Partial<TurnUsage> {
  return value !== undefined && isCount(value) ? { [name]: value } : {}
}

/**
 * The projection's last gate: a number that is not finite never reaches an
 * event.
 *
 * JSON has no way to carry NaN or Infinity, but a frame value like `1e999`
 * parses into exactly that, and the session log's writer rejects a whole
 * event on the first unrepresentable number — one bad field would take the
 * turn's answer down with it. This walk drops such a field instead, keeping
 * the event; values it does not touch are returned as the same reference, so
 * the happy path stays allocation-free.
 */
export function withoutNonFinite<T>(value: T): T {
  return clean(value) === DROP ? value : (clean(value) as T)
}

/** Signals "this value cannot be written"; never escapes the module. */
const DROP = Symbol('non-finite')

function clean(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : DROP
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined
    for (let index = 0; index < value.length; index++) {
      const item = clean(value[index])
      if (item === DROP) { copy ??= value.slice(0, index); continue }
      if (item !== value[index] && copy === undefined) copy = value.slice(0, index)
      copy?.push(item)
    }
    return copy ?? value
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    let copy: Record<string, unknown> | undefined
    for (const [key, member] of Object.entries(source)) {
      const cleanedMember = clean(member)
      if (cleanedMember === DROP) {
        copy ??= {}
        for (const [kept, keptValue] of Object.entries(source)) {
          if (kept === key) break
          copy[kept] = keptValue
        }
        continue
      }
      if (cleanedMember !== member && copy === undefined) {
        copy = {}
        for (const [kept, keptValue] of Object.entries(source)) {
          if (kept === key) break
          copy[kept] = keptValue
        }
      }
      if (copy !== undefined) copy[key] = cleanedMember
    }
    return copy ?? value
  }
  return value
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
  options: {
    readonly turn: number
    readonly step: number
    readonly dialect: AcpDialect
    /**
     * The compacted live stream, when the turn ran with streaming on.
     *
     * Without it the durable message carries `stream: []`: the user watches the
     * text arrive, reloads, and finds it gone. That is the whole transcript
     * disagreeing with what was just on screen.
     */
    readonly stream?: readonly StreamRecord[]
  },
): ProjectionEvent[] {
  const { dialect, turn, step } = options
  return contentEvents(accumulate(frames, dialect), {
    dialect,
    turn,
    step,
    ...(options.stream === undefined ? {} : { stream: options.stream }),
  })
}

function accumulate(frames: readonly AcpFrame[], dialect: AcpDialect): Accumulator {
  const thought: string[] = []
  const text: string[] = []
  const tools = new Map<string, ToolCall>()
  let usage: TurnUsage | undefined

  for (const frame of frames) {
    if (frame.method === undefined) {
      // A reply frame — within a turn the only request this side sends is
      // `session/prompt`, so its reply is the one frame carrying usage. The
      // handshake replies (initialize, session/new) never reach a turn's
      // frames: they are answered while the session is being opened.
      if (frame.result !== undefined) usage = dialect.readReplyUsage(frame.result)
      continue
    }
    if (frame.method !== 'session/update') continue
    const update = recordOf(recordOf(frame.params)['update'])
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
  }

  return { thought, text, tools, usage }
}

function contentEvents(
  acc: Accumulator,
  options: {
    readonly dialect: AcpDialect
    readonly turn: number
    readonly step: number
    readonly stream?: readonly StreamRecord[]
  },
): ProjectionEvent[] {
  const { dialect, turn, step } = options
  if (options.stream !== undefined) acc.stream = options.stream
  const { thought, text, tools } = acc
  const events: ProjectionEvent[] = []
  // One message per step, in the canonical native shape: the ordered blocks
  // carry the reasoning first, then the answer. Two separate messages would
  // survive in the log, but the conversation view folds each step's message
  // into one node by keeping the LAST assistant/message — a second message
  // would erase the first on screen.
  const content = [
    ...(thought.length > 0 ? [{ type: 'reasoning' as const, text: thought.join('') }] : []),
    ...(text.length > 0 ? [{ type: 'text' as const, text: text.join('') }] : []),
  ]
  if (content.length > 0) events.push(assistantEvent(dialect, acc, content, turn, step))
  for (const tool of tools.values()) {
    events.push({
      type: 'tool/call',
      payload: withoutNonFinite({ turn, step, callId: tool.callId, name: tool.name, arguments: JSON.stringify(tool.arguments) }),
    })
    const isError = tool.status === 'failed'
    events.push({
      type: 'tool/result',
      payload: withoutNonFinite({
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
      }),
    })
  }
  return events
}

/** The user turn's own event, appended before the agent starts work. */
export function projectUserMessage(text: string, turn: number): ProjectionEvent[] {
  return [
    { type: 'user/message', payload: withoutNonFinite({ turn, message: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }) },
    { type: 'turn/start', payload: { turn } },
  ]
}