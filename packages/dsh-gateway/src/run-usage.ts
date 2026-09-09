/** Best-effort token-usage capture from backend-native frames.
 *
 *  Each backend reports usage differently and only sometimes; these helpers
 *  stay tolerant and never fabricate a number:
 *
 *  - Codex / Claude ACP: the `session/prompt` RPC response carries a
 *    per-prompt-turn breakdown under `result.usage`
 *    (`{inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, …}`).
 *  - Grok: same response carries it under `result._meta.usage`; cache writes
 *    are reported as `cacheCreationTokens` and cache reads as
 *    `cachedReadTokens` (plus `reasoningTokens`).
 *  - DeepSeek Harness: usage arrives inside `session.event` stream payloads
 *    (`data.chunk.usage` / `data.usage`, fields `inputTokens`,
 *    `outputTokens`, `cacheReadTokens`, `reasoningTokens`, …) once per
 *    request, so values are summed while a round is open.
 *
 *  Usage is attached (in the gateway projection) to the round's terminal
 *  status row so the browser can show "last round" numbers without carrying
 *  telemetry through the whole transcript. If nothing was reported, no
 *  `usage` field is emitted at all and the UI drops those groups.
 */

import type { JsonValue, RemoteAgentBackend, RemoteTranscriptUsage } from '@threadharbor/protocol'

/** Result of inspecting one frame for usage. */
export interface FrameUsageReading {
  readonly usage: RemoteTranscriptUsage
  /** ACP prompt responses are per-turn cumulative → replace; DSH stream
   *  payloads are per-request → sum while the round is open. */
  readonly accumulate: 'replace' | 'sum'
}

function record(value: JsonValue | undefined): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function numeric(source: Record<string, unknown> | undefined, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

function asUsage(source: Record<string, unknown> | undefined): RemoteTranscriptUsage {
  const input = numeric(source, 'inputTokens', 'uncachedInputTokens', 'input_tokens')
  const output = numeric(source, 'outputTokens', 'completionTokens', 'output_tokens')
  const cachedRead = numeric(
    source,
    'cachedReadTokens', 'cacheReadTokens', 'cachedReadInputTokens', 'cached_input_tokens', 'cache_read_input_tokens',
  )
  const cachedWrite = numeric(
    source,
    'cachedWriteTokens', 'cacheWriteTokens', 'cacheCreationTokens', 'cache_creation_input_tokens',
  )
  const reasoning = numeric(source, 'reasoningTokens', 'reasoning_tokens', 'reasoningOutputTokens')
  const total = numeric(source, 'totalTokens', 'total_tokens')
  const entries: Array<[keyof RemoteTranscriptUsage, number]> = []
  if (input !== undefined) entries.push(['inputTokens', input])
  if (output !== undefined) entries.push(['outputTokens', output])
  if (cachedRead !== undefined) entries.push(['cachedReadTokens', cachedRead])
  if (cachedWrite !== undefined) entries.push(['cachedWriteTokens', cachedWrite])
  if (reasoning !== undefined) entries.push(['reasoningTokens', reasoning])
  if (total !== undefined) entries.push(['totalTokens', total])
  return Object.fromEntries(entries) as RemoteTranscriptUsage
}

function hasNumbers(usage: RemoteTranscriptUsage): boolean {
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined
    || usage.cachedReadTokens !== undefined || usage.cachedWriteTokens !== undefined
    || usage.reasoningTokens !== undefined || usage.totalTokens !== undefined
}

/** First source that yields at least one numeric usage field. */
function firstUsage(...sources: readonly (Record<string, unknown> | undefined)[]): RemoteTranscriptUsage | undefined {
  for (const source of sources) {
    const usage = asUsage(source)
    if (hasNumbers(usage)) return usage
  }
  return undefined
}

/** ACP prompt response: `{"jsonrpc","id","result":{…, usage?|_meta:{usage?}}}`. */
function responseUsage(frame: JsonValue): FrameUsageReading | undefined {
  const recordValue = record(frame)
  if (recordValue === undefined || typeof recordValue['method'] === 'string') return undefined
  const result = record(recordValue['result'] as JsonValue)
  if (result === undefined) return undefined
  const meta = record(result['_meta'] as JsonValue)
  const usage = firstUsage(record(result['usage'] as JsonValue), record(meta?.['usage'] as JsonValue))
  if (usage === undefined) return undefined
  return { usage, accumulate: 'replace' }
}

/** DSH stream payloads: `session.event` with `chunk.usage` / `data.usage`. */
function eventUsage(frame: JsonValue): FrameUsageReading | undefined {
  const frameRecord = record(frame)
  if (frameRecord?.['method'] !== 'session.event') return undefined
  const params = record(frameRecord['params'] as JsonValue)
  const event = record(params?.['event'] as JsonValue)
  if (event === undefined || typeof event['type'] !== 'string') return undefined
  const data = record(event['data'] as JsonValue)
  const chunk = record(data?.['chunk'] as JsonValue)
  const usage = firstUsage(record(chunk?.['usage'] as JsonValue), record(data?.['usage'] as JsonValue))
  if (usage === undefined) return undefined
  return { usage, accumulate: 'sum' }
}

/**
 * Read one native frame for usage data. Tolerant of both flat numbers and
 * the common nested locations; fields that are absent stay absent.
 * @param backend - session backend (affects where usage may hide).
 * @param frame - one journaled native frame.
 * @returns a usage reading, or `undefined` when the frame carries none.
 */
export function frameUsageReading(backend: RemoteAgentBackend, frame: JsonValue): FrameUsageReading | undefined {
  return backend === 'dsh' ? eventUsage(frame) ?? responseUsage(frame) : responseUsage(frame) ?? eventUsage(frame)
}

/** Round-completion frames that should carry the collected usage. */
export function isRoundTerminalFrame(backend: RemoteAgentBackend, frame: JsonValue): boolean {
  const recordValue = record(frame)
  if (recordValue === undefined) return false
  const method = recordValue['method']
  if (method === '_x.ai/session/prompt_complete') return true
  if (method === '_dsh/transport_closed' || method === '_dsh/transport_error') return true
  if (method === 'session.status') {
    const params = record(recordValue['params'] as JsonValue)
    return params?.['status'] === 'idle' || params?.['running'] === false
  }
  if (method !== 'session.event' || backend !== 'dsh') return false
  const params = record(recordValue['params'] as JsonValue)
  const event = record(params?.['event'] as JsonValue)
  return event?.['type'] === 'turn/end'
}

function add(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0)
}

/**
 * Fold one reading into the round's running totals.
 * @param current - previously collected usage for this round.
 * @param reading - new reading.
 * @returns the merged usage (mutable-safe: builds a fresh object).
 */
export function mergeUsage(
  current: RemoteTranscriptUsage | undefined,
  reading: FrameUsageReading | undefined,
): RemoteTranscriptUsage | undefined {
  if (reading === undefined) return current
  const next = reading.usage
  if (current === undefined || reading.accumulate === 'replace') return next
  const entries: Array<[keyof RemoteTranscriptUsage, number]> = []
  const keys = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens', 'reasoningTokens', 'totalTokens'] as const
  for (const key of keys) {
    const summed = add(current[key], next[key])
    if (summed !== undefined) entries.push([key, summed])
  }
  return Object.fromEntries(entries) as RemoteTranscriptUsage
}
