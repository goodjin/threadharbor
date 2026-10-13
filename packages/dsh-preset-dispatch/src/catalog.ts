/**
 * External agents presented to the model selector as providers.
 *
 * DSH's model catalog is Host-generation-global by design, and the adapter
 * contract explicitly blesses an adapter that only advertises models
 * ("Adapters used there must advertise their available models; the base empty
 * catalog offers no GUI selection"). So each external agent gets one provider
 * route, and the existing UI — which already renders provider + model — gains
 * those groups with no client change at all.
 *
 * The route is also the routing key: a selection carries the route, which is
 * what lets "pick a model, switch agent" work without a second lookup table.
 */

import type { AcpDialect } from '@threadharbor/dsh-acp-agent'
import type { PresetConfig } from './registry.ts'

/** One model as the catalog publishes it. */
export type CatalogModel = {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  /**
   * Reasoning efforts this model offers, when the agent publishes one model per
   * effort as `base[effort]`. Absent for bare-id agents — DSH's picker renders a
   * reasoning sub-control exactly when this is present, which is what turns the
   * effort into a separate axis instead of N duplicate rows.
   */
  readonly reasoning?: { readonly efforts: readonly { readonly id: string; readonly name: string }[] }
}

/**
 * One collapsed base model as the catalog publishes it: base id, base display
 * name, the declared description, and — only when the agent publishes efforts —
 * a `reasoning.efforts` array, which is the signal DSH's picker reads to render
 * the effort as a separate choice instead of one row per effort.
 *
 * Deliberately omits `defaultEffort`: DSH's picker treats an absent default as
 * "show a Provider default row and pre-select nothing" (it synthesizes that row
 * only when `defaultEffort` is undefined), which is the honest first paint — the
 * agent picks its own default until the user chooses an effort. Setting one here
 * would silently pre-select an effort the user never chose.
 */
function collapsedToCatalog(
  provider: string,
  model: CollapsedModel,
): CatalogModel {
  return {
    provider,
    id: model.baseId,
    name: model.displayName,
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.efforts === undefined
      ? {}
      : { reasoning: { efforts: model.efforts.map(effort => ({ id: effort.id, name: effort.name })) } }),
  }
}

/** One selectable reasoning effort, as a model the agent offers it. */
export type CatalogEffort = {
  /** The wire value the agent selects on — the `[suffix]` after the base id. */
  readonly id: string
  /** Human label, as the agent reported the suffixed entry. */
  readonly name: string
  /** The full wire id this effort stands for (`base[id]`), so a selection re-attaches it verbatim. */
  readonly wireId: string
}

/** A model after collapsing same-base entries: one base, its efforts (absent when the agent offers none). */
export type CollapsedModel = {
  /** The base wire id, with any `[effort]` suffix stripped. */
  readonly baseId: string
  /** The display name for the single base entry. */
  readonly displayName: string
  /** The declared description from the agent's report, or undefined. */
  readonly description?: string
  /** The efforts this model offers, or undefined when the agent publishes bare ids. */
  readonly efforts: readonly CatalogEffort[] | undefined
}

/**
 * Split a model id into its base and reasoning-effort suffix.
 *
 * Some agents (codex-acp, confirmed on a live `session/new` 2026-10-12) publish
 * one model per effort as `base[effort]` — six genuinely distinct wire ids, not a
 * display label. Others (claude, grok) publish bare ids with no suffix. This
 * returns the split for a suffixed id and `undefined` effort for a bare one, so
 * the caller can collapse same-base entries without assuming a fixed vocabulary.
 */
function splitEffort(id: string): { base: string; effort: string } | undefined {
  const open = id.lastIndexOf('[')
  if (open === -1 || !id.endsWith(']')) return undefined
  const base = id.slice(0, open)
  const effort = id.slice(open + 1, -1)
  if (base === '' || effort === '' || effort.includes(']') || effort.includes('[')) return undefined
  return { base, effort }
}

/**
 * Collapse same-base models into one entry and collect their efforts.
 *
 * This is what makes "reasoning effort its own choice" and "no duplicate models"
 * hold at once: a model published as `base[low]`…`base[ultra]` becomes a single
 * `base` entry carrying every effort, so DSH's picker shows the model once and
 * offers the effort as a separate axis (it renders a reasoning sub-control
 * exactly when the model advertises `reasoning.efforts`). A bare-id agent is
 * returned unchanged — no invented efforts, no collapsed rows.
 *
 * The base display name and the efforts keep whatever the agent reported; the
 * base id is the most common spelling among a model's entries (first wins ties),
 * which is stable because a model's entries share one spelling in practice.
 * @param models - The models one preset's agent offers, possibly with `[effort]` suffixes.
 * @returns One entry per base model, in first-seen order, efforts in first-seen order.
 */
export function collapseEffortModels(models: readonly { id: string; name: string; description?: string }[]): CollapsedModel[] {
  const order: string[] = []
  const byBase = new Map<string, { wireId?: string; displayName: string; description?: string; count: number; efforts: CatalogEffort[] }>()
  for (const model of models) {
    const split = splitEffort(model.id)
    if (split === undefined) {
      // Bare-id agent (claude, grok): collapse by display name, not wire id.
      // claude publishes five entries (default/opus/fable/sonnet/haiku) that all
      // display as "GLM-5.3"; without name-based dedup the picker shows five
      // identical rows. The first entry's real wire id is kept as baseId so a
      // selection re-attaches to a real id, not the display label.
      const existing = byBase.get(model.name)
      if (existing === undefined) {
        order.push(model.name)
        byBase.set(model.name, { wireId: model.id, displayName: model.name, count: 1, ...(model.description === undefined ? {} : { description: model.description }), efforts: undefined as unknown as CatalogEffort[] })
      } else {
        existing.count += 1
        if (existing.description === undefined && model.description !== undefined) existing.description = model.description
      }
      continue
    }
    const existing = byBase.get(split.base)
    if (existing === undefined) {
      order.push(split.base)
      byBase.set(split.base, { displayName: baseName(model.name, split.effort), ...(model.description === undefined ? {} : { description: model.description }), count: 1, efforts: [{ id: split.effort, name: model.name, wireId: model.id }] })
      continue
    }
    existing.count += 1
    if (existing.description === undefined && model.description !== undefined) existing.description = model.description
    if (existing.efforts !== undefined && !existing.efforts.some(effort => effort.id === split.effort)) {
      existing.efforts.push({ id: split.effort, name: model.name, wireId: model.id })
    }
  }
  return order.map(base => {
    const entry = byBase.get(base) as { wireId?: string; displayName: string; description?: string; count: number; efforts: CatalogEffort[] }
    // Bare-id rows carry the real wire id; suffixed rows use the stripped base id.
    return { baseId: entry.wireId ?? base, displayName: entry.displayName, ...(entry.description === undefined ? {} : { description: entry.description }), efforts: entry.efforts }
  })
}

/**
 * The accumulator entry for one base model, with `description` omitted entirely
 * when the agent reported none — `exactOptionalPropertyTypes` rejects an explicit
 * `undefined` for an optional property, so the field is left off rather than set.
 */
/** Strip a trailing ` (effort)` from a display name, leaving the base model's label. */
function baseName(name: string, effort: string): string {
  const suffix = `(${effort})`
  return name.endsWith(suffix) ? name.slice(0, -suffix.length).trim() : name
}


/** What the adapter needs from the outside world. */
export type CatalogDeps = {
  /** The models one preset's agent reports for itself. */
  modelsOf(presetId: string): readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  /**
   * The models one preset's agent reported on its live `session/new` reply, or
   * `undefined` while none has arrived this host generation. Present wins over
   * `modelsOf` — including present-and-empty, which is the agent saying it
   * serves nothing; the configured list must not resurrect over that answer.
   */
  runtimeModelsOf?(presetId: string): readonly { readonly id: string; readonly name: string; readonly description?: string }[] | undefined
  /** The frame dialect of one preset's agent. */
  dialectOf(presetId: string): AcpDialect | undefined
  /**
   * A model request landed on one of our routes for a session this row does
   * not drive — the user picked one of our models somewhere the takeover never
   * reached. This is where a mid-conversation switch runs, and it must end
   * loudly either way: the caller refuses to pretend to stream.
   */
  onForeignModelRequest?(request: ForeignModelRequest): Promise<void> | void
}

/** A model request that reached one of this adapter's routes from outside. */
export type ForeignModelRequest = {
  readonly provider: string
  readonly model: string
  /** The session the request belongs to, when the loop stamped one. */
  readonly sessionId: string
  /** The conversation the request would have carried, when present. */
  readonly messages?: readonly unknown[]
}

const ROUTE_PREFIX = 'acp:'

/**
 * The provider route for one preset.
 *
 * Derived from the preset id rather than stored, so it is stable across calls
 * and carries the preset back with it.
 */
export function providerRoute(presetId: string): string {
  return `${ROUTE_PREFIX}${presetId}`
}

/** The preset a route stands for, or `undefined` for a native route. */
export function presetOfRoute(route: string): string | undefined {
  return route.startsWith(ROUTE_PREFIX) ? route.slice(ROUTE_PREFIX.length) : undefined
}

/** Which preset serves one exact model, if any. */
export function presetForModel(
  config: PresetConfig,
  deps: CatalogDeps,
  route: string,
  modelId: string,
): string | undefined {
  const presetId = presetOfRoute(route)
  if (presetId === undefined) return undefined
  if (config.presets[presetId] === undefined) return undefined
  return (deps.runtimeModelsOf?.(presetId) ?? deps.modelsOf(presetId)).some(model => model.id === modelId)
    ? presetId
    : undefined
}

/** Names shown in the selector for the agents we drive. */
const DISPLAY: Readonly<Record<string, string>> = {
  grok: 'Grok',
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
}

/**
 * The catalog-facing adapter.
 *
 * Deliberately implements only the display side. `stream` never produces a
 * stream: an external turn is driven by the replaced step and never by a model
 * request, so reaching this method means the takeover did not happen. When a
 * switch hook is wired the request is treated as a switch first — planned,
 * applied or refused by name — and the stream still ends in an error naming
 * what happened, because a session that looks healthy while doing nothing is
 * worse than one that says so.
 */
export function catalogAdapter(config: PresetConfig, deps: CatalogDeps): CatalogAdapterLike {
  // One source of truth for every catalog-facing answer: the agent's own
  // report once one has landed, the operator's configured list until then.
  // Resolving and routing must read the same list the picker advertised, or a
  // selection can advertise from one list and route against another.
  const modelsFor = (presetId: string): readonly { readonly id: string; readonly name: string; readonly description?: string }[] =>
    deps.runtimeModelsOf?.(presetId) ?? deps.modelsOf(presetId)
  const adapter: CatalogAdapterLike = {
    providerInfo: (provider: string) => {
      const presetId = presetOfRoute(provider) ?? ''
      const agent = config.presets[presetId]?.agent
      return { id: provider, name: (agent === undefined ? undefined : DISPLAY[agent]) ?? presetId }
    },

    listModels: async (provider: string) => {
      const presetId = presetOfRoute(provider)
      if (presetId === undefined) return []
      if (config.presets[presetId] === undefined) return []
      const models = modelsFor(presetId)
      // Collapse same-base entries (one model published as base[low]…base[ultra])
      // into a single row carrying its efforts, so the picker shows the model
      // once and reasoning effort becomes a separate axis rather than N rows.
      // A preset that opts out (cursor, whose ids carry a config suffix rather
      // than an effort) gets one row per id, uncollapsed.
      if (config.presets[presetId]?.collapseEfforts === false) {
        return models.map(model => collapsedToCatalog(provider, {
          baseId: model.id,
          displayName: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          efforts: undefined,
        }))
      }
      return collapseEffortModels(models).map(model => collapsedToCatalog(provider, model))
    },

    // The catalog resolves every advertised model once at build time, and the
    // runtime also resolves ids that never went through the catalog (a session
    // stamped with one before the list changed). An adapter that omits this
    // method takes its whole provider group out of the picker as a failure, so
    // undeclared ids get the runtime's own default answer — identity metadata —
    // rather than a throw.
    resolveModel: async (provider: string, model: string): Promise<CatalogModel> => {
      const presetId = presetOfRoute(provider)
      const declared = presetId === undefined
        ? undefined
        : modelsFor(presetId).find(candidate => candidate.id === model)
      if (declared !== undefined) {
        return {
          provider,
          id: declared.id,
          name: declared.name,
          ...(declared.description === undefined ? {} : { description: declared.description }),
        }
      }
      // The id may be a base the catalog collapsed (the picker selects the base
      // and rides effort separately) or a bare id an older session carries.
      // Resolve it against the collapsed list so metadata and reasoning stay
      // aligned with what the picker advertised.
      const collapsed = presetId === undefined
        ? undefined
        : collapseEffortModels(modelsFor(presetId)).find(entry => entry.baseId === model)
      if (collapsed === undefined) return { provider, id: model, name: model }
      return collapsedToCatalog(provider, collapsed)
    },

    // An async generator rather than a synchronous throw: the switch hook is
    // async, and the generator's rejection surfaces to the loop as the turn's
    // error — loud, and never a silently empty answer.
    providerRetryPolicy: (): undefined => undefined,
    stream: function stream(options: { provider: string; model: string; sessionId?: unknown; messages?: readonly unknown[] }): AsyncIterable<never> {
      return (async function* foreignModelRequest(): AsyncIterable<never> {
        if (deps.onForeignModelRequest === undefined || typeof options.sessionId !== 'string') {
          throw new Error(
            `acp catalog: ${options.provider}/${options.model} never streams — an external turn is driven by the replaced step, so reaching the model request means the takeover did not happen`,
          )
        }
        const messages = Array.isArray(options.messages) ? options.messages : undefined
        await deps.onForeignModelRequest({
          provider: options.provider,
          model: options.model,
          sessionId: options.sessionId,
          ...(messages === undefined ? {} : { messages }),
        })
        // The hook reports what it did by throwing; reaching this line means it
        // performed nothing it wanted to name, so the plain takeover-diagnostic
        // is the honest remaining answer.
        throw new Error(
          `acp catalog: ${options.provider}/${options.model} never streams — an external turn is driven by the replaced step, so reaching the model request means the takeover did not happen`,
        )
      })()
    },

    // The loop resolves every native step through `llm.prepareCall()` before
    // the request is admitted (reference agent-loop `prepareRequest`, which
    // tolerates only a missing adapter — not a broken one), and the runtime
    // forwards that to the adapter unconditionally. A class-based adapter
    // inherits a default that composes `resolveModel` + `stream`; the runtime
    // packages cannot be imported here (see `dispatch.ts` for why), so the
    // same composition is stated on the object. Without it, a pick of one of
    // our models in a session that still runs its native step dies as a
    // TypeError before `stream` — and the switch chain behind it — runs.
    prepareCall: async (provider: string, model: string) => ({
      model: await adapter.resolveModel(provider, model),
      stream: (options: Parameters<CatalogAdapterLike['stream']>[0]) => adapter.stream(options),
    }),
  }
  return adapter
}

/** The adapter surface the runtime consumes, stated here so this compiles alone. */
export type CatalogAdapterLike = {
  providerInfo(provider: string): { id: string; name: string }
  listModels(provider: string): Promise<readonly CatalogModel[]>
  /**
   * The runtime resolves exact model metadata through this — once per advertised
   * model while the catalog builds, and for any model id a session carries. An
   * adapter that omits it has every route it owns reported as a catalog
   * failure, which the picker then silently drops.
   */
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<CatalogModel>
  /**
   * The loop's per-step preparation entry: the runtime calls this on the
   * adapter for every native step on one of our routes, before the request is
   * admitted or dispatched. The base class a class-based adapter inherits
   * composes `resolveModel` + `stream`; an object adapter states the same
   * composition or the step dies as a TypeError before the switch chain runs.
   */
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: CatalogModel
    stream(options: { provider: string; model: string; sessionId?: unknown; messages?: readonly unknown[] }): AsyncIterable<never>
  }>
  stream(options: { provider: string; model: string; sessionId?: unknown; messages?: readonly unknown[] }): AsyncIterable<never>
  /**
   * The runtime asks every registered adapter for this, without checking that
   * it exists — an adapter that omits it takes down every route, not just its
   * own. Undefined means "use the normal defaults", which is what we mean.
   */
  providerRetryPolicy(provider: string): undefined
  /** Same deal: consumed unconditionally, so it has to be present. */
  requestImagePricing?(options: unknown): undefined
}
