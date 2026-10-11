/**
 * Getting the ACP models into the model catalog.
 *
 * The catalog is global to one Host generation and DSH's own picker reads it,
 * so registering here is what makes an external agent's models appear in the
 * composer — without replacing that picker. Without it the session runs on the
 * external agent while the model list stays native-only, which reads as a
 * picker that has quietly stopped matching the session.
 */

import { catalogAdapter, providerRoute } from './catalog.ts'
import type { CatalogDeps } from './catalog.ts'
import type { AcpDialect } from '@threadharbor/dsh-acp-agent'
import type { AcpPresetConfig, PresetConfig } from './registry.ts'

/**
 * The provider routes this configuration adds to the catalog.
 *
 * One per preset, named after the preset so the picker's provider column reads
 * as the agent rather than as a generic adapter.
 */
export function catalogRoutes(config: PresetConfig): string[] {
  return Object.keys(config.presets).map(providerRoute)
}

/**
 * The models one preset's agent offers the picker.
 *
 * Shared by every path that answers for the catalog (the mounted plugin and the
 * standalone entry alike): two places deriving this differently is how the
 * picker and the dispatcher start disagreeing about what an agent serves.
 */
export function modelsOfPreset(
  config: PresetConfig,
  factory: { dialectFor(presetId: string, preset: AcpPresetConfig): AcpDialect | undefined },
  presetId: string,
): readonly { id: string; name: string; description?: string; contextWindow?: number }[] {
  const preset = config.presets[presetId]
  if (preset === undefined) return []
  const dialect = factory.dialectFor(presetId, preset)
  // Not ours, or an agent that publishes nothing: no models to advertise.
  if (dialect === undefined) return []
  return preset.models ?? []
}

/**
 * Register the ACP routes with the host's model registry.
 *
 * Silently does nothing when the host has no registry: dispatch still works
 * without it, and failing the whole attach over a missing catalog would take
 * the sessions down with it. Registers nothing when there are no presets,
 * because an empty registration is rejected by the runtime.
 */
export function registerCatalog(ctx: unknown, config: PresetConfig, deps: CatalogDeps): void {
  const routes = catalogRoutes(config)
  if (routes.length === 0) return
  const registry = registryOf(ctx)
  if (registry === undefined) return
  registry.registerAdapter(routes, catalogAdapter(config, deps))
}

type RegistryLike = {
  registerAdapter(providers: string[], adapter: unknown): unknown
}

/**
 * Read the host's LLM registry, or `undefined` when this host has none.
 *
 * The registry is looked up through `get` when the context offers it — the same
 * seam the entry uses for `approval` and `sessionProjections`. The property
 * fallback is guarded because on a cordis context an uninjected property throws
 * on read, and "this host has no registry" must stay a normal composition, not
 * a failed mount.
 */
function registryOf(ctx: unknown): RegistryLike | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  const getter = ctx as { get?: unknown }
  let llm: unknown
  if (typeof getter.get === 'function') {
    llm = (getter.get as (key: string) => unknown).call(ctx, 'llm')
  } else {
    try {
      llm = (ctx as { llm?: unknown }).llm
    } catch {
      // The context refuses the read rather than answering "absent"; that is
      // the same "no registry here" as a missing property.
      return undefined
    }
  }
  if (typeof llm !== 'object' || llm === null) return undefined
  const register = (llm as { registerAdapter?: unknown }).registerAdapter
  return typeof register === 'function' ? (llm as RegistryLike) : undefined
}