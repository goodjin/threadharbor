/**
 * 点击行为，在 jsdom 里真实发生：列表 → 详情 → 编辑保存 → 返回，列表 →
 * 添加表单 → 确定/取消，删除登记的确认流。
 *
 * renderToString 只能证明结构，证明不了事件；「点行进详情页」「保存后列表
 * 行变」「确定后新行以未连接出现」是这次改版的验收主体，测试必须点得到
 * 它们。上一轮「静态检查全绿、真机是坏的」的教训之一就是事件层没有测试。
 *
 * 假服务全部带原型方法（先例见 handover-mount.spec.ts）：面板从服务对象上取
 * 方法调用，箭头函数假服务会把「拆下来裸调丢 this」这类错误盖住；登记端口
 * 直接用真的 hostRegistry 配内存存储，登记语义不走仿造。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { AgentPanel } from '../src/panel.tsx'
import type { AgentListPort, AgentPanelProps, HostRegistryPort } from '../src/panel.tsx'
import type { RollUpSection } from '../src/rollup-section.ts'
import type { ConfiguredIdentity } from '../src/settings-source.ts'
import type { AgentDescriptor, GatewayResult } from '../src/gateway.ts'
import { hostRegistry } from '@threadharbor/dsh-host-federation'
import type { HostIdentity, HostSnapshot } from '@threadharbor/dsh-host-federation'
import type { HostStorePosture } from '../src/host-store.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** 带原型的假 agent 目录：方法挂在 prototype 上，不丢 this。 */
class FakeAgents implements AgentListPort {
  constructor(private readonly list: readonly AgentDescriptor[] = []) {}
  current(): readonly AgentDescriptor[] {
    return this.list
  }
  async reload(): Promise<GatewayResult<readonly AgentDescriptor[]>> {
    return { ok: true, value: this.list }
  }
}

/**
 * 带原型的假主机名单。setIdentity 按真的 section（修复后）的契约实现：
 * 返回后再读 hosts()/identity()，看到的是保存后的身份——section 本身的语义
 * 由 rollup-section.spec.ts 对真实现验证，这里只供面板接线使用。
 */
class FakeRollUp implements RollUpSection {
  private snapshot: HostSnapshot

  constructor(hosts: readonly HostSnapshot[] = []) {
    this.snapshot = { ...(hosts.find(host => host.self) ?? hosts[0] ?? { hostId: 'self-host', hostTitle: '本机', lastSeen: 1_000, self: true }) }
  }

  identity(): HostIdentity {
    return { hostId: this.snapshot.hostId, hostTitle: this.snapshot.hostTitle, derived: true }
  }

  hosts(): readonly HostSnapshot[] {
    return [this.snapshot]
  }

  onlineHostIds(): readonly string[] {
    return [this.snapshot.hostId]
  }

  setIdentity(value: ConfiguredIdentity): void {
    this.snapshot = {
      ...this.snapshot,
      ...(value.hostId === undefined ? {} : { hostId: value.hostId }),
      ...(value.hostTitle === undefined ? {} : { hostTitle: value.hostTitle }),
    }
  }

  rereadIdentity(): void {}

  dispose(): void {}
}

/**
 * 带原型的假存储姿态源：可以中途换姿态（水合落地、写入失败都会这样），
 * 换了之后通知订阅者——面板靠它刷新姿态行。
 */
class FakeHostStore {
  private readonly listeners = new Set<() => void>()
  constructor(private state: HostStorePosture) {}
  posture(): HostStorePosture {
    return this.state
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  become(next: HostStorePosture): void {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** 真的 hostRegistry 配内存存储；entries 作为种子直接走 add 的真实校验。 */
function makeRegistry(entries: readonly { hostId: string; hostTitle: string; address: string }[] = []): HostRegistryPort {
  const map = new Map<string, string>()
  const registry = hostRegistry({
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  })
  for (const entry of entries) {
    const result = registry.add(entry)
    if (!result.ok) throw new Error(`seed failed for ${entry.hostId}: ${result.error.detail}`)
  }
  return registry
}

const SELF_HOST: HostSnapshot = { hostId: 'self-host', hostTitle: '本机', lastSeen: 1_000, self: true }

async function mountPanel(registry: HostRegistryPort, hostStore?: FakeHostStore): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const props: AgentPanelProps = {
    agents: new FakeAgents([{ presetId: 'acp-grok', label: 'Grok' }]),
    probe: () => new Promise(() => {}),
    rollUp: new FakeRollUp([SELF_HOST]),
    registry,
    ...(hostStore === undefined ? {} : { hostStore }),
  }
  await act(async () => {
    root.render(createElement(AgentPanel, props))
  })
  return { container, root }
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount()
  })
}

function q(container: HTMLElement, selector: string): Element {
  const el = container.querySelector(selector)
  if (el === null) throw new Error(`no element matches ${selector}`)
  return el
}

function click(container: HTMLElement, selector: string): void {
  const el = q(container, selector)
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function type(container: HTMLElement, selector: string, value: string): void {
  const el = q(container, selector)
  if (!(el instanceof HTMLInputElement)) throw new Error(`${selector} is not an input`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('面板点击行为：列表、详情、添加三个界面', () => {
  it('初始是列表页：只有添加按钮和主机行；agent 区不在列表页', async () => {
    const { container, root } = await mountPanel(makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ]))
    try {
      expect(q(container, '[data-panel-page="list"]')).toBeTruthy()
      expect(q(container, '[data-action="add-host"]').textContent).toContain('添加新主机')
      expect(q(container, '[data-host-row="bench"]')).toBeTruthy()
      expect(container.querySelector('[data-agent-section]')).toBeNull()
      expect(container.querySelector('[data-panel-page="detail"]')).toBeNull()
    } finally {
      await unmount(root)
    }
  })

  it('点本机行进详情页：agent 区在这里；返回列表页', async () => {
    const { container, root } = await mountPanel(makeRegistry())
    try {
      click(container, '[data-host-open="self-host"]')
      expect(q(container, '[data-panel-page="detail"]')).toBeTruthy()
      expect(q(container, '[data-agent-section]')).toBeTruthy()
      expect(q(container, '[data-agent="acp-grok"]')).toBeTruthy()
      expect(container.querySelector('[data-panel-page="list"]')).toBeNull()

      click(container, '[data-form-cancel-bottom]')
      expect(q(container, '[data-panel-page="list"]')).toBeTruthy()
      expect(container.querySelector('[data-agent-section]')).toBeNull()
    } finally {
      await unmount(root)
    }
  })

  it('点登记行进详情页：事实区说未连接，表单可编辑；没有 agent 区', async () => {
    const { container, root } = await mountPanel(makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ]))
    try {
      click(container, '[data-host-open="bench"]')
      expect(q(container, '[data-panel-page="detail"]')).toBeTruthy()
      expect(q(container, '[data-reported-facts]').textContent).toContain('未连接')
      expect(q(container, '[data-form-field-address]')).toBeTruthy()
      expect(q(container, '[data-form-confirm]').textContent).toContain('保存')
      expect(container.querySelector('[data-agent-section]')).toBeNull()
    } finally {
      await unmount(root)
    }
  })

  it('详情页顶部有「主机管理」标题：点开每一台主机都进设置界面', async () => {
    // 2026-10-12 用户决定：设置按钮去掉，各主机按钮收进面板，点开每台主机
    // 进设置界面，现有主机信息作为其中一个栏目。本测试钉住「主机管理」这个入口名。
    const { container, root } = await mountPanel(makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ]))
    try {
      click(container, '[data-host-open="bench"]')
      expect(q(container, '[data-panel-page="detail"]')).toBeTruthy()
      const heading = q(container, '[data-host-management-heading]')
      expect(heading).toBeTruthy()
      expect(heading.textContent).toContain('主机管理')
      // 主机信息仍是其中一个栏目（自报标识、状态等），没被标题取代。
      expect(q(container, '[data-reported-facts]')).toBeTruthy()
    } finally {
      await unmount(root)
    }
  })

  it('详情页改显示名保存后回到列表：那一行的主行跟着变', async () => {
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      type(container, '[data-form-field-title]', '甲板机')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-panel-page="list"]')).toBeTruthy()
      expect(q(container, '[data-host-row="bench"] [data-host-name]').textContent).toBe('甲板机')
      expect(registry.list()[0]).toMatchObject({ hostId: 'bench', hostTitle: '甲板机' })
    } finally {
      await unmount(root)
    }
  })

  it('详情页把标识改成机器自报的：保存后列表行换到新标识下', async () => {
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      type(container, '[data-form-field-id]', 'bench-x')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-host-row="bench-x"] [data-host-name]').textContent).toBe('测试机')
      expect(container.querySelector('[data-host-row="bench"]')).toBeNull()
      expect(registry.list().map(entry => entry.hostId)).toEqual(['bench-x'])
    } finally {
      await unmount(root)
    }
  })

  it('详情页编辑成非法地址：留在详情页，报错，原值还在', async () => {
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      type(container, '[data-form-field-address]', '不是地址')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-panel-page="detail"]')).toBeTruthy()
      expect(q(container, '[data-form-message="bad"]').textContent).toContain('地址')
      const address = q(container, '[data-form-field-address]')
      if (!(address instanceof HTMLInputElement)) throw new Error('address input missing')
      expect(address.value).toBe('不是地址')
      expect(registry.list()[0]).toMatchObject({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' })
    } finally {
      await unmount(root)
    }
  })


  it('存储在后台发通知（登记写入的副作用）时，详情页里正在输入的草稿不被冲掉', async () => {
    const store = new FakeHostStore({ kind: 'host' } satisfies HostStorePosture)
    const { container, root } = await mountPanel(makeRegistry(), store)
    try {
      click(container, '[data-host-open="self-host"]')
      type(container, '[data-form-field-title]', '工作站甲')
      // 真实序列：登记写入 → 存储通知 → 面板重读身份 → 表单若重挂，草稿就丢了
      await act(async () => { store.become({ kind: 'host' }) })
      const titleInput = q(container, '[data-form-field-title]')
      if (!(titleInput instanceof HTMLInputElement)) throw new Error('title field is not an input')
      expect(titleInput.value).toBe('工作站甲')
      click(container, '[data-form-confirm]')
      expect(q(container, '[data-host-row="self-host"] [data-host-name]').textContent).toBe('工作站甲')
    } finally {
      await unmount(root)
    }
  })

  it('本机详情页改名保存后回到列表：本机行显示新名字', async () => {
    const { container, root } = await mountPanel(makeRegistry())
    try {
      click(container, '[data-host-open="self-host"]')
      type(container, '[data-form-field-title]', '工作室主机')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-host-row="self-host"] [data-host-name]').textContent).toBe('工作室主机')
    } finally {
      await unmount(root)
    }
  })

  it('删除登记：详情页里先问后删，确认后回到列表且行消失', async () => {
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      click(container, '[data-registry-remove-ask]')
      expect(q(container, '[data-registry-remove-confirm]')).toBeTruthy()
      click(container, '[data-registry-remove-confirm]')

      expect(q(container, '[data-panel-page="list"]')).toBeTruthy()
      expect(container.querySelector('[data-host-row="bench"]')).toBeNull()
      expect(registry.list()).toHaveLength(0)
    } finally {
      await unmount(root)
    }
  })

  it('添加：列表页点按钮进表单页，没有事实区；确定后新行以未连接出现', async () => {
    const registry = makeRegistry()
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-action="add-host"]')
      expect(q(container, '[data-panel-page="add"]')).toBeTruthy()
      expect(container.querySelector('[data-reported-facts]')).toBeNull()
      expect(q(container, '[data-form-confirm]').textContent).toContain('确定')
      expect(q(container, '[data-form-cancel-bottom]').textContent).toContain('取消')

      type(container, '[data-form-field-address]', 'http://192.168.1.30:3081')
      type(container, '[data-form-field-id]', 'gamma')
      type(container, '[data-form-field-title]', '丙机')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-panel-page="list"]')).toBeTruthy()
      const row = q(container, '[data-host-row="gamma"]')
      expect(row.querySelector('[data-host-name]')?.textContent).toBe('丙机')
      const badge = row.querySelector('[data-host-badge]')
      expect(badge?.getAttribute('data-host-badge')).toBe('offline')
      expect(badge?.textContent).toBe('未连接')
      expect(registry.list().some(entry => entry.hostId === 'gamma')).toBe(true)
    } finally {
      await unmount(root)
    }
  })

  it('添加点取消：回列表页，什么都没加', async () => {
    const registry = makeRegistry()
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-action="add-host"]')
      type(container, '[data-form-field-id]', 'gamma')
      click(container, '[data-form-cancel-bottom]')

      expect(q(container, '[data-panel-page="list"]')).toBeTruthy()
      expect(container.querySelector('[data-host-row="gamma"]')).toBeNull()
      expect(registry.list()).toHaveLength(0)
    } finally {
      await unmount(root)
    }
  })

  it('添加被拒（地址非法）：留在表单页，报错，已输入的内容保留', async () => {
    const registry = makeRegistry()
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-action="add-host"]')
      type(container, '[data-form-field-address]', '不是地址')
      type(container, '[data-form-field-id]', 'gamma')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-panel-page="add"]')).toBeTruthy()
      expect(q(container, '[data-form-message="bad"]')).toBeTruthy()
      const address = q(container, '[data-form-field-address]')
      if (!(address instanceof HTMLInputElement)) throw new Error('address input missing')
      expect(address.value).toBe('不是地址')
      expect(container.querySelector('[data-host-row="gamma"]')).toBeNull()
    } finally {
      await unmount(root)
    }
  })

  it('探测按钮在详情页的 agent 区里真的发起探测', async () => {
    const outcomes: string[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const props: AgentPanelProps = {
      agents: new FakeAgents([{ presetId: 'acp-grok', label: 'Grok' }]),
      probe: () => Promise.resolve({ verdict: { kind: 'ok', ms: 900 } }),
      rollUp: new FakeRollUp([SELF_HOST]),
      registry: makeRegistry(),
    }
    await act(async () => {
      root.render(createElement(AgentPanel, props))
    })
    try {
      click(container, '[data-host-open="self-host"]')
      click(container, '[data-agent="acp-grok"] [data-action="probe"]')
      await act(async () => {
        await Promise.resolve()
      })
      expect(container.querySelector('[data-probe-state="ok"]')).not.toBeNull()
      outcomes.push('ok')
    } finally {
      await act(async () => {
        root.unmount()
      })
    }
    expect(outcomes).toEqual(['ok'])
  })
})

describe('存储姿态行：跟状态走，加页也在', () => {
  it('水合落地姿态从 loading 变 host，列表页那行跟着换说法', async () => {
    const store = new FakeHostStore({ kind: 'loading' } satisfies HostStorePosture)
    const { container, root } = await mountPanel(makeRegistry(), store)
    try {
      expect(q(container, '[data-storage-posture="loading"]').textContent).toContain('正在从这台机器读取')
      act(() => {
        store.become({ kind: 'host' })
      })
      expect(q(container, '[data-storage-posture="host"]').textContent).toContain('保存在这台机器上')
    } finally {
      await unmount(root)
    }
  })

  it('写入失败的姿态把原因带到屏幕上，不是静默退回内存', async () => {
    const store = new FakeHostStore({ kind: 'degraded', detail: '没存进这台机器：通道拒绝' } satisfies HostStorePosture)
    const { container, root } = await mountPanel(makeRegistry(), store)
    try {
      const line = q(container, '[data-storage-posture="degraded"]')
      expect(line.textContent).toContain('通道拒绝')
      expect(line.textContent).toContain('会丢')
    } finally {
      await unmount(root)
    }
  })

  it('添加页同样如实说明存到哪儿，再让用户填表', async () => {
    const store = new FakeHostStore({ kind: 'memory', reason: 'remote-page' } satisfies HostStorePosture)
    const { container, root } = await mountPanel(makeRegistry(), store)
    try {
      click(container, '[data-action="add-host"]')
      const addPage = q(container, '[data-panel-page="add"]')
      expect(addPage.contains(container.querySelector('[data-storage-posture="memory"]'))).toBe(true)
      expect(addPage.textContent).toContain('远程机器')
    } finally {
      await unmount(root)
    }
  })
})
