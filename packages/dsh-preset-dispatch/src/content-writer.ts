/**
 * Writing projected content back onto the session.
 *
 * The three event types are not interchangeable at the call site, and getting
 * it wrong fails quietly rather than loudly:
 *
 * - a message is a *surface* event, so its append must carry a surface intent;
 * - a tool call is *log-only*, where a third argument is not merely useless but
 *   rejected — passing one loses the event;
 * - a tool result is a surface event that must point back at the call it
 *   answers, by sequence number. Without that link the result lands in the
 *   transcript as an orphan no surface can pair it with.
 *
 * So the shape is decided once, here, rather than at each call site.
 *
 * Facts verified against `reference/deepseek-harness` @ 5badb15009:
 * `session/src/index.ts:718-722` (append signature),
 * `session/src/types.ts:439-478` (which events take an intent, and which are
 * forbidden one), `agent-loop/src/tool-calls.ts:263-289` (the two tool shapes).
 */

import type { ContentEvent } from './dispatch.ts'

/** What `session.append` gives back, and all this needs of it. */
export type SessionAppend = (
  type: string,
  payload: unknown,
  intent?: { surfaceOp?: string; sourceEventSeqs?: readonly number[] },
) => { readonly seq: number }

/**
 * Append the events, in order; returns the assistant message's sequence number.
 *
 * The number comes back because the live stream's closing frame points at it —
 * that frame is how the UI knows the text it watched arrive is now findable in
 * the transcript. Returning it is what lets the turn settle its stream without
 * reaching back into the session afterwards.
 */
export type ContentWriter = (events: readonly ContentEvent[]) => number | undefined

/** Tool result, and the call it answers, as they are numbered. */
type PairKey = `${number}:${string}`

const CALL = 'tool/call'
const RESULT = 'tool/result'
const MESSAGE = 'assistant/message'

/**
 * Build a writer bound to one session.
 *
 * `onOrphan` is told when a result arrives with no call behind it. The result is
 * still written: dropping it would lose the agent's output, and an unpaired
 * result is easier to recover from than a missing one.
 */
export function makeContentWriter(append: SessionAppend, onOrphan?: (callId: string) => void): ContentWriter {
  // Keyed by turn as well as call id: turn numbers restart, so a call id reused
  // in a later turn must not pick up an earlier turn's sequence number.
  const answers = new Map<PairKey, number>()

  return (events): number | undefined => {
    let written: number | undefined
    for (const event of events) {
      if (event.type === CALL) {
        const { seq } = append(CALL, event.payload)
        const { turn, callId } = parts(event.payload)
        if (callId !== undefined) answers.set(key(turn, callId), seq)
        continue
      }
      if (event.type === RESULT) {
        const { turn, callId } = parts(event.payload)
        const seq = callId === undefined ? undefined : answers.get(key(turn, callId))
        if (callId !== undefined && seq === undefined) onOrphan?.(callId)
        append(RESULT, event.payload, {
          surfaceOp: 'append',
          ...(seq === undefined ? {} : { sourceEventSeqs: [seq] }),
        })
        continue
      }
      if (event.type === MESSAGE) {
        written = append(MESSAGE, event.payload, { surfaceOp: 'append' }).seq
      }
      // Anything else is not ours to write: a guessed shape corrupts the
      // transcript in a way nothing downstream can detect.
    }
    return written
  }
}

function key(turn: number, callId: string): PairKey {
  return `${turn}:${callId}`
}

function parts(payload: unknown): { turn: number; callId: string | undefined } {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const turn = typeof record['turn'] === 'number' ? record['turn'] : 0
  const inner = record['message']
  const fromMessage = (typeof inner === 'object' && inner !== null ? inner : {}) as Record<string, unknown>
  const callId = typeof record['callId'] === 'string'
    ? record['callId']
    : typeof fromMessage['toolCallId'] === 'string' ? fromMessage['toolCallId'] : undefined
  return { turn, callId }
}