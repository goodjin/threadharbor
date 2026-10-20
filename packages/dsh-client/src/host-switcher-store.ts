import type { SwitchEntry } from './host-switcher.tsx'

/**
 * 切换器的状态：一份可切换条目快照，配一套订阅。形状照 `remote-session-store`
 * 的手写 store——不是 zustand，组件用 React 的 `useSyncExternalStore` 读，
 * `entries()` 就是它的快照函数（引用不变就不重画）。
 */
export type HostSwitcherStore = {
  entries(): readonly SwitchEntry[]
  set(next: readonly SwitchEntry[]): void
  subscribe(listener: () => void): () => void
}

/** 造一个切换器 store：空快照起步，`set` 整体替换并通知订阅者。 */
export function createHostSwitcherStore(): HostSwitcherStore {
  let snapshot: readonly SwitchEntry[] = []
  const listeners = new Set<() => void>()
  return {
    entries: () => snapshot,
    set: next => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

let shared: HostSwitcherStore | undefined

/** 全页面一份：入口接线往里写，组件读同一份（照 `sharedRemoteConversation` 的路子）。 */
export function sharedHostSwitcherStore(): HostSwitcherStore {
  shared ??= createHostSwitcherStore()
  return shared
}
