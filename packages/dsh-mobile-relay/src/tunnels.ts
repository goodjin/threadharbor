/**
 * 隧道池：为每台机器维持一条 SSH 本地转发，本地端口一经分配就固定下来。
 *
 * 为什么端口必须由本层自己分配并持久化：各机的认证 cookie 绑定 authority
 * （`127.0.0.1:<本地端口>`），端口一换人已存凭据就集体失效。SSH 层
 * （DshSshManager.ensureTunnel）自选的本地端口来自系统临时分配（freePort），
 * 每次重启都会换号——所以分配权在这里：从 41100 起探一个空闲端口，写进
 * statePath 的 tunnels 段，重启后先读回落盘分配再重建隧道，端口不变。
 *
 * 为什么从固定起点探端口而不是取系统分配端口（listen(0)）：listen(0) 每次
 * 给的都是临时端口，两次重启几乎必然不同号，正是要防的故障；从 41100 起
 * 逐个真 bind 探测（`net.createServer().listen(port, '127.0.0.1')`）让分配
 * 可复现，也把中转用的端口钉在一个远离临时端口段的窄带里。探测绑定
 * 127.0.0.1 与隧道实际监听口一致，别的接口/IPv6 上的占用不会误伤判定。
 *
 * 落盘端口被占（例如另一进程抢了）时不换端口、直接报失败并保留落盘值：
 * 静默换端口等于让句柄地址与已存凭据的 authority 分家，全线凭据对着错误
 * 地址失效，比「这台机器暂时建不起来」难查得多。端口归属冲突同理——分配
 * 新端口时跳过已归属他机的落盘端口，哪怕它此刻空闲。
 *
 * deps.ensureTunnel 由装配处注入（Task 7 传 DshSshManager.ensureTunnel 的
 * 绑定），本文件不拼 ssh 命令行。它的返回值（endpoint 字符串）不作为句柄
 * 端口的来源——端口的权威是本层的落盘分配；本层经 opts.localPort 把落盘
 * 端口交给 SSH 层，联邦包的 manager 自 Task 5b 起服从该端口，落盘端口与
 * 实际监听口两边一致。
 *
 * 先落盘、后开隧道：开隧道失败时分配已留存，重试或重启后仍拿同一端口——
 * 「一经分配就固定」不因一次失败而作废。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import type { SshConnectionConfig } from '@threadharbor/dsh-host-federation/ssh/types'
import type { RelayMachineConfig } from './index.ts'
import { StateStore, type RelayStateDocument } from './state.ts'

/** 一台机器的隧道句柄：origin 即该机 DSH 在云主机侧的 authority（cookie 绑定它）。 */
export type TunnelHandle = {
  readonly hostId: string
  readonly localPort: number
  readonly origin: string
}

export type TunnelEnsureResult =
  | { readonly ok: true; readonly handle: TunnelHandle }
  | {
      readonly ok: false
      /** fingerprint-unapproved=需先确认主机指纹（不建隧道）；ssh-failed=机器此刻连不上或本机端口被占。 */
      readonly reason: 'fingerprint-unapproved' | 'ssh-failed'
      readonly detail: string
    }

export interface TunnelPoolDeps {
  /** 与 DshSshManager.ensureTunnel 同形；绑定必须服从 opts.localPort（见模块头注释）。 */
  ensureTunnel(config: SshConnectionConfig, remotePort: number, opts?: { readonly localPort?: number }): Promise<string>
  /** 收尾钩子（如 manager.close 的绑定）；缺省时 closeAll 只清内存句柄。 */
  closeTunnel?(): Promise<void>
}

/** 分配段起点：中转专用窄带的第一个端口（设计文档钉的值）。 */
const FIRST_LOCAL_PORT = 41100
const LAST_LOCAL_PORT = 65535

export class TunnelPool {
  private readonly state: StateStore
  private readonly knownHostsPath: string
  private readonly deps: TunnelPoolDeps
  /** 内存去重表：同一 hostId 的重复 ensure 直接给同一 handle，不再动隧道。 */
  private readonly handles = new Map<string, TunnelHandle>()
  /**
   * ensure 的串行队列。分配是「读盘 → 逐个探端口 → 写盘」三步，probe 之间
   * 有 await，若两台机器的 ensure 交错跑，可能同时探中同一个空闲端口并各自
   * 落盘，两台从此撞号。中转单实例进程内把 ensure 排成队（manager 的
   * tunnelOps 同款写法），这条临界区就没有并发了；跨进程并发由部署侧的单
   * 实例前提兜底（state.ts 头注释）。
   */
  private tail: Promise<unknown> = Promise.resolve()

  // 字段用普通赋值而不是构造参数属性：宿主以 strip-only 模式装载插件 TS，
  // 参数属性在 import 时就会被拒（manager.ts 同款注释）。
  constructor(statePath: string, deps: TunnelPoolDeps, knownHostsPath: string) {
    this.state = new StateStore(statePath)
    this.deps = deps
    this.knownHostsPath = knownHostsPath
  }

  async ensure(machine: RelayMachineConfig): Promise<TunnelEnsureResult> {
    return await this.enqueue(async () => {
      // 指纹闸门最先做：未登记的机器不建隧道、不占端口、不落盘，回报「需
      // 确认指纹」。known_hosts 每次现读不缓存——运维在运行中给新机器登记
      // 指纹后，下一次 ensure 就该放行，不该等重启。
      const fingerprint = this.lookupFingerprint(machine)
      if (fingerprint === undefined) {
        return {
          ok: false,
          reason: 'fingerprint-unapproved',
          detail: `机器 ${machine.hostId}（${machine.target}）的 SSH 主机指纹未登记，需先确认指纹，未自动建立隧道`,
        }
      }

      const cached = this.handles.get(machine.hostId)
      if (cached !== undefined) {
        // 缓存命中也要验活：ssh 起隧道只等 350ms 就判成功（manager 侧的口径），
        // 一台「黑洞型失联」的机器（休眠、被防火墙丢包）要十几秒才退，那时句柄
        // 早就进缓存了。不验活的话，从下一拍起每拍都直接返回缓存——隧道死了也
        // 不重建，reachable 恒 true 而 running 恒 false，除非重启中转进程。
        if (!(await isPortFree(cached.localPort))) return { ok: true, handle: cached }
        this.handles.delete(machine.hostId)
      }

      const doc = this.state.read()
      const assigned = assignedPort(doc, machine.hostId)
      let localPort: number
      if (assigned !== undefined) {
        // 重启重建路径：落盘分配还在，就沿用。被占说明有别的进程抢了号，
        // 报失败并把决定权交还运维（头注释：为什么不静默换号）。
        if (!(await isPortFree(assigned))) {
          return {
            ok: false,
            reason: 'ssh-failed',
            detail: `本地端口 ${assigned}（机器 ${machine.hostId} 的固定分配）已被其他进程占用；为不使已存凭据对不上地址，未自动换端口，请先释放该端口`,
          }
        }
        localPort = assigned
      } else {
        // 首次分配。段内探尽仍无空闲端口在现实里近乎不可能，但要有明确的
        // 失败出口而不是死循环或越段。
        const allocated = await this.allocatePort(doc, machine.hostId)
        if (allocated === undefined) {
          return {
            ok: false,
            reason: 'ssh-failed',
            detail: `本地端口 ${FIRST_LOCAL_PORT} 起没有可分配的空闲端口，无法为机器 ${machine.hostId} 建立隧道`,
          }
        }
        localPort = allocated
      }

      // 分配即落盘（先于开隧道，理由见头注释）。update 每次从盘上现读，
      // 只动本机的槽位，凭据段与他机记录原样保留。
      this.state.update(current => ({
        ...current,
        tunnels: { ...current.tunnels, [machine.hostId]: { port: localPort } },
      }))

      try {
        // 返回值（endpoint）不作句柄端口来源：权威是上面的落盘分配。
        // opts.localPort 把落盘端口交给 SSH 层，落盘账目和实际监听口是同一
        // 个号，凭据绑定的 authority 不落空。
        await this.deps.ensureTunnel(this.connectionConfig(machine, fingerprint), machine.remotePort, { localPort })
      } catch (error) {
        // SSH 层的错误文本只含目标与 stderr（不含凭据）；原样截取给上层分
        // 「连不上」类提示。状态文档里的凭据值从不进入本层任何消息。
        return { ok: false, reason: 'ssh-failed', detail: errorText(error) }
      }

      const handle: TunnelHandle = {
        hostId: machine.hostId,
        localPort,
        origin: `http://127.0.0.1:${localPort}`,
      }
      this.handles.set(machine.hostId, handle)
      return { ok: true, handle }
    })
  }

  /**
   * 收尾：关掉注入侧的隧道并清内存句柄。落盘分配**故意保留**——端口是
   * 「一经分配就固定」的账，重启后靠它原号重建；closeAll 只代表隧道断开，
   * 不代表作废分配。
   */
  async closeAll(): Promise<void> {
    await this.enqueue(async () => {
      if (this.deps.closeTunnel !== undefined) await this.deps.closeTunnel()
      this.handles.clear()
    })
  }

  /** 在串行队列里跑一个作业；前一个作业失败不堵后一个。 */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 从分配段里挑第一个「未被他机落盘账目认领、且此刻真空闲」的端口。 */
  private async allocatePort(doc: RelayStateDocument, hostId: string): Promise<number | undefined> {
    const claimed = new Set<number>()
    for (const [id, entry] of Object.entries(doc.tunnels)) {
      if (id === hostId) continue
      const port = assignedPortOfEntry(entry)
      if (port !== undefined) claimed.add(port)
    }
    for (let port = FIRST_LOCAL_PORT; port <= LAST_LOCAL_PORT; port += 1) {
      if (claimed.has(port)) continue
      if (await isPortFree(port)) return port
    }
    return undefined
  }

  /**
   * 指纹从联邦包同一份 known_hosts 里查（查不到即未登记）。条目是部署侧
   * persistKnownHost 按「别名 公钥」写入的，别名必须与 manager.ts 的
   * alias() 同一写法——tests/tunnels.spec.ts 把现值逐字钉死，manager 改写
   * 法时用例先红，两处被迫同步。指纹值按 OpenSSH 的算法现算（对公钥
   * blob 做 SHA256 再去 padding 的 base64），与 `ssh-keygen -lf -E sha256`
   * 实测同值；它在这里只证明「已登记」，真正的密钥校验由 ssh 按
   * known_hosts 严格模式自己做。
   */
  private lookupFingerprint(machine: RelayMachineConfig): string | undefined {
    const alias = hostKeyAlias(machine.target, machine.port)
    let text: string
    try {
      text = readFileSync(this.knownHostsPath, 'utf8')
    } catch {
      return undefined // 没有 known_hosts 就没有任何已登记机器
    }
    for (const line of text.split('\n')) {
      if (!line.startsWith(`${alias} `)) continue
      const fields = line.trim().split(/\s+/)
      const blob = fields[2]
      if (blob === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) continue
      return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`
    }
    return undefined
  }

  /** 由机器配置拼 SSH 连接面；缺省字段不出现（与 RelayMachineConfig 的可选语义一致）。 */
  /**
   * 这台机器的 SSH 连接配置（指纹已登记时），没有则 undefined。
   *
   * 装配层要靠它去读启动日志（凭据自愈那一步），而指纹解析只有这一处——
   * 让装配层再解析一遍就是两份真相，登记规则一改两处就会分家。所以这里只暴露
   * 结果，不暴露怎么解析。
   */
  connectionFor(machine: RelayMachineConfig): SshConnectionConfig | undefined {
    const fingerprint = this.lookupFingerprint(machine)
    return fingerprint === undefined ? undefined : this.connectionConfig(machine, fingerprint)
  }

  private connectionConfig(machine: RelayMachineConfig, fingerprint: string): SshConnectionConfig {
    return {
      target: machine.target,
      ...(machine.port === undefined ? {} : { port: machine.port }),
      ...(machine.user === undefined ? {} : { user: machine.user }),
      ...(machine.identityFile === undefined ? {} : { identityFile: machine.identityFile }),
      hostKeyFingerprint: fingerprint,
    }
  }
}

/**
 * known_hosts 别名：与 dsh-host-federation/src/ssh/manager.ts 的 alias() 逐
 * 字同一写法（`threadharbor-` + sha256(target\0port) 前 24 位十六进制，端口
 * 缺省 22）。两边各有一份是既定取舍：manager 不导出它，而中转不得为查一
 * 个指纹把 SSH 管理器整个拖起来；同步纪律由隧道池的用例钉住。
 */
function hostKeyAlias(target: string, port: number | undefined): string {
  return `threadharbor-${createHash('sha256').update(`${target}\0${port ?? 22}`).digest('hex').slice(0, 24)}`
}

/** 落盘条目里的端口；形状不对（手改坏、旧版本残留）按「无分配」处理，重新分配并覆盖。 */
function assignedPort(doc: RelayStateDocument, hostId: string): number | undefined {
  return assignedPortOfEntry(doc.tunnels[hostId])
}

function assignedPortOfEntry(entry: unknown): number | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const port = (entry as Record<string, unknown>)['port']
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return port
}

/**
 * 真 bind 探测：绑上再放掉才算空闲。绑的地址与隧道监听口一致
 * （127.0.0.1），避免「别的地址上有人听」造成的误判。探测与后续真正开隧
 * 道之间留有竞窗（别人可能恰好抢绑），真发生时隧道侧 bind 失败，走
 * ssh-failed 出口——方向是失败而不是错配，可接受。
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server: Server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** 错误文本只取消息本体；本层消息永不携带状态文档 credentials 段的内容。 */
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.trim() === '' ? 'SSH 隧道建立失败（无错误详情）' : text.trim()
}
