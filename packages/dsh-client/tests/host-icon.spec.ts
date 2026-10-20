/**
 * 主机入口：侧栏顶部面板图标区里那个主机图标。
 *
 * 这一批把「侧栏底部的分体切换器」换成「顶部的图标 + 主区的主机列表」。图标
 * 行是侧栏画的外壳——整行一个按钮，点击由外壳去切面板；我们注册的只是行里的
 * 一块图形，所以图标自己不接点击。
 *
 * 用真 SlotCore 挂载（与 panel-mount.spec.ts 同一套壳子）：注册错了座位、
 * id 与主区键对不上、或者主区座位没就位，在这里都要红，不能等真机上发现。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { SlotCore, resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { registerPanelSlots, type PanelSlotHost } from '../src/client/index.ts'
import type { AgentPanelBusinessProps } from '../src/panel.tsx'
import { zh } from '../src/locales.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const PANEL_ID = 'threadharbor-rollup'

/**
 * 壳子照真实页面搭：根座位声明 `main`（keyed）与 `sidebar`（single），侧栏
 * 座位再声明 `sidebar.panellist`（列表）与 `settings.section`（列表）。
 * `main` 与 `sidebar` 都是根的子座位、根注册时一并声明，所以主区座位一定
 * 先于面板图标行就位——外壳点图标时 `selectPanel` 有键可切。
 */
function shellWith(core: SlotCore): void {
  core.register(
    {
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        sidebar: { kind: 'single', scope: 'root' },
      },
      inject: () => null,
    },
    () => createElement('div'),
  )
  core.register(
    {
      name: 'sidebar',
      children: {
        'sidebar.panellist': { kind: 'list', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
      },
    },
    () => createElement('div'),
  )
}

/** 面板侧座位适配器：`inject` 在座位已声明时立刻跑回调。 */
function slotHost(core: SlotCore): PanelSlotHost {
  return {
    inject: (key, callback) => {
      if (core.spec(key) === undefined) throw new Error(`slot ${key} is not declared`)
      callback()
      return () => {}
    },
    register: (options, component) => core.register(options, component),
  }
}

/** 面板主体要的那些口，这里只占位：本用例验的是座位与图标，不碰面板内容。 */
const face = {} as unknown as AgentPanelBusinessProps

function mount(): SlotCore {
  const core = new SlotCore()
  shellWith(core)
  registerPanelSlots(slotHost(core), face, () => zh['panel.label'])
  return core
}

describe('主机入口（侧栏顶部图标）', () => {
  it('主机图标进面板图标区，id 与主区座位同名，排在配对图标下面', () => {
    const core = mount()

    const rows = core.entriesOfSlot('sidebar.panellist')
    const row = rows.find(entry => entry.options.id === PANEL_ID)
    expect(row).toBeDefined()
    // 数字越大越靠下：配对图标是 101，主机图标要落在它下面。
    expect(row?.options.order).toBe(102)

    // 外壳点图标时调的是 selectPanel(id)，主区座位必须用同一个键。
    const panels = core.entriesOfSlot('main')
    expect(panels.some(entry => entry.options.key === PANEL_ID)).toBe(true)
  })

  it('面板图标行的标签是词典里的「各主机」，不是空串也不是原始键名', () => {
    const core = mount()

    const row = core.entriesOfSlot('sidebar.panellist').find(entry => entry.options.id === PANEL_ID)
    expect(resolveSlotLabel(row?.options.label)).toBe('各主机')
  })

  it('主区座位与图标行同时就位：外壳点图标时 selectPanel 有键可切', () => {
    const core = mount()

    // 两条都在，才说明外壳那次 selectPanel(PANEL_ID) 不会因为键没注册而抛错。
    expect(core.entriesOfSlot('sidebar.panellist').some(entry => entry.options.id === PANEL_ID)).toBe(true)
    expect(core.entriesOfSlot('main').some(entry => entry.options.key === PANEL_ID)).toBe(true)
  })

  it('图标根元素带 data-host-switcher（网关注入入口的去重判据）', async () => {
    const core = mount()

    const row = core.entriesOfSlot('sidebar.panellist').find(entry => entry.options.id === PANEL_ID)
    const Icon = row?.component as (props: { size: number; active: boolean }) => ReturnType<typeof createElement>

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(Icon, { size: 16, active: false }))
      })
      expect(container.querySelector('[data-host-switcher]')).not.toBeNull()
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })
})
