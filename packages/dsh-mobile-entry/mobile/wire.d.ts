/**
 * mobile/wire.js 的手写声明：wire.js 是浏览器原生 ESM（无构建链），有意
 * 不进 tsc 编译范围（包 tsconfig 只 include src/tests 的 .ts）；这个 .d.ts
 * 只服务两件事——tests/wire.spec.ts 的类型检查、Task 8 应用层的类型契约。
 * 改 wire.js 行为时同步改这里。
 */

/** rpcCall / MuxConnection.answer 的统一结果：ok 二分，失败带种类与可展示消息。 */
export type RpcOutcome =
  | { readonly ok: true; readonly result: unknown }
  | {
    readonly ok: false
    readonly kind: 'unpaired' | 'untrusted' | 'error'
    readonly message: string
  }

/** 最小 fetch 形：注入用，标准 fetch / Response 均满足。 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * MuxConnection 依赖的最小 socket 形（真 WebSocket 的子集，Task 8 适配）：
 * 回调只在 socketFactory 返回后异步触发；onmessage 收到的是已解包的帧文本。
 */
export interface WireSocket {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((data: string) => void) | null
  onclose: (() => void) | null
}

/** 发一次 RPC：POST /api/<endpoint>，信封 {type:'client-request', rpcId, method: endpoint, payload:{args: payload}}。 */
export declare function rpcCall(
  fetchLike: FetchLike,
  endpoint: string,
  payload: unknown,
  rpcId: string,
): Promise<RpcOutcome>

/**
 * 断线重连退避：attempts 是调用方持有的可变计数（连接 ready 后归零）。
 * next() 依次返回 1000/2000/5000 毫秒，之后 10000 封顶。
 */
export declare function createBackoff(attempts: { count: number }): { next(): number }

/**
 * $events 订阅连接：构造即建连，断线按退避自动重连并重放订阅，close() 后
 * 永久停止。onEvent(type, listener) 按下行 item 帧的 value.type 派发；answer
 * 走 HTTP $events/result（迟到应答为良性 error 结果，从不 reject）。
 */
export declare class MuxConnection {
  constructor(
    urlFactory: () => string | URL,
    socketFactory: (url: string | URL) => WireSocket,
    fetchLike?: FetchLike,
  )
  onEvent(type: string, listener: (value: unknown) => void): () => void
  answer(eventId: string, outcome: unknown): Promise<RpcOutcome>
  close(): void
}

/** 会话列表：POST /api/session/list，payload `{args:{_request:{}}}`。 */
export declare const SESSION_LIST_ENDPOINT: 'session/list'

/** 历史分页读（加载更早）：POST /api/session/page，payload `{args:{request:{address, throughSeq, …}}}`。 */
export declare const SESSION_HISTORY_ENDPOINT: 'session/page'

/** 发消息：POST /api/session/prompt，payload `{args:{request:{requestId, sessionId, mode, content, …}}}`。 */
export declare const SESSION_PROMPT_ENDPOINT: 'session/prompt'

/** 停止（取消当前回合）：POST /api/session/cancel，payload `{args:{request:{sessionId}}}`。 */
export declare const SESSION_CANCEL_ENDPOINT: 'session/cancel'

/** WebSocket 多路复用器路径（ws(s)://<host>/api/remote.mux）。 */
export declare const MUX_PATH: '/api/remote.mux'

/** mux 内部事件流端点：open 一条 `$events` 逻辑流即订阅全部转发事件。 */
export declare const EVENTS_STREAM_ENDPOINT: '$events'

/** waterfall 事件的应答 RPC：POST /api/$events/result，payload `{args:{clientId, eventId, outcome}}`。 */
export declare const EVENT_RESULT_ENDPOINT: '$events/result'
