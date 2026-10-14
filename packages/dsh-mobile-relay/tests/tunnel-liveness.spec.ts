/**
 * 评审修复的回归用例：每条钉住一个「修之前会红」的退化。
 *
 * 这一组四条都是可用性相关的（都在「某台机器坏掉时会发生什么」上），所以
 * 用例名一律从坏法写起，改回来时也一眼看得出它护的是什么。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { TunnelPool } from '../src/tunnels.ts'
import type { RelayMachineConfig } from '../src/index.ts'

const ALIAS = 'threadharbor-d8ca9aefebfeb9c08686b55c'
const PUB_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIE6iU6S9KCZpZ+Grgo2AfY8A3a+KW7ZAYsZQJd1Q4FcF'
const MACHINE: RelayMachineConfig = { hostId: 'mac-a', target: '100.64.0.2', remotePort: 3081, logPath: '/l.log' }

function paths(): { statePath: string; knownHostsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-liveness-'))
  const knownHostsPath = join(dir, 'known_hosts')
  writeFileSync(knownHostsPath, `${ALIAS} ssh-ed25519 ${PUB_BLOB}\n`, 'utf8')
  return { statePath: join(dir, 'state', 'state.json'), knownHostsPath }
}

describe('隧道句柄要验活', () => {
  it('隧道口已经不监听时，第二次 ensure 重建而不是拿缓存交差', async () => {
    // 机器「黑洞型失联」的真实形状：ssh 起手 350ms 没报错就算成功进缓存，
    // 十几秒后才退。此时本地口没人听——如果直接拿缓存交差，这台机器会永远
    // 显示「可达但没在跑」，除非重启中转进程。
    const { statePath, knownHostsPath } = paths()
    let asked = 0
    const pool = new TunnelPool(statePath, { ensureTunnel: async () => { asked++; return 'endpoint' } }, knownHostsPath)

    const first = await pool.ensure(MACHINE)
    expect(first.ok).toBe(true)
    // 假 SSH 层不会真的监听端口，所以第二次一定验活失败并重建。
    const second = await pool.ensure(MACHINE)

    expect(second.ok).toBe(true)
    expect(asked).toBe(2)
  })

  it('隧道口确实在监听时，第二次 ensure 不重建', async () => {
    // 反向：验活不能把「好好的隧道」也拆了——那会让每拍都重开 SSH。
    const { statePath, knownHostsPath } = paths()
    let asked = 0
    const pool = new TunnelPool(statePath, { ensureTunnel: async () => { asked++; return 'endpoint' } }, knownHostsPath)

    await pool.ensure(MACHINE)
    // 手工把句柄的端口指向一个真的在听的东西（测试进程自己监一个）。
    const server = createServer()
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    }))
    // 直接把「live」这台机的缓存句柄指到那个真在听的端口上，验缓存命中的快路。
    const handles = (pool as unknown as { handles: Map<string, { hostId: string; localPort: number; origin: string }> }).handles
    handles.set('live', { hostId: 'live', localPort: port, origin: `http://127.0.0.1:${port}` })
    const live = await pool.ensure({ ...MACHINE, hostId: 'live' })
    server.close()

    expect(live.ok).toBe(true)
    expect(asked).toBe(1) // 只在第一拍为 mac-a 开过；live 走缓存命中
  })
})
