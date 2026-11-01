/**
 * Codex 额度接口：凭据读取、上游取数、应答解析与宿主路由。
 *
 * 接口地址、鉴权头与应答形状都是 2026-11-01 对本机真实登录实测的：
 * `GET https://chatgpt.com/backend-api/codex/usage`，Bearer + chatgpt-account-id，
 * `rate_limit.primary_window/secondary_window`（used_percent + limit_window_seconds）
 * 与 `credits.balance`。测试全部走假件，不碰真实凭据与网络。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  fetchCodexUsage,
  parseUsage,
  QUOTA_ROUTE_PATH,
  readCredential,
  registerCodexQuotaRoute,
  swapUsageFetch,
} from '../src/usage-codex.ts'
import type { CodexQuotaContext, CodexUsage } from '../src/usage-codex.ts'

const TOKEN = 'test-codex-oat-token'
const ACCOUNT = 'test-account-id'

/** 2026-11-01 实测应答的形状（Pro 档：只有周主窗，secondary 为 null）。 */
const MEASURED = {
  user_id: 'user-x',
  account_id: ACCOUNT,
  email: 'someone@example.com',
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 91,
      limit_window_seconds: 604_800,
      reset_after_seconds: 273_741,
      reset_at: 1_793_777_853,
    },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  credits: { has_credits: false, unlimited: false, balance: 0 },
  spend_control: { reached: false },
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

function rig(): { ctx: CodexQuotaContext; route: CapturedRoute } {
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
  } as unknown as CodexQuotaContext
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
})

describe('readCredential（凭据读取）', () => {
  it('从 ~/.codex/auth.json 读出 access_token 与 account_id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'))
    try {
      await mkdir(join(home, '.codex'), { recursive: true })
      await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: { access_token: TOKEN, account_id: ACCOUNT },
      }))
      const credential = await readCredential({ home })
      expect(credential).toEqual({ accessToken: TOKEN, accountId: ACCOUNT })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('文件缺失或形状不对都返回 undefined（没登录，胶囊安静地不出现）', async () => {
    expect(await readCredential({ home: join(tmpdir(), 'codex-home-missing-') })).toBeUndefined()
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'))
    try {
      await mkdir(join(home, '.codex'), { recursive: true })
      await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: TOKEN } }))
      expect(await readCredential({ home })).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('parseUsage（应答解析）', () => {
  it('实测应答：Pro 档只有周主窗（604800 秒 → weekly），积分余额 0 不显示', () => {
    const usage = parseUsage(MEASURED)
    expect(usage).toEqual({
      level: 'pro',
      weekly: { kind: 'weekly', percent: 91, windowSeconds: 604_800, resetAt: 1_793_777_853_000 },
    })
  })

  it('5 小时窗（18000 秒）归为 five-hour；次窗存在时带上', () => {
    const usage = parseUsage({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_at: 1_793_000_000 },
        secondary_window: { used_percent: 12, limit_window_seconds: 604_800, reset_at: 1_793_500_000 },
      },
      credits: { has_credits: true, balance: 12.5 },
    })
    expect(usage?.fiveHour).toMatchObject({ kind: 'five-hour', percent: 40 })
    expect(usage?.weekly).toMatchObject({ kind: 'weekly', percent: 12 })
    expect(usage?.credit).toEqual({ balance: 12.5 })
  })

  it('没有主窗口就算不认识，返回 null', () => {
    expect(parseUsage({ rate_limit: { primary_window: null } })).toBeNull()
    expect(parseUsage({})).toBeNull()
    expect(parseUsage(null)).toBeNull()
  })
})

describe('fetchCodexUsage（取数）', () => {
  it('GET usage 地址，带 Bearer 与 chatgpt-account-id，解析实测形状', async () => {
    const seen: { url: string; method: string; headers: Record<string, string> }[] = []
    const usage = await fetchCodexUsage({
      credential: { accessToken: TOKEN, accountId: ACCOUNT },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(input),
          method: String(init?.method),
          headers: init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : { ...(init?.headers as Record<string, string>) },
        })
        return new Response(JSON.stringify(MEASURED), { status: 200 })
      }) as typeof fetch,
    })
    expect(seen).toEqual([{
      url: 'https://chatgpt.com/backend-api/codex/usage',
      method: 'GET',
      headers: expect.objectContaining({
        authorization: `Bearer ${TOKEN}`,
        'chatgpt-account-id': ACCOUNT,
      }),
    }])
    expect(usage?.weekly).toMatchObject({ kind: 'weekly', percent: 91 })
  })

  it('失败抛错且令牌被脱敏', async () => {
    const fetchImpl = (async () => new Response(`denied ${TOKEN}`, { status: 401 })) as typeof fetch
    await expect(fetchCodexUsage({ credential: { accessToken: TOKEN, accountId: ACCOUNT }, fetchImpl })).rejects.toThrow(/401/)
    await expect(fetchCodexUsage({ credential: { accessToken: TOKEN, accountId: ACCOUNT }, fetchImpl }))
      .rejects.toThrow(/^(?![\s\S]*test-codex-oat-token)/)
  })
})

describe('registerCodexQuotaRoute（宿主路由）', () => {
  it('注册 exact 路由在固定路径，成功应答带完整额度', async () => {
    const { route } = rig()
    expect(route).toMatchObject({ kind: 'exact', path: QUOTA_ROUTE_PATH })
    expect(QUOTA_ROUTE_PATH).toBe('/threadharbor/codex/quota')
    swapUsageFetch(async () => ({
      level: 'pro',
      weekly: { kind: 'weekly', percent: 91, windowSeconds: 604_800 },
    }) satisfies CodexUsage)
    const res = await callRoute(route)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, quota: { level: 'pro', weekly: { percent: 91 } } })
  })

  it('取数为 null 或抛错都折成 200 + ok:false，不甩 500；令牌不外泄', async () => {
    const { route } = rig()
    swapUsageFetch(async () => null)
    expect(await callRoute(route)).toMatchObject({ status: 200, body: { ok: false } })
    swapUsageFetch(async () => {
      throw new Error('Codex usage request failed (401): denied [redacted]')
    })
    const res = await callRoute(route)
    expect(res).toMatchObject({ status: 200, body: { ok: false } })
    expect(JSON.stringify(res.body)).not.toContain('oat-secret')
  })

  it('30 秒缓存：连续两问只取一次数', async () => {
    const { route } = rig()
    let fetches = 0
    swapUsageFetch(async () => {
      fetches += 1
      return { weekly: { kind: 'weekly', percent: 91, windowSeconds: 604_800 } }
    })
    await callRoute(route)
    await callRoute(route)
    expect(fetches).toBe(1)
  })
})
