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
import type { AgentListPort, AgentPanelProps, HostRegistryPort, TailscalePeer, TailscalePeersResult, TailscalePort } from '../src/panel.tsx'
import type { RollUpSection } from '../src/rollup-section.ts'
import type { ConfiguredIdentity } from '../src/settings-source.ts'
import type { AgentDescriptor, GatewayResult } from '../src/gateway.ts'
import { hostRegistry } from '@threadharbor/dsh-host-federation'
import type { HostIdentity, HostSnapshot } from '@threadharbor/dsh-host-federation'
import type { HostStorePosture } from '../src/host-store.ts'
import { zh } from '../src/locales.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/**
 * The `t` the framework would synthesize, bound to the dictionary's source
 * language with the documented `{name}` placeholder substitution — the same
 * copy path the real seat runs, minus the locale registry.
 */
function zhT(key: string, params?: Record<string, unknown>): string {
  return zh[key as keyof typeof zh]!.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

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
  private readonly all: readonly HostSnapshot[]
  private snapshot: HostSnapshot

  constructor(hosts: readonly HostSnapshot[] = []) {
    const fallback = { hostId: 'self-host', hostTitle: '本机', lastSeen: 1_000, self: true }
    this.all = hosts.length > 0 ? hosts : [fallback]
    this.snapshot = { ...(this.all.find(host => host.self) ?? this.all[0] ?? fallback) }
  }

  identity(): HostIdentity {
    return { hostId: this.snapshot.hostId, hostTitle: this.snapshot.hostTitle, derived: true }
  }

  hosts(): readonly HostSnapshot[] {
    // 自报那条以 this.snapshot 为准（setIdentity 改的是它），其余是种子里的路过主机。
    return this.all.map(host => (host.self ? this.snapshot : host))
  }

  onlineHostIds(): readonly string[] {
    return this.all.map(host => (host.self ? this.snapshot.hostId : host.hostId))
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

/**
 * 带原型的假 Tailscale 端口：loadPeers / refresh 都按面板的契约给结果，
 * refresh 记下被点过几次。真端口在 client/index.ts 里走 remote.settings，
 * 这里只管「选择器拿到什么、刷新给什么」。
 */
class FakeTailscale implements TailscalePort {
  public refreshCalls = 0
  constructor(
    private readonly loaded: TailscalePeersResult,
    private readonly refreshed: TailscalePeersResult = loaded,
  ) {}
  async loadPeers(): Promise<TailscalePeersResult> {
    return this.loaded
  }
  async refresh(): Promise<TailscalePeersResult> {
    this.refreshCalls += 1
    return this.refreshed
  }
}

const TWO_PEERS: readonly TailscalePeer[] = [
  { name: 'bench.tail-scale.ts.net', ip: '100.101.1.7', online: true },
  { name: 'labbox', ip: '100.101.2.9', online: false },
]

async function mountPanel(registry: HostRegistryPort, hostStore?: FakeHostStore, rollUp?: FakeRollUp, tailscale?: TailscalePort): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const props: AgentPanelProps = {
    agents: new FakeAgents([{ presetId: 'acp-grok', label: 'Grok' }]),
    probe: () => new Promise(() => {}),
    rollUp: rollUp ?? new FakeRollUp([SELF_HOST]),
    registry,
    t: zhT,
    ...(hostStore === undefined ? {} : { hostStore }),
    ...(tailscale === undefined ? {} : { tailscale }),
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
  it('初始是列表页：表头（名称、状态、IP）+ 主机行（圆点、名称、状态文字、IP、设置按钮）；agent 区不在列表页', async () => {
    const { container, root } = await mountPanel(makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ]))
    try {
      expect(q(container, '[data-panel-page="list"]')).toBeTruthy()
      expect(q(container, '[data-action="add-host"]').textContent).toContain('添加新主机')
      const head = q(container, '[data-host-list-head]')
      const labels = [...head.querySelectorAll('span')].map(span => span.textContent)
      expect(labels[0]).toBe('名称')
      // 状态列由主机状态工作加入：表头四列——名称/状态/IP/设置。
      expect(labels[1]).toBe('状态')
      expect(labels[2]).toBe('IP')
      // 第四列是设置按钮，表头留空。
      expect(labels[3]).toBe('')
      expect(q(container, '[data-host-row="bench"]')).toBeTruthy()
      expect(q(container, '[data-host-row="bench"] [data-host-name]').textContent).toBe('测试机')
      expect(q(container, '[data-host-row="bench"] [data-host-ip]').textContent).toBe('192.168.1.20')
      expect(q(container, '[data-host-row="bench"] [data-host-settings]').textContent).toBe('设置')
      expect(q(container, '[data-host-row="bench"] [data-host-status]').getAttribute('data-host-status')).toBe('offline')
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

  it('点路过的主机（同源在线、未登记）进详情页：名称和 IP 可填，保存即登记', async () => {
    const registry = makeRegistry()
    const { container, root } = await mountPanel(
      registry,
      undefined,
      new FakeRollUp([
        SELF_HOST,
        { hostId: 'peer', hostTitle: '同源的另一个标签页', lastSeen: 1_000, self: false },
      ]),
    )
    try {
      click(container, '[data-host-open="peer"]')
      expect(q(container, '[data-panel-page="detail"]')).toBeTruthy()
      // 路过的主机也可填：名称和 IP 是 input，不是只读 span。
      expect(q(container, '[data-form-field-id=""]').tagName).toBe('INPUT')
      expect(q(container, '[data-form-field-address=""]').tagName).toBe('INPUT')
      expect(q(container, '[data-form-confirm]').textContent).toContain('保存')
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

  it('详情页改名称保存后回到列表：那一行跟着变（名称就是原主机标识）', async () => {
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      type(container, '[data-form-field-id]', '甲板机')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-panel-page="list"]')).toBeTruthy()
      expect(q(container, '[data-host-row="甲板机"] [data-host-name]').textContent).toBe('甲板机')
      expect(container.querySelector('[data-host-row="bench"]')).toBeNull()
      expect(registry.list()[0]).toMatchObject({ hostId: '甲板机', hostTitle: '甲板机' })
    } finally {
      await unmount(root)
    }
  })

  it('详情页把名称改成机器自报的：保存后列表行换到新名称下', async () => {
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      type(container, '[data-form-field-id]', 'bench-x')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-host-row="bench-x"] [data-host-name]').textContent).toBe('bench-x')
      expect(container.querySelector('[data-host-row="bench"]')).toBeNull()
      expect(registry.list().map(entry => entry.hostId)).toEqual(['bench-x'])
    } finally {
      await unmount(root)
    }
  })

  it('详情页编辑成非法 IP：留在详情页，报错，原值还在', async () => {
    const registry = makeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ])
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      type(container, '[data-form-field-address]', '不是 地址')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-panel-page="detail"]')).toBeTruthy()
      expect(q(container, '[data-form-message="bad"]').textContent).toContain('地址')
      const address = q(container, '[data-form-field-address]')
      if (!(address instanceof HTMLInputElement)) throw new Error('address input missing')
      expect(address.value).toBe('不是 地址')
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
      type(container, '[data-form-field-id]', '工作站甲')
      // 真实序列：登记写入 → 存储通知 → 面板重读身份 → 表单若重挂，草稿就丢了
      await act(async () => { store.become({ kind: 'host' }) })
      const nameInput = q(container, '[data-form-field-id]')
      if (!(nameInput instanceof HTMLInputElement)) throw new Error('name field is not an input')
      expect(nameInput.value).toBe('工作站甲')
      click(container, '[data-form-confirm]')
      expect(q(container, '[data-host-row="工作站甲"] [data-host-name]').textContent).toBe('工作站甲')
    } finally {
      await unmount(root)
    }
  })

  it('本机详情页改名称保存后回到列表：本机行显示新名字', async () => {
    const { container, root } = await mountPanel(makeRegistry())
    try {
      click(container, '[data-host-open="self-host"]')
      type(container, '[data-form-field-id]', '工作室主机')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-host-row="工作室主机"] [data-host-name]').textContent).toBe('工作室主机')
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
      // 表单只有两个字段：名称、IP；没有显示名。
      expect(container.querySelectorAll('[data-host-form] input')).toHaveLength(2)
      expect(container.querySelector('[data-form-field-title]')).toBeNull()
      expect(q(container, '[data-form-confirm]').textContent).toContain('确定')
      expect(q(container, '[data-form-cancel-bottom]').textContent).toContain('取消')
      // 确定和取消下面没有内容（说明文字已去掉）。
      expect(container.querySelector('[data-add-notes]')).toBeNull()
      expect(q(container, '[data-panel-page="add"]').textContent).not.toContain('不是建立连接')

      type(container, '[data-form-field-address]', '192.168.1.30:3081')
      type(container, '[data-form-field-id]', 'gamma')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-panel-page="list"]')).toBeTruthy()
      const row = q(container, '[data-host-row="gamma"]')
      expect(row.querySelector('[data-host-name]')?.textContent).toBe('gamma')
      expect(row.querySelector('[data-host-ip]')?.textContent).toBe('192.168.1.30')
      // 状态不再占一列：以名称旁的圆点标示（title 里带词）。
      const dot = row.querySelector('[data-host-status]')
      expect(dot?.getAttribute('data-host-status')).toBe('offline')
      expect(dot?.getAttribute('title')).toBe('未连接')
      // IP 字段不带协议：入库时补上 http://。
      expect(registry.list()).toMatchObject([
        { hostId: 'gamma', hostTitle: 'gamma', address: 'http://192.168.1.30:3081' },
      ])
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

  it('添加被拒（IP 非法）：留在表单页，报错，已输入的内容保留', async () => {
    const registry = makeRegistry()
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-action="add-host"]')
      type(container, '[data-form-field-address]', '不是 地址')
      type(container, '[data-form-field-id]', 'gamma')
      click(container, '[data-form-confirm]')

      expect(q(container, '[data-panel-page="add"]')).toBeTruthy()
      expect(q(container, '[data-form-message="bad"]')).toBeTruthy()
      const address = q(container, '[data-form-field-address]')
      if (!(address instanceof HTMLInputElement)) throw new Error('address input missing')
      expect(address.value).toBe('不是 地址')
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
      t: zhT,
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

describe('从 Tailscale 选：表单前面的选择器', () => {
  /** 点开按钮后把 loadPeers 的异步落地等完（选择器状态是异步置的）。 */
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('添加页「从 Tailscale 选」在表单前面；列出 peers（名字+IP+在线徽标），选一台名称和 IP 一起填上且选择器收起', async () => {
    const registry = makeRegistry()
    const { container, root } = await mountPanel(registry, undefined, undefined, new FakeTailscale({ ok: true, peers: TWO_PEERS }))
    try {
      click(container, '[data-action="add-host"]')
      // 入口在表单前面（2026-10-13 用户反馈），不是地址旁的小按钮。
      expect(container.querySelector('[data-action="tailscale-pick"]')).not.toBeNull()
      const section = q(container, '[data-tailscale-section]')
      const form = q(container, '[data-host-form]')
      expect(section.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

      click(container, '[data-action="tailscale-pick"]')
      await settle()

      const picker = q(container, '[data-tailscale-picker]')
      const bench = q(container, '[data-tailscale-peer="bench.tail-scale.ts.net"]')
      expect(bench.textContent).toContain('100.101.1.7')
      expect(bench.textContent).toContain('在线')
      expect(q(container, '[data-tailscale-peer="labbox"]').textContent).toContain('未连接')
      expect(bench.getAttribute('data-tailscale-online')).toBe('true')
      expect(q(container, '[data-tailscale-peer="labbox"]').getAttribute('data-tailscale-online')).toBe('false')

      click(container, '[data-tailscale-peer="bench.tail-scale.ts.net"]')
      const name = q(container, '[data-form-field-id]')
      if (!(name instanceof HTMLInputElement)) throw new Error('name input missing')
      const ip = q(container, '[data-form-field-address]')
      if (!(ip instanceof HTMLInputElement)) throw new Error('ip input missing')
      expect(name.value).toBe('bench.tail-scale.ts.net')
      expect(ip.value).toBe('100.101.1.7')
      expect(container.querySelector('[data-tailscale-picker]')).toBeNull()
      expect(picker).toBeTruthy()

      // 选完直接确定：登记的是名称 + 补协议的 IP。
      click(container, '[data-form-confirm]')
      expect(registry.list()).toMatchObject([
        { hostId: 'bench.tail-scale.ts.net', hostTitle: 'bench.tail-scale.ts.net', address: 'http://100.101.1.7' },
      ])
    } finally {
      await unmount(root)
    }
  })

  it('离线主机置灰但仍可选：点了照样填名称和 IP，徽标是未连接', async () => {
    const { container, root } = await mountPanel(makeRegistry(), undefined, undefined, new FakeTailscale({ ok: true, peers: TWO_PEERS }))
    try {
      click(container, '[data-action="add-host"]')
      click(container, '[data-action="tailscale-pick"]')
      await settle()
      const labbox = q(container, '[data-tailscale-peer="labbox"]')
      expect(labbox.getAttribute('data-tailscale-online')).toBe('false')
      click(container, '[data-tailscale-peer="labbox"]')
      const name = q(container, '[data-form-field-id]')
      const ip = q(container, '[data-form-field-address]')
      if (!(name instanceof HTMLInputElement) || !(ip instanceof HTMLInputElement)) throw new Error('inputs missing')
      expect(name.value).toBe('labbox')
      expect(ip.value).toBe('100.101.2.9')
    } finally {
      await unmount(root)
    }
  })

  it('点「收起」只关清单不填字段', async () => {
    const { container, root } = await mountPanel(makeRegistry(), undefined, undefined, new FakeTailscale({ ok: true, peers: TWO_PEERS }))
    try {
      click(container, '[data-action="add-host"]')
      click(container, '[data-action="tailscale-pick"]')
      await settle()
      click(container, '[data-action="tailscale-close"]')
      expect(container.querySelector('[data-tailscale-picker]')).toBeNull()
      const name = q(container, '[data-form-field-id]')
      const ip = q(container, '[data-form-field-address]')
      if (!(name instanceof HTMLInputElement) || !(ip instanceof HTMLInputElement)) throw new Error('inputs missing')
      expect(name.value).toBe('')
      expect(ip.value).toBe('')
    } finally {
      await unmount(root)
    }
  })

  it('点「刷新」走 port.refresh：换上的新清单出现', async () => {
    const refreshed: readonly TailscalePeer[] = [{ name: 'newbox', ip: '100.101.9.9', online: true }]
    const port = new FakeTailscale(
      { ok: true, peers: TWO_PEERS },
      { ok: true, peers: refreshed },
    )
    const { container, root } = await mountPanel(makeRegistry(), undefined, undefined, port)
    try {
      click(container, '[data-action="add-host"]')
      click(container, '[data-action="tailscale-pick"]')
      await settle()
      expect(container.querySelector('[data-tailscale-peer="newbox"]')).toBeNull()

      click(container, '[data-action="tailscale-refresh"]')
      await settle()

      expect(port.refreshCalls).toBe(1)
      expect(q(container, '[data-tailscale-peer="newbox"]')).toBeTruthy()
    } finally {
      await unmount(root)
    }
  })

  it('读不到清单（通道缺失等）：选择器里说明原因，不是空白', async () => {
    const { container, root } = await mountPanel(
      makeRegistry(),
      undefined,
      undefined,
      new FakeTailscale({ ok: false, message: '这台机器没有提供设置通道（remote.settings）' }),
    )
    try {
      click(container, '[data-action="add-host"]')
      click(container, '[data-action="tailscale-pick"]')
      await settle()
      expect(q(container, '[data-tailscale-state="failed"]').textContent).toContain('设置通道')
    } finally {
      await unmount(root)
    }
  })

  it('主机侧报告了 tailscale 的毛病（note）：清单照列，毛病原样说在面上', async () => {
    const { container, root } = await mountPanel(
      makeRegistry(),
      undefined,
      undefined,
      new FakeTailscale({ ok: true, peers: [], note: 'tailscale status --json 失败：未登录' }),
    )
    try {
      click(container, '[data-action="add-host"]')
      click(container, '[data-action="tailscale-pick"]')
      await settle()
      expect(q(container, '[data-tailscale-note]').textContent).toContain('未登录')
      expect(q(container, '[data-tailscale-state="empty"]').textContent).toContain('只有本机')
    } finally {
      await unmount(root)
    }
  })

  it('IP 不可编辑的页面（本机详情）没有这个入口；没接端口时也不出现', async () => {
    const withPort = await mountPanel(makeRegistry(), undefined, undefined, new FakeTailscale({ ok: true, peers: TWO_PEERS }))
    try {
      click(withPort.container, '[data-host-open="self-host"]')
      expect(withPort.container.querySelector('[data-action="tailscale-pick"]')).toBeNull()
    } finally {
      await unmount(withPort.root)
    }

    const withoutPort = await mountPanel(makeRegistry())
    try {
      click(withoutPort.container, '[data-action="add-host"]')
      expect(withoutPort.container.querySelector('[data-action="tailscale-pick"]')).toBeNull()
    } finally {
      await unmount(withoutPort.root)
    }
  })
})
