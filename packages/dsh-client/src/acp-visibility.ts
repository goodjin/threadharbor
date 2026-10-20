/**
 * Which providers and models the pickers are allowed to list.
 *
 * Every provider group the catalog offers is fair game — the ACP presets and
 * the built-in providers alike (2026-10-20 extended it past `acp:`, the scope
 * it started with). The official Settings → Models page is deliberately left
 * alone: it keeps listing everything and keeps the API keys reachable, so
 * hiding is always a display choice that a checkbox reverses — never a
 * credential to re-enter.
 *
 * The choice belongs to the machine that served the page, not to the browser:
 * it is stored under one key in the host settings document (through
 * host-store.ts), so a browser switch or a cleared cache does not bring hidden
 * agents back. The settings page reads the raw catalog directly, which is what
 * lets a hidden row be listed there and unhidden; only the model directories
 * the pickers consume are filtered.
 *
 * The value is deliberately small and hand-editable:
 *
 * ```json
 * { "hiddenAgents": ["cursor", "deepseek-account"],
 *   "hiddenModels": { "codex": ["gpt-5-codex"] } }
 * ```
 *
 * The keys predate the scope change (fields, module and storage key all say
 * `acp`): an `acp:` route is keyed by its preset id (`acp:cursor` → `cursor`),
 * every other provider by its route id as-is (`deepseek-account`). They stay
 * that way because stored values on machines are read back verbatim — a rename
 * would silently drop every existing choice.
 *
 * `hiddenAgents` removes the provider group (and its failure row) whole.
 * `hiddenModels` removes individual models while the provider stays listed.
 * Hiding a provider keeps its per-model list, so unhiding the provider
 * restores the finer choice instead of silently losing it.
 */

import type {
  ModelCatalogFailure,
  ModelProviderGroup,
} from '@deepseek-ai/dsh-api-session-controller/types'

/** The provider route prefix every ACP preset registers under. */
export const ACP_ROUTE_PREFIX = 'acp:'

/** The settings-document key this choice lives under. */
export const ACP_VISIBILITY_STORAGE_KEY = 'threadharbor.acpVisibility'

/** What the user chose to keep out of the model pickers. */
export type AcpVisibility = {
  /** Provider keys hidden whole (see the key rule above). */
  readonly hiddenAgents: readonly string[]
  /** Per-provider model ids hidden while the provider itself stays listed. */
  readonly hiddenModels: Readonly<Record<string, readonly string[]>>
}

/** The storage face this module needs (host-store's Web Storage shape). */
export type AcpVisibilityStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** What the settings page and the picker filter read. */
export type AcpVisibilityStore = {
  /** The current choice; the same object until it changes. */
  get(): AcpVisibility
  subscribe(listener: () => void): () => void
  /** Replace the choice, normalizes it, and persists it through the storage. */
  set(next: AcpVisibility): void
  /** Re-read the storage after hydration or another tab's write. */
  refresh(): void
}

/** A fresh, empty choice. */
export function emptyAcpVisibility(): AcpVisibility {
  return { hiddenAgents: [], hiddenModels: {} }
}

/**
 * The key a provider route is hidden under.
 * @param route - a catalog provider id.
 * @returns the key, or undefined for a route that cannot be named.
 */
export function visibilityKeyOfRoute(route: string): string | undefined {
  const key = route.startsWith(ACP_ROUTE_PREFIX) ? route.slice(ACP_ROUTE_PREFIX.length) : route
  return key === '' ? undefined : key
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Trimmed, non-empty, deduplicated ids in a stable order. */
function cleanIds(values: readonly unknown[]): string[] {
  const ids = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (id !== '') ids.add(id)
  }
  return [...ids].sort()
}

/**
 * Drop empty values, deduplicate, and sort so two equal choices serialize to
 * the same string (which is what decides whether an edit really changed).
 * @param input - any choice, possibly carrying duplicates or blank ids.
 * @returns the canonical form.
 */
export function normalizeAcpVisibility(input: AcpVisibility): AcpVisibility {
  const entries = Object.entries(input.hiddenModels)
    .map(([agent, models]) => [agent.trim(), cleanIds(Array.isArray(models) ? models : [])] as const)
    .filter(([agent, models]) => agent !== '' && models.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
  return {
    hiddenAgents: cleanIds(input.hiddenAgents),
    hiddenModels: Object.fromEntries(entries),
  }
}

/**
 * Parse the stored string. Anything unreadable reads as "nothing hidden" —
 * a corrupt value must not hide every agent — and says so when a reporter is
 * supplied.
 * @param raw - the stored JSON string, or null when absent.
 * @param report - where an unreadable value is named.
 * @returns the canonical choice.
 */
export function parseAcpVisibility(raw: string | null | undefined, report?: (message: string) => void): AcpVisibility {
  if (typeof raw !== 'string' || raw.trim() === '') return emptyAcpVisibility()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    report?.('acp visibility: the stored value is not valid JSON — treating it as empty')
    return emptyAcpVisibility()
  }
  if (!isRecord(parsed)) {
    report?.('acp visibility: the stored value is not an object — treating it as empty')
    return emptyAcpVisibility()
  }
  const agents: string[] = []
  if (Array.isArray(parsed['hiddenAgents'])) {
    for (const value of parsed['hiddenAgents']) {
      if (typeof value === 'string') agents.push(value)
    }
  }
  const models: Record<string, readonly string[]> = {}
  if (isRecord(parsed['hiddenModels'])) {
    for (const [agent, value] of Object.entries(parsed['hiddenModels'])) {
      if (Array.isArray(value)) models[agent] = value.filter((item): item is string => typeof item === 'string')
    }
  }
  return normalizeAcpVisibility({ hiddenAgents: agents, hiddenModels: models })
}

/**
 * The canonical storage string. Key order is fixed by normalization, so two
 * equal choices compare equal without a deep-equality pass.
 * @param visibility - the choice to write.
 * @returns the JSON string.
 */
export function serializeAcpVisibility(visibility: AcpVisibility): string {
  return JSON.stringify(normalizeAcpVisibility(visibility))
}

/** Whether the whole provider is hidden. */
export function agentHidden(visibility: AcpVisibility, key: string): boolean {
  return visibility.hiddenAgents.includes(key)
}

/**
 * Whether this model was chosen to be hidden.
 *
 * This deliberately ignores a hidden provider: the settings page must still
 * show the per-model choice under a hidden provider, or unhiding it would
 * leave every model looking hidden.
 */
export function modelHidden(visibility: AcpVisibility, key: string, modelId: string): boolean {
  return visibility.hiddenModels[key]?.includes(modelId) === true
}

/** Hide or unhide one provider whole, keeping its per-model choice. */
export function setAgentHidden(visibility: AcpVisibility, key: string, hidden: boolean): AcpVisibility {
  const agents = new Set(visibility.hiddenAgents)
  if (hidden) agents.add(key)
  else agents.delete(key)
  return normalizeAcpVisibility({ hiddenAgents: [...agents], hiddenModels: visibility.hiddenModels })
}

/** Hide or unhide one model of one provider. */
export function setModelHidden(
  visibility: AcpVisibility,
  key: string,
  modelId: string,
  hidden: boolean,
): AcpVisibility {
  const models = new Set(visibility.hiddenModels[key] ?? [])
  if (hidden) models.add(modelId)
  else models.delete(modelId)
  const hiddenModels: Record<string, readonly string[]> = { ...visibility.hiddenModels }
  if (models.size === 0) delete hiddenModels[key]
  else hiddenModels[key] = [...models]
  return normalizeAcpVisibility({ hiddenAgents: visibility.hiddenAgents, hiddenModels })
}

/**
 * The provider groups a picker may list.
 *
 * A group disappears when its provider is hidden, loses its hidden models
 * otherwise, and disappears when no model remains — an empty provider heading
 * is not a choice anyone can make. A route with no representable key (an empty
 * id) passes through untouched. The input array itself is returned when
 * nothing changed, which is what keeps filtered snapshots stable for
 * `useSyncExternalStore`.
 * @param groups - the raw catalog groups.
 * @param visibility - the current choice.
 * @returns the visible groups.
 */
export function visibleProviderGroups(
  groups: readonly ModelProviderGroup[],
  visibility: AcpVisibility,
): readonly ModelProviderGroup[] {
  const hiddenAgents = new Set(visibility.hiddenAgents)
  const out: ModelProviderGroup[] = []
  let changed = false
  for (const group of groups) {
    const key = visibilityKeyOfRoute(group.id)
    if (key === undefined) {
      out.push(group)
      continue
    }
    if (hiddenAgents.has(key)) {
      changed = true
      continue
    }
    const hiddenModels = visibility.hiddenModels[key]
    if (hiddenModels === undefined || hiddenModels.length === 0) {
      out.push(group)
      continue
    }
    const hidden = new Set(hiddenModels)
    const models = group.models.filter(model => !hidden.has(model.id))
    if (models.length === group.models.length) {
      out.push(group)
      continue
    }
    changed = true
    if (models.length > 0) out.push({ ...group, models })
  }
  return changed ? out : groups
}

/**
 * The failure rows a picker may list: a hidden provider's failure goes with
 * the provider. Failures say nothing about individual models, so model hiding
 * does not touch them.
 * @param failures - the raw catalog failures.
 * @param visibility - the current choice.
 * @returns the visible failures.
 */
export function visibleCatalogFailures(
  failures: readonly ModelCatalogFailure[],
  visibility: AcpVisibility,
): readonly ModelCatalogFailure[] {
  const hiddenAgents = new Set(visibility.hiddenAgents)
  const out = failures.filter(failure => {
    const key = visibilityKeyOfRoute(failure.id)
    return key === undefined || !hiddenAgents.has(key)
  })
  return out.length === failures.length ? failures : out
}

/**
 * Start the choice over one storage.
 * @param storage - the machine-backed storage (host-store's storage face).
 * @param report - where unreadable stored values are named.
 * @returns the store the panel and the picker filter read.
 */
export function startAcpVisibility(
  storage: AcpVisibilityStorage,
  report: (message: string) => void = () => {},
): AcpVisibilityStore {
  const listeners = new Set<() => void>()
  const read = (): AcpVisibility => parseAcpVisibility(storage.getItem(ACP_VISIBILITY_STORAGE_KEY), report)
  let current = read()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    get: () => current,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: next => {
      const normalized = normalizeAcpVisibility(next)
      if (serializeAcpVisibility(normalized) === serializeAcpVisibility(current)) return
      current = normalized
      storage.setItem(ACP_VISIBILITY_STORAGE_KEY, serializeAcpVisibility(normalized))
      notify()
    },
    refresh: () => {
      const next = read()
      if (serializeAcpVisibility(next) === serializeAcpVisibility(current)) return
      current = next
      notify()
    },
  }
}
