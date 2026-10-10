/**
 * Whether the session's chosen model is one this row serves.
 *
 * The takeover replaces the whole step, so the loop never fires a model request
 * and nothing in the host reacts to the picker — the selection would sit unused
 * while the preset's agent answers anyway, which is exactly the "the interface
 * shows one thing, the session does another" state this module prevents. The
 * durable `modelSelection` projection records what was picked but not yet used
 * (`pending`); the replaced step reads it at turn time, the one moment a turn
 * can still decide who should answer.
 *
 * The projection's shape is verified against `reference/deepseek-harness` @
 * `5badb15009` (`api/session-controller/src/model-selection-projection.ts`):
 * state is `{ lastUsed, pending }`, each a nullable `{ provider, model,
 * reasoningEffort? }`, and `pending` is cleared only by a committed
 * `request/header`. An external session never commits one, so a selection read
 * here stays pending — reading it every turn is therefore idempotent, not
 * consuming.
 */

/** The provider route prefix every ACP catalog route carries. */
const ROUTE_PREFIX = 'acp:'

/** A model selection, as the projection records it. */
export type SelectionLike = {
  readonly provider: string
  readonly model: string
}

/** What one turn should do about the session's chosen model. */
export type SelectionDecision =
  /** Nothing pending — answer with whatever the preset drives. */
  | { readonly kind: 'none' }
  /** The pending selection names a model this preset serves; use it. */
  | { readonly kind: 'own'; readonly modelId: string }
  /**
   * The pending selection names a model this preset does not serve. The turn is
   * refused with the reason: answering anyway would put one agent's words under
   * another model's name.
   */
  | { readonly kind: 'refuse'; readonly reason: string }

/** The preset-side facts a decision needs. */
export type SelectionConfig = {
  /** This row's preset id, as the session names it. */
  readonly presetId: string
  /** The models this preset's agent serves, as configured. */
  readonly models: readonly { readonly id: string }[]
}

/**
 * Read the pending selection out of a projection state value.
 *
 * Absent, malformed, or already-consumed (null) states all read as "nothing
 * pending" — a projection this host does not compose must not block turns.
 */
export function pendingSelectionOf(state: unknown): SelectionLike | undefined {
  const record = (typeof state === 'object' && state !== null ? state : {}) as { pending?: unknown }
  return selectionOf(record['pending'])
}

/**
 * Read one selection value, as the host records it anywhere.
 *
 * The projection's entries and the host default's `currentSelection()` share
 * the shape `{ provider, model, reasoningEffort? }`; anything else reads as
 * "no opinion", because a half-known selection must not gate a turn.
 */
export function selectionOf(value: unknown): SelectionLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const selection = value as { provider?: unknown; model?: unknown }
  if (typeof selection['provider'] !== 'string' || typeof selection['model'] !== 'string') return undefined
  return { provider: selection['provider'], model: selection['model'] }
}

/** Where a turn's effective model choice came from, as the refusal names it. */
export type SelectionSource = 'picker' | 'host-default'

/**
 * Decide what this turn does about the session's chosen model.
 *
 * The provider route decides: a route can only be this preset's, another ACP
 * preset's, or a native one. Only the first can be served here, and only for a
 * model the preset's list actually names — the picker shows every catalog
 * group, so "provider matches" alone would still let a model this agent never
 * advertised through.
 */
export function decideSelection(
  config: SelectionConfig,
  selection: SelectionLike,
  source: SelectionSource = 'picker',
): SelectionDecision {
  if (selection.provider === routeOf(config.presetId)
    && config.models.some(model => model.id === selection.model)) {
    return { kind: 'own', modelId: selection.model }
  }
  return { kind: 'refuse', reason: refusalMessage(config, selection, source) }
}

function routeOf(presetId: string): string {
  return `${ROUTE_PREFIX}${presetId}`
}

function refusalMessage(config: SelectionConfig, selection: SelectionLike, source: SelectionSource): string {
  const served = config.models.length === 0
    ? '该预设没有声明任何模型'
    : `该预设提供的模型：${config.models.map(model => model.id).join('、')}`
  const origin = source === 'picker'
    ? `模型选择器里选中的 ${selection.provider} / ${selection.model}`
    : `这台主机的默认模型 ${selection.provider} / ${selection.model}`
  return `这个会话运行在 ${config.presetId} 预设上，由它的外部 agent 应答；${origin} `
    + `不由这个预设提供，本回合不会执行——否则界面显示的和实际回答的会是两个模型。`
    + `请改选 ${served}；或者把会话建在提供该模型的预设上。`
}
