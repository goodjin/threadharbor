/**
 * zcode 套餐限额接口：宿主侧的转发与缓存。
 *
 * 准入照官方 /api 的写法（先 admit 后应答，拒绝时状态码原样、短体固定）；
 * 取数走模块级可替换的 quota 注入点（swapQuotaFetch），测试不碰真密钥真网络。
 * 成功应答带 30s 缓存（多标签页轮询不打爆上游）；取数失败或应答形状不认识
 * 都折成 200 + ok:false + 原因，绝不甩 500；密钥若混进错误文本必须被脱敏。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { apply, QUOTA_ROUTE_PATH, registerZcodeQuotaRoute, swapQuotaFetch } from '../src/zcode-quota.ts'
import type { ZcodeQuotaContext } from '../src/zcode-quota.ts'
import type { GlmCodingPlanQuota } from '@threadharbor/zcode-acp'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

/** 一次成功取数的标准答案（与真机应答同形）。 */
const QUOTA: GlmCodingPlanQuota = {
  level: 'max',
  fiveHour: { kind: 'five-hour', used: 98, total: 28000, percent: 1, resetAt: 1792150126523 },
  weekly: { kind: 'weekly', used: 66064, total: 140000, percent: 47, resetAt: 1792564552999 },
}

/**
 * fake connection：对照官方 admit 的分支语义——无 cookie 401，Host 不可信 403，
 * 通过则给 peer。authorizeIndex 到达即抛错：这个路由不该碰令牌交换。
 */
function fakeConnection(options: { trustedHost?: string } = {}) {
  const calls = { admit: [] as unknown[] }
  const connection = {
    authorizeIndex(): boolean {
      throw new Error('zcode 配额路由不应触发 index 令牌交换')
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

/** 最小宿主面：effect 立即执行，webServer.register 捕获路由。 */
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
  } as unknown as ZcodeQuotaContext
  return { ctx, routes, calls: admitSource.calls }
}

/** 请进来一次的请求（默认带合法 cookie），收回应答的状态码、头与体。 */
async function callRoute(
  route: CapturedRoute | undefined,
  init: { method?: string; cookie?: string; host?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | number | undefined>; body: unknown }> {
  if (route === undefined) throw new Error('route was not registered')
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

/** 换上计数假取数器；无论成败都换回真件。 */
async function withFakeQuota(run: (count: () => number) => Promise<void>): Promise<void> {
  let count = 0
  swapQuotaFetch(async () => {
    count += 1
    return QUOTA
  })
  try {
    await run(() => count)
  } finally {
    swapQuotaFetch(undefined)
  }
}

describe('apply（wiring 层）', () => {
  it('注册一条 exact 的 /threadharbor/zcode/quota 路由', () => {
    const { ctx, routes } = rig()
    apply(ctx)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'exact', path: QUOTA_ROUTE_PATH })
    expect(QUOTA_ROUTE_PATH).toBe('/threadharbor/zcode/quota')
  })
})

describe('registerZcodeQuotaRoute（行为层）', () => {
  it('准入通过时 200 应答配额 JSON，且走的是注入的取数器', async () => {
    const { ctx, routes } = rig()
    registerZcodeQuotaRoute(ctx)
    await withFakeQuota(async count => {
      const answer = await callRoute(routes[0], { cookie: 'dsh-session=good' })
      expect(answer.status).toBe(200)
      expect(answer.headers['content-type']).toBe('application/json')
      expect(answer.headers['cache-control']).toBe('no-store')
      expect(answer.body).toEqual({ ok: true, quota: QUOTA })
      expect(count()).toBe(1)
    })
  })

  it('无 cookie 401、Host 不可信 403，短体固定，且不碰取数器', async () => {
    const trusted = rig(fakeConnection({ trustedHost: 'trusted.example' }))
    registerZcodeQuotaRoute(trusted.ctx)
    await withFakeQuota(async count => {
      expect(await callRoute(trusted.routes[0], { cookie: '', host: 'trusted.example' })).toMatchObject({ status: 401, body: 'unauthorized' })
      expect(await callRoute(trusted.routes[0], { cookie: 'dsh-session=good', host: 'evil.example' })).toMatchObject({ status: 403, body: 'forbidden' })
      expect(count()).toBe(0)
    })
  })

  it('非 GET 一律 405，并说明只允许 GET', async () => {
    const { ctx, routes } = rig()
    registerZcodeQuotaRoute(ctx)
    await withFakeQuota(async count => {
      expect(await callRoute(routes[0], { method: 'POST', cookie: 'dsh-session=good' })).toMatchObject({ status: 405, body: 'method not allowed' })
      expect(count()).toBe(0)
    })
  })

  it('缓存期内重复请求吃缓存：取数器只被叫一次', async () => {
    const { ctx, routes } = rig()
    registerZcodeQuotaRoute(ctx)
    await withFakeQuota(async count => {
      await callRoute(routes[0], { cookie: 'dsh-session=good' })
      await callRoute(routes[0], { cookie: 'dsh-session=good' })
      await callRoute(routes[0], { cookie: 'dsh-session=good' })
      expect(count()).toBe(1)
    })
  })

  it('TTL 归零后缓存过期，下一次请求重新取数', async () => {
    const { ctx, routes } = rig()
    registerZcodeQuotaRoute(ctx, { ttlMs: 0 })
    await withFakeQuota(async count => {
      await callRoute(routes[0], { cookie: 'dsh-session=good' })
      await callRoute(routes[0], { cookie: 'dsh-session=good' })
      expect(count()).toBe(2)
    })
  })

  it('取数抛错折成 200 + ok:false + 原因（错误到这一层已被 quota 模块脱敏）', async () => {
    const { ctx, routes } = rig()
    registerZcodeQuotaRoute(ctx)
    swapQuotaFetch(async () => {
      throw new Error('GLM quota request failed (401): bad [redacted]')
    })
    try {
      const answer = await callRoute(routes[0], { cookie: 'dsh-session=good' })
      expect(answer.status).toBe(200)
      expect(answer.body).toMatchObject({ ok: false })
      expect(JSON.stringify(answer.body)).toContain('GLM quota request failed (401)')
      expect(JSON.stringify(answer.body)).not.toContain('local-login-key')
    } finally {
      swapQuotaFetch(undefined)
    }
  })

  it('应答形状不认识（null）也是 200 + ok:false + 明说原因', async () => {
    const { ctx, routes } = rig()
    registerZcodeQuotaRoute(ctx)
    swapQuotaFetch(async () => null)
    try {
      const answer = await callRoute(routes[0], { cookie: 'dsh-session=good' })
      expect(answer.status).toBe(200)
      expect(answer.body).toMatchObject({ ok: false })
      expect(JSON.stringify(answer.body)).toContain('unrecognised')
    } finally {
      swapQuotaFetch(undefined)
    }
  })

  it('默认取数带超时信号：上游挂住时这一路不会无限等', async () => {
    // 审计补漏（2026-10-16）：网关层的期限改成了无活动期限，这个转发口原先
    // 什么都不带——上游挂住则接口跟着挂。默认取数必须自带超时信号。
    const real = globalThis.fetch
    const seen: Array<{ signal?: AbortSignal }> = []
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      seen.push(init?.signal === undefined ? {} : { signal: init.signal })
      return new Response(JSON.stringify({
        code: 200,
        success: true,
        data: { level: 'max', limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, currentValue: 1, usage: 100, percentage: 1, nextResetTime: 1792150126523 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, currentValue: 1, usage: 100, percentage: 1, nextResetTime: 1792564552999 },
        ] },
      }), { status: 200 })
    }) as typeof fetch
    try {
      const { defaultQuotaFetch, QUOTA_UPSTREAM_TIMEOUT_MS } = await import('../src/zcode-quota.ts')
      expect(QUOTA_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0)
      const answer = await defaultQuotaFetch()
      expect(seen).toHaveLength(1)
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
      expect(answer?.fiveHour?.kind).toBe('five-hour')
    } finally {
      globalThis.fetch = real
    }
  })
})
