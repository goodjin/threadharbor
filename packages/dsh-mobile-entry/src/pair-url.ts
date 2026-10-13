/**
 * pair-url 接口：桌面端二维码面板取「手机配对网址」的第一个已准入出口。
 *
 * 准入与官方 /api 同一面（对照 DSH 参考源码 packages/client/connection/src/
 * index.ts:148-153，2026-10-15 核对）：`connection.admit(req)` 拒绝时状态码
 * 原样写出，短体固定——401 'unauthorized'，其余 'forbidden'。准入后按配置
 * 铸造 `${mobileOrigin}/threadharbor/mobile/` 的带令牌网址（官方
 * authenticatedUrl 保留 authority 与挂载点、追加进程令牌），手机端打开它再经
 * 官方 authorizeIndex 换 cookie（见 pairing.ts 的封装）。mobileOrigin 未配置
 * 属于部署半途：准入已过，应答 500 + 结构化错误体，桌面端能直接显示原因。
 *
 * mobileOrigin 的装载期校验分两道：schema 的 pattern 卡形状（见
 * MOBILE_ORIGIN_PATTERN），apply 里的 assertMobileOrigin 卡 URL 语法
 * （端口范围、规范化 origin）。坏值一律装载即失败，不做静默回退。
 */

import type { ServerResponse } from 'node:http'
import { MOBILE_PREFIX, type MobileRouteContext } from './static-serve.ts'

/** pair-url 的 exact 路由路径；桌面端二维码面板按这个常量取网址。 */
export const PAIR_URL_PATH = '/threadharbor/mobile/pair-url'

/**
 * mobileOrigin 的形状校验（Config 的 pattern，装载第一道）：https + 仅
 * authority 段——路径、查询、碎片、尾斜杠都要 `/`、`?`、`#` 之一，一律排除；
 * 控制字符与空白（`\x00`–`\x20`）也排除（WHATWG 解析会静默剥掉其中一部分，
 * 铸出与配置偏移的主机）。语法层（端口范围、规范化 origin）由
 * {@link assertMobileOrigin} 在 apply 里补第二道；两道都在装载期失败，
 * 不做静默回退。
 */
export const MOBILE_ORIGIN_PATTERN = /^https:\/\/[^\x00-\x20/?#]+$/

/**
 * mobileOrigin 的装载期 URL 语法校验（apply 在任何注册之前调用）。
 * schema 的 pattern 只卡形状，语法层要靠这里：`new URL` 解析失败即坏值
 * （端口越界如 `:99999`）；解析成功但 `url.origin` 与配置值不等也拒绝——
 * WHATWG 会剥掉冗余冒号、小写化 authority，写非规范化形式意味着运行时
 * 铸出的网址与配置偏移。两道校验都失败在装载期，不在请求期。
 * @param value - 已过 schema 形状校验的 mobileOrigin。
 * @throws 配置值不是合法且规范化的 https origin 时抛错。
 */
export function assertMobileOrigin(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`mobileOrigin 不是合法网址：${value}`)
  }
  if (url.origin !== value) {
    throw new Error(`mobileOrigin 必须写成规范化 origin（https、小写 authority、无冗余端口）：${value} 的规范化形式是 ${url.origin}`)
  }
}

/**
 * 注册 pair-url exact 路由，走 DSH 插件的登记样式：
 * `ctx.effect(() => ctx.webServer.register(...))`。
 *
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param mobileOrigin - 已过 schema 校验的手机端根网址源；缺省时准入后应答
 *   500 `mobile-origin-unset`。
 */
export function registerPairUrlRoute(ctx: MobileRouteContext, mobileOrigin: string | undefined): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PAIR_URL_PATH,
        handler(req, res) {
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
          if (mobileOrigin === undefined) {
            respondJson(res, 500, '{"error":"mobile-origin-unset"}')
            return
          }
          const pairUrl = ctx.connection.authenticatedUrl(`${mobileOrigin}${MOBILE_PREFIX}/`)
          respondJson(res, 200, JSON.stringify({ url: pairUrl }))
        },
      }),
    'threadharbor-mobile-entry: pair-url route',
  )
}

/** JSON 应答：no-store（带令牌的网址不许被任何一环缓存）+ 固定长度。 */
function respondJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
