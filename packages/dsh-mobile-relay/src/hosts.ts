/**
 * 主机清单（云主机侧）：算出一台中转够得着哪些机器，各台什么状态。
 *
 * 两级来源：
 * - **发现**靠 Tailscale 列出 tailnet 对端（复用联邦包那份 exec + 解析）。
 *   但**只保留配置里登记过的 hostId**——tailnet 上的路由器、NAS、手机天然
 *   在列表里，它们没有 DSH，更没有 SSH 隧道可言。
 * - **可用性**靠经隧道探测各机 DSH 的 hello 标记。探测目标是隧道 origin
 *   （`http://127.0.0.1:<落盘端口>`）而不是 tailnet 地址：各机 DSH 只监听
 *   回环，也没有 `tailscale serve` 配置，隧道口是唯一能碰到 hello 的地方。
 *
 * 三条失败方向一律安全：tailscale 查询失败或悬挂 → 空清单 + error（不抛，
 * 上层照样 200）；隧道拉不起来 → 该机 reachable:false / running:false，
 * 其余机器不受影响；探测超时或非 200 → running:false。
 *
 * `credential` 只有两态（ok / missing），由凭据层 `resolve` 的结果直接得出。
 * 原计划里还有一态「曾失效已自愈」，但凭据层没有持久化的失效标记，那个状态
 * 当下无从判定——硬造一个永远为假的枚举比缺字段更糟：它会被读成「有信息」，
 * 真去读时只拿到假象。将来若凭据层补上持久标记，这里加一态很容易。
 */

import { queryTailscalePeers } from '@threadharbor/dsh-host-federation/tailscale'
import type { TailscalePeer, TailscaleStatusRun } from '@threadharbor/dsh-host-federation/tailscale'
import type { RelayMachineConfig } from './index.ts'

/** 清单 exact 路由的路径；手机端中转页按这个常量取可达机器清单。 */
export const RELAY_HOSTS_PATH = '/threadharbor/relay/hosts'

/**
 * hello 探测路径，硬编码在此并注释指回来源：`HELLO_PATH` 定义在
 * `packages/dsh-mobile-entry/src/static-serve.ts`，而那个包的 exports 只有
 * `.` 与 `./pair-url`，跨包取不到。为一个路径常量扩包导出面不值——仓库先例
 * 同样如此（`mobile/wire.js` 硬编码探针常量并在注释指回 `src/wire.ts`）。
 */
const HELLO_PATH = '/threadharbor/mobile/hello'

/** 单台探测的预算；到点即判假，不让一台死机拖住整个应答。 */
const PROBE_TIMEOUT_MS = 2000

/** 探测结果的缓存时长；手机页轮询不必每一拍都重新敲一遍隧道口。 */
const PROBE_CACHE_MS = 5000

/**
 * tailscale 查询的预算。联邦包的 `queryTailscalePeers` 默认执行器自己给 15s，
 * 机器侧样板因此在外层再兜 3s——这里照抄那条纪律：中转要的是「别让手机干等」，
 * 不是「拿到最终答案」。宁可按空清单处置。
 *
 * 注意这只兜住了 tailnet 查询这一步：拿隧道（真 SSH）与换凭据（读启动日志 +
 * 换令牌）各有自己的超时，不在 3s 内。端到端的应答时限归路由层管（那才是应答
 * 真正发出的地方），这里不假装整个清单都有界。
 */
const TAILSCALE_TIMEOUT_MS = 3000

/** 探测用的最小 fetch 面：地址 + 超时信号进，回来只看状态码。 */
export type HostProbeFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>

/** 隧道层的最小面（形如 TunnelPool）：给一台机器要稳定 origin。 */
export interface HostRegistryTunnels {
  ensure(
    machine: RelayMachineConfig,
  ): Promise<
    | { ok: true; handle: { hostId: string; localPort: number; origin: string } }
    | { ok: false; reason: 'fingerprint-unapproved' | 'ssh-failed'; detail: string }
  >
}

/** 凭据层的最小面（形如 MachineCredentials）：能换到就是 ok，换不到就是 missing。 */
export interface HostRegistryCredentials {
  resolve(
    hostId: string,
    origin: string,
    readLaunchUrl: () => Promise<string | undefined>,
  ): Promise<{ ok: true; cookie: string } | { ok: false; reason: string; detail?: string }>
}

/** 由装配层注入的面；生产真接，测试全换假件。 */
export interface HostRegistryDeps {
  /** 登记在配置里的机器（唯一权威：tailnet 上没登记的一律不进清单）。 */
  machines: readonly RelayMachineConfig[]
  tunnels: HostRegistryTunnels
  credentials: HostRegistryCredentials
  /**
   * 凭据自愈时要读的启动网址（经 SSH 读远端启动日志），按 hostId 给——
   * 各台机的日志路径不共用一个值，回调拿不到机器就无从查起。
   */
  readLaunchUrl: (hostId: string) => Promise<string | undefined>
  /**
   * 最后联系上的时刻的账（形如 StateStore）。缺省就不给 lastSeenAt：装配层
   * 没接这个面时，少一个标注胜过猜一个。
   */
  lastSeen?: {
    markSeen(hostId: string, at?: number): number
    lastSeenOf(hostId: string): number | undefined
  }
  /** tailscale 命令执行面；缺省走联邦包的真 execFile。 */
  run?: TailscaleStatusRun
  /** 探测用 fetch；缺省走全局 fetch。 */
  probeFetch?: HostProbeFetch
}

/**
 * 清单里一台机器的形状。
 *
 * `reason` / `detail` 是**给运维看的自报状态**：一台机器不可达时只有
 * reachable:false 是不够的——隧道没开出来、指纹没登记、凭据没换到，看上去
 * 几乎一模一样，现场只能靠猜。加一条短原因（枚举）+ 一句人话细节，
 * 手机只渲染 reason 对应的短文案，detail 不上手机。
 */
export type RelayHost = {
  readonly hostId: string
  readonly online: boolean
  readonly running: boolean
  readonly reachable: boolean
  readonly credential: 'ok' | 'missing'
  /** 不可达/凭据缺失的短原因枚举；一切正常时不出现。 */
  readonly reason?: 'fingerprint-unapproved' | 'ssh-failed' | 'credential-missing'
  /** 一句人话细节，给运维看；含目标与 stderr 片段，不含任何凭据。 */
  readonly detail?: string
  /**
   * 这台机器最后一次**真的联系上**的时刻（epoch 毫秒）。之前联系过但现在断了
   * 的机器才有它——手机上据此说「最后一次有动静是 3 分钟前」，把「离线很久」
   * 与「从来没成功过」分开。从没成功过就不带这个字段。
   */
  readonly lastSeenAt?: number
}

/** 没联系过就不带这个字段（别让手机显示「1970 年」）。 */
function lastSeenField(at: number | undefined): { lastSeenAt?: number } {
  return at === undefined ? {} : { lastSeenAt: at }
}

/** 清单结果；tailscale 查询失败时 hosts 为空、error 带原因（接口仍 200）。 */
export type RelayHostList = { readonly hosts: readonly RelayHost[]; readonly error?: string }

/**
 * 清单的算子。探测结果按 origin 带 5s 缓存（同一台机器的多次请求不吃重复
 * 探测），`invalidate()` 清空——换探测器、或刚处理完一台机器的状态变更后，
 * 清一次比等它自然过期省事。
 */
export class HostRegistry {
  private readonly deps: HostRegistryDeps
  private readonly probeCache = new Map<string, { at: number; running: boolean }>()

  constructor(deps: HostRegistryDeps) {
    this.deps = deps
  }

  /** 清掉探测缓存：上一批结果的出处已变，留着会让下一拍吃到旧的账。 */
  invalidate(): void {
    this.probeCache.clear()
  }

  /**
   * 算清单：tailnet 只查一次拿在线状态，再对登记过的机器并发要隧道、探 hello、
   * 换凭据。谁都不拖住谁，一台挂了其余照常入列。
   */
  async list(): Promise<RelayHostList> {
    const { peers, error } = await queryTailnet(this.deps.run)
    if (error !== undefined) return { hosts: [], error }

    const settled = await Promise.allSettled(this.deps.machines.map(machine => this.describe(machine, onlineOf(peers, machine.hostId))))
    return {
      hosts: settled.map((outcome, index) => {
        if (outcome?.status === 'fulfilled') return outcome.value
        // ensure/resolve 约定不抛，真抛了也不许把整机清单带下去——该机按最保守形状入列。
        const machine = this.deps.machines[index]!
        return {
          hostId: machine.hostId,
          online: onlineOf(peers, machine.hostId),
          running: false,
          reachable: false,
          credential: 'missing' as const,
        }
      }),
    }
  }

  /** 一台机器的完整状态：在线（tailnet）× 可达（隧道）× 在跑（hello）× 凭据。 */
  private async describe(machine: RelayMachineConfig, online: boolean): Promise<RelayHost> {
    const tunnel = await this.deps.tunnels.ensure(machine)
    if (!tunnel.ok) {
      // 隧道都拉不起来，凭据无从谈起：这时报「凭据缺失」是误导，如实说不可达。
      // 把原因带出去——不然这台机器「不可达」和「指纹没登记」在清单上长得一样。
      return {
        hostId: machine.hostId,
        online,
        running: false,
        reachable: false,
        credential: 'missing',
        reason: tunnel.reason,
        detail: tunnel.detail,
        ...lastSeenField(this.lastSeenOf(machine)),
      }
    }
    const { origin } = tunnel.handle
    const outcome = await this.deps.credentials.resolve(machine.hostId, origin, () => this.deps.readLaunchUrl(machine.hostId))
    const running = await this.probeHelloCached(origin)
    // 隧道通了但凭据没换到：这是**另一回事**（机器的 DSH 起来了，但我们进不去），
    // 必须与「隧道没开出来」区分开，否则两者的处置完全不同。
    if (!outcome.ok) {
      return {
        hostId: machine.hostId,
        online,
        running,
        reachable: true,
        credential: 'missing',
        reason: 'credential-missing',
        // 带上换凭据那一步的细节（如 HTTP 401/403）：「令牌被拒」与「解析不出
        // cookie」的处置完全相反，现场必须能一眼分开。
        detail: `机器 ${machine.hostId} 的凭据未就绪（${outcome.reason}${outcome.detail === undefined ? '' : `，${outcome.detail}`}）`,
        ...lastSeenField(this.lastSeenOf(machine)),
      }
    }
    // 联系上了就记一笔：这一拍之后它再断，手机上还能说出「最后一次是什么时候」。
    const lastSeenAt = this.deps.lastSeen?.markSeen(machine.hostId)
    return {
      hostId: machine.hostId,
      online,
      running,
      reachable: true,
      credential: 'ok',
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    }
  }

  /** 一台断掉的机器上一次被联系到是什么时候；没联系过就 undefined。 */
  private lastSeenOf(machine: RelayMachineConfig): number | undefined {
    return this.deps.lastSeen?.lastSeenOf(machine.hostId)
  }

  /** 带 5s 缓存的 hello 探测：缓存里还年轻的结果直接用，过期的重新探。 */
  private async probeHelloCached(origin: string): Promise<boolean> {
    const cached = this.probeCache.get(origin)
    if (cached !== undefined && Date.now() - cached.at < PROBE_CACHE_MS) return cached.running
    const running = await this.probeHello(origin)
    this.probeCache.set(origin, { at: Date.now(), running })
    return running
  }

  /**
   * 探一台机器的 hello：HTTP 200 才算在跑 DSH。2s 预算双保险——race 到点判假
   * （假 fetch 不理信号也有底），AbortSignal 顺手掐断真网络里还挂着的那只请求。
   */
  private async probeHello(origin: string): Promise<boolean> {
    const call = this.deps.probeFetch ?? ((url, init) => globalThis.fetch(url, init))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        call(`${origin}${HELLO_PATH}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then(res => res.status === 200),
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
}

/**
 * tailnet 里的这台在不在、在线不在线。
 *
 * 名字要对两次才认：配置里的 hostId 是短名（`gooddemacbook-pro`），而 tailnet
 * 回的是 MagicDNS 全名（`gooddemacbook-pro.tailb6790d.ts.net`）——只按全名比对
 * 会把所有机器都判成「不在 tailnet 上」，在线状态永远假、页面看着像断线。认全名
 * 或认首段都算命中，是为了让配置写法保持人类可读。
 *
 * 查不到按离线（fail-safe，不是 fail-open）：宁可显示离线叫人看一眼，也不要显示
 * 在线却根本发不出请求。
 */
function onlineOf(peers: readonly TailscalePeer[], hostId: string): boolean {
  const peer = peers.find(entry => entry.name === hostId || entry.name.split('.')[0] === hostId)
  return peer?.online ?? false
}

/** 查一次 tailnet：3s 到点按失败处置；一切抛出都折成 error 字段。 */
async function queryTailnet(run: TailscaleStatusRun | undefined): Promise<{ peers: readonly TailscalePeer[]; error?: string }> {
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
