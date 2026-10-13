/**
 * 手机页静态服务与 hello 标记。
 *
 * 无凭据出口的两类之一都在这里：`mobile/` 下的静态资源与 hello JSON。
 * 资源解析是纯函数 `resolveMobileAsset`：路径归一化 + 逐段校验 + 目录
 * 包含性验证，三道防线保证请求路径只能落在包内 `mobile/` 资源目录里，
 * 目录外（含各种穿越写法）一律 404。手机页不引入构建链，`mobile/` 下
 * 是浏览器原生文件。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 手机页所有路由都挂在这个前缀下，后续任务（pairing / peers）同样如此。 */
export const MOBILE_PREFIX = '/threadharbor/mobile'

/** hello 标记：探针用，证明手机入口已经挂上，不做任何准入。 */
export const HELLO_PATH = '/threadharbor/mobile/hello'

/** 包内手机页资源目录；测试通过第二个参数注入临时目录。 */
const DEFAULT_MOBILE_DIR = fileURLToPath(new URL('../mobile', import.meta.url))

const INDEX_FILE = 'index.html'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
}

/** 静态资源解析结果：命中给全文，落不进资源目录就 404。 */
export type MobileAsset =
  | { status: 200; body: string; contentType: string }
  | { status: 404 }

/** 宿主侧路由登记 API（webServer 服务）与本插件用到的 effect 面。 */
export interface MobileRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface MobileRouteContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer: {
    register(route: MobileRoute): () => void
  }
}

const NOT_FOUND: MobileAsset = { status: 404 }

/**
 * 把请求路径解析成 `mobile/` 目录里的一个文件。
 *
 * 防线次序（不能调换、不能省）：
 * 1. `new URL` 归一化——消化裸 `.` / `..` 段与百分号编码的点段，剥掉查询串；
 * 2. 整条路径单次 decodeURIComponent——只解一层，二次编码的写法解出来
 *    仍是字面量，最终靠文件存在性兜底；解不了（畸形百分号）直接 404；
 * 3. 段级校验——解码后按 `/` 切段，前缀段逐段相等（不是 startsWith 字符串
 *    拼接），其余段不得为空、`.`、`..`、反斜杠或空字节；
 * 4. 目录包含性验证——`relative` 出来仍须落在资源目录内；
 * 5. 只服务资源目录里真实存在的文件。
 *
 * @param pathname - 请求路径（可带查询串）。
 * @param mobileDir - 资源目录，缺省为包内 `mobile/`；测试注入临时目录。
 */
export function resolveMobileAsset(pathname: string, mobileDir: string = DEFAULT_MOBILE_DIR): MobileAsset {
  let url: URL
  try {
    url = new URL(pathname, 'http://threadharbor.invalid')
  } catch {
    return NOT_FOUND
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return NOT_FOUND
  }

  const segments = decoded.split('/')
  const prefixSegments = MOBILE_PREFIX.split('/')
  if (segments.length < prefixSegments.length) return NOT_FOUND
  for (const [index, prefixSegment] of prefixSegments.entries()) {
    if (segments[index] !== prefixSegment) return NOT_FOUND
  }

  let fileSegments = segments.slice(prefixSegments.length)
  if (fileSegments.length === 0 || (fileSegments.length === 1 && fileSegments[0] === '')) {
    // `/threadharbor/mobile` 与 `/threadharbor/mobile/` 两种拼写都映射 index.html。
    fileSegments = [INDEX_FILE]
  } else {
    for (const segment of fileSegments) {
      if (segment === '' || segment === '.' || segment === '..') return NOT_FOUND
      if (segment.includes('\\') || segment.includes('\0')) return NOT_FOUND
    }
  }

  const rootDir = resolve(mobileDir)
  const candidate = resolve(rootDir, join(...fileSegments))
  const rel = relative(rootDir, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return NOT_FOUND
  }

  if (!existsSync(candidate) || !statSync(candidate).isFile()) return NOT_FOUND
  const contentType = CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream'
  return { status: 200, body: readFileSync(candidate, 'utf8'), contentType }
}

/**
 * 把静态资源 prefix 路由与 hello exact 路由挂上宿主。
 * 走 DSH 插件的登记样式：`ctx.effect(() => ctx.webServer.register(...), 标签)`。
 * hello 不做准入：GET 直接回固定 JSON，非 GET 回 405。
 *
 * @param ctx - 宿主上下文（effect / webServer）。
 * @param _config - 组合配置；本任务无字段，Task 4 起才消费。
 */
export function registerMobileRoutes(ctx: MobileRouteContext, _config: unknown): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: MOBILE_PREFIX,
        handler(req, res) {
          const asset = resolveMobileAsset(req.url ?? '/')
          if (asset.status === 404) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('not found')
            return
          }
          res.writeHead(200, {
            'content-type': asset.contentType,
            'content-length': Buffer.byteLength(asset.body),
          })
          res.end(asset.body)
        },
      }),
    'threadharbor-mobile-entry: mobile page static assets',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: HELLO_PATH,
        handler(req, res) {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
            res.end('method not allowed')
            return
          }
          const body = '{"mobile":true}'
          res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          })
          res.end(body)
        },
      }),
    'threadharbor-mobile-entry: hello marker',
  )
}
