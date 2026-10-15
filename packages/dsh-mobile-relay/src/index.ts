/**
 * 手机中转（云主机侧）。
 *
 * 这个包跑在有公网 HTTPS 的云主机上：手机从公网访问它，它经 SSH 隧道把
 * 请求代理到各台机器的 DSH。装载器读到的是 `name` / `inject` / `Config` /
 * `apply` 四件套，组合行（cordis.patch.yml 的 threadharbor-mobile-relay）
 * 指向这里。已装上 `/threadharbor/relay/hosts`：tailnet 发现（只认配置里登记过的机器）、
 * 隧道可用性、经隧道的 hello 探测与凭据自愈。静态壳与转发面在后续任务接上——
 * 把静态服务签名变更混进来会让评审范围变浑，所以壳留到它的归属任务。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import Schema from '@deepseek-ai/schemastery'
import { assertMobileOrigin, MOBILE_ORIGIN_PATTERN } from '@threadharbor/dsh-mobile-entry/pair-url'
import { HostRegistry, RELAY_HOSTS_PATH, type HostRegistryDeps, type RelayHost } from './hosts.ts'
import { Relay, RELAY_ANSWER_PATH, RELAY_EVENTS_PATH, RELAY_SESSIONS_PATH } from './relay.ts'
import { RelayClientPool } from './client-pool.ts'
import { TunnelPool, type TunnelEnsureResult } from './tunnels.ts'
import { CredentialStore, MachineCredentials } from './credentials.ts'
import type { SshConnectionConfig } from '@threadharbor/dsh-host-federation/ssh/types'
import { DshSshManager } from '@threadharbor/dsh-host-federation/ssh/manager'
import { WebSocketServer } from 'ws'

export { RELAY_HOSTS_PATH } from './hosts.ts'
export { RELAY_ANSWER_PATH, RELAY_EVENTS_PATH, RELAY_SESSIONS_PATH, Relay } from './relay.ts'

export const name = 'threadharbor-mobile-relay'

/**
 * 事件面共用的 ws 服务端（noServer：握手由插件自己那三道门决定）。
 * 每个进程一个足够——noServer 模式下它不监听端口，只是握手的状态机。
 */
let eventSocketServer: WebSocketServer | undefined
function getEventSocketServer(): WebSocketServer | undefined {
  if (eventSocketServer === undefined) eventSocketServer = new WebSocketServer({ noServer: true })
  return eventSocketServer
}

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
  /**
   * 该机 DSH 的启动日志路径（要**追加**写的那份，含 `LAUNCH_URL=` 标记）。
   * 每台不一样（用户、服务名、部署通道都可能不同），所以必填而不给默认值——
   * 猜一个默认值等于让凭据自愈对着错文件 grep，然后报「连不上」。
   */
  readonly logPath: string
}

/** apply 收到的组合配置形状（Config 的解析结果）；四个字段全都必填，缺一即拒装载（理由见 apply）。 */
export interface MobileRelayConfig {
  readonly mobileOrigin: string
  readonly sshKnownHostsPath: string
  readonly statePath: string
  readonly machines: readonly RelayMachineConfig[]
}


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
    /**
     * WebSocket 升级登记（可选面：没它就不挂事件流，其余 HTTP 面照常）。
     *
     * handler 的签名与宿主 WebUpgradeRoute 一致：`(req, socket, head)`。
     * **req 不能省**——准入、方法和 origin 绑定三道门全靠它，少一道就是给
     * 事件流留了一条绕开配对的旁门（事件流承载全部机器的会话内容与审批）。
     */
    registerUpgrade?(route: {
      path: string
      handler: (req: unknown, socket: unknown, head: unknown) => void | Promise<void>
    }): () => void
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
  mobileOrigin: Schema.string().pattern(MOBILE_ORIGIN_PATTERN).required().description('中转站对外服务的源（如 https://relay.example.com）'),
  sshKnownHostsPath: Schema.string().pattern(/.+/).required().description('SSH known_hosts 路径（校验各机主机指纹）'),
  statePath: Schema.string().pattern(/.+/).required().description('凭据与端口分配的家目录文件路径'),
  machines: Schema.array(
    Schema.object({
      hostId: Schema.string().pattern(/^\S+$/).required().description('tailnet DNS 名（如 gooddemacbook-pro）'),
      target: Schema.string().pattern(/^\S+$/).required().description('SSH 目标（IP 或名字）'),
      port: Schema.number().min(1).max(65535).step(1).description('SSH 端口，缺省 22'),
      user: Schema.string().description('SSH 用户'),
      identityFile: Schema.string().description('私钥绝对路径'),
      remotePort: Schema.number().min(1).max(65535).step(1).required().description('该机 DSH 的回环端口（如 3081）'),
      logPath: Schema.string().pattern(/^\S+$/).required().description('该机 DSH 的启动日志路径（追加写、含 LAUNCH_URL= 标记）'),
    }),
  ).required().description('各台机器的隧道目标清单'),
})

/**
 * 会被拼进远端 shell 的字段，装载期再挡一道。
 *
 * schema 的「非空无空白」挡不住 `;`、反引号、`$()`、换行——这些值之后要进
 * `ssh <target> grep ... <logPath>` 这类命令行，漏进去就是一次任意命令执行。
 * 这里用**正字白名单**而不是禁字符表：禁字符表要靠人记得列全（`~` 一度就被误
 * 拦，而它是日志路径的常态）；正字表多写一个字符就放行一次，也得人记得列全——
 * 但列全的是「合法字符集」，比列全「所有危险字符」可靠得多，多半也不会误伤。
 * `~` 放行是有意的：manager 会把开头的 `~/` 改写成远端双引号形式，交给远端展开。
 */
const SHELL_SAFE_TARGET = /^[A-Za-z0-9._:[\]-]+$/
const SHELL_SAFE_USER = /^[A-Za-z0-9._-]+$/
const SHELL_SAFE_PATH = /^[A-Za-z0-9._~/:+-]+$/

function assertShellSafe(value: string | undefined, label: string, pattern: RegExp): void {
  if (value === undefined) return
  if (!pattern.test(value)) {
    throw new Error(`${label} 含 shell 元字符，拒绝装载：${value}`)
  }
}


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
function assertMachines(machines: readonly RelayMachineConfig[], sshKnownHostsPath: string | undefined): void {
  const seen = new Set<string>()
  for (const machine of machines) {
    assertHostId(machine.hostId)
    if (seen.has(machine.hostId)) {
      throw new Error(`machines 里 hostId 重复：${machine.hostId}`)
    }
    seen.add(machine.hostId)
    // target/user/identityFile/logPath 都要进远端命令行，逐个过白名单。
    assertShellSafe(machine.target, `${machine.hostId} 的 target`, SHELL_SAFE_TARGET)
    assertShellSafe(machine.user, `${machine.hostId} 的 user`, SHELL_SAFE_USER)
    assertShellSafe(machine.identityFile, `${machine.hostId} 的 identityFile`, SHELL_SAFE_PATH)
    assertShellSafe(machine.logPath, `${machine.hostId} 的 logPath`, SHELL_SAFE_PATH)
  }
  assertShellSafe(sshKnownHostsPath, 'sshKnownHostsPath', SHELL_SAFE_PATH)
}

/**
 * 装配时用到的 SSH 面（生产是联邦包的 DshSshManager，测试换假件）。
 * 声明成最小面而不是直接依赖具体类：装配只碰这两个方法，
 * 也免得为了两个方法把整个 manager 的构造参数搬进中转的配置面。
 */
export interface RelaySshFacade {
  ensureTunnel(config: SshConnectionConfig, remotePort: number, opts?: { readonly localPort?: number }): Promise<string>
  readLaunchUrl(config: SshConnectionConfig, remoteLogPath: string, timeoutMs?: number): Promise<string | undefined>
}

/**
 * apply 的第三参：只在单测里注入的窄缝，生产不传。
 *
 * 之所以开缝：真实装配要真连 SSH、真读 known_hosts、真探测网络，单测里一件
 * 都不该发生；但「隧道池落盘的端口有没有原样传到 SSH 层」这种接线正确性，
 * 又必须用真代码路径验出来——它正是上一版差点让整条链路静默失效的地方。
 * 缝开在**装配的输入面**（SSH 面、tailnet 对端、探测结果），不在被验的逻辑里。
 */
export interface RelayAssemblyDeps {
  /** SSH 面；缺省由装配处构造联邦包的 manager。 */
  ssh?: RelaySshFacade
  /** tailnet 对端假件；缺省走真 tailscale 命令。 */
  tailscalePeers?: readonly { readonly name: string; readonly online: boolean }[]
  /** 探测假件；缺省走全局 fetch。 */
  probeStatus?: number
  /** 整份清单的端到端时限；缺省 10 秒。 */
  listTimeoutMs?: number
  /** 清单算子替身；缺省按上面三件真装配。 */
  registry?: { list(): Promise<{ hosts: readonly RelayHost[]; error?: string }>; invalidate(): void }
}

/** 整份清单的端到端时限；到点按空清单 + error 应答，绝不把手机吊着。 */
const LIST_TIMEOUT_MS = 10_000

/**
 * 挂载入口：装配隧道池、凭据层、清单算子，注册 hosts 清单 exact 路由。
 * @param ctx - 宿主上下文（effect / webServer / connection 服务从这里取）。
 * @param config - 校验后的组合配置。
 * @param deps - 仅单测注入的窄缝，生产不传。
 */
export function apply(ctx: RelayRouteContext, config?: MobileRelayConfig, deps: RelayAssemblyDeps = {}): void {
  // 语义校验先于任何注册：坏配置装载即失败，不留下半挂的路由。
  // null 也在这里挡住：`typeof null === 'object'`，漏了它会以「访问 undefined 的
  // hostKeyFingerprint」这种天书报错收场，而不是告诉运维缺配置。
  if (config === undefined || config === null || typeof config !== 'object') {
    // 组合行没给 config 块时宿主传什么（undefined 还是空对象）我们没在真机上量过，
    // 与其为它赌一种形状，不如两种都挡住并说清缺什么——装载失败时人要看得懂
    // 缺的是哪个字段，而不是看一个 `dirname(undefined)` 的 TypeError。
    throw new Error('threadharbor-mobile-relay 缺配置：中转站必须声明 mobileOrigin / sshKnownHostsPath / statePath / machines')
  }
  const { mobileOrigin, sshKnownHostsPath, statePath, machines } = config
  if (mobileOrigin === undefined || sshKnownHostsPath === undefined || statePath === undefined || machines === undefined) {
    const missing = [mobileOrigin, sshKnownHostsPath, statePath, machines].findIndex(value => value === undefined)
    throw new Error(`threadharbor-mobile-relay 缺配置字段 ${['mobileOrigin', 'sshKnownHostsPath', 'statePath', 'machines'][missing]}：四项全部必填`)
  }
  if (mobileOrigin === '') {
    // 没有 origin 就没法做 origin 绑定（请求 Host 对不上也放行等于门户大开），
    // 而一个说不清自己对外源的中转站本来也不该上线——拒装载，不给默认值兜。
    throw new Error('threadharbor-mobile-relay 缺 mobileOrigin：中转站必须声明对外服务的源（如 https://relay.example.com），没有它无法做 origin 绑定')
  }
  assertMobileOrigin(mobileOrigin)
  assertMachines(machines, sshKnownHostsPath)
  // 清单与转发共用**同一份** runtime（隧道池、凭据层、SSH 面各一份）：
  // 两份池子会各自读盘、各自分配端口，第一台机器在两边拿到不同的号，凭据绑定
  // 的 authority 与真实监听口就此分家——表现是「某台机器恒 401，自愈也救不
  // 回来」，而现场看着像网络问题。
  const runtime = deps.registry === undefined ? buildRuntime(config, deps) : undefined
  const registry = deps.registry ?? new HostRegistry(buildRegistryDeps(config, deps, runtime!))
  // 比 hostname 不比 host：`URL.host` 会保留非默认端口（https://x:8443 → x:8443），
  // 而反代透传的 Host 头在默认端口下不带端口——那样配的站点会被整站 403。
  // 端口不参与比对：中转对外只有一个入口，端口由反代终结，写进配置反而多一处
  // 能配错的地方（真要非默认端口，直接在反代上终结掉）。
  registerHostsRoute(ctx, registry, new URL(mobileOrigin).hostname, deps.listTimeoutMs ?? LIST_TIMEOUT_MS)
  // 转发面（Task 8）：清单之外的请求都走这里。装配不出 TunnelPool 的场合
  // （测试替身）就只挂清单——半套转发面比没有更难排查。
  if (runtime !== undefined) {
    // 内部故障的落点。手机侧只拿到有界的 {error:'machine-error'}，细节在这里。
    // 落点选 console 而非 ctx.logger：DSH 的 logger 输出不进那份运维真正在
    // 读的追加日志（真机实测：日志文件里搜不到 logger 写的字），而插件的
    // console 输出就在里面。细节丢了等于没写。
    const log = (message: string): void => { console.warn(message) }
    registerHubRoutes(ctx, buildRelay(config, runtime, log), new URL(mobileOrigin).hostname)
  }
}

/**
 * 把清单层已经建好的隧道池与凭据层交给转发面：每台机器一个客户端，
 * origin 就是该机隧道在云主机侧的落点（与凭据绑定的 authority 同一个号）。
 *
 * 这里刻意复用同一份 `tunnelDeps`/`credentialStore`，而不是再各建一个——两份
 * 池子会各自读盘、各自分配端口，配额会在两次分配之间分裂，表现是「某台机器
 * 偶尔 401，自愈也救不回来」。
 */
function buildRelay(config: MobileRelayConfig, runtime: RelayRuntime, log?: (message: string) => void): Relay {
  const { tunnels, credentials, readLaunchUrl } = runtime
  const pool = new RelayClientPool(
    config.machines.map(machine => ({
      hostId: machine.hostId,
      resolve: async () => {
        // 端口向池子要，不自己算：落盘号是唯一真相（见本文件头部注释）。
        const ensured = await tunnels.ensure(machine)
        if (!ensured.ok) throw new Error(`机器 ${machine.hostId} 现在开不出隧道（${ensured.reason}：${ensured.detail}）`)
        const origin = ensured.handle.origin
        return {
          origin,
          // 凭据自愈要能读启动网址，回源办法与清单层共用同一份隧道句柄。
          getCookie: async () => {
            const outcome = await credentials.resolve(machine.hostId, origin, () => readLaunchUrl(machine.hostId))
            return outcome.ok ? { ok: true as const, cookie: outcome.cookie } : { ok: false as const, reason: outcome.reason }
          },
        }
      },
    })),
  )
  // 401 自愈的接线点：上游 401 说明 cookie 已被对端作废（那台 DSH 重启过），
  // 必须**判脏到凭据层**，否则 resolve 的缓存与盘上条目一直是坏 cookie：
  // 401 → 重建客户端 → 同一个坏 cookie → 恒 401，重启中转也恢复不了。
  // onCredentialStale 里 invalidate 同时清内存缓存与盘上条目（credentials.ts）。
  return new Relay({
    knownHostIds: new Set(config.machines.map(machine => machine.hostId)),
    ...(log === undefined ? {} : { log }),
    clients: pool,
    onCredentialStale: hostId => credentials.invalidate(hostId),
  })
}

/**
 * 进程内共用的那几件真件：SSH 面、隧道池、凭据层、按 hostId 的机器表，
 * 以及凭据自愈要用的读启动网址。
 *
 * 清单层与转发层共用同一份（见 apply 里的注释）：这是端口唯一真相的前提。
 */
interface RelayRuntime {
  ssh: RelaySshFacade
  tunnels: TunnelPool
  credentials: MachineCredentials
  byHost: ReadonlyMap<string, RelayMachineConfig>
  readLaunchUrl(hostId: string): Promise<string | undefined>
}

function buildRuntime(config: MobileRelayConfig, deps: RelayAssemblyDeps): RelayRuntime {
  const ssh = deps.ssh ?? createSshFacade(config.sshKnownHostsPath)
  const tunnels = new TunnelPool(
    config.statePath,
    // 箭头函数保住 this：manager 的方法取出来裸传会丢接收者。
    { ensureTunnel: (connection, remotePort, opts) => ssh.ensureTunnel(connection, remotePort, opts) },
    config.sshKnownHostsPath,
  )
  const credentials = new MachineCredentials(new CredentialStore(config.statePath))
  const byHost = new Map(config.machines.map(machine => [machine.hostId, machine]))
  const readLaunchUrl = async (hostId: string): Promise<string | undefined> => {
    const machine = byHost.get(hostId)
    if (machine === undefined) return undefined
    // 指纹未登记时池子不给连接配置，这里也就读不到启动日志——如实交白卷，
    // 由上层把「需先确认指纹」和「凭据需更新」两件事分开说。
    const connection = tunnels.connectionFor(machine)
    if (connection === undefined) return undefined
    // 显式给超时，不吃 SSH 层的默认 10s：读启动日志只是一次 grep，不值得占掉
    // 整份清单的时间预算。
    return await ssh.readLaunchUrl(connection, machine.logPath, 3_000)
  }
  return { ssh, tunnels, credentials, byHost, readLaunchUrl }
}

/**
 * 装配清单算子要吃的面：隧道池与凭据层是真件，SSH 面按需注入。
 *
 * 端口这件事在这里合拢：池子按 hostId 固定分配并落盘，再把**同一个号**交给
 * SSH 层去开转发。凭据绑定的 authority（`127.0.0.1:<落盘号>`）必须与真实监听
 * 口是同一个号——分家之后每次请求都 401，自愈也救不回来，而且现场看着像
 * 「网络问题」，极难定位。
 */
function buildRegistryDeps(
  config: MobileRelayConfig,
  deps: RelayAssemblyDeps,
  runtime: RelayRuntime,
): HostRegistryDeps {
  const { tunnels, credentials, readLaunchUrl } = runtime
  // 缝的覆盖项**逐个并入**同一份依赖，不做「命中即早退」：早退会让后面的缝
  // 静默失效——测试里两条缝一起传，第二条形同虚设，而真网络恰好快速失败，
  // 断言照样绿。宁可多写两行，也不要留一个会静默吃掉参数的缝。
  const overrides: Partial<HostRegistryDeps> = {}
  if (deps.tailscalePeers !== undefined) {
    // 缝给的是「对端列表」，但清单层要的是命令执行面——中间仍走联邦包那份真
    // 解析器（MagicDNS 全名去尾点、Online 布尔、100.x 首地址这些规则都在那边）。
    // 绕开解析器造假输出，等于让用例验证的是另一条代码路径。
    const peers = deps.tailscalePeers
    overrides.run = async () => ({
      stdout: JSON.stringify({
        BackendState: 'Running',
        Peer: Object.fromEntries(peers.map((peer, index) => [
          `peer${index}`,
          { DNSName: `${peer.name}.ts.net.`, HostName: peer.name, TailscaleIPs: ['100.64.0.1'], Online: peer.online, Active: peer.online },
        ])),
      }),
    })
  }
  if (deps.probeStatus !== undefined) {
    const status = deps.probeStatus
    overrides.probeFetch = async () => ({ status })
  }
  return { machines: config.machines, tunnels, credentials, readLaunchUrl, ...overrides }
}

/** 生产用的 SSH 面：联邦包那个 manager（隧道与读启动日志都归它）。 */
function createSshFacade(knownHostsPath: string): RelaySshFacade {
  const manager = new DshSshManager({
    knownHostsPath,
    // 3s：单台机的 SSH 往返要压在清单 deadline 的三分之一以内——一台黑洞型失联
    // 的机器（休眠笔记本、防火墙丢包）慢到什么程度，都不能把整份清单拖到超时。
    connectTimeoutMs: 3_000,
    installTimeoutMs: 120_000,
    deploymentChannel: 'mobile-relay',
    defaultRemoteWebPort: 3081,
  })
  return {
    ensureTunnel: (config, remotePort, opts) => manager.ensureTunnel(config, remotePort, opts),
    readLaunchUrl: (config, remoteLogPath, timeoutMs) => manager.readLaunchUrl(config, remoteLogPath, timeoutMs),
  }
}

/**
 * 注册 hosts 清单 exact 路由，走 DSH 插件的登记样式：
 * `ctx.effect(() => ctx.webServer.register(...))`。
 *
 * 四道门按固定次序：admit（与官方 /api 同一面，拒绝分支短体固定）→ 方法 →
 * **origin 绑定** → 端到端时限。第三道是中转自己的：请求的 Host 与配置声明的
 * origin 不符就拒，否则同一个中转换个 Host 头也能被取走清单，origin 与凭据的
 * 绑定就名存实亡了（Host 大小写不敏感，比较时统一小写）。
 */
function registerHostsRoute(
  ctx: RelayRouteContext,
  registry: { list(): Promise<{ hosts: readonly RelayHost[]; error?: string }>; invalidate(): void },
  originHost: string,
  timeoutMs: number,
): void {
  const expected = originHost.toLowerCase()
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RELAY_HOSTS_PATH,
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
          const host = req.headers.host
          if (typeof host !== 'string' || host.toLowerCase() !== expected) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('forbidden')
            return
          }
          const result = await listWithDeadline(registry, timeoutMs)
          respondJson(res, 200, JSON.stringify(result))
        },
      }),
    'threadharbor-mobile-relay: hosts route',
  )
}

/**
 * 转发面的路由登记（Task 8）：清单之外的手机请求都在这里。
 *
 * 前三道门与 hosts 清单完全一致（admit → 方法 → origin 绑定），不多也不少：
 * 手机走的是同一个公网入口，凭据也绑在同一个 origin 上，只给其中一部分接口
 * 加门等于给攻击者留一条绕路的旁门。origin 绑定排在方法之后，是因为拒绝分支
 * 的短体要与官方 /api 一致（admit 先答），而 origin 是中转自己的判断。
 *
 * 会话类接口用 prefix 登记（webServer.register 只有 exact/prefix，没有路径
 * 参数），真正的形状校验在 Relay.parse 里做——段数、hostId 登记、sid 白名单、
 * 动作段四道一起过才放行。
 */
function registerHubRoutes(ctx: RelayRouteContext, relay: Relay, originHost: string): void {
  const expected = originHost.toLowerCase()
  relay.attachClients()

  type Req = { method?: string | undefined; url?: string | undefined; headers?: Record<string, string | string[] | undefined> | undefined }
  type Res = { writeHead(status: number, headers?: Record<string, string | number | string[]>): void; end(chunk?: string): void }

  /**
   * 前三道门：admit（与官方 /api 同一面，拒绝分支短体固定）→ 方法 → origin 绑定。
   * 返回 true 才放行。少一道就是给攻击者留一条绕路的旁门，所以与 hosts 清单
   * 用的是同一套次序与同样的短体。
   */
  const gate = (req: Req, res: Res, allow: string): boolean => {
    const admission = ctx.connection.admit(req as never)
    if ('rejection' in admission) {
      res.writeHead(admission.rejection)
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      return false
    }
    if ((req.method ?? 'GET') !== allow) {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow })
      res.end('method not allowed')
      return false
    }
    const host = req.headers?.host
    if (typeof host !== 'string' || host.toLowerCase() !== expected) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return false
    }
    return true
  }

  /**
   * 握手与帧：把裸 TCP 交给 ws 的 noServer 模式，由它写 101 并接管帧编解码。
   *
   * 这一层以前是缺的——处理器直接把裸 socket 当 WebSocket 用，写的不是帧、
   * 也没有 101，于是手机侧永远「连接中」。协议（ready / item）仍在 Relay 里。
   * ws 是本包已声明的依赖（客户端那一侧在用），这里只是同一个库的第二种用法。
   */
  const upgradeFace = (req: Req, socket: unknown, head: unknown, relay: Relay): void => {
    const wss = getEventSocketServer()
    if (wss === undefined) {
      // ws 不可用（装载环境缺依赖）：毁掉连接，而不是让它半死不活地挂着。
      ;(socket as { destroy?: () => void }).destroy?.()
      return
    }
    wss.handleUpgrade(
      req as never,
      socket as never,
      head as Buffer,
      ws => { relay.connectEvents(ws as never) },
    )
  }

  /** 与 {@link gate} 同序同条件的升级面版本，只是拒绝方式换成 destroy。 */
  const upgradeGate = (req: Req): boolean => {
    const admission = ctx.connection.admit(req as never)
    if ('rejection' in admission) return false
    if ((req.method ?? 'GET') !== 'GET') return false
    const host = req.headers?.host
    return typeof host === 'string' && host.toLowerCase() === expected
  }

  const register = (path: string, method: 'GET' | 'POST', label: string, handler: (req: Req, res: Res, url: URL) => Promise<void>) => {
    // 前缀自带尾斜杠会让宿主的 `startsWith(prefix + '/')` 永远不成立（见
    // RELAY_SESSIONS_PATH 的注释）。这条断言把「登记形状对不对」挡在装载期，
    // 而不是等到真机上一次 404 才想起查路由表。
    if (path.endsWith('/')) throw new Error(`中转前缀路由不能以斜杠结尾（会永不命中）：${path}`)
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path,
          async handler(req, res) {
            const typedReq = req as unknown as Req
            if (!gate(typedReq, res as unknown as Res, method)) return
            await handler(typedReq, res as unknown as Res, new URL(req.url ?? path, 'http://relay.invalid'))
          },
        }),
      `threadharbor-mobile-relay: ${label}`,
    )
  }

  // 会话类接口共用一个 prefix 登记，形状（哪一段是动作）在 Relay.parse 里判。
  register(RELAY_SESSIONS_PATH, 'GET', 'sessions', (req, res, url) => {
    if (url.pathname.endsWith('/prompt')) return relay.handlePrompt(req, res, url)
    if (url.pathname.endsWith('/cancel')) return relay.handleCancel(req, res, url)
    if (url.pathname.endsWith('/messages')) return relay.handleMessages(req, res, url)
    return relay.handleSessions(req, res, url)
  })
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RELAY_ANSWER_PATH,
        async handler(req, res) {
          const typedReq = req as unknown as Req
          if (!gate(typedReq, res as unknown as Res, 'POST')) return
          await relay.handleAnswer(typedReq, res as unknown as Res)
        },
      }),
    'threadharbor-mobile-relay: answer',
  )
  // 事件流：宿主没给升级面就只留 HTTP 面——手机会看到「事件流不可用」，
  // 而不是整个中转起不来。
  ctx.webServer.registerUpgrade?.({
    path: RELAY_EVENTS_PATH,
    // 与 HTTP 面同一套三道门，顺序也一致：admit → 方法 → origin 绑定。
    // 升级面没有 res 可写状态码，过关的方式是**直接毁掉 socket**：握手还没
    // 完成，此刻不回帧就是最干净的拒绝。
    handler: (req, socket, head) => {
      const typedReq = req as Req
      // 三道门先过：升级面没有 res 可写状态码，握手还没完成，此刻不回帧就是
      // 最干净的拒绝（直接毁掉 socket）。
      if (!upgradeGate(typedReq)) {
        ;(socket as { destroy?: () => void }).destroy?.()
        return
      }
      upgradeFace(typedReq, socket, head, relay)
    },
  })
}

/**
 * 端到端时限：清单算子内部只给 tailnet 查询与 hello 探测各兜了预算，拿隧道
 * （真 SSH）与换凭据（读日志 + 换令牌）各有自己的超时，不在同一个 3s 内。应答
 * 的时限只能在这里兜——到点按空清单 + error 应答（200），让手机看到「暂时拿不到」
 * 而不是一直转圈。
 */
async function listWithDeadline(
  registry: { list(): Promise<{ hosts: readonly RelayHost[]; error?: string }> },
  timeoutMs: number,
): Promise<{ hosts: readonly RelayHost[]; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      registry.list(),
      new Promise<{ hosts: readonly RelayHost[]; error: string }>(resolve => {
        timer = setTimeout(
          () => resolve({ hosts: [], error: `清单计算超时（${Math.round(timeoutMs / 1000)}s）：有机器没在预算内应答，按空清单处置` }),
          timeoutMs,
        )
      }),
    ])
  } catch (error) {
    // 算子约定不抛，真抛了也不甩 500：手机看到的是「拿不到 + 原因」。
    return { hosts: [], error: `清单计算失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** JSON 应答：no-store（清单跟着机器状态变，不许被任何一环缓存）+ 固定长度。 */
function respondJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
