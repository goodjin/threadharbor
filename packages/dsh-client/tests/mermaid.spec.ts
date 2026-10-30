/**
 * 会话区 Markdown 里的 Mermaid 预览。
 *
 * 照上游 CodeBlock 的真实 DOM 造块：`.md-code-block` 根、横幅、`[data-code-block-content] pre`。
 * 渲染器一律是假件——jsdom 里不跑真 mermaid（3.5 MB，且要布局测量）。
 * 时间全靠真计时器，但把 `scanDelayMs` / `settleMs` 压到 1ms；只在「稳定后
 * 才渲染」这一条上把 settle 拉长，验证连续变化不会反复渲染。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveMermaidAssetUrl,
  sniffMermaidSource,
  startMermaidDiagrams,
} from '../src/mermaid.ts'
import type { MermaidApi, MermaidApiLoader, MermaidDiagrams } from '../src/mermaid.ts'
import { en, zh } from '../src/locales.ts'

const ACTIVE = 'data-th-mermaid-active'
const VIEW = 'data-th-mermaid-view'
const TOGGLE = 'data-th-mermaid-toggle'
const LABEL = 'data-th-mermaid-label'
const PREVIEW = 'data-th-mermaid'
const CANVAS = 'data-th-mermaid-canvas'

const handles: MermaidDiagrams[] = []
/** 当前语言；测试改这里再让 scan 发现变化。 */
const language = { current: 'zh' as 'zh' | 'en' }

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

async function waitFor(check: () => boolean, what: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

type BlockOptions = { lang?: string; compact?: boolean }

/** 上游 CodeBlock 的最小复刻：根、横幅（含复制按钮）、content 里的源码 pre。 */
function mountBlock(source: string, options: BlockOptions = {}): HTMLElement {
  const block = document.createElement('div')
  block.className = 'md-code-block'
  const banner = document.createElement('div')
  banner.setAttribute('data-code-block-banner', '')
  const info = document.createElement('div')
  info.textContent = options.lang ?? ''
  const action = document.createElement('div')
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = '复制'
  action.appendChild(copy)
  banner.append(info, action)
  const content = document.createElement('div')
  content.setAttribute('data-code-block-content', '')
  const pre = document.createElement('pre')
  pre.className = 'plain'
  const code = document.createElement('code')
  code.textContent = source
  pre.appendChild(code)
  content.appendChild(pre)
  block.append(banner, content)
  if (options.compact === true) {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-markdown-variant', 'compact')
    wrapper.appendChild(block)
    document.body.appendChild(wrapper)
  } else {
    document.body.appendChild(block)
  }
  return block
}

function setSource(block: HTMLElement, text: string): void {
  block.querySelector('pre')!.textContent = text
}

type FakeRuntime = {
  api: MermaidApi
  calls: Array<{ id: string; text: string }>
  inits: Array<Record<string, unknown>>
  state: { fail: number }
}

function fakeRuntime(): FakeRuntime {
  const calls: Array<{ id: string; text: string }> = []
  const inits: Array<Record<string, unknown>> = []
  const state = { fail: 0 }
  const api: MermaidApi = {
    initialize(config) {
      inits.push(config)
    },
    async render(id, text) {
      calls.push({ id, text })
      if (state.fail > 0) {
        state.fail -= 1
        throw new Error('layout failed')
      }
      return { svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' }
    },
  }
  return { api, calls, inits, state }
}

type StartOptions = { loadApi?: MermaidApiLoader; log?: (message: string) => void; settleMs?: number }

function start(options: StartOptions = {}): MermaidDiagrams {
  const handle = startMermaidDiagrams({
    document,
    window,
    scanDelayMs: 1,
    settleMs: options.settleMs ?? 1,
    t: key => (language.current === 'en' ? en : zh)[key],
    loadApi: options.loadApi ?? (async () => {
      throw new Error('test did not provide a runtime')
    }),
    ...(options.log === undefined ? {} : { log: options.log }),
  })
  handles.push(handle)
  return handle
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose()
  delete (window as unknown as { mermaid?: unknown }).mermaid
  document.querySelectorAll('head base').forEach(base => { base.remove() })
  document.body.innerHTML = ''
  document.body.removeAttribute('data-ds-dark-theme')
  document.documentElement.lang = ''
  language.current = 'zh'
})

describe('内容嗅探', () => {
  it('各图类型的关键字都认，fence 前后的 frontmatter、注释与指令不挡路', () => {
    const positives = [
      'graph TD',
      'graph LR',
      'flowchart TD',
      'sequenceDiagram\n  A->>B: hi',
      'classDiagram',
      'classDiagram-v2',
      'stateDiagram',
      'stateDiagram-v2',
      'erDiagram',
      'journey',
      'gantt',
      'pie title Pets',
      'quadrantChart',
      'requirementDiagram',
      'gitGraph',
      'mindmap',
      'timeline',
      'C4Context',
      'sankey-beta',
      'xychart-beta',
      'block-beta',
      'architecture-beta',
      'packet-beta',
      'kanban',
      'radar-beta',
      'treemap-beta',
      'zenuml',
    ]
    for (const sample of positives) expect(sniffMermaidSource(sample), sample).toBe(sample)

    const decorated = [
      '---\ntitle: 流程\n---\n\ngraph TD\n  A-->B',
      '%% 这是注释\n%%{init: {"theme": "dark"}}%%\nsequenceDiagram\n  A->>B: hi',
      '\uFEFFflowchart LR\n  A-->B',
    ]
    for (const sample of decorated) expect(sniffMermaidSource(sample), sample).toBe(sample.replace(/^\uFEFF/, ''))
  })

  it('普通代码（包括以 graph 开头的 TS 片段）不误判', () => {
    const negatives = [
      '',
      'const n = 1',
      'graph = buildGraph()',
      'graph.addNode(1)',
      'graph TDX',
      'sequenceDiagramX',
      'piechart',
      'C4',
      '```ts\nconst n = 1\n```',
      '---\ntitle: 只有 frontmatter\n---\n\n',
      '%%{init: broken\nsequenceDiagram',
    ]
    for (const sample of negatives) expect(sniffMermaidSource(sample), sample).toBeUndefined()
  })
})

describe('资产地址', () => {
  it('没有 base 时取本机根路径', () => {
    expect(resolveMermaidAssetUrl(document, window))
      .toBe(new URL('/threadharbor/mermaid.js', window.location.origin).href)
  })

  it('网关 base 下按子路径取，尾斜杠缺了也补上', () => {
    const origin = window.location.origin
    for (const href of ['/threadharbor/gateway/host-1', '/threadharbor/gateway/host-1/']) {
      const base = document.createElement('base')
      base.setAttribute('href', href)
      document.head.appendChild(base)
      expect(resolveMermaidAssetUrl(document, window))
        .toBe(new URL('/threadharbor/gateway/host-1/threadharbor/mermaid.js', origin).href)
      base.remove()
    }
  })

  it('绝对 base 保留主机与协议', () => {
    const base = document.createElement('base')
    base.setAttribute('href', 'https://gw.example/threadharbor/gateway/9/')
    document.head.appendChild(base)
    expect(resolveMermaidAssetUrl(document, window))
      .toBe('https://gw.example/threadharbor/gateway/9/threadharbor/mermaid.js')
  })
})

describe('会话区 Mermaid 预览', () => {
  it('mermaid fence 画出预览并给出图表/源码开关，其他语言块不动', async () => {
    const source = 'graph TD\n  A[开始] --> B[结束]'
    const block = mountBlock(source, { lang: 'mermaid' })
    const other = mountBlock('const n = 1', { lang: 'ts' })
    const runtime = fakeRuntime()
    start({ loadApi: async () => runtime.api })

    await waitFor(() => block.hasAttribute(ACTIVE), 'diagram')
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]?.text).toBe(source)
    expect(runtime.calls[0]?.id).toMatch(/^th-mermaid-\d+$/)
    expect(runtime.inits).toHaveLength(1)
    expect(runtime.inits[0]).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'default',
    })
    expect(block.getAttribute(VIEW)).toBe('diagram')
    const preview = block.querySelector(`[${PREVIEW}]`)
    expect(preview).not.toBeNull()
    // 预览追加在 content 之后，横幅与源码 pre 原样保留（复制仍读源码）。
    expect(block.lastElementChild).toBe(preview)
    expect(preview?.querySelector(`[${LABEL}]`)?.textContent).toBe('Mermaid')
    const toggle = preview?.querySelector<HTMLButtonElement>(`[${TOGGLE}]`)!
    expect(toggle.textContent).toBe('源码')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('切换 Mermaid 图与源码')
    expect(preview?.querySelector(`[${CANVAS}] svg`)).not.toBeNull()
    expect(block.querySelectorAll('pre')).toHaveLength(1)
    expect(block.querySelector('pre')?.textContent).toBe(source)
    expect(other.querySelector(`[${PREVIEW}]`)).toBeNull()
    // 图表视图藏的是 content，源码 pre 留在原地给复制按钮读。
    expect(document.getElementById('th-mermaid-style')?.textContent)
      .toContain('.md-code-block[data-th-mermaid-view="diagram"] > [data-code-block-content]')
  })

  it('compact 变体的代码块不处理', async () => {
    const source = 'graph TD\n  A-->B'
    const compact = mountBlock(source, { compact: true })
    const normal = mountBlock(source)
    const runtime = fakeRuntime()
    start({ loadApi: async () => runtime.api })

    await waitFor(() => normal.hasAttribute(ACTIVE), 'diagram')
    await sleep(30)
    expect(compact.querySelector(`[${PREVIEW}]`)).toBeNull()
    expect(compact.hasAttribute(ACTIVE)).toBe(false)
    expect(runtime.calls).toHaveLength(1)
  })

  it('源码连续变化只在稳定后渲染一次，且用最终文本', async () => {
    const block = mountBlock('graph TD\n  A-->B')
    const runtime = fakeRuntime()
    start({ settleMs: 20, loadApi: async () => runtime.api })

    await sleep(3)
    setSource(block, 'graph TD\n  A-->C')
    await sleep(5)
    setSource(block, 'graph TD\n  A-->D')
    await waitFor(() => runtime.calls.length > 0, 'settled render')
    await sleep(40)
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]?.text).toBe('graph TD\n  A-->D')
  })

  it('渲染失败保持代码外观：同一段源码不重试，换文本才重试', async () => {
    const source = 'graph TD\n  A-->B'
    const block = mountBlock(source)
    const runtime = fakeRuntime()
    runtime.state.fail = 1
    const logs: string[] = []
    start({ loadApi: async () => runtime.api, log: message => logs.push(message) })

    await waitFor(() => runtime.calls.length === 1, 'first attempt')
    await sleep(30)
    expect(block.querySelector(`[${PREVIEW}]`)).toBeNull()
    expect(block.hasAttribute(ACTIVE)).toBe(false)
    expect(block.querySelector('pre')?.textContent).toBe(source)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('did not render')

    // 同一段文本：再扫（外部变更触发）也不重试。
    document.body.appendChild(document.createElement('span'))
    await sleep(30)
    expect(runtime.calls).toHaveLength(1)

    setSource(block, 'graph TD\n  A-->C')
    await waitFor(() => runtime.calls.length === 2, 'retry with new source')
    await waitFor(() => block.hasAttribute(ACTIVE), 'diagram after retry')
    expect(runtime.calls[1]?.text).toBe('graph TD\n  A-->C')
  })

  it('图表/源码开关：属性、文案与 aria 状态跟着翻，复制仍读源码', async () => {
    const source = 'sequenceDiagram\n  A->>B: hi'
    const block = mountBlock(source)
    const runtime = fakeRuntime()
    start({ loadApi: async () => runtime.api })

    await waitFor(() => block.hasAttribute(ACTIVE), 'diagram')
    const toggle = block.querySelector<HTMLButtonElement>(`[${TOGGLE}]`)!
    expect(block.querySelectorAll('pre')).toHaveLength(1)

    toggle.click()
    expect(block.getAttribute(VIEW)).toBe('source')
    expect(toggle.textContent).toBe('图表')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(block.querySelector('pre')?.textContent).toBe(source)

    toggle.click()
    expect(block.getAttribute(VIEW)).toBe('diagram')
    expect(toggle.textContent).toBe('源码')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(runtime.calls).toHaveLength(1)
  })

  it('深色主题切换重新初始化，并按新主题重绘所有已渲染块', async () => {
    const block = mountBlock('pie title Pets\n  "Dogs": 3')
    const runtime = fakeRuntime()
    start({ loadApi: async () => runtime.api })

    await waitFor(() => block.hasAttribute(ACTIVE), 'diagram')
    expect(runtime.inits.map(init => init['theme'])).toEqual(['default'])

    document.body.setAttribute('data-ds-dark-theme', '')
    handles[0]!.scan()
    await waitFor(() => runtime.calls.length === 2, 'dark re-render')
    expect(runtime.inits.map(init => init['theme'])).toEqual(['default', 'dark'])
    expect(block.hasAttribute(ACTIVE)).toBe(true)
    expect(block.querySelector(`[${CANVAS}] svg`)).not.toBeNull()
  })

  it('语言切换只换标签与按钮文案，不重绘', async () => {
    const block = mountBlock('graph TD\n  A-->B')
    const runtime = fakeRuntime()
    start({ loadApi: async () => runtime.api })

    await waitFor(() => block.hasAttribute(ACTIVE), 'diagram')
    const toggle = block.querySelector<HTMLButtonElement>(`[${TOGGLE}]`)!
    expect(toggle.textContent).toBe('源码')

    language.current = 'en'
    document.documentElement.lang = 'en'
    handles[0]!.scan()
    expect(block.querySelector(`[${LABEL}]`)?.textContent).toBe('Mermaid')
    expect(toggle.textContent).toBe('Source')
    expect(toggle.getAttribute('aria-label')).toBe('Switch between the Mermaid diagram and its source')
    await sleep(20)
    expect(runtime.calls).toHaveLength(1)
  })

  it('根节点被重建时从缓存恢复预览，不额外渲染', async () => {
    const source = 'graph TD\n  A-->B'
    const block = mountBlock(source)
    const runtime = fakeRuntime()
    start({ loadApi: async () => runtime.api })

    await waitFor(() => block.hasAttribute(ACTIVE), 'diagram')
    const firstPreview = block.querySelector(`[${PREVIEW}]`)
    block.remove()
    const replacement = mountBlock(source)

    await waitFor(() => replacement.hasAttribute(ACTIVE), 'restored preview')
    expect(runtime.calls).toHaveLength(1)
    expect(replacement.querySelector(`[${PREVIEW}] svg`)).not.toBeNull()
    expect(firstPreview?.isConnected).toBe(false)
  })

  it('运行时加载失败只报一次，块保持代码，不反复加载', async () => {
    const block = mountBlock('graph TD\n  A-->B')
    const logs: string[] = []
    let loads = 0
    start({
      log: message => logs.push(message),
      loadApi: async () => {
        loads += 1
        throw new Error('asset missing')
      },
    })

    await waitFor(() => logs.length === 1, 'load failure log')
    await sleep(30)
    expect(loads).toBe(1)
    expect(logs[0]).toContain('runtime unavailable')
    expect(block.querySelector(`[${PREVIEW}]`)).toBeNull()
    expect(block.hasAttribute(ACTIVE)).toBe(false)

    mountBlock('sequenceDiagram\n  A->>B: x')
    await sleep(30)
    expect(loads).toBe(1)
    expect(logs).toHaveLength(1)
  })

  it('连续两次 scan 不产生额外写入或渲染', async () => {
    const block = mountBlock('graph TD\n  A-->B')
    const runtime = fakeRuntime()
    const handle = start({ loadApi: async () => runtime.api })

    await waitFor(() => block.hasAttribute(ACTIVE), 'diagram')
    const preview = block.querySelector(`[${PREVIEW}]`)
    handle.scan()
    handle.scan()
    await sleep(20)
    expect(runtime.calls).toHaveLength(1)
    expect(block.querySelectorAll(`[${PREVIEW}]`)).toHaveLength(1)
    expect(block.querySelector(`[${PREVIEW}]`)).toBe(preview)
  })

  it('页面已有 window.mermaid 时直接使用，不注入脚本', async () => {
    const runtime = fakeRuntime()
    ;(window as unknown as { mermaid?: unknown }).mermaid = runtime.api
    const block = mountBlock('graph TD\n  A-->B')
    const handle = startMermaidDiagrams({
      document,
      window,
      scanDelayMs: 1,
      settleMs: 1,
      t: key => (language.current === 'en' ? en : zh)[key],
    })
    handles.push(handle)

    await waitFor(() => block.hasAttribute(ACTIVE), 'diagram')
    expect(runtime.calls).toHaveLength(1)
    expect(document.querySelector('script[src*="threadharbor/mermaid.js"]')).toBeNull()
  })

  it('块在渲染前被移除就不再动作', async () => {
    const block = mountBlock('graph TD\n  A-->B')
    const runtime = fakeRuntime()
    start({ settleMs: 30, loadApi: async () => runtime.api })

    block.remove()
    await sleep(80)
    expect(runtime.calls).toHaveLength(0)
  })

  it('dispose 清掉预览、属性与样式，之后不再动作', async () => {
    const source = 'graph TD\n  A-->B'
    const block = mountBlock(source)
    const runtime = fakeRuntime()
    const handle = start({ loadApi: async () => runtime.api })

    await waitFor(() => block.hasAttribute(ACTIVE), 'diagram')
    handle.dispose()
    expect(block.querySelector(`[${PREVIEW}]`)).toBeNull()
    expect(block.hasAttribute(ACTIVE)).toBe(false)
    expect(block.hasAttribute(VIEW)).toBe(false)
    expect(document.getElementById('th-mermaid-style')).toBeNull()
    expect(block.querySelector('pre')?.textContent).toBe(source)

    handle.scan()
    setSource(block, 'graph TD\n  A-->C')
    await sleep(30)
    expect(runtime.calls).toHaveLength(1)
    expect(block.querySelector(`[${PREVIEW}]`)).toBeNull()
  })
})
