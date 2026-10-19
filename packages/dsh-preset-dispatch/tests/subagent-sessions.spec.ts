/**
 * 子会话构建器：出生建会话、目录事件、实时流、真实终态收尾。
 *
 * 这里钉的是「只展示、不执行、等真实终态」的语义：父回合结束时子会话保持开放，
 * 宿主没有子代理能力包时一个事件都不写（写错事件会让会话日志加载不了）。
 */

import { describe, expect, it } from 'vitest'
import { codexDialect } from '@threadharbor/dsh-acp-agent'
import { SubagentSessions } from '../src/subagent-sessions.ts'
import type { ChildSessionLike, SubagentSessionHost } from '../src/subagent-sessions.ts'

type Written = { readonly target: 'parent' | 'child'; readonly childId?: string; readonly type: string; readonly payload: unknown; readonly intent?: unknown }

/** A fake host that records every write and every emitted live frame. */
function fakeHost(options?: { available?: boolean }) {
  const written: Written[] = []
  const emitted: { childId: string; frame: Record<string, unknown> }[] = []
  const opened: string[] = []
  const children = new Map<string, { session: ChildSessionLike; appends: Written[] }>()

  const host: SubagentSessionHost = {
    available: options?.available ?? true,
    openChild(parentSessionId, childId) {
      if (host.available === false) return undefined
      void parentSessionId
      const appends: Written[] = []
      opened.push(childId)
      let seq = 0
      const session: ChildSessionLike = {
        id: childId,
        header: { createdAt: 1111 },
        get seq() { return seq },
        append: (type, payload, intent) => {
          seq += 1
          const entry: Written = { target: 'child', childId, type, payload, intent }
          appends.push(entry)
          written.push(entry)
          return { seq }
        },
      }
      children.set(childId, { session, appends })
      return session
    },
    appendParent(parentSessionId, type, payload) {
      void parentSessionId
      written.push({ target: 'parent', type, payload })
    },
    emitChildStream(child, frame) {
      emitted.push({ childId: child.id, frame })
    },
  }
  return { host, written, emitted, opened, children }
}

function typesOf(written: readonly Written[], target: 'parent' | 'child' = 'child'): string[] {
  return written.filter(entry => entry.target === target).map(entry => entry.type)
}

describe('SubagentSessions', () => {
  it('有 id 的出生帧：建会话、写目录事件、把任务写成用户消息', () => {
    const { host, written, opened, children } = fakeHost()
    const sessions = new SubagentSessions(host, codexDialect)
    sessions.spawn('parent', 'child-1', 'Calculate', 'do the math')

    expect(opened).toEqual(['acp-sub-child-1'])
    expect(typesOf(written, 'parent')).toEqual(['subagent/catalog'])
    expect(written.find(entry => entry.target === 'parent')!.payload).toEqual({
      version: 0,
      childId: 'acp-sub-child-1',
      childCreatedAt: 1111,
      mode: 'one-shot',
      label: 'Calculate',
    })
    const appends = children.get('acp-sub-child-1')!.appends
    expect(appends.map(entry => entry.type)).toEqual(['turn/start', 'step/start', 'user/message'])
    const user = appends[2]!
    expect((user.payload as { message: { content: { text: string }[] } }).message.content[0]!.text).toBe('do the math')
    expect(user.intent).toEqual({ surfaceOp: 'append' })
  })

  it('无 id 的出生帧推迟建会话，首个增量用出生帧的标签（grok）', () => {
    const { host, written, opened } = fakeHost()
    const sessions = new SubagentSessions(host, codexDialect)
    sessions.spawn('parent', undefined, 'Compute 6 times 7', '')
    expect(opened).toEqual([])
    expect(written).toEqual([])

    sessions.chunk('parent', 'c9f9', 'message', 'hi')
    expect(opened).toEqual(['acp-sub-c9f9'])
    expect(written.find(entry => entry.target === 'parent')!.payload).toMatchObject({ label: 'Compute 6 times 7' })
  })

  it('既无 id 也无增量：零写入', () => {
    const { host, written } = fakeHost()
    const sessions = new SubagentSessions(host, codexDialect)
    sessions.spawn('parent', undefined, 'orphan', '')
    expect(written).toEqual([])
  })

  it('思考与正文增量各走自己的流帧，流只开一次', () => {
    const { host, emitted } = fakeHost()
    const sessions = new SubagentSessions(host, codexDialect)
    sessions.spawn('parent', 'child-1', 'Calc', 'task')
    sessions.chunk('parent', 'child-1', 'thought', 'thinking')
    sessions.chunk('parent', 'child-1', 'message', 'answer')

    const frames = emitted.map(entry => entry.frame)
    expect(frames.filter(frame => frame['type'] === 'start')).toHaveLength(1)
    const chunks = frames.filter(frame => frame['type'] === 'chunk')
    expect(chunks.map(frame => (frame['chunk'] as { type: string }).type)).toEqual(['reasoning-delta', 'text-delta'])
    expect(new Set(emitted.map(entry => entry.childId))).toEqual(new Set(['acp-sub-child-1']))
  })

  it('completed 终态：消息带累积文本与流记录，step/end 与 turn/end 收尾', () => {
    const { host, written, emitted, children } = fakeHost()
    const sessions = new SubagentSessions(host, codexDialect)
    sessions.spawn('parent', 'child-1', 'Calc', 'task')
    sessions.chunk('parent', 'child-1', 'thought', '想一想')
    sessions.chunk('parent', 'child-1', 'message', '答案是 42')
    sessions.terminal('parent', 'child-1', 'completed', undefined)

    const appends = children.get('acp-sub-child-1')!.appends
    expect(appends.map(entry => entry.type)).toEqual(['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
    const message = appends[3]!.payload as { message: { content: { type: string; text: string }[] }; stream: unknown[] }
    expect(message.message.content).toEqual([
      { type: 'reasoning', text: '想一想' },
      { type: 'text', text: '答案是 42' },
    ])
    expect((message.stream as { type: string }[]).map(run => run.type)).toEqual(['reasoning-chunks', 'text-chunks'])
    const turnEnd = appends[5]!.payload as { reason: { kind: string } }
    expect(turnEnd.reason).toEqual({ kind: 'completed' })
    // 收流帧指向刚写的消息
    const end = emitted.filter(entry => entry.frame['type'] === 'end').at(-1)!
    expect((end.frame['outcome'] as { kind: string; seq: number }).kind).toBe('committed')
    expect((end.frame['outcome'] as { seq: number }).seq).toBe(4)
  })

  it('failed 终态把原因写进 turn/end', () => {
    const { host, children } = fakeHost()
    const sessions = new SubagentSessions(host, codexDialect)
    sessions.spawn('parent', 'child-1', 'Calc', 'task')
    sessions.terminal('parent', 'child-1', 'failed', '出错了')
    const turnEnd = children.get('acp-sub-child-1')!.appends.at(-1)!.payload as { reason: { kind: string; error: { message: string; code: string } } }
    expect(turnEnd.reason.kind).toBe('error')
    expect(turnEnd.reason.error).toEqual({ message: '出错了', code: 'SUBAGENT_FAILED' })
  })

  it('父回合结束只放弃流，子会话保持开放', () => {
    const { host, written, emitted } = fakeHost()
    const sessions = new SubagentSessions(host, codexDialect)
    sessions.spawn('parent', 'child-1', 'Calc', 'task')
    sessions.chunk('parent', 'child-1', 'message', 'partial')
    const before = written.length
    sessions.parentTurnEnd('parent')
    expect(written.length).toBe(before)
    const end = emitted.filter(entry => entry.frame['type'] === 'end').at(-1)!
    expect((end.frame['outcome'] as { kind: string }).kind).toBe('abandoned')
  })

  it('宿主无能力包：全部 no-op，零写入', () => {
    const { host, written, opened } = fakeHost({ available: false })
    const sessions = new SubagentSessions(host, codexDialect)
    sessions.spawn('parent', 'child-1', 'Calc', 'task')
    sessions.chunk('parent', 'child-1', 'message', 'hi')
    sessions.terminal('parent', 'child-1', 'completed', undefined)
    sessions.parentTurnEnd('parent')
    expect(opened).toEqual([])
    expect(written).toEqual([])
  })

  it('收尾前未闭合的未知块在终态时先落盘，排在收尾消息之前', () => {
    const { host, children } = fakeHost()
    const sessions = new SubagentSessions(host, codexDialect)
    sessions.spawn('parent', 'child-1', 'Calc', 'task')
    sessions.rawOutputFrame('parent', 'child-1', { method: 'session/update', params: { sessionId: 'child-1', update: { sessionUpdate: 'session_info_update', a: 1 } } })
    sessions.terminal('parent', 'child-1', 'completed', undefined)
    const types = children.get('acp-sub-child-1')!.appends.map(entry => entry.type)
    const messageAt = types.lastIndexOf('assistant/message')
    const callAt = types.indexOf('tool/call')
    expect(callAt).toBeGreaterThanOrEqual(0)
    expect(callAt).toBeLessThan(messageAt)
    expect(types.indexOf('tool/result')).toBeGreaterThan(callAt)
    expect(messageAt).toBeLessThan(types.indexOf('step/end'))
  })

  it('两个子会话交错增量互不串写', () => {
    const { host, emitted, children } = fakeHost()
    const sessions = new SubagentSessions(host, codexDialect)
    sessions.spawn('parent', 'child-1', 'One', 't1')
    sessions.spawn('parent', 'child-2', 'Two', 't2')
    sessions.chunk('parent', 'child-1', 'message', 'a')
    sessions.chunk('parent', 'child-2', 'message', 'b')
    sessions.terminal('parent', 'child-1', 'completed', undefined)
    sessions.terminal('parent', 'child-2', 'completed', undefined)

    const one = children.get('acp-sub-child-1')!.appends
    const two = children.get('acp-sub-child-2')!.appends
    const textOf = (appends: Written[]): string => {
      const message = appends.find(entry => entry.type === 'assistant/message')!.payload as { message: { content: { type: string; text: string }[] } }
      return message.message.content.find(block => block.type === 'text')!.text
    }
    expect(textOf(one)).toBe('a')
    expect(textOf(two)).toBe('b')
    expect(emitted.filter(entry => entry.childId === 'acp-sub-child-1')).toHaveLength(3)
    expect(emitted.filter(entry => entry.childId === 'acp-sub-child-2')).toHaveLength(3)
  })
})
