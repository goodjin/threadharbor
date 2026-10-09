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
import type { PresetConfig } from './registry.ts'

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

function registryOf(ctx: unknown): RegistryLike | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  const llm = (ctx as { llm?: unknown }).llm
  if (typeof llm !== 'object' || llm === null) return undefined
  const register = (llm as { registerAdapter?: unknown }).registerAdapter
  return typeof register === 'function' ? (llm as RegistryLike) : undefined
}