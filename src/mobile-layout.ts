/**
 * 手机/窄屏布局：DSH 壳在宽度 <1024 时本来就会自动收起侧栏，但**展开**时
 * 它仍然把 280px 侧栏当作网格的第一列，390px 的手机上主列只剩 110px。
 *
 * 这个模块只补这一处：
 * - 给壳的 frame 与侧栏列打上标记；窄屏展开时让侧栏变成浮层（带遮罩），
 *   主列占满整宽；
 * - 点遮罩、或点侧栏里的导航之后，替用户按一下 DSH 自己的「收起侧边栏」
 *   按钮——折叠状态只归 DSH 的布局服务管，这里不复制它、不直接改 DOM；
 * - 收起时什么都不做，保持 DSH 原有的 56px 轨道（或 iOS 上的 0 轨道）。
 *
 * 标记从壳自己的属性读（frame 的 data-sidebar-collapsed、bottom/overlay 的
 * 座位），不依赖 DSH 的压缩类名；DSH 换皮肤不会把这里悄悄弄坏。
 */

/** 与 DSH 的 SIDEBAR_AUTO_COLLAPSE 对齐：到这个宽度以下侧栏才浮起来。 */
export const MOBILE_MAX_WIDTH = 1023

/** frame 与侧栏列上的标记，样式只认这两个属性。 */
const FRAME_ATTR = 'data-th-mobile-frame'
const SIDEBAR_ATTR = 'data-th-mobile-sidebar'
const STYLE_ID = 'th-mobile-layout-style'

const MOBILE_CSS = `
@media (max-width: ${MOBILE_MAX_WIDTH}px) {
  [${FRAME_ATTR}]:not([data-sidebar-collapsed]) {
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  }
  [${FRAME_ATTR}]:not([data-sidebar-collapsed]) > [${SIDEBAR_ATTR}] {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 40;
    width: min(86vw, 320px);
    height: 100%;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  }
  [${FRAME_ATTR}]:not([data-sidebar-collapsed])::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 35;
    background: rgba(0, 0, 0, 0.42);
  }
}
`

/** 这个模块要的页面面：缺省用真实 document/window，测试塞假件。 */
export type MobileLayoutDeps = {
  document?: Document
  window?: Window
  /** 找不到壳、或收不起侧栏时说一句；缺省吞掉。 */
  log?(message: string): void
}

export type MobileLayout = {
  /** 当下是否处在窄屏（测试与诊断读）。 */
  readonly narrow: boolean
  dispose(): void
}

/**
 * 装上窄屏布局。
 * @param deps - 页面面；SSR/没有 document 时返回一个空壳。
 * @returns dispose 撤样式、监听与观察者。
 */
export function startMobileLayout(deps: MobileLayoutDeps = {}): MobileLayout {
  const doc = deps.document ?? (typeof document === 'undefined' ? undefined : document)
  const win = deps.window ?? doc?.defaultView ?? (typeof window === 'undefined' ? undefined : window)
  if (doc === undefined || win === undefined) {
    return { narrow: false, dispose: () => {} }
  }
  const log = deps.log ?? (() => {})
  let frame: HTMLElement | undefined
  let disposed = false

  const isNarrow = (): boolean => win.innerWidth <= MOBILE_MAX_WIDTH

  if (doc.getElementById(STYLE_ID) === null) {
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = MOBILE_CSS
    doc.head.appendChild(style)
  }

  /** 找到壳并打好标记；返回当下的 frame（没有就 undefined）。 */
  const ensureTagged = (): HTMLElement | undefined => {
    if (frame !== undefined && frame.isConnected && frame.firstElementChild?.hasAttribute(SIDEBAR_ATTR) === true) {
      return frame
    }
    // Frame 的锚点是它自己的两个座位：底部行与浮层都挂在同一个父元素下。
    const bottom = doc.querySelector('[data-shell-bottom]')
    const candidate = bottom?.parentElement ?? doc.querySelector('[data-shell-overlay]')?.parentElement ?? null
    if (candidate === null) return undefined
    const sidebar = candidate.firstElementChild
    if (sidebar === null) return undefined
    candidate.setAttribute(FRAME_ATTR, '')
    sidebar.setAttribute(SIDEBAR_ATTR, '')
    frame = candidate
    return frame
  }

  /** 按一下 DSH 的折叠按钮；按钮标签跟随语言，认「侧边栏 / sidebar」。 */
  const collapse = (): void => {
    const current = ensureTagged()
    if (current === undefined || current.hasAttribute('data-sidebar-collapsed')) return
    const sidebar = current.firstElementChild
    if (sidebar === null) return
    const toggles = [...sidebar.querySelectorAll('button[aria-label]')]
    const toggle = toggles.find(button => /sidebar|侧边栏/i.test(button.getAttribute('aria-label') ?? ''))
    if (toggle === undefined) {
      log('mobile layout: sidebar is expanded but its collapse button was not found')
      return
    }
    // 走它自己的点击：布局服务收到的是和用户点按钮完全相同的一次动作。
    ;(toggle as HTMLButtonElement).click()
  }

  const onClick = (event: MouseEvent): void => {
    if (!isNarrow()) return
    const current = ensureTagged()
    if (current === undefined || current.hasAttribute('data-sidebar-collapsed')) return
    const sidebar = current.firstElementChild
    const target = event.target as Node | null
    if (sidebar !== null && target !== null && sidebar.contains(target)) {
      // 侧栏里的导航：让这次点击先落到应用上，再收起抽屉，否则详情页
      // 会被遮罩挡住。
      win.setTimeout(() => { if (!disposed) collapse() }, 0)
      return
    }
    // 遮罩点击：不把这一下透给被盖住的主列，只收起抽屉。
    event.preventDefault()
    event.stopPropagation()
    collapse()
  }

  doc.addEventListener('click', onClick, true)

  // 壳可能晚于本插件挂载；只在 frame 丢失时重新找，流式输出不会触发
  // 每帧一次 querySelector。
  const observer = new MutationObserver(() => {
    if (frame === undefined || !frame.isConnected) ensureTagged()
  })
  if (doc.body !== null) observer.observe(doc.body, { childList: true, subtree: true })
  ensureTagged()

  return {
    get narrow() { return isNarrow() },
    dispose: () => {
      disposed = true
      doc.removeEventListener('click', onClick, true)
      observer.disconnect()
      doc.getElementById(STYLE_ID)?.remove()
      if (frame !== undefined) {
        frame.removeAttribute(FRAME_ATTR)
        frame.firstElementChild?.removeAttribute(SIDEBAR_ATTR)
      }
    },
  }
}
