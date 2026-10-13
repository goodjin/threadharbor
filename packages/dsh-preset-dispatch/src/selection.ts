/**
 * Whether the session's chosen model is one this row serves — and what the
 * preset and the model mean for each other.
 *
 * The takeover replaces the whole step, so the loop never fires a model request
 * and nothing in the host reacts to the picker — the selection would sit unused
 * while the preset's agent answers anyway. DSH's own composition keeps the
 * preset and the model independent: the preset adds capabilities, the model
 * chooses the route, and a native session may freely run preset X with model Y
 * from any provider. The takeover cannot ask the native loop to route, so the
 * honest equivalent of that independence is that the two picks follow each
 * other instead of colliding:
 *
 *   - a model this preset serves is used as-is;
 *   - the host default, when it names some other route, means "no opinion" —
 *     the preset answers with its own default (a session created on a preset
 *     shows the host default in its composer without any pick ever made);
 *   - an explicit pick this preset cannot serve refuses the turn, and the row
 *     wires the two together so the refusal stays the rare, honest fallback
 *     (`plugin.ts` follows a preset pick with this preset's first model, and a
 *     model pick with the preset that serves it).
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

/**
 * The base wire id of a model, with any `[effort]` suffix stripped.
 *
 * Some agents publish one model per effort as `base[effort]`; the catalog
 * collapses those to `base` and rides effort separately, so a picker selection
 * arrives as the bare base. The preset's declared list still carries the
 * suffixed ids, so matching compares base-to-base — a `base` pick is served
 * when the preset advertises `base` at any effort.
 *
 * Shared by everything that matches a pick against a declared model list
 * (the takeover's own check, the switch chain's preset lookup, the follow
 * rules, the context-window lookup) so they cannot drift apart again.
 */
export function baseIdOf(id: string): string {
  const open = id.lastIndexOf('[')
  if (open === -1 || !id.endsWith(']')) return id
  const base = id.slice(0, open)
  const effort = id.slice(open + 1, -1)
  if (base === '' || effort === '' || effort.includes('[') || effort.includes(']')) return id
  return base
}

/** A model selection, as the projection records it. */
export type SelectionLike = {
  readonly provider: string
  readonly model: string
  /**
   * The reasoning effort the picker paired with this model, when the model
   * advertises one. Carried end-to-end so a collapsed base pick can re-attach
   * its `[effort]` suffix before reaching the agent — the agent selects effort
   * through the model id, not a separate parameter.
   */
  readonly reasoningEffort?: string
}

/** What one turn should do about the session's chosen model. */
export type SelectionDecision =
  /** Nothing pending that names a model — answer with whatever the preset drives. */
  | { readonly kind: 'none' }
  /** The selection names a model this preset serves; use it. */
  | { readonly kind: 'own'; readonly modelId: string; readonly reasoningEffort?: string }
  /**
   * The selection names a model nothing here can serve the session with. The
   * turn is refused with the reason: answering anyway would put one agent's
   * words under another model's name.
   */
  | { readonly kind: 'refuse'; readonly reason: string }

/** The preset-side facts a decision needs. */
export type SelectionConfig = {
  /** This row's preset id, as the session names it. */
  readonly presetId: string
  /** The models this preset's agent serves, as configured. */
  readonly models: readonly { readonly id: string }[]
}

/** Where a turn's effective model choice came from. */
export type SelectionSource = 'picker' | 'host-default'

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
  const selection = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof selection['provider'] !== 'string' || typeof selection['model'] !== 'string') return undefined
  // The effort rides alongside the model, not inside it: the picker keeps them
  // separate, and the agent only accepts the combined wire id. Dropping it here
  // would leave a collapsed base pick with no way to re-attach its suffix.
  return typeof selection['reasoningEffort'] === 'string'
    ? { provider: selection['provider'], model: selection['model'], reasoningEffort: selection['reasoningEffort'] }
    : { provider: selection['provider'], model: selection['model'] }
}

/**
 * Decide what this turn does about the session's chosen model.
 *
 * The provider route decides: a route can be this preset's, another ACP
 * preset's, or a native one. Only the first is served here, and only for a
 * model the preset's list actually names — the picker shows every catalog
 * group, so "provider matches" alone would still let a model this agent never
 * advertised through. The host default is the one soft case: nobody expressed
 * a wish, so the preset answers with its own default rather than refusing.
 */
export function decideSelection(
  config: SelectionConfig,
  selection: SelectionLike,
  source: SelectionSource = 'picker',
): SelectionDecision {
  if (selection.provider === routeOf(config.presetId)) {
    // The picker now selects the collapsed base id (effort rides DSH's own
    // reasoningEffort field), while the preset's declared list still carries the
    // suffixed wire ids. A bare base pick is served when the preset advertises
    // that base at any effort; a still-suffixed pick (an older session stamped
    // with one) is matched exactly and passed through verbatim so it keeps
    // reaching the agent as the exact wire id it reported.
    const exact = config.models.find(model => model.id === selection.model)
    if (exact !== undefined) {
      return { kind: 'own', modelId: exact.id, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
    }
    const bare = baseIdOf(selection.model)
    const byBase = config.models.find(model => baseIdOf(model.id) === bare)
    if (byBase !== undefined) {
      // A bare base pick: the effort rides the model id as a suffix the agent
      // accepts, so it travels with the decision rather than separately.
      const modelId = selection.reasoningEffort === undefined ? bare : `${bare}[${selection.reasoningEffort}]`
      return { kind: 'own', modelId, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
    }
    // The host default naming this route with a model the list has dropped is
    // still "no opinion": nothing here was picked on purpose.
    if (source === 'host-default') return { kind: 'none' }
    return { kind: 'refuse', reason: staleModelMessage(config, selection) }
  }
  // The host default was never picked by anyone; the preset's own default
  // answers. This is the state every fresh session on a preset starts in.
  if (source === 'host-default') return { kind: 'none' }
  if (selection.provider.startsWith(ROUTE_PREFIX)) {
    return { kind: 'refuse', reason: otherPresetMessage(config, selection) }
  }
  return { kind: 'refuse', reason: nativeModelMessage(config, selection) }
}

function routeOf(presetId: string): string {
  return `${ROUTE_PREFIX}${presetId}`
}

function staleModelMessage(config: SelectionConfig, selection: SelectionLike): string {
  const served = config.models.length === 0
    ? '该预设没有声明任何模型'
    : `该预设提供的模型：${config.models.map(model => model.id).join('、')}`
  return `模型选择器里选中的 ${selection.provider} / ${selection.model} 不由 ${config.presetId} 预设提供`
    + `（${served}），本回合不会用它执行。请改选列出的模型。`
}

function otherPresetMessage(config: SelectionConfig, selection: SelectionLike): string {
  const target = selection.provider.slice(ROUTE_PREFIX.length)
  return `模型选择器里选中的 ${selection.provider} / ${selection.model} 由另一个预设（${target}）提供，`
    + `而本会话仍运行在 ${config.presetId} 预设上。自动切换没有发生：${target} 可能不在本机，`
    + `或本会话已开始、预设无法再换。请把会话切到 ${target}，或新建会话时选择它。`
}

function nativeModelMessage(config: SelectionConfig, selection: SelectionLike): string {
  return `这个会话运行在 ${config.presetId} 预设上，由它的外部 agent 应答；模型选择器里选中的`
    + ` ${selection.provider} / ${selection.model} 是原生模型，不由任何已挂载的 acp 预设提供，`
    + `已开始的会话也不能交回原生 agent——否则界面显示的和实际回答的会是两个模型。`
    + `要使用原生模型，请新建一个不带这个预设的会话。`
}
