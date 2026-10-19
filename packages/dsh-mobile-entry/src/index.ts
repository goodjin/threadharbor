/**
 * 手机端独立入口（宿主侧）。
 *
 * 这个包在 DSH Web 服务上挂手机页静态资源与 peers / pair-url 接口。
 * 装载器读到的是 `name` / `inject` / `Config` / `apply` 四件套，组合行
 * （cordis.patch.yml 的 threadharbor-mobile-entry）指向这里；目前挂上
 * 手机页静态资源、hello 标记、pair-url 与 peers 接口，正式应用页在
 * 后续任务加。
 */

import Schema from '@deepseek-ai/schemastery'
import { assertMobileOrigin, MOBILE_ORIGIN_PATTERN, registerPairUrlRoute } from './pair-url.ts'
import { registerPeersRoute } from './peers.ts'
import { registerMobileRoutes, type MobileRouteContext } from './static-serve.ts'

export const name = 'threadharbor-mobile-entry'

/** webServer 挂路由；connection 做准入（admit / authorizeIndex）。 */
export const inject = ['webServer', 'connection']

// 手机页的对外 serve API 从包根导出：中转插件（dsh-mobile-relay）直接调用它们
// 出页面，自己不再作为独立入口被装载。直连模式取消后，本包只剩这套「出页面 +
// pair-url + peers」的库能力；name/inject/Config/apply 四件套保留但不再注册。
export { registerMobileRoutes, MOBILE_PREFIX, HELLO_PATH } from './static-serve.ts'
export type { MobileRouteContext, MobileRoute, MobileAsset } from './static-serve.ts'
export { registerPairUrlRoute, PAIR_URL_PATH, assertMobileOrigin, MOBILE_ORIGIN_PATTERN } from './pair-url.ts'
export { registerPeersRoute, PEERS_PATH } from './peers.ts'

/** apply 收到的组合配置形状（Config 的解析结果）；mobileOrigin 缺省时 pair-url 应答 500。 */
export interface MobileEntryConfig {
  mobileOrigin?: string
}

/**
 * 配置字段：mobileOrigin 是手机端根网址的源（如 https://mac1.example.ts.net）。
 * 装载期两道校验：形状（https、无路径/查询/碎片、无尾斜杠、无控制字符）钉在
 * pattern 上；URL 语法（端口范围、规范化 origin）由 apply 里的
 * assertMobileOrigin 补第二道。坏值装载即失败，不做静默回退。
 */
export const Config: Schema = Schema.object({
  mobileOrigin: Schema.string().pattern(MOBILE_ORIGIN_PATTERN).description('手机端根网址的源（如 https://mac1.example.ts.net）'),
  // 不加 required() 就是「可缺省」（本仓库其余可选字段同款）。
})

/**
 * 挂载入口：注册手机页静态资源 prefix 路由、hello 标记 exact 路由，
 * 以及 pair-url 与 peers 两个 exact 路由。正式应用页在后续任务往这里加。
 * @param ctx - 宿主上下文（webServer / connection 服务从这里取）。
 * @param config - 校验后的组合配置（mobileOrigin 可缺省）。
 */
export function apply(ctx: MobileRouteContext, config?: MobileEntryConfig): void {
  // 语法校验先于任何注册：坏配置装载即失败，不留下半挂的路由。
  if (config?.mobileOrigin !== undefined) assertMobileOrigin(config.mobileOrigin)
  registerMobileRoutes(ctx)
  registerPairUrlRoute(ctx, config?.mobileOrigin)
  registerPeersRoute(ctx)
}
