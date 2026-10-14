/**
 * What one gateway request feeds the external conversation.
 *
 * The native loop assembles the whole derived history for every step; the
 * external agent keeps its own conversation and must not be fed the same text
 * twice. So each request is planned against a cursor: the first request
 * primes with everything before the question, later requests send only the
 * user-side text that arrived since.
 */

import { assembleHandover, messagesOf } from './handover.ts'
import type { HandoverMessage } from './handover.ts'

/** How far the external conversation has been fed, as an index into the derived history. */
export type FeedCursor = { readonly fed: number }

export type FeedPlan =
  | { readonly kind: 'first'; readonly primer: string; readonly prompt: string; readonly cursor: FeedCursor }
  | { readonly kind: 'next'; readonly prompt: string; readonly cursor: FeedCursor }
  | { readonly kind: 'nothing'; readonly reason: string }

/**
 * Plan one request's feed.
 *
 * The question is the trailing user-role message; everything before it minus
 * the system prompt primes the external conversation on the first request and
 * is never sent again. Assistant messages after the cursor are the external
 * agent's own words and are skipped — feeding them back would make it argue
 * with its own transcript.
 */
export function planFeed(messages: readonly unknown[], cursor: FeedCursor | undefined): FeedPlan {
  const next = { fed: messages.length - 1 }
  const last = messages[messages.length - 1]
  const lastRole = roleOf(last)
  if (lastRole !== 'user') {
    return { kind: 'nothing', reason: 'no new user message to ask the external agent' }
  }
  const prompt = textOf(last)
  if (prompt === '') {
    return { kind: 'nothing', reason: 'the new user message carries no text' }
  }
  if (cursor === undefined) {
    const history = messages.slice(0, -1).filter(message => roleOf(message) !== 'system')
    const carried = messagesOf(history)
    const primer = carried.length === 0 ? '' : assembleHandover(carried as HandoverMessage[])
    return { kind: 'first', primer, prompt, cursor: next }
  }
  if (messages.length <= cursor.fed) {
    return {
      kind: 'nothing',
      reason: 'the conversation got shorter than what the external agent already has '
        + '(history was compacted?) — refusing rather than feeding it a duplicate transcript',
    }
  }
  const fresh = messages.slice(cursor.fed + 1).filter(message => {
    const role = roleOf(message)
    return role !== 'assistant' && role !== 'system'
  })
  const texts = fresh.map(textOf).filter(text => text !== '')
  if (texts.length === 0) {
    return { kind: 'nothing', reason: 'nothing new on the user side since the last request' }
  }
  return { kind: 'next', prompt: texts.join('\n'), cursor: next }
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
