/**
 * Mermaid 运行时资产路由：宿主侧的按需供给。
 *
 * 准入照官方 /api 的写法（先 admit 后应答，拒绝时状态码原样、短体固定）；
 * 资产只在第一次成功请求时读一次（字节 + ETag 缓存），`if-none-match` 命中
 * 回 304；读失败折成 500 短体并只记一次日志。取数器全部注入，测试不读真文件
 * （最后一条除外：它钉住 mermaid 依赖与子路径真的能解析到）。
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  apply,
  MERMAID_ROUTE_PATH,
  readInstalledMermaidAsset,
  registerMermaidAssetRoute,
} from '../src/mermaid-asset.ts'
import type { MermaidAssetContext } from '../src/mermaid-asset.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

/** 一份像样的资产：两种字节值，长度非零。 */
const ASSET = new TextEncoder().encode('window.mermaid={initialize(){},render(){}}')

function assetEtag(bytes: Uint8Array): string {
  return `"${createHash('sha1').update(bytes).digest('hex')}"`
}

/**
 * fake connection：对照官方 admit 的分支语义——无 cookie 401，Host 不可信 403，
 * 通过则给 peer。
 */
function fakeConnection(options: { trustedHost?: string } = {}) {
  const calls = { admit: [] as unknown[] }
  const connection = {
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

/** 最小宿主面：effect 立即执行，webServer.register 捕获路由，logger 记 warn。 */
function rig(admitSource = fakeConnection()) {
  const routes: CapturedRoute[] = []
  const warns: string[] = []
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
    logger(name: string) {
      return { warn(message: string) { warns.push(`${name}: ${message}`) } }
    },
  } as unknown as MermaidAssetContext
  return { ctx, routes, calls: admitSource.calls, warns }
}

interface Answer {
  status: number
  headers: Record<string, string | string[] | number | undefined>
  body: string | Uint8Array | undefined
}

/** 请进来一次的请求（默认带合法 cookie），收回应答的状态码、头与体。 */
async function callRoute(
  route: CapturedRoute | undefined,
  init: { method?: string; cookie?: string; host?: string; ifNoneMatch?: string } = {},
): Promise<Answer> {
  if (route === undefined) throw new Error('route was not registered')
  const req = {
    method: init.method ?? 'GET',
    headers: {
      ...(init.host === undefined ? {} : { host: init.host }),
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
      ...(init.ifNoneMatch === undefined ? {} : { 'if-none-match': init.ifNoneMatch }),
    },
  } as IncomingMessage
  let status = 0
  const headers: Record<string, string | string[] | number | undefined> = {}
  let bodyOut: string | Uint8Array | undefined
  const res = {
    writeHead(code: number, head?: Record<string, unknown>) {
      status = code
      for (const [key, value] of Object.entries(head ?? {})) headers[key] = value as string | number
    },
    end(body?: string | Uint8Array) {
      bodyOut = body
    },
  } as unknown as ServerResponse
  await route.handler(req, res)
  return { status, headers, body: bodyOut }
}

describe('apply（wiring 层）', () => {
  it('注册一条 exact 的 /threadharbor/mermaid.js 路由', () => {
    const { ctx, routes } = rig()
    apply(ctx)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'exact', path: MERMAID_ROUTE_PATH })
    expect(MERMAID_ROUTE_PATH).toBe('/threadharbor/mermaid.js')
  })
})

describe('registerMermaidAssetRoute（行为层）', () => {
  it('准入通过时 200 送出资产：类型、长度、ETag 与字节都对，且只读一次', async () => {
    const { ctx, routes } = rig()
    let reads = 0
    registerMermaidAssetRoute(ctx, {
      readAsset: async () => {
        reads += 1
        return ASSET
      },
    })
    const first = await callRoute(routes[0], { cookie: 'dsh-session=good' })
    expect(first.status).toBe(200)
    expect(first.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(first.headers['content-length']).toBe(ASSET.byteLength)
    expect(first.headers['cache-control']).toBe('no-cache')
    expect(first.headers['etag']).toBe(assetEtag(ASSET))
    expect(first.body).toBeInstanceOf(Uint8Array)
    expect(new Uint8Array(first.body as Uint8Array)).toEqual(ASSET)

    const second = await callRoute(routes[0], { cookie: 'dsh-session=good' })
    expect(second.status).toBe(200)
    expect(second.headers['etag']).toBe(first.headers['etag'])
    expect(new Uint8Array(second.body as Uint8Array)).toEqual(ASSET)
    expect(reads).toBe(1)
  })

  it('if-none-match 命中（含多值列表）回 304，不再送体', async () => {
    const { ctx, routes } = rig()
    registerMermaidAssetRoute(ctx, { readAsset: async () => ASSET })
    const first = await callRoute(routes[0], { cookie: 'dsh-session=good' })
    const etag = first.headers['etag'] as string

    const exact = await callRoute(routes[0], { cookie: 'dsh-session=good', ifNoneMatch: etag })
    expect(exact.status).toBe(304)
    expect(exact.headers['etag']).toBe(etag)
    expect(exact.headers['cache-control']).toBe('no-cache')
    expect(exact.body).toBeUndefined()

    const listed = await callRoute(routes[0], {
      cookie: 'dsh-session=good',
      ifNoneMatch: `"stale", ${etag}`,
    })
    expect(listed.status).toBe(304)

    const miss = await callRoute(routes[0], { cookie: 'dsh-session=good', ifNoneMatch: '"stale"' })
    expect(miss.status).toBe(200)
  })

  it('无 cookie 401、Host 不可信 403，短体固定，且不读资产', async () => {
    const { ctx, routes, calls } = rig(fakeConnection({ trustedHost: 'trusted.example' }))
    let reads = 0
    registerMermaidAssetRoute(ctx, {
      readAsset: async () => {
        reads += 1
        return ASSET
      },
    })
    expect(await callRoute(routes[0], { cookie: '', host: 'trusted.example' }))
      .toMatchObject({ status: 401, body: 'unauthorized' })
    expect(await callRoute(routes[0], { cookie: 'dsh-session=good', host: 'evil.example' }))
      .toMatchObject({ status: 403, body: 'forbidden' })
    expect(calls.admit).toHaveLength(2)
    expect(reads).toBe(0)
  })

  it('非 GET 一律 405，并说明只允许 GET', async () => {
    const { ctx, routes } = rig()
    let reads = 0
    registerMermaidAssetRoute(ctx, {
      readAsset: async () => {
        reads += 1
        return ASSET
      },
    })
    expect(await callRoute(routes[0], { method: 'POST', cookie: 'dsh-session=good' }))
      .toMatchObject({ status: 405, body: 'method not allowed' })
    expect(reads).toBe(0)
  })

  it('资产读不出来回 500 短体，只记一次日志，不把路径回显给浏览器', async () => {
    const { ctx, routes, warns } = rig()
    let reads = 0
    registerMermaidAssetRoute(ctx, {
      readAsset: async () => {
        reads += 1
        throw new Error('/secret/node_modules/mermaid/dist/mermaid.min.js is missing')
      },
    })
    for (let i = 0; i < 2; i += 1) {
      const answer = await callRoute(routes[0], { cookie: 'dsh-session=good' })
      expect(answer.status).toBe(500)
      expect(answer.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(answer.headers['cache-control']).toBe('no-store')
      expect(answer.body).toBe('mermaid asset unavailable')
    }
    expect(reads).toBe(2)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('mermaid runtime is missing')
  })

  it('cache-control 可用注入面覆盖', async () => {
    const { ctx, routes } = rig()
    registerMermaidAssetRoute(ctx, { readAsset: async () => ASSET, cacheControl: 'public, max-age=60' })
    const answer = await callRoute(routes[0], { cookie: 'dsh-session=good' })
    expect(answer.status).toBe(200)
    expect(answer.headers['cache-control']).toBe('public, max-age=60')
  })
})

describe('readInstalledMermaidAsset（真依赖）', () => {
  it('从 mermaid 依赖里解析到 dist/mermaid.min.js（>1 MB）', async () => {
    const bytes = await readInstalledMermaidAsset()
    expect(bytes.byteLength).toBeGreaterThan(1024 * 1024)
    expect(new TextDecoder().decode(bytes.subarray(0, 200))).toContain('mermaid')
  })
})
