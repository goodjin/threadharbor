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

/**
 * 一个什么都不答的目录，给「服务已经没了」的那一档用。
 *
 * 形状与真目录一致（store / load / select），所以座位与选择器都能照常渲染：
 * 目录是空的，触发按钮退回占位文案，选择器列出全部 provider（不筛选）。
 */
function degradedDirectory(): DirectoryLike {
  return {
    store: {
      getSnapshot: () => undefined as unknown as ModelDirectoryState,
      subscribe: () => () => {},
    },
    load: async () => undefined,
    select: async () => undefined,
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
 * The service instance of the CURRENT generation.
 *
 * 客户端图被热替换（宿主重建了客户端包，SSE 把新图推给开着的页签）之后，
 * 上一代的服务实例已被处置：它的原方法一调就抛「inactive context」。而官方那个
 * 模型座位**可能还攥着上一代那个实例**（座位的 inject 与服务的替换之间有个
 * 缝）——座位条目就此崩掉，输入框的模型入口整个消失，而页签不会自愈
 * （2026-10-20 桌面版现场：空白首页没事，有会话的窗口就废了）。
 *
 * 所以每个包装层在调用时都转到**当下这一代**的服务：旧实例上装的包装层照样
 * 服务当下的目录，模型就回来了。安装时更新这里的指向即可（每次安装都是新一代）。
 */
let currentService: object | undefined

/** 一个实例上未被包装的 `directoryFor`（装过就用装前那个，免得叠层）。 */
function pristineOf(instance: object): ((...args: unknown[]) => unknown) | undefined {
  const installed = patches.get(instance)
  const candidate = installed?.original ?? (instance as { directoryFor?: unknown }).directoryFor
  return typeof candidate === 'function' ? candidate as (...args: unknown[]) => unknown : undefined
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
  const holder = service as { directoryFor?: unknown }
  const patch = patches.get(service)
  const candidate = patch?.original ?? holder.directoryFor
  if (typeof candidate !== 'function') {
    report('acp visibility: modelDirectories has no directoryFor — the pickers list every provider')
    return undefined
  }
  const original = candidate as (...args: unknown[]) => unknown
  // 这一代就是当下这一代：后面装的（新一代的）会覆盖它。
  currentService = service
  // Weak refs: this installation must not keep every session's directory
  // alive. Dead refs are pruned whenever the choice changes.
  const live = new Set<WeakRef<FilteredStore>>()
  const cache = new WeakMap<object, DirectoryLike>()
  let shapeReported = false
  const wrapper = (...args: unknown[]): unknown => {
    // 先找当下这一代的服务：图被热替换后，这个实例可能已经是上一代的了。
    const target = currentService ?? service
    const targetOriginal = target === service ? original : pristineOf(target)
    let raw: unknown
    try {
      raw = targetOriginal === undefined ? undefined : targetOriginal.apply(target, args)
    } catch (error) {
      // 服务没了（连接重建后旧实例被处置，它的上下文已失效）：原方法一调就抛
      // 「cannot get required service "remote.session" in inactive context」。
      // 异常顺着调用方冒上去，崩的是**座位条目**——2026-10-20 桌面版：官方那个
      // 模型座位崩了，输入框的模型入口整个消失。
      //
      // 这里给一个「什么都不答」的目录：座位照常渲染（目录是空的，触发按钮退回
      // 占位文案），选择器列出全部 provider（不筛选），而崩溃没有了。
      if (!shapeReported) {
        shapeReported = true
        const note = `acp visibility: the model directory service is gone (${describeError(error)}) — the pickers keep working, unfiltered`
        report(note)
        // 宿主日志在浏览器里看不见，而这一档正是用户在浏览器控制台里排查的那一档：
        // 不留一条，症状就只剩「模型列表空了」，没有任何线索（2026-10-20 桌面版）。
        console.warn(`[threadharbor] ${note}`)
      }
      return degradedDirectory()
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
  patches.set(service, { original, wrapper })
  return () => {
    unsubscribe()
    if (holder.directoryFor === wrapper) holder.directoryFor = original
    const installed = patches.get(service)
    if (installed?.wrapper === wrapper) patches.delete(service)
  }
}
