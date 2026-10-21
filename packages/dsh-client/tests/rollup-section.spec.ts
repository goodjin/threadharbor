/**
 * The section behind the first card: identity, presence, heartbeat.
 *
 * 2026-10-11 面板改为主机列表后，这个模块只回答三个问题：本机是谁、频道上
 * 有谁、静默多久算走。会话与项目的读取和发布已随该决定移除，这里不再有
 * 与会话相关的路径可测。
 */

import { describe, expect, it, vi } from 'vitest'
import { startRollUpSection } from '../src/rollup-section.ts'
import type { RollUpSectionDeps } from '../src/rollup-section.ts'
import type { FederationBus } from '@threadharbor/dsh-host-federation'
import type { ConfiguredIdentity, IdentitySettings } from '../src/settings-source.ts'
import type { RuntimeT } from '../src/locales.ts'

/** A bus the test can look into and drive, standing in for BroadcastChannel. */
function fakeBus(): FederationBus & {
  posted: { kind: string; hostId: string; hostTitle: string; at: number }[]
  deliver(message: unknown): void
} {
  const listeners = new Set<(message: unknown) => void>()
  const posted: { kind: string; hostId: string; hostTitle: string; at: number }[] = []
  return {
    posted,
    post: message => {
      posted.push(message as { kind: string; hostId: string; hostTitle: string; at: number })
      for (const listener of listeners) listener(message)
    },
    subscribe: listener => { listeners.add(listener) },
    deliver: message => { for (const listener of listeners) listener(message) },
  }
}

/** In-memory identity settings, as storage-backed ones behave. */
function fakeSettings(initial: ConfiguredIdentity = {}): IdentitySettings & { current: ConfiguredIdentity } {
  let current: ConfiguredIdentity = { ...initial }
  return {
    // 活的读数，不是创建时的快照：section 写入之后测试要能看到。
    get current() { return current },
    read: () => ({ ...current }),
    write: value => { current = { ...value } },
  }
}

function setup(overrides: Partial<RollUpSectionDeps> = {}) {
  const bus = fakeBus()
  const ticks: (() => void)[] = []
  const cleared: number[] = []
  const warnings: string[] = []
  let handle = 0
  const settings = fakeSettings({ hostId: 'alpha', hostTitle: 'Alpha' })
  const deps: RollUpSectionDeps = {
    settings,
    bus,
    setInterval: handler => { ticks.push(handler); handle += 1; return handle },
    clearInterval: id => { cleared.push(id) },
    report: message => { warnings.push(message) },
    heartbeatMs: 10_000,
    staleMs: 1_000,
    ...overrides,
  }
  const section = startRollUpSection(deps)
  return { bus, ticks, cleared, warnings, settings, section }
}

describe('主机名单的来源', () => {
  it('一开始只列本机自己', () => {
    const { section } = setup()
    expect(section.hosts().map(host => host.hostId)).toEqual(['alpha'])
    expect(section.hosts()[0]?.self).toBe(true)
    section.dispose()
  })

  it('别的标签页报上来就出现，带它自报的名字', () => {
    const { bus, section } = setup()
    bus.deliver({ kind: 'hello', hostId: 'beta', hostTitle: '测试机', at: 100 })
    expect(section.onlineHostIds()).toContain('beta')
    const beta = section.hosts().find(host => host.hostId === 'beta')
    expect(beta?.hostTitle).toBe('测试机')
    expect(beta?.self).toBe(false)
    section.dispose()
  })

  it('对方说再见就立刻消失', () => {
    const { bus, section } = setup()
    bus.deliver({ kind: 'hello', hostId: 'beta', hostTitle: 'B', at: 100 })
    bus.deliver({ kind: 'bye', hostId: 'beta', hostTitle: 'B', at: 200 })
    expect(section.onlineHostIds()).not.toContain('beta')
    section.dispose()
  })
})

describe('心跳与过期', () => {
  it('定时器到点就发一次心跳', () => {
    const { bus, ticks, section } = setup()
    expect(bus.posted.some(message => message.kind === 'hello')).toBe(true)
    ticks[0]?.()
    expect(bus.posted.some(message => message.kind === 'heartbeat')).toBe(true)
    section.dispose()
  })

  it('静默超过窗口的外来主机在心跳节拍上被剔除，本机不受影响', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { bus, ticks, section } = setup()
      bus.deliver({ kind: 'hello', hostId: 'beta', hostTitle: 'B', at: 0 })
      vi.setSystemTime(1_000)
      ticks[0]?.()
      // 恰好在窗口边缘（1_000 - 0 不大于 1_000）：还留。
      expect(section.onlineHostIds()).toContain('beta')
      vi.setSystemTime(2_500)
      ticks[0]?.()
      expect(section.onlineHostIds()).toEqual(['alpha'])
      section.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 停掉定时器并说再见', () => {
    const { bus, cleared, section } = setup()
    section.dispose()
    expect(cleared).toHaveLength(1)
    expect(bus.posted.at(-1)?.kind).toBe('bye')
  })
})

describe('身份变更', () => {
  it('改 id：旧的先退场，新的再报到', () => {
    const { bus, settings, section } = setup()
    // 换成另一个 id；settings 由 section 写入后再读回。
    section.setIdentity({ hostId: 'gamma' })
    expect(settings.current).toEqual({ hostId: 'gamma' })
    expect(section.identity().hostId).toBe('gamma')
    const kinds = bus.posted.map(message => message.kind)
    // hello（alpha 启动）、bye（alpha 退场）、hello（gamma 报到）
    expect(kinds).toEqual(['hello', 'bye', 'hello'])
    section.dispose()
  })

  it('只改名字不动 id：不退场重报，但在场快照和播报都换新名字', () => {
    // 列表的行读的是在场快照：快照不换名，编辑保存后主行就永远显示旧名字
    // （2026-10-12 用户要求编辑要反映到列表）。换名用一次心跳播报出去，
    // 别的标签页原位改行，不需要 bye/hello 造成的列表闪烁。
    const { bus, section } = setup()
    const before = bus.posted.length
    section.setIdentity({ hostId: 'alpha', hostTitle: '工作室主机' })
    expect(section.identity().hostTitle).toBe('工作室主机')
    expect(section.hosts().find(host => host.self)?.hostTitle).toBe('工作室主机')
    expect(bus.posted.slice(before).map(message => message.kind)).toEqual(['heartbeat'])
    expect(bus.posted.at(-1)?.hostTitle).toBe('工作室主机')
    section.dispose()
  })

  it('身份配置读不出来时按未配置处理，不掉整个名单', () => {
    const warnings: string[] = []
    const broken: IdentitySettings = {
      read: () => { throw new Error('storage gone') },
      write: () => {},
    }
    const { section } = setup({ settings: broken, report: message => { warnings.push(message) } })
    expect(section.hosts()).toHaveLength(1)
    expect(warnings.some(message => message.includes('host settings'))).toBe(true)
    section.dispose()
  })

  it('rereadIdentity：存储在自己脚下变了（水合落地）时重读并换身份', () => {
    // 登记与默认身份搬到主机侧后，身份是在页面打开之后才异步读回来的。
    // 读到之前本机先用页面来源派生的身份在场；水合落地时存储里多出了
    // 配置的身份，section 必须在不写入的前提下重读并换装——id 变了就
    // 旧的退场、新的报到，和 setIdentity 走同一条路。
    const lateSettings = fakeSettings()
    const { bus, section } = setup({ settings: lateSettings })
    // 开场没有配置身份：派生身份在场。
    const derivedId = section.identity().hostId
    expect(section.identity().derived).toBe(true)
    // 模拟水合：存储里出现了这台机器配置的身份（不经 section 写入）。
    lateSettings.current.hostId = 'workstation'
    lateSettings.current.hostTitle = '工作室主机'
    section.rereadIdentity()
    expect(section.identity().hostId).toBe('workstation')
    expect(section.identity().derived).toBe(false)
    const kinds = bus.posted.map(message => message.kind)
    // hello（派生身份启动）、bye（派生身份退场）、hello（配置身份报到）。
    expect(kinds).toEqual(['hello', 'bye', 'hello'])
    expect(derivedId).not.toBe('workstation')
    section.dispose()
  })

  it('subscribe：每次身份重读都通知，退订后不再通知', () => {
    const { section } = setup()
    const seen: string[] = []
    const unsubscribe = section.subscribe(identity => { seen.push(`${identity.hostId}/${identity.hostTitle}`) })
    section.setIdentity({ hostId: 'alpha', hostTitle: '新名字' })
    section.setIdentity({ hostId: 'gamma' })
    // 未配置显示名时按主机名回落到页面来源，id 必须换成 gamma。
    expect(seen[0]).toBe('alpha/新名字')
    expect(seen[1]?.startsWith('gamma/')).toBe(true)
    unsubscribe()
    section.setIdentity({ hostId: 'delta' })
    expect(seen).toHaveLength(2)
    section.dispose()
  })

  it('订阅者抛错只留一条报告，不改身份也不拦别的订阅者', () => {
    const warnings: string[] = []
    const { section } = setup({ report: message => { warnings.push(message) } })
    const seen: string[] = []
    section.subscribe(() => { throw new Error('listener gone') })
    section.subscribe(identity => { seen.push(identity.hostId) })
    section.setIdentity({ hostId: 'gamma' })
    expect(seen).toEqual(['gamma'])
    expect(warnings.some(message => message.includes('identity listener'))).toBe(true)
    section.dispose()
  })
})

/** 一个跟任何词典文案都不同的 `t`：译文即调用痕迹，断言不用猜。 */
const fakeT: RuntimeT = (key, params) =>
  params === undefined ? `[T] ${key}` : `[T] ${key} ${JSON.stringify(params)}`

describe('空会话提示与跨主机说明的文案（盲区串收编）', () => {
  it('给 t 时别的空主机提示与本节说明都被翻译', () => {
    const { bus, section } = setup({ t: fakeT })
    // 一台空会话的外来主机：它的行挂的就是「还没有会话数据」那句。
    bus.deliver({ kind: 'hello', hostId: 'beta', hostTitle: 'B', at: 100 })
    const note = section.element().querySelector('[data-host-note]')
    expect(note?.textContent).toBe(fakeT('panel.rollup.emptySessions'))
    expect(section.notices()).toContain(fakeT('panel.rollup.crossSourceNote'))
    section.dispose()
  })

  it('不给 t 时回落到迁移前的中文原文（逐字节）', () => {
    const { bus, section } = setup()
    bus.deliver({ kind: 'hello', hostId: 'beta', hostTitle: 'B', at: 100 })
    const note = section.element().querySelector('[data-host-note]')
    expect(note?.textContent).toBe('这台主机还没有会话数据——请点「连接」打开远端 DSH，或等待后台拉取。')
    expect(section.notices()).toContain('跨主机说明：页签间的通道只在同源之间通信。同一台 DSH 的多个标签页会互相看见；另一台机器（另一个源）的页面不在这个频道里，要让它出现，请在那里打开它自己的页面。')
    section.dispose()
  })
})
