/**
 * Pairing the tool calls of one request with their results.
 *
 * The session log records a tool call and its result wherever they happen to
 * land. That is usually the same step, but not always: a background subagent
 * call can stay open for the rest of the turn, and when the turn ends
 * interrupted, the recovery writes the "outcome unknown" result at the tail of
 * the log instead of next to the call it answers. A history like that is
 * faithful to what happened and still unusable on the wire: the anthropic
 * messages format wants every tool_use answered by the tool_result blocks of
 * the very next user message, and MiniMax rejects such a request outright
 * ("tool call result does not follow tool call").
 *
 * This re-pairs the history on the way out. The log is left alone: the session
 * keeps what happened, and only the copy that goes to the model is re-paired,
 * per request.
 *
 * The rules:
 *
 * - a result recorded away from its call moves back to the call it answers;
 * - a call with no result at all is answered with an error result that says
 *   the outcome is unknown — the call may still be running in the background,
 *   so this is not a failure;
 * - a result that answers no call stays out of the request.
 *
 * A repeated call id cannot be answered twice, so the later copy of the block
 * is dropped: the session format rejects an empty call id, and one id per call
 * is the only shape the providers accept.
 */

/** The wording a call without a recorded result gets. */
const UNKNOWN_OUTCOME = 'This tool call has no recorded result in the session history. Its outcome is unknown: it may still be running in the background, or it may have been interrupted before it finished. Treat it as unknown rather than as a failure. Retry only if the operation is read-only or idempotent; if it may have side effects, verify the external state or ask the user first.'

/** One session message, read defensively: the history arrives as untyped data. */
type Message = Record<string, unknown>

/**
 * Re-pair the tool calls of one request with their results.
 * @param messages - the conversation history, in order.
 * @returns the same history with every tool call answered by the message right after it.
 */
export function pairToolResults(messages: readonly unknown[]): unknown[] {
  const answers = new Map<string, Message>()
  for (const message of messages) {
    if (!isRecord(message) || roleOf(message) !== 'tool') continue
    const id = callIdOf(message)
    if (id === undefined || answers.has(id)) continue
    answers.set(id, message)
  }

  const repaired: unknown[] = []
  const answered = new Set<string>()
  for (const message of messages) {
    if (!isRecord(message)) {
      repaired.push(message)
      continue
    }
    const role = roleOf(message)
    // A tool message is emitted next to the call it answers, and dropped when
    // no call asks for it.
    if (role === 'tool') continue
    if (role !== 'assistant') {
      repaired.push(message)
      continue
    }
    const calls = callIdsOf(message)
    if (calls.length === 0) {
      repaired.push(message)
      continue
    }
    const fresh: string[] = []
    const results: Message[] = []
    for (const id of calls) {
      if (answered.has(id)) continue
      answered.add(id)
      fresh.push(id)
      results.push(answers.get(id) ?? unknownResult(id))
    }
    const kept = withoutRepeatedCalls(message, fresh)
    if (kept !== undefined) repaired.push(kept)
    repaired.push(...results)
  }
  return repaired
}

/** The result a call that never produced one gets. */
function unknownResult(callId: string): Message {
  return {
    id: `pairing-unknown-result-${callId}`,
    role: 'tool',
    toolCallId: callId,
    isError: true,
    source: { kind: 'tool', callId },
    content: [{ type: 'text', text: UNKNOWN_OUTCOME }],
  }
}

/**
 * The message without the tool calls another message already answered.
 *
 * The message itself when nothing was repeated, a copy without the repeated
 * blocks when it was, and nothing at all when the repeated blocks were all it
 * carried.
 */
function withoutRepeatedCalls(message: Message, fresh: readonly string[]): Message | undefined {
  const content = Array.isArray(message['content']) ? message['content'] : []
  const seen = new Set<string>()
  const blocks: unknown[] = []
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool-call') {
      blocks.push(block)
      continue
    }
    const id = typeof block['id'] === 'string' ? block['id'] : ''
    if (id === '' || !fresh.includes(id) || seen.has(id)) continue
    seen.add(id)
    blocks.push(block)
  }
  if (blocks.length === content.length) return message
  if (blocks.length === 0) return undefined
  const copy = structuredClone(message) as Message
  copy['content'] = blocks
  return copy
}

/** The call ids an assistant message carries, in order, without repeats. */
function callIdsOf(message: Message): string[] {
  const content = Array.isArray(message['content']) ? message['content'] : []
  const ids: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool-call') continue
    const id = block['id']
    if (typeof id !== 'string' || id === '') continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** The call a tool message answers. */
function callIdOf(message: Message): string | undefined {
  const direct = message['toolCallId']
  if (typeof direct === 'string' && direct !== '') return direct
  const source = message['source']
  if (!isRecord(source)) return undefined
  const fromSource = source['callId']
  return typeof fromSource === 'string' && fromSource !== '' ? fromSource : undefined
}

function roleOf(message: Message): string {
  const role = message['role']
  return typeof role === 'string' ? role : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
