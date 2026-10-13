import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HELLO_PATH,
  MOBILE_PREFIX,
  registerMobileRoutes,
  resolveMobileAsset,
  type MobileRouteContext,
} from '../src/static-serve.ts'

/**
 * 临时资源目录：资源清单不写死在用例里，逐用例注入，
 * 与包内真实的 mobile/ 目录隔离。
 */
const TEMP_INDEX_HTML = '<!doctype html><html lang="zh"><title>临时占位壳</title></html>'

const tempDirs: string[] = []
function makeMobileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mobile-entry-'))
  writeFileSync(join(dir, 'index.html'), TEMP_INDEX_HTML, 'utf8')
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveMobileAsset（手机页资源解析）', () => {
  it('根路径两种拼写都映射 index.html，返回 200 与 text/html', () => {
    const dir = makeMobileDir()
    for (const pathname of ['/threadharbor/mobile', '/threadharbor/mobile/']) {
      expect(resolveMobileAsset(pathname, dir)).toEqual({
        status: 200,
        body: TEMP_INDEX_HTML,
        contentType: 'text/html',
      })
    }
  })

  it('显式请求 index.html 同样返回 200', () => {
    const dir = makeMobileDir()
    expect(resolveMobileAsset('/threadharbor/mobile/index.html', dir)).toEqual({
      status: 200,
      body: TEMP_INDEX_HTML,
      contentType: 'text/html',
    })
  })

  it('缺省目录参数时读包内 mobile/', () => {
    const result = resolveMobileAsset('/threadharbor/mobile')
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.contentType).toBe('text/html')
      expect(result.body).toContain('threadharbor mobile')
    }
  })

  it('未知资源返回 404', () => {
    const dir = makeMobileDir()
    expect(resolveMobileAsset('/threadharbor/mobile/nope.js', dir)).toEqual({ status: 404 })
    expect(resolveMobileAsset('/threadharbor/mobile/sub/dir/missing.html', dir)).toEqual({ status: 404 })
  })

  it('裸 ../ 路径穿越返回 404', () => {
    const dir = makeMobileDir()
    expect(resolveMobileAsset('/threadharbor/mobile/../../package.json', dir)).toEqual({ status: 404 })
  })

  it('百分号编码的穿越变体一律 404', () => {
    const dir = makeMobileDir()
    const attempts = [
      '/threadharbor/mobile/%2e%2e%2fpackage.json',
      '/threadharbor/mobile/..%2f..%2fpackage.json',
      '/threadharbor/mobile/%252e%252e%252fpackage.json',
      '/threadharbor/mobile/..%5cpackage.json',
    ]
    for (const pathname of attempts) {
      expect(resolveMobileAsset(pathname, dir), pathname).toEqual({ status: 404 })
    }
  })

  it('形近前缀（mobile-evil / mobilex）不算本插件的路由，返回 404', () => {
    const dir = makeMobileDir()
    expect(resolveMobileAsset('/threadharbor/mobile-evil/index.html', dir)).toEqual({ status: 404 })
    expect(resolveMobileAsset('/threadharbor/mobilex', dir)).toEqual({ status: 404 })
  })

  it('畸形百分号序列返回 404 而不是抛错', () => {
    const dir = makeMobileDir()
    expect(resolveMobileAsset('/threadharbor/mobile/%zz.html', dir)).toEqual({ status: 404 })
  })

  it('查询串不参与资源解析', () => {
    const dir = makeMobileDir()
    expect(resolveMobileAsset('/threadharbor/mobile/?v=1', dir)).toEqual({
      status: 200,
      body: TEMP_INDEX_HTML,
      contentType: 'text/html',
    })
  })
})

/** registerMobileRoutes 需要的宿主面在单测里拿不到，用最小桩捕获注册调用。 */
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

function captureRoutes(): { routes: CapturedRoute[]; ctx: MobileRouteContext } {
  const routes: CapturedRoute[] = []
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
  }
  return { routes, ctx: ctx as unknown as MobileRouteContext }
}

/** 直接调用 handler，收下它对响应生命周期的完整处置。 */
function call(handler: RouteHandler, req: { method?: string; url?: string }) {
  const state = { status: 0, headers: {} as Record<string, string | number>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, string | number>) {
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

describe('registerMobileRoutes（路由注册与 hello 标记）', () => {
  it('注册 prefix 静态路由与 exact hello 路由，路径与常量一致', () => {
    const { routes, ctx } = captureRoutes()
    registerMobileRoutes(ctx, {})
    expect(routes).toHaveLength(2)
    const prefix = routes.find(route => route.kind === 'prefix')
    const exact = routes.find(route => route.kind === 'exact')
    expect(prefix?.path).toBe(MOBILE_PREFIX)
    expect(MOBILE_PREFIX).toBe('/threadharbor/mobile')
    expect(exact?.path).toBe(HELLO_PATH)
    expect(HELLO_PATH).toBe('/threadharbor/mobile/hello')
  })

  it('hello 对 GET 返回固定 JSON 形状，无准入', () => {
    const { routes, ctx } = captureRoutes()
    registerMobileRoutes(ctx, {})
    const hello = routes.find(route => route.path === '/threadharbor/mobile/hello')
    const state = call(hello!.handler, { method: 'GET', url: HELLO_PATH })
    expect(state.status).toBe(200)
    expect(state.headers['content-type']).toBe('application/json')
    expect(state.headers['cache-control']).toBe('no-store')
    expect(state.body).toBe('{"mobile":true}')
  })

  it('hello 拒绝非 GET 请求', () => {
    const { routes, ctx } = captureRoutes()
    registerMobileRoutes(ctx, {})
    const hello = routes.find(route => route.path === '/threadharbor/mobile/hello')
    expect(call(hello!.handler, { method: 'POST', url: HELLO_PATH }).status).toBe(405)
  })

  it('prefix 路由按解析结果回包：命中 200，未命中 404', () => {
    const { routes, ctx } = captureRoutes()
    registerMobileRoutes(ctx, {})
    const serve = routes.find(route => route.kind === 'prefix')!
    const hit = call(serve.handler, { method: 'GET', url: '/threadharbor/mobile/' })
    expect(hit.status).toBe(200)
    expect(hit.headers['content-type']).toBe('text/html')
    const miss = call(serve.handler, { method: 'GET', url: '/threadharbor/mobile/missing.html' })
    expect(miss.status).toBe(404)
  })
})
