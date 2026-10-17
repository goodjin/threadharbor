import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import type { SshConnectionConfig } from '@threadharbor/dsh-host-federation/ssh/types'
import { CredentialStore } from '../src/credentials.ts'
import { StateStore } from '../src/state.ts'
import type { RelayMachineConfig } from '../src/index.ts'
import { TunnelPool } from '../src/tunnels.ts'

/**
 * 隧道池用例：本地端口一经分配就固定（落盘持久化）、同实例去重、指纹未登记
 * 不建隧道。测试替身照 credentials.spec.ts 的既有做法：ensureTunnel 由用例传
 * 假件（记录调用次数与入参、按队列应答或抛错），状态文件落 mkdtemp 临时目录；
 * 端口占用场景用真实 listener 模拟「落盘端口被别的进程抢占」。
 *
 * 「重启」在单测里没有进程边界可借，按简报的做法模拟：同 statePath 新建一个
 * TunnelPool 实例（内存去重表为空、只剩盘上账目），即等价于重启后的进程。
 */

const HOST = 'gooddemacbook-pro'
const TARGET = '100.64.0.2'
const MACHINE: RelayMachineConfig = { hostId: HOST, target: TARGET, remotePort: 3081, logPath: '/l.log' }

/**
 * known_hosts 条目的主机别名是 manager.ts `alias()` 的现值快照：
 * `threadharbor-` + sha256(`${target}\0${port}`) 前 24 位十六进制。夹具把
 * 别名逐字写死而不是在用例里重算同一哈希——manager 哪天改了写法，隧道池若
 * 没跟着改，这里的用例会红，两处同步才不会被静默漏掉。
 */
const ALIAS_PORT_22 = 'threadharbor-d8ca9aefebfeb9c08686b55c'
const ALIAS_PORT_2222 = 'threadharbor-f95c55a36b89ad60eca117b4'

/** 临时生成的 ed25519 公钥（私钥已弃）。指纹是 `ssh-keygen -lf - -E sha256` 的实测值。 */
const PUB_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIE6iU6S9KCZpZ+Grgo2AfY8A3a+KW7ZAYsZQJd1Q4FcF'
const PUB_FINGERPRINT = 'SHA256:RUCEMIthVvtseQ3tTxV3xiKGoa6zjxZjkBP9WyeUBsY'

/** 状态文件放临时目录；中间一层目录不预先建，让被测代码自己建。 */
function statePathInTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-tunnels-'))
  return join(dir, 'state', 'state.json')
}

/** known_hosts 夹具：把指纹对应公钥写成 persistKnownHost 的行形状。 */
function knownHostsLine(alias: string): string {
  return `${alias} ssh-ed25519 ${PUB_BLOB}`
}

function knownHostsPathOf(...lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-tunnels-kh-'))
  const path = join(dir, 'known_hosts')
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

/** 两台机器共用同一 target（hostId 与 target 解耦），known_hosts 夹具即可复用。 */
const MACHINE_B: RelayMachineConfig = { hostId: 'host-b', target: TARGET, remotePort: 3082, logPath: '/l.log' }

interface TunnelCall {
  config: SshConnectionConfig
  remotePort: number
  /** opts.localPort 的记录；undefined = 调用方没把落盘端口交给 SSH 层。 */
  localPort?: number
}

/**
 * ensureTunnel 假件：记录调用与入参，按队列应答（Error 项=抛错），队列空了
 * 返回一个与 41100 起的分配段无关的固定 endpoint——端口的权威在隧道池的落
 * 盘分配，句柄端口若是从假件返回值里抄的，下面的用例会当场红。
 */
function ensureTunnelFake(...outcomes: Array<string | Error>): {
  calls: TunnelCall[]
  ensureTunnel: (
    config: SshConnectionConfig,
    remotePort: number,
    opts?: { readonly localPort?: number },
  ) => Promise<string>
} {
  const calls: TunnelCall[] = []
  const ensureTunnel = async (
    config: SshConnectionConfig,
    remotePort: number,
    opts?: { readonly localPort?: number },
  ): Promise<string> => {
    calls.push({ config, remotePort, ...(opts?.localPort === undefined ? {} : { localPort: opts.localPort }) })
    const next = outcomes.shift()
    if (next instanceof Error) throw next
    return next ?? 'http://127.0.0.1:54321'
  }
  return { calls, ensureTunnel }
}

function readTunnelsSection(path: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(path, 'utf8')) as { tunnels: Record<string, unknown> }).tunnels
}

/** 结果收窄：ok:false 的用例里拿 reason/detail 前先断言失败形状。 */
function expectOk(result: Awaited<ReturnType<TunnelPool['ensure']>>): { hostId: string; localPort: number; origin: string } {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`应成功，实际 ${result.reason}：${result.detail}`)
  return result.handle
}

describe('TunnelPool（本地端口固定分配并持久化）', () => {
  it('① 首次 ensure：从 41100 起分配端口、origin 对应、落盘 tunnels 段且不碰凭据段；config 逐字段来自机器配置', async () => {
    const path = statePathInTemp()
    new CredentialStore(path).put({ hostId: HOST, cookie: 'dsh-auth-x=y', obtainedAt: 7 })
    const { calls, ensureTunnel } = ensureTunnelFake()
    const pool = new TunnelPool(path, { ensureTunnel }, knownHostsPathOf(knownHostsLine(ALIAS_PORT_22), 'threadharbor-0000000000000000000000decoy ssh-ed25519 AAAA'))
    const handle = expectOk(await pool.ensure(MACHINE))
    expect(handle.hostId).toBe(HOST)
    expect(handle.localPort).toBeGreaterThanOrEqual(41100)
    expect(handle.origin).toBe(`http://127.0.0.1:${handle.localPort}`)
    expect(readTunnelsSection(path)[HOST]).toEqual({ port: handle.localPort })
    // 隧道落盘不吃掉同文档里的凭据段（两段同住一份 statePath）
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { version: number; credentials: unknown[] }
    expect(doc.version).toBe(1)
    expect(doc.credentials).toHaveLength(1)
    // 拼给 SSH 层的 config：可选字段缺省就不出现，指纹来自 known_hosts 对应条目
    expect(calls).toHaveLength(1)
    expect(calls[0]?.config).toEqual({ target: TARGET, hostKeyFingerprint: PUB_FINGERPRINT })
    expect(calls[0]?.remotePort).toBe(MACHINE.remotePort)
    // 落盘端口必须经 opts.localPort 交给 SSH 层：落盘账目和实际监听口是同
    // 一个号，端口↔凭据绑定才成立（Task 5b）。
    expect(calls[0]?.localPort).toBe(handle.localPort)
  })

  it('② 重启重建（同 statePath 新开 pool）：端口不变；假隧道累计被调 2 次——重建要真把隧道再开起来', async () => {
    const path = statePathInTemp()
    const knownHostsPath = knownHostsPathOf(knownHostsLine(ALIAS_PORT_22))
    const fake = ensureTunnelFake()
    const first = expectOk(await new TunnelPool(path, { ensureTunnel: fake.ensureTunnel }, knownHostsPath).ensure(MACHINE))
    const second = expectOk(await new TunnelPool(path, { ensureTunnel: fake.ensureTunnel }, knownHostsPath).ensure(MACHINE))
    expect(second.localPort).toBe(first.localPort)
    expect(second.origin).toBe(first.origin)
    expect(fake.calls).toHaveLength(2)
    // 重建的两次调用都服从同一个落盘端口——重启后端口不换号正是隧道池存在的意义。
    expect(fake.calls[0]?.localPort).toBe(first.localPort)
    expect(fake.calls[1]?.localPort).toBe(first.localPort)
  })

  it('③ 同实例重复 ensure：隧道口仍在监听时返回同一 handle，不再调用假隧道', async () => {
    // 前提是「口上确实有东西在听」：池子缓存命中时会验活（见 tunnel-liveness.spec.ts），
    // 假隧道不真的监听端口的话，这条用例验的就不是复用而是重建了。
    const path = statePathInTemp()
    const fake = ensureTunnelFake()
    const listeners: { close(): void }[] = []
    const pool = new TunnelPool(
      path,
      {
        ensureTunnel: async (config, remotePort, opts) => {
          const endpoint = await fake.ensureTunnel(config, remotePort, opts)
          const server = createServer()
          await new Promise<void>(resolve => server.listen(opts?.localPort ?? 0, '127.0.0.1', resolve))
          listeners.push(server)
          return endpoint
        },
      },
      knownHostsPathOf(knownHostsLine(ALIAS_PORT_22)),
    )
    const first = expectOk(await pool.ensure(MACHINE))
    const again = expectOk(await pool.ensure(MACHINE))
    for (const server of listeners) server.close()
    expect(again).toBe(first)
    expect(fake.calls).toHaveLength(1)
  })

  it('④ 指纹未登记 → fingerprint-unapproved：不叫隧道、不落盘 tunnels、不动凭据', async () => {
    const path = statePathInTemp()
    new CredentialStore(path).put({ hostId: HOST, cookie: 'dsh-auth-x=y', obtainedAt: 7 })
    const fake = ensureTunnelFake()
    // known_hosts 只有别名对不上的条目（别的机器或手写行），被测机没有登记
    const pool = new TunnelPool(path, { ensureTunnel: fake.ensureTunnel }, knownHostsPathOf('threadharbor-0000000000000000000000decoy ssh-ed25519 AAAA'))
    const result = await pool.ensure(MACHINE)
    expect(result).toMatchObject({ ok: false, reason: 'fingerprint-unapproved' })
    if (!result.ok) expect(result.detail).toContain('指纹')
    expect(fake.calls).toHaveLength(0)
    expect(readTunnelsSection(path)[HOST]).toBeUndefined()
    expect((JSON.parse(readFileSync(path, 'utf8')) as { credentials: unknown[] }).credentials).toHaveLength(1)
  })

  it('known_hosts 文件不存在：一律按未登记处理（不抛、不建隧道）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-tunnels-miss-'))
    const fake = ensureTunnelFake()
    const pool = new TunnelPool(statePathInTemp(), { ensureTunnel: fake.ensureTunnel }, join(dir, '不存在的-known_hosts'))
    const result = await pool.ensure(MACHINE)
    expect(result).toMatchObject({ ok: false, reason: 'fingerprint-unapproved' })
    expect(fake.calls).toHaveLength(0)
  })

  it('落盘端口被别的进程占了 → ssh-failed 且不调隧道、落盘值保留：不静默换端口（换端口=凭据对不上 authority）', async () => {
    const path = statePathInTemp()
    const knownHostsPath = knownHostsPathOf(knownHostsLine(ALIAS_PORT_22))
    const first = expectOk(await new TunnelPool(path, { ensureTunnel: ensureTunnelFake().ensureTunnel }, knownHostsPath).ensure(MACHINE))
    const occupier = createServer()
    await new Promise<void>(resolve => occupier.listen(first.localPort, '127.0.0.1', resolve))
    try {
      const fake = ensureTunnelFake()
      const again = await new TunnelPool(path, { ensureTunnel: fake.ensureTunnel }, knownHostsPath).ensure(MACHINE)
      expect(again.ok).toBe(false)
      if (!again.ok) {
        expect(again.reason).toBe('ssh-failed')
        expect(again.detail).toContain(String(first.localPort))
      }
      expect(fake.calls).toHaveLength(0)
      expect(readTunnelsSection(path)[HOST]).toEqual({ port: first.localPort })
    } finally {
      await new Promise(resolve => occupier.close(() => resolve(undefined)))
    }
  })

  it('开隧道失败（ssh 抛错）→ ssh-failed 带原因；端口分配已先行落盘，换好假件重建拿到同一端口', async () => {
    const path = statePathInTemp()
    const knownHostsPath = knownHostsPathOf(knownHostsLine(ALIAS_PORT_22))
    const bad = ensureTunnelFake(new Error('ssh: connect to host 100.64.0.2 port 22: Operation timed out'))
    const failed = await new TunnelPool(path, { ensureTunnel: bad.ensureTunnel }, knownHostsPath).ensure(MACHINE)
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.reason).toBe('ssh-failed')
      expect(failed.detail).toContain('Operation timed out')
    }
    const persisted = readTunnelsSection(path)[HOST] as { port: number }
    expect(typeof persisted.port).toBe('number')
    const good = ensureTunnelFake()
    const healed = expectOk(await new TunnelPool(path, { ensureTunnel: good.ensureTunnel }, knownHostsPath).ensure(MACHINE))
    expect(healed.localPort).toBe(persisted.port)
    expect(good.calls).toHaveLength(1)
  })

  it('分配新端口时跳过已归属他机的落盘端口（哪怕它此刻空闲）——两台的固定分配不撞车', async () => {
    const path = statePathInTemp()
    const knownHostsPath = knownHostsPathOf(knownHostsLine(ALIAS_PORT_22))
    const first = expectOk(await new TunnelPool(path, { ensureTunnel: ensureTunnelFake().ensureTunnel }, knownHostsPath).ensure(MACHINE))
    const second = expectOk(
      await new TunnelPool(path, { ensureTunnel: ensureTunnelFake().ensureTunnel }, knownHostsPath).ensure(MACHINE_B),
    )
    expect(second.localPort).toBeGreaterThanOrEqual(41100)
    expect(second.localPort).not.toBe(first.localPort)
  })

  it('tunnels 段里的坏条目（port 不是数字）按未分配处理：重新分配并覆盖，不抛', async () => {
    const path = statePathInTemp()
    // 坏条目经 StateStore 播种（生产里数据只会经它落盘；文档级合法、条目级坏）
    new StateStore(path).update(doc => ({ ...doc, tunnels: { ...doc.tunnels, [HOST]: { port: 'junk' } } }))
    const fake = ensureTunnelFake()
    const handle = expectOk(await new TunnelPool(path, { ensureTunnel: fake.ensureTunnel }, knownHostsPathOf(knownHostsLine(ALIAS_PORT_22))).ensure(MACHINE))
    expect(handle.localPort).toBeGreaterThanOrEqual(41100)
    expect(readTunnelsSection(path)[HOST]).toEqual({ port: handle.localPort })
    expect(fake.calls).toHaveLength(1)
  })

  it('closeAll：调用注入的 closeTunnel 一次；之后再 ensure 走重建、端口仍是落盘的那个', async () => {
    const path = statePathInTemp()
    const knownHostsPath = knownHostsPathOf(knownHostsLine(ALIAS_PORT_22))
    let closed = 0
    const closeTunnel = async (): Promise<void> => {
      closed += 1
    }
    const fake = ensureTunnelFake()
    const pool = new TunnelPool(path, { ensureTunnel: fake.ensureTunnel, closeTunnel }, knownHostsPath)
    const first = expectOk(await pool.ensure(MACHINE))
    await pool.closeAll()
    expect(closed).toBe(1)
    const again = expectOk(await pool.ensure(MACHINE))
    expect(again.localPort).toBe(first.localPort)
    expect(fake.calls).toHaveLength(2)
    expect(closed).toBe(1)
  })

  it('机器带 port/user/identityFile：config 逐字段带全，指纹按「target+显式端口」对应的条目取', async () => {
    const path = statePathInTemp()
    const fake = ensureTunnelFake()
    const pool = new TunnelPool(path, { ensureTunnel: fake.ensureTunnel }, knownHostsPathOf(knownHostsLine(ALIAS_PORT_22), knownHostsLine(ALIAS_PORT_2222)))
    const machine: RelayMachineConfig = {
      hostId: HOST,
      target: TARGET,
      port: 2222,
      user: 'hello',
      logPath: '/l.log',
      identityFile: '/home/relay/.ssh/id_ed25519',
      remotePort: 3081,
    }
    expectOk(await pool.ensure(machine))
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.config).toEqual({
      target: TARGET,
      port: 2222,
      user: 'hello',
      identityFile: '/home/relay/.ssh/id_ed25519',
      hostKeyFingerprint: PUB_FINGERPRINT,
    })
    expect(fake.calls[0]?.remotePort).toBe(3081)
  })
})
