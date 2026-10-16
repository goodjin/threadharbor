/**
 * GLM 套餐限额的宿主侧接口。
 *
 * 浏览器画输入框下方的配额胶囊时要读这份限额，但解密密钥只住在宿主进程
 * （zcode-acp 的约定：内存里解密、不落盘、不进日志）。所以这一层只做转发：
 * 同源 GET `/threadharbor/zcode/quota` → 宿主用本机登录密钥问一次 Coding
 * Plan 的 monitor 地址，把两个窗口（5 小时、周）的数字原样发回。密钥本身
 * 永远不出宿主。
 *
 * 准入与官方 /api 同一面（照抄 peers 路由的写法）：`connection.admit(req)`
 * 拒绝时状态码原样、短体固定——401 'unauthorized'，其余 'forbidden'。
 * 成功应答带 30 秒缓存：多标签页、多会话各自轮询时，上游看到的是每半分钟
 * 最多一问。取数失败或应答形状不认识都不甩 500——200 + `ok:false` + 原因，
 * 浏览器侧据此把胶囊藏起来并在日志里留一行。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { fetchCodingPlanQuota } from '@threadharbor/zcode-acp'
import type { GlmCodingPlanQuota } from '@threadharbor/zcode-acp'

export const name = 'threadharbor-zcode-quota'

/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection']

/** exact 路由路径；浏览器侧的胶囊按这个常量取数。 */
export const QUOTA_ROUTE_PATH = '/threadharbor/zcode/quota'

/** 成功应答的缓存时长；换算成上游被问的频率上限（两个标签页也不翻倍）。 */
const CACHE_TTL_MS = 30_000

/** 取一次配额的最小面：无参进去，配额或 null 出来，失败抛错（消息已脱敏）。 */
export type ZcodeQuotaFetch = () => Promise<GlmCodingPlanQuota | null>

/** 模块级可替换的取数器：生产走真密钥真网络，测试换假件。 */
let quotaFetch: ZcodeQuotaFetch | undefined

/**
 * 换取数器（测试注入假件）；传回 `undefined` 恢复真件。
 * @param next - 下一只取数器，或 `undefined` 恢复生产实现。
 */
export function swapQuotaFetch(next: ZcodeQuotaFetch | undefined): void {
  quotaFetch = next
}

/** 这个入口需要的宿主面（窄接口，测试立桩照这个来）。 */
export interface ZcodeQuotaContext {
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
}

/** 注册时可选的注入面；生产空着，测试换缓存时长。 */
export interface ZcodeQuotaRouteDeps {
  /** 成功应答的缓存时长（毫秒）；缺省 30 秒。 */
  ttlMs?: number
}

/**
 * 装载入口：挂上这条 exact 路由。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 */
export function apply(ctx: ZcodeQuotaContext): void {
  registerZcodeQuotaRoute(ctx)
}

/**
 * 注册配额路由，走 DSH 插件的登记样式：`ctx.effect(() => ctx.webServer.register(...))`。
 *
 * 缓存在本次注册的闭包里：一次注册一份，重复注册不共享旧账。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param deps - 可选注入面；缺省时缓存 30 秒。
 */
export function registerZcodeQuotaRoute(ctx: ZcodeQuotaContext, deps: ZcodeQuotaRouteDeps = {}): void {
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS
  let cached: { at: number; quota: GlmCodingPlanQuota } | undefined
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: QUOTA_ROUTE_PATH,
        async handler(req, res) {
          // 拒绝分支照抄官方 /api 的写法：状态码原样，短体固定。
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
          if (cached !== undefined && Date.now() - cached.at < ttlMs) {
            respondJson(res, 200, JSON.stringify({ ok: true, quota: cached.quota }))
            return
          }
          const fetcher = quotaFetch ?? defaultQuotaFetch
          try {
            const quota = await fetcher()
            if (quota === null) {
              respondJson(res, 200, JSON.stringify({
                ok: false,
                error: 'unrecognised GLM coding plan answer — no five-hour or weekly window was present',
              }))
              return
            }
            cached = { at: Date.now(), quota }
            respondJson(res, 200, JSON.stringify({ ok: true, quota }))
          } catch (error) {
            // 到这一层的错误消息已在 quota 模块里脱敏（密钥不可能混进来）。
            respondJson(res, 200, JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }))
          }
        },
      }),
    'threadharbor-zcode-quota: quota route',
  )
}

/** 生产取数器：密钥、地址、环境变量全在 quota 模块内解析。 */
const defaultQuotaFetch: ZcodeQuotaFetch = () => fetchCodingPlanQuota({})

/** JSON 应答：no-store（缓存归宿主管，不许任何一环替我们缓存）+ 固定长度。 */
function respondJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
