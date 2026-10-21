/**
 * 窄屏侧栏浮层：标记、遮罩点击顺手收起、点导航后收起、桌面宽度不插手。
 *
 * DOM 形状照 DSH 壳来：frame 的第一个元素是侧栏列，底部行与浮层是 frame
 * 的另外两个子元素（data-shell-bottom / data-shell-overlay）。折叠状态只
 * 认 frame 的 data-sidebar-collapsed，测试里的假折叠按钮就改这个属性，
 * 与真实布局服务的行为一致。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest'
import { MOBILE_MAX_WIDTH, startMobileLayout } from '../src/mobile-layout.ts'

const toggleClicks: string[] = []

/** 造一个最小可用的 DSH 壳；expanded 时侧栏没有折叠标记。 */
function shell(expanded: boolean): HTMLElement {
  document.body.innerHTML = ''
  const frame = document.createElement('div')
  frame.id = 'frame'
  if (!expanded) frame.setAttribute('data-sidebar-collapsed', '')
  const sidebar = document.createElement('div')
  sidebar.id = 'sidebar'
  const toggle = document.createElement('button')
  toggle.setAttribute('aria-label', expanded ? '收起侧边栏' : '打开侧边栏')
  toggle.addEventListener('click', () => {
    toggleClicks.push('toggle')
    // 真实布局服务在这一下之后把 frame 标成折叠；测试照此模拟。
    frame.setAttribute('data-sidebar-collapsed', '')
  })
  sidebar.appendChild(toggle)
  const center = document.createElement('div')
  center.id = 'center'
  const bottom = document.createElement('div')
  bottom.setAttribute('data-shell-bottom', '')
  const overlay = document.createElement('div')
  overlay.setAttribute('data-shell-overlay', '')
  frame.append(sidebar, center, bottom, overlay)
  document.body.appendChild(frame)
  return frame
}

function setWidth(px: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px })
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

afterEach(() => {
  toggleClicks.length = 0
  setWidth(1024)
  document.body.innerHTML = ''
})

describe('窄屏侧栏浮层', () => {
  it('装好就把 frame 与侧栏列打上标记，并注入窄屏样式', () => {
    const frame = shell(true)
    const layout = startMobileLayout({ document })
    expect(frame.hasAttribute('data-th-mobile-frame')).toBe(true)
    expect(frame.firstElementChild?.hasAttribute('data-th-mobile-sidebar')).toBe(true)
    expect(document.getElementById('th-mobile-layout-style')?.textContent).toContain(String(MOBILE_MAX_WIDTH))
    layout.dispose()
  })

  it('窄屏展开时点遮罩：这一下不透给主列，侧栏收起', () => {
    setWidth(390)
    const frame = shell(true)
    const layout = startMobileLayout({ document })
    const center = document.getElementById('center')!
    let sawCenterClick = false
    center.addEventListener('click', () => { sawCenterClick = true })
    click(center)
    expect(toggleClicks).toEqual(['toggle'])
    expect(sawCenterClick).toBe(false)
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    layout.dispose()
  })

  it('窄屏展开时点侧栏里的导航：先让导航落地，再收起', async () => {
    setWidth(390)
    shell(true)
    const layout = startMobileLayout({ document })
    const nav = document.createElement('a')
    nav.href = '#/settings'
    document.getElementById('sidebar')!.appendChild(nav)
    click(nav)
    expect(toggleClicks).toEqual([])
    await settle()
    expect(toggleClicks).toEqual(['toggle'])
    layout.dispose()
  })

  it('已经收起时点主列不动作（那是正常操作，不是遮罩）', () => {
    setWidth(390)
    shell(false)
    const layout = startMobileLayout({ document })
    click(document.getElementById('center')!)
    expect(toggleClicks).toEqual([])
    layout.dispose()
  })

  it('桌面宽度下完全不插手', () => {
    setWidth(1400)
    shell(true)
    const layout = startMobileLayout({ document })
    click(document.getElementById('center')!)
    expect(toggleClicks).toEqual([])
    layout.dispose()
  })

  it('壳晚于插件挂载：观察者补上标记', async () => {
    document.body.innerHTML = ''
    const layout = startMobileLayout({ document })
    const frame = shell(true)
    await settle()
    expect(frame.hasAttribute('data-th-mobile-frame')).toBe(true)
    expect(frame.firstElementChild?.hasAttribute('data-th-mobile-sidebar')).toBe(true)
    layout.dispose()
  })

  it('dispose 撤样式、撤标记、撤监听', () => {
    setWidth(390)
    const frame = shell(true)
    const layout = startMobileLayout({ document })
    layout.dispose()
    expect(document.getElementById('th-mobile-layout-style')).toBeNull()
    expect(frame.hasAttribute('data-th-mobile-frame')).toBe(false)
    expect(frame.firstElementChild?.hasAttribute('data-th-mobile-sidebar')).toBe(false)
    click(document.getElementById('center')!)
    expect(toggleClicks).toEqual([])
  })
})
