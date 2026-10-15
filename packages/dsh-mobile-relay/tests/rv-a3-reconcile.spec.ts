/**
 * 【评审反向验证用例——验证后删除】
 * 断言：清单每轮之后必须做订阅对账（relay.reconcile）——启动时离线的机器
 * 上线后事件要能自己补上。生产接线（index.ts）从未调用 reconcile。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Relay } from '../src/relay.ts'
import { apply, RELAY_HOSTS_PATH, type MobileRelayConfig, type RelayAssemblyDeps, type RelayRouteContext } from '../src/index.ts'

describe('RV-A3：清单一轮后必须触发订阅对账', () => {
  it('hosts 路由算完清单后 reconcile 被调用', async () => {
    const spy = vi.spyOn(Relay.prototype, 'reconcile')
    const dir = mkdtempSync(join(tmpdir(), 'rv-a3-'))
    writeFileSync(join(dir, 'known_hosts'), '')
    const config: MobileRelayConfig = {
      mobileOrigin: 'https://relay.example.com',
      sshKnownHostsPath: join(dir, 'known_hosts'),
      statePath: join(dir, 'state.json'),
      machines: [{ hostId: 'mac-a', target: '100.64.0.2', remotePort: 3081, logPath: '/l.log' }],
    }
    const routes: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }[] = []
    const ctx = {
      effect(factory: () => unknown) { factory(); return undefined },
      webServer: {
        register(route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) {
          routes.push(route)
          return () => {}
        },
      },
      connection: { admit: () => ({ peer: {} }) },
    } as unknown as RelayRouteContext
    const deps: RelayAssemblyDeps = {
      ssh: {
        ensureTunnel: async () => { throw new Error('机器现在连不上（启动时离线）') },
        readLaunchUrl: async () => undefined,
      },
      tailscalePeers: [{ name: 'mac-a', online: true }],
      probeStatus: 200,
    }
    apply(ctx, config, deps)
    const handler = routes.find(route => route.path === RELAY_HOSTS_PATH)?.handler
    if (handler === undefined) throw new Error('hosts 路由未挂上')
    const res = { writeHead() {}, end() {} }
    await handler({ method: 'GET', headers: { host: 'relay.example.com' } }, res)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
