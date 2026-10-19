/**
 * 消息事件构造器：每一类事件都必须满足宿主加载时的形状规则。
 *
 * 这里把规则本身写成断言（与 reference 的 `assertMessageEventShape` 逐条对应），
 * 任何调用方拿到的事件都只能长成这样。
 */

import { describe, expect, it } from 'vitest'
import {
  assistantMessageEvent,
  systemNoteEvent,
  toolCallAnnouncementEvent,
  toolCallEvent,
  toolResultMessageEvent,
  userMessageEvent,
} from '../src/message-events.ts'

describe('systemNoteEvent', () => {
  it('source 恰好是 system-prompt（写错会让会话永久加载不了）', () => {
    const event = systemNoteEvent(3, 1, '等待外部 agent')
    const payload = event.payload as { turn: number; step: number; message: { id: string; role: string; content: { text: string }[]; source: unknown } }
    expect(event.type).toBe('system/message')
    expect(payload.turn).toBe(3)
    expect(payload.step).toBe(1)
    expect(payload.message.role).toBe('system')
    expect(payload.message.id.length).toBeGreaterThan(0)
    expect(payload.message.source).toEqual({ kind: 'system-prompt' })
    expect(payload.message.content[0]!.text).toBe('等待外部 agent')
  })
})

describe('userMessageEvent', () => {
  it('role=user、source=user、带 id 与文本块', () => {
    const event = userMessageEvent(1, 'hi')
    const payload = event.payload as { message: { id: string; role: string; content: { type: string }[]; source: { kind: string } } }
    expect(event.type).toBe('user/message')
    expect(payload.message.role).toBe('user')
    expect(payload.message.source.kind).toBe('user')
    expect(payload.message.content).toEqual([{ type: 'text', text: 'hi' }])
  })
})

describe('assistantMessageEvent', () => {
  it('source 是 model 来源且 provider/model 非空，stream 必带', () => {
    const event = assistantMessageEvent({
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: '答案' }],
      provider: 'acp-codex',
      model: 'codex',
      stream: [],
    })
    const payload = event.payload as { message: { role: string; source: { kind: string; provider: string; model: string } }; stream: unknown[] }
    expect(payload.message.role).toBe('assistant')
    expect(payload.message.source).toEqual({ kind: 'model', provider: 'acp-codex', model: 'codex' })
    expect(payload.stream).toEqual([])
  })

  it('用量原样挂在载荷上', () => {
    const usage = { inputTokens: 1, outputTokens: 2 }
    const event = assistantMessageEvent({ turn: 1, step: 1, content: [], provider: 'p', model: 'm', stream: [], usage })
    expect((event.payload as { usage: unknown }).usage).toEqual(usage)
  })
})

describe('toolCallAnnouncementEvent', () => {
  it('公告消息只含一个工具调用块，且带 model 来源', () => {
    const event = toolCallAnnouncementEvent({
      turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}', provider: 'acp-codex', model: 'codex',
    })
    const payload = event.payload as { message: { content: { type: string; id: string; name: string; arguments: string }[]; source: { kind: string } }; stream: unknown[] }
    expect(payload.message.content).toEqual([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }])
    expect(payload.message.source.kind).toBe('model')
    expect(payload.stream).toEqual([])
  })
})

describe('toolCallEvent / toolResultMessageEvent', () => {
  it('调用与结果的形状固定，结果与调用同 callId', () => {
    const call = toolCallEvent({ turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    expect(call).toEqual({ type: 'tool/call', payload: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } })

    const result = toolResultMessageEvent({ turn: 1, step: 1, callId: 'c1', text: 'ok', isError: false })
    const payload = result.payload as { message: { id: string; role: string; source: { kind: string; callId: string }; toolCallId: string; isError: boolean; content: { text: string }[] } }
    expect(payload.message.role).toBe('tool')
    expect(payload.message.source).toEqual({ kind: 'tool', callId: 'c1' })
    expect(payload.message.toolCallId).toBe('c1')
    expect(payload.message.isError).toBe(false)
    expect(payload.message.content[0]!.text).toBe('ok')
  })

  it('错误结果带上 error 字段', () => {
    const result = toolResultMessageEvent({
      turn: 1, step: 1, callId: 'c1', text: 'boom', isError: true,
      error: { name: 'tool', code: 'failed', reason: 'boom' },
    })
    expect((result.payload as { error: unknown }).error).toEqual({ name: 'tool', code: 'failed', reason: 'boom' })
  })
})
