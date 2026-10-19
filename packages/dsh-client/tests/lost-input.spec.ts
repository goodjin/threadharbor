/**
 * 失败回合的“未送达请求”恢复：事件折叠、节点产出、卡片与重发。
 *
 * 只钉业务事实，不碰真机：一次 splice 插入 → 回合开始的 claim → 报错，
 * 文本必须还能拿出来；中间有 user/message 就说明送达了；取消的移除不算。
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import {
  EMPTY_LOST_INPUT_STATE,
  LOST_INPUT_NODE_KIND,
  LOST_INPUT_STATE_KIND,
  LostInputCard,
  canResendLost,
  foldLostInput,
  lostInputAtTurnEnd,
  lostInputDefinition,
  lostInputStateDefinition,
  resendFaceOf,
  resendLostMessages,
} from '../src/lost-input.ts'
import { zh } from '../src/locales.ts'

function zhT(key: string, params?: Record<string, unknown>): string {
  const raw = zh[key as keyof typeof zh]
  if (raw === undefined) throw new Error(`missing zh key: ${key}`)
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

const userMessage = (id: string, text: string | undefined, extra: readonly unknown[] = []) => ({
  id,
  content: text === undefined ? [...extra] : [{ type: 'text', text }, ...extra],
  source: { kind: 'user' as const },
})

const splice = (seq: number, target: 'next-turn' | 'next-step', options: {
  start?: number
  removedCount?: number
  inserted?: readonly unknown[]
  outcome?: 'canceled'
}) => ({
  type: 'agent/inbox/spliced' as const,
  seq,
  time: seq,
  data: {
    target,
    start: options.start ?? 0,
    ...(options.removedCount === undefined ? {} : { removedCount: options.removedCount }),
    inserted: options.inserted ?? [],
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
  },
})

const userMessageEvent = (seq: number, id: string, text: string) => ({
  type: 'user/message' as const,
  seq,
  time: seq,
  data: userMessage(id, text),
})

const turnEnd = (seq: number, kind: 'error' | 'completed' | 'interrupted' = 'error') => ({
  type: 'turn/end' as const,
  seq,
  time: seq,
  data: {
    turn: 4,
    reason: kind === 'error'
      ? { kind: 'error', error: { message: 'unknown prompt variable', code: 'UNKNOWN' } }
      : { kind },
  },
})

describe('折叠：插入 → claim → 报错', () => {
  it('claim 后没有任何 user/message，原文仍能拿出来', () => {
    let state = foldLostInput(EMPTY_LOST_INPUT_STATE, splice(1, 'next-turn', { inserted: [userMessage('m1', '有没可能加个账号名？')] }))
    expect(lostInputAtTurnEnd(state)).toEqual([])
    state = foldLostInput(state, splice(2, 'next-turn', { start: 0, removedCount: 1 }))
    expect(lostInputAtTurnEnd(state)).toEqual([{ id: 'm1', text: '有没可能加个账号名？', resendable: true }])
  })

  it('中间落了同 id 的 user/message，就不算未送达', () => {
    let state = foldLostInput(EMPTY_LOST_INPUT_STATE, splice(1, 'next-turn', { inserted: [userMessage('m1', '你好')] }))
    state = foldLostInput(state, splice(2, 'next-turn', { start: 0, removedCount: 1 }))
    state = foldLostInput(state, userMessageEvent(3, 'm1', '你好'))
    expect(lostInputAtTurnEnd(state)).toEqual([])
  })

  it('带 outcome: canceled 的移除是主动丢弃，不算未送达', () => {
    let state = foldLostInput(EMPTY_LOST_INPUT_STATE, splice(1, 'next-turn', { inserted: [userMessage('m1', '你好')] }))
    state = foldLostInput(state, splice(2, 'next-turn', { start: 0, removedCount: 1, outcome: 'canceled' }))
    expect(lostInputAtTurnEnd(state)).toEqual([])
  })

  it('next-step 里的 steer 被 claim 后失败，同样算', () => {
    let state = foldLostInput(EMPTY_LOST_INPUT_STATE, splice(1, 'next-step', { inserted: [userMessage('m1', '顺便改个名')] }))
    state = foldLostInput(state, splice(2, 'next-step', { start: 0, removedCount: 1 }))
    expect(lostInputAtTurnEnd(state)).toEqual([{ id: 'm1', text: '顺便改个名', resendable: true }])
  })

  it('带附件的消息只标记可复制、不可重发', () => {
    let state = foldLostInput(EMPTY_LOST_INPUT_STATE, splice(1, 'next-turn', {
      inserted: [userMessage('m1', undefined, [{ type: 'file', receiptId: 'r1' }])],
    }))
    state = foldLostInput(state, splice(2, 'next-turn', { start: 0, removedCount: 1 }))
    expect(lostInputAtTurnEnd(state)).toEqual([{ id: 'm1', text: '', resendable: false }])
  })

  it('turn/end 之后折叠清空，旧账不会算到下一轮', () => {
    let state = foldLostInput(EMPTY_LOST_INPUT_STATE, splice(1, 'next-turn', { inserted: [userMessage('m1', '你好')] }))
    state = foldLostInput(state, splice(2, 'next-turn', { start: 0, removedCount: 1 }))
    state = foldLostInput(state, turnEnd(3))
    expect(lostInputAtTurnEnd(state)).toEqual([])
  })
})

describe('Definition：什么时候出节点', () => {
  it('状态 Definition 只吃 splice、user/message 与 turn/end', () => {
    expect(lostInputStateDefinition.kind).toBe(LOST_INPUT_STATE_KIND)
    expect(lostInputStateDefinition.match(splice(1, 'next-turn', { inserted: [] }) as never)).not.toBeNull()
    expect(lostInputStateDefinition.match(userMessageEvent(2, 'm1', 'hi') as never)).not.toBeNull()
    expect(lostInputStateDefinition.match(turnEnd(3) as never)).not.toBeNull()
    expect(lostInputStateDefinition.match({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as never)).toBeNull()
  })

  it('只有 error 结尾才渲染；完成/中断都不渲染', () => {
    expect(lostInputDefinition.kind).toBe(LOST_INPUT_NODE_KIND)
    expect(lostInputDefinition.match(turnEnd(9) as never)).not.toBeNull()
    expect(lostInputDefinition.match(turnEnd(9, 'completed') as never)).toBeNull()
    expect(lostInputDefinition.match(turnEnd(9, 'interrupted') as never)).toBeNull()
  })

  it('start 从上一个状态 Context 取原文；没有就 buildViewNode 返回 null', () => {
    let state = foldLostInput(EMPTY_LOST_INPUT_STATE, splice(1, 'next-turn', { inserted: [userMessage('m1', '你好')] }))
    state = foldLostInput(state, splice(2, 'next-turn', { start: 0, removedCount: 1 }))
    const reader = { previous: (kind: string) => kind === LOST_INPUT_STATE_KIND ? { state } : undefined }
    const startEvent = turnEnd(3)
    const data = lostInputDefinition.start({} as never, { event: startEvent, role: 'start', location: { kind: 'turn', turn: { turn: 4, status: 'closed', steps: [], data: {} } } } as never, reader as never)
    expect(data).toEqual({ turn: 4, seq: 3, time: 3, messages: [{ id: 'm1', text: '你好', resendable: true }] })

    const emptyReader = { previous: () => undefined }
    const none = lostInputDefinition.start({} as never, { event: startEvent, role: 'start', location: { kind: 'unresolved' } } as never, emptyReader as never)
    expect(lostInputDefinition.buildViewNode?.({ state: none, key: 'k', kind: LOST_INPUT_NODE_KIND, id: '3', matches: [], start: undefined, current: new Map() } as never)).toBeNull()
  })
})

describe('重发面与卡片', () => {
  class FakeSessions {
    sent: string[] = []
    scope(id: string) {
      expect(id).toBe('session-1')
      return {
        get: (name: string) => name === 'conversation'
          ? { send: async (text: string) => { this.sent.push(text) } }
          : undefined,
      }
    }
  }

  it('从会话 scope 取 conversation.send；缺席时降级为 undefined', async () => {
    const sessions = new FakeSessions()
    const resend = resendFaceOf(sessions, 'session-1')
    expect(resend).toBeDefined()
    await resend?.('你好')
    expect(sessions.sent).toEqual(['你好'])
    expect(resendFaceOf(undefined, 'session-1')).toBeUndefined()
    expect(resendFaceOf({ scope: () => undefined }, 'session-1')).toBeUndefined()
    expect(resendFaceOf({ scope: () => ({ get: () => ({}) }) }, 'session-1')).toBeUndefined()
  })

  it('重发按顺序逐条发；任何一条失败就停在那一条', async () => {
    const sent: string[] = []
    const resend = vi.fn(async (text: string) => {
      if (text === 'bad') throw new Error('boom')
      sent.push(text)
    })
    await resendLostMessages(resend, [
      { id: 'a', text: 'one', resendable: true },
      { id: 'b', text: 'two', resendable: true },
    ])
    expect(sent).toEqual(['one', 'two'])
    await expect(resendLostMessages(resend, [
      { id: 'a', text: 'one', resendable: true },
      { id: 'b', text: 'bad', resendable: true },
      { id: 'c', text: 'three', resendable: true },
    ])).rejects.toThrow('boom')
    expect(sent).toEqual(['one', 'two', 'one'])
  })

  it('有附件或没有重发面时不允许重发', () => {
    const resend = async () => {}
    expect(canResendLost([{ id: 'a', text: 'x', resendable: true }], resend)).toBe(true)
    expect(canResendLost([{ id: 'a', text: 'x', resendable: false }], resend)).toBe(false)
    expect(canResendLost([{ id: 'a', text: 'x', resendable: true }], undefined)).toBe(false)
  })

  it('卡片把原文、复制与重发按钮画出来', () => {
    const markup = renderToString(createElement(LostInputCard, {
      node: { key: 'k', kind: LOST_INPUT_NODE_KIND, id: '3', target: 'chat', data: {
        turn: 4, seq: 3, time: 3,
        messages: [{ id: 'm1', text: '有没可能加个账号名？', resendable: true }],
      } },
      t: zhT,
      sessionId: 'session-1',
      resend: async () => {},
    } as never))
    expect(markup).toContain('data-lost-input')
    expect(markup).toContain('本轮请求未送达')
    expect(markup).toContain('有没可能加个账号名？')
    expect(markup).toContain('data-lost-input-copy')
    expect(markup).toContain('data-lost-input-resend')
  })

  it('带附件时只给复制，并说明原因', () => {
    const markup = renderToString(createElement(LostInputCard, {
      node: { key: 'k', kind: LOST_INPUT_NODE_KIND, id: '3', target: 'chat', data: {
        turn: 4, seq: 3, time: 3,
        messages: [{ id: 'm1', text: '', resendable: false }],
      } },
      t: zhT,
      resend: async () => {},
    } as never))
    expect(markup).toContain('data-lost-input-copy')
    expect(markup).not.toContain('data-lost-input-resend')
    expect(markup).toContain('带附件')
  })
})
