/**
 * 每台机器一个客户端，按 hostId 懒建并复用。
 *
 * 为什么懒建：客户端要拿 origin（该机隧道在云主机侧的落点），而端口是隧道池
 * **首次 ensure 时**才分配并落盘的。启动时就算不出 origin——硬造一个就是拿
 * 错端口去请求上游，症状是恒 401，凭据自愈也救不回来。所以第一笔用到某机时
 * 才问一次「你的 origin 是多少」，之后复用。
 *
 * 为什么复用：一个客户端一条 WebSocket，代表与上游的整条长连接（事件流与审批
 * 应答身份都在上面）。每请求建一个会让上游的应答落到已经关掉的连接上。
 */

import { MachineClient } from './machine-client.ts'
import type { MachineClientOptions } from './machine-client.ts'
import type { ClientPool } from './relay.ts'

/** 一台机器在池子里的登记项：`resolve` 现问 origin 与取 cookie 的办法。 */
export interface PoolMachine {
  hostId: string
  /**
   * 解析该机的 origin（首次会真的开隧道）。失败时抛错，调用方把它当
   * 「这台机器现在用不了」处置。
   */
  resolve(): Promise<{
    origin: string
    getCookie: () => Promise<{ ok: true; cookie: string } | { ok: false; reason: string }>
  }>
}

export class RelayClientPool implements ClientPool {
  private readonly machines: ReadonlyMap<string, PoolMachine>
  private readonly clients = new Map<string, MachineClient>()
  /** 建连中的在场标记：两笔并发请求同时要同一台机时，只开一条。 */
  private readonly pending = new Map<string, Promise<MachineClient>>()
  /** 注入点：测试给假工厂，生产走真 MachineClient。 */
  private readonly makeClient: (opts: MachineClientOptions) => MachineClient

  constructor(machines: readonly PoolMachine[], makeClient?: (opts: MachineClientOptions) => MachineClient) {
    this.machines = new Map(machines.map(machine => [machine.hostId, machine]))
    this.makeClient = makeClient ?? (opts => new MachineClient(opts))
  }

  /**
   * 该机的客户端；不在配置登记内的 hostId 抛错——Relay 已经先按白名单挡过一道，
   * 这里抛是防止将来新增调用点时静默拿到别人的连接。
   */
  async clientFor(hostId: string): Promise<MachineClient> {
    const cached = this.clients.get(hostId)
    if (cached !== undefined) return cached
    const inflight = this.pending.get(hostId)
    if (inflight !== undefined) return await inflight
    const machine = this.machines.get(hostId)
    if (machine === undefined) throw new Error(`clientFor 收到未登记的 hostId ${hostId}`)
    const task = (async () => {
      const { origin, getCookie } = await machine.resolve()
      const client = this.makeClient({ origin, getCookie })
      this.clients.set(hostId, client)
      return client
    })()
    this.pending.set(hostId, task)
    try {
      return await task
    } finally {
      this.pending.delete(hostId)
    }
  }

  /**
   * 上游说凭据不对：丢掉这个客户端，让下一笔按当时的凭据重建。
   *
   * 不在这里重连：此刻手里还是同一份坏 cookie，重连只会失败再进退避，白费一轮。
   */
  invalidate(hostId: string): void {
    const client = this.clients.get(hostId)
    if (client === undefined) return
    client.close()
    this.clients.delete(hostId)
  }

  /** 停机：全部关闭。 */
  closeAll(): void {
    for (const client of this.clients.values()) client.close()
    this.clients.clear()
  }

  /** 供接线自检：某机是否已建连接（不建）。 */
  has(hostId: string): boolean {
    return this.clients.has(hostId)
  }
}

export type { ClientPool }
