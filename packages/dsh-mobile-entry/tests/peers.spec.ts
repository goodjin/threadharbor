/**
 * peers 接口：tailnet 机器清单 + 各机 DSH 探测标记。
 *
 * 准入照官方 /api 的写法（无 cookie 401、Host 不可信 403，短体固定，先 admit
 * 后应答）；tailnet 查询复用联邦包的 queryTailscalePeers（测试注入假 run，
 * 不跑真命令）；dsh 探测走模块级可替换的 fetch 注入点（swapProbeFetch）。
 * 探测一台 200 一台悬挂：应答里 dsh 一真一假，总耗时钉死「并发 + 2s 超时」；
 * 查询失败/悬挂折成 200 + error + 空 peers，绝不甩 500。
 */

import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply, type MobileEntryConfig } from '../src/index.ts'
import { PEERS_PATH, registerPeersRoute, swapProbeFetch, type DshProbeFetch } from '../src/peers.ts'
import type { MobileRouteContext } from '../src/static-serve.ts'
import type { TailscaleStatusRun } from '@threadharbor/dsh-host-federation/tailscale'

/** registerPeersRoute / apply 需要的宿主面在单测里拿不到，用最小桩捕获注册调用。 */
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

const FAKE_PEER = { role: 'operator' }

/**
 * fake connection 实现官方 admit 的分支语义（对照 DSH 参考源码
 * packages/client/connection/src/rpc-host.ts：先 Host/Origin 栅栏 → 403，
 * 再会话 cookie → 401，通过给 operator peer）；authorizeIndex 与
 * authenticatedUrl 到达即抛错——peers 路由不该碰令牌交换与铸网址。
 */
function fakePeersConnection(options: { trustedHost?: string } = {}) {
  const calls = { admit: [] as unknown[] }
  const connection = {
    authorizeIndex(): boolean {
      throw new Error('peers 路由不应触发 index 令牌交换')
    },
    admit(request: { headers?: Record<string, string> }) {
      calls.admit.push(request)
      if (options.trustedHost !== undefined && request.headers?.['host'] !== options.trustedHost) {
        return { rejection: 403 as const }
      }
      if ((request.headers?.['cookie'] ?? '') !== 'dsh-session=good') {
        return { rejection: 401 as const }
      }
      return { peer: FAKE_PEER }
    },
    authenticatedUrl(_baseUrl: string): string {
      throw new Error('peers 路由不应铸造带令牌网址')
    },
  }
  return { calls, connection }
}

/** 跑一遍 apply，捕获挂上的全部路由（wiring 层：peers 由 apply 注册）。 */
function captureAppliedRoutes(config: MobileEntryConfig | undefined) {
  const routes: CapturedRoute[] = []
  const { calls, connection } = fakePeersConnection()
  const ctx = {
    effect(factory: () => unknown, _label?: string) {
      factory()
    },
    webServer: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {}
      },
    },
    connection,
  }
  apply(ctx as unknown as MobileRouteContext, config)
  return { routes, calls }
}

/** 直接注册 peers 路由（行为层：可注入假 run），取回 handler 与 admit 调用记录。 */
function peersRig(options: { run?: TailscaleStatusRun; trustedHost?: string } = {}) {
  const routes: CapturedRoute[] = []
  // exactOptionalPropertyTypes：缺省就不写这个键，不显式塞 undefined。
  const { calls, connection } = fakePeersConnection(options.trustedHost === undefined ? {} : { trustedHost: options.trustedHost })
  const ctx = {
    effect(factory: () => unknown, _label?: string) {
      factory()
    },
    webServer: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {}
      },
    },
    connection,
  }
  registerPeersRoute(ctx as unknown as MobileRouteContext, options.run === undefined ? {} : { run: options.run })
  const handler = routes.find(route => route.path === PEERS_PATH)?.handler
  if (handler === undefined) throw new Error('peers 路由未挂上')
  return { handler, calls }
}

/** 直接 await handler，收下它对响应生命周期的完整处置。 */
async function callAsync(
  handler: RouteHandler,
  req: { method?: string; url?: string; headers?: Record<string, string> },
) {
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

/** 一份真实形状的 tailscale status --json 输出：Peer 两台，一台在线一台离线。 */
function statusStdout(): string {
  return JSON.stringify({
    BackendState: 'Running',
    Peer: {
      'nodekey:alive': { DNSName: 'alive.tail-scale.ts.net.', TailscaleIPs: ['100.64.0.11'], Online: true },
      'nodekey:dead': { DNSName: 'dead.tail-scale.ts.net.', TailscaleIPs: ['100.64.0.12'], Online: false },
    },
  })
}

/** 假 run：返回给定 stdout，顺手记录跑过的命令（应是 tailscale status --json）。 */
function fakeRun(stdout: string, log?: string[]): TailscaleStatusRun {
  return async (file, args) => {
    log?.push(`${file} ${args.join(' ')}`)
    return { stdout }
  }
}

/** 假探测：按主机名编程应答器；未编程的主机一律拒绝，调用只登记 URL。 */
function fakeProbe(handlers: Record<string, () => Promise<{ status: number }>>) {
  const urls: string[] = []
  const probe: DshProbeFetch = async url => {
    urls.push(url)
    const handler = handlers[new URL(url).hostname]
    if (handler === undefined) throw new Error(`意外探测：${url}`)
    return await handler()
  }
  return { probe, urls }
}

const HELLO_OF = (dnsName: string): string => `https://${dnsName}/threadharbor/mobile/hello`

/** 应答器积木：立刻成功 / 立刻给指定状态码 / 立刻拒绝 / 延迟后 200 / 永不回来。 */
const ok200 = (): Promise<{ status: number }> => Promise.resolve({ status: 200 })
const statusOf = (status: number) => (): Promise<{ status: number }> => Promise.resolve({ status })
const rejects = (): (() => Promise<{ status: number }>) => () => Promise.reject(new Error('connection refused'))
const delay200 = (ms: number) => (): Promise<{ status: number }> =>
  new Promise(resolve => { setTimeout(() => resolve({ status: 200 }), ms) })
const hangs = (): Promise<{ status: number }> => new Promise(() => {})

type PeersBody = { peers: { dnsName: string; online: boolean; dsh: boolean }[]; error?: string }

const ADMITTED_HEADERS = { host: 'desktop.example.net', cookie: 'dsh-session=good' }

describe('peers 路由（先 admit，后应答）', () => {
  it('apply 挂 exact 路由，路径与常量一致', () => {
    const { routes } = captureAppliedRoutes({})
    expect(routes.find(route => route.path === PEERS_PATH)?.kind).toBe('exact')
    expect(PEERS_PATH).toBe('/threadharbor/mobile/peers')
  })

  it('无 cookie → 401 短体 unauthorized（官方写法）；admit 收到原始请求，查询与探测都不该被碰', async () => {
    const boom: TailscaleStatusRun = async () => {
      throw new Error('401 之后不该查询 tailscale')
    }
    const { probe, urls } = fakeProbe({})
    swapProbeFetch(probe)
    const { handler, calls } = peersRig({ run: boom })
    const req = { method: 'GET', url: PEERS_PATH, headers: { host: 'desktop.example.net' } }
    const state = await callAsync(handler, req)
    expect(state.status).toBe(401)
    expect(state.body).toBe('unauthorized')
    expect(calls.admit).toHaveLength(1)
    expect(calls.admit[0]).toBe(req)
    expect(urls).toEqual([])
  })

  it('Host 不可信 → 403 短体 forbidden', async () => {
    const { handler } = peersRig({ trustedHost: 'real-host.example.net' })
    const state = await callAsync(handler, {
      method: 'GET',
      url: PEERS_PATH,
      headers: { host: 'evil.example.net', cookie: 'dsh-session=good' },
    })
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
  })

  it('已准入的非 GET → 405', async () => {
    const { handler } = peersRig({})
    const state = await callAsync(handler, { method: 'POST', url: PEERS_PATH, headers: ADMITTED_HEADERS })
    expect(state.status).toBe(405)
    expect(state.headers['allow']).toBe('GET')
  })
})

describe('peers 应答：tailnet 清单 + dsh 并发探测', () => {
  it('注入 run → 两台 peer 各带 dsh；一台 200 一台悬挂，总耗时不落到串行（并发 + 2s 超时）', async () => {
    const commands: string[] = []
    const { probe, urls } = fakeProbe({
      'alive.tail-scale.ts.net': delay200(300),
      'dead.tail-scale.ts.net': hangs,
    })
    swapProbeFetch(probe)
    const { handler } = peersRig({ run: fakeRun(statusStdout(), commands) })
    const startedAt = Date.now()
    const state = await callAsync(handler, { method: 'GET', url: PEERS_PATH, headers: ADMITTED_HEADERS })
    const elapsed = Date.now() - startedAt

    expect(state.status).toBe(200)
    expect(state.headers['content-type']).toBe('application/json')
    expect(state.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(state.body) as PeersBody
    expect(body.error).toBeUndefined()
    expect(body.peers).toEqual([
      { dnsName: 'alive.tail-scale.ts.net', online: true, dsh: true },
      { dnsName: 'dead.tail-scale.ts.net', online: false, dsh: false },
    ])
    // 查询复用联邦包：跑的就是 tailscale status --json。
    expect(commands).toEqual(['tailscale status --json'])
    // 探测打的是各机的 hello 标记。
    expect([...urls].sort()).toEqual(
      [HELLO_OF('alive.tail-scale.ts.net'), HELLO_OF('dead.tail-scale.ts.net')].sort(),
    )
    // 并发钉死：悬挂那台 2s 超时封顶 ≈ 2000ms；若串行则至少 300 + 2000 = 2300ms。
    expect(elapsed).toBeGreaterThanOrEqual(1950)
    expect(elapsed).toBeLessThan(2300)
  }, 15_000)

  it('run 抛错（tailscale 缺失）→ 200 + 非空 error + 空 peers，且不做任何探测', async () => {
    const { probe, urls } = fakeProbe({})
    swapProbeFetch(probe)
    const { handler } = peersRig({
      run: async () => {
        throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' })
      },
    })
    const state = await callAsync(handler, { method: 'GET', url: PEERS_PATH, headers: ADMITTED_HEADERS })
    expect(state.status).toBe(200)
    const body = JSON.parse(state.body) as PeersBody
    expect(body.peers).toEqual([])
    expect(body.error).toContain('ENOENT')
    expect(urls).toEqual([])
  })

  it('BackendState 未登录的输出：同样 200 + error 说明 + 空 peers', async () => {
    swapProbeFetch(fakeProbe({}).probe)
    const { handler } = peersRig({ run: fakeRun(JSON.stringify({ BackendState: 'NeedsLogin' })) })
    const state = await callAsync(handler, { method: 'GET', url: PEERS_PATH, headers: ADMITTED_HEADERS })
    expect(state.status).toBe(200)
    const body = JSON.parse(state.body) as PeersBody
    expect(body.peers).toEqual([])
    expect(body.error).toContain('未登录')
  })

  it('探测拒绝或非 200 → dsh:false，应答照常', async () => {
    const { probe } = fakeProbe({
      'angry.tail-scale.ts.net': rejects(),
      'tired.tail-scale.ts.net': statusOf(500),
    })
    swapProbeFetch(probe)
    const { handler } = peersRig({
      run: fakeRun(JSON.stringify({
        Peer: {
          k1: { DNSName: 'angry.tail-scale.ts.net.', TailscaleIPs: ['100.64.0.21'], Online: true },
          k2: { DNSName: 'tired.tail-scale.ts.net.', TailscaleIPs: ['100.64.0.22'], Online: true },
        },
      })),
    })
    const state = await callAsync(handler, { method: 'GET', url: PEERS_PATH, headers: ADMITTED_HEADERS })
    expect(state.status).toBe(200)
    const body = JSON.parse(state.body) as PeersBody
    expect(body.error).toBeUndefined()
    expect(body.peers.map(peer => peer.dsh)).toEqual([false, false])
  })
})

describe('dsh 探测缓存（5s）', () => {
  it('5s 内二次调用不再探测：两次应答一致，每台只探测一次', async () => {
    const { probe, urls } = fakeProbe({
      'alive.tail-scale.ts.net': ok200,
      'dead.tail-scale.ts.net': statusOf(503),
    })
    swapProbeFetch(probe)
    const { handler } = peersRig({ run: fakeRun(statusStdout()) })
    const req = { method: 'GET', url: PEERS_PATH, headers: ADMITTED_HEADERS }
    const first = await callAsync(handler, req)
    const second = await callAsync(handler, req)
    expect(JSON.parse(first.body) as PeersBody).toEqual(JSON.parse(second.body) as PeersBody)
    expect(urls).toHaveLength(2)
    // dsh 值照旧一真一假（503 不算活着）。
    expect((JSON.parse(second.body) as PeersBody).peers.map(peer => peer.dsh)).toEqual([true, false])
  })

  it('缓存过 5s 作废：下一次请求重新探测', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { probe, urls } = fakeProbe({
        'alive.tail-scale.ts.net': ok200,
        'dead.tail-scale.ts.net': statusOf(503),
      })
      swapProbeFetch(probe)
      const { handler } = peersRig({ run: fakeRun(statusStdout()) })
      const req = { method: 'GET', url: PEERS_PATH, headers: ADMITTED_HEADERS }
      await callAsync(handler, req)
      expect(urls).toHaveLength(2)
      vi.setSystemTime(Date.now() + 6000)
      await callAsync(handler, req)
      expect(urls).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('tailscale 查询 3s 超时', () => {
  it('run 悬挂 → 3s 后 200 + 非空 error + 空 peers（接口绝不悬着）', async () => {
    swapProbeFetch(fakeProbe({}).probe)
    const { handler } = peersRig({ run: () => new Promise<{ stdout: string }>(() => {}) })
    const startedAt = Date.now()
    const state = await callAsync(handler, { method: 'GET', url: PEERS_PATH, headers: ADMITTED_HEADERS })
    const elapsed = Date.now() - startedAt
    expect(state.status).toBe(200)
    const body = JSON.parse(state.body) as PeersBody
    expect(body.peers).toEqual([])
    expect((body.error ?? '').length).toBeGreaterThan(0)
    expect(elapsed).toBeGreaterThanOrEqual(2950)
    expect(elapsed).toBeLessThan(4500)
  }, 15_000)
})
