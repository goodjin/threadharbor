/**
 * Whether a handover can carry the whole conversation across.
 *
 * Switching agent mid-conversation means the target has to take the history as
 * it stands. If it cannot, the choice is to fail or to quietly carry part of
 * it — and a conversation that starts missing its own earlier turns is worse
 * than one that plainly refuses, because neither the agent nor the user can
 * tell what was lost.
 *
 * So the decision is made before anything moves, and on failure says by how
 * much. Trimming exists, but only when asked for, and only with the amounts
 * stated — a silent truncation is the one outcome this refuses to produce.
 */

/**
 * One message of the conversation being handed over, flattened to what a
 * prompt can carry.
 *
 * Only the conversation's own words travel: system instructions belong to the
 * target's own composition, and tool traffic is the old agent's scratch work —
 * carrying it would present one agent's tool calls as another's history.
 */
export type HandoverMessage = {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** One raw message's role, or an empty string when it has none. */
function roleOf(message: unknown): string {
  return typeof message === 'object' && message !== null
    ? String((message as { readonly role?: unknown }).role ?? '')
    : ''
}

/**
 * The `source.kind` a durable message declares, when it has a usable one.
 *
 * Every message the host admits to a session carries a source (session-format
 * validation refuses one without), so this is the boundary between what the
 * human said and what the host injected into the same user role.
 */
export function sourceKindOf(message: unknown): string | undefined {
  const source = typeof message === 'object' && message !== null
    ? (message as { readonly source?: unknown }).source
    : undefined
  if (typeof source !== 'object' || source === null) return undefined
  const kind = (source as { readonly kind?: unknown }).kind
  return typeof kind === 'string' && kind !== '' ? kind : undefined
}

/** Whether this message is something the human typed, not host-injected context. */
export function isHumanInput(message: unknown): boolean {
  return roleOf(message) === 'user' && sourceKindOf(message) === 'user'
}

/** Read one content block's text, or nothing when it carries none. */
function textBlockOf(block: unknown): string {
  if (typeof block === 'string') return block
  const record = (typeof block === 'object' && block !== null ? block : {}) as { type?: unknown; text?: unknown }
  if (record['type'] !== 'text' || typeof record['text'] !== 'string') return ''
  return record['text']
}

/** Flatten one raw message's content — a string or a block array — to its text. */
function textOfMessage(message: unknown): string {
  const record = (typeof message === 'object' && message !== null ? message : {}) as { content?: unknown }
  const content = record['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(textBlockOf).filter(text => text !== '').join('\n')
}

/**
 * Flatten the conversation a request or a session log carries into handover
 * messages.
 *
 * Only two voices belong to a handover: the human's own words (role user with
 * source kind `user`) and the assistant's replies. System instructions, tool
 * traffic, and injected context ride the user role too — but they are host
 * plumbing, and presenting them to the receiving agent as something the user
 * said would put words in the human's mouth. Anything unshaped reads as empty
 * and is dropped the same way — a handover carries what is actually there,
 * never a guess.
 */
export function messagesOf(raw: readonly unknown[] | undefined): readonly HandoverMessage[] {
  if (raw === undefined) return []
  const messages: HandoverMessage[] = []
  for (const message of raw) {
    const text = textOfMessage(message)
    if (text === '') continue
    if (isHumanInput(message)) messages.push({ role: 'user', text })
    else if (roleOf(message) === 'assistant') messages.push({ role: 'assistant', text })
  }
  return messages
}

/**
 * Assemble the messages into the text that primes a new conversation.
 *
 * The block says plainly what it is and what it is for: the receiving agent is
 * being handed a conversation it did not take part in, and the question that
 * follows is addressed to it. The roles are named in the text, so a model that
 * has never heard of this harness still reads the exchange correctly.
 */
export function assembleHandover(messages: readonly HandoverMessage[]): string {
  const labelOf: Readonly<Record<HandoverMessage['role'], string>> = {
    user: '用户',
    assistant: '助手',
  }
  const lines = messages.map(message => `【${labelOf[message.role]}】${message.text}`)
  return [
    `以下是一次会话切换时完整移交的此前对话记录，共 ${String(messages.length)} 条。`
      + '请把这段记录当作已经发生过的上下文，并回答记录之后的问题。',
    '',
    ...lines,
    '',
    '——记录结束——',
  ].join('\n')
}

export type HandoverInput = {
  /** Size of the conversation being handed over. */
  readonly historyTokens: number
  /** The target's context window; absent means it reported none. */
  readonly targetContextWindow?: number | undefined
  /** Space held back so the target has room to answer. */
  readonly reservedForOutput: number
}

export type HandoverOptions = {
  /** Allow carrying part of the history, keeping the newest turns. */
  readonly trim?: boolean
}

export type HandoverDecision =
  | { readonly kind: 'ok'; readonly keptTokens: number }
  | { readonly kind: 'trimmed'; readonly keptTokens: number; readonly droppedTokens: number; readonly keepsNewest: true }
  | { readonly kind: 'too-long'; readonly shortBy: number; readonly keptTokens: number }
  | { readonly kind: 'bad-input'; readonly reason: string }

export function decideHandover(input: HandoverInput, options: HandoverOptions = {}): HandoverDecision {
  if (!Number.isFinite(input.historyTokens) || input.historyTokens < 0) {
    return { kind: 'bad-input', reason: 'historyTokens must be a non-negative finite number' }
  }
  const window = input.targetContextWindow
  if (window !== undefined && (!Number.isFinite(window) || window <= 0)) {
    return { kind: 'bad-input', reason: 'targetContextWindow must be a positive finite number when reported' }
  }
  // An agent that reports no window is not known to be too small; refusing on a
  // missing number would block every target that simply does not advertise one.
  if (window === undefined) return { kind: 'ok', keptTokens: input.historyTokens }

  const room = window - input.reservedForOutput
  if (input.historyTokens <= room) return { kind: 'ok', keptTokens: input.historyTokens }

  const shortBy = input.historyTokens - room
  if (options.trim === true && room > 0) {
    // Keep the newest turns: dropping the old ones leaves the thread coherent,
    // while dropping the newest would discard the exchange just made.
    return { kind: 'trimmed', keptTokens: room, droppedTokens: shortBy, keepsNewest: true }
  }
  return { kind: 'too-long', shortBy, keptTokens: input.historyTokens }
}
