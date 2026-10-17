/**
 * 远端读数的线上形状：向一台已部署主机读到的事实，以及把它从任意 JSON 里
 * 解出来的唯一入口。
 *
 * 两个词表（RemoteDeployment / RemoteLiveness）只在这里声明一份：面板的
 * 状态推导（dsh-client 的 host-state.ts）从这里转出同名别名，登记簿的
 * remote 字段也存这个形状——别处比较的字符串必须是同一批字面量，词面分叉
 * 一次，状态词就会说一次谎。
 *
 * 解析刻意不对称：单个字段宽容——认不出的枚举值降级成 unknown、坏端口只
 * 丢自己，因为一个坏字段不该否定一次真实发生过的读取；整条记录严格——
 * 不是对象、readAt 不是有限数字，就返回 undefined，宁可不显示，也不拿
 * 编造的时刻当真。
 *
 * 本模块是纯类型与纯解析，不碰 node 内建模块：根入口（index.ts）直接转出
 * 它，浏览器 bundle 会顺着根入口把它拖进去（先例同 tailscale-keys.ts）。
 */

/** 部署事实：那台主机上装没装对方的部署体。 */
export type RemoteDeployment = 'undeployed' | 'deployed' | 'unknown'

/** 存活事实：那台部署体此刻在不在跑。 */
export type RemoteLiveness = 'stopped' | 'running' | 'unknown'

/** 一次远端读取得到的事实快照；readAt 是读取发生的时刻，缺了它整条作废。 */
export type RemoteReport = {
  readonly deployment: RemoteDeployment
  readonly liveness: RemoteLiveness
  /** 对方对存活的补充说明；读不到就没有。 */
  readonly livenessNote?: string
  /** 对方网页端口；缺了或不在 1–65535 内就没有。 */
  readonly port?: number
  /** 对方给出的带 token 的完整入口 URL；读不到就没有。 */
  readonly launchUrl?: string
  readonly readAt: number
}

const DEPLOYMENTS: readonly string[] = ['undeployed', 'deployed', 'unknown']
const LIVENESS: readonly string[] = ['stopped', 'running', 'unknown']

const isUsablePort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/**
 * 把任意值读成一次远端读数。
 *
 * 单个字段坏只坏自己：认不出的 deployment / liveness 读成 unknown，
 * 1–65535 之外的 port 丢弃；readAt 不是有限数字、或输入根本不是对象时，
 * 整条返回 undefined。
 * @param value - 对方读数原本的样子，通常是 JSON.parse 的产物。
 * @returns 站得住的读数；站不住时 undefined。
 */
export function parseRemoteReport(value: unknown): RemoteReport | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const readAt = record['readAt']
  if (typeof readAt !== 'number' || !Number.isFinite(readAt)) return undefined
  const deployment = record['deployment']
  const liveness = record['liveness']
  const livenessNote = nonEmptyString(record['livenessNote'])
  const launchUrl = nonEmptyString(record['launchUrl'])
  return {
    deployment: typeof deployment === 'string' && DEPLOYMENTS.includes(deployment)
      ? deployment as RemoteDeployment
      : 'unknown',
    liveness: typeof liveness === 'string' && LIVENESS.includes(liveness)
      ? liveness as RemoteLiveness
      : 'unknown',
    ...(livenessNote === undefined ? {} : { livenessNote }),
    ...(isUsablePort(record['port']) ? { port: record['port'] } : {}),
    ...(launchUrl === undefined ? {} : { launchUrl }),
    readAt,
  }
}
