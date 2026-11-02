/**
 * Carrying out a switch plan.
 *
 * The plan says what should happen; this does it. The fork is the risky move,
 * and one verified host fact shapes it: a DSH fork copies the source's event
 * prefix — turn boundaries included — so the copy replays into the same
 * "already started" lock the source is under, and `agent-preset/select` on it
 * fails (`agent-preset/locked`; the lock check folds `turn/start` events, and
 * the fork carries them — verified against the reference source and on a real
 * host). The working execution is therefore the host's other new-session
 * route: create a **blank** session bound to the target preset (nothing to
 * unlock — a blank session takes a preset), and carry the conversation into
 * its first model request.
 *
 * Creating the session and carrying the conversation are one act here, on
 * purpose: a new session that silently continues without the conversation is
 * exactly the quiet truncation this chain exists to prevent. So an unreadable
 * conversation refuses the switch before anything is created, and a failure
 * after creation names the session it made.
 */

import type { SwitchPlan } from './switch-plan.ts'
import type { HandoverMessage } from './handover.ts'

/** What this needs from the host to actually move a session. */
export type SwitchPorts = {
  /** Take a preset on a session; `undefined` hands it back to the native agent. */
  select(sessionId: string, presetId: string | undefined): Promise<void>
  /**
   * Create the session the switch continues in: blank, bound to the target
   * preset, with the conversation and the pending question delivered into its
   * first model request.
   *
   * `history` is the conversation to carry; `undefined` never reaches this
   * port — `applySwitchPlan` refuses first, because a session created without
   * its conversation would be a silent truncation.
   */
  fork(request: ForkRequest): Promise<{ sessionId: string }>
}

/** What the fork port is asked to do, in one request. */
export type ForkRequest = {
  /** The session the switch moves out of. */
  readonly sessionId: string
  /** The preset to bind the new session to; `undefined` means the native agent. */
  readonly preset: string | undefined
  /** The conversation to carry, oldest first. */
  readonly history: readonly HandoverMessage[]
  /** The question to put to the new session once the conversation is in place. */
  readonly prompt: string
  /**
   * The model pick that started the switch, when there was one — recorded on
   * the new session so its composer shows, and its turn uses, what the user
   * actually chose.
   */
  readonly selection?: { readonly provider: string; readonly model: string }
}

/** What the caller hands the executor to carry across, when it plans a fork. */
export type SwitchCarry = {
  /** The conversation, oldest first. */
  readonly history: readonly HandoverMessage[]
  /** The question the new session should be asked once the conversation is in place. */
  readonly prompt: string
  /** The model pick that started this switch, when there was one. */
  readonly selection?: { readonly provider: string; readonly model: string }
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
  carry?: SwitchCarry,
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

  // A fork of a started session replays the started state (its copied prefix
  // includes turn boundaries), so the new session is created blank and bound
  // to the target preset instead — nothing to unlock. The conversation has to
  // be readable for this: creating the session without it would strand the
  // user in a conversation that quietly lost its own history.
  if (carry === undefined || carry.history.length === 0) {
    throw new Error(
      'cannot switch: the conversation could not be read, and a new session without it '
      + 'would silently lose the history — nothing was created',
    )
  }
  const forked = await ports.fork({
    sessionId,
    preset: plan.preset,
    history: carry.history,
    prompt: carry.prompt,
    ...(carry.selection === undefined ? {} : { selection: carry.selection }),
  })
  return plan.droppedTokens === undefined
    ? { kind: 'switched', sessionId: forked.sessionId }
    : { kind: 'switched', sessionId: forked.sessionId, droppedTokens: plan.droppedTokens }
}

function refusalMessage(plan: Extract<SwitchPlan, { kind: 'refuse' }>): string {
  const parts: string[] = []
  if (plan.locked) parts.push('the session has already been used, so its agent cannot be changed')
  if (plan.shortBy !== undefined) {
    // Name the numbers: what the target declares, what would have fit, and
    // what is over — the kept/dropped split, without pretending anything was
    // trimmed.
    const size = plan.windowTokens === undefined
      ? ''
      : ` (its declared ${plan.windowTokens} token window leaves room for about `
        + `${Math.max(plan.fitsTokens ?? 0, 0)} tokens; trimming was not requested, so nothing was carried over)`
    parts.push(`the conversation is ${plan.shortBy} tokens too large for the target${size}`)
  }
  if (plan.reason !== undefined) return plan.reason
  return `cannot switch: ${parts.join('; ')}`
}
