/**
 * 手机端线上协议常量（Task 6 探针钉死）。
 *
 * 这里每个值都来自对运行中 DSH 实例（127.0.0.1:3091，dsh 0.2.0-rc.2）的
 * 实测——探针脚本 `scripts/probe-mobile-wire.mjs` 的输出，逐条记录在
 * `docs/research/2026-10-15-mobile-wire.md`——并与参考源码逐行核对过
 * （对照出处见各常量的注释）。手机端应用（Task 7/8）只硬编码这里的值；
 * 值变了先改探针、再改这里，不做任何回退猜测。
 *
 * 纯常量模块：不 import 任何东西，手机端原样照抄打包。
 */

/** 会话列表：POST /api/session/list，payload `{args:{_request:{}}}`（`_request` 内可选 `cursor` 字段源码钉死：ref types.ts:248-250，探针未用到）。 */
export const SESSION_LIST_ENDPOINT = 'session/list'

/**
 * 历史分页读（加载更早）：POST /api/session/page，payload
 * `{args:{request:{address, throughSeq, beforeSeq?, maxMessages?, turnWindow?}}}`。
 * `throughSeq` 是「当前已载入最旧记录之下」的含端截断（最旧为 seq 0 时传 -1，
 * 应答 `{records:[], hasMore:false}`，实测见研究笔记 §3.2）。
 */
export const SESSION_HISTORY_ENDPOINT = 'session/page'

/** 发消息：POST /api/session/prompt，payload `{args:{request:{requestId, sessionId, mode, content, clientTimeZone?}}}`。 */
export const SESSION_PROMPT_ENDPOINT = 'session/prompt'

/** 停止（取消当前回合）：POST /api/session/cancel，payload `{args:{request:{sessionId}}}`。 */
export const SESSION_CANCEL_ENDPOINT = 'session/cancel'

/**
 * WebSocket 多路复用器路径（ws(s)://<host>/api/remote.mux）。升级请求按
 * 浏览器同源 cookie 鉴权（与 /api 相同的 Host/Origin 栅栏 + 会话 cookie）。
 */
export const MUX_PATH = '/api/remote.mux'

/**
 * 多路复用器内部的事件流端点：开一条 `$events` 逻辑流即订阅全部转发事件
 * （emit 广播 + waterfall 问答），开流 payload 固定 `{args:{}}`，首帧必为
 * `{type:'ready', clientId, host:{home}}`。
 */
export const EVENTS_STREAM_ENDPOINT = '$events'

/**
 * waterfall 事件的应答 RPC：POST /api/$events/result，payload
 * `{args:{clientId, eventId, outcome}}`。每个连接用自己 ready 帧里的 clientId
 * 应答。端点与形状校验实测（未知 clientId 显式报错）；「已知 eventId 首答生效、
 * 其余收 cancel」为源码钉死（gateway/src/index.ts:614-668），见研究笔记 §6。
 */
export const EVENT_RESULT_ENDPOINT = '$events/result'

/**
 * 多路复用器客户帧（浏览器 → 宿主），四个帧型一字不差。证据成色：
 * `open` 实测（探针发送并被 0.2.0-rc.2 接受，run-1/3/4）；`item`/`end`/`cancel`
 * 的客户端发送路径为源码钉死（packages/api/gateway/src/stream-protocol.ts:264-286
 * admit 规则逐字段核对，探针未发送过这三种）。二进制帧与未知帧型会被服务端以
 * close 1008/1003 拒绝（stream-server.ts:150-159，源码钉死）。
 */
export type MuxClientFrame =
  | {
    /** 打开一条逻辑流；同一 streamId 重复 open 是唯一会关掉整条 socket 的协议违例（stream-server.ts:201-204）。 */
    readonly type: 'open'
    readonly streamId: string
    /** 形如 `session/follow` 的远程流端点，或内部端点 `$events`。 */
    readonly endpoint: string
    /** 端点入参；固定形状是 `{args:{…}}`（服务端校验「恰好一个 plain-object args 字段」）。 */
    readonly payload: unknown
  }
  | {
    /** 客户端上行项；`value` 可省略（表示 undefined 值本身）。 */
    readonly type: 'item'
    readonly streamId: string
    readonly value?: unknown
  }
  | {
    /** 客户端半关闭（上行结束）。 */
    readonly type: 'end'
    readonly streamId: string
  }
  | {
    /** 取消这条逻辑流。 */
    readonly type: 'cancel'
    readonly streamId: string
  }
