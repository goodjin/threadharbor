/**
 * What should happen when the model selection changes.
 *
 * The decision is made before anything is performed, because two of the three
 * outcomes differ only in *why* nothing happens — and a session that silently
 * keeps the wrong agent is worse than one that refuses.
 *
 *   - same agent      → nothing to do
 *   - native model    → switch back to the native agent
 *   - another agent   → switch, unless the session has already produced turns
 *     and is therefore locked; then say so, and offer the way forward
 */

import { presetForModel, presetOfRoute } from './catalog.ts'
import type { CatalogDeps } from './catalog.ts'
import type { PresetConfig } from './registry.ts'

/** What the session looks like at the moment of the decision. */
export type SelectionState = {
  /** The preset the session is actually on, live value not the stale header. */
  readonly currentPreset: string | undefined
  /** Whether the session has produced any turn yet. */
  readonly started: boolean
}

export type SelectionDecision =
  | { readonly kind: 'none' }
  /** Switch to this preset; `undefined` means the native agent. */
  | { readonly kind: 'switch'; readonly preset: string | undefined }
  /** Cannot switch here; `forkTo` is the preset the fork should be created on. */
  | { readonly kind: 'locked'; readonly from: string | undefined; readonly forkTo: string | undefined }

export function decideOnSelection(
  config: PresetConfig,
  deps: CatalogDeps,
  selection: { readonly provider: string; readonly model: string },
  state: SelectionState,
): SelectionDecision {
  const route = presetOfRoute(selection.provider)

  // A native route, or one whose agent does not serve this model: the session
  // keeps whatever it has. Only a native selection means "go back to native".
  if (route === undefined) {
    if (state.currentPreset === undefined) return { kind: 'none' }
    return { kind: 'switch', preset: undefined }
  }

  const target = presetForModel(config, deps, selection.provider, selection.model)
  if (target === undefined) return { kind: 'none' }
  if (target === state.currentPreset) return { kind: 'none' }

  // DSH locks the preset once a turn has run: `lastTurn` is cumulative and
  // `turn/end` never clears it. Refusing with a way forward beats truncating
  // history or quietly leaving the session on the old agent.
  if (state.started) return { kind: 'locked', from: state.currentPreset, forkTo: target }
  return { kind: 'switch', preset: target }
}
