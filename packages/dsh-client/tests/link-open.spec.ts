/**
 * 会话结果文本块的 http 链接：hover 浮出「右侧打开 / 浏览器打开」，
 * 单击走默认打开方式（可在文档框打开方式下拉里设置，存 localStorage）。
 */
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpProcessBlock } from '../src/acp-process-surface.tsx'
import { defaultLinkOpenMode, readDefaultLinkOpenMode, writeDefaultLinkOpenMode } from '../src/link-open.ts'

let container: HTMLDivElement
let root: Root

async function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(node) })
}

function segmentWithLink() {
  return {
    callId: 'c1',
    entries: [],
    blocks: [{ kind: 'text' as const, text: 'see https://example.com/docs for details' }],
  }
}

function renderBlock() {
  return mount(createElement(AcpProcessBlock, { segment: segmentWithLink(), t: (key: string) => key }))
}

function link() {
  return document.querySelector('[data-link-text-block] a[href="https://example.com/docs"]') as HTMLElement | null
}

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('默认打开方式设置', () => {
  it('未设置时默认右侧打开', () => {
    expect(readDefaultLinkOpenMode()).toBe('right')
    expect(defaultLinkOpenMode()).toBe('right')
  })

  it('写入浏览器后读出浏览器，刷新后仍保留', () => {
    writeDefaultLinkOpenMode('browser')
    expect(readDefaultLinkOpenMode()).toBe('browser')
    expect(readDefaultLinkOpenMode()).toBe('browser')
  })

  it('非法值回退到右侧', () => {
    localStorage.setItem('threadharbor.markdown.defaultLinkOpen', 'garbage')
    expect(readDefaultLinkOpenMode()).toBe('right')
  })
})

describe('http 链接 hover 工具条', () => {
  it('悬停 http 链接时浮出右侧打开与浏览器打开两个按钮', async () => {
    await renderBlock()
    expect(link()).not.toBeNull()
    await act(async () => { link()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 })) })
    const bar = document.querySelector('[data-link-tools="https://example.com/docs"]')
    expect(bar).not.toBeNull()
    expect(bar?.querySelector('[data-link-action="right"]')).not.toBeNull()
    expect(bar?.querySelector('[data-link-action="browser"]')).not.toBeNull()
  })

  it('点浏览器打开用 window.open 打开新标签', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    await renderBlock()
    await act(async () => { link()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 })) })
    const browserBtn = document.querySelector('[data-link-action="browser"]') as HTMLElement
    await act(async () => { browserBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener')
  })

  it('默认浏览器时，单击链接走 window.open 而非右侧', async () => {
    writeDefaultLinkOpenMode('browser')
    const open = vi.fn()
    vi.stubGlobal('open', open)
    await renderBlock()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link()!.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener')
  })

  it('默认右侧时，单击链接不拦截（交给宿主右侧预览）', async () => {
    writeDefaultLinkOpenMode('right')
    const open = vi.fn()
    vi.stubGlobal('open', open)
    await renderBlock()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link()!.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('移出链接后工具条隐藏', async () => {
    await renderBlock()
    await act(async () => { link()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 })) })
    expect(document.querySelector('[data-link-tools]')).not.toBeNull()
    // 指针移到链接外的正文段落：relatedTarget 落在容器内但非链接、非工具条。
    const block = document.querySelector('[data-link-text-block]') as HTMLElement
    await act(async () => { block.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: block })) })
    expect(document.querySelector('[data-link-tools]')).toBeNull()
  })
})
