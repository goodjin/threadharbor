/**
 * 「ensureTunnel 指定本地端口」的行为测试（中转隧道池的端口↔凭据绑定前提）。
 *
 * 不连真 SSH：manager 走真的 spawn('ssh')，我们在 PATH 前面放一个假 ssh
 * 可执行件（launch-url.spec.ts 的同款做法）。隧道分支不发远端脚本，假 ssh
 * 收到 argv 后记账并挂住不退——manager 以「350ms 内没退出」判定隧道建立。
 *
 * 脚本按本文件只建一份、账本路径走 TH_FAKE_SSH_LEDGER 环境变量按用例隔离：
 * 实测 macOS 对新写的可执行件首次 exec 有秒级的系统扫描延迟，每个用例各写
 * 一份脚本会让每例都付这笔延迟；共享脚本只有首例付一次。
 *
 * 记账用单一追加式账本（===CALL=== 分段），不用「第 n 次」编号文件：重开
 * 隧道时旧脚本可能被 SIGTERM 在落账之前杀掉，编号会跳号或重号；断言只看
 * 「有没有一条绑着指定端口的新记录」，不依赖记录的先后与完整性。
 * `-O` 多路复用收尾调用不是隧道本体，不记账，避免 stopTunnel 的后台收尾
 * 污染计数。
 *
 * 时序纪律：账本一律限期轮询，不假设读完 endpoint 就已落账；「没有再发
 * ssh」这类否定断言先静置一段宽限期再读账本（被测代码若会多发 ssh，spawn
 * 发生在调用同步路径上，宽限期足以让它的记录落账）。等待真实子进程落账的
 * 用例显式放宽 vitest 用例超时到 15s（默认 5s 不够首例的系统扫描延迟）。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DshSshManager } from '../src/ssh/manager.ts'
import type { SshConnectionConfig } from '../src/ssh/types.ts'

const savedPath = process.env.PATH
const savedLedgerVar = process.env.TH_FAKE_SSH_LEDGER
const roots: string[] = []
let binRoot = ''

beforeAll(async () => {
  binRoot = await mkdtemp(join(tmpdir(), 'threadharbor-tunnel-bin-'))
  const bin = join(binRoot, 'bin')
  await mkdir(bin, { recursive: true })
  const lines = [
    '#!/bin/sh',
    '# 假 ssh：把收到的 argv 追加进 $TH_FAKE_SSH_LEDGER（===CALL=== 分段），然后挂住不退（不退＝manager 认定隧道建立）。',
    '# 账本路径走环境变量而不是内嵌进脚本：脚本整个测试文件只建一份，账本按用例隔离。',
    "# `-O` 是多路复用控制面的收尾调用，不算隧道本体，直接退出不记账。",
    'case " $* " in (*" -O "*) exit 0;; esac',
    '{',
    "  printf '===CALL===\\n'",
    "  printf '%s\\n' \"$@\"",
    '} >> "$TH_FAKE_SSH_LEDGER"',
    'sleep 5',
  ]
  await writeFile(join(bin, 'ssh'), `${lines.join('\n')}\n`, { mode: 0o755 })
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
})

afterEach(async () => {
  process.env.TH_FAKE_SSH_LEDGER = savedLedgerVar
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

afterAll(async () => {
  process.env.PATH = savedPath
  if (binRoot !== '') await rm(binRoot, { recursive: true, force: true })
})

function makeManager(root: string): DshSshManager {
  return new DshSshManager({
    knownHostsPath: join(root, 'known_hosts'),
    connectTimeoutMs: 100,
    installTimeoutMs: 100,
    deploymentChannel: 'test',
    defaultRemoteWebPort: 3081,
  })
}

const config: SshConnectionConfig = { target: 'fake-remote.test', hostKeyFingerprint: 'unapproved' }

/** 每个用例独立的账本：临时目录里一份 invocations.log，挂到假 ssh 读取的环境变量上。 */
async function installLedger(): Promise<{ root: string; ledger: string }> {
  const root = await mkdtemp(join(tmpdir(), 'threadharbor-tunnel-'))
  roots.push(root)
  const ledger = join(root, 'invocations.log')
  process.env.TH_FAKE_SSH_LEDGER = ledger
  return { root, ledger }
}

/** 立即读账本；文件还没落出来时返回空（由调用方决定轮询还是静置）。 */
async function readLedger(ledger: string): Promise<string[][]> {
  let text: string
  try {
    text = await readFile(ledger, 'utf8')
  } catch {
    return []
  }
  return text
    .split('===CALL===')
    .map(record => record.split('\n').filter(line => line !== ''))
    .filter(record => record.length > 0)
}

/** 限期轮询账本直到条件成立；超时把当时的账本带进错误信息里。 */
async function waitForLedger(
  ledger: string,
  accept: (records: string[][]) => boolean,
  what: string,
  deadlineMs = 10_000,
): Promise<string[][]> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const records = await readLedger(ledger)
    if (accept(records)) return records
    if (Date.now() > deadline) {
      throw new Error(`等待假 ssh 记账超时（${what}），账本至今：${JSON.stringify(records)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** 某条记录里 -L 的转发声明（`127.0.0.1:<本地>:127.0.0.1:<远端>`）。 */
function forwardSpecOf(record: string[]): string | undefined {
  return record[record.indexOf('-L') + 1]
}

/** 静置宽限期后读账本；给「不该发生的调用」留出落账时间（见文件头注释）。 */
async function ledgerAfterSettling(ledger: string, graceMs = 2_000): Promise<string[][]> {
  await new Promise(resolve => setTimeout(resolve, graceMs))
  return await readLedger(ledger)
}

describe('DshSshManager.ensureTunnel 指定本地端口', () => {
  it('不传 opts.localPort：沿用自选临时端口，endpoint 与 ssh -L 的本地绑定口一致（旧行为不变）', { timeout: 15_000 }, async () => {
    const { root, ledger } = await installLedger()
    const manager = makeManager(root)
    try {
      const endpoint = await manager.ensureTunnel(config, 3081)
      const records = await waitForLedger(ledger, records => records.length > 0, '第一次调用落账')
      // 旧行为的形状钉在这里：绑定地址是 loopback，本地端口是临时自选的
      // （不预设具体值），endpoint 与 ssh 命令里的同一个口。
      const spec = forwardSpecOf(records[0] ?? [])
      const match = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:3081$/.exec(spec ?? '')
      expect(match, `ssh -L 应为 127.0.0.1:<本地>:127.0.0.1:3081，实际 ${spec}`).not.toBeNull()
      const localPort = Number(match?.[1])
      expect(localPort).toBeGreaterThan(0)
      expect(localPort).toBeLessThanOrEqual(65535)
      expect(endpoint).toBe(`http://127.0.0.1:${localPort}`)
    } finally {
      manager.close()
    }
  })

  it('传 opts.localPort：ssh -L 逐字绑定传入端口，endpoint 同口——落盘端口与实际监听口不再分家', { timeout: 15_000 }, async () => {
    const { root, ledger } = await installLedger()
    const manager = makeManager(root)
    try {
      // 41337 只是个断言用的写死值：假 ssh 不真 bind，无须端口恰好空闲，
      // 反而能证明端口是被服从的而不是被替换的。
      const endpoint = await manager.ensureTunnel(config, 3081, { localPort: 41337 })
      const records = await waitForLedger(
        ledger,
        records => records.some(record => forwardSpecOf(record) === '127.0.0.1:41337:127.0.0.1:3081'),
        '绑 41337 的转发声明落账',
      )
      expect(records).toHaveLength(1)
      expect(endpoint).toBe('http://127.0.0.1:41337')
    } finally {
      manager.close()
    }
  })

  it('已有自选端口的旧隧道时再传 opts.localPort：不复用旧隧道，按指定端口重开', { timeout: 15_000 }, async () => {
    const { root, ledger } = await installLedger()
    const manager = makeManager(root)
    try {
      await manager.ensureTunnel(config, 3081)
      const endpoint = await manager.ensureTunnel(config, 3081, { localPort: 41337 })
      // 第二次调用必须真的发出新的 ssh 并绑到 41337：凭据绑定的 authority
      // 是指定端口，复用旧口等于对着没人监听的地址发请求。旧调用的记录可能
      // 被提前 SIGTERM 掉没落账（见文件头注释），所以只断言「有绑 41337 的
      // 新记录」——这条记录只可能来自第二次调用。
      const records = await waitForLedger(
        ledger,
        records => records.some(record => forwardSpecOf(record) === '127.0.0.1:41337:127.0.0.1:3081'),
        '绑 41337 的新记录落账',
      )
      const spec = forwardSpecOf(records[records.length - 1] ?? [])
      expect(spec).toBe('127.0.0.1:41337:127.0.0.1:3081')
      expect(endpoint).toBe('http://127.0.0.1:41337')
    } finally {
      manager.close()
    }
  })

  it('指定端口与已在跑的隧道同口：复用现有隧道，不再新开 ssh', { timeout: 15_000 }, async () => {
    const { root, ledger } = await installLedger()
    const manager = makeManager(root)
    try {
      const first = await manager.ensureTunnel(config, 3081, { localPort: 41337 })
      const second = await manager.ensureTunnel(config, 3081, { localPort: 41337 })
      expect(second).toBe(first)
      const records = await ledgerAfterSettling(ledger)
      expect(records).toHaveLength(1)
      expect(forwardSpecOf(records[0] ?? [])).toBe('127.0.0.1:41337:127.0.0.1:3081')
    } finally {
      manager.close()
    }
  })

  it('非法本地端口（0、负数、越界、非整数）在调用点即报错，不发 ssh', async () => {
    const { root, ledger } = await installLedger()
    const manager = makeManager(root)
    try {
      // 逐个值为什么必须挡：0 会被 ssh 当「随机分配本地端口」，endpoint 却仍
      // 写 0——恰好是本入口要消灭的静默分家；负数/非整数拼出
      // `127.0.0.1:-5:` 这类畸形转发声明，越界端口 bind 必败，都只会在运行
      // 时深处才炸。统一挡在这一层，错误在调用点当场出现。
      for (const localPort of [0, -1, 65536, 41100.5]) {
        await expect(manager.ensureTunnel(config, 3081, { localPort })).rejects.toThrow(/1-65535/)
      }
      expect(await ledgerAfterSettling(ledger)).toHaveLength(0)
    } finally {
      manager.close()
    }
  })
})
