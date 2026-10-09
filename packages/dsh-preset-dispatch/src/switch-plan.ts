/**
 * The whole plan for a requested switch, in one decision.
 *
 * Two independent things can stand in the way of switching: the session may be
 * locked (it has already produced turns), and the history may not fit in the
 * target. They combine, and the combination is where the careless cases live —
 * a plan that says "fork it" without noticing the history will not fit is a
 * plan that produces a new session quietly missing the conversation.
 *
 * So this refuses when both apply, and reports both reasons when it does.
 */

import { decideHandover } from './handover.ts'
import type { HandoverDecision } from './handover.ts'
import { decideOnSelection } from './switch.ts'
import type { CatalogDeps } from './catalog.ts'
import type { PresetConfig } from './registry.ts'

/** What the session looks like when a switch is asked for. */
export type SwitchSessionState = {
  /** The preset it is actually on right now, not the stale header. */
  readonly currentPreset: string | undefined
  /** Whether it has produced any turn yet. */
  readonly started: boolean
  readonly historyTokens: number
  readonly targetContextWindow: number | undefined
  readonly reservedForOutput: number
}

export type SwitchOptions = {
  /** Allow a fork that carries part of the history, keeping the newest turns. */
  readonly trim?: boolean
}

export type SwitchPlan =
  | { readonly kind: 'noop' }
  | { readonly kind: 'switch-here'; readonly preset: string | undefined }
  | {
    readonly kind: 'fork'
    readonly preset: string | undefined
    /** False when the fork has to carry only part of the conversation. */
    readonly carriesAllHistory: boolean
    readonly droppedTokens?: number
  }
  | {
    readonly kind: 'refuse'
    readonly locked: boolean
    readonly shortBy?: number
    readonly reason?: string
  }

export function planSwitch(
  config: PresetConfig,
  deps: CatalogDeps,
  selection: { readonly provider: string; readonly model: string },
  session: SwitchSessionState,
  options: SwitchOptions,
): SwitchPlan {
  const decision = decideOnSelection(config, deps, selection, session)
  if (decision.kind === 'none') return { kind: 'noop' }

  const target = decision.kind === 'switch' ? decision.preset : decision.forkTo
  const handover = decideHandover(
    {
      historyTokens: session.historyTokens,
      targetContextWindow: session.targetContextWindow,
      reservedForOutput: session.reservedForOutput,
    },
    { ...(options.trim === true ? { trim: true } : {}) },
  )

  if (handover.kind === 'bad-input') {
    return { kind: 'refuse', locked: decision.kind === 'locked', reason: handover.reason }
  }

  if (handover.kind === 'trimmed') {
    // Only reachable when trimming was asked for: without it the same input
    // falls through to `too-long` below.
    return {
      kind: 'fork',
      preset: target,
      carriesAllHistory: false,
      droppedTokens: handover.droppedTokens,
    }
  }

  if (handover.kind === 'too-long') {
    // Forking does not make the history smaller — a new session carries the
    // same conversation — so this refuses whichever way the switch could have
    // gone. Splitting the conversation in two would be the alternative, and
    // that is not something to do silently.
    return { kind: 'refuse', locked: decision.kind === 'locked', shortBy: handover.shortBy }
  }

  // The whole conversation fits. Whether this session can change in place is
  // the only remaining question.
  return decision.kind === 'switch'
    ? { kind: 'switch-here', preset: target }
    : { kind: 'fork', preset: target, carriesAllHistory: true }
}