/**
 * 主机清单（云主机侧）的用例。
 *
 * 全部用假件注入：假 Tailscale 执行面、假隧道层、假凭据层、假探测 fetch。
 * 断言钉行为（清单内容、字段值、调用次数），不钉命令字符串形状。
 */

import { describe, expect, it, vi } from 'vitest'
import type { TailscaleStatusRun } from '@threadharbor/dsh-host-federation/tailscale'
import { HostRegistry, RELAY_HOSTS_PATH, type HostRegistryDeps } from '../src/hosts.ts'

const MACHINE_A = { hostId: 'mac-a', target: 'mac-a', remotePort: 3081 }
const MACHINE_B = { hostId: 'linux-b', target: 'linux-b', remotePort: 3081 }

/** 假 Tailscale 执行面：stdout 是一份 `tailscale status --json` 样式文本。 */
function runWith(names: readonly string[], offline: readonly string[] = []): TailscaleStatusRun {
  return async (_file, args) => {
    if (args.includes('--peers=false')) return { stdout: '' }
    const entry = (name: string, isOnline: boolean, index: number) => ({
      // 真实 CLI 给的是 MagicDNS 全名（带尾点），不是短名——这里照实模拟。
      DNSName: `${name}.tailb6790d.ts.net.`,
      HostName: name,
      TailscaleIPs: [`100.64.${isOnline ? 0 : 9}.${index + 10}`],
      Online: isOnline,
      Active: isOnline,
      OS: 'linux',
    })
    const peer = Object.fromEntries([
      ...names.map((name, index) => [`peer${index}`, entry(name, true, index)]),
      ...offline.map((name, index) => [`off${index}`, entry(name, false, index + 50)]),
    ])
    return { stdout: JSON.stringify({ BackendState: 'Running', Peer: peer }) }
  }
}

function tunnelsWith(
  outcome: (machine: { hostId: string }) => { ok: true; origin: string } | { ok: false; reason: 'fingerprint-unapproved' | 'ssh-failed'; detail: string },
) {
  const calls: string[] = []
  return {
    calls,
    async ensure(machine: { hostId: string }) {
      calls.push(machine.hostId)
      const result = outcome(machine)
      return result.ok
        ? { ok: true as const, handle: { hostId: machine.hostId, localPort: 41100, origin: result.origin } }
        : result
    },
  }
}

function credentialsWith(outcome: 'ok' | 'missing') {
  const calls: string[] = []
  return {
    calls,
    async resolve(hostId: string) {
      calls.push(hostId)
      return outcome === 'ok' ? { ok: true as const, cookie: 'dsh-auth-fake=canary-value' } : { ok: false as const, reason: 'no-cookie' as const }
    },
  }
}

function probeWith(status: number | ((url: string) => number), onCall?: (url: string) => void) {
  const urls: string[] = []
  const fetch = async (url: string) => {
    urls.push(url)
    onCall?.(url)
    const code = typeof status === 'function' ? status(url) : status
    return { status: code }
  }
  return { urls, fetch }
}

const READ_LAUNCH_URL = async (): Promise<string | undefined> => undefined

function makeRegistry(deps: Partial<HostRegistryDeps> & Pick<HostRegistryDeps, 'machines'>): HostRegistry {
  return new HostRegistry({
    machines: deps.machines,
    tunnels: deps.tunnels ?? tunnelsWith(() => ({ ok: true, origin: 'http://127.0.0.1:41100' })),
    credentials: deps.credentials ?? credentialsWith('ok'),
    readLaunchUrl: deps.readLaunchUrl ?? READ_LAUNCH_URL,
    run: deps.run ?? runWith(['mac-a', 'linux-b']),
    probeFetch: deps.probeFetch ?? probeWith(200).fetch,
  })
}

describe('relay hosts 清单', () => {
  it('只保留配置里登记过的对端', async () => {
    // tailnet 上有 3 个对端，配置只登记 2 台：未登记者不进清单。
    const registry = makeRegistry({
      machines: [MACHINE_A, MACHINE_B],
      run: runWith(['mac-a', 'linux-b', 'nas-c']),
    })

    const result = await registry.list()

    expect(result.hosts.map(host => host.hostId)).toEqual(['mac-a', 'linux-b'])
    expect(result.error).toBeUndefined()
  })

  it('hello 探测 200 才算在跑 DSH', async () => {
    const registry = makeRegistry({
      machines: [MACHINE_A, MACHINE_B],
      probeFetch: probeWith(url => (url.includes('41100') ? 200 : 404)).fetch,
      tunnels: {
        async ensure(machine: { hostId: string }) {
          const port = machine.hostId === 'mac-a' ? 41100 : 41101
          return { ok: true as const, handle: { hostId: machine.hostId, localPort: port, origin: `http://127.0.0.1:${port}` } }
        },
      },
    })

    const { hosts } = await registry.list()

    expect(hosts.find(host => host.hostId === 'mac-a')?.running).toBe(true)
    expect(hosts.find(host => host.hostId === 'linux-b')?.running).toBe(false)
  })

  it('隧道拉不起来时该机既不可达也不在跑', async () => {
    const registry = makeRegistry({
      machines: [MACHINE_A],
      tunnels: tunnelsWith(() => ({ ok: false, reason: 'ssh-failed', detail: 'ssh 退出码 255' })),
    })

    const { hosts } = await registry.list()

    expect(hosts).toEqual([
      { hostId: 'mac-a', online: true, running: false, reachable: false, credential: 'missing' },
    ])
  })

  it('tailscale 查询出错时返回空清单与 error，不抛给调用方', async () => {
    // 联邦层那条查询的合同是「失败不抛」：CLI 自身失败时它就带回 error 字段，
    // 而不是把异常甩出来。两种形态都要在接口层被同一种方式接住。
    const failing: TailscaleStatusRun = async () => {
      throw new Error('tailscale 未安装')
    }
    const registry = makeRegistry({ machines: [MACHINE_A], run: failing })

    const thrown = await registry.list()
    const quiet = await makeRegistry({ machines: [MACHINE_A], run: runWith([], ['mac-a']) }).list()

    expect(thrown.hosts).toEqual([])
    expect(thrown.error).toContain('tailscale')
    expect(quiet.error).toBeUndefined()
    expect(quiet.hosts).toHaveLength(1)
  })

  it('配置用短名时也能对上 tailnet 回的 MagicDNS 全名', async () => {
    // tailnet 回的是 mac-a.tailb6790d.ts.net，配置里写的是 mac-a。
    // 只按全名比对会把所有机器判成「不在 tailnet 上」，在线状态永远假。
    const registry = makeRegistry({ machines: [MACHINE_A], run: runWith(['mac-a']) })

    const { hosts } = await registry.list()

    expect(hosts[0]).toMatchObject({ hostId: 'mac-a', online: true })
  })

  it('tailscale 查询挂起时按 3s 预算折成空清单', async () => {
    const hanging: TailscaleStatusRun = () => new Promise(() => {})
    const registry = makeRegistry({ machines: [MACHINE_A], run: hanging })

    const result = await registry.list()

    expect(result.hosts).toEqual([])
    expect(result.error).toContain('超时')
  }, 10_000)

  it('缓存期内重复取清单不重复打探测', async () => {
    const probe = probeWith(200)
    const registry = makeRegistry({ machines: [MACHINE_A], probeFetch: probe.fetch })

    await registry.list()
    await registry.list()

    expect(probe.urls).toHaveLength(1)
  })

  it('清掉缓存后重新探测', async () => {
    const probe = probeWith(200)
    const registry = makeRegistry({ machines: [MACHINE_A], probeFetch: probe.fetch })

    await registry.list()
    registry.invalidate()
    await registry.list()

    expect(probe.urls).toHaveLength(2)
  })

  it('探测目标是隧道 origin 上的 hello，不是 tailnet 地址', async () => {
    const probe = probeWith(200)
    const registry = makeRegistry({ machines: [MACHINE_A], probeFetch: probe.fetch })

    await registry.list()

    expect(probe.urls).toEqual(['http://127.0.0.1:41100/threadharbor/mobile/hello'])
  })

  it('凭据换不到时标 missing，换到时标 ok', async () => {
    const ok = makeRegistry({ machines: [MACHINE_A], credentials: credentialsWith('ok') })
    const missing = makeRegistry({ machines: [MACHINE_A], credentials: credentialsWith('missing') })

    expect((await ok.list()).hosts[0]?.credential).toBe('ok')
    expect((await missing.list()).hosts[0]?.credential).toBe('missing')
  })

  it('对端离线时 online 为假，但不因此从清单消失', async () => {
    const offline = runWith([], ['linux-b'])
    const registry = makeRegistry({ machines: [MACHINE_B], run: offline })

    const { hosts } = await registry.list()

    expect(hosts).toEqual([
      { hostId: 'linux-b', online: false, running: true, reachable: true, credential: 'ok' },
    ])
  })

  it('一台机器挂了不影响其余机器入列', async () => {
    const registry = makeRegistry({
      machines: [MACHINE_A, MACHINE_B],
      tunnels: tunnelsWith(machine => (machine.hostId === 'mac-a'
        ? { ok: false, reason: 'ssh-failed', detail: '连接超时' }
        : { ok: true, origin: 'http://127.0.0.1:41101' })),
    })

    const { hosts } = await registry.list()

    expect(hosts.map(host => [host.hostId, host.reachable])).toEqual([
      ['mac-a', false],
      ['linux-b', true],
    ])
  })
})

describe('relay hosts 常量', () => {
  it('清单路径是 relay 前缀下的 hosts', () => {
    expect(RELAY_HOSTS_PATH).toBe('/threadharbor/relay/hosts')
  })
})