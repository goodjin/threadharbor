/**
 * Save-time repair of the session log's tool lifecycle.
 *
 * The host validates an appended event's payload and its surface intent, but
 * not the cross-event lifecycle: a second `tool/result` for one call is
 * accepted live and only rejected on the next load, at which point the whole
 * file is unreadable (`tool/result … has no advertised tool lifecycle`). That
 * gap is what turned a streaming writer bug into a session that could not be
 * opened at all.
 *
 * This guard closes the gap on the writes this plugin owns, and it repairs
 * rather than throws: a bad event is a log problem, not a reason to abort the
 * turn the user is watching. Two outcomes are possible:
 *
 * - a second append result for a call that already answered is rewritten into
 *   the one form the log accepts for "same call, newer content": a replacement
 *   of the current result node, content from the new event, identity fields
 *   verbatim from the node it shadows. The output is kept;
 * - a result that cannot be paired (no `message.toolCallId`, no started call,
 *   or no content to carry) is dropped and reported through `onAdjust`.
 *
 * Replacement results and every non-tool event pass through untouched. The
 * guard runs per session (or per child session) and only in the process that
 * owns that session's writes.
 */

import type { SessionAppend, SurfaceIntent } from './content-writer.ts'

const CALL = 'tool/call'
const RESULT = 'tool/result'

/** A write the guard changed or refused so the file stays loadable. */
export type LifecycleAdjustment =
  | { readonly kind: 'refined'; readonly callId: string }
  | { readonly kind: 'dropped'; readonly type: string; readonly callId?: string; readonly reason: string }

/** The guarded append: `undefined` means the event was dropped, not written. */
export type GuardedAppend = (
  type: string,
  payload: unknown,
  intent?: SurfaceIntent,
) => { readonly seq: number } | undefined

/**
 * Wrap one session's append so the tool lifecycle holds after every write.
 *
 * @param append - the session's append; successful writes return the host
 *   event's sequence number unchanged.
 * @param onAdjust - told when an event was rewritten or dropped, for logging.
 * @returns an append that keeps the log loadable instead of failing the turn.
 */
export function withLifecycleGuard(append: SessionAppend, onAdjust?: (adjustment: LifecycleAdjustment) => void): GuardedAppend {
  /** Calls written but not yet answered. */
  const started = new Set<string>()
  /** The current result node per call, and its identity without the content. */
  const current = new Map<string, { seq: number; envelope: Record<string, unknown> }>()

  const drop = (type: string, reason: string, callId?: string): undefined => {
    onAdjust?.({ kind: 'dropped', type, ...(callId === undefined ? {} : { callId }), reason })
    return undefined
  }

  return (type, payload, intent) => {
    if (type === CALL) {
      const id = stringField(payload, 'callId')
      // A second start for a call still in flight is the shape the load-time
      // validator refuses; the author meant one call, so keep the first.
      if (id !== undefined && started.has(id)) return drop(type, 'call is already started and not yet answered', id)
      const written = append(type, payload, intent)
      if (id !== undefined) {
        started.add(id)
        // Reusing an id after its result settled starts a new lifecycle; the
        // old node stays on the surface and a new result appends as a new node.
        current.delete(id)
      }
      return written
    }

    if (type === RESULT) {
      const id = resultCallId(payload)
      const replacing = typeof intent?.surfaceOp === 'object' && intent.surfaceOp?.op === 'replace'
      if (replacing) {
        const written = append(type, payload, intent)
        if (id !== undefined) {
          started.delete(id)
          current.set(id, { seq: written.seq, envelope: withoutContent(payload) })
        }
        return written
      }
      if (id === undefined) return drop(type, 'result has no message.toolCallId')

      const previous = current.get(id)
      if (previous !== undefined) {
        const content = contentOf(payload)
        if (content === undefined) return drop(type, 'result has no message.content array', id)
        const refined = { ...previous.envelope, message: { ...recordOf(previous.envelope['message']), content } }
        const written = append(type, refined, {
          surfaceOp: { op: 'replace', startSeq: previous.seq, endSeq: previous.seq },
          sourceEventSeqs: [previous.seq],
        })
        current.set(id, { seq: written.seq, envelope: withoutContent(refined) })
        onAdjust?.({ kind: 'refined', callId: id })
        return written
      }

      if (!started.has(id)) return drop(type, 'result has no started call behind it', id)
      const written = append(type, payload, intent)
      started.delete(id)
      current.set(id, { seq: written.seq, envelope: withoutContent(payload) })
      return written
    }

    return append(type, payload, intent)
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
}

function stringField(value: unknown, key: string): string | undefined {
  const field = recordOf(value)[key]
  return typeof field === 'string' ? field : undefined
}

/** The call a result answers: the host pairs by `message.toolCallId`. */
function resultCallId(payload: unknown): string | undefined {
  return stringField(recordOf(recordOf(payload)['message']), 'toolCallId')
}

function contentOf(payload: unknown): unknown[] | undefined {
  const content = recordOf(recordOf(payload)['message'])['content']
  return Array.isArray(content) ? content : undefined
}

/** The result payload with its content cleared: what a refinement keeps verbatim. */
function withoutContent(payload: unknown): Record<string, unknown> {
  const record = recordOf(payload)
  const message = record['message']
  if (typeof message !== 'object' || message === null) return record
  return { ...record, message: { ...(message as Record<string, unknown>), content: [] } }
}
