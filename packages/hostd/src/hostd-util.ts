/** Process-level helpers shared by the detached agent processes.
 *
 * These belong to the *process*, not to a session: one stderr trace stream, one
 * frame-log toggle, one journal-metrics toggle. The single-session hold worker
 * and the shared bridge both use them, which is why they live outside both.
 */

import type { RawData } from 'ws'
import type { JsonValue } from '@threadharbor/protocol'

/** Serialize one value as a single newline-delimited JSON line. */
export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/** Decode a WebSocket message payload into text. */
export function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/** Journal append/compaction metrics: on in non-test runs unless silenced. */
export function journalMetricsEnabled(): boolean {
  return process.env['THREADHARBOR_HOLD_JOURNAL_METRICS'] !== '0' && process.env['NODE_ENV'] !== 'test'
}

/** Trace toggle: default ON in non-test runs so latency investigations always
 *  have data; explicit `THREADHARBOR_TRACE=0` silences. */
export function traceEnabled(): boolean {
  return process.env['THREADHARBOR_TRACE'] !== '0' && process.env['NODE_ENV'] !== 'test'
}

/** Emit one structured trace line for an in-process stage. */
export function trace(stage: string, fields: Record<string, unknown>): void {
  if (!traceEnabled()) return
  const parts = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  process.stderr.write(`threadharbor-hostd ${stage} ${parts}\n`)
}

/** Opt-in verbatim native frame dump for upstream protocol analysis.
 *
 *  Turned off by default; enable with `THREADHARBOR_FRAME_LOG=1` on the hostd
 *  process (the toggle is inherited by detached agent processes). Treat every
 *  logged line as sensitive: frames may embed tool input/output or model
 *  content. The per-line cap keeps runaway payloads from flooding the log.
 */
export function frameLogEnabled(): boolean {
  return process.env['THREADHARBOR_FRAME_LOG'] === '1' || process.env['THREADHARBOR_FRAME_LOG'] === 'true'
}

export function frameLogMax(): number {
  const raw = process.env['THREADHARBOR_FRAME_LOG_MAX']
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 32_768
}

/** Truncate a serialized frame line without breaking the JSON tail markers
 *  the analysis tooling greps for. */
export function truncateFrameLine(line: string, max: number): string {
  if (line.length <= max) return line
  return `${line.slice(0, Math.max(0, max - 16))}…[truncated ${line.length - max} chars]`
}

/** Emit one verbatim native frame line to stderr for protocol analysis. */
export function logNativeFrame(direction: 'in' | 'out', frame: unknown, max: number): void {
  if (!frameLogEnabled()) return
  const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame)
    ? frame as Record<string, unknown> : undefined
  const method = record?.['method']
  const id = record?.['id']
  const line = truncateFrameLine(
    `threadharbor-hostd frame-${direction} ${typeof method === 'string' ? `method=${method}` : 'method='}`
      + `${id === undefined ? '' : ` id=${typeof id === 'string' ? id : String(id)}`} frame=${jsonLine(frame).trim()}`,
    max,
  )
  process.stderr.write(`${line}\n`)
}

/** Longest conversation text hostd will hand to an Agent as recovered context.
 *
 *  Roughly 24k tokens of mixed Chinese and English. Past this the seed costs
 *  more than it is worth: the model spends its budget re-reading a transcript
 *  instead of working, and the caller is told it was cut rather than quietly
 *  losing the beginning. */
export const CONTEXT_SEED_MAX_CHARS = 80_000

/** Conversation text offered on attach, so a session whose Agent state cannot be
 *  reopened still starts with the discussion in front of the model. */
export interface SessionContextSeed {
  readonly transcript: string
  readonly truncated: boolean
}

/** Read the optional context seed off an attach request, bounded and validated.
 *  Malformed input is ignored rather than fatal: the seed is a courtesy, and a
 *  bad one must not be the reason an attach fails. */
export function optionalSessionContext(params: Record<string, JsonValue>): SessionContextSeed | undefined {
  const raw = params['context']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, JsonValue>
  const transcript = record['transcript']
  if (typeof transcript !== 'string' || transcript.trim() === '') return undefined
  // Keep the newest end of the conversation: the most recent turns are what the
  // model needs to continue, and the opening "hello" is the least useful part.
  const clipped = transcript.length > CONTEXT_SEED_MAX_CHARS
    ? transcript.slice(transcript.length - CONTEXT_SEED_MAX_CHARS)
    : transcript
  return { transcript: clipped, truncated: clipped.length < transcript.length || record['truncated'] === true }
}
