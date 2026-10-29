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

/** A real snapshot is required: the official seat reads state.groups directly. */
function degradedDirectory(error: unknown): DirectoryLike {
  const message = describeError(error)
  const snapshot: ModelDirectoryState = {
    current: null,
    routable: null,
    groups: [],
    failures: [],
    status: 'error',
    pending: null,
    error: message,
  }
  return {
    store: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
    load: async () => snapshot,
    select: async () => { throw new Error(message) },
  }
}

/** 一句话说明这次失败是什么（给报告用，不带堆栈）。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
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
 * The service instance of the CURRENT generation — shared across module
 * instances, because the client graph can be hot-swapped underneath us.
 *
 * 客户端图被热替换（宿主重建了客户端包，SSE 把新图推给开着的页签）之后，
 * 上一代的服务实例已被处置：它的原方法一调就抛「inactive context」。而官方那个
 * 模型座位**可能还攥着上一代那个实例**（座位的 inject 与服务的替换之间有个
 * 缝）——座位条目就此崩掉，输入框的模型入口整个消失，而页签不会自愈
 * （2026-10-20 桌面版现场：空白首页没事，有会话的窗口就废了）。
 *
 * 所以每个包装层在调用时都转到**当下这一代**的服务。可「当下这一代」不能住在
 * 模块变量里：热替换会把模块**重新求值**，新的一份模块变量是空的，而旧的那份
 * （还装在旧实例上、还被座位攥着）停在上一代——两边对不上，就地再死一次
 * （2026-10-21 桌面版现场：每次宿主侧的插件一动，页签里的模型名就消失）。
 *
 * 这个指针因此住在页面的全局上（`Symbol.for` 的全局注册表），新旧两份模块
 * 看到的是同一份。
 */
const CURRENT_SERVICE_KEY = Symbol.for('threadharbor.acpVisibility.currentService')

/** The one slot every module instance of this module shares. */
function currentServiceSlot(): { service?: object } {
  const scope = globalThis as unknown as Record<symbol, { service?: object } | undefined>
  const existing = scope[CURRENT_SERVICE_KEY]
  if (existing !== undefined) return existing
  const created: { service?: object } = {}
  scope[CURRENT_SERVICE_KEY] = created
  return created
}

/**
 * Cordis reads return a new caller-context proxy, including a new method proxy
 * on every read. Patch the underlying instance so identity and cleanup work,
 * and never retain the installing plugin's context as the method receiver.
 * This is Cordis's exported symbols.original key, shared across module copies.
 */
function serviceInstance(service: object): object {
  const original: unknown = (service as Record<symbol, unknown>)[Symbol.for('cordis.original')]
  return isRecord(original) ? original : service
}

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
  const instance = serviceInstance(service)
  const holder = instance as { directoryFor?: unknown }
  const patch = patches.get(instance)
  const candidate = patch?.original ?? holder.directoryFor
  if (typeof candidate !== 'function') {
    report('acp visibility: modelDirectories has no directoryFor — the pickers list every provider')
    return undefined
  }
  const original = candidate as (...args: unknown[]) => unknown
  // 这一代就是当下这一代：后面装的（新一代的）会覆盖同一个槽位。
  currentServiceSlot().service = instance
  // Weak refs: this installation must not keep every session's directory
  // alive. Dead refs are pruned whenever the choice changes.
  const live = new Set<WeakRef<FilteredStore>>()
  const cache = new WeakMap<object, DirectoryLike>()
  let shapeReported = false
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    // Retained wrappers follow the live generation, including its visibility
    // settings. Do not wrap its already-filtered result with stale settings.
    const shared = currentServiceSlot().service
    if (shared !== undefined && shared !== instance) {
      const current = (shared as { directoryFor?: (...args: unknown[]) => unknown }).directoryFor
      if (typeof current === 'function') return current.apply(shared, args)
    }
    // Preserve Cordis's caller context for normal calls. The installer is only
    // responsible for the patch's lifetime, never for later directory reads.
    const receiver = isRecord(this) ? this : instance
    let raw: unknown
    try {
      raw = original.apply(receiver, args)
    } catch (error) {
      if (!shapeReported) {
        shapeReported = true
        const note = `acp visibility: model directory unavailable (${describeError(error)})`
        report(note)
        console.warn(`[threadharbor] ${note}`)
      }
      return degradedDirectory(error)
    }
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
  patches.set(instance, { original, wrapper })
  return () => {
    unsubscribe()
    if (holder.directoryFor === wrapper) holder.directoryFor = original
    const installed = patches.get(instance)
    if (installed?.wrapper === wrapper) {
      patches.delete(instance)
      if (currentServiceSlot().service === instance) delete currentServiceSlot().service
    }
  }
}
