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
}

/** What the adapter needs from the outside world. */
export type CatalogDeps = {
  /** The models one preset's agent reports for itself. */
  modelsOf(presetId: string): readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  /** The frame dialect of one preset's agent. */
  dialectOf(presetId: string): AcpDialect | undefined
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
  return deps.modelsOf(presetId).some(model => model.id === modelId) ? presetId : undefined
}

/** Names shown in the selector for the agents we drive. */
const DISPLAY: Readonly<Record<string, string>> = {
  grok: 'Grok',
  claude: 'Claude',
  codex: 'Codex',
}

/**
 * The catalog-facing adapter.
 *
 * Deliberately implements only the display side. `stream` throws rather than
 * returning an empty stream: an external turn is driven by the replaced step
 * and never by a model request, so reaching this method means the takeover did
 * not happen — and a session that looks healthy while doing nothing is worse
 * than one that says so.
 */
export function catalogAdapter(config: PresetConfig, deps: CatalogDeps): CatalogAdapterLike {
  return {
    providerInfo: (provider: string) => {
      const presetId = presetOfRoute(provider) ?? ''
      const agent = config.presets[presetId]?.agent
      return { id: provider, name: (agent === undefined ? undefined : DISPLAY[agent]) ?? presetId }
    },

    listModels: async (provider: string) => {
      const presetId = presetOfRoute(provider)
      if (presetId === undefined) return []
      if (config.presets[presetId] === undefined) return []
      return deps.modelsOf(presetId).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      }))
    },

    stream: (options: { provider: string; model: string }) => {
      throw new Error(
        `acp catalog: ${options.provider}/${options.model} never streams — an external turn is driven by the replaced step, so reaching the model request means the takeover did not happen`,
      )
    },
  }
}

/** The adapter surface the runtime consumes, stated here so this compiles alone. */
export type CatalogAdapterLike = {
  providerInfo(provider: string): { id: string; name: string }
  listModels(provider: string): Promise<readonly CatalogModel[]>
  stream(options: { provider: string; model: string }): AsyncIterable<never>
}
