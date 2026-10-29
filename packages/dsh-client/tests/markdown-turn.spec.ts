/**
 * 会话区 Markdown 阅读区。
 *
 * 官方改动卡片不动。这里从一轮的产出、交付和改动摘要里挑文本文件，
 * 在轮次结尾展开：默认打开，一屏高，超出滚动，可收起。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'

const {
  MARKDOWN_READ_LINE_CAP,
  changesSummaryUrl,
  createMarkdownTurnReaders,
  isInlineTextPath,
  isMarkdownPath,
  markdownPathsFromSummary,
  markdownSources,
  mergeMarkdownPaths,
  readMarkdownText,
} = await import('../src/markdown-turn-sources.ts')
const {
  MARKDOWN_TAIL_ID,
  MARKDOWN_TAIL_ORDER,
  MarkdownTurnTail,
  registerMarkdownTurn,
} = await import('../src/markdown-turn.tsx')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function deliverables(value: unknown) {
  return { data: { get: (key: string) => key === 'deliverables' ? value : undefined } }
}

function page(text: string, lines: number, eof: boolean) {
  return { text, lines, eof }
}

function readers(overrides?: Partial<{
  readPage: ReturnType<typeof vi.fn>
  loadSummary: ReturnType<typeof vi.fn>
}>) {
  return {
    readPage: overrides?.readPage ?? vi.fn(async () => page('# Hello', 1, true)),
    loadSummary: overrides?.loadSummary ?? vi.fn(async () => ({ files: [] })),
  }
}

describe('markdownSources', () => {
  it('从产出和交付里挑文本，并记下改动序号', () => {
    expect(markdownSources({
      produced: [{ path: 'docs/a.md' }, { path: 'src/a.ts' }, { path: 'docs/a.md' }, { path: 'pic.png' }],
      presented: [{ path: 'notes/b.markdown' }, { path: 'docs/a.md' }, { path: 'Makefile' }],
      changes: { seq: 12 },
    })).toEqual({
      paths: ['docs/a.md', 'src/a.ts', 'notes/b.markdown', 'Makefile'],
      changesSeq: 12,
    })
  })

  it('Markdown 只认 md 后缀；文本排除已知二进制，无后缀算文本', () => {
    expect(isMarkdownPath('README.MD')).toBe(true)
    expect(isMarkdownPath('guide.markdown')).toBe(true)
    expect(isMarkdownPath('file.md.bak')).toBe(false)
    expect(isMarkdownPath('file.txt')).toBe(false)
    expect(isInlineTextPath('src/a.ts')).toBe(true)
    expect(isInlineTextPath('notes.txt')).toBe(true)
    expect(isInlineTextPath('Dockerfile')).toBe(true)
    expect(isInlineTextPath('data.csv')).toBe(true)
    expect(isInlineTextPath('icon.svg')).toBe(true)
    expect(isInlineTextPath('pic.png')).toBe(false)
    expect(isInlineTextPath('book.pdf')).toBe(false)
    expect(isInlineTextPath('deck.pptx')).toBe(false)
    expect(isInlineTextPath('pack.tar.gz')).toBe(false)
  })

  it('没有文本路径也没有改动序号时不占位', () => {
    expect(markdownSources(undefined)).toBeNull()
    expect(markdownSources({ produced: [{ path: 'a.png' }] })).toBeNull()
  })

  it('摘要补上文本，二进制标记和二进制后缀都跳过，形状不对就作废', () => {
    expect(markdownPathsFromSummary({
      files: [
        { path: 'docs/c.md', binary: false },
        { path: 'src/a.ts' },
        { path: 'pic.png' },
        { path: 'blob.md', binary: true },
      ],
    })).toEqual(['docs/c.md', 'src/a.ts'])
    expect(markdownPathsFromSummary({ ok: true })).toBe('invalid')
    expect(mergeMarkdownPaths(['docs/a.md'], ['docs/a.md', 'docs/c.md'])).toEqual(['docs/a.md', 'docs/c.md'])
  })

  it('按页拼正文，到末尾停下，超过行数上限就截断', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(page('a\nb', 2, false))
      .mockResolvedValueOnce(page('c', 1, true))
    await expect(readMarkdownText(read, 10)).resolves.toEqual({ text: 'a\nb\nc', truncated: false })
    expect(read).toHaveBeenNthCalledWith(1, 1)
    expect(read).toHaveBeenNthCalledWith(2, 3)

    const capped = vi.fn().mockResolvedValue(page('x', MARKDOWN_READ_LINE_CAP, false))
    await expect(readMarkdownText(capped, MARKDOWN_READ_LINE_CAP)).resolves.toEqual({ text: 'x', truncated: true })
  })

  it('改动摘要地址带着会话和序号', () => {
    expect(changesSummaryUrl('sess/1', 4)).toBe('api/changes.summary?sessionId=sess%2F1&seq=4')
  })
})

describe('MarkdownTurnTail', () => {
  it('产出的 Markdown 默认展开，一屏高，正文进来后可收起', async () => {
    let resolvePage: (value: { text: string, lines: number, eof: boolean }) => void = () => {}
    const face = readers({
      readPage: vi.fn(() => new Promise(resolve => { resolvePage = resolve })),
    })
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
        readers: face,
      }))
    })
    expect(container.querySelector('[data-markdown-turn]')).not.toBeNull()
    expect(container.querySelector('[data-markdown-path="docs/a.md"]')).not.toBeNull()
    expect(container.textContent).toContain('正在读取文档')
    const body = container.querySelector('[data-markdown-body="docs/a.md"]')
    expect(body).not.toBeNull()
    expect((body as HTMLElement).style.maxHeight).toBe('100dvh')
    expect((body as HTMLElement).style.overflow).toBe('auto')

    await act(async () => { resolvePage(page('# Hello', 1, true)) })
    expect(container.textContent).toContain('Hello')
    expect(face.readPage).toHaveBeenCalledWith('sess', 'docs/a.md', 1, expect.any(AbortSignal))

    const toggle = container.querySelector('button[aria-expanded="true"]')
    await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-markdown-body]')).toBeNull()
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { root.unmount() })
  })

  it('改动摘要里的文本会补进来，图片不会', async () => {
    const face = readers({
      loadSummary: vi.fn(async () => ({ files: [{ path: 'docs/c.md' }, { path: 'src/b.ts' }, { path: 'pic.png' }] })),
    })
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'src/a.ts' }], changes: { seq: 9 } }),
        readers: face,
      }))
    })
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-markdown-path="docs/c.md"]')).not.toBeNull()
    expect(container.querySelector('[data-markdown-path="src/a.ts"]')).not.toBeNull()
    expect(container.querySelector('[data-markdown-path="src/b.ts"]')).not.toBeNull()
    expect(container.querySelector('[data-markdown-path="pic.png"]')).toBeNull()
    expect(face.loadSummary).toHaveBeenCalledWith('sess', 9, expect.any(AbortSignal))
    await act(async () => { root.unmount() })
  })

  it('源码按原文放进阅读区，不按 Markdown 排版', async () => {
    const face = readers({
      readPage: vi.fn(async () => ({ text: 'const n = 1', lines: 1, eof: true })),
    })
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'src/a.ts' }] }),
        readers: face,
      }))
    })
    await act(async () => { await Promise.resolve() })
    const plain = container.querySelector('[data-markdown-plain="src/a.ts"]')
    expect(plain?.textContent).toBe('const n = 1')
    expect(plain?.tagName).toBe('PRE')
    await act(async () => { root.unmount() })
  })

  it('没有文本文件或没有会话编号时不渲染', () => {
    const face = readers()
    expect(renderToString(createElement(MarkdownTurnTail, {
      sessionId: 'sess',
      turn: deliverables({ produced: [{ path: 'a.png' }] }),
      readers: face,
    }))).toBe('')
    expect(renderToString(createElement(MarkdownTurnTail, {
      turn: deliverables({ produced: [{ path: 'a.md' }] }),
      readers: face,
    }))).toBe('')
  })

  it('读文件失败时给出重试，重试会再读一次', async () => {
    const readPage = vi.fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(page('again', 1, true))
    const face = readers({ readPage })
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'a.md' }] }),
        readers: face,
      }))
    })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('文档没有读出来')
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === '重试')
    await act(async () => { retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(readPage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('again')
    await act(async () => { root.unmount() })
  })
})

describe('registerMarkdownTurn', () => {
  it('往 conversation.chat.turnTail 注册，排在官方卡片之后', () => {
    const registrations: Array<{ options: Record<string, unknown> }> = []
    const host = {
      inject: vi.fn((_key: string, callback: () => void) => {
        callback()
        return () => {}
      }),
      register: vi.fn((options: Record<string, unknown>) => {
        registrations.push({ options })
        return () => {}
      }),
    }
    registerMarkdownTurn(host as never, readers())
    expect(host.inject).toHaveBeenCalledWith('conversation.chat.turnTail', expect.any(Function))
    expect(registrations[0]?.options).toMatchObject({
      name: 'conversation.chat.turnTail',
      id: MARKDOWN_TAIL_ID,
      order: MARKDOWN_TAIL_ORDER,
      locale: 'threadharborClient',
    })
    expect(MARKDOWN_TAIL_ORDER).toBeGreaterThan(0)
    expect(MARKDOWN_TAIL_ORDER).toBeLessThan(10)
  })
})

describe('createMarkdownTurnReaders', () => {
  it('每次读取都用当下的 workspaceFiles.read，摘要走文档相对地址', async () => {
    const read = vi.fn(async () => ({ ok: true, value: page('body', 1, true) }))
    const first = { workspaceFiles: { read } }
    const second = { workspaceFiles: { read: vi.fn(async () => ({ ok: true, value: page('next', 1, true) })) } }
    let current: unknown = first
    const face = createMarkdownTurnReaders(() => current)
    const signal = new AbortController().signal
    await expect(face.readPage('sess', 'a.md', 1, signal)).resolves.toEqual(page('body', 1, true))
    expect(read).toHaveBeenCalledWith('sess', 'a.md', { offset: 1 }, signal)
    current = second
    await face.readPage('sess', 'a.md', 1, signal)
    expect(second.workspaceFiles.read).toHaveBeenCalledTimes(1)

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ files: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await face.loadSummary('sess', 3, signal)
    expect(fetchMock).toHaveBeenCalledWith('api/changes.summary?sessionId=sess&seq=3', { signal })
    vi.unstubAllGlobals()
  })

  it('没有 read 方法时抛错，不把缺席说成空文档', async () => {
    const face = createMarkdownTurnReaders(() => ({}))
    await expect(face.readPage('sess', 'a.md', 1, new AbortController().signal)).rejects.toThrow(/workspaceFiles\.read/)
  })

  it('远程调用失败时抛出宿主的错误，不把信封当成正文', async () => {
    const read = vi.fn(async () => ({ ok: false, error: { message: 'workspace-file/not-found' } }))
    const face = createMarkdownTurnReaders(() => ({ workspaceFiles: { read } }))
    await expect(face.readPage('sess', 'a.md', 1, new AbortController().signal)).rejects.toThrow('workspace-file/not-found')
  })
})
