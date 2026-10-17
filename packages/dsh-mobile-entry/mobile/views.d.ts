/**
 * mobile/views.js 的手写声明：views.js 是浏览器原生 ESM（无构建链），有意
 * 不进 tsc 编译范围（包 tsconfig 只 include src/tests 的 .ts）。本声明服务
 * tests/views.spec.ts 与 tests/app.spec.ts 的类型检查，改 views.js 行为时
 * 同步改这里。
 */

/** HTML 转义：&, <, >, ", ' 全量替换。 */
export declare function escapeHtml(value: unknown): string

/** rpcCall 失败种类 → 引导分支；只有 unpaired/untrusted 两支，其余 null（R2）。 */
export declare function guidanceReasonForKind(kind: unknown): 'unpaired' | 'untrusted' | null

/** 启动中的整屏文案。 */
export declare function renderLoading(): string

/** 启动失败整屏：错误原文 + Tailscale 检查提示 + 重试按钮（data-action="retry-boot"）。 */
export declare function renderErrorScreen(message: string): string

/** 配对引导屏（R2：只有 'unpaired' | 'untrusted' 两支）。 */
/**
 * reason 只收两支（无效令牌等第三种情况不进引导）。mode 省略时是直连模式，
 * 文案逐字不变；中转模式换成对中转站配对的那一套。
 */
export declare function pairingGuideView(reason: 'unpaired' | 'untrusted', mode?: 'machine' | 'hub'): string

/** 一台 peer 的形状（Task 5 应答项）。 */
export interface PeerBody {
  dnsName: string
  online: boolean
  dsh: boolean
}

/** renderHostList 输入：peers 只是展示，不跨域连接；error 带原文时提示不可用。 */
export interface HostListState {
  peers?: readonly PeerBody[]
  error?: string
  loading?: boolean
}

export declare function renderHostList(state: HostListState): string

/** session/list 应答项的最小投影（Task 6 §3.1 实测字段；projections 放宽）。 */
export interface SessionSummaryView {
  sessionId: string
  updatedAt: number
  running: boolean
  blank?: boolean
  agentAvailable?: boolean
  projections?: { values?: { title?: string } } & Record<string, unknown>
}

export interface SessionListState {
  items?: readonly SessionSummaryView[]
  hasMore?: boolean
}

export declare function renderSessionList(state: SessionListState): string

/** stateFold 的 durable 记录：session/page 与 follow 流的 event 帧原样保存。 */
export interface EventRecord {
  type: 'event'
  event: { type: string, seq: number, time?: number, data?: unknown }
}

/** assistant-stream 下行帧（Task 6 §4.2 实测帧形）。 */
export type AssistantStreamFrame =
  | { type: 'start', attemptId: string, revision: number, turn: number, step: number, startedAfterSeq: number }
  | { type: 'chunk', attemptId: string, revision: number, index: number, time?: number, chunk: unknown }
  | { type: 'end', attemptId: string, revision: number, index: number, outcome: unknown }

/** 对话状态：records 升序去重，streams 是在途流式块，hasMore 表示更早还有页。 */
export interface ConversationState {
  records: EventRecord[]
  streams: Array<{ attemptId: string, revision: number, blocks: AssistantStreamFrame[] }>
  hasMore: boolean
}

/** stateFold 的三类变更（外加原样拷贝的兜底）。 */
export type StateChange =
  | { kind: 'append', records?: readonly unknown[] }
  | { kind: 'prepend', records?: readonly unknown[], hasMore: boolean }
  | { kind: 'assistant-stream', frame?: AssistantStreamFrame }

/** 事件归并：纯函数，不改写入参；同一变更重放得到深度相等的状态（幂等）。 */
export declare function stateFold(prev: ConversationState | null, change: StateChange): ConversationState

export interface ConversationViewState {
  session: { sessionId: string, title?: string, running?: boolean }
  conv: ConversationState | null
  hasMore?: boolean
  loading?: boolean
  error?: string
}

export declare function renderConversation(state: ConversationViewState): string

/** 一条待批权限（waterfall approval/request 的最小投影）。 */
export interface ApprovalItem {
  eventId: string
  toolName: string
  displayReason?: string
  reason?: string
  /** 应答在途：该横幅的批准/拒绝按钮渲染为 disabled。 */
  pending?: boolean
}

export declare function renderApprovalBanners(items: readonly ApprovalItem[]): string
