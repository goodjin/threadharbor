/**
 * The settings page's own view of the host's model catalog.
 *
 * It has to read the catalog RAW. The pickers read filtered directories (see
 * acp-visibility-filter.ts), and a page that read those would stop listing
 * what it exists to let the user unhide. So this store calls
 * `remote.session.modelCatalog()` directly and keeps every row — hidden
 * providers and models included.
 *
 * Every provider group is listed, the ACP presets and the built-in providers
 * alike: the official Settings → Models page is left untouched, so this
 * section is the only place a hidden provider can be brought back. A failed
 * provider lookup is listed too: it is a registered provider, and hiding it
 * is a legitimate choice even while its catalog is unreadable.
 */

import { ACP_ROUTE_PREFIX, visibilityKeyOfRoute } from './acp-visibility.ts'

/** One model row the settings page lists. */
export type AcpCatalogModel = {
  readonly id: string
  readonly name: string
}

/** One provider row, with the models it last reported. */
export type AcpCatalogAgent = {
  /** The key the choice is stored under (see visibilityKeyOfRoute). */
  readonly key: string
  readonly route: string
  readonly name: string
  readonly models: readonly AcpCatalogModel[]
  /** Present when the host reported this provider's catalog lookup as failed. */
  readonly failure?: string
}

/** Why the catalog could not be listed. */
export type AcpCatalogError =
  | { readonly kind: 'missing' }
  | { readonly kind: 'shape' }
  | { readonly kind: 'failed'; readonly detail: string }

/** What the settings page renders. */
export type AcpCatalogSnapshot = {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly agents: readonly AcpCatalogAgent[]
  readonly error: AcpCatalogError | null
}

/** The raw wire call, or undefined when the host has no such method. */
export type AcpCatalogReader = () => Promise<unknown>

/** The settings page's catalog source. */
export type AcpCatalogStore = {
  /** The same object until the listing changes. */
  getSnapshot(): AcpCatalogSnapshot
  subscribe(listener: () => void): () => void
  /** Read the catalog; concurrent calls share one in-flight read. */
  load(force?: boolean): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** A display name that never repeats the `acp:` wire prefix at the user. */
function displayName(raw: unknown, key: string): string {
  if (typeof raw !== 'string' || raw === '') return key
  return raw.startsWith(ACP_ROUTE_PREFIX) ? raw.slice(ACP_ROUTE_PREFIX.length) : raw
}

/**
 * Unwrap the remote answer. The Remote channel wraps results as `{ ok, value }`;
 * a direct catalog object is accepted too, because some hosts answer the
 * namespace method without the wrapper.
 */
function unwrap(raw: unknown): { readonly value?: unknown; readonly error?: AcpCatalogError } {
  if (!isRecord(raw)) return { error: { kind: 'shape' } }
  if (raw['ok'] === true) return { value: raw['value'] }
  if (raw['ok'] === false) {
    const error = raw['error']
    const detail = isRecord(error) && typeof error['message'] === 'string'
      ? error['message']
      : JSON.stringify(error)
    return { error: { kind: 'failed', detail } }
  }
  return { value: raw }
}

/**
 * Normalize the catalog into provider rows, groups first and failures after.
 * A route with no representable key is skipped, and so is a duplicate key.
 * Malformed rows are skipped rather than failing the whole listing: one
 * strange entry must not leave the user unable to reach the other providers.
 * @param value - the unwrapped catalog.
 * @returns the provider rows, or a shape error when there is no groups list.
 */
export function parseAcpCatalog(value: unknown): { readonly agents?: readonly AcpCatalogAgent[]; readonly error?: AcpCatalogError } {
  if (!isRecord(value)) return { error: { kind: 'shape' } }
  const groups = value['groups']
  if (!Array.isArray(groups)) return { error: { kind: 'shape' } }
  const failures = Array.isArray(value['failures']) ? value['failures'] : []
  const agents: AcpCatalogAgent[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    if (!isRecord(group)) continue
    const route = typeof group['id'] === 'string' ? group['id'] : undefined
    const key = route === undefined ? undefined : visibilityKeyOfRoute(route)
    if (route === undefined || key === undefined || seen.has(key)) continue
    seen.add(key)
    const models: AcpCatalogModel[] = []
    for (const model of Array.isArray(group['models']) ? group['models'] : []) {
      if (!isRecord(model) || typeof model['id'] !== 'string' || model['id'] === '') continue
      models.push({
        id: model['id'],
        name: typeof model['name'] === 'string' && model['name'] !== '' ? model['name'] : model['id'],
      })
    }
    agents.push({ key, route, name: displayName(group['name'], key), models })
  }
  for (const failure of failures) {
    if (!isRecord(failure)) continue
    const route = typeof failure['id'] === 'string' ? failure['id'] : undefined
    const key = route === undefined ? undefined : visibilityKeyOfRoute(route)
    if (route === undefined || key === undefined || seen.has(key)) continue
    seen.add(key)
    const message = typeof failure['message'] === 'string' ? failure['message'] : ''
    agents.push({
      key,
      route,
      name: displayName(failure['name'], key),
      models: [],
      ...(message === '' ? {} : { failure: message }),
    })
  }
  return { agents }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Start the settings page's catalog store.
 * @param read - the raw `remote.session.modelCatalog` call, or undefined when
 * the host offers none.
 * @returns the store the settings section subscribes to.
 */
export function createAcpCatalogStore(read: AcpCatalogReader | undefined): AcpCatalogStore {
  let snapshot: AcpCatalogSnapshot = { status: 'idle', agents: [], error: null }
  const listeners = new Set<() => void>()
  let inFlight: Promise<void> | undefined
  const publish = (next: AcpCatalogSnapshot): void => {
    if (next.status === snapshot.status
      && next.agents === snapshot.agents
      && next.error === snapshot.error) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const load = async (force = false): Promise<void> => {
    if (inFlight !== undefined) return inFlight
    if (!force && snapshot.status === 'loading') return
    publish({ status: 'loading', agents: snapshot.agents, error: null })
    inFlight = (async () => {
      try {
        if (read === undefined) {
          publish({ status: 'error', agents: [], error: { kind: 'missing' } })
          return
        }
        const answered = unwrap(await read())
        if (answered.error !== undefined) {
          publish({ status: 'error', agents: [], error: answered.error })
          return
        }
        const parsed = parseAcpCatalog(answered.value)
        if (parsed.error !== undefined || parsed.agents === undefined) {
          publish({ status: 'error', agents: [], error: parsed.error ?? { kind: 'shape' } })
          return
        }
        publish({ status: 'ready', agents: parsed.agents, error: null })
      } catch (error) {
        publish({ status: 'error', agents: [], error: { kind: 'failed', detail: messageOf(error) } })
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load,
  }
}
