import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply, Config, type MobileEntryConfig } from '../src/index.ts'
import { PAIR_URL_PATH } from '../src/pair-url.ts'
import type { MobileRouteContext } from '../src/static-serve.ts'

describe('Config 的 mobileOrigin 校验（坏值装载即失败，不静默回退）', () => {
  it('合规 https 源通过校验，字段缺省也通过', () => {
    expect(Config({ mobileOrigin: 'https://mac1.example.ts.net' })).toEqual({
      mobileOrigin: 'https://mac1.example.ts.net',
    })
    expect(Config({})).toEqual({})
  })

  it.each([
    ['http 明文', 'http://mac1.example.ts.net'],
    ['带路径', 'https://mac1.example.ts.net/threadharbor'],
    ['带尾斜杠', 'https://mac1.example.ts.net/'],
    ['带查询', 'https://mac1.example.ts.net/?x=1'],
    ['带碎片', 'https://mac1.example.ts.net/#m'],
    ['非 https 协议', 'ftp://mac1.example.ts.net'],
    ['空 authority', 'https://'],
  ])('%s（%s）配置解析抛错', (_label, value) => {
    expect(() => Config({ mobileOrigin: value })).toThrow()
  })
})

/** registerMobileRoutes / apply 需要的宿主面在单测里拿不到，用最小桩捕获注册调用。 */
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

/**
 * fake connection 实现官方 admit 的分支语义（对照 DSH 参考源码
 * packages/client/connection/src/rpc-host.ts：先 Host/Origin 栅栏 → 403，
 * 再会话 cookie → 401，通过给 operator peer）；authenticatedUrl 按官方
 * browser-auth.ts 语义：保留 authority 与挂载点，把进程令牌追加为查询参数。
 * authorizeIndex 到达即抛错——pair-url 路由不该触发 index 令牌交换。
 */
const FAKE_PEER = { role: 'operator' }

interface PairConnectionOptions {
  trustedHost?: string
  cookie?: string
  launchToken?: string
}

function fakePairConnection(options: PairConnectionOptions) {
  const calls = {
    admit: [] as Array<{ method?: string; url?: string; headers?: Record<string, string> }>,
    authenticatedUrl: [] as string[],
  }
  const connection = {
    authorizeIndex(): boolean {
      throw new Error('pair-url 路由不应触发 index 令牌交换')
    },
    admit(request: { method?: string; url?: string; headers?: Record<string, string> }) {
      calls.admit.push(request)
      if (options.trustedHost !== undefined && request.headers?.['host'] !== options.trustedHost) {
        return { rejection: 403 as const }
      }
      if ((request.headers?.['cookie'] ?? '') !== (options.cookie ?? 'dsh-session=good')) {
        return { rejection: 401 as const }
      }
      return { peer: FAKE_PEER }
    },
    authenticatedUrl(baseUrl: string): string {
      calls.authenticatedUrl.push(baseUrl)
      const url = new URL(baseUrl)
      url.searchParams.set('token', options.launchToken ?? 'launch-token-xyz')
      return url.href
    },
  }
  return { calls, connection }
}

/** 跑一遍 apply，捕获挂上的全部路由与 connection 调用记录。 */
function captureAppliedRoutes(config: MobileEntryConfig | undefined, options: PairConnectionOptions = {}) {
  const routes: CapturedRoute[] = []
  const { calls, connection } = fakePairConnection(options)
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

/** 取 pair-url 那条路由（没挂上就大声失败，让缺挂载在测试里显形）。 */
function pairRouteOf(routes: CapturedRoute[]): RouteHandler {
  const route = routes.find(entry => entry.path === PAIR_URL_PATH)
  if (route === undefined) throw new Error('pair-url 路由未挂上')
  return route.handler
}

/** 直接调用 handler，收下它对响应生命周期的完整处置。 */
function call(handler: RouteHandler, req: { method?: string; url?: string; headers?: Record<string, string> }) {
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
  handler(req as IncomingMessage, res as unknown as ServerResponse)
  return state
}

describe('pair-url 路由（先 admit，后应答）', () => {
  const ORIGIN = 'https://mac1.example.ts.net'
  const ADMITTED_HEADERS = { host: 'mac1.example.ts.net', cookie: 'dsh-session=good' }

  it('挂 exact 路由，路径与常量一致', () => {
    const { routes } = captureAppliedRoutes({ mobileOrigin: ORIGIN })
    expect(routes.find(route => route.path === PAIR_URL_PATH)?.kind).toBe('exact')
    expect(PAIR_URL_PATH).toBe('/threadharbor/mobile/pair-url')
  })

  it('无 cookie → 401 短体 unauthorized（官方写法），admit 收到原始请求', () => {
    const { routes, calls } = captureAppliedRoutes({ mobileOrigin: ORIGIN })
    const req = { method: 'GET', url: PAIR_URL_PATH, headers: { host: 'mac1.example.ts.net' } }
    const state = call(pairRouteOf(routes), req)
    expect(state.status).toBe(401)
    expect(state.body).toBe('unauthorized')
    expect(calls.admit).toHaveLength(1)
    expect(calls.admit[0]).toBe(req)
    expect(calls.authenticatedUrl).toHaveLength(0)
  })

  it('Host 不可信 → 403 短体 forbidden（官方 401/403 镜像的另一分支）', () => {
    const { routes } = captureAppliedRoutes(
      { mobileOrigin: ORIGIN },
      { trustedHost: 'desktop.example.net' },
    )
    const state = call(pairRouteOf(routes), {
      method: 'GET',
      url: PAIR_URL_PATH,
      headers: { host: 'mac1.example.ts.net', cookie: 'dsh-session=good' },
    })
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
  })

  it('已准入但未配置 mobileOrigin → 500 体 mobile-origin-unset（JSON + no-store）', () => {
    const { routes, calls } = captureAppliedRoutes({})
    const state = call(pairRouteOf(routes), { method: 'GET', url: PAIR_URL_PATH, headers: ADMITTED_HEADERS })
    expect(state.status).toBe(500)
    expect(state.headers['content-type']).toBe('application/json')
    expect(state.headers['cache-control']).toBe('no-store')
    expect(state.body).toBe('{"error":"mobile-origin-unset"}')
    expect(calls.authenticatedUrl).toHaveLength(0)
  })

  it('已准入且配置 mobileOrigin → 200 JSON，url 以 origin 开头、含手机根路径、带非空令牌查询', () => {
    const { routes, calls } = captureAppliedRoutes({ mobileOrigin: ORIGIN })
    const state = call(pairRouteOf(routes), { method: 'GET', url: PAIR_URL_PATH, headers: ADMITTED_HEADERS })
    expect(state.status).toBe(200)
    expect(state.headers['content-type']).toBe('application/json')
    expect(state.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(state.body) as { url: string }
    expect(body.url.startsWith(`${ORIGIN}/threadharbor/mobile/`)).toBe(true)
    expect(body.url).toContain('/threadharbor/mobile/')
    expect(new URL(body.url).search.length).toBeGreaterThan(1)
    expect(new URL(body.url).searchParams.get('token')).toBe('launch-token-xyz')
    expect(calls.authenticatedUrl).toEqual([`${ORIGIN}/threadharbor/mobile/`])
  })

  it('已准入的非 GET → 405', () => {
    const { routes } = captureAppliedRoutes({ mobileOrigin: ORIGIN })
    const state = call(pairRouteOf(routes), { method: 'POST', url: PAIR_URL_PATH, headers: ADMITTED_HEADERS })
    expect(state.status).toBe(405)
    expect(state.headers['allow']).toBe('GET')
  })
})
