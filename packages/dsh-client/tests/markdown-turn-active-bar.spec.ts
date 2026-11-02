/**
 * 会话区文件操作区顶部的共享文件操作栏（ActiveFileBar）。
 *
 * 它显示当前作用（或列表第一个）文件，并把「编辑 / 展开」也挂上来：这两个按钮
 * 改的是同一份共享 store 里的展开/编辑态，和文档自己的内联按钮同步。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

const { MarkdownTurnTail } = await import('../src/markdown-turn.tsx')
const { resetActiveFilePath } = await import('../src/markdown-turn-active.ts')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

async function waitFor(check: () => boolean, what: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

function readers() {
  return {
    readPage: vi.fn(async () => ({ text: '# Hello', lines: 1, eof: true })),
    loadSummary: vi.fn(async () => ({ files: [] })),
    revealFile: vi.fn(async () => {}),
    canOpenFiles: vi.fn(async () => true),
    fileApplications: vi.fn(async () => []),
    openFile: vi.fn(async () => {}),
    sendToSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => 'new-sess'),
  }
}

function deliverables(value: unknown) {
  return { data: { get: (key: string) => key === 'deliverables' ? value : undefined } }
}

afterEach(() => {
  document.body.innerHTML = ''
  resetActiveFilePath()
})

describe('ActiveFileBar 编辑/展开', () => {
  it('顶部栏的展开按钮点开下方文档，再点收起', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
        readers: readers(),
      }))
    })
    // 顶部栏默认显示列表第一个文件，带编辑/展开按钮。
    const bar = container.querySelector('[data-active-file-bar]') as HTMLElement
    expect(bar).not.toBeNull()
    expect(bar.querySelector('[data-active-path="docs/a.md"]')).not.toBeNull()
    const expand = bar.querySelector('[data-active-expand]') as HTMLButtonElement
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    // 折叠态点展开：下方文档展开（出现正文体）。
    await act(async () => { expand.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-markdown-body="docs/a.md"]')).not.toBeNull()
    expect(container.querySelector('[data-markdown-turn] [data-expand-toggle]')?.getAttribute('aria-expanded')).toBe('true')
    // 再点收起。
    await act(async () => { expand.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await waitFor(() => container.querySelector('[data-markdown-body]') === null, 'body to collapse')
    expect(container.querySelector('[data-markdown-body]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('顶部栏的编辑按钮让下方文档进入编辑态（文本框出现）', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
        readers: readers(),
      }))
    })
    const bar = container.querySelector('[data-active-file-bar]') as HTMLElement
    const edit = bar.querySelector('[data-active-edit]') as HTMLButtonElement
    // 折叠态点编辑：先展开再进编辑态，正文体变文本框。
    await act(async () => { edit.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await waitFor(() => container.querySelector('[data-markdown-body] textarea') !== null, 'edit textarea')
    expect(container.querySelector('[data-markdown-body] textarea')).not.toBeNull()
    // 再点编辑退出。
    await act(async () => { edit.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await waitFor(() => container.querySelector('[data-markdown-body] textarea') === null, 'edit textarea to close')
    expect(container.querySelector('[data-markdown-body] textarea')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('没有文件时不渲染顶栏', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({}),
        readers: readers(),
      }))
    })
    expect(container.querySelector('[data-active-file-bar]')).toBeNull()
    await act(async () => { root.unmount() })
  })
})
