/**
 * 文档框路径栏「打开方式」下拉里的默认链接打开方式设置。
 */
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileOpenSplit } from '../src/markdown-turn-open.tsx'
import { readDefaultLinkOpenMode } from '../src/link-open.ts'

function readers() {
  return {
    canOpenFiles: vi.fn(async () => true),
    fileApplications: vi.fn(async () => []),
    openFile: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ ok: true, value: { absolutePath: '/w/a.md' } })),
    revealFile: vi.fn(async () => {}),
  }
}

let container: HTMLDivElement
let root: Root

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileOpenSplit, {
      sessionId: 'sess',
      path: 'a.md',
      readers: readers() as never,
      t: (key: string) => key,
    }))
  })
}

async function openMenu() {
  const more = container.querySelector('[data-open-path-more]') as HTMLElement
  await act(async () => { more.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('默认链接打开方式设置', () => {
  it('下拉里出现默认打开方式两项，选中浏览器写入 localStorage', async () => {
    localStorage.setItem('threadharbor.markdown.defaultLinkOpen', 'right')
    await mount()
    await openMenu()
    expect(document.body.textContent).toContain('markdownTurn.defaultOpenLink')
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[]
    const browserItem = items.find(el => el.textContent === 'markdownTurn.linkOpenBrowser')
    expect(browserItem).toBeDefined()
    await act(async () => { browserItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(readDefaultLinkOpenMode()).toBe('browser')
  })

  it('选中右侧写回 right', async () => {
    localStorage.setItem('threadharbor.markdown.defaultLinkOpen', 'browser')
    await mount()
    await openMenu()
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[]
    const rightItem = items.find(el => el.textContent === 'markdownTurn.linkOpenRight')
    expect(rightItem).toBeDefined()
    await act(async () => { rightItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(readDefaultLinkOpenMode()).toBe('right')
  })
})
