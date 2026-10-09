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
