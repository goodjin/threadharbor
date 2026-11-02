/**
 * Mermaid 运行时的宿主侧静态资源路由。
 *
 * 浏览器侧不把 3.5 MB 的 mermaid 打进客户端包（每次页面启动都要解析执行），
 * 而是在第一次遇到真正的 Mermaid 代码块时才注入 `<script>`，从本机
 * `/threadharbor/mermaid.js` 取这份 UMD 文件。同一登录准入（`connection.admit`
 * 的 cookie 校验与原样状态码），不走 CDN、离线可用；同源主机网关下的页面按
 * `<base href>` 解析成网关子路径，请求仍会落到这里。
 *
 * 文件从本包自己的 `mermaid` 依赖解析，路径懒解析、内容首次请求时读一次并缓存
 * （字节 + ETag）。`cache-control: no-cache` 让浏览器每次带 `if-none-match`
 * 回来问，命中就 304——多标签页、多会话不会反复拖 3.5 MB。
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export const name = 'threadharbor-mermaid-asset'

/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection']

/** exact 路由路径；浏览器侧的 mermaid.ts 用同一个常量。 */
export const MERMAID_ROUTE_PATH = '/threadharbor/mermaid.js'

/** 资产文件名：随 mermaid 包发布，内容变化时 ETag 跟着变。 */
const ASSET_FILE = 'mermaid.min.js'

/** 这份入口需要的宿主面（窄接口，测试立桩照这个来）。 */
export interface MermaidAssetContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
    }): (() => void) | void
  }
  connection: {
    admit(request: IncomingMessage): { rejection: number } | { peer: unknown }
  }
  /** 读完文件失败时留一行原因；测试与窄上下文可以不给。 */
  logger?(name: string): { warn(message: string): void }
}

/** 注册时可选的注入面；生产空着，测试换假资产与假读取器。 */
export interface MermaidAssetRouteDeps {
  /** 读一份资产字节；缺省读本包安装的 mermaid。 */
  readAsset?(): Promise<Uint8Array>
  /** 成功应答的缓存策略；缺省 `no-cache`（每次带 ETag 回来问）。 */
  cacheControl?: string
}

/**
 * 装载入口：挂上这条 exact 路由。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 */
export function apply(ctx: MermaidAssetContext): void {
  registerMermaidAssetRoute(ctx)
}

/**
 * 注册 Mermaid 资产路由，走 DSH 插件的登记样式。
 *
 * 缓存在本次注册的闭包里：一次注册一份，重复注册不共享旧账。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param deps - 可选注入面；缺省读安装的 mermaid。
 */
export function registerMermaidAssetRoute(ctx: MermaidAssetContext, deps: MermaidAssetRouteDeps = {}): void {
  const readAsset = deps.readAsset ?? readInstalledMermaidAsset
  const cacheControl = deps.cacheControl ?? 'no-cache'
  let cached: { bytes: Uint8Array; etag: string } | undefined
  let failureLogged = false
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: MERMAID_ROUTE_PATH,
        async handler(req, res) {
          // 拒绝分支照抄官方 /api：状态码原样，短体固定。
          const admission = ctx.connection.admit(req)
          if ('rejection' in admission) {
            res.writeHead(admission.rejection)
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
            res.end('method not allowed')
            return
          }
          if (cached === undefined) {
            try {
              const bytes = await readAsset()
              cached = { bytes, etag: `"${createHash('sha1').update(bytes).digest('hex')}"` }
            } catch (error) {
              if (!failureLogged) {
                failureLogged = true
                ctx.logger?.('threadharbor-mermaid-asset').warn(
                  `mermaid runtime is missing from this install; diagrams stay as code (${error instanceof Error ? error.message : String(error)})`,
                )
              }
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
              res.end('mermaid asset unavailable')
              return
            }
          }
          const asset = cached
          const noneMatch = req.headers['if-none-match']
          if (typeof noneMatch === 'string' && noneMatch.split(',').some(value => value.trim() === asset.etag)) {
            res.writeHead(304, { etag: asset.etag, 'cache-control': cacheControl })
            res.end()
            return
          }
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'content-length': asset.bytes.byteLength,
            'cache-control': cacheControl,
            etag: asset.etag,
          })
          res.end(asset.bytes)
        },
      }),
    'threadharbor-mermaid-asset: asset route',
  )
}

/**
 * 本机安装的 mermaid UMD 文件内容。
 *
 * 从本包的依赖里解析路径（`mermaid` 允许的导出子路径因版本而异，先找
 * package.json，再退到主入口旁的 dist），懒解析——模块顶层不碰文件，
 * 宿主以 plain Node 导入入口时不会因为缺文件而失败。
 */
export async function readInstalledMermaidAsset(): Promise<Uint8Array> {
  return await readFile(installedMermaidAssetPath())
}

function installedMermaidAssetPath(): string {
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('mermaid/package.json')), 'dist', ASSET_FILE)
  } catch {
    return join(dirname(require.resolve('mermaid')), ASSET_FILE)
  }
}
