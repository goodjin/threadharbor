/**
 * 右侧栏覆盖布局：桌面宽度下，DSH 右侧栏（终端/文件/预览/浏览器）展开时
 * 不再推挤会话区，而是叠在会话区上面。
 *
 * DOM 形状照 DSH 壳来：frame 是带 inline grid-template-columns 的网格容器，
 * 第一个流内子元素是侧栏列，右侧栏列挂着 data-rightbar-col；右侧栏的推挤/
 * 全屏状态只认 frame 的 data-rightbar-collapsed 与 data-rightbar-fullscreen，
 * 与真实布局服务的同步一致（SidebarRight 的 syncPresentation）。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  RIGHTBAR_FRAME_ATTR,
  RIGHTBAR_OVERLAY_KEY,
  SIDEBAR_TRACK_VAR,
  STYLE_ID,
  startRightbarOverlay,
} from '../src/rightbar-overlay.ts'

/** 造一个最小可用的 DSH 壳；rightbar 状态用 frame 属性表达，与布局服务一致。 */
function shell(options: { rightbarCollapsed?: boolean; rightbarFullscreen?: boolean; sidebarTrack?: string } = {}): HTMLElement {
  document.body.innerHTML = ''
  const frame = document.createElement('div')
  frame.id = 'frame'
  frame.style.gridTemplateColumns = options.sidebarTrack ?? '280px minmax(360px, 1fr) minmax(0px, 540px)'
  if (options.rightbarCollapsed !== false) frame.setAttribute('data-rightbar-collapsed', '')
  if (options.rightbarFullscreen === true) frame.setAttribute('data-rightbar-fullscreen', '')
  const sidebar = document.createElement('div')
  sidebar.id = 'sidebar'
  const center = document.createElement('div')
  center.id = 'center'
  const rightbarCol = document.createElement('div')
  rightbarCol.setAttribute('data-rightbar-col', '')
  const overlay = document.createElement('div')
  overlay.setAttribute('data-shell-overlay', '')
  frame.append(sidebar, center, rightbarCol, overlay)
  document.body.appendChild(frame)
  return frame
}

/** React 重写 frame 内联样式时用的另一组轨道值。 */
const WIDER_TRACKS = '320px minmax(360px, 1fr) minmax(0px, 480px)'

const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** 每个用例启动的实例都记下，afterEach 统一销毁——观察者跨用例存活会把
 * 新造的 frame 又标回去，污染后面的断言。 */
const started: Array<ReturnType<typeof startRightbarOverlay>> = []

function start(deps: Parameters<typeof startRightbarOverlay>[0]): ReturnType<typeof startRightbarOverlay> {
  const overlay = startRightbarOverlay(deps)
  started.push(overlay)
  return overlay
}

afterEach(() => {
  for (const overlay of started.splice(0)) overlay.dispose()
  document.body.innerHTML = ''
  document.getElementById(STYLE_ID)?.remove()
  window.localStorage.removeItem(RIGHTBAR_OVERLAY_KEY)
})

describe('右侧栏覆盖布局', () => {
  it('默认启用：frame 打标记、样式进 head，覆盖规则带两条状态守卫与桌面媒体查询', () => {
    const frame = shell({ rightbarCollapsed: false })
    start({})

    expect(frame.hasAttribute(RIGHTBAR_FRAME_ATTR)).toBe(true)
    const style = document.getElementById(STYLE_ID)
    expect(style).not.toBeNull()
    const css = style!.textContent ?? ''
    // 只在「推挤展开」时接管：收起（collapsed）与全屏（fullscreen）都不碰。
    expect(css).toContain(`[${RIGHTBAR_FRAME_ATTR}]:not([data-rightbar-collapsed]):not([data-rightbar-fullscreen])`)
    // 第三条轨道压回 0，第一条轨道用镜像变量兜底 280px（DSH 的 SIDEBAR_DEFAULT）。
    expect(css).toContain(`grid-template-columns: var(${SIDEBAR_TRACK_VAR}, 280px) minmax(0, 1fr) 0px !important`)
    // ≤1023 交给 mobile-layout 的抽屉模式，两条 !important 用媒体查询隔开。
    expect(css).toContain('@media (min-width: 1024px)')
    // 叠在会话区上的面板要有浮层影子，只认面板自己的稳定属性。
    expect(css).toContain(`[${RIGHTBAR_FRAME_ATTR}]:not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]) [data-sidebar-right-panel='push']`)
  })

  it('镜像侧栏轨道宽度：从 frame 内联样式读出，React 重写后跟着更新', async () => {
    const frame = shell({ rightbarCollapsed: false })
    start({})
    expect(frame.style.getPropertyValue(SIDEBAR_TRACK_VAR)).toBe('280px')

    // React 因视口/动画重写整条 inline style（含第一条轨道变化），观察者要跟上。
    frame.style.gridTemplateColumns = WIDER_TRACKS
    await settle()
    expect(frame.style.getPropertyValue(SIDEBAR_TRACK_VAR)).toBe('320px')
  })

  it('内联样式读不出轨道时撤掉镜像变量，样式表兜底 280px', async () => {
    const frame = shell({ rightbarCollapsed: false })
    start({})
    expect(frame.style.getPropertyValue(SIDEBAR_TRACK_VAR)).toBe('280px')

    frame.style.gridTemplateColumns = ''
    await settle()
    expect(frame.style.getPropertyValue(SIDEBAR_TRACK_VAR)).toBe('')
  })

  it('开关 off：不插样式、不打标记', () => {
    window.localStorage.setItem(RIGHTBAR_OVERLAY_KEY, 'off')
    const frame = shell({ rightbarCollapsed: false })
    start({})

    expect(frame.hasAttribute(RIGHTBAR_FRAME_ATTR)).toBe(false)
    expect(document.getElementById(STYLE_ID)).toBeNull()
  })

  it('壳晚于插件挂载：观察者找到 frame 并补上标记与镜像', async () => {
    start({})
    const frame = shell({ rightbarCollapsed: false })
    await settle()

    expect(frame.hasAttribute(RIGHTBAR_FRAME_ATTR)).toBe(true)
    expect(frame.style.getPropertyValue(SIDEBAR_TRACK_VAR)).toBe('280px')
  })

  it('dispose：撤样式、标记与镜像，观察者停下', async () => {
    const frame = shell({ rightbarCollapsed: false })
    const overlay = start({})
    overlay.dispose()

    expect(frame.hasAttribute(RIGHTBAR_FRAME_ATTR)).toBe(false)
    expect(frame.style.getPropertyValue(SIDEBAR_TRACK_VAR)).toBe('')
    expect(document.getElementById(STYLE_ID)).toBeNull()

    frame.style.gridTemplateColumns = WIDER_TRACKS
    await settle()
    expect(frame.style.getPropertyValue(SIDEBAR_TRACK_VAR)).toBe('')
  })

  it('重复启动（HMR）：样式只插一份', () => {
    const frame = shell({ rightbarCollapsed: false })
    start({})
    start({})

    expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1)
    expect(frame.hasAttribute(RIGHTBAR_FRAME_ATTR)).toBe(true)
  })
})
