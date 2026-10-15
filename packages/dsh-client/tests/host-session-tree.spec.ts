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

  it('本机项目行内「新会话」→ startSession(项目)', async () => {
    const { container, root, ctx } = await mountTree()
    try {
      click(container, '[data-project-group="w1"] [data-action="tree-new-session"]')
      expect(ctx.started).toEqual(['w1'])
    } finally { await unmount(root) }
  })

  it('本机打开派发失败：树上如实说，不静默', async () => {
    const { container, root } = await mountTree({ ctx: { get: () => undefined } })
    try {
      click(container, '[data-session-row="s1"]')
      expect(container.querySelector('[data-open-failed]')?.textContent).toContain('打开会话失败')
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
