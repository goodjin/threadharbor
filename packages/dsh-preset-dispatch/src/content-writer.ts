/**
 * Writing projected content back onto the session.
 *
 * The four event types are not interchangeable at the call site, and getting
 * it wrong fails quietly rather than loudly:
 *
 * - a user message is a *surface* event with no turn of its own: the loop owns
 *   the boundaries, so the claimed message object is appended as it stands
 *   (the native step commits them the same way, `agent-loop/src/agent.ts:419-423`
 *   — the replaced step inherits that duty, or the question vanishes from the
 *   transcript entirely);
 * - a model message is a *surface* event, so its append must carry a surface intent;
 * - a tool call is *log-only*, where a third argument is not merely useless but
 *   rejected — passing one loses the event;
 * - a tool result is a surface event that must point back at the call it
 *   answers, by sequence number. Without that link the result lands in the
 *   transcript as an orphan no surface can pair it with.
 *
 * So the shape is decided once, here, rather than at each call site.
 *
 * One event in the list is this plugin's own and never reaches the log as
 * itself: `acp/undelivered` is the runner's record of attachments the external
 * agent did not receive (a capability table that says no, or a block kind no
 * agent takes). The writer expands it into the paired `tool/call` +
 * `tool/result`(isError) the host's own vocabulary carries — both are known
 * session event types, verified against
 * `reference/deepseek-harness/packages/core/session/src/known-event-types.ts`.
 * A lone `tool/result` would be an orphan and a same-step `assistant/message`
 * would erase the answer (the conversation view keeps only the last
 * assistant/message of a step), so the pair is the one shape that is both
 * reload-safe and visible. It expands BEFORE the projected events, and since
 * only a message sets the returned sequence number, the live stream's closing
 * frame still points at the agent's answer.
 *
 * Facts verified against `reference/deepseek-harness` @ 5badb15009:
 * `session/src/index.ts:718-722` (append signature),
 * `session/src/types.ts:439-478` (which events take an intent, and which are
 * forbidden one), `agent-loop/src/tool-calls.ts:263-289` (the two tool shapes).
 */

import { randomUUID } from 'node:crypto'

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
const USER = 'user/message'

/**
 * The runner's marker for attachments that did not reach the external agent.
 *
 * An internal event of this plugin, not a session event type — the writer below
 * is the only thing allowed to see it, and it never appends it as-is.
 */
export const UNDELIVERED = 'acp/undelivered'

/**
 * One attachment the external agent did not receive, as the runner records it.
 *
 * Every block the prompt cannot carry lands here: an image when the agent's
 * capability table declines it, and any other non-text block (a file, a
 * resource) always — those no agent is sent today.
 */
export type UndeliveredAttachment = {
  readonly kind: 'image' | 'file'
  readonly mimeType?: string
}

/** The name the undelivered row's call card carries; the client shows it verbatim on a generic card. */
const UNDELIVERED_TOOL = '附件未送达'

/** Expand one marker into the call and the error result that pair with it. */
function undeliveredEvents(payload: unknown): ContentEvent[] {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const turn = typeof record['turn'] === 'number' ? record['turn'] : 0
  const step = typeof record['step'] === 'number' ? record['step'] : 0
  const attachments = Array.isArray(record['attachments']) ? record['attachments'] : []
  const callId = randomUUID()
  const notice = noticeText(attachments)
  return [
    {
      type: CALL,
      payload: {
        turn,
        step,
        callId,
        name: UNDELIVERED_TOOL,
        arguments: JSON.stringify({ attachments }),
      },
    },
    {
      type: RESULT,
      payload: {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'tool',
          content: [{ type: 'text', text: notice }],
          source: { kind: 'tool', callId },
          toolCallId: callId,
          isError: true,
        },
        error: { name: 'acp', code: 'attachment-undelivered', reason: notice },
      },
    },
  ]
}

/** The sentence the user reads: what was held back, and that it never arrived. */
function noticeText(attachments: readonly unknown[]): string {
  const images = attachments.filter(attachment => (attachment as { kind?: unknown })?.['kind'] === 'image').length
  const files = attachments.length - images
  const counted = [
    ...(images > 0 ? [`${String(images)} 张图片`] : []),
    ...(files > 0 ? [`${String(files)} 个文件`] : []),
  ]
  return `未送达：外部 agent 不接收这些附件，${counted.join('、') || '附件'}没有随本次提问发送给外部 agent。`
}

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
    // Worked through a queue so an expanded marker joins the list in place —
    // the call and the result it becomes must pass through the same branches
    // as any other pair, or their pairing would be a second code path to keep
    // honest.
    const queue = [...events]
    while (queue.length > 0) {
      const event = queue.shift()!
      if (event.type === UNDELIVERED) {
        queue.unshift(...undeliveredEvents(event.payload))
        continue
      }
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
      if (event.type === USER) {
        // The loop's own shape: the message object as it was claimed, with the
        // surface intent. No seq to track — nothing later points at a user
        // message.
        append(USER, event.payload, { surfaceOp: 'append' })
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

/**
 * A writer that keeps the log-only tool events and drops the assistant message.
 *
 * The in-place answer path hands the native loop's own answer to the loop: the
 * loop assembles the message from the chunk stream and appends it. So a writer
 * that appended the message here too would leave two messages for one step, and
 * the conversation view keeps only the last of them — erasing the one the user
 * just watched arrive.
 *
 * The tool events are the other way round. They are log-only and are not part
 * of the chunk vocabulary the loop assembles from, so nothing upstream of this
 * path can see them: without a writer they reach the session as nothing at all,
 * and a turn that ran three commands leaves a transcript with no trace of them.
 *
 * Returns nothing for the message sequence, which is the honest answer — this
 * writer did not write the message, so it must not claim a sequence for it.
 * @param append - the session's append, as `makeContentWriter` takes it.
 * @returns a writer for the events this path is responsible for.
 */
export function makeToolOnlyWriter(append: SessionAppend): ContentWriter {
  const inner = makeContentWriter(append)
  return (events): number | undefined => {
    for (const event of events) {
      // One event at a time so the dropped message cannot affect how the
      // call/result pairing is resolved for the ones that remain.
      if (event.type === MESSAGE) continue
      inner([event])
    }
    return undefined
  }
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