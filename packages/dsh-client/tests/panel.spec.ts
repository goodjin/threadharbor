/**
 * The agent panel's pieces, without a browser in the loop.
 *
 * 2026-10-12 用户反馈定下的形状：面板是三个界面——
 * 1. 列表页：上方一个「添加新主机」按钮，下面是主机行；行是摘要，点行进
 *    详情页（不再就地展开）；列表页宽度固定，别的什么都不放。
 * 2. 详情页：和添加页是同一套表单的两种模式——用户填的字段（主机标识、
 *    显示名、地址）是表单，主机自己报的事实（在线状态、心跳、自报的标识
 *    和名字）只在详情模式出现；本机的 agent 列表属于本机的详情页。
 * 3. 添加页：同一套表单的新增模式，下面「确定」「取消」两个按钮。
 * 主机标识两边可能不一样（人填的 vs 机器自报的）：两个都摆出来，不悄悄
 * 用一个覆盖另一个。
 *
 * 这里的测试管结构：哪个界面该有什么、收起时什么必须不出现。点击行为
 * （跳转、保存、提交）另有 jsdom 交互测试（panel-interact.spec.ts），真机
 * 验收在真实浏览器里做。
 */

import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { describeVerdict } from '../src/verdict.ts'
import type { ProbeVerdict } from '../src/verdict.ts'
import { IDENTITY_STORAGE_KEY, IDENTITY_TAB_STORAGE_KEY, layeredIdentitySettings, storageIdentitySettings } from '../src/settings-source.ts'
import type { ConfiguredIdentity } from '../src/settings-source.ts'
import {
  runProbe,
  AgentPanel,
  AgentRow,
  HostRow,
  HostFormPage,
  mergeHostRows,
  heartbeatWord,
  applyRegistrationEdit,
  type ProbeRunState,
  type RegistrationEditInput,
} from '../src/panel.tsx'
import type { AgentListPort, HostListRow, HostRegistryPort } from '../src/panel.tsx'
import type { ProbeOutcome } from '../src/probe.ts'
import type { RollUpSection } from '../src/rollup-section.ts'
import type { AgentDescriptor, GatewayResult } from '../src/gateway.ts'
import { hostRegistry } from '@threadharbor/dsh-host-federation'
import type { HostIdentity, HostRegistration, HostSnapshot } from '@threadharbor/dsh-host-federation'
import type { HostStorePosture } from '../src/host-store.ts'

/** A string-map stand-in for the slice of localStorage these settings touch. */
function fakeStorage(initial: Record<string, string> = {}): {
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }
  dump(): Record<string, string>
} {
  const map = new Map(Object.entries(initial))
  return {
    storage: {
      getItem: key => map.get(key) ?? null,
      setItem: (key, value) => { map.set(key, value) },
    },
    dump: () => Object.fromEntries(map),
  }
}

describe('主机身份设置来源', () => {
  it('没有配置时读出来是空的，写入后再读就是配置的值', () => {
    const { storage } = fakeStorage()
    const settings = storageIdentitySettings(storage)
    expect(settings.read()).toEqual({})
    settings.write({ hostId: 'studio', hostTitle: '工作室主机' })
    expect(settings.read()).toEqual({ hostId: 'studio', hostTitle: '工作室主机' })
  })

  it('写进真实的存储键，值是 JSON，别的键不受影响', () => {
    const { storage, dump } = fakeStorage({ 'unrelated': 'keep' })
    storageIdentitySettings(storage).write({ hostId: 'studio' })
    const written = dump()[IDENTITY_STORAGE_KEY]
    expect(JSON.parse(written)).toEqual({ hostId: 'studio' })
    expect(dump()['unrelated']).toBe('keep')
  })

  it('存储里的坏数据读成空配置，而不是把面板砸了', () => {
    const { storage } = fakeStorage({ [IDENTITY_STORAGE_KEY]: '{not json' })
    expect(storageIdentitySettings(storage).read()).toEqual({})
  })

  it('非字符串的字段被丢弃，字符串的保留', () => {
    const { storage } = fakeStorage({ [IDENTITY_STORAGE_KEY]: JSON.stringify({ hostId: 42, hostTitle: '甲' }) })
    expect(storageIdentitySettings(storage).read()).toEqual({ hostTitle: '甲' })
  })
})

describe('四种结论的措辞', () => {
  it('四种结论各有各的说法，两两不同', () => {
    const verdicts: ProbeVerdict[] = [
      { kind: 'ok', ms: 800 },
      { kind: 'slow', ms: 20_000 },
      { kind: 'hung', ms: 60_000 },
      { kind: 'unreachable', reason: 'route not found' },
    ]
    const headlines = verdicts.map(verdict => describeVerdict(verdict).headline)
    expect(new Set(headlines).size).toBe(4)
    expect(headlines).toEqual(['正常', '偏慢', '卡住', '连不上'])
  })

  it('卡住的建议不再指向重启：主机自己会重连，这里让人去看 agent', () => {
    const display = describeVerdict({ kind: 'hung', ms: 60_000 })
    expect(display.advice).not.toContain('重启')
    expect(display.advice).toContain('agent')
  })

  it('连不上说的是地址和凭证，不是速度', () => {
    const display = describeVerdict({ kind: 'unreachable', reason: 'connect ECONNREFUSED' })
    expect(display.detail).toBe('connect ECONNREFUSED')
    expect(display.advice).toContain('地址')
  })
})

/** 带原型的假 agent 目录：方法挂在 prototype 上，从对象上取下来调用不丢 this。 */
class FakeAgents implements AgentListPort {
  constructor(private readonly list: readonly AgentDescriptor[] = []) {}
  current(): readonly AgentDescriptor[] {
    return this.list
  }
  async reload(): Promise<GatewayResult<readonly AgentDescriptor[]>> {
    return { ok: true, value: this.list }
  }
}

/** A probe the test hands out outcomes through. */
function fakeProbe(): { probe: (presetId: string) => Promise<ProbeOutcome>; settle: (outcome: ProbeOutcome) => void } {
  let pending: Promise<ProbeOutcome> = new Promise(() => {})
  return {
    probe: () => pending,
    settle: outcome => { pending = Promise.resolve(outcome) },
  }
}

const okOutcome: ProbeOutcome = { verdict: { kind: 'ok', ms: 900 } }

/**
 * 带原型的假主机名单：面板从它身上取 identity()/hosts() 调用，this 必须活着。
 * 它只按实现 RollUpSection 接口回答；名单语义（心跳、过期、改名传播）由
 * rollup-section.spec.ts 对真的 section 验证。
 */
class FakeRollUpSection implements RollUpSection {
  constructor(private readonly list: readonly HostSnapshot[] = [{ hostId: 'self-host', hostTitle: '本机', lastSeen: 1000, self: true }]) {}
  identity(): HostIdentity {
    const self = this.list.find(host => host.self) ?? this.list[0]
    return { hostId: self?.hostId ?? 'self-host', hostTitle: self?.hostTitle ?? '本机', derived: true }
  }
  hosts(): readonly HostSnapshot[] {
    return this.list
  }
  onlineHostIds(): readonly string[] {
    return this.list.map(host => host.hostId)
  }
  setIdentity(_value: ConfiguredIdentity): void {}
  rereadIdentity(): void {}
  republish(): void {}
  element(): HTMLDivElement { return document.createElement('div') }
  notices(): readonly string[] { return [] }
  dispose(): void {}
}

/**
 * 真的 hostRegistry 配假存储：登记语义（校验、去重、持久化）走实现本身，
 * 不走仿造——编辑登记的测试因此验证的是真行为。
 */
function seededRegistry(entries: readonly { hostId: string; hostTitle: string; address: string }[] = []): HostRegistryPort {
  const { storage } = fakeStorage()
  const registry = hostRegistry(storage)
  for (const entry of entries) {
    const result = registry.add(entry)
    if (!result.ok) throw new Error(`seed failed for ${entry.hostId}: ${result.error.detail}`)
  }
  return registry
}

const renderPanel = (rollUp: RollUpSection, registry: HostRegistryPort, posture?: HostStorePosture): string =>
  renderToString(createElement(AgentPanel, {
    agents: new FakeAgents([]),
    probe: fakeProbe().probe,
    rollUp,
    registry,
    ...(posture === undefined ? {} : { hostStore: fakeHostStore(posture) }),
  }))

/** 带原型的假存储姿态源：posture 挂 prototype，取下来调用不丢 this。 */
class FakeHostStore {
  constructor(private readonly state: HostStorePosture) {}
  posture(): HostStorePosture {
    return this.state
  }
  subscribe(): () => void {
    return () => {}
  }
}

const fakeHostStore = (posture: HostStorePosture): FakeHostStore => new FakeHostStore(posture)

describe('存储姿态行：设置落在哪儿、坏了没有，如实说', () => {
  const cases: readonly { readonly name: string; readonly posture: HostStorePosture; readonly marker: string; readonly text: RegExp }[] = [
    { name: '本机存储健康', posture: { kind: 'host' }, marker: 'data-storage-posture="host"', text: /保存在这台机器上/ },
    { name: '正在读取', posture: { kind: 'loading' }, marker: 'data-storage-posture="loading"', text: /正在从这台机器读取/ },
    { name: '远程页面走内存', posture: { kind: 'memory', reason: 'remote-page' }, marker: 'data-storage-posture="memory"', text: /远程机器/ },
    { name: '没有设置通道走内存', posture: { kind: 'memory', reason: 'no-channel' }, marker: 'data-storage-posture="memory"', text: /设置存储通道/ },
    { name: '存取坏了点名原因', posture: { kind: 'degraded', detail: '没存进去：通道拒绝' }, marker: 'data-storage-posture="degraded"', text: /通道拒绝/ },
  ]
  for (const { name, posture, marker, text } of cases) {
    it(`列表页：${name}`, () => {
      const html = renderPanel(new FakeRollUpSection(), seededRegistry(), posture)
      expect(html).toContain(marker)
      expect(html).toMatch(text)
    })
  }

  it('没接存储姿态来源时（旧调用方）不渲染这一行，面板照常', () => {
    const html = renderPanel(new FakeRollUpSection(), seededRegistry())
    expect(html).not.toContain('data-storage-posture')
    expect(html).toContain('data-panel-page="list"')
  })
})

describe('面板渲染（agent 探测，位于本机详情页）', () => {
  it('每个 agent 一行，带名字和探测按钮，没有重启按钮', () => {
    const html = renderToString(createElement(AgentRow, {
      presetId: 'acp-grok',
      label: 'Grok',
      onProbe: () => {},
    }))
    expect(html).toContain('data-agent="acp-grok"')
    expect(html).toContain('data-action="probe"')
    expect(html).not.toContain('data-action="restart"')
  })

  it('归档没成功时，那句说明出现在结论旁边', () => {
    const html = renderToString(createElement(AgentRow, {
      presetId: 'acp-grok',
      label: 'Grok',
      verdict: { phase: 'done', verdict: { kind: 'ok', ms: 900 }, archiveNote: '归档失败：workspace is stopping' } satisfies ProbeRunState,
      onProbe: () => {},
    }))
    expect(html).toContain('正常')
    expect(html).toContain('归档失败：workspace is stopping')
  })

  it('结论是行里的主角：状态词单独着色，数字用等宽数字，建议收进折叠', () => {
    const html = renderToString(createElement(AgentRow, {
      presetId: 'acp-grok',
      label: 'Grok',
      verdict: { phase: 'done', verdict: { kind: 'slow', ms: 20_000 } } satisfies ProbeRunState,
      onProbe: () => {},
    }))
    expect(html).toContain('data-verdict-word=""')
    expect(html).toContain('data-verdict-tone="slow"')
    expect(html).toContain('data-verdict-detail=""')
    expect(html).toContain('20000 ms')
    expect(html).toContain('<details')
    expect(html).toContain('再探测一次')
  })
})

describe('runProbe', () => {
  it('把探测结果变成完成状态', async () => {
    const states: ProbeRunState[] = []
    const probe = fakeProbe()
    probe.settle(okOutcome)
    const running = runProbe(probe.probe, 'acp-grok', state => { states.push(state) })
    expect(states[0]).toEqual({ phase: 'running' })
    await running
    expect(states[1]).toEqual({ phase: 'done', verdict: { kind: 'ok', ms: 900 } })
  })

  it('探测坏了不把面板砸了：错误成为状态，异常被接住', async () => {
    const states: ProbeRunState[] = []
    const broken: (presetId: string) => Promise<ProbeOutcome> = () => Promise.reject(new Error('gateway gone'))
    await runProbe(broken, 'acp-grok', state => { states.push(state) })
    expect(states[1]).toEqual({ phase: 'error', message: 'gateway gone' })
  })
})

describe('分层身份：标签页自己的声明压过本源默认', () => {
  it('标签页存过就用标签页的，没存过退回本源默认', () => {
    const tab = fakeStorage().storage
    const local = fakeStorage({ [IDENTITY_STORAGE_KEY]: JSON.stringify({ hostId: 'origin-default', hostTitle: '源默认' }) }).storage
    const settings = layeredIdentitySettings(tab, local)
    expect(settings.read()).toEqual({ hostId: 'origin-default', hostTitle: '源默认' })
    settings.write({ hostId: 'tab-b', hostTitle: '标签页乙' })
    expect(settings.read()).toEqual({ hostId: 'tab-b', hostTitle: '标签页乙' })
  })

  it('写入同时落到两层：本标签页重载不走样，新标签页继承本源默认', () => {
    const tab = fakeStorage().storage
    const local = fakeStorage().storage
    const settings = layeredIdentitySettings(tab, local)
    settings.write({ hostId: 'bench', hostTitle: '测试机' })
    expect(JSON.parse(tab.getItem(IDENTITY_TAB_STORAGE_KEY)!)).toEqual({ hostId: 'bench', hostTitle: '测试机' })
    expect(JSON.parse(local.getItem(IDENTITY_STORAGE_KEY)!)).toEqual({ hostId: 'bench', hostTitle: '测试机' })
    // A fresh tab has no claim of its own; it reads the origin default.
    expect(layeredIdentitySettings(fakeStorage().storage, local).read()).toEqual({ hostId: 'bench', hostTitle: '测试机' })
  })

  it('两个标签页各自声明后互不覆盖：乙的写入不动甲的声明', () => {
    const tabA = fakeStorage().storage
    const tabB = fakeStorage().storage
    const local = fakeStorage().storage
    layeredIdentitySettings(tabA, local).write({ hostId: 'host-a', hostTitle: '甲' })
    layeredIdentitySettings(tabB, local).write({ hostId: 'host-b', hostTitle: '乙' })
    expect(layeredIdentitySettings(tabA, local).read().hostId).toBe('host-a')
    expect(layeredIdentitySettings(tabB, local).read().hostId).toBe('host-b')
  })
})

describe('主机表单页：新增和详情是同一套东西的两种模式', () => {
  const viewProps = {
    mode: 'view',
    heading: '测试机',
    values: { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    onConfirm: () => true,
    onCancel: () => {},
  } as const

  it('新增模式：只有人填的三个字段和确定/取消；主机报的字段一概不出现', () => {
    const html = renderToString(createElement(HostFormPage, {
      mode: 'new',
      heading: '添加新主机',
      values: { hostId: '', hostTitle: '', address: '' },
      onConfirm: () => false,
      onCancel: () => {},
    }))
    expect(html).toContain('data-panel-page="add"')
    expect(html).toContain('data-form-field-id=""')
    expect(html).toContain('data-form-field-title=""')
    expect(html).toContain('data-form-field-address=""')
    expect(html).toContain('data-form-confirm=""')
    expect(html).toContain('确定')
    expect(html).toContain('data-form-cancel=""')
    expect(html).toContain('取消')
    expect(html).not.toContain('data-reported-facts')
    expect(html).not.toContain('最近心跳')
    expect(html).not.toContain('data-agent-section')
    // 诚实的说明不丢：登记不是建连 + 完整环境前提都在添加页（折叠）。
    expect(html).toContain('data-registry-posture=""')
    expect(html).toContain('不是建立连接')
    expect(html).toContain('添加一台主机需要什么')
    expect(html).toContain('--trusted-host')
    expect(html).toContain('凭证留在主机侧')
  })

  it('详情模式：同一套字段之外，主机自报的事实也在（在线、心跳、自报标识和名字）', () => {
    const html = renderToString(createElement(HostFormPage, {
      ...viewProps,
      reported: {
        self: false,
        online: true,
        lastSeen: 9_000,
        reportedId: 'bench',
        reportedTitle: '测试机',
        onlineIds: ['bench'],
      },
    }))
    expect(html).toContain('data-panel-page="detail"')
    expect(html).toContain('data-reported-facts=""')
    expect(html).toContain('data-fact-online=""')
    expect(html).toContain('在线')
    expect(html).toContain('最近心跳')
    expect(html).toContain('data-fact-reported-id=""')
    expect(html).toContain('data-fact-reported-title=""')
    expect(html).toContain('data-form-confirm=""')
    expect(html).toContain('data-form-cancel=""')
  })

  it('自报的标识和名字与登记一致时，明说一致', () => {
    const html = renderToString(createElement(HostFormPage, {
      ...viewProps,
      reported: { self: false, online: true, lastSeen: 9_000, reportedId: 'bench', reportedTitle: '测试机', onlineIds: ['bench'] },
    }))
    expect(html).toContain('data-fact-id-match=""')
    expect(html).toContain('data-fact-title-match=""')
    expect(html).not.toContain('data-fact-id-mismatch')
    expect(html).not.toContain('data-fact-title-mismatch')
  })

  it('自报标识与填的标识不一致时，两个都摆出来，不覆盖', () => {
    const html = renderToString(createElement(HostFormPage, {
      ...viewProps,
      reported: { self: false, online: true, lastSeen: 9_000, reportedId: 'bench-x', reportedTitle: '测试机', onlineIds: ['bench-x'] },
    }))
    expect(html).toContain('data-fact-id-mismatch=""')
    expect(html).toContain('bench-x')
    expect(html).toContain('bench')
    expect(html).not.toContain('data-fact-id-match')
  })

  it('自报名字与登记名不一致时，两个名字都在', () => {
    const html = renderToString(createElement(HostFormPage, {
      ...viewProps,
      reported: { self: false, online: true, lastSeen: 9_000, reportedId: 'bench', reportedTitle: '机器自报的名字', onlineIds: ['bench'] },
    }))
    expect(html).toContain('data-fact-title-mismatch=""')
    expect(html).toContain('机器自报的名字')
    expect(html).toContain('测试机')
  })

  it('登记的标识不在频道上时，如实说没有，并列出现在在线的标识（真实传入的数据）', () => {
    const html = renderToString(createElement(HostFormPage, {
      ...viewProps,
      reported: { self: false, online: false, onlineIds: ['alpha-live', 'zeta-live'] },
    }))
    expect(html).toContain('频道上没有这个标识')
    expect(html).toContain('data-fact-online-ids=""')
    expect(html).toContain('alpha-live')
    expect(html).toContain('zeta-live')
    expect(html).not.toContain('data-fact-heartbeat')
  })

  it('离线时没有心跳，也没有自报标识可摆', () => {
    const html = renderToString(createElement(HostFormPage, {
      ...viewProps,
      reported: { self: false, online: false, onlineIds: [] },
    }))
    expect(html).not.toContain('data-fact-heartbeat')
    expect(html).not.toContain('data-fact-reported-id')
  })

  it('本机详情：事实区说明这就是本机身份', () => {
    const html = renderToString(createElement(HostFormPage, {
      mode: 'view',
      heading: '本机',
      values: { hostId: 'self-host', hostTitle: '本机', address: '' },
      reported: { self: true, online: true, lastSeen: 9_000, reportedId: 'self-host', reportedTitle: '本机', onlineIds: ['self-host'] },
      onConfirm: () => true,
      onCancel: () => {},
    }))
    expect(html).toContain('这就是本机')
    expect(html).toContain('最近心跳')
  })

  it('agent 区只在传进来时渲染：它是调用方（本机详情）的事', () => {
    const withAgents = renderToString(createElement(HostFormPage, {
      ...viewProps,
      reported: { self: true, online: true, lastSeen: 9_000, reportedId: 'bench', reportedTitle: '测试机', onlineIds: ['bench'] },
      agents: createElement('div', { 'data-agent-section': '' }, 'agent 区'),
    }))
    expect(withAgents).toContain('data-agent-section=""')
    const without = renderToString(createElement(HostFormPage, { ...viewProps }))
    expect(without).not.toContain('data-agent-section')
  })
})

describe('面板三个界面', () => {
  it('初始是列表页：只有添加按钮和主机行；agent 卡、计数、说明、就地展开都不在', () => {
    const html = renderPanel(
      new FakeRollUpSection([
        { hostId: 'self-host', hostTitle: '本机', lastSeen: 1000, self: true },
        { hostId: 'bench', hostTitle: '测试机', lastSeen: 1001, self: false },
      ]),
      seededRegistry([{ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' }]),
    )
    expect(html).toContain('data-panel-page="list"')
    expect(html).toContain('data-action="add-host"')
    expect(html).toContain('data-host-open="bench"')
    expect(html).toContain('data-host-open="self-host"')
    expect(html).not.toContain('data-panel-section="agents"')
    expect(html).not.toContain('data-host-count')
    expect(html).not.toContain('data-panel-notices')
    expect(html).not.toContain('data-host-details')
  })

  it('列表页的主行还是只有名字、简短标识、徽标', () => {
    const html = renderToString(createElement(HostRow, {
      row: { hostId: 'bench', name: '测试机', self: false, online: false, connection: 'disconnected', address: 'http://192.168.1.20:3081' },
      onOpen: () => {},
    }))
    expect(html).toContain('data-host-open="bench"')
    expect(html).toContain('data-host-name=""')
    expect(html).toContain('data-host-id-label=""')
    expect(html).toContain('data-host-badge="offline"')
    expect(html).not.toContain('http://192.168.1.20:3081')
    expect(html).not.toContain('最近心跳')
  })

  it('徽标分三色：本机、在线、未连接', () => {
    const cases: [HostListRow, string][] = [
      [{ hostId: 'self', name: '本机', self: true, online: true, connection: 'connected' }, 'data-host-badge="self"'],
      [{ hostId: 'beta', name: 'b', self: false, online: true, connection: 'connected' }, 'data-host-badge="online"'],
      [{ hostId: 'bench', name: 'b', self: false, online: false, connection: 'disconnected' }, 'data-host-badge="offline"'],
    ]
    for (const [row, marker] of cases) {
      const html = renderToString(createElement(HostRow, { row, onOpen: () => {} }))
      expect(html).toContain(marker)
    }
  })

  it('说明（在线的含义等）收进详情页的折叠，不占列表页', () => {
    // 详情页由面板在有 reported 事实时渲染；说明随 HostFormPage 的 notes 进
    // 详情页，交互测试验证点行后能看到。
    const html = renderToString(createElement(HostFormPage, {
      mode: 'view',
      heading: '测试机',
      values: { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
      reported: { self: false, online: false, onlineIds: [] },
      notes: createElement('ul', { 'data-panel-notices': '' }, createElement('li', null, '「在线」= 同源标签页按心跳报数')),
      onConfirm: () => true,
      onCancel: () => {},
    }))
    expect(html).toContain('data-panel-notices=""')
    expect(html).toContain('「在线」')
  })
})

describe('登记编辑', () => {
  const seeded = (): HostRegistryPort => seededRegistry([
    { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
  ])

  it('改名成功：旧条目被替换，列表里是新名字新地址', () => {
    const registry = seeded()
    const input: RegistrationEditInput = { hostTitle: '甲板机', address: 'http://10.0.0.8:3081' }
    const result = applyRegistrationEdit(registry, 'bench', input)
    expect(result.ok).toBe(true)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ hostId: 'bench', hostTitle: '甲板机', address: 'http://10.0.0.8:3081' })
  })

  it('标识也能改：换成机器实际自报的那个，旧标识的条目不再存在', () => {
    const registry = seeded()
    const result = applyRegistrationEdit(registry, 'bench', { hostId: 'bench-x', hostTitle: '测试机', address: 'http://192.168.1.20:3081' })
    expect(result.ok).toBe(true)
    expect(registry.list().map(entry => entry.hostId)).toEqual(['bench-x'])
  })

  it('标识改成已存在的：报错，原登记原样保留', () => {
    const registry = seededRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
      { hostId: 'taken', hostTitle: '被占用', address: 'http://192.168.1.21:3081' },
    ])
    const result = applyRegistrationEdit(registry, 'bench', { hostId: 'taken', hostTitle: 'X', address: 'http://192.168.1.20:3081' })
    expect(result.ok).toBe(false)
    expect(registry.list()).toHaveLength(2)
    expect(registry.list().find(entry => entry.hostId === 'bench')).toMatchObject({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' })
  })

  it('编辑成非法地址：报错，且原登记原样保留', () => {
    const registry = seeded()
    const result = applyRegistrationEdit(registry, 'bench', { hostTitle: 'X', address: '不是地址' })
    expect(result.ok).toBe(false)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' })
  })

  it('行在场但没有登记：按新增处理', () => {
    const registry = seededRegistry()
    const result = applyRegistrationEdit(registry, 'beta', { hostTitle: '乙', address: 'http://10.0.0.9:3081' })
    expect(result.ok).toBe(true)
    expect(registry.list().map(entry => entry.hostId)).toEqual(['beta'])
  })
})

describe('主机行合并', () => {
  const presence = (hostId: string, hostTitle: string, self = false) => ({ hostId, hostTitle, lastSeen: 500, self })

  it('登记的名字和地址盖过主机自报的派生名', () => {
    const rows = mergeHostRows([presence('bench', '127-0-0-1-3081-x')], [
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081', createdAt: 0 } satisfies HostRegistration,
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ hostId: 'bench', name: '测试机', online: true, address: 'http://192.168.1.20:3081' })
  })

  it('只在登记簿里的主机也有一行：未连接，无心跳', () => {
    const rows = mergeHostRows([presence('self', '本机', true)], [
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081', createdAt: 0 } satisfies HostRegistration,
    ])
    expect(rows.map(row => row.hostId)).toEqual(['self', 'bench'])
    expect(rows[1]).toMatchObject({ name: '测试机', online: false })
    expect(rows[1]?.lastSeen).toBeUndefined()
  })

  it('本机永远排第一，其余按 id 稳定排序', () => {
    const rows = mergeHostRows([presence('zeta', 'Z'), presence('alpha', 'A'), presence('self', '本机', true)], [])
    expect(rows.map(row => row.hostId)).toEqual(['self', 'alpha', 'zeta'])
  })

  it('两处都没有名字时以主机标识兜底', () => {
    const rows = mergeHostRows([presence('beta', '')], [])
    expect(rows[0]?.name).toBe('beta')
  })
})

describe('心跳措辞', () => {
  it('按久暂选词：刚刚、秒、分、时', () => {
    const now = 1_000_000
    expect(heartbeatWord(now, now)).toBe('刚刚')
    expect(heartbeatWord(now - 5_000, now)).toBe('5 秒前')
    expect(heartbeatWord(now - 120_000, now)).toBe('2 分钟前')
    expect(heartbeatWord(now - 7_200_000, now)).toBe('2 小时前')
  })
})
