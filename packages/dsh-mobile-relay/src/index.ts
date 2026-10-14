/**
 * 手机中转（云主机侧）。
 *
 * 这个包跑在有公网 HTTPS 的云主机上：手机从公网访问它，它经 SSH 隧道把
 * 请求代理到各台机器的 DSH。装载器读到的是 `name` / `inject` / `Config` /
 * `apply` 四件套，组合行（cordis.patch.yml 的 threadharbor-mobile-relay）
 * 指向这里。骨架任务只挂 `/threadharbor/relay/hosts` 一条占位路由（空清单）：
 * 隧道数据面、tailnet 发现与静态壳由后续任务接上——把静态服务签名变更混进
 * 骨架任务会让两个任务的评审范围都变浑，所以壳留到它的归属任务。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import Schema from '@deepseek-ai/schemastery'
import { assertMobileOrigin, MOBILE_ORIGIN_PATTERN } from '@threadharbor/dsh-mobile-entry/pair-url'

export const name = 'threadharbor-mobile-relay'

/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection']

/** 一台要被中转到的机器：hostId 是 tailnet DNS 名，target 才是 SSH 目标。 */
export interface RelayMachineConfig {
  readonly hostId: string
  readonly target: string
  readonly port?: number
  readonly user?: string
  readonly identityFile?: string
  readonly remotePort: number
}

/** apply 收到的组合配置形状（Config 的解析结果）；mobileOrigin 缺省时后续任务再定处置。 */
export interface MobileRelayConfig {
  readonly mobileOrigin?: string
  readonly sshKnownHostsPath: string
  readonly statePath: string
  readonly machines: readonly RelayMachineConfig[]
}

/** hosts 清单 exact 路由的路径；手机端中转页按这个常量取可达机器清单。 */
export const RELAY_HOSTS_PATH = '/threadharbor/relay/hosts'

/** 宿主侧路由登记 API（webServer 服务）与本插件用到的 effect 面。 */
export interface RelayRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 官方 admit 的准入结果（官方 PeerAdmission 的最小投影）：准入给 peer，拒绝给 401 | 403。 */
export type RelayAdmission = { readonly peer: unknown } | { readonly rejection: 401 | 403 }

/**
 * 本插件用到的官方 connection 服务面：hosts 清单是运维数据，与官方 /api
 * 同一准入面。成员是官方 HostConnectionService 的最小投影，后续任务按需加。
 */
export interface RelayConnection {
  admit(request: { readonly headers: Readonly<Record<string, string | readonly string[] | undefined>> }): RelayAdmission
}

export interface RelayRouteContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer: {
    register(route: RelayRoute): () => void
  }
  connection: RelayConnection
}

/**
 * 配置字段：mobileOrigin 是中转站对外服务的源；sshKnownHostsPath 用于校验
 * 各机主机指纹；statePath 是凭据与端口分配的家目录文件；machines 是隧道
 * 目标清单。装载期两道门沿用 dsh-mobile-entry 的做法：形状（origin 的
 * https/无路径、hostId/target 非空无空白、remotePort 1–65535 整数）钉在
 * schema 上；URL 语法（assertMobileOrigin）与 hostId 的语义（大写/尾点/
 * 重复）由 apply 补第二道。坏值装载即失败，不做静默回退。
 */
export const Config: Schema = Schema.object({
  mobileOrigin: Schema.string().pattern(MOBILE_ORIGIN_PATTERN).description('中转站对外服务的源（如 https://relay.example.com）'),
  sshKnownHostsPath: Schema.string().pattern(/.+/).description('SSH known_hosts 路径（校验各机主机指纹）'),
  statePath: Schema.string().pattern(/.+/).description('凭据与端口分配的家目录文件路径'),
  machines: Schema.array(
    Schema.object({
      hostId: Schema.string().pattern(/^\S+$/).required().description('tailnet DNS 名（如 gooddemacbook-pro）'),
      target: Schema.string().pattern(/^\S+$/).required().description('SSH 目标（IP 或名字）'),
      port: Schema.number().description('SSH 端口，缺省 22'),
      user: Schema.string().description('SSH 用户'),
      identityFile: Schema.string().description('私钥绝对路径'),
      remotePort: Schema.number().min(1).max(65535).step(1).required().description('该机 DSH 的回环端口（如 3081）'),
    }),
  ).description('各台机器的隧道目标清单'),
})

/**
 * hostId 的装载期语义校验。形状门（schema）只保证非空无空白；这里再加
 * 不含大写字母、不含尾点——hostId 之后要拼进 authority 与 SSH 目标，
 * 坏名字会产出畸形地址或与 tailnet DNS（MagicDNS 名本就是小写、无尾点）
 * 对不上的形式，装载期拒掉最省事，不静默跳过。
 */
function assertHostId(hostId: string): void {
  if (/[A-Z]/.test(hostId) || hostId.endsWith('.') || /\s/.test(hostId)) {
    throw new Error(`hostId 不能含大写字母、尾点或空白：${hostId}`)
  }
}

/** machines 逐项校验 + hostId 全表唯一：重名会让路由指向错乱，装载期拒掉。 */
function assertMachines(machines: readonly RelayMachineConfig[]): void {
  const seen = new Set<string>()
  for (const machine of machines) {
    assertHostId(machine.hostId)
    if (seen.has(machine.hostId)) {
      throw new Error(`machines 里 hostId 重复：${machine.hostId}`)
    }
    seen.add(machine.hostId)
  }
}

/**
 * 挂载入口：注册 hosts 清单占位 exact 路由（空清单，真现在后续任务）。
 * @param ctx - 宿主上下文（effect / webServer / connection 服务从这里取）。
 * @param config - 校验后的组合配置。
 */
export function apply(ctx: RelayRouteContext, config?: MobileRelayConfig): void {
  // 语法与语义校验先于任何注册：坏配置装载即失败，不留下半挂的路由。
  if (config?.mobileOrigin !== undefined) assertMobileOrigin(config.mobileOrigin)
  assertMachines(config?.machines ?? [])
  registerHostsRoute(ctx)
}

/**
 * 注册 hosts 清单 exact 路由，走 DSH 插件的登记样式：
 * `ctx.effect(() => ctx.webServer.register(...))`。先过官方 admit（与
 * 官方 /api 同一面），拒绝分支短体固定——401 'unauthorized'，其余
 * 'forbidden'。占位应答空清单，Task 7 换成真实的 tailnet 发现结果。
 */
function registerHostsRoute(ctx: RelayRouteContext): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RELAY_HOSTS_PATH,
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
          const body = '{"hosts":[]}'
          res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          })
          res.end(body)
        },
      }),
    'threadharbor-mobile-relay: hosts placeholder route',
  )
}
