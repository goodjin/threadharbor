/**
 * Keeping hidden providers and models out of the two model pickers.
 *
 * Both the official `/model` popup and the composer seat read one shared
 * service, `ctx.modelDirectories`. Its `directoryFor(sessionId)` hands out a
 * per-session directory whose `store` is what the React surfaces subscribe
 * to; the popup additionally reads `load()`'s return value for its options.
 * So a filter that only wrapped the store would leave the popup listing
 * everything — the two reads must move together.
 *
 * The wrap is applied to the service instance's own `directoryFor` (the same
 * mechanism roster-filter.ts uses on `agentPresets.remoteExportList`). Each
 * raw directory is wrapped once in a Proxy that:
 *
 * - returns a filtered store for `store`,
 * - overrides `load` to await the raw load, sync, and return the filtered
 *   snapshot,
 * - binds every other member to the raw directory, so `select`, `dispose`
 *   and whatever the host adds next behave exactly as before.
 *
 * The filtered store is read-only by construction: the official surfaces only
 * read `getSnapshot`/`subscribe` from it (verified against 0.2.0-rc.2 — nothing
 * calls `store.update`/`store.set` on a model directory), and writes still go
 * through the raw directory's `select`.
 *
 * Snapshots are cached and content-compared, because `useSyncExternalStore`
 * re-renders forever if an unchanged catalog comes back as a new object.
 */

import type { ModelCatalogFailure, ModelProviderGroup, ModelReasoning } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { visibleCatalogFailures, visibleProviderGroups } from './acp-visibility.ts'
import type { AcpVisibility, AcpVisibilityStore } from './acp-visibility.ts'

type DirectoryStore = {
  getSnapshot(): ModelDirectoryState
  subscribe(listener: () => void): () => void
}

type DirectoryLike = {
  readonly store: DirectoryStore
  load(): Promise<unknown>
  select(selection: unknown): Promise<unknown>
}

/** The read-only face the pickers subscribe to. */
type FilteredStore = {
  getSnapshot(): ModelDirectoryState
  subscribe(listener: () => void): () => void
  /** Re-derive from the raw store and the current choice. */
  sync(): void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function isDirectoryLike(value: unknown): value is DirectoryLike {
  if (!isRecord(value)) return false
  const store = value['store']
  return isRecord(store)
    && typeof store['getSnapshot'] === 'function'
    && typeof store['subscribe'] === 'function'
    && typeof value['load'] === 'function'
}

function sameReasoning(left: ModelReasoning | undefined, right: ModelReasoning | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left.defaultEffort !== right.defaultEffort || left.efforts.length !== right.efforts.length) return false
  return left.efforts.every((effort, index) => {
    const other = right.efforts[index]
    return other !== undefined
      && effort.id === other.id
      && effort.name === other.name
      && effort.description === other.description
  })
}

function sameModels(left: ModelProviderGroup['models'], right: ModelProviderGroup['models']): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((model, index) => {
    const other = right[index]
    return other !== undefined
      && model.id === other.id
      && model.name === other.name
      && model.description === other.description
      && sameReasoning(model.reasoning, other.reasoning)
  })
}

function sameGroups(left: readonly ModelProviderGroup[], right: readonly ModelProviderGroup[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((group, index) => {
    const other = right[index]
    return other !== undefined
      && group.id === other.id
      && group.name === other.name
      && sameModels(group.models, other.models)
  })
}

function sameFailures(left: readonly ModelCatalogFailure[], right: readonly ModelCatalogFailure[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((failure, index) => {
    const other = right[index]
    return other !== undefined
      && failure.id === other.id
      && failure.name === other.name
      && failure.message === other.message
  })
}

/**
 * Derive one filtered snapshot, reusing the previous groups/failures arrays
 * (and the previous snapshot object) when nothing visible changed. Every
 * state field other than the two catalog lists is carried through untouched.
 */
function derive(
  raw: ModelDirectoryState,
  visibility: AcpVisibility,
  previous: ModelDirectoryState | undefined,
): ModelDirectoryState {
  const filteredGroups = visibleProviderGroups(raw.groups, visibility)
  const groups = previous !== undefined && sameGroups(filteredGroups, previous.groups)
    ? previous.groups
    : filteredGroups
  const filteredFailures = visibleCatalogFailures(raw.failures, visibility)
  const failures = previous !== undefined && sameFailures(filteredFailures, previous.failures)
    ? previous.failures
    : filteredFailures
  if (previous !== undefined
    && groups === previous.groups
    && failures === previous.failures
    && raw.current === previous.current
    && raw.retainedEffort === previous.retainedEffort
    && raw.routable === previous.routable
    && raw.status === previous.status
    && raw.pending === previous.pending
    && raw.error === previous.error) return previous
  return { ...raw, groups, failures }
}

function createFilteredStore(raw: DirectoryStore, visibility: AcpVisibilityStore): FilteredStore {
  const listeners = new Set<() => void>()
  let snapshot = derive(raw.getSnapshot(), visibility.get(), undefined)
  let stopped = false
  const sync = (): void => {
    if (stopped) return
    const next = derive(raw.getSnapshot(), visibility.get(), snapshot)
    if (next === snapshot) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  // The raw store holds this closure; the two are collected together with the
  // directory, so session teardown needs no explicit disposal here.
  raw.subscribe(sync)
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    sync,
  }
}

/**
 * Wait for the raw load, then hand back the filtered snapshot.
 *
 * The `/model` popup uses this return value (not the store) for its options,
 * which is exactly why `load` is overridden rather than passed through.
 */
function filteredLoad(raw: DirectoryLike, store: FilteredStore): () => Promise<ModelDirectoryState> {
  return async () => {
    await raw.load()
    store.sync()
    return store.getSnapshot()
  }
}

/** One installation's patch of one service instance. */
type Patch = {
  readonly original: (...args: unknown[]) => unknown
  readonly wrapper: (...args: unknown[]) => unknown
}

/**
 * The pristine `directoryFor` per service instance. Keeping only the original
 * makes a second installation rebuild on it instead of stacking filters.
 */
const patches = new WeakMap<object, Patch>()

/**
 * Wrap one model-directory service so its pickers omit what the user hid.
 * @param service - the `modelDirectories` service instance.
 * @param visibility - the current choice.
 * @param report - where a declined installation or an unexpected directory
 * shape is named.
 * @returns a disposer restoring the original method, or undefined when the
 * service cannot be wrapped.
 */
export function installAcpVisibilityFilter(
  service: unknown,
  visibility: AcpVisibilityStore,
  report: (message: string) => void = () => {},
): (() => void) | undefined {
  if (!isRecord(service)) {
    report('acp visibility: modelDirectories is not an object — the pickers list every provider')
    return undefined
  }
  const holder = service as { directoryFor?: unknown }
  const patch = patches.get(service)
  const candidate = patch?.original ?? holder.directoryFor
  if (typeof candidate !== 'function') {
    report('acp visibility: modelDirectories has no directoryFor — the pickers list every provider')
    return undefined
  }
  const original = candidate as (...args: unknown[]) => unknown
  // Weak refs: this installation must not keep every session's directory
  // alive. Dead refs are pruned whenever the choice changes.
  const live = new Set<WeakRef<FilteredStore>>()
  const cache = new WeakMap<object, DirectoryLike>()
  let shapeReported = false
  const wrapper = (...args: unknown[]): unknown => {
    const raw = original.apply(service, args)
    if (!isDirectoryLike(raw)) {
      if (!shapeReported) {
        shapeReported = true
        report('acp visibility: directoryFor returned a shape without store/load — leaving that directory unfiltered')
      }
      return raw
    }
    const object = raw as object
    const cached = cache.get(object)
    if (cached !== undefined) return cached
    const store = createFilteredStore(raw.store, visibility)
    live.add(new WeakRef(store))
    const proxied = new Proxy(raw, {
      get(target, property) {
        if (property === 'store') return store
        if (property === 'load') return filteredLoad(target, store)
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    cache.set(object, proxied)
    return proxied
  }
  holder.directoryFor = wrapper
  const unsubscribe = visibility.subscribe(() => {
    for (const ref of [...live]) {
      const store = ref.deref()
      if (store === undefined) {
        live.delete(ref)
        continue
      }
      store.sync()
    }
  })
  patches.set(service, { original, wrapper })
  return () => {
    unsubscribe()
    if (holder.directoryFor === wrapper) holder.directoryFor = original
    const installed = patches.get(service)
    if (installed?.wrapper === wrapper) patches.delete(service)
  }
}
