/**
 * mobile/backend-hub.js 的手写声明。理由与 wire.d.ts 相同：它是浏览器原生 ESM，
 * 有意不进 tsc 的编译范围，这份声明只服务 tests 的类型检查。
 *
 * 写它是因为那条链路恰恰是评审里断得最狠的一段：没有声明，用例就能把替身的
 * 形状写成任何样子——上一版就是把「自造词表」当成真实形状钉进用例，全绿。
 * 声明只约束**签名**，形状对不对还得靠喂真帧的用例。
 */

/** createHubBackend 的注入点。缺省走 globalThis.fetch / globalThis.WebSocket。 */
export interface HubBackendOptions {
  fetchLike?: (url: string, init?: RequestInit) => Promise<Response>
  WebSocketCtor?: (new (url: string) => unknown) | undefined
  /** 中转根路径，缺省 '/threadharbor/relay'。 */
  relayRoot?: string
}

/**
 * 中转后端交给应用层的事件回调。
 *
 * type 取的是**上游 mux item 的原样 type**（waterfall / emit / cancel），事件名
 * 与业务字段都在 value 上——中转只做搬运，不改词表。应用层按同一套词表判，
 * 直连分支同理；两边各编一套词表时，横幅与广播刷新会静默地永不触发。
 */
export interface HubEventHandlers {
  onStatus?: (status: 'connecting' | 'online' | 'offline', detail: string) => void
  onEvent?: (hostId: string, type: string, value: unknown) => void
}

export interface HubEventsHandle {
  close(): void
}

/** 直连/中转两种后端共用的能力面（app.d.ts 的 MobileBackend 是它的子集视图）。 */
export interface HubBackend {
  readonly mode: 'hub'
  listHosts(): Promise<unknown>
  listSessions(hostId: string): Promise<unknown>
  pageMessages(hostId: string): Promise<unknown>
  prompt(hostId: string): Promise<{ ok: boolean, message?: string }>
  cancel(hostId: string): Promise<{ ok: boolean, message?: string }>
  answer(hostId: string, eventId: string, outcome: unknown): Promise<{ ok: boolean, message?: string }>
  connectEvents(handlers: HubEventHandlers): HubEventsHandle
}

export declare function createHubBackend(opts?: HubBackendOptions): HubBackend
export declare const EVENTS_PATH: string
export declare const ANSWER_PATH: string
export declare const RELAY_ROOT: string
