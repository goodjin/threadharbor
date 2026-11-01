/**
 * 会话区顶部共享文件操作栏依赖的「当前作用文件」状态。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getActiveFilePath,
  resetActiveFilePath,
  setActiveFilePath,
  subscribeActiveFilePath,
} from '../src/markdown-turn-active.ts'

afterEach(() => {
  resetActiveFilePath()
})

describe('active file path state', () => {
  it('初始没有激活文件', () => {
    expect(getActiveFilePath()).toBeNull()
  })

  it('setActive 后读到该路径，并通知订阅者', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeActiveFilePath(listener)
    setActiveFilePath('docs/a.md')
    expect(getActiveFilePath()).toBe('docs/a.md')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('重复设同一路径不重复通知', () => {
    setActiveFilePath('docs/a.md')
    const listener = vi.fn()
    const unsubscribe = subscribeActiveFilePath(listener)
    setActiveFilePath('docs/a.md')
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('设回 null 会清除并通知', () => {
    setActiveFilePath('docs/a.md')
    const listener = vi.fn()
    const unsubscribe = subscribeActiveFilePath(listener)
    setActiveFilePath(null)
    expect(getActiveFilePath()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('退订后不再通知', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeActiveFilePath(listener)
    unsubscribe()
    setActiveFilePath('docs/b.md')
    expect(listener).not.toHaveBeenCalled()
    expect(getActiveFilePath()).toBe('docs/b.md')
  })

  it('reset 回到初始空状态', () => {
    setActiveFilePath('docs/a.md')
    resetActiveFilePath()
    expect(getActiveFilePath()).toBeNull()
  })
})
