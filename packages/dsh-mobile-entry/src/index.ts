/**
 * 手机端独立入口（宿主侧）。
 *
 * 这个包在 DSH Web 服务上挂手机页静态资源与 peers / pair-url 接口。
 * 装载器读到的是 `name` / `inject` / `Config` / `apply` 四件套，组合行
 * （cordis.patch.yml 的 threadharbor-mobile-entry）指向这里；目前挂上
 * 手机页静态资源与 hello 标记，pairing / peers 等行为在后续任务加。
 */

import Schema from '@deepseek-ai/schemastery'
import { registerMobileRoutes, type MobileRouteContext } from './static-serve.ts'

export const name = 'threadharbor-mobile-entry'

/** webServer 挂路由；connection 做准入（admit / authorizeIndex）。 */
export const inject = ['webServer', 'connection']

/**
 * 配置字段（mobileOrigin）随 Task 4 落进来；先立空 schema 占位，
 * 组合行不写 config 也能装载。
 */
export const Config: Schema = Schema.object({})

/**
 * 挂载入口：注册手机页静态资源 prefix 路由与 hello 标记 exact 路由。
 * pairing / pair-url / peers / 正式应用页都在后续任务往这里加。
 * @param ctx - 宿主上下文（webServer / connection 服务从这里取）。
 * @param _config - 校验后的组合配置（当前无字段）。
 */
export function apply(ctx: MobileRouteContext, _config: unknown): void {
  registerMobileRoutes(ctx, _config)
}

