/**
 * 【评审反向验证用例——验证后删除】
 * 断言：事件面升级路由必须可随插件卸载（走 ctx.effect / 留 disposer），
 * 否则插件重载时宿主按「重复升级路径」拒绝装载。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, type MobileRelayConfig, type RelayAssemblyDeps, type RelayRouteContext } from '../src/index.ts'

describe('RV-A4：升级路由必须能被卸载（重载不再撞重复登记）', () => {
  it('模拟宿主卸载（跑 effect 的 disposer）后再次 apply 不应撞 duplicate upgrade route', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-a4-'))
    const config: MobileRelayConfig = {
      mobileOrigin: 'https://relay.example.com',
      sshKnownHostsPath: join(dir, 'known_hosts'),
      statePath: join(dir, 'state.json'),
      machines: [{ hostId: 'mac-a', target: '100.64.0.2', remotePort: 3081, logPath: '/l.log' }],
    }
    const deps: RelayAssemblyDeps = {
      ssh: { ensureTunnel: async () => 'x', readLaunchUrl: async () => undefined },
      tailscalePeers: [],
      probeStatus: 404,
    }
    const upgrades = new Map<string, unknown>()
    const disposers: (() => void)[] = []
    const ctx = {
      effect(factory: () => unknown) {
        const result = factory()
        if (typeof result === 'function') disposers.push(result as () => void)
        return result
      },
      webServer: {
        // 真宿主语义（webserver/src/index.ts）：exact 与 prefix 是两张表，
        // 重复检查按表进行；升级路径是第三张表。
        register(route: { kind: 'exact' | 'prefix'; path: string }) {
          const table = route.kind === 'exact' ? exactTable : prefixTable
          if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
          table.set(route.path, route)
          return () => { table.delete(route.path) }
        },
        registerUpgrade(route: { path: string }) {
          if (upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
          upgrades.set(route.path, route)
          return () => { upgrades.delete(route.path) }
        },
      },
      connection: { admit: () => ({ peer: {} }) },
    } as unknown as RelayRouteContext
    const routeTable = new Map<string, unknown>()
    function routesTake(path: string): () => void {
      if (routeTable.has(path)) throw new Error(`webserver: duplicate route "${path}"`)
      routeTable.set(path, path)
      return () => { routeTable.delete(path) }
    }
    // 第一次装载：应该成功。
    expect(() => apply(ctx, config, deps)).not.toThrow()
    // 模拟宿主卸载：跑 effect 里登记的全部 disposer（HTTP 路由因此被回收；
    // 升级路由的 disposer 被 index.ts 丢弃，从来没有进过这份名单）。
    for (const dispose of disposers.splice(0)) dispose()
    // 重载：HTTP 路由已回收，不该有任何重复登记错误。
    expect(() => apply(ctx, config, deps)).not.toThrow()
  })
})
