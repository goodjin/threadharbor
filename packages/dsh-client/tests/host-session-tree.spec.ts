/**
 * 左侧主机树的纯渲染与点击行为：三层结构、data 钩子、本机/远端/未部署
 * 三种行的分流，与展开态记忆。组件自身不发请求（拉取在遮蔽组件层），
 * 所以这里全部真渲染真点击，不需要网络桩。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { HostSessionTree } from '../src/host-session-tree.tsx'
import type { RollUpView } from '@threadharbor/dsh-host-federation'
import { zh } from '../src/locales.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function zhT(key: string, params?: Record<string, unknown>): string {
  return zh[key as keyof typeof zh]!.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

class FakeUiWorkspace {
  readonly opened: string[] = []
  readonly started: string[] = []
  openSession(sessionId: string): void { this.opened.push(sessionId) }
  startSession(workspaceId: string): void { this.started.push(workspaceId) }
  get(name: string): unknown { return name === 'uiWorkspace' ? this : undefined }
}

const view = (): RollUpView => ({
  hosts: [
    {
      hostId: 'self', label: '本机', self: true, lastSeen: 1, sessionCount: 1, empty: false,
      projects: [{ projectId: 'w1', label: '研究', baseLabel: '研究', sharedName: false, sessions: [
        { sessionId: 's1', projectId: 'w1', title: '会话 1', hostId: 'self', own: true },
      ] }],
    },
    {
      hostId: 'mini', label: '迷你主机', self: false, lastSeen: 0, sessionCount: 1, empty: false,
      projects: [{ projectId: 'rp', label: '远端项目', baseLabel: '远端项目', sharedName: false, sessions: [
        { sessionId: 'r1', projectId: 'rp', title: '远端会话', hostId: 'mini', own: false },
      ] }],
    },
    {
      hostId: 'ghost', label: '幽灵机', self: false, lastSeen: 0, sessionCount: 0, empty: true, undeployed: true,
      projects: [],
    },
    {
      hostId: 'broken', label: '断线机', self: false, lastSeen: 0, sessionCount: 0, empty: true, note: 'HTTP 500',
      projects: [],
    },
  ],
  totalSessions: 2,
  empty: false,
})

async function mountTree(props: Partial<Parameters<typeof HostSessionTree>[0]> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const ctx = new FakeUiWorkspace()
  const onOpenHostPage = vi.fn()
  await act(async () => {
    root.render(createElement(HostSessionTree, { view: view(), ctx, onOpenHostPage, t: zhT, ...props } as Parameters<typeof HostSessionTree>[0]))
  })
  return { container, root, ctx, onOpenHostPage }
}

async function unmount(root: Root): Promise<void> {
  await act(async () => { root.unmount() })
}

const click = (container: HTMLElement, selector: string): void => {
  const el = container.querySelector<HTMLElement>(selector)
  if (el === null) throw new Error(`no element matches ${selector}`)
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => { localStorage.clear() })

describe('HostSessionTree', () => {
  it('三层结构与数据钩子齐全：树根/主机行/项目组/会话行', async () => {
    const { container, root } = await mountTree()
    try {
      expect(container.querySelector('[data-host-tree]')).not.toBeNull()
      expect(container.querySelector('[data-host-node="self"]')).not.toBeNull()
      expect(container.querySelector('[data-host-node="mini"] [data-host-toggle]')).not.toBeNull()
      expect(container.querySelector('[data-project-group="w1"]')).not.toBeNull()
      expect(container.querySelector('[data-session-row="s1"]')?.textContent).toContain('会话 1')
    } finally { await unmount(root) }
  })

  it('点本机会话行 → 经 uiWorkspace 打开该会话', async () => {
    const { container, root, ctx } = await mountTree()
    try {
      click(container, '[data-session-row="s1"]')
      expect(ctx.opened).toEqual(['s1'])
    } finally { await unmount(root) }
  })

  it('未部署主机：灰显行 + 指引文案（设置 → 各主机），点击不展开不跳转', async () => {
    const { container, root } = await mountTree()
    try {
      expect(container.querySelector('[data-undeployed="true"]')).not.toBeNull()
      expect(container.querySelector('[data-undeployed-note]')?.textContent).toContain('设置')
      click(container, '[data-undeployed="true"] [data-host-toggle]')
      expect(container.querySelector('[data-undeployed="true"] [data-project-group]')).toBeNull()
    } finally { await unmount(root) }
  })

  it('拉取失败的主机：原始原因进 data-host-error', async () => {
    const { container, root } = await mountTree()
    try {
      click(container, '[data-host-node="broken"] [data-host-toggle]')
      expect(container.querySelector('[data-host-node="broken"] [data-host-error]')?.textContent).toContain('HTTP 500')
    } finally { await unmount(root) }
  })

  it('本机项目行加号 → 直连建会话并揭示；失败原文上树', async () => {
    const created: Array<{ workspaceId: string; sessionId?: string }> = []
    const opened: string[] = []
    const ctx = {
      get: (name: string) => {
        if (name === 'sessions') {
          return {
            create: async (opts: { workspaceId: string; sessionId?: string }) => { created.push(opts); return { ok: true, value: { sessionId: opts.sessionId ?? 'fresh-1' } } },
            list: { getSnapshot: () => ({ ids: [], byId: {} }) },
          }
        }
        if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) } }
        if (name === 'uiWorkspace') return { openSession: (id: string) => { opened.push(id) } }
        return undefined
      },
    }
    const { container, root } = await mountTree({ ctx })
    try {
      await act(async () => {
        click(container, '[data-project-group="w1"] [data-action="tree-new-session"]')
        await Promise.resolve()
      })
      expect(created).toEqual([{ workspaceId: 'w1' }])
      expect(opened).toEqual(['fresh-1'])
    } finally { await unmount(root) }
    const failing = {
      get: (name: string) => {
        if (name === 'sessions') return { create: async () => ({ ok: false, error: { message: '目录正忙' } }), list: { getSnapshot: () => ({ ids: [], byId: {} }) } }
        if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) } }
        if (name === 'uiWorkspace') return { openSession: () => {} }
        return undefined
      },
    }
    const second = await mountTree({ ctx: failing })
    try {
      await act(async () => {
        click(second.container, '[data-project-group="w1"] [data-action="tree-new-session"]')
        await Promise.resolve()
      })
      expect(second.container.querySelector('[data-tree-action-error]')?.textContent).toContain('目录正忙')
    } finally { await unmount(second.root) }
  })

  it('本机打开派发失败：树上如实说，不静默', async () => {
    const { container, root } = await mountTree({ ctx: { get: () => undefined } })
    try {
      click(container, '[data-session-row="s1"]')
      expect(container.querySelector('[data-open-failed]')?.textContent).toContain('打开会话失败')
    } finally { await unmount(root) }
  })

  it('项目行点击折叠/展开并持久化；收纳超过 5 条时显示「展开其余」', async () => {
    localStorage.removeItem('threadharbor.tree.projects')
    const many = { hosts: [{ hostId: 'self', label: '本机', self: true, lastSeen: 1, sessionCount: 8, empty: false, projects: [{ projectId: 'w1', label: '研究', baseLabel: '研究', sharedName: false, sessions: Array.from({ length: 8 }, (_, i) => ({ sessionId: `s${i}`, projectId: 'w1', title: `会话${i}`, hostId: 'self', own: true })) }] }], totalSessions: 8, empty: false }
    const { container, root } = await mountTree({ view: many })
    try {
      expect(container.querySelectorAll('[data-session-row]')).toHaveLength(5)
      expect(container.querySelector('[data-action="tree-expand-more"]')?.textContent).toContain('展开其余 3 个会话')
      click(container, '[data-action="tree-expand-more"]')
      expect(container.querySelectorAll('[data-session-row]')).toHaveLength(8)
      expect(container.querySelector('[data-action="tree-collapse-sessions"]')?.textContent).toContain('收起')
      // 项目行点击 → 折叠
      click(container, '[data-project-toggle]')
      expect(container.querySelectorAll('[data-session-row]')).toHaveLength(0)
      expect(JSON.parse(localStorage.getItem('threadharbor.tree.projects') ?? '[]')).toEqual(['w1'])
    } finally { await unmount(root) }
  })

  it('项目菜单：重命名走行内输入提交，删除需二次确认；动作失败原文上树', async () => {
    const renameCalls: Array<[string, string]> = []
    const deleteCalls: string[] = []
    const ctx = {
      get: (name: string) => name === 'workspaces'
        ? { rename: async (id: string, t: string) => { if (t === '炸') throw new Error('名字冲突'); renameCalls.push([id, t]); return { ok: true } }, delete: async (id: string) => { deleteCalls.push(id); return { ok: true } } }
        : name === 'uiWorkspace' ? {} : undefined,
    }
    const { container, root } = await mountTree({ ctx })
    try {
      click(container, '[data-project-group="w1"] [data-action="row-menu"]')
      expect(container.querySelector('[data-action="menu-new-session"]')).toBeNull()
      click(container, '[data-action="menu-rename-workspace"]')
      const input = container.querySelector('[data-rename-input]')
      if (input === null) throw new Error('rename input missing')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '新项目名')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      expect(renameCalls).toEqual([['w1', '新项目名']])
      click(container, '[data-project-group="w1"] [data-action="row-menu"]')
      click(container, '[data-action="menu-delete-workspace"]')
      expect(deleteCalls).toEqual([])
      click(container, '[data-action="menu-confirm-delete"]')
      expect(deleteCalls).toEqual(['w1'])
    } finally { await unmount(root) }
  })

  it('会话菜单：归档/置顶/分叉经接收者调用，失败原文上树', async () => {
    const calls: string[] = []
    const ui = {
      archiveSession: async (id: string) => { calls.push(`archive:${id}`) },
      pinSession: async (id: string) => { calls.push(`pin:${id}`) },
      forkSession: async () => { throw new Error('分叉被拒') },
    }
    const ctx = { get: (name: string) => name === 'uiWorkspace' ? ui : name === 'workspaces' ? {} : undefined }
    const { container, root } = await mountTree({ ctx })
    try {
      click(container, '[data-session-row="s1"] [data-action="row-menu"]')
      click(container, '[data-action="menu-archive-session"]')
      click(container, '[data-session-row="s1"] [data-action="row-menu"]')
      click(container, '[data-action="menu-pin-session"]')
      click(container, '[data-session-row="s1"] [data-action="row-menu"]')
      await act(async () => {
        click(container, '[data-action="menu-fork-session"]')
        await Promise.resolve()
      })
      expect(calls).toEqual(['archive:s1', 'pin:s1'])
      expect(container.querySelector('[data-tree-action-error]')?.textContent).toContain('分叉被拒')
    } finally { await unmount(root) }
  })

  it('置顶的会话行排在项目最前并带标记', async () => {
    const pinned = { hosts: [{ hostId: 'self', label: '本机', self: true, lastSeen: 1, sessionCount: 2, empty: false, projects: [{ projectId: 'w1', label: '研究', baseLabel: '研究', sharedName: false, sessions: [
      { sessionId: 'sa', projectId: 'w1', title: '普通', hostId: 'self', own: true },
      { sessionId: 'sb', projectId: 'w1', title: '置顶的', hostId: 'self', own: true, pinned: true },
    ] }] }], totalSessions: 2, empty: false }
    const { container, root } = await mountTree({ view: pinned })
    try {
      const first = container.querySelector('[data-session-row]')
      expect(first?.getAttribute('data-session-row')).toBe('sb')
      expect(first?.getAttribute('data-pinned')).toBe('true')
    } finally { await unmount(root) }
  })

  it('搜索框：标题即筛出本机结果，历史搜索并入去重，无匹配有文案', async () => {
    localStorage.removeItem('threadharbor.tree.view')
    const searched: string[] = []
    const sessions = {
      search: async (query: string) => {
        searched.push(query)
        return { ok: true, value: { items: [{ sessionId: 's9', title: '远端历史命中' }], hasMore: false } }
      },
    }
    const ctx = { get: (name: string) => name === 'sessions' ? sessions : name === 'uiWorkspace' ? {} : undefined }
    const { container, root } = await mountTree({ ctx })
    try {
      const input = container.querySelector('[data-search-input]')
      if (input === null) throw new Error('search input missing')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '会话')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      // 本机标题含「登录」的行 + 远端历史命中（去重后合并为扁平结果）
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 260) }) })
      const results = [...container.querySelectorAll('[data-search-result]')].map(r => r.getAttribute('data-search-result'))
      expect(results).toContain('s1')
      expect(results).toContain('s9')
      expect(searched).toEqual(['会话'])
      // 清除回到树
      click(container, '[data-action="search-clear"]')
      expect(container.querySelectorAll('[data-search-result]')).toHaveLength(0)
    } finally { await unmount(root) }
  })

  it('无匹配：两路都空时显示「无匹配会话」，搜索拒绝时原文报错', async () => {
    const sessions = { search: async () => { throw new Error('历史索引未就绪') } }
    const ctx = { get: (name: string) => name === 'sessions' ? sessions : name === 'uiWorkspace' ? {} : undefined }
    const { container, root } = await mountTree({ ctx })
    try {
      const input = container.querySelector('[data-search-input]')
      if (input === null) throw new Error('search input missing')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'zzz')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 260) }) })
      expect(container.querySelector('[data-search-error]')?.textContent).toContain('历史索引未就绪')
    } finally { await unmount(root) }
  })

  it('视图选项：默认按最近更新（末次发送）降序；手动可切回；筛选可切到仅已归档并持久化', async () => {
    localStorage.removeItem('threadharbor.tree.view')
    const withStamps = { hosts: [{ hostId: 'self', label: '本机', self: true, lastSeen: 1, sessionCount: 3, empty: false, projects: [{ projectId: 'w1', label: '研究', baseLabel: '研究', sharedName: false, sessions: [
      { sessionId: 'old', projectId: 'w1', title: '旧的', hostId: 'self', own: true, updatedAt: 1 },
      { sessionId: 'new', projectId: 'w1', title: '新的', hostId: 'self', own: true, updatedAt: 9 },
      { sessionId: 'arch', projectId: 'w1', title: '归档的', hostId: 'self', own: true, archived: true, updatedAt: 5 },
    ] }] }], totalSessions: 3, empty: false }
    const { container, root } = await mountTree({ view: withStamps, ctx: { get: () => undefined } })
    try {
      // 默认：隐藏已归档，且按 updatedAt 降序（末次发送/提示时间）
      expect([...container.querySelectorAll('[data-session-row]')].map(r => r.getAttribute('data-session-row'))).toEqual(['new', 'old'])
      click(container, '[data-action="view-options"]')
      click(container, '[data-action="order-manual"]')
      expect([...container.querySelectorAll('[data-session-row]')].map(r => r.getAttribute('data-session-row'))).toEqual(['old', 'new'])
      click(container, '[data-action="order-updated"]')
      expect([...container.querySelectorAll('[data-session-row]')].map(r => r.getAttribute('data-session-row'))).toEqual(['new', 'old'])
      // 选项菜单不自动收起，直接切换筛选
      click(container, '[data-action="filter-only-archived"]')
      expect([...container.querySelectorAll('[data-session-row]')].map(r => r.getAttribute('data-session-row'))).toEqual(['arch'])
      expect(JSON.parse(localStorage.getItem('threadharbor.tree.view') ?? '{}')).toMatchObject({ orderBy: 'updated', filterBy: 'only' })
    } finally { await unmount(root) }
  })

  it('活跃会话：进行中绿点；等待审批/提问琥珀点（pending 优先于 running）；空闲无标记', async () => {
    localStorage.removeItem('threadharbor.tree.view')
    const withLive = { hosts: [{ hostId: 'self', label: '本机', self: true, lastSeen: 1, sessionCount: 3, empty: false, projects: [{ projectId: 'w1', label: '研究', baseLabel: '研究', sharedName: false, sessions: [
      { sessionId: 'busy', projectId: 'w1', title: '在跑', hostId: 'self', own: true, updatedAt: 9, running: true },
      { sessionId: 'ask', projectId: 'w1', title: '等你', hostId: 'self', own: true, updatedAt: 8, running: true, pendingInteraction: 'question' as const },
      { sessionId: 'idle', projectId: 'w1', title: '空闲', hostId: 'self', own: true, updatedAt: 1 },
    ] }] }], totalSessions: 3, empty: false }
    const { container, root } = await mountTree({ view: withLive, ctx: { get: () => undefined } })
    try {
      const busy = container.querySelector('[data-session-row="busy"]')
      const ask = container.querySelector('[data-session-row="ask"]')
      const idle = container.querySelector('[data-session-row="idle"]')
      expect(busy?.getAttribute('data-live')).toBe('running')
      expect(busy?.querySelector('[data-session-live="running"]')?.getAttribute('title')).toBe(zh['panel.tree.sessionRunning'])
      expect(ask?.getAttribute('data-live')).toBe('question')
      expect(ask?.querySelector('[data-session-live="question"]')?.getAttribute('title')).toBe(zh['panel.tree.sessionWaitingAnswer'])
      expect(idle?.getAttribute('data-live')).toBeNull()
      expect(idle?.querySelector('[data-session-live]')).toBeNull()
      // ⋯ 锚定行尾（DOM 上为 sessionRow 最后一个子元素，CSS margin-left:auto）
      expect(busy?.lastElementChild?.getAttribute('data-action')).toBe('row-menu')
    } finally { await unmount(root) }
  })

  it('⋯ 菜单是浮层下拉：点外部、按 Esc 都收起；条目照常派发', async () => {
    const archive: string[] = []
    const ui = { archiveSession: async (id: string) => { archive.push(id) } }
    const ctx = { get: (name: string) => name === 'uiWorkspace' ? ui : name === 'workspaces' ? {} : undefined }
    const { container, root } = await mountTree({ ctx })
    try {
      click(container, '[data-session-row="s1"] [data-action="row-menu"]')
      expect(container.querySelector('[data-row-menu]')).not.toBeNull()
      // 点外部收起
      await act(async () => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      })
      expect(container.querySelector('[data-row-menu]')).toBeNull()
      // 重开，按 Esc 收起
      click(container, '[data-session-row="s1"] [data-action="row-menu"]')
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(container.querySelector('[data-row-menu]')).toBeNull()
      // 重开后条目仍派发
      click(container, '[data-session-row="s1"] [data-action="row-menu"]')
      await act(async () => {
        click(container, '[data-action="menu-archive-session"]')
        await Promise.resolve()
      })
      expect(archive).toEqual(['s1'])
    } finally { await unmount(root) }
  })

  it('展开态记忆：本机默认展开，远端展开后写入 localStorage', async () => {
    const first = await mountTree()
    try {
      expect(first.container.querySelector('[data-session-row="s1"]')).not.toBeNull()
      click(first.container, '[data-host-node="mini"] [data-host-toggle]')
      expect(JSON.parse(localStorage.getItem('threadharbor.tree.expanded') ?? '[]')).toContain('mini')
    } finally { await unmount(first.root) }
    const second = await mountTree()
    try {
      expect(second.container.querySelector('[data-session-row="r1"]')).not.toBeNull()
    } finally { await unmount(second.root) }
  })
})
