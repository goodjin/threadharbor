/**
 * 消息事件的唯一构造入口：把「写对形状」这件事从各调用方收回到一处。
 *
 * 落盘层对每一类消息事件都有专用规则，而它们只在**会话下次加载**时才校验：
 * system/message 的 source.kind 必须恰好是 `system-prompt`；assistant/message
 * 必须是 `model` 来源且带 provider/model；tool/result 必须是 `tool` 来源、
 * 带 callId 且与 message.toolCallId 一致；每种消息都要有非空 id 与 content 数组。
 *
 * 手拼这些字段出过一次事故（静默提示的 source 写成 `acp-gateway`，整份会话日志
 * 永久加载不了）。所以这里按事件类型给出构造函数，调用方只传语义参数——形状
 * 不再由调用方决定，写错的形状根本构造不出来。
 *
 * 参考：`reference/deepseek-harness/packages/core/session/src/index.ts` 的
 * `assertMessageEventShape`（system-prompt / model / tool 三条来源规则）。
 */

import { randomUUID } from 'node:crypto'

/** 一条待落盘的会话事件（类型 + 载荷；写入意图由调用方决定）。 */
export type MessageEvent = { readonly type: string; readonly payload: unknown }

/** 助手/系统消息的文本块。 */
export type TextBlock = { readonly type: 'text'; readonly text: string }
/** 助手的思考块。 */
export type ReasoningBlock = { readonly type: 'reasoning'; readonly text: string }
/** 助手消息里的工具调用公告块。 */
export type ToolCallBlock = { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }

/** 一条系统提示事件（`system/message`）。 */
export function systemNoteEvent(turn: number, step: number, text: string): MessageEvent {
  return {
    type: 'system/message',
    payload: {
      turn,
      step,
      message: {
        id: randomUUID(),
        role: 'system',
        content: [{ type: 'text', text }],
        // 唯一的合法来源：宿主加载时要求 system/message 的 source.kind 恰好是它。
        source: { kind: 'system-prompt' },
      },
    },
  }
}

/** 一条用户消息事件（`user/message`）。 */
export function userMessageEvent(turn: number, text: string): MessageEvent {
  return {
    type: 'user/message',
    payload: {
      turn,
      message: {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
    },
  }
}

/**
 * 一条助手消息事件（`assistant/message`）。
 *
 * source 固定为 `model` 并带上 provider/model（宿主加载时两者都要求非空）；
 * `stream` 是紧凑流记录，必带（可为空数组）。
 */
export function assistantMessageEvent(options: {
  readonly turn: number
  readonly step: number
  readonly content: readonly (TextBlock | ReasoningBlock | ToolCallBlock)[]
  readonly provider: string
  readonly model: string
  readonly stream: readonly unknown[]
  readonly usage?: unknown
}): MessageEvent {
  return {
    type: 'assistant/message',
    payload: {
      turn: options.turn,
      step: options.step,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: options.content,
        source: { kind: 'model', provider: options.provider, model: options.model },
      },
      stream: options.stream,
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    },
  }
}

/**
 * 一条工具结果的公告消息：只含一个工具调用块，用来让随后的 `tool/call` 被日志接纳。
 *
 * 每个 `tool/call` 之前都必须有这样一条消息（同名、同参数序列化），否则会话
 * 打开时「does not match one advertised tool call」。
 */
export function toolCallAnnouncementEvent(options: {
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly provider: string
  readonly model: string
}): MessageEvent {
  return assistantMessageEvent({
    turn: options.turn,
    step: options.step,
    content: [{ type: 'tool-call', id: options.callId, name: options.name, arguments: options.arguments }],
    provider: options.provider,
    model: options.model,
    stream: [],
  })
}

/** 一条工具调用事件（`tool/call`）。 */
export function toolCallEvent(options: {
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly name: string
  readonly arguments: string
}): MessageEvent {
  return {
    type: 'tool/call',
    payload: {
      turn: options.turn,
      step: options.step,
      callId: options.callId,
      name: options.name,
      arguments: options.arguments,
    },
  }
}

/**
 * 一条工具结果事件（`tool/result`）。
 *
 * source 固定为 `tool` 并带 callId，`message.toolCallId` 与它同源生成——宿主
 * 加载时要求两者一致。
 */
export function toolResultMessageEvent(options: {
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly text: string
  readonly isError: boolean
  readonly error?: { readonly name: string; readonly code: string; readonly reason?: string }
}): MessageEvent {
  return {
    type: 'tool/result',
    payload: {
      turn: options.turn,
      step: options.step,
      message: {
        id: randomUUID(),
        role: 'tool',
        // 空输出写成空内容数组（投影的既有形状），非空才带文本块。
        content: options.text === '' ? [] : [{ type: 'text', text: options.text }],
        source: { kind: 'tool', callId: options.callId },
        toolCallId: options.callId,
        isError: options.isError,
      },
      ...(options.error === undefined ? {} : { error: options.error }),
    },
  }
}
