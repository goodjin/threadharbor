/**
 * 未知输出块的折叠节点：默认收起，点开看外部 agent 的原始内容。
 *
 * 外部 agent 的帧种类会继续增长，投影只认识其中一部分。看不懂的帧不是垃圾——
 * 用户要能看到它说了什么——但也不该逐帧铺满转录。宿主把这类帧聚成一条
 * `acp/raw-output` 事件落盘，这里把它画成一行折叠条：收起时只有种类与帧数，
 * 展开后是原文。纯展示：不请求、不改会话。
 */

import type {
  ConversationLocation, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeDataMap } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, useState } from 'react'
import type { ReactNode } from 'react'
import { NAMESPACE } from './locales.ts'

/** One aggregated run of unmapped frames, as the host wrote it. */
export interface RawOutputData {
  readonly turn: number
  readonly step: number
  readonly kind: string
  readonly format: 'json' | 'text'
  /** 首行「（N 帧）」，其后每帧一行。 */
  readonly content: string
  readonly count: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 未映射帧的聚合块：插件事件，读者不认识可跳过（宿主落盘时带 ignorable）。 */
    'acp/raw-output': RawOutputData
  }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'acp-raw-output': RawOutputData
  }
}

/** Per-node fold of the Definition: one event, one node. */
interface RawOutputState {
  readonly data: RawOutputData
  readonly seq: number
}

/**
 * One raw-output event, one node.
 *
 * The event is the whole node, so its own match opens the Context as a
 * `start`; there are no later matches to fold.
 */
export const rawOutputDefinition: ConversationNodeDefinition<RawOutputState> = {
  kind: 'acp-raw-output',
  target: 'chat',
  match: (event) => (event.type === 'acp/raw-output'
    ? { id: String(event.seq), role: 'start' }
    : null),
  start: (_context, match) => {
    if (match.event.type !== 'acp/raw-output') throw new Error('acp-raw-output start requires acp/raw-output')
    return { data: match.event.data, seq: match.event.seq }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const location: ConversationLocation = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
    return {
      key: context.key,
      kind: 'acp-raw-output',
      id: context.id,
      target: 'chat',
      anchorSeq: state.seq,
      location,
      visibility: 'visible',
      data: state.data,
    }
  },
}

/** Component props: the node's data plus the locale `t` seat. */
export type RawOutputCardProps = PropsRuntime<'conversation.chat.node', 'acp-raw-output'>
  & PropsLocale<typeof NAMESPACE>

/** The collapsed disclosure row; expanded shows the aggregated frames verbatim. */
export function RawOutputCard(props: RawOutputCardProps): ReactNode {
  const data = props.node.data
  const [open, setOpen] = useState(false)
  const label = props.t('rawOutput.title', { kind: data.kind, count: data.count })
  return createElement(
    'div',
    null,
    createElement(
      'button',
      {
        type: 'button',
        'aria-expanded': open,
        'aria-label': open ? props.t('rawOutput.collapse') : props.t('rawOutput.expand'),
        onClick: () => { setOpen(value => !value) },
      },
      label,
    ),
    open ? createElement('pre', null, data.content) : null,
  )
}

/** What the surface needs from the page's context. */
export type RawOutputSurfaceContext = {
  logger(name: string): { info(message: string): void; warn(message: string): void }
  get(name: string): unknown
  slots: {
    inject(key: string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void
    register: SlotCore['register']
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Read one declared service off the context, tolerating a refusing read. */
function serviceNow(ctx: RawOutputSurfaceContext, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Bind the conversation registry's `register` to its owner (detached it dies on `this`). */
function conversationRegisterOf(uiConversation: Record<string, unknown>): ((definition: unknown) => unknown) | undefined {
  const events = uiConversation['events']
  if (!isRecord(events)) return undefined
  const register = events['register']
  if (typeof register !== 'function') return undefined
  const bound = (register as (this: unknown, definition: unknown) => unknown).bind(events)
  return definition => bound(definition)
}

/**
 * Register the raw-output surface: the Chat Definition plus its keyed renderer.
 *
 * Both ride the same seams as DSH's own Chat nodes. A service that is absent or
 * shaped differently degrades to one log line — raw output then keeps existing
 * only as data, never as a broken page.
 */
export function installRawOutputSurface(ctx: RawOutputSurfaceContext): void {
  const uiConversation = serviceNow(ctx, 'uiConversation')
  const register = isRecord(uiConversation) ? conversationRegisterOf(uiConversation) : undefined
  if (register === undefined) {
    ctx.logger('threadharbor-client').warn('raw output: uiConversation unavailable — unmapped frames stay data-only, no card')
    return
  }
  register(rawOutputDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'acp-raw-output', locale: NAMESPACE },
    RawOutputCard,
  ))
}
