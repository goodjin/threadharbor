/**
 * 会话区文件操作区共享的「当前作用文件」状态。
 *
 * turnTail 里每个文档各自展开/折叠，但顶部那一条共享栏（ActiveFileBar）需要知道
 * 「现在该对哪个文件作用」。这里存两样东西：
 *   1. 当前作用的文件路径（哪个文件最近被点开/激活）；
 *   2. 每个文件的展开/编辑状态——共享栏的「编辑/展开」按钮和文档自己的内联按钮
 *      改的是同一份，存在这里才能让两处同步、不各改各的。
 *
 * 不存内容、不存 readers——职责单一，可独立测试。`useSyncExternalStore` 直接吃这套
 * 接口；SSR 下没有 window，getSnapshot 退回安全空值。
 */

export interface FileUiState {
  readonly open: boolean
  readonly editing: boolean
}

const EMPTY_STATE: FileUiState = { open: false, editing: false }

let activePath: string | null = null
const fileStates = new Map<string, FileUiState>()
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
  emit()
}

/** 清除激活文件与其 UI 状态，回到初始空状态。 */
export function resetActiveFilePath(): void {
  activePath = null
  fileStates.clear()
  emit()
}

/** 订阅：激活路径或任一文件 UI 状态变化时回调。返回退订函数。 */
export function subscribeActiveFilePath(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 某文件的展开/编辑状态；没设置过返回共享空值（open=false, editing=false）。 */
export function getFileState(path: string): FileUiState {
  return fileStates.get(path) ?? EMPTY_STATE
}

/** 直接写某文件的 UI 状态并通知。 */
export function setFileState(path: string, next: FileUiState): void {
  fileStates.set(path, next)
  emit()
}

/** 切换某文件的展开态，保留编辑态。 */
export function toggleFileOpen(path: string): void {
  const state = getFileState(path)
  setFileState(path, { open: !state.open, editing: state.editing })
}

/** 切换某文件的编辑态，保留展开态。 */
export function toggleFileEditing(path: string): void {
  const state = getFileState(path)
  setFileState(path, { open: state.open, editing: !state.editing })
}

function emit(): void {
  for (const listener of listeners) listener()
}
