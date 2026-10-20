/**
 * 侧栏底部的主机切换器：纯函数把在场主机与登记簿合成可切换条目（本机第一、
 * 其余按行序），组件在侧栏底脚渲染「切换主机」入口，点可用主机整页跳到那
 * 台机器（经网关），点本机回到根路径；点不可用主机不导航。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { switchEntries, HostSwitcher } from '../src/host-switcher.tsx'
import { sharedHostSwitcherStore } from '../src/host-switcher-store.ts'
import { mergeHostRows } from '../src/panel.tsx'
import { gatewayPagePath, hostRegistry } from '@threadharbor/dsh-host-federation'
import type { HostSnapshot } from '@threadharbor/dsh-host-federation'
import { zh } from '../src/locales.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** 内存真登记簿（与 sidebar-tree 同款）：add 写存储、list 读存储，语义不走仿造。 */
function makeRegistry(entries: readonly { hostId: string; hostTitle: string; address: string; launchUrl?: string }[] = []) {
  const map = new Map<string, string>()
  const registry = hostRegistry({
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  })
  for (const entry of entries) {
    const result = registry.add(entry)
    if (!result.ok) throw new Error(`seed failed for ${entry.hostId}: ${result.error.detail}`)
  }
  return registry
}

describe('switchEntries（纯函数）', () => {
  it('本机排第一且不可跨机跳转：path 为空', () => {
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    const hosts: HostSnapshot[] = [
      { hostId: 'self-host', hostTitle: '本机', lastSeen: 1_000, self: true },
      { hostId: 'bench', hostTitle: '测试机', lastSeen: 1_000, self: false },
    ]
    const entries = switchEntries(mergeHostRows(hosts, registry.list()), registry.list())
    expect(entries.map(entry => entry.hostId)).toEqual(['self-host', 'bench'])
    expect(entries[0]?.self).toBe(true)
    expect(entries[0]?.path).toBe('')
  })

  it('没有打开地址的登记主机 launchable 为 false，仍出现在列表里', () => {
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    const entries = switchEntries(mergeHostRows([], registry.list()), registry.list())
    const bench = entries.find(entry => entry.hostId === 'bench')
    expect(bench).toBeDefined()
    expect(bench?.launchable).toBe(false)
    expect(bench?.path).toBe(gatewayPagePath('bench'))
  })

  it('有打开地址的主机 path 是 gatewayPagePath(hostId)', () => {
    const registry = makeRegistry([
      { hostId: 'peer', hostTitle: '同源另一台', address: 'http://127.0.0.1:45000', launchUrl: 'http://127.0.0.1:45000/?token=t' },
    ])
    const entries = switchEntries(mergeHostRows([], registry.list()), registry.list())
    const peer = entries.find(entry => entry.hostId === 'peer')
    expect(peer?.launchable).toBe(true)
    expect(peer?.path).toBe(gatewayPagePath('peer'))
  })
})

/** 渲染切换器并挂到文档，返回容器与 root 供断言与卸载。 */
async function renderHostSwitcher(wide: boolean) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(HostSwitcher, { wide }))
  })
  return { container, root }
}

describe('HostSwitcher（组件）', () => {
  beforeEach(() => { sharedHostSwitcherStore().set([]) })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('根元素带 data-host-switcher 标记', async () => {
    const { container, root } = await renderHostSwitcher(true)
    try {
      expect(container.querySelector('[data-host-switcher]')).not.toBeNull()
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })

  it('收起状态下按钮读出当前主机（panel.switch.current，文案「本机」起）', async () => {
    const registry = makeRegistry()
    const hosts: HostSnapshot[] = [
      { hostId: 'self-host', hostTitle: '本机', lastSeen: 1_000, self: true },
    ]
    sharedHostSwitcherStore().set(switchEntries(mergeHostRows(hosts, registry.list()), registry.list()))
    const { container, root } = await renderHostSwitcher(true)
    try {
      const trigger = container.querySelector('[data-host-switcher-trigger]')
      expect(trigger?.textContent).toContain(zh['panel.switch.current' as keyof typeof zh])
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })

  it('展开后每个 SwitchEntry 有一行，标签取 entry.label', async () => {
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    const hosts: HostSnapshot[] = [
      { hostId: 'self-host', hostTitle: '本机', lastSeen: 1_000, self: true },
      { hostId: 'bench', hostTitle: '测试机', lastSeen: 1_000, self: false },
    ]
    const entries = switchEntries(mergeHostRows(hosts, registry.list()), registry.list())
    sharedHostSwitcherStore().set(entries)
    const { container, root } = await renderHostSwitcher(true)
    try {
      act(() => {
        container.querySelector<HTMLElement>('[data-host-switcher-trigger]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      for (const entry of entries) {
        const row = container.querySelector(`[data-host-switcher-entry="${entry.hostId}"]`)
        expect(row, `row for ${entry.hostId}`).not.toBeNull()
        expect(row?.textContent).toContain(entry.label)
      }
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })

  it('launchable 为 false 的行 aria-disabled="true" 且点击不导航', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    sharedHostSwitcherStore().set(switchEntries(mergeHostRows([], registry.list()), registry.list()))
    const { container, root } = await renderHostSwitcher(true)
    try {
      act(() => {
        container.querySelector<HTMLElement>('[data-host-switcher-trigger]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      const row = container.querySelector<HTMLElement>('[data-host-switcher-entry="bench"]')
      expect(row?.getAttribute('aria-disabled')).toBe('true')
      act(() => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
      expect(assign).not.toHaveBeenCalled()
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })

  it('wide=false 时只渲染一个图标按钮，不渲染展开列表', async () => {
    const { container, root } = await renderHostSwitcher(false)
    try {
      expect(container.querySelector('[data-host-switcher-trigger]')).not.toBeNull()
      expect(container.querySelector('[data-host-switcher-list]')).toBeNull()
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })

  it('点击可用项只调用 window.location.assign，无其它调用', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    const registry = makeRegistry([
      { hostId: 'peer', hostTitle: '同源另一台', address: 'http://127.0.0.1:45000', launchUrl: 'http://127.0.0.1:45000/?token=t' },
    ])
    const entries = switchEntries(mergeHostRows([], registry.list()), registry.list())
    sharedHostSwitcherStore().set(entries)
    const { container, root } = await renderHostSwitcher(true)
    try {
      act(() => {
        container.querySelector<HTMLElement>('[data-host-switcher-trigger]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      act(() => {
        container.querySelector<HTMLElement>('[data-host-switcher-entry="peer"]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(assign).toHaveBeenCalledTimes(1)
      expect(assign).toHaveBeenCalledWith(gatewayPagePath('peer'))
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })
})
