/**
 * What one gateway request feeds the external conversation.
 *
 * The native loop assembles the whole derived history for every step; the
 * external agent keeps its own conversation and must not be fed the same text
 * twice. So each request is planned against a cursor: the first request
 * primes with everything before the question, later requests send only the
 * human input that arrived since.
 *
 * Only the human's own messages are user input. Injected context also rides in
 * the user role (`agent-instructions`, `runtime-context`, …), and tool results
 * are role `tool`; the external agent either already owns that traffic (its
 * own tool calls) or it belongs to the host's composition (instructions). Re-
 * feeding it is what once turned a 122-character question into a
 * 1,221,980-character prompt (2026-10-27 session 8b518c00).
 */

import { assembleHandover, isHumanInput, messagesOf, sourceKindOf } from './handover.ts'

/** How far the external conversation has been fed, as an index into the derived history. */
export type FeedCursor = { readonly fed: number }

export type FeedPlan =
  | {
    readonly kind: 'first'
    readonly primer: string
    readonly prompt: string
    /** The raw messages this request asks with (text and attachments alike). */
    readonly messages: readonly unknown[]
    readonly cursor: FeedCursor
  }
  | {
    readonly kind: 'next'
    readonly prompt: string
    /** The raw messages this request asks with (text and attachments alike). */
    readonly messages: readonly unknown[]
    readonly cursor: FeedCursor
  }
  | { readonly kind: 'nothing'; readonly reason: string }

/** How many messages of each category one request (or its increment) carries. */
export type FeedCounts = {
  readonly total: number
  readonly human: number
  readonly assistant: number
  readonly tool: number
  readonly injected: number
  readonly system: number
  readonly other: number
}

/**
 * Plan one request's feed.
 *
 * The question is the newest human message; everything before it minus the
 * host's own traffic primes the external conversation on the first request and
 * is never sent again. Later requests send the human messages after the
 * cursor — assistant messages are the external agent's own words, and tool
 * results and injected context were never the human's input; feeding any of
 * them back would make the agent argue with its own transcript or read the
 * host's plumbing as a request.
 */
export function planFeed(messages: readonly unknown[], cursor: FeedCursor | undefined): FeedPlan {
  const next = { fed: messages.length - 1 }
  if (cursor === undefined) {
    const questionAt = lastHumanIndex(messages)
    if (questionAt < 0) {
      return { kind: 'nothing', reason: 'no new user message to ask the external agent' }
    }
    const question = messages[questionAt]!
    if (!hasDeliverableContent(question)) {
      return { kind: 'nothing', reason: 'the new user message carries no text' }
    }
    const carried = messagesOf(messages.slice(0, questionAt))
    const primer = carried.length === 0 ? '' : assembleHandover(carried)
    return {
      kind: 'first',
      primer,
      prompt: textOf(question),
      messages: [question],
      cursor: next,
    }
  }
  if (messages.length <= cursor.fed) {
    return {
      kind: 'nothing',
      reason: 'the conversation got shorter than what the external agent already has '
        + '(history was compacted?) — refusing rather than feeding it a duplicate transcript',
    }
  }
  const fresh = messages
    .slice(cursor.fed + 1)
    .filter(message => isHumanInput(message) && hasDeliverableContent(message))
  if (fresh.length === 0) {
    return { kind: 'nothing', reason: 'nothing new on the user side since the last request' }
  }
  return {
    kind: 'next',
    prompt: fresh.map(textOf).filter(text => text !== '').join('\n'),
    messages: fresh,
    cursor: next,
  }
}

/**
 * Count the request's messages by category for the delivery diagnostic.
 *
 * With a cursor, only the increment past it is counted — the part this
 * request is actually deciding what to do with. Counts and lengths only: the
 * line must never carry message bodies, credentials, or prompt text.
 */
export function feedCountsOf(messages: readonly unknown[], cursor?: FeedCursor): FeedCounts {
  const considered = cursor === undefined ? messages : messages.slice(cursor.fed + 1)
  const counts = {
    total: considered.length,
    human: 0,
    assistant: 0,
    tool: 0,
    injected: 0,
    system: 0,
    other: 0,
  }
  for (const message of considered) {
    const role = roleOf(message)
    if (isHumanInput(message)) counts.human += 1
    else if (role === 'assistant') counts.assistant += 1
    else if (role === 'tool') counts.tool += 1
    else if (role === 'system') counts.system += 1
    else if (role === 'user' && isInjected(message)) counts.injected += 1
    else counts.other += 1
  }
  return counts
}

function isInjected(message: unknown): boolean {
  const kind = sourceKindOf(message)
  return kind !== undefined && kind !== 'user'
}

function lastHumanIndex(messages: readonly unknown[]): number {
  // Scanning back skips injected context (it can trail the question), but a
  // non-user message blocks: an assistant reply or tool result means the last
  // human words were already answered, so there is no pending question to ask
  // — re-sending them would duplicate history in the external conversation.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (roleOf(message) !== 'user') return -1
    if (isHumanInput(message)) return index
  }
  return -1
}

/**
 * Whether a human message carries anything the prompt can deliver.
 *
 * Text is the ordinary case; an attachment-only message is still a request
 * (the image or file block travels, and any the agent cannot take is announced
 * as undelivered by the runner) — refusing it would swallow the question.
 */
function hasDeliverableContent(message: unknown): boolean {
  const content = typeof message === 'object' && message !== null
    ? (message as { readonly content?: unknown }).content
    : undefined
  if (typeof content === 'string') return content !== ''
  if (!Array.isArray(content)) return false
  return content.some(block => {
    const record = (typeof block === 'object' && block !== null ? block : {}) as {
      readonly type?: unknown
      readonly text?: unknown
    }
    if (record.type === 'text') return typeof record.text === 'string' && record.text !== ''
    return typeof record.type === 'string' && record.type !== ''
  })
}

function roleOf(message: unknown): string {
  return typeof message === 'object' && message !== null
    ? String((message as { readonly role?: unknown }).role ?? '')
    : ''
}

function textOf(message: unknown): string {
  const content = typeof message === 'object' && message !== null
    ? (message as { readonly content?: unknown }).content
    : undefined
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as readonly { readonly type?: unknown; readonly text?: unknown }[]) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}
