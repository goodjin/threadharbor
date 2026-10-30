/**
 * 会话区 Markdown 里的 Mermaid 图。
 *
 * DSH 的 MarkdownText → CodeBlock 没有可插拔的代码渲染入口，`mermaid` 这类
 * 不可高亮的 fence 连语言都被抹掉（横幅只写「代码」）。所以这一层在 DOM 上
 * 增强：观察 `.md-code-block`，按内容认出 Mermaid 源码，渲染成 SVG 预览，并
 * 给一个「图表 / 源码」开关。助手回复与 turnTail 的 `.md` 阅读卡片用的是同一个
 * 代码块组件，一个观察器同时覆盖。
 *
 * Mermaid 运行时（3.5 MB）不进客户端包：第一次遇到真正的 Mermaid 块时才注入
 * `<script>`，从宿主侧的 {@link MERMAID_ROUTE_PATH} 同源加载（同一登录准入、
 * 离线可用、不走 CDN）。注入地址按 `<base href>` 解析——同源主机网关会在被框
 * 页面里注入 `/threadharbor/gateway/<主机标识>/`，根绝对路径会绕过它。
 *
 * 原则：React 拥有的文字一个都不改。预览追加在代码块最后；横幅、源码 `<pre>`
 * 与复制按钮保持原样（复制仍拿得到源码）。渲染失败就移除预览、保持纯代码，
 * 同一段源码不反复重试。
 */

import { fallbackT } from './locales.ts'
import type { RuntimeT } from './locales.ts'

/** 宿主侧 mermaid-asset 路由登记的同一路径。 */
export const MERMAID_ROUTE_PATH = '/threadharbor/mermaid.js'

/** Mermaid 运行时里本模块用到的那一面（UMD 的 `window.mermaid`）。 */
export type MermaidApi = {
  initialize(config: Record<string, unknown>): void
  render(id: string, text: string, container?: Element): Promise<{ svg: string; bindFunctions?(element: Element): void }>
}

/** 取运行时；测试注入假件，生产注入 `<script>`。 */
export type MermaidApiLoader = (document: Document, window: Window) => Promise<MermaidApi>

/** 这个模块要的页面面：缺省用真实 document/window，测试塞假件。 */
export type MermaidDiagramsDeps = {
  document?: Document
  window?: Window
  /** 加载失败、渲染失败时说一句；同一原因只报一次。 */
  log?(message: string): void
  /** 预览头与切换按钮的文案；缺席时读词典源语言。 */
  t?: RuntimeT
  loadApi?: MermaidApiLoader
  /** 观察者到扫描的合流窗口（毫秒）；缺省 150。 */
  scanDelayMs?: number
  /** 源码停止变化多久后才尝试渲染（毫秒）；缺省 350。 */
  settleMs?: number
}

export type MermaidDiagrams = {
  /** 立刻扫一遍（测试与诊断用；平时由观察者驱动）。 */
  scan(): void
  dispose(): void
}

const STYLE_ID = 'th-mermaid-style'
const BLOCK_SELECTOR = '.md-code-block'
const SOURCE_SELECTOR = '[data-code-block-content] pre'
const COMPACT_SELECTOR = '[data-markdown-variant="compact"]'
const PREVIEW_ATTR = 'data-th-mermaid'
const CANVAS_ATTR = 'data-th-mermaid-canvas'
const TOGGLE_ATTR = 'data-th-mermaid-toggle'
const ACTIVE_ATTR = 'data-th-mermaid-active'
const VIEW_ATTR = 'data-th-mermaid-view'

const DEFAULT_SCAN_DELAY_MS = 150
const DEFAULT_SETTLE_MS = 350
/** 渲染结果缓存条数；阅读卡片收起再展开、行重建都靠它免于重复渲染。 */
const CACHE_LIMIT = 64

const STYLE_CSS = `
[${PREVIEW_ATTR}] {
  border-top: 1px solid rgba(128, 128, 128, 0.28);
  padding: 6px 10px 8px;
}
[${PREVIEW_ATTR}] [data-th-mermaid-head] {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 1.4;
  opacity: 0.85;
}
[${PREVIEW_ATTR}] [data-th-mermaid-label] {
  font-weight: 600;
  letter-spacing: 0.02em;
}
[${PREVIEW_ATTR}] [${TOGGLE_ATTR}] {
  margin-left: auto;
  padding: 1px 8px;
  border: 1px solid currentColor;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  opacity: 0.8;
}
[${PREVIEW_ATTR}] [${TOGGLE_ATTR}]:hover {
  opacity: 1;
}
[${PREVIEW_ATTR}] [${CANVAS_ATTR}] {
  display: none;
  overflow: auto;
  padding: 8px 0 4px;
}
${BLOCK_SELECTOR}[${VIEW_ATTR}="diagram"] > [${PREVIEW_ATTR}] > [${CANVAS_ATTR}] {
  display: block;
}
${BLOCK_SELECTOR}[${VIEW_ATTR}="diagram"] > [data-code-block-content] {
  display: none;
}
[${PREVIEW_ATTR}] [${CANVAS_ATTR}] svg {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}
`

/**
 * Mermaid 各图类型的关键字；首行命中才算候选块。
 *
 * `graph` / `flowchart` 还必须带方向词（TB/TD/BT/RL/LR）——`graph.addNode(1)`、
 * `graph = buildGraph()` 这类 TS 片段不是图。
 */
const FLOW_HEAD = /^(?:graph|flowchart)\s+(?:TB|TD|BT|RL|LR)\b/i

const DIAGRAM_HEAD = new RegExp(
  '^(?:'
  + 'sequenceDiagram\\b'
  + '|classDiagram(?:-v2)?\\b'
  + '|stateDiagram(?:-v2)?\\b'
  + '|erDiagram\\b'
  + '|journey\\b'
  + '|gantt\\b'
  + '|pie(?:\\s|$)'
  + '|quadrantChart\\b'
  + '|requirementDiagram\\b'
  + '|gitGraph\\b'
  + '|mindmap\\b'
  + '|timeline\\b'
  + '|C4(?:Context|Container|Component|Dynamic|Deployment)\\b'
  + '|sankey-beta\\b'
  + '|xychart-beta\\b'
  + '|block-beta\\b'
  + '|architecture-beta\\b'
  + '|packet-beta\\b'
  + '|kanban\\b'
  + '|radar(?:-beta)?\\b'
  + '|treemap(?:-beta)?\\b'
  + '|zenuml\\b'
  + ')',
)

/**
 * 这段代码是不是 Mermaid 源码；是就返回给渲染用的文本，不是返回 undefined。
 *
 * 先剥掉 YAML frontmatter（`---…---`）、前导 `%%` 注释与 `%%{…}%%` 指令，
 * 再看第一个非空行。只有候选块才付渲染成本。
 * @param text - 代码块里 `<pre>` 的文本。
 * @returns 去掉 BOM 的原文，或 undefined。
 */
export function sniffMermaidSource(text: string): string | undefined {
  const source = text.replace(/^\uFEFF/, '')
  let body = source
  if (body.startsWith('---')) {
    const close = body.indexOf('\n---', 3)
    if (close !== -1) body = body.slice(close + 4)
  }
  for (;;) {
    const trimmed = body.replace(/^\s+/, '')
    if (trimmed.startsWith('%%{')) {
      const close = trimmed.indexOf('}%%')
      if (close === -1) return undefined
      body = trimmed.slice(close + 3)
      continue
    }
    if (trimmed.startsWith('%%')) {
      const newline = trimmed.indexOf('\n')
      if (newline === -1) return undefined
      body = trimmed.slice(newline + 1)
      continue
    }
    body = trimmed
    break
  }
  const first = body.split('\n', 1)[0]?.trim() ?? ''
  return first !== '' && (FLOW_HEAD.test(first) || DIAGRAM_HEAD.test(first)) ? source : undefined
}

/**
 * 浏览器该从哪个地址取 Mermaid 运行时。
 *
 * 页面里有显式 `<base href>`（同源主机网关注入的 `/threadharbor/gateway/<id>/`）
 * 时按它解析成子路径，请求因此仍走网关；没有就回到本机根路径。`base` 不带尾
 * 斜杠时按目录补齐，否则最后一段会被当成文件名吃掉。
 * @param document - 页面。
 * @param window - 用来取 location。
 * @returns 绝对地址。
 */
export function resolveMermaidAssetUrl(document: Document, window: Window): string {
  const baseHref = document.querySelector('base[href]')?.getAttribute('href') ?? ''
  if (baseHref !== '') {
    try {
      const base = new URL(baseHref, window.location.href)
      if (!base.pathname.endsWith('/')) base.pathname += '/'
      return new URL(MERMAID_ROUTE_PATH.replace(/^\//, ''), base).href
    } catch {
      // 坏 base 不该连累资产；落到本机根路径。
    }
  }
  return new URL(MERMAID_ROUTE_PATH, window.location.origin).href
}

/** 运行时的默认取法：已有 `window.mermaid` 直接用，否则注入 `<script>`。 */
const loadMermaidFromHost: MermaidApiLoader = (document, window) => {
  const existing = (window as unknown as { mermaid?: unknown }).mermaid
  if (isMermaidApi(existing)) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = resolveMermaidAssetUrl(document, window)
    script.async = true
    script.addEventListener('load', () => {
      const api = (window as unknown as { mermaid?: unknown }).mermaid
      if (isMermaidApi(api)) resolve(api)
      else reject(new Error(`${script.src} loaded but did not expose the mermaid API`))
    })
    script.addEventListener('error', () => {
      reject(new Error(`${script.src} could not be loaded`))
    })
    document.head.appendChild(script)
  })
}

function isMermaidApi(value: unknown): value is MermaidApi {
  if (typeof value !== 'object' || value === null) return false
  const api = value as Record<string, unknown>
  return typeof api['initialize'] === 'function' && typeof api['render'] === 'function'
}

/** 一个代码块的增强状态；字段都可写，React 重挂时按新元素重新来。 */
type BlockState = {
  source: string
  view: 'diagram' | 'source'
  attempted: string | undefined
  /** 最近一次成功挂上的 SVG；失败后为 undefined（同一段源码不再重试）。 */
  svg: string | undefined
  timer: number | undefined
  generation: number
  preview: HTMLElement | undefined
}

/** 模块级闩：同一页面只该有一份观察器（重复 start 返回空壳）。 */
let active = false

/** 渲染 id 序号；mermaid 要求每次 render 的 id 唯一。 */
let renderSeq = 0

/**
 * 装上 Mermaid 预览。
 * @param deps - 页面面与注入点；SSR/没有 document 时返回空壳。
 * @returns scan 与 dispose。
 */
export function startMermaidDiagrams(deps: MermaidDiagramsDeps = {}): MermaidDiagrams {
  const doc = deps.document ?? (typeof document === 'undefined' ? undefined : document)
  const win = deps.window ?? doc?.defaultView ?? (typeof window === 'undefined' ? undefined : window)
  if (doc === undefined || win === undefined || active) {
    return { scan: () => {}, dispose: () => {} }
  }
  active = true
  const log = deps.log ?? (() => {})
  const say = deps.t ?? fallbackT
  const scanDelayMs = deps.scanDelayMs ?? DEFAULT_SCAN_DELAY_MS
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS
  const states = new Map<HTMLElement, BlockState>()
  const cache = new Map<string, string>()
  const reported = new Set<string>()
  let disposed = false
  let scanTimer: number | undefined
  let lastTheme: string | undefined
  let lastLang: string | undefined
  let initializedTheme: string | undefined
  let apiPromise: Promise<MermaidApi> | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const report = (message: string): void => {
    if (reported.has(message)) return
    reported.add(message)
    log(message)
  }

  if (doc.getElementById(STYLE_ID) === null) {
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE_CSS
    doc.head.appendChild(style)
  }

  const themeOf = (): string => doc.body?.hasAttribute('data-ds-dark-theme') === true ? 'dark' : 'default'

  const api = (): Promise<MermaidApi> => {
    apiPromise ??= (deps.loadApi ?? loadMermaidFromHost)(doc, win)
    return apiPromise
  }

  const cacheKey = (theme: string, source: string): string => `${theme}\u0000${source}`

  const remember = (key: string, svg: string): void => {
    if (cache.has(key)) cache.delete(key)
    cache.set(key, svg)
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  const initializeFor = (runtime: MermaidApi, theme: string): void => {
    if (initializedTheme === theme) return
    initializedTheme = theme
    const body = doc.body
    const fontFamily = body === null ? '' : win.getComputedStyle(body).fontFamily
    runtime.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme,
      logLevel: 'fatal',
      ...(fontFamily === '' ? {} : { fontFamily }),
    })
  }

  /** 串行执行：mermaid 的 render 共享全局配置，并发调用会互相打乱。 */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => {})
    return run
  }

  const setView = (block: HTMLElement, state: BlockState, view: 'diagram' | 'source'): void => {
    state.view = view
    block.setAttribute(VIEW_ATTR, view)
    const button = state.preview?.querySelector(`[${TOGGLE_ATTR}]`)
    if (button === null || button === undefined) return
    button.textContent = say(view === 'diagram' ? 'mermaid.source' : 'mermaid.diagram')
    button.setAttribute('aria-pressed', view === 'diagram' ? 'true' : 'false')
    button.setAttribute('aria-label', say('mermaid.toggleNamed'))
  }

  /** 取（或补上）预览节点；head 里不放 `<pre>`，上游复制按钮读的是源码那份。 */
  const ensurePreview = (block: HTMLElement, state: BlockState): { canvas: Element; button: Element } => {
    if (state.preview !== undefined) {
      if (!state.preview.isConnected) {
        state.preview = undefined
      } else {
        const canvas = state.preview.querySelector(`[${CANVAS_ATTR}]`)
        const button = state.preview.querySelector(`[${TOGGLE_ATTR}]`)
        if (canvas !== null && button !== null) return { canvas, button }
        state.preview.remove()
        state.preview = undefined
      }
    }
    const preview = doc.createElement('div')
    preview.setAttribute(PREVIEW_ATTR, '')
    // 阅读卡片双击正文会收起；预览上的双击到此为止。
    preview.addEventListener('dblclick', event => { event.stopPropagation() })
    const head = doc.createElement('div')
    head.setAttribute('data-th-mermaid-head', '')
    const label = doc.createElement('span')
    label.setAttribute('data-th-mermaid-label', '')
    label.textContent = say('mermaid.label')
    const button = doc.createElement('button')
    button.type = 'button'
    button.setAttribute(TOGGLE_ATTR, '')
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      setView(block, state, state.view === 'diagram' ? 'source' : 'diagram')
    })
    head.append(label, button)
    const canvas = doc.createElement('div')
    canvas.setAttribute(CANVAS_ATTR, '')
    preview.append(head, canvas)
    block.appendChild(preview)
    state.preview = preview
    return { canvas, button }
  }

  const applySvg = (block: HTMLElement, state: BlockState, view: 'diagram' | 'source', svg: string): void => {
    const { canvas } = ensurePreview(block, state)
    // mermaid 在 securityLevel 'strict' 下产出的是它自己净化过的 SVG，官方
    // 用法就是把它挂进页面；这里不再过一道会拆坏图形的过滤器。
    canvas.innerHTML = svg
    state.svg = svg
    block.setAttribute(ACTIVE_ATTR, '')
    setView(block, state, view)
  }

  /** 撤掉预览、保持纯代码外观；不改 attempted（失败的那段源码不重试）。 */
  const clearPreview = (block: HTMLElement, state: BlockState): void => {
    state.svg = undefined
    state.view = 'source'
    state.preview?.remove()
    state.preview = undefined
    block.removeAttribute(ACTIVE_ATTR)
    block.removeAttribute(VIEW_ATTR)
  }

  const dropPreview = (block: HTMLElement, state: BlockState): void => {
    state.generation += 1
    state.attempted = undefined
    clearPreview(block, state)
  }

  const renderBlock = async (block: HTMLElement, state: BlockState): Promise<void> => {
    const source = state.source
    if (disposed || !block.isConnected) return
    if (sniffMermaidSource(source) === undefined) return
    if (state.attempted === source) return
    const theme = themeOf()
    const generation = ++state.generation
    state.attempted = source
    const key = cacheKey(theme, source)
    const cached = cache.get(key)
    if (cached !== undefined) {
      applySvg(block, state, state.view, cached)
      return
    }
    let runtime: MermaidApi
    try {
      runtime = await api()
    } catch (error) {
      report(`mermaid: runtime unavailable (${messageOf(error)}); diagrams stay as code`)
      return
    }
    if (disposed || !block.isConnected || state.generation !== generation || state.source !== source) return
    try {
      initializeFor(runtime, theme)
      const id = `th-mermaid-${String(++renderSeq)}`
      // 只传两参：mermaid 11 传容器（尤其游离节点）会在内部 getAttribute
      // 上抛错，SVG 由返回值得出、我们自己挂进画布（真机抓到的形状）。
      const result = await enqueue(() => runtime.render(id, source))
      if (disposed || !block.isConnected || state.generation !== generation || state.source !== source) return
      remember(key, result.svg)
      applySvg(block, state, state.view, result.svg)
      observer.takeRecords()
    } catch (error) {
      clearPreview(block, state)
      report(`mermaid: a diagram did not render (${messageOf(error)}); it stays as code`)
    }
  }

  const scheduleRender = (state: BlockState, block: HTMLElement): void => {
    if (state.timer !== undefined) return
    state.timer = win.setTimeout(() => {
      state.timer = undefined
      void renderBlock(block, state)
    }, settleMs)
  }

  const clearTimer = (state: BlockState): void => {
    if (state.timer === undefined) return
    win.clearTimeout(state.timer)
    state.timer = undefined
  }

  const stateOf = (block: HTMLElement): BlockState => {
    let state = states.get(block)
    if (state === undefined) {
      state = { source: '', view: 'diagram', attempted: undefined, svg: undefined, timer: undefined, generation: 0, preview: undefined }
      states.set(block, state)
    }
    return state
  }

  /** 预览头与按钮跟随当前语言重新措辞；已画好的图不重绘。 */
  const relabel = (): void => {
    for (const [block, state] of states) {
      const preview = state.preview
      if (preview === undefined || !preview.isConnected) continue
      const label = preview.querySelector('[data-th-mermaid-label]')
      if (label !== null) label.textContent = say('mermaid.label')
      setView(block, state, state.view)
    }
  }

  const scan = (): void => {
    if (disposed) return
    const theme = themeOf()
    if (lastTheme === undefined) lastTheme = theme
    if (theme !== lastTheme) {
      lastTheme = theme
      // 主题变了：mermaid 的配色写在初始化配置里，已渲染的块按新主题重来。
      for (const [block, state] of states) {
        if (state.preview === undefined) continue
        state.attempted = undefined
        scheduleRender(state, block)
      }
    }
    const lang = doc.documentElement.lang
    if (lastLang === undefined) lastLang = lang
    if (lang !== lastLang) {
      lastLang = lang
      relabel()
    }
    for (const [block, state] of states) {
      if (block.isConnected) continue
      clearTimer(state)
      states.delete(block)
    }
    const blocks = doc.querySelectorAll(BLOCK_SELECTOR)
    for (const root of blocks) {
      const block = root as HTMLElement
      if (block.closest(COMPACT_SELECTOR) !== null) continue
      const pre = block.querySelector(SOURCE_SELECTOR)
      if (pre === null) continue
      const text = pre.textContent ?? ''
      const state = stateOf(block)
      const previous = state.source
      state.source = text
      if (state.preview !== undefined && !state.preview.isConnected) {
        state.preview = undefined
        block.removeAttribute(ACTIVE_ATTR)
        block.removeAttribute(VIEW_ATTR)
      }
      if (sniffMermaidSource(text) === undefined) {
        clearTimer(state)
        if (state.preview !== undefined || block.hasAttribute(ACTIVE_ATTR)) dropPreview(block, state)
        else state.attempted = undefined
        continue
      }
      if (state.attempted === text) {
        // 根节点被 React 重挂/重建：把上次的预览补回去，不额外渲染。
        if (state.preview === undefined && state.svg !== undefined) {
          applySvg(block, state, state.view, state.svg)
          observer.takeRecords()
        }
        continue
      }
      if (state.timer !== undefined) {
        if (text === previous) continue
        clearTimer(state)
      }
      scheduleRender(state, block)
    }
  }

  const observer = new MutationObserver(() => {
    if (disposed) return
    if (scanTimer !== undefined) return
    scanTimer = win.setTimeout(() => {
      scanTimer = undefined
      scan()
    }, scanDelayMs)
  })
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
  scan()

  return {
    scan,
    dispose: () => {
      if (disposed) return
      disposed = true
      active = false
      observer.disconnect()
      if (scanTimer !== undefined) {
        win.clearTimeout(scanTimer)
        scanTimer = undefined
      }
      for (const [block, state] of states) {
        clearTimer(state)
        state.preview?.remove()
        block.removeAttribute(ACTIVE_ATTR)
        block.removeAttribute(VIEW_ATTR)
      }
      states.clear()
      cache.clear()
      doc.getElementById(STYLE_ID)?.remove()
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
