/**
 * 中转对单机 DSH 的线上协议常量。
 *
 * 每个值与手机页已上线的那份 `packages/dsh-mobile-entry/src/wire.ts` 逐字
 * 相同（那边是 Task 6 探针钉死的记录，证据 docs/research/2026-10-15-mobile-wire.md；
 * 中转侧的连通性另经 docs/research/2026-10-16-relay-spike.md 真机复测）。
 * 两边各存一份是既定取舍——静态手机页只能照抄字面量，而中转不宜为几个
 * 常量反向依赖手机页的打包面；同步纪律靠 machine-client.spec.ts 把这些值
 * 钉死，改值时两处用例会一起红，被迫同改。
 *
 * 纯常量模块：不 import 任何东西，本文件不承载任何行为。
 */

/** 会话列表：POST /api/session/list（中转透明转发，args 形状由调用方构造）。 */
export const SESSION_LIST_ENDPOINT = 'session/list'

/** 历史分页读（加载更早）：POST /api/session/page。 */
export const SESSION_HISTORY_ENDPOINT = 'session/page'

/** 发消息：POST /api/session/prompt。 */
export const SESSION_PROMPT_ENDPOINT = 'session/prompt'

/** 停止（取消当前回合）：POST /api/session/cancel。 */
export const SESSION_CANCEL_ENDPOINT = 'session/cancel'

/**
 * WebSocket 多路复用器路径。升级请求必须带 Cookie 头（阶段 0 实测：不带
 * cookie 升级到不了 ready），MachineClient 把整对 cookie 交给 openSocket
 * 注入点，默认适配器用 ws 的 headers 选项送达。
 */
export const MUX_PATH = '/api/remote.mux'

/**
 * 多路复用器内部的事件流端点：开一条 $events 逻辑流即订阅全部转发事件
 * （emit 广播 + waterfall 问答），开流 payload 固定 `{args:{}}`，首项为
 * `{type:'ready', clientId, host:{home}}`，clientId 是应答审批的身份。
 */
export const EVENTS_STREAM_ENDPOINT = '$events'

/**
 * waterfall 事件的应答 RPC：POST /api/$events/result，payload
 * `{args:{clientId, eventId, outcome}}`。每个连接用自己 ready 帧里的
 * clientId 应答；「已知 eventId 首答生效、其余收 cancel」为宿主源码钉死，
 * 迟到应答会被宿主显式报错（answer 折成 {ok:false}，不算连接故障）。
 */
export const EVENT_RESULT_ENDPOINT = '$events/result'
