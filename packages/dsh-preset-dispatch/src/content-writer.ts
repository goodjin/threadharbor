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
import { toolCallAnnouncementEvent, toolCallEvent, toolResultMessageEvent } from '@threadharbor/dsh-acp-agent'

import type { ContentEvent } from './dispatch.ts'
import { withLifecycleGuard } from './session-lifecycle.ts'

/** How an event enters the log's surface: append it, or replace one current node. */
export type SurfaceIntent = {
  surfaceOp?: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
  sourceEventSeqs?: readonly number[]
}

/** What `session.append` gives back, and all this needs of it. */
export type SessionAppend = (
  type: string,
  payload: unknown,
  intent?: SurfaceIntent,
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
 * A system note: the same session event the loop uses for its own notices.
 *
 * It is a surface event like a message, so it takes the surface intent; its
 * shape is fixed by `systemNoteEvent` (source.kind must be `system-prompt`, or
 * the whole log becomes unloadable). Used for live agent-status notes — the
 * one place a status can appear while a step is still open.
 */
const SYSTEM = 'system/message'

/**
 * The runner's marker for attachments that did not reach the external agent.
 *
 * An internal event of this plugin, not a session event type — the writer below
 * is the only thing allowed to see it, and it never appends it as-is.
 */
export const UNDELIVERED = 'acp/undelivered'

/**
 * The runner's marker for one aggregated run of unmapped frames.
 *
 * Same shape as UNDELIVERED: an internal event, expanded here into the
 * `assistant/message` announcement the log demands plus the `tool/call` and
 * `tool/result` pair that carries the text. A plugin event of its own cannot be
 * used — the log refuses event types its readers do not know unless the
 * envelope marks them ignorable, which `append` does not accept — and the
 * client's generic command card already renders exactly the collapsed-then-
 * expandable disclosure this content needs.
 */
export const RAW_OUTPUT = 'acp/raw-output'

/** The tool name the unknown-output card carries; the client shows it verbatim. */
const RAW_OUTPUT_TOOL = '外部输出'

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

/** Expand one raw-output marker into its announcement, call, and result. */
function rawOutputEvents(payload: unknown): ContentEvent[] {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const turn = typeof record['turn'] === 'number' ? record['turn'] : 0
  const step = typeof record['step'] === 'number' ? record['step'] : 0
  const kind = typeof record['kind'] === 'string' ? record['kind'] : 'unknown'
  const content = typeof record['content'] === 'string' ? record['content'] : ''
  const format = typeof record['format'] === 'string' ? record['format'] : 'json'
  const count = typeof record['count'] === 'number' ? record['count'] : 1
  const callId = randomUUID()
  const name = `${RAW_OUTPUT_TOOL} · ${kind}`
  const args = JSON.stringify({ format, count })
  return [
    toolCallAnnouncementEvent({ turn, step, callId, name, arguments: args, provider: 'acp-raw-output', model: 'acp-raw-output' }),
    toolCallEvent({ turn, step, callId, name, arguments: args }),
    toolResultMessageEvent({ turn, step, callId, text: content, isError: false }),
  ]
}

/** Expand one marker into the call and the error result that pair with it. */
function undeliveredEvents(payload: unknown): ContentEvent[] {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const turn = typeof record['turn'] === 'number' ? record['turn'] : 0
  const step = typeof record['step'] === 'number' ? record['step'] : 0
  const attachments = Array.isArray(record['attachments']) ? record['attachments'] : []
  const callId = randomUUID()
  const notice = noticeText(attachments)
  const args = JSON.stringify({ attachments })
  return [
    toolCallAnnouncementEvent({
      turn,
      step,
      callId,
      name: UNDELIVERED_TOOL,
      arguments: args,
      provider: 'acp-undelivered',
      model: 'acp-undelivered',
    }),
    toolCallEvent({ turn, step, callId, name: UNDELIVERED_TOOL, arguments: args }),
    toolResultMessageEvent({
      turn,
      step,
      callId,
      text: notice,
      isError: true,
      error: { name: 'acp', code: 'attachment-undelivered', reason: notice },
    }),
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
 * The log admits exactly one `tool/result` per advertised call: a second append
 * closes a lifecycle that is already closed, and the reader refuses the whole
 * file (`tool/result … has no advertised tool lifecycle`). That is fatal, not
 * cosmetic — the session stops opening. So the writer enforces the rule here,
 * where every result passes:
 *
 * - the first result for a call is an append, linked to the call's sequence;
 * - a later result for the same call is the same answer refined (live terminal
 *   output, a late provider update). It is written as a replacement of the
 *   current result node, carrying the first result's non-content fields
 *   verbatim — the live append path only accepts a content-only change;
 * - a result with no call behind it is dropped. `onOrphan` names it so the
 *   caller can report the loss: one call's output missing beats a file that
 *   never loads again.
 */
export function makeContentWriter(append: SessionAppend, onOrphan?: (callId: string) => void): ContentWriter {
  // Keyed by turn as well as call id: turn numbers restart, so a call id reused
  // in a later turn must not pick up an earlier turn's sequence number. Step is
  // deliberately not part of the key — a spawned run's card opens in its birth
  // segment and settles in a later one, and the log pairs the two by call id.
  const answers = new Map<PairKey, number>()
  const results = new Map<PairKey, WrittenResult>()
  const guarded = withLifecycleGuard(append)

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
      if (event.type === RAW_OUTPUT) {
        queue.unshift(...rawOutputEvents(event.payload))
        continue
      }
      if (event.type === CALL) {
        const written = guarded(CALL, event.payload)
        const { turn, callId } = parts(event.payload)
        if (written !== undefined && callId !== undefined) answers.set(key(turn, callId), written.seq)
        continue
      }
      if (event.type === RESULT) {
        const { turn, callId } = parts(event.payload)
        if (callId === undefined) continue
        const pair = key(turn, callId)
        const callSeq = answers.get(pair)
        if (callSeq === undefined) {
          onOrphan?.(callId)
          continue
        }
        const previous = results.get(pair)
        if (previous === undefined) {
          const payload = recordOf(event.payload)
          const written = guarded(RESULT, payload, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
          if (written !== undefined) results.set(pair, { seq: written.seq, payload: withoutContent(payload) })
          continue
        }
        const payload = refinedResult(previous.payload, recordOf(event.payload))
        // An event this writer cannot turn into a content-only refinement is
        // not written: a real replacement the log will refuse corrupts the
        // file as surely as a duplicate append.
        if (payload === undefined) continue
        const written = guarded(RESULT, payload, {
          surfaceOp: { op: 'replace', startSeq: previous.seq, endSeq: previous.seq },
          sourceEventSeqs: [previous.seq],
        })
        if (written !== undefined) results.set(pair, { seq: written.seq, payload })
        continue
      }
      if (event.type === USER) {
        // The loop's own shape: the message object as it was claimed, with the
        // surface intent. No seq to track — nothing later points at a user
        // message.
        guarded(USER, event.payload, { surfaceOp: 'append' })
        continue
      }
      if (event.type === SYSTEM) {
        // A status note. Shape comes from `systemNoteEvent`; this branch only
        // supplies the surface intent the host requires of message events.
        guarded(SYSTEM, event.payload, { surfaceOp: 'append' })
        continue
      }
      if (event.type === MESSAGE) {
        written = guarded(MESSAGE, event.payload, { surfaceOp: 'append' })?.seq
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
 * A result this writer has already logged for a call: the sequence of its
 * current surface node, and its envelope (content stripped — the content of a
 * later version replaces it, and keeping every output in memory for the life of
 * the session buys nothing). Every later result for the call refines against
 * this envelope, so the replacement differs from its target in the content
 * alone.
 */
type WrittenResult = {
  seq: number
  payload: Record<string, unknown>
}

function recordOf(value: unknown): Record<string, unknown> {
  return (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
}

/** The result payload with its message content cleared: the part a refinement keeps verbatim. */
function withoutContent(payload: Record<string, unknown>): Record<string, unknown> {
  const message = payload['message']
  if (typeof message !== 'object' || message === null) return payload
  return { ...payload, message: { ...(message as Record<string, unknown>), content: [] } }
}

/**
 * The next version of an answer: the previous payload with only the message
 * content taken from the new one. The log's surface replacement rule allows a
 * tool result to change its content and nothing else — turn, step, message id,
 * source and error all stay as first written.
 */
function refinedResult(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> | undefined {
  const priorMessage = previous['message']
  const nextMessage = next['message']
  if (typeof priorMessage !== 'object' || priorMessage === null) return undefined
  if (typeof nextMessage !== 'object' || nextMessage === null) return undefined
  const content = (nextMessage as Record<string, unknown>)['content']
  if (!Array.isArray(content)) return undefined
  return { ...previous, message: { ...(priorMessage as Record<string, unknown>), content } }
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
 * The message is not dropped wholesale, though. The projection folds the step's
 * `tool-call` blocks into it — the announcement the log requires before it will
 * admit the `tool/call` that follows, and the same declaration the native loop
 * writes. Dropping the message dropped that announcement with it, which turned
 * every ACP tool card into an orphan these sessions could not open with. So the
 * split is by content: a message carrying an announcement is kept; a text-only
 * answer message still is not — the loop writes that one.
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
      if (event.type === MESSAGE && !carriesToolCallAnnouncement(event)) continue
      inner([event])
    }
    return undefined
  }
}

/**
 * Whether an assistant message carries at least one `tool-call` block.
 *
 * The log admits a `tool/call` only after such a block has announced it, so a
 * message holding one is not the loop's answer — it is the declaration this
 * path is the only one positioned to write.
 */
function carriesToolCallAnnouncement(event: ContentEvent): boolean {
  if (event.type !== MESSAGE) return false
  const payload = event.payload as { message?: { content?: unknown } }
  const content = payload?.message?.content
  if (!Array.isArray(content)) return false
  return content.some(block => (block as { type?: unknown })?.type === 'tool-call')
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