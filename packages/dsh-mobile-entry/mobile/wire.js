/**
 * 手机页 wire 客户端（纯逻辑模块）。
 *
 * 浏览器原生 ESM：无构建链、无 import、无 DOM 依赖，node 可直接加载
 * （vitest 的 .ts 测试直接 import 本文件）。本文件硬编码的常量与帧形来自
 * Task 6 的线上探针，逐条记录在 docs/research/2026-10-15-mobile-wire.md，
 * 与 src/wire.ts 同值——静态页不能 import TS，只能原样照抄，改值先改探针
 * 再两处同改。
 *
 * 注入约定（本模块不碰任何环境全局，URL/WebSocket/fetch 全部由调用方给）：
 * - rpcCall(fetchLike, endpoint, payload, rpcId)：fetchLike(url, init) 返回
 *   标准 fetch Response 形（至少 {status, text()}）；rpcId 由调用方铸造并
 *   保证唯一（应用层持有计数器/uuid），本模块不自己生成。
 * - new MuxConnection(urlFactory, socketFactory, fetchLike?)：
 *   - urlFactory(): 每次建连（含每次重连）调用一次，返回 mux 的 ws 地址；
 *   - socketFactory(url): 返回下方 WireSocket 形的最小 socket；
 *   - fetchLike 可省略，省略时在调用点取 globalThis.fetch（浏览器环境天然
 *     存在；仅 answer 的 HTTP 应答用到）。
 *
 * WireSocket——Task 8 用真 WebSocket 适配的最小形状：
 *   {
 *     send(data: string): void          // 发送一帧文本
 *     close(): void                     // 发起关闭
 *     onopen: (() => void) | null       // 连接可发消息了
 *     onmessage: ((data: string) => void) | null   // 收到一帧文本（已解包）
 *     onclose: (() => void) | null      // 连接断了（无论谁发起）
 *   }
 * 三个回调只在 socketFactory 返回之后异步触发（真 WebSocket 天然如此；
 * 测试替身也必须遵守——socketFactory 不得在构造期间同步回调），onerror
 * 不需要：WebSocket 语义里 error 之后必有 close。
 *
 * 行为契约（与探针记录逐条对应）：
 * - 建连后发一帧 open 订阅 $events（payload 恰为 {args:{}}），ready 首项
 *   带本连接的 clientId；每个连接的 clientId 不同。
 * - 下行 item 帧按 value.type 派发给 onEvent(type, listener) 注册的监听器
 *   （ready/waterfall/cancel/快照等）。宿主 mux 级 error 帧派发为 'error'
 *   事件（帧形源码钉死、线上未观测）；mux 级 end 帧等于服务端关流，按
 *   断线处理走重连恢复。
 * - answer(eventId, outcome) 走 HTTP POST /api/$events/result（应答不占用
 *   WS 客户帧通道），payload {args:{clientId, eventId, outcome}}，clientId
 *   取当前连接 ready 帧的值。首答生效、迟到应答会被宿主显式报错——一律
 *   解析为 {ok:false,kind:'error'} 返回，answer 从不 reject、从不触发重连。
 * - 断线（onclose）按 1s→2s→5s→10s 封顶退避自动重连并重放订阅；ready 后
 *   退避计数归零。不在 socket 上恢复审批等在途状态——应用层在重连后重新
 *   拉取。
 */

export const SESSION_LIST_ENDPOINT = 'session/list'
export const SESSION_HISTORY_ENDPOINT = 'session/page'
export const SESSION_PROMPT_ENDPOINT = 'session/prompt'
export const SESSION_CANCEL_ENDPOINT = 'session/cancel'
export const MUX_PATH = '/api/remote.mux'
export const EVENTS_STREAM_ENDPOINT = '$events'
export const EVENT_RESULT_ENDPOINT = '$events/result'

/** 退避阶梯（毫秒）：前三次走阶梯，之后封顶。 */
const BACKOFF_STEPS_MS = [1000, 2000, 5000]
const BACKOFF_CAP_MS = 10000

/**
 * 发一次 RPC。payload 是端点的命名参数对象，本函数按宿主要求包成
 * `{args: payload}`；信封 method 与路径端点逐字相等。状态映射：
 * 200 且 result.ok=true → {ok:true,result=value}；result.ok=false 与其余
 * 非 200 → {ok:false,kind,message}（401→unpaired 未配对、403→untrusted
 * 宿主未信任、其他→error）。传输层失败（fetchLike reject）原样向上抛，
 * 由调用方决定怎么处置。
 */
export async function rpcCall(fetchLike, endpoint, payload, rpcId) {
  let response
  try {
    response = await fetchLike(`/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload: { args: payload },
      }),
    })
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
  if (response.status === 401) {
    return { ok: false, kind: 'unpaired', message: '未配对（HTTP 401）：请从桌面端的配对链接打开本页' }
  }
  if (response.status === 403) {
    return { ok: false, kind: 'untrusted', message: '宿主尚未信任此连接（HTTP 403）' }
  }
  if (response.status !== 200) {
    return { ok: false, kind: 'error', message: `RPC ${endpoint} 失败：HTTP ${response.status}` }
  }
  let body
  try {
    body = JSON.parse(await response.text())
  } catch {
    return { ok: false, kind: 'error', message: `RPC ${endpoint} 响应不是合法 JSON` }
  }
  const result = body !== null && typeof body === 'object' ? body.result : undefined
  if (result !== null && typeof result === 'object' && result.ok === true) {
    return { ok: true, result: result.value }
  }
  if (result !== null && typeof result === 'object' && result.ok === false) {
    const message = result.error && typeof result.error.message === 'string'
      ? result.error.message
      : `RPC ${endpoint} 失败（宿主未给出 message）`
    return { ok: false, kind: 'error', message }
  }
  return { ok: false, kind: 'error', message: `RPC ${endpoint} 响应不是 server-response 形` }
}

/**
 * 断线重连退避。attempts 是调用方持有的可变计数 `{count: number}`（连接在
 * ready 后把它归零，即「稳定连接之后的第一次断线仍从 1s 起步」）。next()
 * 按当前计数返回下一次重连前要等的毫秒数：1s、2s、5s，之后 10s 封顶。
 */
export function createBackoff(attempts) {
  return {
    next() {
      const index = attempts.count
      attempts.count += 1
      return index < BACKOFF_STEPS_MS.length ? BACKOFF_STEPS_MS[index] : BACKOFF_CAP_MS
    },
  }
}

/** 模块级流水号：streamId / 内部 rpcId 只要求非空且不重复（宿主按字符串收）。 */
let wireSeq = 0

/**
 * $events 订阅连接：构造即建连，断线自动按退避重连并重放订阅，close() 之后
 * 永久停止。详见文件头注释的注入约定与行为契约。
 */
export class MuxConnection {
  #urlFactory
  #socketFactory
  #fetchLike
  #listeners = new Map()
  #attempts = { count: 0 }
  #backoff
  #clientId = null
  #currentSocket = null
  #streamId = null
  #reconnectTimer = null
  #closed = false

  constructor(urlFactory, socketFactory, fetchLike) {
    this.#urlFactory = urlFactory
    this.#socketFactory = socketFactory
    this.#fetchLike = fetchLike ?? ((...args) => globalThis.fetch(...args))
    this.#backoff = createBackoff(this.#attempts)
    this.#connect()
  }

  /** 注册某类事件（下行 item 帧按 value.type 分类）的监听器；返回退订函数。 */
  onEvent(type, listener) {
    let set = this.#listeners.get(type)
    if (!set) {
      set = new Set()
      this.#listeners.set(type, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  /**
   * 应答一条 waterfall 事件（如 approval/request）。走 HTTP $events/result，
   * outcome 形如 {kind:'next'} | {kind:'result',value?} | {kind:'rejected',error}。
   * 从不 reject：无 clientId、宿主报迟到、传输失败都解析为 error-kind 结果——
   * 迟到应答是良性的（首答已生效），不算连接故障。
   */
  async answer(eventId, outcome) {
    const clientId = this.#clientId
    if (clientId === null) {
      return { ok: false, kind: 'error', message: 'answer 在收到 ready（clientId）之前被调用，未发送' }
    }
    try {
      return await rpcCall(
        this.#fetchLike,
        EVENT_RESULT_ENDPOINT,
        { clientId, eventId, outcome },
        `wire-answer-${++wireSeq}`,
      )
    } catch (error) {
      return {
        ok: false,
        kind: 'error',
        message: `answer 传输失败（按良性迟到应答处理，不影响连接）：${error}`,
      }
    }
  }

  /** 关闭当前连接并停止一切重连。 */
  close() {
    this.#closed = true
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    const socket = this.#currentSocket
    this.#currentSocket = null
    socket?.close()
  }

  #connect() {
    if (this.#closed) {
      return
    }
    const streamId = `wire-stream-${++wireSeq}`
    const socket = this.#socketFactory(this.#urlFactory())
    this.#currentSocket = socket
    this.#streamId = streamId
    socket.onopen = () => {
      if (socket !== this.#currentSocket) {
        return
      }
      socket.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: EVENTS_STREAM_ENDPOINT,
        payload: { args: {} },
      }))
    }
    socket.onmessage = (data) => {
      this.#handleFrame(data, socket)
    }
    socket.onclose = () => {
      this.#handleClose(socket)
    }
  }

  #handleFrame(data, socket) {
    if (socket !== this.#currentSocket) {
      return
    }
    let frame
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object') {
      return
    }
    if (frame.type === 'item' && frame.streamId === this.#streamId
      && frame.value !== null && typeof frame.value === 'object'
      && typeof frame.value.type === 'string') {
      if (frame.value.type === 'ready') {
        this.#clientId = typeof frame.value.clientId === 'string' ? frame.value.clientId : null
        this.#attempts.count = 0
      }
      this.#dispatch(frame.value.type, frame.value)
      return
    }
    if (frame.type === 'error' && frame.streamId === this.#streamId
      && frame.error !== null && typeof frame.error === 'object') {
      this.#dispatch('error', frame.error)
      return
    }
    if (frame.type === 'end' && frame.streamId === this.#streamId) {
      socket.close()
    }
    // 其余帧（未知帧型/坏形/mux end 与 error 之外的形状）忽略：协议层不猜。
  }

  #handleClose(socket) {
    if (socket !== this.#currentSocket) {
      return
    }
    this.#currentSocket = null
    this.#streamId = null
    this.#clientId = null
    if (this.#closed) {
      return
    }
    const delay = this.#backoff.next()
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#connect()
    }, delay)
  }

  #dispatch(type, value) {
    const set = this.#listeners.get(type)
    if (set) {
      for (const listener of set) {
        listener(value)
      }
    }
  }
}
