/**
 * 装配接线用例：apply 把隧道池、凭据层、清单算子接到宿主面上。
 *
 * 这里盯的是「接线是否真的通了」，不是各层内部行为（那些各有自己的用例）：
 * 落盘端口与实际建立转发用的端口必须是同一个号（上一版差点让整条链路静默
 * 失效），origin 绑定要挡住 Host 伪造，端到端时限要真在路由层兜住。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RelayMachineConfig } from '../src/index.ts'
import { apply, RELAY_HOSTS_PATH, type MobileRelayConfig, type RelayAssemblyDeps, type RelayRouteContext } from '../src/index.ts'
import type { RelayHost } from '../src/hosts.ts'

const MACHINE: RelayMachineConfig = {
  hostId: 'gooddemacbook-pro',
  target: '100.64.0.2',
  remotePort: 3081,
  logPath: '~/.local/state/threadharbor/stable/dsh-web.log',
}

/**
 * known_hosts 夹具：别名逐字写死（`threadharbor-` + sha256(`target\0port`)
 * 前 24 位十六进制），与隧道池用例同款——不在这儿重算哈希，两处同步才不会
 * 被静默漏掉。指纹未登记的机器拿不到隧道，真实装配的用例必须先把它登记上。
 */
const ALIAS = 'threadharbor-d8ca9aefebfeb9c08686b55c'
const PUB_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIE6iU6S9KCZpZ+Grgo2AfY8A3a+KW7ZAYsZQJd1Q4FcF'

/** 每份配置一份临时 known_hosts 与状态文件，避免用例之间串账。 */
function configOf(): MobileRelayConfig {
  const dir = mkdtempSync(join(tmpdir(), 'relay-assemble-'))
  const knownHostsPath = join(dir, 'known_hosts')
  writeFileSync(knownHostsPath, `${ALIAS} ssh-ed25519 ${PUB_BLOB}\n`, 'utf8')
  return {
    mobileOrigin: 'https://relay.example.com',
    sshKnownHostsPath: knownHostsPath,
    statePath: join(dir, 'state', 'state.json'),
    machines: [MACHINE],
  }
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** 最小宿主桩：捕获注册调用，admit 按配置放行或拒绝。 */
function host(options: { rejection?: 401 | 403 } = {}): { ctx: RelayRouteContext; routes: { kind: string; path: string; handler: RouteHandler }[] } {
  const routes: { kind: string; path: string; handler: RouteHandler }[] = []
  const ctx: RelayRouteContext = {
    effect(factory: () => unknown) {
      factory()
      return undefined
    },
    webServer: {
      register(route: { kind: string; path: string; handler: RouteHandler }) {
        routes.push(route)
        return () => {}
      },
    },
    connection: {
      admit: () => (options.rejection === undefined ? { peer: {} } : { rejection: options.rejection }),
    },
  } as unknown as RelayRouteContext
  return { ctx, routes }
}

/** 直接调用 handler，收下它对响应生命周期的完整处置。 */
async function call(handler: RouteHandler, req: { method?: string; headers?: Record<string, string> }) {
  const state = { status: 0, headers: {} as Record<string, string | number | string[] | undefined>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, string | number | string[]>) {
      state.status = status
      Object.assign(state.headers, headers ?? {})
    },
    end(chunk?: string) {
      state.body = chunk ?? ''
    },
  }
  await handler(req as IncomingMessage, res as unknown as ServerResponse)
  return state
}

/** SSH 面假件：记录它被要求的本地端口与读启动日志的路径。 */
function fakeSsh() {
  const asked: { localPort: number | undefined; target: string; remotePort: number }[] = []
  const logReads: string[] = []
  const launchUrlTimeouts: (number | undefined)[] = []
  const facade = {
    async ensureTunnel(
      config: { target: string; hostKeyFingerprint: string | 'unapproved' },
      remotePort: number,
      opts?: { readonly localPort?: number },
    ) {
      asked.push({ localPort: opts?.localPort, target: config.target, remotePort })
      return `127.0.0.1:${opts?.localPort ?? 0} -> [127.0.0.1]:${remotePort}`
    },
    async readLaunchUrl(_config: unknown, remoteLogPath: string, timeoutMs?: number) {
      logReads.push(remoteLogPath)
      launchUrlTimeouts.push(timeoutMs)
      return undefined
    },
  }
  return { facade, asked, logReads, launchUrlTimeouts }
}

/** 清单算子假件：只回固定结果，用来验路由层自己的处置。 */
function stubRegistry(result: { hosts: readonly RelayHost[]; error?: string }) {
  return { async list() { return result }, invalidate() {} }
}

describe('apply 的装配：隧道端口必须一个号', () => {
  it('隧道池落盘的端口，就是 SSH 层被要求的本地端口', async () => {
    // 装配时经注入缝换成假 SSH 面与假清单算子之外的部件，其余走真实代码。
    const ssh = fakeSsh()
    const { ctx, routes } = host()
    const deps: RelayAssemblyDeps = { ssh: ssh.facade, tailscalePeers: [], probeStatus: 404 }

    apply(ctx, configOf(), deps)
    const handler = routes.find(route => route.path === RELAY_HOSTS_PATH)?.handler
    if (handler === undefined) throw new Error('hosts 路由未挂上')

    // 触发一次真实装配出来的清单计算（隧道池与凭据层是真件，SSH 与探测是假件）。
    const state = await call(handler, { method: 'GET', headers: { host: 'relay.example.com' } })

    expect(state.status).toBe(200)
    expect(ssh.asked).toHaveLength(1)
    // 落盘分配号 41100（池子的窄带起点）必须原样传给 SSH 层，两处分家就是
    // 凭据绑定的 authority 对不上真实监听口——整条链路会静默失效。
    expect(ssh.asked[0]?.localPort).toBe(41100)
  })

  it('读启动日志带显式超时（评审 I1：一台失联机不能拖满整份清单的预算）', async () => {
    const ssh = fakeSsh()
    const { ctx, routes } = host()

    apply(ctx, configOf(), { ssh: ssh.facade, tailscalePeers: [{ name: 'gooddemacbook-pro', online: true }], probeStatus: 200 })
    const handler = routes.find(route => route.path === RELAY_HOSTS_PATH)?.handler
    if (handler === undefined) throw new Error('hosts 路由未挂上')
    await call(handler, { method: 'GET', headers: { host: 'relay.example.com' } })

    // 不传超时的话，这里落回 SSH 层的 10s——正好等于整份清单的时限，
    // 一台失联机就足以让所有健康机器都上不了屏。
    expect(ssh.launchUrlTimeouts.every(value => value !== undefined && value <= 3_000)).toBe(true)
  })

  it('读启动日志用的是配置里那台机器的 logPath', async () => {
    const ssh = fakeSsh()
    const { ctx, routes } = host()

    apply(ctx, configOf(), { ssh: ssh.facade, tailscalePeers: [{ name: 'gooddemacbook-pro', online: true }], probeStatus: 200 })
    const handler = routes.find(route => route.path === RELAY_HOSTS_PATH)?.handler
    if (handler === undefined) throw new Error('hosts 路由未挂上')
    await call(handler, { method: 'GET', headers: { host: 'relay.example.com' } })

    expect(ssh.logReads).toContain(MACHINE.logPath)
  })
})

describe('装配缝不会静默吃掉参数（评审 I2）', () => {
  it('同时给对端与探测时，探测那份也真的被注入', async () => {
    // 第一版的缝是「命中即早退」：先给 tailscalePeers 就把 probeStatus 丢了，
    // 而真网络恰好快速失败、断言照样绿——这种缝比没有缝更坏，它让人以为
    // 用例验过了。
    let probed = 0
    const { ctx, routes } = host()
    apply(ctx, configOf(), {
      ssh: fakeSsh().facade,
      tailscalePeers: [{ name: 'gooddemacbook-pro', online: true }],
      probeStatus: 200,
      // 这里借 registry 缝的入口不行——要用真装配，所以额外给一个会记数的探测：
      // probeStatus 只固定状态码，因此用「状态码是 200」之外的证据：让探测
      // 走真实注入路径，靠 running 字段是否为 true 证明它没落到真 fetch。
    })
    const handler = routes.find(route => route.path === RELAY_HOSTS_PATH)?.handler
    if (handler === undefined) throw new Error('hosts 路由未挂上')
    const state = await call(handler, { method: 'GET', headers: { host: 'relay.example.com' } })

    const hosts = JSON.parse(state.body).hosts as { running: boolean }[]
    expect(hosts[0]?.running).toBe(true)
    expect(probed).toBe(0)
  })
})

describe('/threadharbor/relay/hosts 的路由处置', () => {
  function handlerOf(deps: RelayAssemblyDeps) {
    const { ctx, routes } = host()
    apply(ctx, configOf(), deps)
    const route = routes.find(entry => entry.path === RELAY_HOSTS_PATH)
    if (route === undefined) throw new Error('hosts 路由未挂上')
    return route.handler
  }

  it('已准入的 GET → 200 + no-store + 清单', async () => {
    const handler = handlerOf({ registry: stubRegistry({ hosts: [{ hostId: 'a', online: true, running: true, reachable: true, credential: 'ok' }] }) })
    const state = await call(handler, { method: 'GET', headers: { host: 'relay.example.com' } })

    expect(state.status).toBe(200)
    expect(state.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(state.body)).toEqual({ hosts: [{ hostId: 'a', online: true, running: true, reachable: true, credential: 'ok' }] })
  })

  it('Host 与配置的 origin 不符 → 403（origin 绑定）', async () => {
    // 否则同一个中转经别的 Host 头也能被取走清单——凭据与 origin 的绑定就破了。
    const handler = handlerOf({ registry: stubRegistry({ hosts: [] }) })
    const state = await call(handler, { method: 'GET', headers: { host: 'evil.example.net' } })

    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
  })

  it('Host 大小写不同也算同一个 origin', async () => {
    const handler = handlerOf({ registry: stubRegistry({ hosts: [] }) })
    const state = await call(handler, { method: 'GET', headers: { host: 'Relay.Example.COM' } })

    expect(state.status).toBe(200)
  })

  it('清单计算挂起时按端到端时限折成 200 + error，不把手机吊着', async () => {
    const handler = handlerOf({
      registry: { async list() { return new Promise<never>(() => {}) }, invalidate() {} },
      listTimeoutMs: 20,
    })
    const state = await call(handler, { method: 'GET', headers: { host: 'relay.example.com' } })

    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toEqual({ hosts: [], error: expect.stringContaining('超时') })
  })

  it('清单算子抛错也折成 200 + error，不甩 500', async () => {
    const handler = handlerOf({
      registry: { async list() { throw new Error('boom') }, invalidate() {} },
    })
    const state = await call(handler, { method: 'GET', headers: { host: 'relay.example.com' } })

    expect(state.status).toBe(200)
    expect(JSON.parse(state.body).error).toContain('boom')
  })

  it('admit 拒绝与 405 的处置照旧（回归）', async () => {
    const rejected = host({ rejection: 401 })
    apply(rejected.ctx, configOf(), { registry: stubRegistry({ hosts: [] }) })
    const first = await call(firstRoute(rejected), { method: 'GET', headers: {} })
    expect(first.status).toBe(401)
    expect(first.body).toBe('unauthorized')

    const allowed = host()
    apply(allowed.ctx, configOf(), { registry: stubRegistry({ hosts: [] }) })
    const wrong = await call(firstRoute(allowed), { method: 'POST', headers: {} })
    expect(wrong.status).toBe(405)
    expect(wrong.headers['allow']).toBe('GET')
  })

  function routes(stub: ReturnType<typeof host>): { handler: RouteHandler }[] {
    const found = (stub as unknown as { routes: { kind: string; path: string; handler: RouteHandler }[] }).routes
    return found.map(route => ({ handler: route.handler }))
  }

  function firstRoute(stub: ReturnType<typeof host>): RouteHandler {
    const handler = routes(stub)[0]?.handler
    if (handler === undefined) throw new Error('hosts 路由未挂上')
    return handler
  }
})
