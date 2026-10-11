/**
 * The agent panel's pieces, without a browser in the loop.
 *
 * The panel itself is React in DSH's slots; everything that decides what the
 * user sees is plain and tested here. The point of the verdict display is the
 * fork the probe draws on purpose: slow says wait, hung says the agent is not
 * working, unreachable says check the address — showing one where another
 * belongs sends the operator the wrong way.
 *
 * There is no restart button any more. A restart issued from this page is the
 * least reliable thing available exactly when it is needed most — the page is
 * the channel that is hung. The host drops its own dead connections and
 * rebuilds on the next turn; the panel says so instead of offering a button
 * that cannot reach the machine.
 */

import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { describeVerdict } from '../src/verdict.ts'
import { IDENTITY_STORAGE_KEY, IDENTITY_TAB_STORAGE_KEY, layeredIdentitySettings, storageIdentitySettings } from '../src/settings-source.ts'
import { runProbe, AgentPanel, AgentRow, mergeHostRows, heartbeatWord, type ProbeRunState } from '../src/panel.tsx'
import type { AgentListPort, HostRegistryPort } from '../src/panel.tsx'
import type { ProbeOutcome } from '../src/probe.ts'
import type { ProbeVerdict } from '../src/verdict.ts'
import type { RollUpSection } from '../src/rollup-section.ts'
import type { HostRegistration } from '@threadharbor/dsh-host-federation'

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
    // A restart button on this page was the one control that could never work:
    // when the agent is hung, the page is the least reliable channel there is.
    // The advice now points where the truth is — the agent's process and logs.
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

/** An agent list that answers from a fixed snapshot. */
function fakeAgents(list: readonly { presetId: string; label: string }[]): AgentListPort {
  return {
    current: () => list,
    reload: async () => ({ ok: true, value: list }),
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

describe('面板渲染', () => {
  it('每个 agent 一行，带名字和探测按钮，没有重启按钮', () => {
    const rollUp = fakeRollUpSection()
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([{ presetId: 'acp-grok', label: 'Grok' }, { presetId: 'acp-claude', label: 'Claude' }]),
      probe: fakeProbe().probe,
      rollUp,
      registry: fakeRegistry(),
    }))
    expect(html).toContain('data-agent="acp-grok"')
    expect(html).toContain('data-agent="acp-claude"')
    expect(html).toContain('data-action="probe"')
    expect(html).not.toContain('data-action="restart"')
  })

  it('面板上写明自愈策略：主机自动丢弃死连接，下一回合自动重建', () => {
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([]),
      probe: fakeProbe().probe,
      rollUp: fakeRollUpSection(),
      registry: fakeRegistry(),
    }))
    expect(html).toContain('data-self-heal-note')
    expect(html).toContain('自动重连')
  })

  it('agent 列表为空时说明原因，而不是看起来像没配置', () => {
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([]),
      probe: fakeProbe().probe,
      rollUp: fakeRollUpSection(),
      registry: fakeRegistry(),
      agentsNote: '主机目录读不出来：gateway down',
    }))
    expect(html).toContain('主机目录读不出来：gateway down')
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

  it('说明性文字默认折叠：自愈说明收进 details', () => {
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([{ presetId: 'acp-grok', label: 'Grok' }]),
      probe: fakeProbe().probe,
      rollUp: fakeRollUpSection(),
      registry: fakeRegistry(),
    }))
    expect(html).toContain('data-self-heal-note=""')
    expect(html).toContain('<details')
    expect(html).toContain('自动重连')
  })

  it('身份表单收进折叠，头部只留一行身份', () => {
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([]),
      probe: fakeProbe().probe,
      rollUp: fakeRollUpSection(),
      registry: fakeRegistry(),
    }))
    expect(html).toContain('data-identity-line=""')
    expect(html).toContain('本机')
    expect(html).toContain('self')
    expect(html).toContain('按页面来源自动生成')
    expect(html).toContain('data-identity-form=""')
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

describe('主机登记卡', () => {
  it('没有登记时说明这是登记不是连接，并给出入口', () => {
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([]),
      probe: fakeProbe().probe,
      rollUp: fakeRollUpSection(),
      registry: fakeRegistry(),
    }))
    expect(html).toContain('data-registry-posture=""')
    expect(html).toContain('不是建立连接')
    expect(html).toContain('data-registry-empty=""')
    expect(html).toContain('添加一台主机需要什么')
  })

  it('登记一行带身份、地址和如实的状态词', () => {
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([]),
      probe: fakeProbe().probe,
      rollUp: fakeRollUpSection(),
      registry: fakeRegistry([{ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' }]),
    }))
    expect(html).toContain('data-registry-row="bench"')
    expect(html).toContain('http://192.168.1.20:3081')
    expect(html).toContain('data-registry-status="bad"')
    expect(html).toContain('未连接')
    expect(html).toContain('听不到其他源的标签页')
  })

  it('本源在线的登记显示已连接，不再要求测可达', () => {
    const section = { ...fakeRollUpSection(), onlineHostIds: () => ['self', 'bench'] } satisfies RollUpSection
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([]),
      probe: fakeProbe().probe,
      rollUp: section,
      registry: fakeRegistry([{ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' }]),
    }))
    expect(html).toContain('data-registry-status="ok"')
    expect(html).toContain('已连接')
    expect(html).not.toContain('data-registry-reach-try')
  })

  it('本机身份的登记行标为本机', () => {
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([]),
      probe: fakeProbe().probe,
      rollUp: fakeRollUpSection(),
      registry: fakeRegistry([{ hostId: 'self', hostTitle: '本机', address: 'http://127.0.0.1:3081' }]),
    }))
    expect(html).toContain('data-registry-status="ok"')
    expect(html).toContain('这就是当前标签页的身份')
  })

  it('环境前提写在卡里：内网绑定、trusted-host、token、安全代价一个不少', () => {
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([]),
      probe: fakeProbe().probe,
      rollUp: fakeRollUpSection(),
      registry: fakeRegistry(),
    }))
    expect(html).toContain('--trusted-host')
    expect(html).toContain('0.0.0.0')
    expect(html).toContain('token')
    expect(html).toContain('远程代码执行')
    expect(html).toContain('不做脱敏')
    expect(html).toContain('凭证留在主机侧')
  })

  it('删除入口先问后删，确认文案写明只动本机登记', () => {
    const html = renderToString(createElement(AgentPanel, {
      agents: fakeAgents([]),
      probe: fakeProbe().probe,
      rollUp: fakeRollUpSection(),
      registry: fakeRegistry([{ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' }]),
    }))
    expect(html).toContain('data-registry-remove-ask=""')
    // The confirm only appears after the ask; the closed state does not have it.
    expect(html).not.toContain('data-registry-remove-confirm')
  })
})

describe('主机列表卡', () => {
  const renderPanel = (rollUp: RollUpSection, registry: HostRegistryPort): string =>
    renderToString(createElement(AgentPanel, { agents: fakeAgents([]), probe: fakeProbe().probe, rollUp, registry }))

  it('只列主机：名字、id、徽标一行，会话与项目一概不出现', () => {
    // 2026-10-11 用户决定：面板只列主机。三层树（主机 → 项目 → 会话）的任何
    // 痕迹——树容器、项目块、会话行、旧卡名——都必须从这里消失。
    const html = renderPanel(fakeRollUpSection(), fakeRegistry())
    expect(html).toContain('data-panel-section="hosts"')
    expect(html).toContain('data-host-list=""')
    expect(html).toContain('data-host-row="self"')
    expect(html).toContain('data-host-name=""')
    expect(html).toContain('data-host-badge="self"')
    expect(html).not.toContain('data-rollup')
    expect(html).not.toContain('data-project')
    expect(html).not.toContain('data-session')
    expect(html).not.toContain('主机与会话')
  })

  it('频道上在线的外来主机带在线徽标和最近心跳', () => {
    const html = renderPanel(fakeRollUpSection([
      { hostId: 'self', hostTitle: '本机', self: true },
      { hostId: 'beta', hostTitle: '测试机', self: false },
    ]), fakeRegistry())
    expect(html).toContain('data-host-row="beta"')
    expect(html).toContain('data-host-badge="online"')
    expect(html).toContain('data-host-heartbeat')
    expect(html).toContain('最近心跳')
  })

  it('登记过但不在频道上的主机显示未连接，带登记的地址与显示名', () => {
    const html = renderPanel(fakeRollUpSection(), fakeRegistry([
      { hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' },
    ]))
    expect(html).toContain('data-host-row="bench"')
    expect(html).toContain('data-host-badge="offline"')
    expect(html).toContain('data-host-address=""')
    expect(html).toContain('http://192.168.1.20:3081')
    // 未连接的那一行没有心跳可报（本机行有，不在此列）。
    const benchRow = html.slice(html.indexOf('data-host-row="bench"'), html.indexOf('data-host-row="bench"') + 500)
    expect(benchRow).not.toContain('data-host-heartbeat')
  })

  it('头部一眼可见总数与在线数', () => {
    const html = renderPanel(fakeRollUpSection([
      { hostId: 'self', hostTitle: '本机', self: true },
      { hostId: 'beta', hostTitle: 'B', self: false },
    ]), fakeRegistry())
    // React 在文本插值之间插注释节点；比对这些字样先把它们剥掉。
    const text = html.replace(/<!--.*?-->/g, '')
    expect(html).toContain('data-host-count=""')
    expect(text).toContain('共 2 台')
    expect(text).toContain('在线 2 台')
  })

  it('说明收进折叠：另一台机器怎么才会出现在这里', () => {
    const html = renderPanel(fakeRollUpSection(), fakeRegistry())
    expect(html).toContain('<details')
    expect(html).toContain('另一台机器')
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

/**
 * The roll-up section the panel reads from; plain stand-in. 2026-10-11 起它
 * 只供身份、在场名单和在线 id：没有元素、没有说明、没有会话再发布。
 */
function fakeRollUpSection(
  hosts: readonly { hostId: string; hostTitle: string; self: boolean }[] = [{ hostId: 'self', hostTitle: '本机', self: true }],
): RollUpSection {
  return {
    identity: () => ({ hostId: 'self', hostTitle: '本机', derived: true }),
    hosts: () => hosts.map((host, index) => ({ hostId: host.hostId, hostTitle: host.hostTitle, lastSeen: 1000 + index, self: host.self })),
    onlineHostIds: () => hosts.map(host => host.hostId),
    setIdentity: () => {},
    dispose: () => {},
  }
}

/** A registry stand-in for the 主机登记 card. */
function fakeRegistry(entries: readonly { hostId: string; hostTitle: string; address: string }[] = []): HostRegistryPort {
  const list = entries.map(entry => ({ ...entry, createdAt: 0 }))
  return {
    list: () => list,
    add: () => ({ ok: false, error: { kind: 'bad-address', detail: 'stand-in' } }),
    remove: () => true,
  }
}
