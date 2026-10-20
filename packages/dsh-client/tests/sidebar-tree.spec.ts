/**
 * 遮蔽注册与实验开关：默认不注册，原生浏览区照常；只有显式把
 * threadharbor.sidebarTree 设为 'on'，maybeRegisterSidebarTree 才以更低
 * 优先级数值注册 sidebar.workspaces（槽位机制：数值最小者渲染，原生
 * 占位者被遮蔽）。组件容器 ShadowTreeHost 组装本机读取、远端轮询与
 * 登记簿合成，喂给 HostSessionTree；自身不发请求的纯渲染树已在
 * host-session-tree.spec 覆盖，这里测的是接线。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { maybeRegisterSidebarTree, ShadowTreeHost, TREE_STORAGE_KEY, type TreeSlotHost } from '../src/sidebar-tree.ts'
import { HostSessionTree } from '../src/host-session-tree.tsx'
import { hostRegistry } from '@threadharbor/dsh-host-federation'
import { zh } from '../src/locales.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function zhT(key: string, params?: Record<string, unknown>): string {
  return zh[key as keyof typeof zh]!.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

/** 内存真登记簿（与 panel-interact 同款）：add 写存储、list 读存储，语义不走仿造。 */
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

const makeSlots = (): TreeSlotHost & { registered: Array<{ name: string; priority?: number }> } => {
  const registered: Array<{ name: string; priority?: number }> = []
  return {
    registered,
    inject: (_slot: string, callback: () => () => void) => callback(),
    register: (options: { name: string; priority?: number; locale?: string }, _component: unknown) => {
      registered.push({ name: options.name, priority: options.priority, ...(options.locale === undefined ? {} : { locale: options.locale }) })
      return () => {}
    },
  }
}

beforeEach(() => { localStorage.clear() })

describe('maybeRegisterSidebarTree（遮蔽注册与开关）', () => {
  it('默认不注册：原生浏览区照常', () => {
    const slots = makeSlots()
    maybeRegisterSidebarTree(slots, { get: () => undefined })
    expect(slots.registered).toEqual([])
  })

  it('开关 on：以更低优先级数值与 locale 声明注册 sidebar.workspaces', () => {
    localStorage.setItem(TREE_STORAGE_KEY, 'on')
    const slots = makeSlots()
    maybeRegisterSidebarTree(slots, { get: () => undefined })
    expect(slots.registered).toEqual([{ name: 'sidebar.workspaces', priority: -10, locale: 'threadharborClient' }])
  })

  it('同一槽位重复注册（HMR 场景）：第二次静默跳过', () => {
    localStorage.setItem(TREE_STORAGE_KEY, 'on')
    const slots = makeSlots()
    maybeRegisterSidebarTree(slots, { get: () => undefined })
    maybeRegisterSidebarTree(slots, { get: () => undefined })
    expect(slots.registered).toHaveLength(1)
  })
})

/** 按真实投影形状造假：快照在 list.getSnapshot()，会话是 ids + byId。 */
class FakeWorkspaces {
  readonly list = {
    getSnapshot: () => ({
      state: 'ready',
      items: [{ workspaceId: 'w1', title: '研究', path: '/r', sessionIds: ['s1'] }],
      archivedSessionIds: [] as string[],
    }),
  }
}
class FakeSessions {
  readonly list = {
    getSnapshot: () => ({
      ids: ['s1'],
      byId: { s1: { displayTitle: '会话 1' } } as Record<string, { displayTitle?: string; title?: string }>,
    }),
  }
}

describe('槽位组件在无注入 props 时的生产真相', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const captureComponent = (ctx: { get(name: string): unknown }): (props: Record<string, unknown>) => unknown => {
    // This block tests the shadow component itself, which is opt-in now.
    localStorage.setItem(TREE_STORAGE_KEY, 'on')
    const slots = makeSlots()
    const registry = makeRegistry([{ hostId: 'mini', hostTitle: '迷你主机', address: 'http://127.0.0.1:1' }])
    let component: (props: Record<string, unknown>) => unknown = () => null
    const originalRegister = slots.register
    ;(slots as { register: typeof slots.register }).register = (options, comp) => {
      component = comp as (props: Record<string, unknown>) => unknown
      return originalRegister(options, comp)
    }
    maybeRegisterSidebarTree(slots, ctx, registry)
    return component
  }

  it('无注入 props 的生产真相：未部署行点击不再切面板，指引在提示文案里', async () => {
    const layoutCalls: string[] = []
    const services = {
      workspaces: new FakeWorkspaces(),
      sessions: new FakeSessions(),
      layout: { selectPanel: (id: string) => { layoutCalls.push(id) } },
    }
    const component = captureComponent({ get: (name: string) => services[name as keyof typeof services] })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(component as never, {}))
    })
    try {
      const note = container.querySelector('[data-undeployed-note]')?.textContent ?? ''
      expect(note).toContain('设置')
      const el = container.querySelector<HTMLElement>('[data-host-node="mini"] [data-host-toggle]')
      if (el === null) throw new Error('mini row missing')
      act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
      expect(layoutCalls).toEqual([])
    } finally {
      await act(async () => { root.unmount() })
    }
  })
})

describe('ShadowTreeHost（选中态：当前会话高亮随面板激活让位）', () => {
  it('主视图占用的会话行带 data-active；面板激活时不亮', async () => {
    const listeners: Array<() => void> = []
    const sessions = {
      list: {
        getSnapshot: () => ({
          ids: ['s1'],
          byId: { s1: { displayTitle: '修登录', retainedBy: { mainView: 2 } } },
        }),
        subscribe: (listener: () => void) => { listeners.push(listener); return () => {} },
      },
    }
    const workspaces = {
      list: {
        getSnapshot: () => ({
          state: 'idle',
          items: [{ workspaceId: 'w1', title: 'Web', path: '/w', sessionIds: ['s1'] }],
          archivedSessionIds: [],
        }),
      },
    }
    let panelActive = false
    const layout = {
      panelInfo: {
        getSnapshot: () => ({ activePanelId: panelActive ? 'some-panel' : null }),
        subscribe: (listener: () => void) => { listeners.push(listener); return () => {} },
      },
    }
    const services: Record<string, unknown> = { workspaces, sessions, layout }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ShadowTreeHost, { ctx: { get: (name: string) => services[name] }, registry: makeRegistry([]) }))
    })
    try {
      expect(container.querySelector('[data-session-row="s1"]')?.getAttribute('data-active')).toBe('true')
      panelActive = true
      await act(async () => { for (const notify of listeners) notify() })
      expect(container.querySelector('[data-session-row="s1"]')?.getAttribute('data-active')).toBeNull()
    } finally {
      await act(async () => { root.unmount() })
    }
  })
})

describe('ShadowTreeHost（容器接线：本机订阅与提示措辞）', () => {
  it('服务发布变更即刻重读：不等 30 秒轮询', async () => {
    const listeners: Array<() => void> = []
    const workspaces = {
      list: { getSnapshot: () => ({ state: 'loading', items: [], archivedSessionIds: [] }) },
      subscribe: (listener: () => void) => { listeners.push(listener); return () => {} },
    }
    const sessions = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      subscribe: (listener: () => void) => { listeners.push(listener); return () => {} },
    }
    const services = { workspaces, sessions }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ShadowTreeHost, { ctx: { get: (name: string) => services[name] }, registry: makeRegistry([]) }))
    })
    try {
      expect(container.querySelector('[data-local-note]')?.textContent ?? '').toContain('还在加载')
      // 服务水合完成并发布
      const ready = {
        list: {
          getSnapshot: () => ({
            state: 'idle',
            items: [{ workspaceId: 'w1', title: 'Web', path: '/w', sessionIds: ['s1'] }],
            archivedSessionIds: [],
          }),
        },
        subscribe: workspaces.subscribe,
      }
      const sessionsReady = {
        list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { displayTitle: '修登录' } } }) },
        subscribe: sessions.subscribe,
      }
      ;(services as Record<string, unknown>).workspaces = ready
      ;(services as Record<string, unknown>).sessions = sessionsReady
      await act(async () => { for (const notify of listeners) notify() })
      expect(container.querySelector('[data-local-note]')).toBeNull()
      expect(container.querySelector('[data-project-group="w1"]')).not.toBeNull()
      expect(container.querySelector('[data-session-row="s1"]')?.textContent).toContain('修登录')
    } finally {
      await act(async () => { root.unmount() })
    }
  })

  it('本机未就绪的提示不带「拉取失败」前缀（本机是读，不是拉）', async () => {
    const workspaces = { list: { getSnapshot: () => ({ state: 'loading', items: [], archivedSessionIds: [] }) } }
    const sessions = { list: { getSnapshot: () => ({ ids: [], byId: {} }) } }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ShadowTreeHost, { ctx: { get: (name: string) => name === 'workspaces' ? workspaces : sessions }, registry: makeRegistry([]) }))
    })
    try {
      const note = container.querySelector('[data-local-note]')?.textContent ?? ''
      expect(note).toContain('还在加载')
      expect(note.startsWith('拉取失败')).toBe(false)
      expect(container.querySelector('[data-host-error]')).toBeNull()
    } finally {
      await act(async () => { root.unmount() })
    }
  })
})

describe('ShadowTreeHost（容器接线）', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('本机服务就绪 + 登记簿远端主机：合成视图喂树，本机会话真实可见', async () => {
    const registry = makeRegistry([{ hostId: 'mini', hostTitle: '迷你主机', address: 'http://127.0.0.1:1' }])
    const services = { workspaces: new FakeWorkspaces(), sessions: new FakeSessions() }
    const ctx = { get: (name: string) => (name === 'workspaces' || name === 'sessions' ? services[name] : undefined) }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ShadowTreeHost, {
        ctx, registry, t: zhT, fetchNow: async () => ({ sessions: [] }),
      }))
    })
    try {
      expect(container.querySelector('[data-session-row="s1"]')?.textContent).toContain('会话 1')
      expect(container.querySelector('[data-host-node="mini"]')?.getAttribute('data-undeployed')).toBe('true')
    } finally {
      await act(async () => { root.unmount() })
    }
  })

  it('本机服务缺失：树不空白，显示未就绪原因', async () => {
    const registry = makeRegistry()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ShadowTreeHost, {
        ctx: { get: () => undefined }, registry, t: zhT, fetchNow: async () => ({ sessions: [] }),
      }))
    })
    try {
      expect(container.querySelector('[data-host-tree]')?.textContent).toContain('读不到项目列表')
    } finally {
      await act(async () => { root.unmount() })
    }
  })

  it('点未部署主机行：不再有面板可切，事件也不发（桥已随主区注册一并拆除）', async () => {
    const events: string[] = []
    const listener = (e: Event): void => { events.push((e as CustomEvent).type) }
    window.addEventListener('threadharbor:focus-host', listener)
    const services = { workspaces: new FakeWorkspaces(), sessions: new FakeSessions() }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ShadowTreeHost, { ctx: { get: (name: string) => services[name] }, registry: makeRegistry([{ hostId: 'mini', hostTitle: '迷你主机', address: 'http://127.0.0.1:1' }]) }))
    })
    try {
      const el = container.querySelector<HTMLElement>('[data-host-node="mini"] [data-host-toggle]')
      if (el === null) throw new Error('mini row missing')
      act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
      expect(events).toEqual([])
    } finally {
      window.removeEventListener('threadharbor:focus-host', listener)
      await act(async () => { root.unmount() })
    }
  })

  it('远端主机有 launchUrl：挂载即发起一次拉取，失败原文入树', async () => {
    const registry = makeRegistry([{ hostId: 'mini', hostTitle: '迷你主机', address: 'http://127.0.0.1:45000', launchUrl: 'http://127.0.0.1:45000/?token=x' }])
    const services = { workspaces: new FakeWorkspaces(), sessions: new FakeSessions() }
    const ctx = { get: (name: string) => (name === 'workspaces' || name === 'sessions' ? services[name] : undefined) }
    const fetchNow = vi.fn(async () => ({ failed: 'HTTP 500' }))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ShadowTreeHost, { ctx, registry, t: zhT, fetchNow }))
    })
    try {
      expect(fetchNow).toHaveBeenCalledWith('http://127.0.0.1:45000/?token=x')
      expect(container.querySelector('[data-host-error]')?.textContent).toContain('HTTP 500')
    } finally {
      await act(async () => { root.unmount() })
    }
  })
})
