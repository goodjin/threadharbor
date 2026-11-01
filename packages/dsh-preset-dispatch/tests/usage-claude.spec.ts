/**
 * Claude 额度接口：凭据读取（文件 → 钥匙串）、上游取数、429 冷却与宿主路由。
 *
 * 接口与形状按官方 `/usage` 同源只读接口核对（2026-11-01）：
 * `GET https://api.anthropic.com/api/oauth/usage`，Bearer + `anthropic-beta:
 * oauth-2025-04-20`，应答里 `five_hour` / `seven_day`（utilization 0–100 已用、
 * resets_at RFC3339）与 `extra_usage`（按量积分）。该接口自带冷却（问太勤回
 * 429），宿主缓存默认 2 分钟。测试全部走假件，不碰真实凭据与网络。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  fetchClaudeUsage,
  parseUsage,
  QUOTA_ROUTE_PATH,
  registerClaudeQuotaRoute,
  swapKeychainReader,
  swapUsageFetch,
} from '../src/usage-claude.ts'
import type { ClaudeQuotaContext, ClaudeUsage } from '../src/usage-claude.ts'

const TOKEN = 'test-claude-oat-token'

/** 官方 `/usage` 应答的形状（多余的分段桶按 null 处理，解析要跳过它们）。 */
const MEASURED = {
  five_hour: { utilization: 83, resets_at: '2026-06-02T08:30:00.701157+00:00' },
  seven_day: { utilization: 14, resets_at: '2026-06-04T11:00:00.701180+00:00' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

function rig(): { ctx: ClaudeQuotaContext; route: CapturedRoute } {
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
    connection: {
      admit(request: { headers?: Record<string, string> }) {
        if ((request.headers?.['cookie'] ?? '') !== 'dsh-session=good') return { rejection: 401 as const }
        return { peer: { role: 'operator' } }
      },
    },
  } as unknown as ClaudeQuotaContext
  apply(ctx)
  const route = routes[0]
  if (route === undefined) throw new Error('route was not registered')
  return { ctx, route }
}

async function callRoute(route: CapturedRoute): Promise<{ status: number; body: unknown }> {
  const req = { method: 'GET', headers: { cookie: 'dsh-session=good' } } as IncomingMessage
  const headers: Record<string, unknown> = {}
  const res = {
    writeHead(status: number, head?: Record<string, unknown>) {
      headers['#status'] = status
      for (const [key, value] of Object.entries(head ?? {})) headers[key] = value
    },
    end(body?: unknown) {
      headers['#body'] = typeof body === 'string' ? body : String(body ?? '')
    },
  } as unknown as ServerResponse
  await route.handler(req, res)
  const body = headers['#body']
  return { status: headers['#status'] as number, body: typeof body === 'string' && body !== '' ? JSON.parse(body) : body }
}

afterEach(() => {
  swapUsageFetch(undefined)
  swapKeychainReader(undefined)
})

describe('parseUsage（应答解析）', () => {
  it('实测形状：两档窗口 + resets_at；extra_usage 关着不带积分', () => {
    const usage = parseUsage(MEASURED)
    expect(usage?.fiveHour).toMatchObject({ kind: 'five-hour', percent: 83 })
    expect(usage?.weekly).toMatchObject({ kind: 'weekly', percent: 14 })
    expect(usage?.fiveHour?.resetAt).toBe(Date.parse('2026-06-02T08:30:00.701157+00:00'))
    expect(usage?.credit).toBeUndefined()
  })

  it('extra_usage 开着时带按量积分', () => {
    const usage = parseUsage({
      five_hour: { utilization: 1 },
      extra_usage: { is_enabled: true, used_credits: 4.5, monthly_limit: 100 },
    })
    expect(usage?.credit).toEqual({ used: 4.5, limit: 100 })
  })

  it('两档窗口都没有就算不认识，返回 null；utilization 缺失的那档跳过', () => {
    expect(parseUsage({ five_hour: null, seven_day: null })).toBeNull()
    expect(parseUsage({})).toBeNull()
    expect(parseUsage(null)).toBeNull()
    const only = parseUsage({ seven_day: { utilization: 20 } })
    expect(only?.weekly).toMatchObject({ percent: 20 })
    expect(only?.fiveHour).toBeUndefined()
  })
})

describe('fetchClaudeUsage（取数）', () => {
  it('GET oauth usage，带 Bearer 与 anthropic-beta 头，解析实测形状', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const usage = await fetchClaudeUsage({
      credential: { accessToken: TOKEN },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(input),
          headers: init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : { ...(init?.headers as Record<string, string>) },
        })
        return new Response(JSON.stringify(MEASURED), { status: 200 })
      }) as typeof fetch,
    })
    expect(seen).toEqual([{
      url: 'https://api.anthropic.com/api/oauth/usage',
      headers: expect.objectContaining({
        authorization: `Bearer ${TOKEN}`,
        'anthropic-beta': 'oauth-2025-04-20',
      }),
    }])
    expect(usage?.fiveHour).toMatchObject({ percent: 83 })
    expect(usage?.weekly).toMatchObject({ percent: 14 })
  })

  it('失败抛错且令牌被脱敏', async () => {
    const fetchImpl = (async () => new Response(`denied ${TOKEN}`, { status: 401 })) as typeof fetch
    await expect(fetchClaudeUsage({ credential: { accessToken: TOKEN }, fetchImpl })).rejects.toThrow(/401/)
    await expect(fetchClaudeUsage({ credential: { accessToken: TOKEN }, fetchImpl }))
      .rejects.toThrow(/^(?![\s\S]*test-claude-oat-token)/)
  })
})

describe('registerClaudeQuotaRoute（宿主路由）', () => {
  it('注册 exact 路由在固定路径，成功应答带两档窗口', async () => {
    const { route } = rig()
    expect(route).toMatchObject({ kind: 'exact', path: QUOTA_ROUTE_PATH })
    expect(QUOTA_ROUTE_PATH).toBe('/threadharbor/claude/quota')
    swapUsageFetch(async () => ({
      fiveHour: { kind: 'five-hour', percent: 83 },
      weekly: { kind: 'weekly', percent: 14 },
    }) satisfies ClaudeUsage)
    const res = await callRoute(route)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, quota: { fiveHour: { percent: 83 }, weekly: { percent: 14 } } })
  })

  it('取数为 null 或抛错都折成 200 + ok:false，不甩 500', async () => {
    const { route } = rig()
    swapUsageFetch(async () => null)
    expect(await callRoute(route)).toMatchObject({ status: 200, body: { ok: false } })
    swapUsageFetch(async () => {
      throw new Error('Claude usage request failed (401): denied [redacted]')
    })
    const res = await callRoute(route)
    expect(res).toMatchObject({ status: 200, body: { ok: false } })
  })

  it('缓存（默认 2 分钟）：连续两问只取一次数', async () => {
    const { ctx } = rig()
    let fetches = 0
    swapUsageFetch(async () => {
      fetches += 1
      return { fiveHour: { kind: 'five-hour', percent: 1 } }
    })
    const routes: CapturedRoute[] = []
    const probe = {
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
      connection: (ctx as unknown as { connection: unknown }).connection,
    } as unknown as ClaudeQuotaContext
    registerClaudeQuotaRoute(probe)
    const route = routes[0] as CapturedRoute
    const hit = async (): Promise<unknown> => {
      const req = { method: 'GET', headers: { cookie: 'dsh-session=good' } } as IncomingMessage
      let body = ''
      const res = {
        writeHead() { return res },
        end(input?: unknown) { body = String(input ?? '') },
      } as unknown as ServerResponse
      await route.handler(req, res)
      return JSON.parse(body)
    }
    await hit()
    await hit()
    expect(fetches).toBe(1)
  })
})
