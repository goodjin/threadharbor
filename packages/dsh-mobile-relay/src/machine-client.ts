/**
 * 单机客户端：中转数据面里「对某一台机器的 DSH 说话」的那一层。
 *
 * 两件事：带 cookie 的 RPC（HTTP POST /api/<endpoint>，信封
 * `{type:'client-request', rpcId, method, payload:{args}}`），与 $events
 * 事件流（WS 升级 /api/remote.mux，带 Cookie 头，open 帧订阅，断线按
 * 1s→2s→5s→10s 退避重连并重放订阅）。协议形状逐字来自阶段 0 真机实测
 * （docs/research/2026-10-16-relay-spike.md），常量见本包 wire.ts（与手机
 * 页 packages/dsh-mobile-entry/src/wire.ts 同值）。
 *
 * 分工边界（这个模块刻意不做什么）：
 * - 凭据：每笔请求经 getCookie 现取（上游 MachineCredentials.resolve 自带
 *   缓存）。401 只分类成 unauthorized 返回，本层不换凭据、不重试——判脏
 *   （invalidate）与「重试一次」是上层转发面的职责，本层重试会把自愈变成
 *   循环重换，把启动令牌当无限凭据刷（credentials.ts 头注释同款纪律）。
 * - 参数：call 的 args 原样进 payload.args，不登记任何端点描述符、不解析
 *   不改写——描述符字段名逐端点不同（session/list 用 `_request`、
 *   session/prompt 用 `request`），由手机页构造，本层是透明转发。
 * - 会话聚合、审批在途状态：重连不恢复，应用层在重连后重新拉取（与手机
 *   页 mobile/wire.js 的契约一致）。
 *
 * 安全纪律：cookie 只出现在发给 openSocket / fetch 的头部实参里，绝不进
 * 任何错误消息或返回文本（传输失败连原始错误文本都不外带，credentials.ts
 * 同款做法）。
 */

import WebSocket from 'ws'
import { EVENTS_STREAM_ENDPOINT, EVENT_RESULT_ENDPOINT, MUX_PATH } from './wire.ts'

/**
 * 与手机页同形的最小 socket（mobile/wire.js 的 WireSocket 契约）：三个回调
 * 只在 openSocket 返回之后异步触发，error 之后必有 close，所以没有 onerror。
 */
export type WireSocket = {
  /** 发送一帧文本。 */
  send(data: string): void
  /** 发起关闭。 */
  close(): void
  /** 连接可发消息了。 */
  onopen: (() => void) | null
  /** 收到一帧文本（已解包）。 */
  onmessage: ((data: string) => void) | null
  /** 连接断了（无论谁发起）。 */
  onclose: (() => void) | null
}

/** call 的结果。message 面向调用方日志/手机端提示，永不携带 cookie。 */
export type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: 'unauthorized' | 'rpc-error' | 'transport'; message: string }

/** 审批应答的 outcome，原样进 $events/result 的 payload.args.outcome。 */
export type EventOutcome = { kind: 'next' } | { kind: 'result'; value?: unknown } | { kind: 'rejected'; error: string }

export interface MachineClientOptions {
  /** 该机 DSH 在云主机侧的 origin（隧道本机侧，凭据绑定的 authority）。 */
  origin: string
  /** 每次请求/建连现取整对 cookie（上游自带缓存与自愈，见模块头注释）。 */
  getCookie: () => Promise<{ ok: true; cookie: string } | { ok: false; reason: string }>
  /** HTTP 假件注入点（测试用）；缺省 globalThis.fetch。 */
  fetchLike?: typeof fetch
  /** WS 建连注入点（测试用假 socket）；缺省用 ws 库带 Cookie 头升级。 */
  openSocket?: (url: string, cookie: string) => WireSocket
}

/**
 * 退避阶梯：前三次走阶梯，之后 10s 封顶。与手机页 mobile/wire.js 的
 * BACKOFF_STEPS_MS / BACKOFF_CAP_MS 同值（那边是私有常量，两边各自抄值、
 * 注释互认；改值两处同改）。
 */
const BACKOFF_STEPS_MS = [1000, 2000, 5000]
const BACKOFF_CAP_MS = 10000

/** 模块级流水号：streamId / rpcId 只要求非空且不重复（宿主按字符串收）。 */
let seq = 0

export class MachineClient {
  private readonly origin: string
  private readonly getCookie: () => Promise<{ ok: true; cookie: string } | { ok: false; reason: string }>
  private readonly fetchLike: typeof fetch
  private readonly openSocket: (url: string, cookie: string) => WireSocket
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>()
  private currentSocket: WireSocket | null = null
  private streamId: string | null = null
  /** 当前连接 ready 帧给的审批应答身份；断线即清，ready 前为 null。 */
  private clientId: string | null = null
  /** 已断未重连的次数（进退避阶梯的下标）；ready 后归零。 */
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  // 字段用普通赋值而不是构造参数属性：宿主以 strip-only 模式装载插件 TS，
  // 参数属性在 import 时就会被拒（tunnels.ts 同款注释）。
  constructor(opts: MachineClientOptions) {
    this.origin = opts.origin
    this.getCookie = opts.getCookie
    this.fetchLike = opts.fetchLike ?? globalThis.fetch
    this.openSocket = opts.openSocket ?? defaultOpenSocket
  }

  /**
   * 发一次 RPC：POST <origin>/api/<endpoint>，带 Cookie 头，args 透明转发。
   * 状态归类：HTTP 401 → unauthorized（本层不换凭据，见模块头注释）；
   * result.ok===true → 成功；拿到 HTTP 应答的其余失败（宿主报错、非 200、
   * 响应不是 server-response 形）→ rpc-error（服务端给了权威答案）；
   * 本地根本没发出去/没拿到应答（取不到 cookie、fetch 抛错）→ transport。
   */
  async call(endpoint: string, args: Record<string, unknown>): Promise<RpcResult> {
    const cred = await this.cookieSafe()
    if (!cred.ok) {
      return { ok: false, kind: 'transport', message: `RPC ${endpoint} 无法取得机器凭据（${cred.reason}），未发送` }
    }
    let response: Response
    try {
      response = await this.fetchLike(new URL(`/api/${endpoint}`, this.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cred.cookie },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `relay-rpc-${++seq}`,
          method: endpoint,
          payload: { args },
        }),
      })
    } catch {
      // 传输失败不外带原始错误：错误文本里可能出现请求 URL 等环境细节，
      // 且它不是宿主的权威答案，不值得透传（credentials.ts 同款取舍）。
      return { ok: false, kind: 'transport', message: `RPC ${endpoint} 传输失败` }
    }
    if (response.status === 401) {
      // 只分类不处理：上层转发面吃到 unauthorized 后判脏（invalidate）再重试一次。
      return { ok: false, kind: 'unauthorized', message: `RPC ${endpoint} 收到 HTTP 401，机器凭据已失效` }
    }
    let body: unknown
    try {
      body = JSON.parse(await response.text())
    } catch {
      return { ok: false, kind: 'rpc-error', message: `RPC ${endpoint} 响应不是合法 JSON（HTTP ${response.status}）` }
    }
    const result = (body as { result?: unknown } | null)?.result
    if (result !== null && typeof result === 'object' && (result as { ok?: unknown }).ok === true) {
      return { ok: true, value: (result as { value?: unknown }).value }
    }
    if (result !== null && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
      const error = (result as { error?: unknown }).error
      const message =
        error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : `RPC ${endpoint} 失败（宿主未给出 message）`
      return { ok: false, kind: 'rpc-error', message }
    }
    return { ok: false, kind: 'rpc-error', message: `RPC ${endpoint} 响应不是 server-response 形（HTTP ${response.status}）` }
  }

  /** 注册某类事件（下行 item 帧按 value.type 分类）的监听器；返回退订函数。 */
  onEvent(type: string, listener: (value: unknown) => void): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  /**
   * 开始订阅 $events。同步返回，建连（取 cookie → 升级 WS → 发 open 帧）
   * 在后台走；取不到 cookie 或建连失败按一次断线处理进退避，不向上抛。
   * 已在连接/重连途中时是幂等空操作。
   */
  connect(): void {
    this.closed = false
    if (this.currentSocket !== null || this.reconnectTimer !== null) return
    this.attempts = 0 // 全新会话从阶梯头起步
    void this.openSession()
  }

  /**
   * 应答一条 waterfall 事件（如审批）。走 HTTP $events/result（不占 WS 客户
   * 帧通道），payload {args:{clientId,eventId,outcome}}，clientId 取当前连接
   * ready 帧的值。从不 reject：ready 之前（身份未知，无法应答）、宿主报迟到
   * （首答已生效，良性）、传输失败都折成 {ok:false}，不影响连接。
   */
  async answer(eventId: string, outcome: EventOutcome): Promise<{ ok: boolean; message?: string }> {
    const clientId = this.clientId
    if (clientId === null) {
      return { ok: false, message: 'answer 在收到 ready（clientId）之前被调用，未发送' }
    }
    const cred = await this.cookieSafe()
    if (!cred.ok) {
      return { ok: false, message: `answer 无法取得机器凭据（${cred.reason}），未发送` }
    }
    let response: Response
    try {
      response = await this.fetchLike(new URL(`/api/${EVENT_RESULT_ENDPOINT}`, this.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cred.cookie },
        body: JSON.stringify({ args: { clientId, eventId, outcome } }),
      })
    } catch {
      return { ok: false, message: 'answer 传输失败（按良性迟到应答处理，不影响连接）' }
    }
    let body: unknown
    try {
      body = JSON.parse(await response.text())
    } catch {
      return { ok: false, message: `answer 响应不是合法 JSON（HTTP ${response.status}）` }
    }
    const result = (body as { result?: unknown } | null)?.result
    if (result !== null && typeof result === 'object' && (result as { ok?: unknown }).ok === true) {
      return { ok: true }
    }
    const error = result !== null && typeof result === 'object' ? (result as { error?: unknown }).error : undefined
    const message =
      error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : `answer 失败（HTTP ${response.status}，宿主未给出 message）`
    return { ok: false, message }
  }

  /** 关闭当前连接并停止一切重连；之后再 connect() 会作为全新会话重启。 */
  close(): void {
    this.closed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.currentSocket
    this.currentSocket = null
    this.streamId = null
    this.clientId = null
    socket?.close()
  }

  /** 取 cookie 的兜底包装：getCookie 按契约返回 {ok:false} 而不抛，抛了也按取不到处理，不留未处理拒绝。 */
  private async cookieSafe(): Promise<{ ok: true; cookie: string } | { ok: false; reason: string }> {
    try {
      return await this.getCookie()
    } catch {
      return { ok: false, reason: 'cookie-source-threw' }
    }
  }

  /** 一轮建连：取 cookie → 开 socket →（onopen 后）发 open 订阅帧。任何一步失败都按断线进退避。 */
  private async openSession(): Promise<void> {
    if (this.closed) return
    const cred = await this.cookieSafe()
    if (this.closed) return // 等待 cookie 期间被 close
    if (!cred.ok) {
      this.scheduleReconnect()
      return
    }
    let socket: WireSocket
    try {
      socket = this.openSocket(`${wsUrlOf(this.origin)}${MUX_PATH}`, cred.cookie)
    } catch {
      this.scheduleReconnect()
      return
    }
    const streamId = `relay-stream-${++seq}`
    this.currentSocket = socket
    this.streamId = streamId
    socket.onopen = () => {
      if (socket !== this.currentSocket) return
      socket.send(
        JSON.stringify({
          type: 'open',
          streamId,
          endpoint: EVENTS_STREAM_ENDPOINT,
          payload: { args: {} },
        }),
      )
    }
    socket.onmessage = data => {
      if (socket !== this.currentSocket) return
      this.handleFrame(data, socket)
    }
    socket.onclose = () => {
      if (socket !== this.currentSocket) return
      // 断线即清身份与流号：旧 clientId 对新连接无效（宿主按连接发 ready），
      // 留着只会让 answer 拿过期身份发注定失败的请求。
      this.currentSocket = null
      this.streamId = null
      this.clientId = null
      this.scheduleReconnect()
    }
  }

  /**
   * 断线调度重连：按阶梯取延迟（ready 后归零，所以稳定连接后的断线仍从
   * 1s 起步），close() 已把 closed 置真时直接不动。
   */
  private scheduleReconnect(): void {
    if (this.closed) return
    const delay = BACKOFF_STEPS_MS[this.attempts] ?? BACKOFF_CAP_MS
    this.attempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.openSession()
    }, delay)
  }

  /**
   * 宿主 mux 下行帧（形见 mobile-entry/src/wire.ts 的 MuxClientFrame 注释）。
   * item 按 value.type 派发；error 派发为 'error' 事件；end 等于服务端关流，
   * 主动 close 后走 onclose 的断线重连。其余帧（未知帧型/坏形/他流）忽略：
   * 协议层不猜。
   */
  private handleFrame(data: string, socket: WireSocket): void {
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const record = frame as Record<string, unknown>
    if (record['type'] === 'item' && record['streamId'] === this.streamId) {
      const value = record['value']
      if (typeof value !== 'object' || value === null) return
      const item = value as Record<string, unknown>
      if (typeof item['type'] !== 'string') return
      if (item['type'] === 'ready') {
        this.clientId = typeof item['clientId'] === 'string' ? item['clientId'] : null
        this.attempts = 0 // ready 后阶梯归零
      }
      this.dispatch(item['type'], value)
      return
    }
    if (
      record['type'] === 'error' &&
      record['streamId'] === this.streamId &&
      typeof record['error'] === 'object' &&
      record['error'] !== null
    ) {
      this.dispatch('error', record['error'])
      return
    }
    if (record['type'] === 'end' && record['streamId'] === this.streamId) {
      socket.close() // 视为断线：真 ws 随后回调 onclose 走重连
    }
  }

  private dispatch(type: string, value: unknown): void {
    const set = this.listeners.get(type)
    if (set === undefined) return
    for (const listener of set) {
      listener(value)
    }
  }
}

/** http(s) origin 对应的 ws(s) 地址前缀（隧道 origin 是 http，公网形态预留 https）。 */
function wsUrlOf(origin: string): string {
  return origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
}

/**
 * 默认 WS 适配器：用 ws 库升级并把事件折成上方 WireSocket 的三个回调。
 *
 * 为什么选 ws 而不是 Node 内置 WebSocket：阶段 0 实测（spike 文档前提反转
 * 第 10 条）Node 24 的内置 WebSocket **能**带 `{headers:{cookie}}` 且 cookie
 * 真随升级头送达——所以这是「选择」不是「必须」。仍选 ws 的理由：DSH 自身
 * 依赖它（^8.21.0，云主机上必然存在）、行为跨 Node 版本一致，不与 undici
 * 的版本行为耦合。
 */
function defaultOpenSocket(url: string, cookie: string): WireSocket {
  const ws = new WebSocket(url, { headers: { cookie } })
  const wire: WireSocket = {
    send: data => {
      ws.send(data)
    },
    close: () => {
      ws.close()
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  }
  ws.on('open', () => {
    wire.onopen?.()
  })
  ws.on('message', (data, isBinary) => {
    if (isBinary) return // 二进制帧会被服务端以 close 1003 拒（源码钉死），本层不发也不收
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8')
    wire.onmessage?.(text)
  })
  ws.on('close', () => {
    wire.onclose?.()
  })
  // 必须挂一个 error 监听：ws 的 socket 是 EventEmitter，error 事件没有监听
  // 器时 emit 会抛成未捕获异常，直接掀翻中转进程。WebSocket 语义里 error
  // 之后必有 close，断线处理统一走 onclose，这里吞掉事件即可。
  ws.on('error', () => {})
  return wire
}
