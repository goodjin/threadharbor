/**
 * Carrying out a switch plan.
 *
 * The plan says what should happen; this does it. The risky part is the fork:
 * a fork that is created and then fails to take the new preset leaves two
 * sessions behind, one of them an empty copy of the conversation the user was
 * working in. So a failure part-way names the session it made, rather than
 * reporting only the underlying error and leaving the user to hunt for a
 * stray copy.
 */

import type { SwitchPlan } from './switch-plan.ts'

/** What this needs from the host to actually move a session. */
export type SwitchPorts = {
  /** Take a preset on a session; `undefined` hands it back to the native agent. */
  select(sessionId: string, presetId: string | undefined): Promise<void>
  /** Copy the conversation into a new session and return its id. */
  fork(sessionId: string): Promise<{ sessionId: string }>
}

export type ApplyResult =
  | { readonly kind: 'nothing' }
  | {
    readonly kind: 'switched'
    readonly sessionId: string
    /**
     * Present when the new session does not have the whole conversation.
     *
     * Absent means everything came across. It is not left to the caller to
     * remember the plan — a caller that forgets to check would truncate
     * silently, which is the one outcome this exists to prevent.
     */
    readonly droppedTokens?: number
  }

export async function applySwitchPlan(
  plan: SwitchPlan,
  sessionId: string,
  ports: SwitchPorts,
): Promise<ApplyResult> {
  if (plan.kind === 'noop') return { kind: 'nothing' }

  if (plan.kind === 'refuse') {
    // Refusing before touching anything: there is no half-made state to undo,
    // and the message has to carry enough for the user to act on.
    throw new Error(refusalMessage(plan))
  }

  if (plan.kind === 'switch-here') {
    await ports.select(sessionId, plan.preset)
    return { kind: 'switched', sessionId }
  }

  // A fork copies the conversation into a new session, which is not locked and
  // can still take a different preset. The order is the whole point.
  const forked = await ports.fork(sessionId)
  try {
    await ports.select(forked.sessionId, plan.preset)
  } catch (error) {
    throw new Error(
      `switched by forking, but the new session ${forked.sessionId} did not take the new agent: ${messageOf(error)}`,
    )
  }
  // Never a silent truncation: the new session is on the right agent, but when
  // it carries only part of the conversation the caller has to be told, without
  // having to remember that the plan had a `carriesAllHistory` flag.
  return plan.droppedTokens === undefined
    ? { kind: 'switched', sessionId: forked.sessionId }
    : { kind: 'switched', sessionId: forked.sessionId, droppedTokens: plan.droppedTokens }
}

function refusalMessage(plan: Extract<SwitchPlan, { kind: 'refuse' }>): string {
  const parts: string[] = []
  if (plan.locked) parts.push('the session has already been used, so its agent cannot be changed')
  if (plan.shortBy !== undefined) parts.push(`the conversation is ${plan.shortBy} tokens too large for the target`)
  if (plan.reason !== undefined) return plan.reason
  return `cannot switch: ${parts.join('; ')}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}