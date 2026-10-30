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
  linkedFilePathsFromText,
  linkedFilePathsFromTurn,
  markdownPathsFromSummary,
  markdownSources,
  mergeMarkdownPaths,
  readMarkdownText,
} = await import('../src/markdown-turn-sources.ts')
const {
  FOLDED_FILE_COUNT,
  MARKDOWN_TAIL_ID,
  MARKDOWN_TAIL_ORDER,
  MarkdownTurnTail,
  registerMarkdownTurn,
} = await import('../src/markdown-turn.tsx')
const { startMermaidDiagrams } = await import('../src/mermaid.ts')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

async function waitFor(check: () => boolean, what: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

function deliverables(value: unknown) {
  return { data: { get: (key: string) => key === 'deliverables' ? value : undefined } }
}

function page(text: string, lines: number, eof: boolean) {
  return { text, lines, eof }
}

function readers(overrides?: Partial<{
  readPage: ReturnType<typeof vi.fn>
  loadSummary: ReturnType<typeof vi.fn>
  revealFile: ReturnType<typeof vi.fn>
  canOpenFiles: ReturnType<typeof vi.fn>
  fileApplications: ReturnType<typeof vi.fn>
  openFile: ReturnType<typeof vi.fn>
  sendToSession: ReturnType<typeof vi.fn>
}>) {
  return {
    readPage: overrides?.readPage ?? vi.fn(async () => page('# Hello', 1, true)),
    loadSummary: overrides?.loadSummary ?? vi.fn(async () => ({ files: [] })),
    revealFile: overrides?.revealFile ?? vi.fn(async () => {}),
    canOpenFiles: overrides?.canOpenFiles ?? vi.fn(async () => true),
    fileApplications: overrides?.fileApplications ?? vi.fn(async () => []),
    openFile: overrides?.openFile ?? vi.fn(async () => {}),
    sendToSession: overrides?.sendToSession ?? vi.fn(async () => {}),
  }
}

/** 等打开方式按钮问完桌面和应用名单。 */
async function openReady(container: HTMLElement): Promise<Element> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const node = container.querySelector('[data-open-path-state="ready"]')
    if (node !== null) return node
    await act(async () => { await Promise.resolve() })
  }
  throw new Error('open control did not settle')
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


describe('linked file paths', () => {
  it('从助手正文的本地文件链接里取出文本路径', () => {
    const text = [
      '入口：[build.py](/Users/good/qg/glasses/os/manifest/scripts/build.py)。',
      '行号：[overlay()](/Users/good/qg/glasses/os/manifest/scripts/ar1_pipeline/stages.py:243)。',
      '片段：[说明](/repo/docs/guide.md#L38)。',
      '相对：[指针](../baselines/current.env) 和 [`清单`](audits/report.json)。',
      '盘符：[win](C:/repo/a.md:12)。',
      '网页：[文档](https://example.com/guide.md) 和 [协议](javascript:alert(1))。',
      '图片：![图](/repo/pic.png) 以及 [图](/repo/shot.jpg)。',
      '代码里的例子不算：`[隐藏](/repo/hidden.md)`',
      '```',
      '[围栏](/repo/fenced.md)',
      '```',
      '围栏之后：[笔记](/repo/after.md)。',
      '标题：[带标题](/repo/titled.md "打开")。',
    ].join('\n')
    expect(linkedFilePathsFromText(text)).toEqual([
      '/Users/good/qg/glasses/os/manifest/scripts/build.py',
      '/Users/good/qg/glasses/os/manifest/scripts/ar1_pipeline/stages.py',
      '/repo/docs/guide.md',
      '../baselines/current.env',
      'audits/report.json',
      'C:/repo/a.md',
      '/repo/after.md',
      '/repo/titled.md',
    ])
  })

  it('同一路径只留第一次，推理块不计入', () => {
    const turn = {
      steps: [
        { data: { get: (key: string) => key === 'assistant-step' ? {
          blocks: [
            { kind: 'reasoning', text: '[草稿](/repo/draft.md)' },
            { kind: 'text', text: '见 [甲](/repo/a.md) 和 [甲再次](/repo/a.md#L2)。' },
          ],
        } : undefined } },
        { data: { get: (key: string) => key === 'assistant-step' ? {
          blocks: [{ kind: 'text', text: '还有 [乙](notes/b.txt:4)。' }],
        } : undefined } },
      ],
    }
    expect(linkedFilePathsFromTurn(turn)).toEqual(['/repo/a.md', 'notes/b.txt'])
    expect(linkedFilePathsFromTurn({ data: { get: () => undefined } })).toEqual([])
  })
})

describe('MarkdownTurnTail', () => {
  it('产出的 Markdown 默认收起，点开后一屏高，再点收回', async () => {
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
    expect(container.querySelector('[data-file-icon="markdown"] svg')).not.toBeNull()
    expect(container.querySelector('[data-markdown-body]')).toBeNull()
    expect(container.textContent).not.toContain('正在读取文档')
    expect(face.readPage).not.toHaveBeenCalled()
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')

    const toggle = container.querySelector('button')
    await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('正在读取文档')
    const body = container.querySelector('[data-markdown-body="docs/a.md"]')
    expect(body).not.toBeNull()
    expect((body as HTMLElement).style.maxHeight).toBe('100dvh')
    expect((body as HTMLElement).style.overflow).toBe('auto')
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => { resolvePage(page('# Hello', 1, true)) })
    expect(container.textContent).toContain('Hello')
    expect(face.readPage).toHaveBeenCalledWith('sess', 'docs/a.md', 1, expect.any(AbortSignal))

    await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-markdown-body]')).toBeNull()
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { root.unmount() })
  })

  it('路径文字在按钮外面，点路径不展开', async () => {
    const face = readers()
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
        readers: face,
      }))
    })
    const pathText = container.querySelector('[data-path="docs/a.md"]')
    expect(pathText?.textContent).toBe('docs/a.md')
    expect(pathText?.closest('button')).toBeNull()
    expect(pathText?.closest('a')).toBeNull()
    const copied = new Map<string, string>()
    const copy = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(copy, 'clipboardData', {
      value: { setData: (type: string, value: string) => { copied.set(type, value) } },
    })
    pathText?.dispatchEvent(copy)
    expect(copied.get('text/plain')).toBe('docs/a.md')
    expect(copy.defaultPrevented).toBe(true)
    await act(async () => { pathText?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-markdown-body]')).toBeNull()
    expect(face.readPage).not.toHaveBeenCalled()
    const toggle = container.querySelector('button')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-markdown-body]')).not.toBeNull()
    const foot = container.querySelector('[data-path-foot]')
    expect(foot?.querySelector('svg')).not.toBeNull()
    expect(foot?.textContent?.trim()).toBe('')
    expect(foot?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { foot?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-markdown-body]')).toBeNull()
    expect(container.querySelector('[data-path-foot]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('展开后路径栏与正文分开，双击正文收回', async () => {
    const face = readers({ readPage: vi.fn(async () => page('# Hello', 1, true)) })
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
        readers: face,
      }))
    })
    expect(container.querySelector('[data-path-bar]')?.hasAttribute('data-expanded')).toBe(false)
    const toggle = container.querySelector('button[aria-expanded]')
    await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-path-bar]')?.hasAttribute('data-expanded')).toBe(true)
    const body = container.querySelector('[data-markdown-body="docs/a.md"]')
    expect(body).not.toBeNull()
    await act(async () => { body?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(container.querySelector('[data-markdown-body]')).toBeNull()
    expect(container.querySelector('[data-path-bar]')?.hasAttribute('data-expanded')).toBe(false)
    await act(async () => { root.unmount() })
  })

  it('展开和收起都把路径栏留在点击时的位置，自己滚动之后不再拉回', async () => {
    const callbacks: ResizeObserverCallback[] = []
    class FakeResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) { callbacks.push(callback) }
      observe(): void {}
      disconnect(): void {
        const index = callbacks.indexOf(this.callback)
        if (index >= 0) callbacks.splice(index, 1)
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const scroller = document.createElement('div')
    scroller.setAttribute('data-conversation-scroll', '')
    let scrollTop = 500
    let barTop = 240
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        if (value === scrollTop) return
        const previous = scrollTop
        scrollTop = value
        barTop += previous - value
        scroller.dispatchEvent(new Event('scroll'))
      },
    })
    document.body.appendChild(scroller)
    const container = document.createElement('div')
    scroller.appendChild(container)
    const root: Root = createRoot(container)
    const fire = (): void => {
      callbacks.at(-1)?.([], undefined as unknown as ResizeObserver)
    }
    const frames = async (count: number): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve() }) })
      }
    }
    try {
      await act(async () => {
        root.render(createElement(MarkdownTurnTail, {
          sessionId: 'sess',
          turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
          readers: readers({ readPage: vi.fn(async () => page('# Hello', 1, true)) }),
        }))
      })
      const bar = container.querySelector('[data-path-bar]') as HTMLElement
      bar.getBoundingClientRect = () => ({ top: barTop }) as DOMRect
      const toggle = container.querySelector('button[aria-expanded]')
      await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      scroller.scrollTop = 900
      expect(barTop).toBe(-160)
      await act(async () => { fire() })
      expect(scrollTop).toBe(500)
      expect(barTop).toBe(240)
      await act(async () => { await frames(2) })

      await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(container.querySelector('[data-markdown-body]')).toBeNull()
      scroller.scrollTop = 200
      await act(async () => { fire() })
      expect(scrollTop).toBe(500)
      expect(barTop).toBe(240)
      await act(async () => { await frames(2) })

      scroller.scrollTop = 800
      await act(async () => { await frames(2) })
      scroller.scrollTop = 1100
      await act(async () => { fire() })
      expect(scrollTop).toBe(1100)
    } finally {
      await act(async () => { root.unmount() })
      scroller.remove()
      vi.unstubAllGlobals()
    }
  })

  it('打开文件夹不展开正文，失败时另作提示', async () => {
    const openFile = vi.fn(async () => { throw new Error('no') })
    const face = readers({ openFile })
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
        readers: face,
      }))
    })
    await openReady(container)
    const open = container.querySelector('[data-open-path-open]')
    expect(open?.textContent?.trim()).toBe('')
    expect(open?.querySelector('svg')).not.toBeNull()
    expect(open?.getAttribute('aria-label')).toBe('打开文件夹')
    expect(container.querySelector('[data-open-path-more]')).toBeNull()
    await act(async () => { open?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(openFile).toHaveBeenCalledWith('sess', 'docs/a.md', { kind: 'reveal' })
    expect(container.querySelector('[data-markdown-body]')).toBeNull()
    expect(document.body.textContent).toContain('文件夹没有打开')
    await act(async () => { root.unmount() })
  })

  it('打开方式下拉的最后一项是打开文件夹', async () => {
    const openFile = vi.fn(async () => {})
    const face = readers({
      openFile,
      fileApplications: vi.fn(async () => [
        { id: 'notes', name: 'TextEdit', icon: null, default: false },
        { id: 'code', name: 'VS Code', icon: null, default: true },
      ]),
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
    const split = await openReady(container)
    expect(split.querySelector('[data-open-path-open]')?.getAttribute('aria-label')).toBe('用 VS Code 打开')
    await act(async () => {
      split.querySelector('[data-open-path-open]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(openFile).toHaveBeenCalledWith('sess', 'docs/a.md', { kind: 'default' })
    await act(async () => {
      split.querySelector('[data-open-path-more]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent?.trim())
    expect(labels).toEqual(['TextEdit', 'VS Code（默认）', '打开文件夹'])
    expect(labels).not.toContain('显示文件位置')
    const rows = [...document.querySelectorAll('[role="menuitem"]')]
    await act(async () => { rows[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(openFile).toHaveBeenCalledWith('sess', 'docs/a.md', { kind: 'application', id: 'notes' })
    await act(async () => {
      split.querySelector('[data-open-path-more]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const again = [...document.querySelectorAll('[role="menuitem"]')]
    await act(async () => { again[again.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(openFile).toHaveBeenCalledWith('sess', 'docs/a.md', { kind: 'reveal' })
    await act(async () => { root.unmount() })
  })

  it('问不到应用时仍能打开文件夹', async () => {
    const face = readers({ fileApplications: vi.fn(async () => null) })
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
        readers: face,
      }))
    })
    const split = await openReady(container)
    await act(async () => {
      split.querySelector('[data-open-path-more]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent?.trim())
    expect(labels).toEqual(['无法获取应用列表', '打开文件夹（默认）'])
    await act(async () => { root.unmount() })
  })

  it('主机不能打开本地文件时不放打开按钮', async () => {
    const face = readers({ canOpenFiles: vi.fn(async () => false) })
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
        readers: face,
      }))
    })
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-markdown-path]')).not.toBeNull()
    expect(container.querySelector('[data-open-path]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('超过四篇先只列出四篇，点全部才展开', async () => {
    const face = readers()
    const paths = Array.from({ length: FOLDED_FILE_COUNT + 1 }, (_, index) => `file-${index}.ts`)
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: paths.map(path => ({ path })) }),
        readers: face,
      }))
    })
    expect(container.querySelectorAll('[data-markdown-path]')).toHaveLength(FOLDED_FILE_COUNT)
    expect(container.querySelector(`[data-markdown-path="${paths.at(-1)}"]`)).toBeNull()
    expect(container.hasAttribute('data-markdown-folded') || container.querySelector('[data-markdown-folded]') !== null).toBe(true)
    const mores = (): Element[] => [...container.querySelectorAll('[data-markdown-more]')]
    expect(mores()).toHaveLength(1)
    expect(mores()[0]?.textContent).toContain(`全部 ${paths.length} 个文件`)
    expect(mores()[0]?.getAttribute('aria-label')).toBe(`展开全部 ${paths.length} 个文件`)
    expect(mores()[0]?.getAttribute('aria-expanded')).toBe('false')
    const order = [...(container.querySelector('[data-markdown-turn]')?.children ?? [])].map(node => (
      node.querySelector('[data-markdown-more]') !== null ? 'more' : 'file'
    ))
    expect(order[0]).toBe('file')
    expect(order.at(-1)).toBe('more')
    expect(face.readPage).not.toHaveBeenCalled()

    await act(async () => { mores()[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelectorAll('[data-markdown-path]')).toHaveLength(paths.length)
    expect(container.querySelector('[data-markdown-folded]')).toBeNull()
    expect(mores()[0]?.textContent).toContain('收起')
    expect(mores()[0]?.textContent).not.toContain('全部')
    expect(mores()[0]?.getAttribute('aria-label')).toBe('收起文件列表')
    expect(mores()[0]?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      mores()[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelectorAll('[data-markdown-path]')).toHaveLength(FOLDED_FILE_COUNT)
    expect(container.querySelector(`[data-markdown-path="${paths.at(-1)}"]`)).toBeNull()

    const four = document.createElement('div')
    const fourRoot: Root = createRoot(four)
    await act(async () => {
      fourRoot.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: paths.slice(0, FOLDED_FILE_COUNT).map(path => ({ path })) }),
        readers: readers(),
      }))
    })
    expect(four.querySelector('[data-markdown-more]')).toBeNull()
    expect(four.querySelectorAll('[data-markdown-path]')).toHaveLength(FOLDED_FILE_COUNT)
    await act(async () => { fourRoot.unmount(); root.unmount() })
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

  it('源码按原文放进共享代码块，不按 Markdown 排版', async () => {
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
    expect(container.querySelector('[data-file-icon="typescript"] svg')).not.toBeNull()
    expect(container.querySelector('[data-markdown-plain="src/a.ts"]')).toBeNull()
    const toggle = container.querySelector('button')
    await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    const block = container.querySelector('[data-markdown-body="src/a.ts"] .md-code-block')
    expect(block).not.toBeNull()
    expect(block?.querySelector('[data-code-block-content] pre')?.textContent).toBe('const n = 1')
    expect(block?.textContent).toContain('typescript')
    expect(container.querySelector('[data-markdown-plain="src/a.ts"]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('mmd 文件展开后由 Mermaid 增强画成图', async () => {
    const face = readers({
      readPage: vi.fn(async () => page('flowchart TD\n  A[开始] --> B[结束]', 2, true)),
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    const handle = startMermaidDiagrams({
      document,
      window,
      scanDelayMs: 1,
      settleMs: 1,
      t: key => key,
      loadApi: async () => ({
        initialize() {},
        async render() {
          return { svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' }
        },
      }),
    })
    try {
      await act(async () => {
        root.render(createElement(MarkdownTurnTail, {
          sessionId: 'sess',
          turn: deliverables({ produced: [{ path: 'docs/flow.mmd' }] }),
          readers: face,
        }))
      })
      const toggle = container.querySelector('button')
      await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await Promise.resolve() })
      expect(container.querySelector('.md-code-block')).not.toBeNull()
      await waitFor(() => container.querySelector('[data-th-mermaid]') !== null, 'mermaid preview')
      const block = container.querySelector('.md-code-block')
      expect(block?.getAttribute('data-th-mermaid-view')).toBe('diagram')
      expect(container.querySelector('[data-th-mermaid-canvas] svg')).not.toBeNull()
    } finally {
      handle.dispose()
      await act(async () => { root.unmount() })
      container.remove()
    }
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
    expect(container.textContent).not.toContain('文档没有读出来')
    const toggle = container.querySelector('button')
    await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('文档没有读出来')
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === '重试')
    await act(async () => { retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(readPage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('again')
    await act(async () => { root.unmount() })
  })

  it('输出里的文件链接在会话区列出，并带打开文件夹', async () => {
    const face = readers()
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    const turn = {
      data: { get: (key: string) => key === 'deliverables' ? { produced: [{ path: '/repo/a.md' }] } : undefined },
      steps: [{ data: { get: (key: string) => key === 'assistant-step' ? {
        blocks: [{ kind: 'text', text: '已有 [甲](/repo/a.md)，另见 [乙](/repo/b.py:15)。' }],
      } : undefined } }],
    }
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, { sessionId: 'sess', turn, readers: face }))
    })
    const rows = [...container.querySelectorAll('[data-markdown-path]')].map(node => node.getAttribute('data-markdown-path'))
    expect(rows).toEqual(['/repo/a.md', '/repo/b.py'])
    const row = container.querySelector('[data-markdown-path="/repo/b.py"]')
    if (!(row instanceof HTMLElement)) throw new Error('missing row')
    await openReady(row)
    const reveal = row.querySelector('[data-open-path-open]')
    expect(reveal?.textContent).toBe('')
    expect(reveal?.querySelector('svg')).not.toBeNull()
    await act(async () => { reveal?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(face.openFile).toHaveBeenCalledWith('sess', '/repo/b.py', { kind: 'reveal' })
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

  it('打开所在文件夹先取绝对路径，再请主机在文件管理器里显示', async () => {
    const stat = vi.fn(async () => ({ ok: true, value: { absolutePath: '/ws/docs/a.md', version: '1' } }))
    const openWorkspacePath = vi.fn(async () => ({ ok: true, value: { opened: true } }))
    const face = createMarkdownTurnReaders(() => ({ workspaceFiles: { stat }, session: { openWorkspacePath } }))
    await face.revealFile('sess', 'docs/a.md')
    expect(stat).toHaveBeenCalledWith('sess', 'docs/a.md')
    expect(openWorkspacePath).toHaveBeenCalledWith({ path: '/ws/docs/a.md', action: 'reveal' })
  })

  it('没有绝对路径时，打开文件夹失败', async () => {
    const stat = vi.fn(async () => ({ ok: true, value: { version: '1' } }))
    const face = createMarkdownTurnReaders(() => ({
      workspaceFiles: { stat },
      session: { openWorkspacePath: vi.fn() },
    }))
    await expect(face.revealFile('sess', 'a.md')).rejects.toThrow(/absolute path/)
  })

  it('默认应用不带动作，指定应用带上应用编号', async () => {
    const stat = vi.fn(async () => ({ ok: true, value: { absolutePath: '/ws/a.md' } }))
    const openWorkspacePath = vi.fn(async () => ({ ok: true, value: { opened: true } }))
    const face = createMarkdownTurnReaders(() => ({ workspaceFiles: { stat }, session: { openWorkspacePath } }))
    await face.openFile('sess', 'a.md', { kind: 'default' })
    expect(openWorkspacePath).toHaveBeenCalledWith({ path: '/ws/a.md' })
    await face.openFile('sess', 'a.md', { kind: 'application', id: 'code' })
    expect(openWorkspacePath).toHaveBeenLastCalledWith({ path: '/ws/a.md', application: 'code' })
  })

  it('列出文件关联；问失败和没有桌面分开', async () => {
    const stat = vi.fn(async () => ({ ok: true, value: { absolutePath: '/ws/a.md' } }))
    const signal = new AbortController().signal
    const workspacePathApplications = vi.fn(async () => ({ ok: true, value: [
      { id: 'code', name: 'VS Code', icon: 'data:image/svg+xml,abc', default: true },
      { name: 'skip' },
    ] }))
    const canOpenWorkspacePath = vi.fn(async () => ({ ok: true, value: true }))
    const face = createMarkdownTurnReaders(() => ({
      workspaceFiles: { stat },
      session: { workspacePathApplications, canOpenWorkspacePath, openWorkspacePath: vi.fn() },
    }))
    await expect(face.fileApplications('sess', 'a.md', signal)).resolves.toEqual([
      { id: 'code', name: 'VS Code', icon: 'data:image/svg+xml,abc', default: true },
    ])
    expect(workspacePathApplications).toHaveBeenCalledWith({ path: '/ws/a.md' }, signal)
    await expect(face.canOpenFiles()).resolves.toBe(true)
    const closed = createMarkdownTurnReaders(() => ({ session: { canOpenWorkspacePath: vi.fn(async () => ({ ok: true, value: false })) } }))
    await expect(closed.canOpenFiles()).resolves.toBe(false)
    const missing = createMarkdownTurnReaders(() => ({}))
    await expect(missing.fileApplications('sess', 'a.md', signal)).resolves.toBeNull()
    await expect(missing.canOpenFiles()).resolves.toBe(false)
  })
})

describe('createMarkdownTurnReaders sendToSession', () => {
  it('sendToSession 把文本作为一条消息发给会话', async () => {
    const prompt = vi.fn(async () => ({ ok: true }))
    const remote = () => ({ session: { prompt } })
    const face = createMarkdownTurnReaders(remote)
    await face.sendToSession('sess', 'hello world')
    expect(prompt).toHaveBeenCalledTimes(1)
    const payload = prompt.mock.calls[0][0]
    expect(payload.sessionId).toBe('sess')
    expect(payload.mode).toBe('queue')
    expect(payload.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(typeof payload.requestId).toBe('string')
  })

  it('sendToSession 在宿主没有 prompt 能力时抛错', async () => {
    const face = createMarkdownTurnReaders(() => ({}))
    await expect(face.sendToSession('sess', 'x')).rejects.toThrow(/prompt/)
  })
})

describe('MarkdownDocument 行内工具条', () => {
  it('正文块 hover 出现行内按钮，点复制写剪贴板，点发送以块原文调用 sendToSession', async () => {
    const send = vi.fn(async () => {})
    const face = readers({ readPage: vi.fn(async () => page('# 甲\n\n段落乙', 1, true)), sendToSession: send })
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(MarkdownTurnTail, {
        sessionId: 'sess',
        turn: deliverables({ produced: [{ path: 'docs/a.md' }] }),
        readers: face,
      }))
    })
    await act(async () => { await Promise.resolve() })
    const toggle = container.querySelector('button[aria-expanded]')
    await act(async () => { toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    const para = container.querySelector('[data-markdown-body] p')
    expect(para).not.toBeNull()
    await act(async () => { para?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const body = container.querySelector('[data-markdown-body]') as HTMLElement
    const copyBtn = body.querySelector('[data-line-action="copy"]') as HTMLElement | null
    expect(copyBtn).not.toBeNull()
    await act(async () => { copyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(copyBtn?.getAttribute('data-copy-text')).toBe('段落乙')

    const sendBtn = body.querySelector('[data-line-action="send"]') as HTMLElement | null
    await act(async () => { sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(send).toHaveBeenCalledWith('sess', '段落乙')
    await act(async () => { root.unmount() })
  })
})
