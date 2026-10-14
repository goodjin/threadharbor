/**
 * peers 接口：手机端取本 tailnet 的机器清单，并标注哪台在跑 DSH。
 *
 * 准入与官方 /api 同一面（同 pair-url 路由的写法）：`connection.admit(req)`
 * 拒绝时状态码原样写出，短体固定——401 'unauthorized'，其余 'forbidden'。
 * 准入后查 tailnet——复用联邦包的 `queryTailscalePeers`（与各主机面板的
 * 写入桥同一份 exec + 解析）——再并发探测各 peer 的 hello 标记
 * （`https://<dnsName>/threadharbor/mobile/hello`，2s 超时，结果缓存 5s）：
 * HTTP 200 才算 dsh:true，其余一切（非 200、拒绝、悬挂、名字铸不出合法
 * 网址）一律 dsh:false，绝不阻塞应答。tailscale 查询失败或悬挂（3s 到点）
 * 也是 200：error 字段带原因、peers 为空——桥的「失败不抛」约定在接口层
 * 原样兑现。
 *
 * 探测的 fetch 是模块级可替换变量（{@link swapProbeFetch}）：生产用全局
 * fetch，测试换假件；换 fetch 时连缓存一起清——上一只探测器的结果出处已变，
 * 留着会让下一条请求吃到别的账。
 */

import { queryTailscalePeers } from '@threadharbor/dsh-host-federation/tailscale'
import type { TailscalePeer, TailscaleStatusRun } from '@threadharbor/dsh-host-federation/tailscale'
import type { ServerResponse } from 'node:http'
import { HELLO_PATH, type MobileRouteContext } from './static-serve.ts'

/** peers 的 exact 路由路径；手机端按这个常量取清单。 */
export const PEERS_PATH = '/threadharbor/mobile/peers'

/** 单台探测的预算；到点即判假，不让一台死机拖住整个应答。 */
const PROBE_TIMEOUT_MS = 2000

/** 探测结果的缓存时长；手机页轮询不必每一拍都打一遍全网。 */
const PROBE_CACHE_MS = 5000

/** tailscale 查询的预算；CLI 悬挂时按失败处置，接口绝不悬着。 */
const TAILSCALE_TIMEOUT_MS = 3000

/** 探测用的最小 fetch 面：地址 + 超时信号进，回来只看状态码。 */
export type DshProbeFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>

/** 模块级可替换的探测 fetch：生产走全局 fetch，测试换假件。 */
let probeFetch: DshProbeFetch = (url, init) => globalThis.fetch(url, init)

/** 探测缓存：dnsName → 结果与落账时刻。 */
const probeCache = new Map<string, { at: number; dsh: boolean }>()

/**
 * 换探测 fetch（测试注入假件）。缓存一并清空：换探测器意味着旧的 dsh
 * 标记出处已变，留着会让下一条请求吃到上一只探测器的账。
 */
export function swapProbeFetch(next: DshProbeFetch): void {
  probeFetch = next
  probeCache.clear()
}

/** 注册时可选的注入面；生产空着，测试换假 run（tailnet 查询不跑真命令）。 */
export interface PeersRouteDeps {
  /** 传给 queryTailscalePeers 的命令执行面；缺省走真 execFile。 */
  run?: TailscaleStatusRun
}

/**
 * 注册 peers exact 路由，走 DSH 插件的登记样式：
 * `ctx.effect(() => ctx.webServer.register(...))`。
 *
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param deps - 可选注入面；缺省时 tailscale 查询用真 execFile。
 */
export function registerPeersRoute(ctx: MobileRouteContext, deps: PeersRouteDeps = {}): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PEERS_PATH,
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
          const { peers, error } = await queryTailnet(deps.run)
          const bodies = await withDshMarks(peers)
          respondJson(res, 200, JSON.stringify(error === undefined ? { peers: bodies } : { peers: bodies, error }))
        },
      }),
    'threadharbor-mobile-entry: peers route',
  )
}

/** 应答里一台 peer 的形状。 */
type PeerBody = { dnsName: string; online: boolean; dsh: boolean }

/** 清单折成应答形状，dsh 探测全网并发：Promise.allSettled 兜底，谁都不拖住谁。 */
async function withDshMarks(peers: readonly TailscalePeer[]): Promise<readonly PeerBody[]> {
  const settled = await Promise.allSettled(peers.map(peer => probeDshCached(peer.name)))
  return peers.map((peer, index) => {
    const outcome = settled[index]
    return {
      dnsName: peer.name,
      online: peer.online,
      dsh: outcome?.status === 'fulfilled' ? outcome.value : false,
    }
  })
}

/** 带 5s 缓存的探测：缓存里还年轻的结果直接用，过期的重新打。 */
async function probeDshCached(dnsName: string): Promise<boolean> {
  const cached = probeCache.get(dnsName)
  if (cached !== undefined && Date.now() - cached.at < PROBE_CACHE_MS) return cached.dsh
  const dsh = await probeDsh(dnsName)
  probeCache.set(dnsName, { at: Date.now(), dsh })
  return dsh
}

/**
 * 探测一台机器的 hello 标记：HTTP 200 才是 dsh:true。2s 预算双保险——
 * race 到点就判假（假 fetch 不理信号也有底），AbortSignal 顺手掐断真网络
 * 里还挂着的那只请求。
 */
async function probeDsh(dnsName: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probeFetch(`https://${dnsName}${HELLO_PATH}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        .then(res => res.status === 200),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS)
      }),
    ])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 查一次 tailnet：3s 到点按失败处置；一切抛出都折成 error 字段，接口不甩 500。 */
async function queryTailnet(
  run: TailscaleStatusRun | undefined,
): Promise<{ peers: readonly TailscalePeer[]; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      queryTailscalePeers(run),
      new Promise<{ peers: readonly TailscalePeer[]; error: string }>(resolve => {
        timer = setTimeout(
          () => resolve({ peers: [], error: `tailscale 查询超时（${TAILSCALE_TIMEOUT_MS / 1000}s）：CLI 无响应，按空清单处置` }),
          TAILSCALE_TIMEOUT_MS,
        )
      }),
    ])
  } catch (error) {
    return { peers: [], error: `tailscale 查询失败：${messageOf(error)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** JSON 应答：no-store（清单跟着 tailnet 变，不许被任何一环缓存）+ 固定长度。 */
function respondJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
