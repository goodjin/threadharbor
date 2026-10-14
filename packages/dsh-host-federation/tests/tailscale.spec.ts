/**
 * 主机侧的 Tailscale 主机桥。
 *
 * 面板跑在浏览器里，没有执行主机命令的通道；「tailscale status」只能在
 * 提供页面的那台机器上跑。这个入口就是那半边桥：把 peer 清单写进
 * threadharbor-host-store 命名空间的 data 字典（浏览器经 remote.settings
 * 读同一个键），并盯着 refresh 键——面板点「刷新」改它，这里重跑一次。
 *
 * exec + 解析的核心在 queryTailscalePeers：mobile-entry 的 peers 接口与
 * 这座桥共用同一份查询；桥只在它外面包文档写入。命令边界（run：文件 +
 * 参数进、stdout 出）与设置通道（describe/mutate）都是端口，全部的
 * 行为测试都用假件立起来：这里不跑真的 tailscale，也不碰真的设置服务。
 */

import { describe, expect, it } from 'vitest'
import {
  HOST_STORE_ENTRY_ID,
  TAILSCALE_ERROR_KEY,
  TAILSCALE_PEERS_KEY,
  TAILSCALE_REFRESHED_KEY,
  TAILSCALE_REFRESH_KEY,
  parseTailscaleStatus,
  queryTailscalePeers,
  startTailscaleBridge,
} from '../src/tailscale.ts'
import type { TailscaleBridgeDeps, TailscaleSettingsFace, TailscaleStatusRun } from '../src/tailscale.ts'

/** 一份真实形状的 tailscale status --json 片段（字段名照抄真机输出）。 */
function statusFixture(): unknown {
  return {
    BackendState: 'Running',
    Self: {
      DNSName: 'selfbox.tail-scale.ts.net.',
      TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
      Online: true,
    },
    Peer: {
      'nodekey:aaa': {
        DNSName: 'bench.tail-scale.ts.net.',
        TailscaleIPs: ['100.101.1.7', 'fd7a:115c:a1e0::2'],
        Online: true,
      },
      'nodekey:bbb': {
        // MagicDNS 关着的机器：没有 DNSName，退到 HostName。
        HostName: 'labbox',
        TailscaleIPs: ['100.101.2.9'],
        Online: false,
      },
      'nodekey:ccc': {
        DNSName: 'asleep.tail-scale.ts.net.',
        // Online 缺省（旧版输出）按未连接算。
        TailscaleIPs: ['100.101.3.1'],
      },
    },
  }
}

describe('parseTailscaleStatus：把 status JSON 折成 {name, ip, online} 清单', () => {
  it('Self 在前，Peer 按名字排序；DNSName 去掉结尾的点', () => {
    const peers = parseTailscaleStatus(statusFixture())
    expect(peers.map(peer => peer.name)).toEqual([
      'selfbox.tail-scale.ts.net',
      'asleep.tail-scale.ts.net',
      'bench.tail-scale.ts.net',
      'labbox',
    ])
  })

  it('ip 取第一个 100.x 地址，IPv6 不入选', () => {
    const peers = parseTailscaleStatus(statusFixture())
    const bench = peers.find(peer => peer.name === 'bench.tail-scale.ts.net')
    expect(bench?.ip).toBe('100.101.1.7')
  })

  it('online：true 是在线，false 与缺省都是未连接', () => {
    const peers = parseTailscaleStatus(statusFixture())
    expect(peers.find(peer => peer.name.startsWith('bench'))?.online).toBe(true)
    expect(peers.find(peer => peer.name === 'labbox')?.online).toBe(false)
    expect(peers.find(peer => peer.name === 'asleep.tail-scale.ts.net')?.online).toBe(false)
  })

  it('两个 100.x 只取第一个', () => {
    const peers = parseTailscaleStatus({
      Self: { DNSName: 'a.x.', TailscaleIPs: ['100.1.1.1', '100.2.2.2'] },
    })
    expect(peers).toEqual([{ name: 'a.x', ip: '100.1.1.1', online: false }])
  })

  it('没有 DNSName 也没有 HostName 时退用 IP 当名字；连 IP 都没有的条目跳过', () => {
    const peers = parseTailscaleStatus({
      Self: { DNSName: '', TailscaleIPs: [] },
      Peer: {
        k1: { TailscaleIPs: ['100.9.9.9'] },
        k2: { DNSName: 'ghost.x.' },
      },
    })
    expect(peers).toEqual([{ name: '100.9.9.9', ip: '100.9.9.9', online: false }])
  })

  it('非对象输入、缺 Self 与 Peer 都给出空清单，不抛', () => {
    expect(parseTailscaleStatus(undefined)).toEqual([])
    expect(parseTailscaleStatus('nope')).toEqual([])
    expect(parseTailscaleStatus({})).toEqual([])
    expect(parseTailscaleStatus({ Peer: 'not-a-map' })).toEqual([])
  })
})

describe('queryTailscalePeers：命令边界与解析（peers 接口同用这份查询）', () => {
  it('把 stdout 解析成 peers 清单；跑的就是 tailscale status --json', async () => {
    const commands: string[] = []
    const outcome = await queryTailscalePeers(async (file, args) => {
      commands.push(`${file} ${args.join(' ')}`)
      return { stdout: JSON.stringify(statusFixture()) }
    })
    expect(commands).toEqual(['tailscale status --json'])
    expect(outcome.peers.map(peer => peer.name)).toContain('bench.tail-scale.ts.net')
    expect(outcome.error).toBeUndefined()
  })

  it('命令不存在 / 非零退出：空清单 + 带原因（含 stderr）的 error，不抛', async () => {
    const missing = await queryTailscalePeers(async () => {
      throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' })
    })
    expect(missing.peers).toEqual([])
    expect(missing.error).toContain('tailscale')
    expect(missing.error).toContain('ENOENT')

    const failed = await queryTailscalePeers(async () => {
      throw Object.assign(new Error('Command failed: tailscale status --json'), { stderr: 'logged out' })
    })
    expect(failed.peers).toEqual([])
    expect(failed.error).toContain('logged out')
  })

  it('stdout 不是 JSON：空清单 + 带原始输出前一段的 error', async () => {
    const outcome = await queryTailscalePeers(async () => ({ stdout: '这不是 JSON' }))
    expect(outcome.peers).toEqual([])
    expect(outcome.error).toContain('这不是 JSON')
  })

  it('命令成功但 BackendState 是 NeedsLogin：清单照折，error 说「未登录」', async () => {
    // 未登录时 tailscale status --json 照样吐 JSON、照样 exit 0，命令层看不出坏，
    // 只有 BackendState 能告诉消费方「空是因为没登录」，而不是「空是因为没 peer」。
    const outcome = await queryTailscalePeers(async () => ({
      stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: { ID: '' } }),
    }))
    expect(outcome.peers).toEqual([])
    expect(outcome.error).toContain('未登录')
  })
})

/** 假设置通道：describe 按真实服务的形状（直接给描述数组），mutate 就地落账。 */
class FakeSettings implements TailscaleSettingsFace {
  /** ns → (path → value)；unset 记成 undefined。 */
  readonly docs = new Map<string, Map<string, string | undefined>>()
  mutations: { ns: string; ops: readonly { op: string; path: readonly string[]; value?: unknown }[] }[] = []
  /** describe 抛错时的一次性故障注入。 */
  failNextDescribe: string | undefined

  doc(ns: string): Map<string, string | undefined> {
    let doc = this.docs.get(ns)
    if (doc === undefined) {
      doc = new Map()
      this.docs.set(ns, doc)
    }
    return doc
  }

  async describe(): Promise<unknown> {
    if (this.failNextDescribe !== undefined) {
      const message = this.failNextDescribe
      this.failNextDescribe = undefined
      throw new Error(message)
    }
    return [...this.docs.entries()].map(([ns, doc]) => {
      const data: Record<string, string> = {}
      for (const [key, value] of doc) {
        if (value !== undefined) data[key] = value
      }
      return { ns, value: { data } }
    })
  }

  async mutate(ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]): Promise<unknown> {
    this.mutations.push({ ns, ops })
    const doc = this.doc(ns)
    for (const op of ops) {
      const key = op.path[1]
      if (key === undefined) throw new Error(`unexpected op path ${JSON.stringify(op.path)}`)
      doc.set(key, op.op === 'set' ? String(op.value) : undefined)
    }
    return { ns }
  }

  /** 测试读账面：某个键现在的值。 */
  valueOf(ns: string, key: string): string | undefined {
    return this.doc(ns).get(key)
  }
}

/** 桥 + 假件的整套台架：命令桩（run）可编程，事件手动派发。 */
function bench(options: { run: () => Promise<{ stdout: string }> | { stdout: string } }) {
  const settings = new FakeSettings()
  let documentHandler: ((ns: string) => void) | undefined
  const lines: string[] = []
  const deps: TailscaleBridgeDeps = {
    run: async () => await options.run(),
    settings,
    onDocumentUpdated: handler => {
      documentHandler = handler
      return () => {
        documentHandler = undefined
      }
    },
    say: message => { lines.push(message) },
  }
  const bridge = startTailscaleBridge(deps)
  return {
    bridge,
    settings,
    lines,
    updated: (ns: string = HOST_STORE_ENTRY_ID): void => { documentHandler?.(ns) },
    peers: (): string | undefined => settings.valueOf(HOST_STORE_ENTRY_ID, TAILSCALE_PEERS_KEY),
    error: (): string | undefined => settings.valueOf(HOST_STORE_ENTRY_ID, TAILSCALE_ERROR_KEY),
    refreshed: (): string | undefined => settings.valueOf(HOST_STORE_ENTRY_ID, TAILSCALE_REFRESHED_KEY),
  }
}

describe('startTailscaleBridge：启动与按需刷新', () => {
  it('启动即跑一次：把 Self+Peer 写进 data 字典的 peers 键（JSON 串），并清掉 error', async () => {
    const rig = bench({ run: () => ({ stdout: JSON.stringify(statusFixture()) }) })
    await rig.bridge.settled()
    const raw = rig.peers()
    expect(raw).toBeDefined()
    const parsed: unknown = JSON.parse(raw ?? '')
    expect(Array.isArray(parsed)).toBe(true)
    const names = (parsed as { name: string }[]).map(peer => peer.name)
    expect(names).toContain('bench.tail-scale.ts.net')
    expect(rig.error()).toBeUndefined()
  })

  it('命令失败：写空清单 + error 键写明原因（stderr 也带上）；刷新应答键照写（面板轮询它）', async () => {
    const rig = bench({
      run: async () => {
        throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT', stderr: 'logged out' })
      },
    })
    await rig.bridge.settled()
    expect(rig.peers()).toBe('[]')
    expect(rig.error()).toContain('ENOENT')
    expect(rig.error()).toContain('logged out')
    expect(rig.refreshed()).toBe('')
  })

  it('命令成功（exit 0）但 BackendState 是 NeedsLogin：写空清单 + error 键说「未登录」', async () => {
    // 未登录时 tailscale status --json 照样吐 JSON、照样 exit 0，命令层看不出坏，
    // 只有 BackendState 能告诉面板「空是因为没登录」，而不是「空是因为没 peer」。
    const rig = bench({ run: () => ({ stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: { ID: '' } }) }) })
    await rig.bridge.settled()
    expect(rig.peers()).toBe('[]')
    expect(rig.error()).toContain('未登录')
  })

  it('BackendState 是 Stopped：error 键说「已停止」', async () => {
    const rig = bench({ run: () => ({ stdout: JSON.stringify({ BackendState: 'Stopped' }) }) })
    await rig.bridge.settled()
    expect(rig.error()).toContain('已停止')
  })

  it('BackendState 是 Running：不写 error 键（清单就是清单，没有「为什么空」要解释）', async () => {
    const rig = bench({ run: () => ({ stdout: JSON.stringify(statusFixture()) }) })
    await rig.bridge.settled()
    expect(rig.error()).toBeUndefined()
  })

  it('面板改 refresh 键 → 收到 document-updated → 重跑并把新清单写回去', async () => {
    let call = 0
    const rig = bench({
      run: () => (call += 1) === 1 ? { stdout: JSON.stringify(statusFixture()) } : { stdout: JSON.stringify({ Peer: {} }) },
    })
    await rig.bridge.settled()
    expect(JSON.parse(rig.peers() ?? '')).toHaveLength(4)

    rig.settings.doc(HOST_STORE_ENTRY_ID).set(TAILSCALE_REFRESH_KEY, '1770000000000')
    rig.updated()
    await rig.bridge.settled()

    expect(JSON.parse(rig.peers() ?? '')).toHaveLength(0)
    // 应答键 = 消费掉的 refresh 值：面板据此知道这一拍已经跑完。
    expect(rig.refreshed()).toBe('1770000000000')
    expect(rig.error()).toBeUndefined()
  })

  it('自己写的 peers / refreshedAt 又触发 document-updated：refresh 没变就不重跑', async () => {
    const rig = bench({ run: () => ({ stdout: JSON.stringify(statusFixture()) }) })
    await rig.bridge.settled()
    rig.updated()
    await rig.bridge.settled()
    rig.updated()
    await rig.bridge.settled()
    // 真机里 status 每跑一次都有一点开销；重跑循环是这里最坏的副作用。
    expect(JSON.parse(rig.peers() ?? '')).toHaveLength(4)
  })

  it('别的命名空间的 document-updated 不理会', async () => {
    const rig = bench({ run: () => ({ stdout: JSON.stringify(statusFixture()) }) })
    await rig.bridge.settled()
    rig.settings.doc('threadharbor-host-store').set(TAILSCALE_REFRESH_KEY, '1')
    rig.updated('some-other-ns')
    await rig.bridge.settled()
    expect(rig.refreshed()).toBe('')
  })

  it('describe 一开始就坏：说一声，不抛，也不写账', async () => {
    const rig = bench({ run: () => ({ stdout: JSON.stringify(statusFixture()) }) })
    rig.settings.failNextDescribe = 'settings service not started'
    await rig.bridge.settled()
    expect(rig.peers()).toBeUndefined()
    expect(rig.lines.some(line => line.includes('settings service not started'))).toBe(true)
  })

  it('启动时 refresh 键已有值（主机重启期间面板点过刷新）：一并消费掉', async () => {
    const rig = bench({ run: () => ({ stdout: JSON.stringify(statusFixture()) }) })
    rig.settings.doc(HOST_STORE_ENTRY_ID).set(TAILSCALE_REFRESH_KEY, 'old-demand')
    await rig.bridge.settled()
    expect(rig.refreshed()).toBe('old-demand')
  })
})
