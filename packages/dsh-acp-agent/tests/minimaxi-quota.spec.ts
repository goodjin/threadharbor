/**
 * MiniMax Token Plan 限额+积分接口：宿主侧的转发与缓存。
 *
 * 与 zcode-quota 同一面：准入照官方 /api 的写法（先 admit 后应答，拒绝时状态码
 * 原样、短体固定）；取数走模块级可替换的 quota 注入点（swapQuotaFetch），测试不
 * 碰真令牌真网络。成功应答带 30s 缓存（多标签页轮询不打爆上游）；取数失败或应答
 * 形状不认识都折成 200 + ok:false + 原因，绝不甩 500；令牌若混进错误文本必须被脱敏。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, QUOTA_ROUTE_PATH, registerMiniMaxQuotaRoute, swapQuotaFetch } from '../src/minimaxi-quota.ts'
import type { MiniMaxQuotaContext } from '../src/minimaxi-quota.ts'
import type { MiniMaxCodingPlanQuota } from '../src/minimaxi/index.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

/** 一次成功取数的标准答案（与真机应答同形）。 */
const QUOTA: MiniMaxCodingPlanQuota = {
  subscribed: true,
  level: 'Max',
  credit: { remaining: 0 },
  fiveHour: { kind: 'five-hour', percent: 13, unlimited: false },
  weekly: { kind: 'weekly', percent: 45, unlimited: false },
}

/** 未订阅的登录：宿主照样应答 ok:true + subscribed:false，浏览器据此不画窗口。 */
const UNSUBSCRIBED: MiniMaxCodingPlanQuota = { subscribed: false }

/**
 * fake connection：对照官方 admit 的分支语义——无 cookie 401，Host 不可信 403，
 * 通过则给 peer。authorizeIndex 到达即抛错：这个路由不该碰令牌交换。
 */
function fakeConnection(options: { trustedHost?: string } = {}) {
  const calls = { admit: [] as unknown[] }
  const connection = {
    authorizeIndex(): boolean {
      throw new Error('minimaxi 配额路由不应触发 index 令牌交换')
    },
    admit(request: { headers?: Record<string, string> }) {
      calls.admit.push(request)
      if (options.trustedHost !== undefined && request.headers?.['host'] !== options.trustedHost) {
        return { rejection: 403 as const }
      }
      if ((request.headers?.['cookie'] ?? '') !== 'dsh-session=good') {
        return { rejection: 401 as const }
      }
      return { peer: { role: 'operator' } }
    },
  }
  return { calls, connection }
}

/** 最小宿主面：effect 立即执行，webServer.register 捕获路由。apply 后取 routes[0]。 */
function rig(admitSource = fakeConnection()) {
  const routes: CapturedRoute[] = []
  const ctx = {
    effect(factory: () => unknown) {
      factory()
      return () => {}
    },
    webServer: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {}
      },
    },
    connection: admitSource.connection,
  } as unknown as MiniMaxQuotaContext
  apply(ctx)
  const route = routes[0]
  if (route === undefined) throw new Error('route was not registered')
  return { ctx, route, calls: admitSource.calls }
}

/** 请进来一次的请求（默认带合法 cookie），收回应答的状态码、头与体。 */
async function callRoute(
  route: CapturedRoute,
  init: { method?: string; cookie?: string; host?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | number | undefined>; body: unknown }> {
  const req = {
    method: init.method ?? 'GET',
    headers: {
      ...(init.host === undefined ? {} : { host: init.host }),
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
  } as IncomingMessage
  const headers: Record<string, string | string[] | number | undefined> = {}
  const res = {
    writeHead(status: number, head?: Record<string, unknown>) {
      headers['#status'] = status
      for (const [key, value] of Object.entries(head ?? {})) headers[key] = value as string
    },
    end(body?: unknown) {
      headers['#body'] = typeof body === 'string' ? body : String(body ?? '')
    },
  } as unknown as ServerResponse
  await route.handler(req, res)
  const body = headers['#body']
  delete headers['#body']
  let parsed: unknown = body
  if (typeof body === 'string' && body !== '') {
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = body
    }
  }
  return { status: headers['#status'] as number, headers, body: parsed }
}

afterEach(() => {
  swapQuotaFetch(undefined)
})

describe('registerMiniMaxQuotaRoute', () => {
  it('装载即注册一条 exact 路由在固定路径', () => {
    const { route } = rig()
    expect(route).toMatchObject({ kind: 'exact', path: QUOTA_ROUTE_PATH })
    expect(QUOTA_ROUTE_PATH).toBe('/threadharbor/minimax/quota')
  })

  it('准入照官方：拒绝时状态码原样、短体固定，不取数', async () => {
    const { calls, route } = rig(fakeConnection({ trustedHost: 'dsh.local' }))
    expect(calls.admit).toHaveLength(0)
    const noCookie = await callRoute(route, { cookie: '', host: 'dsh.local' })
    expect(noCookie.status).toBe(401)
    expect(noCookie.body).toBe('unauthorized')
    const badHost = await callRoute(route, { cookie: 'dsh-session=good', host: 'evil.example' })
    expect(badHost.status).toBe(403)
    expect(badHost.body).toBe('forbidden')
    expect(calls.admit).toHaveLength(2)
  })

  it('非 GET 405，allow 头只放 GET', async () => {
    const { route } = rig()
    const post = await callRoute(route, { method: 'POST', cookie: 'dsh-session=good' })
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET')
  })

  it('成功取数：200 + ok:true + 完整配额（含积分）', async () => {
    swapQuotaFetch(async () => QUOTA)
    const { route } = rig()
    const res = await callRoute(route, { cookie: 'dsh-session=good' })
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({ ok: true, quota: QUOTA })
  })

  it('未订阅的登录也照实回，只是没有窗口', async () => {
    swapQuotaFetch(async () => UNSUBSCRIBED)
    const { route } = rig()
    const res = await callRoute(route, { cookie: 'dsh-session=good' })
    expect(res.body).toEqual({ ok: true, quota: UNSUBSCRIBED })
  })

  it('取数为 null：200 + ok:false + 原因，不甩 500', async () => {
    swapQuotaFetch(async () => null)
    const { route } = rig()
    const res = await callRoute(route, { cookie: 'dsh-session=good' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false })
    expect(String((res.body as { error: string }).error)).toMatch(/unrecognised MiniMax answer/u)
  })

  it('取数抛错折成 200 + ok:false + 原因（错误到这一层已被 quota 模块脱敏）', async () => {
    swapQuotaFetch(async () => {
      throw new Error('MiniMax quota request failed (401): denied [redacted]')
    })
    const { route } = rig()
    const res = await callRoute(route, { cookie: 'dsh-session=good' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false })
    expect(String((res.body as { error: string }).error)).not.toContain('mmoatoken123')
  })

  it('30 秒缓存：连续两问只取一次数', async () => {
    let fetches = 0
    swapQuotaFetch(async () => {
      fetches += 1
      return QUOTA
    })
    const { route } = rig()
    await callRoute(route, { cookie: 'dsh-session=good' })
    await callRoute(route, { cookie: 'dsh-session=good' })
    expect(fetches).toBe(1)
  })

  it('缓存过期后重新取数', async () => {
    const { route, fetches } = rigWithTtl(0, async () => QUOTA)
    await callRoute(route, { cookie: 'dsh-session=good' })
    await callRoute(route, { cookie: 'dsh-session=good' })
    expect(fetches()).toBe(2)
  })

  it('生产取数器带超时信号，向上游透传', async () => {
    swapQuotaFetch(undefined)
    const real = globalThis.fetch
    const seen: { url: string; method: string; signal?: AbortSignal | undefined }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: String(init?.method), signal: init?.signal as AbortSignal | undefined })
      const path = new URL(String(input)).pathname
      if (path === '/v1/api/user/info') {
        return new Response(JSON.stringify({ data: { userInfo: { realUserID: '483260861993279496' } } }), { status: 200 })
      }
      if (path === '/matrix/api/v1/user/get_user_extra_info') {
        return new Response(JSON.stringify({
          workspaces: [{ workspace_id: 0, workspace_type: 0, op_group_id: '1999459129545986565', has_token_plan: true, token_plan_tier: 'Max' }],
          base_resp: { status_code: 0 },
        }), { status: 200 })
      }
      if (path === '/matrix/api/v1/commerce/get_membership_info') {
        return new Response(JSON.stringify({ has_token_plan: true, base_resp: { status_code: 0 } }), { status: 200 })
      }
      return new Response(JSON.stringify({ model_remains: [] }), { status: 200 })
    }) as typeof fetch
    try {
      const { defaultQuotaFetch, QUOTA_UPSTREAM_TIMEOUT_MS } = await import('../src/minimaxi-quota.ts')
      expect(QUOTA_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0)
      await defaultQuotaFetch()
      expect(seen).toHaveLength(4)
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      globalThis.fetch = real
    }
  })
})

/** 一个指定 ttl 的 rig（缓存过期验证用）。fetches 计数经返回的闭包读取。 */
function rigWithTtl(ttlMs: number, quota: () => Promise<MiniMaxCodingPlanQuota>) {
  let fetches = 0
  swapQuotaFetch(async () => {
    fetches += 1
    return quota()
  })
  const routes: CapturedRoute[] = []
  const ctx = {
    effect(factory: () => unknown) {
      factory()
      return () => {}
    },
    webServer: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {}
      },
    },
    connection: fakeConnection().connection,
  } as unknown as MiniMaxQuotaContext
  registerMiniMaxQuotaRoute(ctx, { ttlMs })
  return { route: routes[0] as CapturedRoute, ctx, fetches: () => fetches }
}
