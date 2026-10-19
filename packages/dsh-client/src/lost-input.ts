/**
 * 失败回合的“未送达请求”恢复。
 *
 * DSH 的回合边界是：发送先插进 agent inbox（排队气泡）→ 回合开始 claim（从
 * 队列移除）→ 组装系统提示 → 只有组装成功才把 user/message 落盘并渲染。若在
 * claim 之后、落盘之前失败（例如 0.2.1 的提示词变量校验），文本只留在
 * `agent/inbox/spliced` 事件里：日志有、界面无、也无从重发。
 *
 * 这里不碰宿主，只沿 DSH 自己的会话事件回放折叠出这个组合：
 *   splice 插入人类消息 → 没有 outcome:'canceled' 的移除（claim）→ 没有同 id
 *   的 user/message → turn/end 的 error 结尾。
 * 命中时在该回合的位置渲染一行“本轮请求未送达”，给复制与直接重发。
 *
 * 所有形状都按结构窄化；服务缺席或形状不符只降级（不重发/不上报），不让
 * 页面挂掉。
 */

import type {
  ConversationContextReader,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, useState } from 'react'
import { NAMESPACE } from './locales.ts'
import styles from './lost-input.module.css'

/** 只做状态折叠、不出节点的 Context kind。 */
export const LOST_INPUT_STATE_KIND = 'threadharbor-lost-input-state'
/** Chat 节点 kind（同时是卡片在 `conversation.chat.node` 槽里的 key）。 */
export const LOST_INPUT_NODE_KIND = 'threadharbor-lost-input'

/** 一条没能进入对话记录的人类消息。 */
export interface LostInputMessage {
  readonly id: string
  readonly text: string
  /** 纯文本才可重发；带附件或没有文本时只能复制。 */
  readonly resendable: boolean
}

/** 折叠时保留在队列里的消息（非人类消息占位以维持 splice 下标）。 */
export interface LostInputQueueMessage extends LostInputMessage {
  readonly human: boolean
}

/** 一个会话的折叠状态：两条 inbox 队列 + 已 claim 未送达的人类消息。 */
export interface LostInputState {
  readonly queues: {
    readonly 'next-turn': readonly LostInputQueueMessage[]
    readonly 'next-step': readonly LostInputQueueMessage[]
  }
  readonly claimed: readonly LostInputMessage[]
}

/** 卡片与 Chat 节点携带的业务数据。 */
export interface LostInputData {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly messages: readonly LostInputMessage[]
}

export const EMPTY_LOST_INPUT_STATE: LostInputState = {
  queues: { 'next-turn': [], 'next-step': [] },
  claimed: [],
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'threadharbor-lost-input': LostInputData
  }
}

/** 折叠只认识的三种事件。 */
interface SpliceEvent {
  readonly type: 'agent/inbox/spliced'
  readonly seq: number
  readonly time?: number
  readonly data: {
    readonly target?: unknown
    readonly start?: unknown
    readonly removedCount?: unknown
    readonly inserted?: readonly unknown[]
    readonly outcome?: unknown
  }
}

interface UserMessageEvent {
  readonly type: 'user/message'
  readonly seq: number
  readonly time?: number
  readonly data: unknown
}

interface TurnEndEvent {
  readonly type: 'turn/end'
  readonly seq: number
  readonly time?: number
  readonly data: { readonly turn?: unknown; readonly reason?: { readonly kind?: unknown } }
}

/** 折叠接受的事件联合。 */
export type LostInputEvent = SpliceEvent | UserMessageEvent | TurnEndEvent

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 从消息内容里取纯文本；出现任何非文本块都不可重发。 */
function contentOf(message: unknown): { text: string; resendable: boolean; human: boolean; id: string } | undefined {
  if (!isRecord(message)) return undefined
  const id = typeof message['id'] === 'string' ? message['id'] : undefined
  if (id === undefined || id === '') return undefined
  const source = isRecord(message['source']) ? message['source'] : undefined
  const content = Array.isArray(message['content']) ? message['content'] : []
  let text = ''
  let resendable = content.length > 0
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') text += block['text']
    else resendable = false
  }
  return {
    id,
    text,
    human: source?.['kind'] === 'user',
    resendable: resendable && text.trim() !== '',
  }
}

function queueMessageOf(message: unknown): LostInputQueueMessage | undefined {
  const parsed = contentOf(message)
  if (parsed === undefined) return undefined
  return { id: parsed.id, text: parsed.text, resendable: parsed.resendable, human: parsed.human }
}

function lostOf(message: LostInputQueueMessage): LostInputMessage {
  return { id: message.id, text: message.text, resendable: message.resendable }
}

/** 同 id 只保留一条（多次 claim/重复插入时的防御）。 */
function uniqueMessages(messages: readonly LostInputMessage[]): readonly LostInputMessage[] {
  const seen = new Set<string>()
  const out: LostInputMessage[] = []
  for (const message of messages) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    out.push(message)
  }
  return out
}

function foldSplice(state: LostInputState, event: SpliceEvent): LostInputState {
  const target: 'next-turn' | 'next-step' = event.data.target === 'next-step' ? 'next-step' : 'next-turn'
  const queue = state.queues[target]
  const start = Math.max(0, asNumber(event.data.start, 0))
  const removedCount = Math.max(0, asNumber(event.data.removedCount, 0))
  const removed = queue.slice(start, start + removedCount)
  const inserted = (event.data.inserted ?? [])
    .map(queueMessageOf)
    .filter((message): message is LostInputQueueMessage => message !== undefined)
  const nextQueue = [...queue.slice(0, start), ...inserted, ...queue.slice(start + removedCount)]
  const canceled = event.data.outcome === 'canceled'
  const claimed = canceled
    ? state.claimed
    : uniqueMessages([...state.claimed, ...removed.filter(message => message.human).map(lostOf)])
  return {
    queues: {
      ...state.queues,
      [target]: nextQueue,
    },
    claimed,
  }
}

function commitMessage(state: LostInputState, id: string): LostInputState {
  return {
    queues: {
      'next-turn': state.queues['next-turn'].filter(message => message.id !== id),
      'next-step': state.queues['next-step'].filter(message => message.id !== id),
    },
    claimed: state.claimed.filter(message => message.id !== id),
  }
}

/**
 * 折叠一个事件。非人类消息只占队列下标，不进候选；turn/end 清空候选，
 * 因为读取方在 turn/end 之前取值（严格向前的 Context 查找）。
 * @param state - 上一个折叠状态。
 * @param event - splice、user/message 或 turn/end。
 * @returns 新状态；无关事件原样返回。
 */
export function foldLostInput(state: LostInputState, event: LostInputEvent): LostInputState {
  if (event.type === 'agent/inbox/spliced') return foldSplice(state, event)
  if (event.type === 'user/message') {
    const parsed = contentOf(event.data)
    if (parsed === undefined || !parsed.human) return state
    return commitMessage(state, parsed.id)
  }
  if (event.type === 'turn/end') return { ...state, claimed: [] }
  return state
}

/**
 * 读取方在 turn/end 之前看到的“已 claim、未送达”的人类消息。
 * @param state - claim 之后、turn/end 之前的状态。
 * @returns 未送达的消息；没有就是空数组。
 */
export function lostInputAtTurnEnd(state: LostInputState): readonly LostInputMessage[] {
  return state.claimed
}

/** 状态 Definition：只折叠，不出节点。 */
export const lostInputStateDefinition: ConversationNodeDefinition<LostInputState> = {
  kind: LOST_INPUT_STATE_KIND,
  match: (event) => {
    if (event.type === 'agent/inbox/spliced' || event.type === 'turn/end') {
      return { id: String(event.seq), role: 'start' }
    }
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      return { id: String(event.seq), role: 'start' }
    }
    return null
  },
  start: (_context, match, reader: ConversationContextReader) => {
    const previous = reader.previous<LostInputState>(LOST_INPUT_STATE_KIND)?.state
    return foldLostInput(previous ?? EMPTY_LOST_INPUT_STATE, match.event as unknown as LostInputEvent)
  },
  update: context => context.state,
  publication: () => 'none',
}

function locationOf(context: ConversationNodeContext<LostInputData | undefined>): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/** 渲染 Definition：只在 error 结尾、且确有未送达消息时出节点。 */
export const lostInputDefinition: ConversationNodeDefinition<LostInputData | undefined> = {
  kind: LOST_INPUT_NODE_KIND,
  target: 'chat',
  match: (event) => event.type === 'turn/end' && event.data.reason.kind === 'error'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader: ConversationContextReader) => {
    if (match.event.type !== 'turn/end') return undefined
    const previous = reader.previous<LostInputState>(LOST_INPUT_STATE_KIND)?.state
    const messages = previous === undefined ? [] : lostInputAtTurnEnd(previous)
    if (messages.length === 0) return undefined
    return {
      turn: match.event.data.turn,
      seq: match.event.seq,
      time: match.event.time,
      messages,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const data = context.state
    if (data === undefined) return null
    return {
      key: context.key,
      kind: LOST_INPUT_NODE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: data.seq,
      location: locationOf(context),
      visibility: 'visible',
      data,
    }
  },
}

/** 卡片注入面：所在会话与重发通道（缺席时只复制）。 */
export interface LostInputCardProps extends PropsRuntime<'conversation.chat.node', 'threadharbor-lost-input'>,
  PropsLocale<typeof NAMESPACE> {
  readonly sessionId?: string | undefined
  readonly resend?: ((text: string) => Promise<void>) | undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 纯文本且所有消息都可重发时，才允许重发。 */
export function canResendLost(
  messages: readonly LostInputMessage[],
  resend: ((text: string) => Promise<void>) | undefined,
): boolean {
  return resend !== undefined
    && messages.length > 0
    && messages.every(message => message.resendable && message.text.trim() !== '')
}

/** 按出现顺序逐条重发；任何一条失败就停在它上面，让原因回到界面。 */
export async function resendLostMessages(
  resend: (text: string) => Promise<void>,
  messages: readonly LostInputMessage[],
): Promise<void> {
  for (const message of messages) await resend(message.text)
}

/** 复制文本；浏览器不给剪贴板时静默失败（按钮仍可点）。 */
function copyText(text: string): void {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard === undefined) return
  void clipboard.writeText(text).catch(() => {})
}

/**
 * The recovery row: title, original text, copy, and resend when available.
 * @param props - node data plus the session-scoped resend face.
 * @returns the row element.
 */
export function LostInputCard(props: LostInputCardProps): ReturnType<typeof createElement> {
  const data = props.node.data
  const resend = props.resend
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const text = data.messages.map(message => message.text).join('\n\n')
  const resendable = canResendLost(data.messages, resend)

  const onCopy = (): void => {
    copyText(text)
    setCopied(true)
  }
  const onResend = (): void => {
    if (!resendable || resend === undefined || phase !== 'idle') return
    setPhase('sending')
    setError(undefined)
    void resendLostMessages(resend, data.messages).then(
      () => { setPhase('sent') },
      (reason: unknown) => {
        setPhase('idle')
        setError(messageOf(reason))
      },
    )
  }

  return createElement(
    'div',
    { className: styles.row, role: 'status', 'data-lost-input': true },
    createElement('span', { className: styles.title }, props.t('lostInput.title')),
    createElement('span', { className: styles.hint }, props.t('lostInput.hint')),
    ...data.messages.map(message => createElement(
      'div',
      { className: styles.text, key: message.id },
      message.text === '' ? props.t('lostInput.emptyText') : message.text,
    )),
    data.messages.some(message => !message.resendable)
      ? createElement('span', { className: styles.hint }, props.t('lostInput.attachments'))
      : null,
    error === undefined
      ? null
      : createElement('span', { className: styles.error }, props.t('lostInput.failed', { reason: error })),
    createElement(
      'div',
      { className: styles.actions },
      createElement('button', {
        type: 'button',
        className: styles.button,
        'data-lost-input-copy': true,
        disabled: text === '',
        onClick: onCopy,
      }, copied ? props.t('lostInput.copied') : props.t('lostInput.copy')),
      resendable
        ? createElement('button', {
          type: 'button',
          className: styles.button,
          'data-lost-input-resend': true,
          disabled: phase !== 'idle',
          onClick: onResend,
        }, phase === 'sent'
          ? props.t('lostInput.sent')
          : phase === 'sending' ? props.t('lostInput.sending') : props.t('lostInput.resend'))
        : null,
    ),
  )
}

/** 从会话 scope 里取 `conversation.send`；任何一环缺席都返回 undefined。 */
export function resendFaceOf(
  sessions: unknown,
  sessionId: string | undefined,
): ((text: string) => Promise<void>) | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const scope = readMethod(sessions, 'scope')
  if (scope === undefined) return undefined
  let scoped: unknown
  try {
    scoped = scope.call(sessions, sessionId)
  } catch {
    return undefined
  }
  const get = readMethod(scoped, 'get')
  if (get === undefined) return undefined
  let conversation: unknown
  try {
    conversation = get.call(scoped, 'conversation')
  } catch {
    return undefined
  }
  const send = readMethod(conversation, 'send')
  if (send === undefined) return undefined
  return async (text: string) => {
    await send.call(conversation, text)
  }
}

function readMethod(target: unknown, name: string): ((this: unknown, ...args: unknown[]) => unknown) | undefined {
  if (!isRecord(target)) return undefined
  const value = target[name]
  return typeof value === 'function' ? value as (this: unknown, ...args: unknown[]) => unknown : undefined
}

function serviceNow(ctx: { get(name: string): unknown }, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 客户端入口需要的面；槽与服务都按结构窄化。 */
export interface LostInputSurfaceContext {
  readonly slots: {
    inject(key: string, callback: () => unknown): unknown
    register(options: unknown, component: unknown): unknown
  }
  get(name: string): unknown
  logger(name: string): { warn(message: string): void }
}

/** 注册状态 Definition、渲染 Definition 与卡片；服务缺席只降级。 */
export function registerLostInputSurface(ctx: LostInputSurfaceContext): void {
  const uiConversation = serviceNow(ctx, 'uiConversation')
  const events = isRecord(uiConversation) ? uiConversation['events'] : undefined
  const register = readMethod(events, 'register')
  if (register === undefined) {
    ctx.logger('threadharbor-client').warn('lost input: uiConversation.events unavailable — failed turns keep their unsent request hidden')
    return
  }
  const registerOn = (definition: unknown): void => {
    try {
      register.call(events, definition)
    } catch (error: unknown) {
      ctx.logger('threadharbor-client').warn(`lost input: definition registration failed: ${messageOf(error)}`)
    }
  }
  registerOn(lostInputStateDefinition)
  registerOn(lostInputDefinition)
  const sessions = serviceNow(ctx, 'sessions')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    {
      name: 'conversation.chat.node',
      key: LOST_INPUT_NODE_KIND,
      locale: NAMESPACE,
      inject: (sessionId: string) => ({ sessionId, resend: resendFaceOf(sessions, sessionId) }),
    },
    LostInputCard,
  ))
}
