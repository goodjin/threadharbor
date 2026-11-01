/**
 * 会话区顶部共享文件操作栏依赖的「当前作用文件」状态。
 *
 * turnTail 里每个文档各自展开/折叠，但顶部那一条共享栏需要知道「现在该对
 * 哪个文件作用」。这里只存一个路径：哪个文件最近被点开/激活。不存内容、不存
 * readers——职责单一，可独立测试。`useSyncExternalStore` 直接吃这套接口。
 */

let activePath: string | null = null
const listeners = new Set<() => void>()

/** 当前作用的文件路径；没有时为 null。 */
export function getActiveFilePath(): string | null {
  return activePath
}

/**
 * 设置当前作用文件。设成与现在相同的路径不通知（避免无谓重渲染）；
 * 设成 null 清除。传非字符串按 null 处理，调用方拿到的永远是 string|null。
 * @param path - 要激活的文件路径，或 null/undefined 清除。
 */
export function setActiveFilePath(path: string | null | undefined): void {
  const next = typeof path === 'string' && path.length > 0 ? path : null
  if (next === activePath) return
  activePath = next
  for (const listener of listeners) listener()
}

/** 清除激活文件，回到初始空状态。 */
export function resetActiveFilePath(): void {
  setActiveFilePath(null)
}

/**
 * 订阅激活文件变化。返回退订函数。
 * @param listener - 变化时被调用。
 * @returns 退订函数。
 */
export function subscribeActiveFilePath(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
