// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { SessionIdBar, registerSessionIdBar } = await import('../src/session-id-bar.ts')
const { zh } = await import('../src/locales.ts')

function zhT(key: string, params?: Record<string, unknown>): string {
  return zh[key as keyof typeof zh]!.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

async function mount(props: Record<string, unknown> = {}): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(SessionIdBar, { sessionId: 'session-3575e031-a21b-492d', t: zhT, ...props } as never))
  })
  return { container, root }
}

const click = async (container: HTMLElement, selector: string): Promise<void> => {
  const el = container.querySelector<HTMLElement>(selector)
  if (el === null) throw new Error(`missing ${selector}`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    // 剪贴板承诺在微任务里回填状态
    await Promise.resolve()
  })
}

describe('SessionIdBar（会话编号条）', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('显示短编号，悬停可见全号；点击复制走剪贴板并反馈已复制', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    const { container, root } = await mount()
    try {
      const bar = container.querySelector('[data-session-id-bar]')
      expect(bar?.textContent).toContain('3575e031')
      expect(bar?.getAttribute('title')).toContain('session-3575e031-a21b-492d')
      await click(container, '[data-action="copy-session-id"]')
      expect(writeText).toHaveBeenCalledWith('session-3575e031-a21b-492d')
      expect(container.querySelector('[data-copy-state]')?.textContent).toContain('已复制')
    } finally { await act(async () => { root.unmount() }) }
  })

  it('剪贴板拒绝时如实报错，不静默', async () => {
    Object.assign(navigator, { clipboard: { writeText: async () => { throw new Error('denied') } } })
    const { container, root } = await mount()
    try {
      await click(container, '[data-action="copy-session-id"]')
      expect(container.querySelector('[data-copy-state]')?.textContent).toContain('复制失败')
    } finally { await act(async () => { root.unmount() }) }
  })

  it('注册进会话头工具槽：inject 回调首参就是会话编号', () => {
    const injected: string[] = []
    const registrations: Array<{ name: string; id?: string }> = []
    const slots = {
      inject: (key: string, callback: () => unknown): void => {
        expect(key).toBe('conversation.session.header.utilities')
        callback()
      },
      register: (options: { name: string; id?: string; inject?: (sessionId: string) => unknown }, _component: unknown): (() => void) => {
        registrations.push({ name: options.name, id: options.id })
        if (options.inject !== undefined) injected.push(String(options.inject('session-abc')))
        return () => {}
      },
    }
    registerSessionIdBar(slots as never)
    expect(registrations).toEqual([{ name: 'conversation.session.header.utilities', id: 'threadharbor-session-id' }])
  })
})
