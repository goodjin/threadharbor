/**
 * 手机端独立入口（宿主侧）。
 *
 * 这个包在 DSH Web 服务上挂手机页静态资源与 peers / pair-url 接口。
 * 本任务只立骨架：装载器读到的 `name` / `inject` / `Config` / `apply`
 * 四件套就位，组合行（cordis.patch.yml 的 threadharbor-mobile-entry）
 * 指向这里；行为都在后续任务往这个入口上加。
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'threadharbor-mobile-entry'

/** webServer 挂路由；connection 做准入（admit / authorizeIndex）。 */
export const inject = ['webServer', 'connection']

/**
 * 配置字段（mobileOrigin）随 Task 4 落进来；先立空 schema 占位，
 * 组合行不写 config 也能装载。
 */
export const Config: Schema = Schema.object({})

/**
 * 挂载入口。本任务内为空体：只证明组合行能把它装进来，
 * 路由注册由后续任务在这里展开。
 * @param ctx - 宿主上下文（webServer / connection 服务从这里取）。
 * @param _config - 校验后的组合配置（当前无字段）。
 */
export function apply(ctx: unknown, _config: unknown): void {
  void ctx
}

