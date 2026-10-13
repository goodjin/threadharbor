/**
 * 手机页静态服务与 hello 标记。
 *
 * 无凭据出口的两类之一都在这里：`mobile/` 下的静态资源与 hello JSON。
 * index 文档的到访先过配对交换封装（`authorizeMobileIndex`）：查询串带令牌时
 * 由官方 `connection.authorizeIndex` 完成令牌换 cookie（303 或 401 都由官方
 * 接管响应），不带令牌时照旧公开服务应用壳。资源解析是纯函数
 * `resolveMobileAsset`：路径归一化 + 逐段校验 + 目录包含性验证，三道防线保证
 * 请求路径只能落在包内 `mobile/` 资源目录里，目录外（含各种穿越写法）一律
 * 404。手机页不引入构建链，`mobile/` 下是浏览器原生文件。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { authorizeMobileIndex, type AuthorizeIndexConnection } from './pairing.ts'

/** 手机页所有路由都挂在这个前缀下；pair-url 与 peers 的 exact 路由同样如此。 */
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

/** 官方 admit 的准入结果（官方 PeerAdmission 的最小投影）：准入给 peer，拒绝给 401 | 403。 */
export type MobileAdmission = { readonly peer: unknown } | { readonly rejection: 401 | 403 }

/**
 * 本插件用到的官方 connection 服务面：index 到访的令牌交换（authorizeIndex）、
 * pair-url 的准入（admit，与官方 /api 同一处置）与带令牌手机根网址的铸造
 * （authenticatedUrl）。成员是官方 HostConnectionService 的最小投影，本包各
 * 路由模块按需取用。
 */
export interface MobileConnection extends AuthorizeIndexConnection {
  /** 官方准入：请求事实里只有 headers 是必填；通过给 peer，拒绝给 401 | 403。 */
  admit(request: { readonly headers: Readonly<Record<string, string | readonly string[] | undefined>> }): MobileAdmission
  /** 把进程令牌追加为查询参数，返回保留 authority 与挂载点的带令牌网址。 */
  authenticatedUrl(baseUrl: string): string
}

export interface MobileRouteContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer: {
    register(route: MobileRoute): () => void
  }
  connection: MobileConnection
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
 * 这条请求是不是 index 文档到访（要过配对交换封装的那类）。
 * 与 {@link resolveMobileAsset} 的 index 映射同一套归一化（`new URL` 取
 * pathname 后单次 decode），三种拼写都算：前缀本身、前缀带斜杠、显式
 * `index.html`。解析不了的畸形路径不算 index，交回普通解析流程按 404 处置。
 */
function isMobileIndexRequest(url: string): boolean {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(url, 'http://threadharbor.invalid').pathname)
  } catch {
    return false
  }
  return pathname === MOBILE_PREFIX
    || pathname === `${MOBILE_PREFIX}/`
    || pathname === `${MOBILE_PREFIX}/${INDEX_FILE}`
}

/**
 * 把静态资源 prefix 路由与 hello exact 路由挂上宿主。
 * 走 DSH 插件的登记样式：`ctx.effect(() => ctx.webServer.register(...), 标签)`。
 * prefix 路由里 index 文档的到访先过配对交换封装（带令牌经官方
 * `authorizeIndex` 换 cookie，官方接管响应），无令牌与静态资源照旧公开服务。
 * hello 不做准入：GET 直接回固定 JSON，非 GET 回 405。
 *
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param _config - 组合配置；本任务无字段，Task 4 起才消费。
 */
export function registerMobileRoutes(ctx: MobileRouteContext, _config: unknown): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: MOBILE_PREFIX,
        handler(req, res) {
          const url = req.url ?? '/'
          if (isMobileIndexRequest(url)) {
            // index 到访先过配对交换封装：带令牌由官方 authorizeIndex 接管
            // 响应（303 换 cookie / 401），'owned' 时这里一个字节都不出；
            // 'serve'（无令牌）落到下面的公开应用壳。headers 按 node:http
            // 实际形态传入，官方侧自行容错（数组值会被忽略），值不被改动。
            const outcome = authorizeMobileIndex(
              { method: req.method ?? '', url, headers: req.headers as Record<string, string> },
              res,
              ctx.connection,
            )
            if (outcome === 'owned') return
          }
          const asset = resolveMobileAsset(url)
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
