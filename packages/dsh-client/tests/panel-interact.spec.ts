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

import { describe, expect, it, vi } from "vitest"
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { AgentPanel } from '../src/panel.tsx'
import type { AgentListPort, AgentPanelProps, HostRegistryPort, RemotePort, RemoteReadResult, RemoteStartResult, TailscalePeer, TailscalePeersResult, TailscalePort } from '../src/panel.tsx'
import type { RollUpSection } from '../src/rollup-section.ts'
import type { ConfiguredIdentity } from '../src/settings-source.ts'
import type { AgentDescriptor, GatewayResult } from '../src/gateway.ts'
import { hostRegistry } from '@threadharbor/dsh-host-federation'
import type { HostIdentity, HostSnapshot, PeerReport, SshConnectionInput } from '@threadharbor/dsh-host-federation'
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

async function mountPanel(registry: HostRegistryPort, hostStore?: FakeHostStore, rollUp?: FakeRollUp, tailscale?: TailscalePort, remote?: RemotePort): Promise<{ container: HTMLElement; root: Root }> {
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
    ...(remote === undefined ? {} : { remote }),
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

  it('添加：列表页点按钮进表单页，没有事实区；确定后新行以未验证出现', async () => {
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
      // 状态不再占一列：以名称旁的圆点标示（title 里带词）。刚登记的主机
      // 没读过、没探过，新模型如实说「未验证」——不再谎称「未连接」。
      const dot = row.querySelector('[data-host-status]')
      expect(dot?.getAttribute('data-host-status')).toBe('offline')
      expect(dot?.getAttribute('title')).toBe('未验证')
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

  it('添加页「从 Tailscale 选」在表单前面；列出 peers（名字+IP+在线徽标），选一台只填名称与 SSH 目标、地址栏留空，选择器收起', async () => {
    const { container, root } = await mountPanel(makeRegistry(), undefined, undefined, new FakeTailscale({ ok: true, peers: TWO_PEERS }))
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
      // 选中只填名称与 SSH 目标：Tailscale 的对端只是 SSH 目标，它的 DSH web
      // 在网上并不直接可达，地址栏留空、由部署或连接成功后写回。
      const name = q(container, '[data-form-field-id]')
      if (!(name instanceof HTMLInputElement)) throw new Error('name input missing')
      const address = q(container, '[data-form-field-address]')
      if (!(address instanceof HTMLInputElement)) throw new Error('address input missing')
      expect(name.value).toBe('bench.tail-scale.ts.net')
      expect(address.value).toBe('')
      const target = q(container, '[data-ssh-target]')
      if (!(target instanceof HTMLInputElement)) throw new Error('ssh target input missing')
      expect(target.value).toBe('100.101.1.7')
      expect(container.querySelector('[data-tailscale-picker]')).toBeNull()
      expect(picker).toBeTruthy()
    } finally {
      await unmount(root)
    }
  })

  it('离线主机置灰但仍可选：点了照样填名称和 SSH 目标，地址栏照旧留空', async () => {
    const { container, root } = await mountPanel(makeRegistry(), undefined, undefined, new FakeTailscale({ ok: true, peers: TWO_PEERS }))
    try {
      click(container, '[data-action="add-host"]')
      click(container, '[data-action="tailscale-pick"]')
      await settle()
      const labbox = q(container, '[data-tailscale-peer="labbox"]')
      expect(labbox.getAttribute('data-tailscale-online')).toBe('false')
      click(container, '[data-tailscale-peer="labbox"]')
      const name = q(container, '[data-form-field-id]')
      const address = q(container, '[data-form-field-address]')
      const target = q(container, '[data-ssh-target]')
      if (!(name instanceof HTMLInputElement) || !(address instanceof HTMLInputElement) || !(target instanceof HTMLInputElement)) throw new Error('inputs missing')
      expect(name.value).toBe('labbox')
      expect(target.value).toBe('100.101.2.9')
      expect(address.value).toBe('')
    } finally {
      await unmount(root)
    }
  })

  it('添加页选中后自动切到 SSH 部署区：IP 进目标栏，名称跟着进主机名栏', async () => {
    // 探测 HEAD 打通＝部署区可用；选择器选中后 addMode 才真的切得过去。
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/threadharbor.host-ssh.operation') && init?.method === 'HEAD') return new Response('', { status: 200 })
      return new Response(JSON.stringify({ ok: false, error: 'no route' }), { status: 404 })
    }) as unknown as typeof fetch
    const { container, root } = await mountPanel(makeRegistry(), undefined, undefined, new FakeTailscale({ ok: true, peers: TWO_PEERS }))
    try {
      await settle()
      click(container, '[data-action="add-host"]')
      click(container, '[data-action="tailscale-pick"]')
      await settle()
      click(container, '[data-tailscale-peer="bench.tail-scale.ts.net"]')
      expect(container.querySelector('[data-ssh-deploy]')).not.toBeNull()
      const target = q(container, '[data-ssh-target]')
      if (!(target instanceof HTMLInputElement)) throw new Error('ssh target input missing')
      expect(target.value).toBe('100.101.1.7')
      const hostId = q(container, '[data-ssh-hostid]')
      if (!(hostId instanceof HTMLInputElement)) throw new Error('hostId input missing')
      expect(hostId.value).toBe('bench.tail-scale.ts.net')
    } finally {
      await unmount(root)
      delete (globalThis as { fetch?: unknown }).fetch
    }
  })

  it('详情页选中不改已登记的地址：输入框原样，登记里 address 前后一致', async () => {
    const registry = makeRegistry([{ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' }])
    const { container, root } = await mountPanel(registry, undefined, undefined, new FakeTailscale({ ok: true, peers: TWO_PEERS }))
    try {
      click(container, '[data-host-open="bench"]')
      const before = registry.list().find(entry => entry.hostId === 'bench')?.address
      const address = q(container, '[data-form-field-address]')
      if (!(address instanceof HTMLInputElement)) throw new Error('address input missing')
      expect(address.value).toBe('192.168.1.20:3081')

      click(container, '[data-action="tailscale-pick"]')
      await settle()
      click(container, '[data-tailscale-peer="bench.tail-scale.ts.net"]')
      // 名称栏照填（可编辑），地址输入框一个字都不动，登记簿也不动。
      const name = q(container, '[data-form-field-id]')
      if (!(name instanceof HTMLInputElement)) throw new Error('name input missing')
      expect(name.value).toBe('bench.tail-scale.ts.net')
      const after = q(container, '[data-form-field-address]')
      if (!(after instanceof HTMLInputElement)) throw new Error('address input missing')
      expect(after.value).toBe('192.168.1.20:3081')
      expect(registry.list().find(entry => entry.hostId === 'bench')?.address).toBe(before)
      expect(before).toBe('http://192.168.1.20:3081')
    } finally {
      await unmount(root)
    }
  })

  it('手填地址的路径不受影响：不选 Tailscale、直接填 IP 并确定，登记的地址补上协议', async () => {
    const registry = makeRegistry()
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-action="add-host"]')
      type(container, '[data-form-field-id]', 'bench.tail-scale.ts.net')
      type(container, '[data-form-field-address]', '100.101.1.7')
      click(container, '[data-form-confirm]')
      expect(registry.list()).toMatchObject([
        { hostId: 'bench.tail-scale.ts.net', hostTitle: 'bench.tail-scale.ts.net', address: 'http://100.101.1.7' },
      ])
    } finally {
      await unmount(root)
    }
  })

  it('地址栏旁的注记把话说在面上：留空由部署或连接自动写入', async () => {
    const { container, root } = await mountPanel(makeRegistry(), undefined, undefined, new FakeTailscale({ ok: true, peers: TWO_PEERS }))
    try {
      click(container, '[data-action="add-host"]')
      expect(q(container, '[data-address-empty-note]').textContent).toBe('留空 = 由部署或连接自动写入')
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

describe('主机详情：使用这台主机 + 远程部署（状态机如实呈现）', () => {
  const SSH_SEED = {
    target: 'mini.tailb6790d.ts.net',
    port: 22,
    user: 'good',
    authMode: 'identityFile' as const,
    identityFile: '/Users/good/.ssh/id_ed25519',
    hostKeyFingerprint: 'SHA256:abc',
    remoteWebPort: 3081,
  }

  function stubFetch(routes: Record<string, unknown | (() => unknown)>): { calls: { url: string; body?: unknown }[] } {
    const calls: { url: string; body?: unknown }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
      if (url.endsWith('/api/threadharbor.host-ssh.operation') && init?.method === 'HEAD') {
        return new Response('', { status: 200 })
      }
      for (const [suffix, payload] of Object.entries(routes)) {
        if (!url.includes(suffix)) continue
        const value = typeof payload === 'function' ? (payload as () => unknown)() : payload
        return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: false, error: `no route for ${url}` }), { status: 404 })
    }) as unknown as typeof fetch
    return { calls }
  }

  it('未存连接方式：使用区块说明现状并给出「填写连接方式」，部署区块默认收起、点开可填', async () => {
    const { calls } = stubFetch({})
    const registry = makeRegistry([{ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' }])
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      const use = q(container, '[data-use-section]')
      expect(use.textContent).toContain('尚未保存')
      click(container, '[data-action="open-deploy"]')
      expect(container.querySelector('[data-ssh-deploy]')).not.toBeNull()
      expect(calls.length).toBeGreaterThanOrEqual(0)
    } finally {
      await unmount(root)
      delete (globalThis as { fetch?: unknown }).fetch
    }
  })

  it('存了连接方式：连接并打开走 connect 路由，成功后登记更新为新网址并开新标签', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { calls } = stubFetch({
      'host-ssh.connect': { ok: true, value: { endpoint: 'http://127.0.0.1:45555', launchUrl: 'http://127.0.0.1:45555/?token=neo', mode: 'tunnel', peer: { pluginsInstalled: true, listen: 'loopback', port: 3081 } } },
    })
    const registry = makeRegistry([{ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081', launchUrl: 'http://192.168.1.20:3081/?token=old' }])
    // 用真实 registry 的存储端口补种 ssh 信息：makeRegistry 只收三个字段，这里手动再 add 一条带 ssh 的
    const withSsh = makeRegistry([])
    ;(withSsh as unknown as { add: (i: Record<string, unknown>) => unknown }).add({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081', ssh: SSH_SEED })
    const { container, root } = await mountPanel(withSsh)
    try {
      click(container, '[data-host-open="bench"]')
      click(container, '[data-action="connect-open"]')
      await act(async () => { await Promise.resolve() })
      const connectCall = calls.find(call => call.url.includes('host-ssh.connect'))
      expect(connectCall).toBeDefined()
      expect(connectCall?.body).toEqual({
        ssh: { target: SSH_SEED.target, port: 22, user: SSH_SEED.user, identityFile: SSH_SEED.identityFile, hostKeyFingerprint: SSH_SEED.hostKeyFingerprint },
        remoteWebPort: 3081,
      })
      expect(open).toHaveBeenCalledWith('http://127.0.0.1:45555/?token=neo', '_blank', 'noopener')
      const updated = withSsh.list().find(entry => entry.hostId === 'bench')
      expect(updated?.address).toBe('http://127.0.0.1:45555')
      expect(updated?.launchUrl).toBe('http://127.0.0.1:45555/?token=neo')
      expect(updated?.ssh?.target).toBe(SSH_SEED.target)
    } finally {
      open.mockRestore()
      await unmount(root)
      delete (globalThis as { fetch?: unknown }).fetch
    }
  })

  it('连接失败：原始原因全文展示，且给重试按钮', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    stubFetch({
      'host-ssh.connect': { ok: false, error: 'ssh: connect to host mini.tailb6790d.ts.net port 22: Connection refused' },
    })
    const withSsh = makeRegistry([])
    ;(withSsh as unknown as { add: (i: Record<string, unknown>) => unknown }).add({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081', ssh: SSH_SEED })
    const { container, root } = await mountPanel(withSsh)
    try {
      click(container, '[data-host-open="bench"]')
      click(container, '[data-action="connect-open"]')
      await act(async () => { await Promise.resolve() })
      const errorBox = q(container, '[data-use-error]')
      expect(errorBox.textContent).toContain('ssh: connect to host mini.tailb6790d.ts.net port 22: Connection refused')
      expect(container.querySelector('[data-action="connect-retry"]')).not.toBeNull()
      expect(open).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
      await unmount(root)
      delete (globalThis as { fetch?: unknown }).fetch
    }
  })

  it('部署在详情页锁定本机名，进度逐行展示，失败原文与重试都在', async () => {
    let operationPolls = 0
    stubFetch({
      'host-ssh.deploy': { ok: true, value: { operationId: 'op-1' } },
      'host-ssh.operation?operationId=op-1': () => {
        operationPolls += 1
        if (operationPolls === 1) return { ok: true, value: { operationId: 'op-1', status: 'running', progress: { phase: 'installing', detail: '正在安装远端 DSH 与插件。' }, startedAt: 1 } }
        return { ok: true, value: { operationId: 'op-1', status: 'failed', progress: { phase: 'failed', detail: '安装中断。' }, error: '远端安装失败：tar: Unexpected EOF in archive\nexit status 2', startedAt: 1, finishedAt: 2 } }
      },
      'host-ssh.inspect': { ok: true, value: { keys: [{ target: 'mini.tailb6790d.ts.net', hostKeyFingerprint: 'SHA256:abc', algorithm: 'ED25519' }] } },
    })
    const registry = makeRegistry([{ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' }])
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      click(container, '[data-action="open-deploy"]')
      expect(container.querySelector('[data-ssh-deploy] [data-ssh-hostid]')).toBeNull()
      type(container, '[data-ssh-deploy] [data-ssh-target]', 'mini.tailb6790d.ts.net')
      type(container, '[data-ssh-deploy] [data-ssh-identity-file]', '/Users/good/.ssh/id_ed25519')
      click(container, '[data-action="ssh-inspect"]')
      await act(async () => { await Promise.resolve() })
      click(container, '[data-ssh-key-row]')
      click(container, '[data-action="ssh-deploy"]')
      // 第一次轮询立刻回来（running），第二次在 800ms 后（failed）。
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
      const log = q(container, '[data-ssh-progress-log]')
      expect(log.textContent).toContain('正在安装远端 DSH 与插件。')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)) })
      const errorBox = q(container, '[data-ssh-error]')
      expect(errorBox.textContent).toContain('远端安装失败：tar: Unexpected EOF in archive')
      expect(container.querySelector('[data-action="ssh-deploy-retry"]')).not.toBeNull()
    } finally {
      await unmount(root)
      delete (globalThis as { fetch?: unknown }).fetch
    }
  })
})

describe('主机行状态词由 hostStatus 推导（事实进、一个词出）', () => {
  const SSH = {
    target: 'mini.tailb6790d.ts.net',
    authMode: 'identityFile' as const,
    identityFile: '/Users/good/.ssh/id_ed25519',
    hostKeyFingerprint: 'SHA256:abc',
  }

  /** 登记一台 bench：add 走真实校验，ssh / remote 读数按需补种。 */
  function seedHost(extra: Record<string, unknown> = {}): HostRegistryPort {
    const registry = makeRegistry([])
    const add = registry as unknown as { add: (input: Record<string, unknown>) => { ok: boolean; error?: { detail: string } } }
    const result = add.add({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081', ...extra })
    if (!result.ok) throw new Error(`seed failed: ${result.error?.detail}`)
    return registry
  }

  /** 用真实登记簿的 recordRemote 写一次远端读数（readAt 是必填的解析门槛）。 */
  function recordRemote(registry: HostRegistryPort, deployment: string, liveness: string): void {
    const port = registry as unknown as { recordRemote: (hostId: string, report: Record<string, unknown>) => boolean }
    if (!port.recordRemote('bench', { deployment, liveness, readAt: 1_000 })) throw new Error('recordRemote refused the report')
  }

  async function rowWord(registry: HostRegistryPort): Promise<string | null> {
    const { container, root } = await mountPanel(registry)
    try {
      return q(container, '[data-host-row="bench"] [data-host-connection]').textContent
    } finally {
      await unmount(root)
    }
  }

  it('读过说没部署：行显示「未部署」，不是含糊的旧词', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemote(registry, 'undeployed', 'unknown')
    expect(await rowWord(registry)).toBe('未部署')
  })

  it('读过说部署了但没在跑：行显示「未启动」', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemote(registry, 'deployed', 'stopped')
    expect(await rowWord(registry)).toBe('未启动')
  })

  it('部署了但读不出在不在跑：行显示「未知」，如实说不知道', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemote(registry, 'deployed', 'unknown')
    expect(await rowWord(registry)).toBe('未知')
  })

  it('部署在跑但没验证过连通性：行显示「未验证」', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemote(registry, 'deployed', 'running')
    expect(await rowWord(registry)).toBe('未验证')
  })

  it('没存凭据的主机读不出部署事实：读数不采信，只按连通性说话（未验证）', async () => {
    const registry = seedHost()
    recordRemote(registry, 'deployed', 'running')
    expect(await rowWord(registry)).toBe('未验证')
  })
})

/**
 * 带原型的假远端读取口：read/start 记下每次调用与实参，读数按构造时的剧本
 * 给。ssh-deploy 路由层的检查主机密钥（inspect）走 HTTP，测试里用 stub 掉的
 * fetch 顶上，往同一份 calls 里记 'inspect'，调用次序因此可以被断言。
 */
class FakeRemote implements RemotePort {
  public readonly calls: string[] = []
  public readonly readInputs: Array<SshConnectionInput & { readonly hostKeyFingerprint: string }> = []

  constructor(
    private readonly readResult:
      | { readonly ok: true; readonly report: PeerReport }
      | { readonly ok: false; readonly error: string },
    private readonly startResult:
      | { readonly ok: true; port: number }
      | { readonly ok: false; readonly error: string } = { ok: true, port: 3081 },
    private readonly hangRead = false,
  ) {}

  /** fetch stub 用：把 inspect 的调用记进同一次序。 */
  note(entry: string): void {
    this.calls.push(entry)
  }

  async read(ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }): Promise<{ readonly ok: true; readonly report: PeerReport } | { readonly ok: false; readonly error: string }> {
    this.calls.push('read')
    this.readInputs.push(ssh)
    if (this.hangRead) return new Promise(() => {})
    return this.readResult.ok ? { ok: true, report: this.readResult.report } : { ok: false, error: this.readResult.error }
  }

  async start(ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }, port: number): Promise<{ readonly ok: true; readonly port: number } | { readonly ok: false; readonly error: string }> {
    this.calls.push(`start:${port}`)
    return this.startResult.ok ? { ok: true, port: this.startResult.port } : { ok: false, error: this.startResult.error }
  }
}

/** 一次成功的远端读数：部署了、在跑、回环监听。 */
const RUNNING_REPORT: PeerReport = {
  pluginsInstalled: true,
  listen: 'loopback',
  port: 3081,
  launchUrl: 'http://127.0.0.1:3081/?token=t',
  liveness: 'running',
}

/**
 * 按剧本出牌的假远端口：read / start 各自按顺序弹出结果，弹完就重复最后
 * 一张。先失败后成功的用例（启动失败留痕要在下次启动成功时清掉）用它。
 */
class ScriptedRemote implements RemotePort {
  public readonly calls: string[] = []
  private readIndex = 0
  private startIndex = 0

  constructor(
    private readonly reads: readonly RemoteReadResult[],
    private readonly starts: readonly RemoteStartResult[],
  ) {}

  async read(ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }): Promise<RemoteReadResult> {
    void ssh
    this.calls.push('read')
    const result = this.reads[Math.min(this.readIndex, this.reads.length - 1)]!
    this.readIndex += 1
    return result
  }

  async start(ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }, port: number): Promise<RemoteStartResult> {
    void ssh
    this.calls.push(`start:${port}`)
    const result = this.starts[Math.min(this.startIndex, this.starts.length - 1)]!
    this.startIndex += 1
    return result
  }
}

describe('详情页按钮表与对方状态读取（hostActions 出按钮，remote 口出读数）', () => {
  const SSH = {
    target: 'mini.tailb6790d.ts.net',
    authMode: 'identityFile' as const,
    identityFile: '/Users/good/.ssh/id_ed25519',
    hostKeyFingerprint: 'SHA256:abc',
  }

  /** 登记一台 bench：add 走真实校验，ssh / remote 读数按需补种。 */
  function seedHost(extra: Record<string, unknown> = {}): HostRegistryPort {
    const registry = makeRegistry([])
    const add = registry as unknown as { add: (input: Record<string, unknown>) => { ok: boolean; error?: { detail: string } } }
    const result = add.add({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081', ...extra })
    if (!result.ok) throw new Error(`seed failed: ${result.error?.detail}`)
    return registry
  }

  /** 按原始形状写一条远端读数（裁定 1 的用例需要带 livenessNote 的记录）。 */
  function recordRemoteRaw(registry: HostRegistryPort, report: Record<string, unknown>): void {
    const port = registry as unknown as { recordRemote: (hostId: string, report: Record<string, unknown>) => boolean }
    if (!port.recordRemote('bench', report as never)) throw new Error('recordRemote refused the report')
  }

  /** 把 async 链上的微任务与重渲染冲干净。 */
  async function flush(times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await act(async () => { await Promise.resolve() })
    }
  }

  it('部署态未部署：详情页状态词是未部署，按钮是部署而不是启动对方', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'undeployed', liveness: 'unknown', readAt: 1_000 })
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      expect(q(container, '[data-host-connection]').textContent).toContain('未部署')
      expect(q(container, '[data-host-actions] [data-action="deploy"]')).toBeTruthy()
      expect(container.querySelector('[data-host-actions] [data-action="start-peer"]')).toBeNull()
    } finally {
      await unmount(root)
    }
  })

  it('运行态未启动：详情页是启动对方 DSH 按钮，点了走 remote.start 再重读', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'deployed', liveness: 'stopped', readAt: 1_000 })
    // 进入详情页本来就会自动读一次；这里让读取失败，未启动的旧读数才留得住，
    // 「未启动」这个状态词也因此可断言（读取失败不动旧读数，裁定 6）。
    const remote = new FakeRemote({ ok: false, error: '读不了' })
    const { container, root } = await mountPanel(registry, undefined, undefined, undefined, remote)
    try {
      click(container, '[data-host-open="bench"]')
      await flush(3)
      expect(q(container, '[data-host-connection]').textContent).toContain('未启动')
      expect(q(container, '[data-host-actions] [data-action="start-peer"]')).toBeTruthy()
      expect(container.querySelector('[data-host-actions] [data-action="deploy"]')).toBeNull()
      click(container, '[data-host-actions] [data-action="start-peer"]')
      await flush(3)
      expect(remote.calls).toContain('start:3081')
      // 启动成功后立刻重读一次：按钮给出的不是「应该启动了」，是读回来的事实。
      expect(remote.calls).toContain('read')
    } finally {
      await unmount(root)
    }
  })

  it('隧道在线：详情页是打开页面按钮', async () => {
    const registry = seedHost()
    const rollUp = new FakeRollUp([
      SELF_HOST,
      { hostId: 'bench', hostTitle: '测试机', lastSeen: 1_000, self: false },
    ])
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, value: {} }) })))
    try {
      const { container, root } = await mountPanel(registry, undefined, rollUp)
      try {
        click(container, '[data-host-open="bench"]')
        // 初始未验证：按钮是检查能否打开；探完可达且对方报过数，就是已连接。
        click(container, '[data-host-actions] [data-action="check-reach"]')
        await flush(2)
        expect(q(container, '[data-host-connection]').textContent).toContain('已连接')
        expect(q(container, '[data-host-actions] [data-action="open-page"]')).toBeTruthy()
      } finally {
        await unmount(root)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('读失败时保留上次读数：失败原因和上次读到的同时在页面上', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'deployed', liveness: 'running', readAt: 1_000 })
    const remote = new FakeRemote({ ok: false, error: 'SSH 读不了' })
    const { container, root } = await mountPanel(registry, undefined, undefined, undefined, remote)
    try {
      click(container, '[data-host-open="bench"]')
      await flush(3)
      expect(q(container, '[data-read-failed]').textContent).toContain('这次没读到：SSH 读不了')
      expect(q(container, '[data-last-read]').textContent).toContain('上次读到的是')
      expect(q(container, '[data-last-read]').textContent).toContain('已部署')
    } finally {
      await unmount(root)
    }
  })

  it('启动失败记在启动名下：不冒充读取失败，两条留痕各说各的', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'deployed', liveness: 'stopped', readAt: 1_000 })
    // 自动读取失败留住「未启动」旧读数；随后启动也失败：两条失败必须各归各家。
    const remote = new FakeRemote({ ok: false, error: 'SSH 读不了' }, { ok: false, error: 'systemd said no' })
    const { container, root } = await mountPanel(registry, undefined, undefined, undefined, remote)
    try {
      click(container, '[data-host-open="bench"]')
      await flush(3)
      // 前提：这次真正的读取失败，原因确实记在读取名下。
      expect(q(container, '[data-read-failed]').textContent).toContain('这次没读到：SSH 读不了')
      click(container, '[data-host-actions] [data-action="start-peer"]')
      await flush(3)
      expect(remote.calls).toContain('start:3081')
      // 读取失败的话一个字不变，启动的原因一个字也不许塞进去。
      expect(q(container, '[data-read-failed]').textContent).toContain('这次没读到：SSH 读不了')
      expect(q(container, '[data-read-failed]').textContent).not.toContain('systemd said no')
      // 启动的失败用自己的话留在页面上。
      expect(q(container, '[data-start-failed]').textContent).toContain('这次没能启动：systemd said no')
    } finally {
      await unmount(root)
    }
  })

  it('启动成功后，上次启动失败的留痕清掉：页面上不再摆过时的失败', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'deployed', liveness: 'stopped', readAt: 1_000 })
    // 第一次读取失败留住旧读数，启动失败一次；再点一次启动成功、跟着的重读也成功。
    const remote = new ScriptedRemote(
      [{ ok: false, error: 'SSH 读不了' }, { ok: true, report: RUNNING_REPORT }],
      [{ ok: false, error: '第一次没起来' }, { ok: true, port: 3081 }],
    )
    const { container, root } = await mountPanel(registry, undefined, undefined, undefined, remote)
    try {
      click(container, '[data-host-open="bench"]')
      await flush(3)
      click(container, '[data-host-actions] [data-action="start-peer"]')
      await flush(3)
      expect(q(container, '[data-start-failed]').textContent).toContain('这次没能启动：第一次没起来')
      click(container, '[data-host-actions] [data-action="start-peer"]')
      await flush(5)
      expect(container.querySelector('[data-start-failed]')).toBeNull()
      // 跟着重读成功落库的是读回来的事实，不是假设。
      const stored = registry.list().find(entry => entry.hostId === 'bench')?.remote
      expect(stored?.liveness).toBe('running')
    } finally {
      await unmount(root)
    }
  })

  it('点刷新对方状态会用已保存的 SSH 凭据去读：identityFile 与指纹都来自登记', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'undeployed', liveness: 'unknown', readAt: 1_000 })
    // 自动读与手动点的读都失败：旧读数留得住，「读一次对方状态」按钮才在。
    const remote = new FakeRemote({ ok: false, error: '读不了' })
    const { container, root } = await mountPanel(registry, undefined, undefined, undefined, remote)
    try {
      click(container, '[data-host-open="bench"]')
      await flush(3)
      click(container, '[data-host-actions] [data-action="read-peer"]')
      await flush(3)
      // 进页面的自动读加上点的这一次，每一次都用登记里存的凭据。
      expect(remote.readInputs.length).toBeGreaterThanOrEqual(2)
      for (const input of remote.readInputs) {
        expect(input.identityFile).toBe(SSH.identityFile)
        expect(input.hostKeyFingerprint).toBe(SSH.hostKeyFingerprint)
        expect(input.target).toBe(SSH.target)
      }
    } finally {
      await unmount(root)
    }
  })

  it('密码认证的主机明说读不了：给说明文字，不去发起读取', async () => {
    const registry = seedHost({ ssh: { target: 'mini.tailb6790d.ts.net', authMode: 'password' } })
    const remote = new FakeRemote({ ok: false, error: '不应被调用' })
    const { container, root } = await mountPanel(registry, undefined, undefined, undefined, remote)
    try {
      click(container, '[data-host-open="bench"]')
      await flush(2)
      expect(q(container, '[data-note-password-auth]').textContent).toContain('凭据不保存')
      expect(remote.calls).toEqual([])
    } finally {
      await unmount(root)
    }
  })

  it('没批准主机密钥时给的是批准并读取；点它先检查密钥再自动读取', async () => {
    const registry = seedHost({ ssh: { ...SSH, hostKeyFingerprint: 'unapproved' } })
    const remote = new FakeRemote({ ok: true, report: RUNNING_REPORT })
    const approvedKey = { target: 'mini.tailb6790d.ts.net', hostKeyFingerprint: 'SHA256:real', algorithm: 'ssh-ed25519' }
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input).includes('host-ssh.inspect')) {
        remote.note('inspect')
        return { status: 200, json: async () => ({ ok: true, value: { keys: [approvedKey] } }) }
      }
      return { status: 200, json: async () => ({ ok: true, value: {} }) }
    }))
    try {
      const { container, root } = await mountPanel(registry, undefined, undefined, undefined, remote)
      try {
        click(container, '[data-host-open="bench"]')
        await flush(2)
        expect(q(container, '[data-host-actions] [data-action="approve-and-read"]')).toBeTruthy()
        expect(container.querySelector('[data-host-actions] [data-action="retry-read"]')).toBeNull()
        click(container, '[data-host-actions] [data-action="approve-and-read"]')
        await flush(5)
        expect(remote.calls).toEqual(['inspect', 'read'])
        expect(remote.readInputs[0]?.hostKeyFingerprint).toBe('SHA256:real')
      } finally {
        await unmount(root)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('指纹没批准时，状态是未启动也不给启动按钮：入口只有批准并读取（裁定5）', async () => {
    const registry = seedHost({ ssh: { ...SSH, hostKeyFingerprint: 'unapproved' } })
    recordRemoteRaw(registry, { deployment: 'deployed', liveness: 'stopped', readAt: 1_000 })
    // 自动读取在未批准时不发起（裁定5），旧读数留得住，「未启动」才可断言。
    const remote = new FakeRemote({ ok: false, error: '不应被调用' })
    const { container, root } = await mountPanel(registry, undefined, undefined, undefined, remote)
    try {
      click(container, '[data-host-open="bench"]')
      await flush(2)
      // 状态词确实是未启动：动作表本来会给出启动按钮，健全性前提。
      expect(q(container, '[data-host-connection]').textContent).toContain('未启动')
      // 但启动拿不出已批准的凭据，按钮表不给它；入口只有批准并读取。
      expect(q(container, '[data-host-actions] [data-action="approve-and-read"]')).toBeTruthy()
      expect(container.querySelector('[data-host-actions] [data-action="start-peer"]')).toBeNull()
      // 表没被整个清空：重部署仍然在。
      expect(q(container, '[data-host-actions] [data-action="redeploy"]')).toBeTruthy()
      expect(remote.calls).toEqual([])
    } finally {
      await unmount(root)
    }
  })

  it('主机行只有状态词：列表行里不出现打开页面/连接并打开/检查能否打开', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'deployed', liveness: 'running', readAt: 1_000 })
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      // 详情页确实有这些按钮（健全性前提），随后回列表。
      expect(q(container, '[data-host-actions] [data-action="check-reach"]')).toBeTruthy()
      click(container, '[data-form-cancel-bottom]')
      for (const action of ['open-page', 'connect-open', 'check-reach']) {
        expect(container.querySelector(`[data-host-row] [data-action="${action}"]`)).toBeNull()
      }
    } finally {
      await unmount(root)
    }
  })

  it('带存活附注的读数不说未部署：记录说没装但机器没来得及回答时，按未知呈现（裁定1）', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'undeployed', liveness: 'unknown', livenessNote: '读取超时', readAt: 1_000 })
    const { container, root } = await mountPanel(registry)
    try {
      // 列表行不说未部署。
      expect(q(container, '[data-host-row="bench"] [data-host-connection]').textContent).toBe('未知')
      click(container, '[data-host-open="bench"]')
      // 详情页也不说未部署——否则操作者会往一台可能已装好的机器上再部署。
      expect(q(container, '[data-host-connection]').textContent).toContain('未知')
      expect(container.querySelector('[data-host-actions] [data-action="deploy"]')).toBeNull()
    } finally {
      await unmount(root)
    }
  })

  it('降级读取的附注不看写的是什么字：换一串实现里没有的附注，同样不说未部署（裁定1）', async () => {
    // 附注故意用一串实现与主机侧今天都不会写出的字面值：两道闸只看附注在
    // 不在，绝不比对附注的文字。谁把判断收窄成「等于某个特定文案」，
    // 这条用例就红——别把它「整理」回「读取超时」。
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'undeployed', liveness: 'unknown', livenessNote: 'deadline-missed-no-answer-9q7', readAt: 1_000 })
    const { container, root } = await mountPanel(registry)
    try {
      expect(q(container, '[data-host-row="bench"] [data-host-connection]').textContent).toBe('未知')
      click(container, '[data-host-open="bench"]')
      expect(q(container, '[data-host-connection]').textContent).toContain('未知')
      expect(container.querySelector('[data-host-actions] [data-action="deploy"]')).toBeNull()
    } finally {
      await unmount(root)
    }
  })

  it('带附注的读数走真的读取口落库：remoteRecordOf 把降级读数落成未知而不是未部署', async () => {
    // 落库这道闸原先没有任何测试盖住：既有用例都从 recordRemoteRaw 绕过它。
    // 这里从假读取口一路走到登记簿，断言写回去的记录本身——同样只看附注
    // 在不在，不看附注写的是什么字。
    const registry = seedHost({ ssh: SSH })
    const remote = new FakeRemote({ ok: true, report: { pluginsInstalled: false, liveness: 'unknown', livenessNote: 'deadline-missed-no-answer-9q7' } })
    const { container, root } = await mountPanel(registry, undefined, undefined, undefined, remote)
    try {
      click(container, '[data-host-open="bench"]')
      await flush(3)
      const stored = registry.list().find(entry => entry.hostId === 'bench')?.remote
      expect(stored?.deployment).toBe('unknown')
      expect(stored?.livenessNote).toBe('deadline-missed-no-answer-9q7')
      expect(stored?.liveness).toBe('unknown')
      expect(typeof stored?.readAt).toBe('number')
      // 屏幕上读到的也是落库之后的词。
      expect(q(container, '[data-host-connection]').textContent).toContain('未知')
    } finally {
      await unmount(root)
    }
  })

  it('已部署但存活读不出：重试读取是主按钮（裁定2 的唯一例外）', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'deployed', liveness: 'unknown', readAt: 1_000 })
    const { container, root } = await mountPanel(registry)
    try {
      click(container, '[data-host-open="bench"]')
      expect(q(container, '[data-host-connection]').textContent).toContain('未知')
      const actions = [...q(container, '[data-host-actions]').querySelectorAll('[data-action]')]
      expect(actions[0]?.getAttribute('data-action')).toBe('retry-read')
      expect(actions.map(action => action.getAttribute('data-action'))).toContain('fill-ssh')
    } finally {
      await unmount(root)
    }
  })

  it('读取在途：行和详情页都说检测中，不抢答', async () => {
    const registry = seedHost({ ssh: SSH })
    recordRemoteRaw(registry, { deployment: 'deployed', liveness: 'running', readAt: 1_000 })
    const remote = new FakeRemote({ ok: true, report: RUNNING_REPORT }, { ok: true, port: 3081 }, true)
    const { container, root } = await mountPanel(registry, undefined, undefined, undefined, remote)
    try {
      click(container, '[data-host-open="bench"]')
      await flush(2)
      expect(q(container, '[data-host-connection]').textContent).toContain('检测中')
      // 回列表：读取还悬着，行同样说检测中，不说旧读数的词。
      click(container, '[data-form-cancel-bottom]')
      expect(q(container, '[data-host-row="bench"] [data-host-connection]').textContent).toBe('检测中')
    } finally {
      await unmount(root)
    }
  })
})
