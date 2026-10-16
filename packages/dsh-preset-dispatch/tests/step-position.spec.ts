/**
 * The session-indexed step position store.
 *
 * The load-bearing rule: the payload the loop's `agent/pre-step` waterfall
 * carries is core-shaped — `{messages, turn, step, signal}` fused with the
 * agent object by the event bus. Core resolves a session from that agent via
 * `agent.session.header.id` (see `underArchivedSession` in
 * dsh-api-session-controller); `agent.id` is the loop's own handle, not the
 * session id. A store keyed by anything else answers `undefined` forever,
 * and every in-place answer silently drops its tool events.
 */

import { describe, expect, it } from 'vitest'
import { forgetSession, positionOfSessionEvents, rememberPreStepPayload, stepPositionOfSession } from '../src/step-position.ts'

const coreShapedAgent = (sessionId: string): object => ({
  id: 'agent-scope-handle',
  session: { header: { id: sessionId } },
})

describe('rememberPreStepPayload', () => {
  it('核心形状的载荷：会话从 session.header.id 解析，位置按会话可查', () => {
    rememberPreStepPayload({ agent: coreShapedAgent('session-real'), turn: 3, step: 1 })
    expect(stepPositionOfSession('session-real')).toEqual({ turn: 3, step: 1 })
  })

  it('旧形状仍然可用：session.id 与 agent.id 依次兜底', () => {
    rememberPreStepPayload({ agent: { session: { id: 'session-flat' } }, turn: 1, step: 2 })
    expect(stepPositionOfSession('session-flat')).toEqual({ turn: 1, step: 2 })
    rememberPreStepPayload({ agent: { id: 'session-as-agent-id' }, turn: 2, step: 1 })
    expect(stepPositionOfSession('session-as-agent-id')).toEqual({ turn: 2, step: 1 })
  })

  it('turn 或 step 不是数字的载荷整体忽略，宁可不记也不记坏', () => {
    rememberPreStepPayload({ agent: coreShapedAgent('session-bad'), turn: '3', step: 1 })
    expect(stepPositionOfSession('session-bad')).toBeUndefined()
  })

  it('解析不出会话的载荷忽略：没有会话索引就没有可查的位置', () => {
    rememberPreStepPayload({ agent: {}, turn: 1, step: 1 })
    // 没有崩溃，也没有污染索引。
    expect(stepPositionOfSession('session-real')).toEqual({ turn: 3, step: 1 })
  })

  it('forgetSession 清掉该会话的索引', () => {
    rememberPreStepPayload({ agent: coreShapedAgent('session-stop'), turn: 1, step: 1 })
    expect(stepPositionOfSession('session-stop')).toEqual({ turn: 1, step: 1 })
    forgetSession('session-stop')
    expect(stepPositionOfSession('session-stop')).toBeUndefined()
  })
})

describe('positionOfSessionEvents', () => {
  const ev = (type: string, data: unknown): { type: string; data: unknown } => ({ type, data })

  it('尾部是打开的步骤：给出该回合与步骤号', () => {
    const events = [
      ev('turn/start', { turn: 8 }),
      ev('step/start', { turn: 8, step: 1 }),
      ev('user/message', { content: [] }),
      ev('request/header', { header: {} }),
    ]
    expect(positionOfSessionEvents(events)).toEqual({ turn: 8, step: 1 })
  })

  it('尾部已见步骤或回合的收尾：没有打开的位置', () => {
    expect(positionOfSessionEvents([
      ev('turn/start', { turn: 8 }),
      ev('step/start', { turn: 8, step: 1 }),
      ev('step/end', { turn: 8, step: 1 }),
    ])).toBeUndefined()
    expect(positionOfSessionEvents([
      ev('turn/start', { turn: 8 }),
      ev('turn/end', { turn: 8, reason: { kind: 'completed' } }),
    ])).toBeUndefined()
  })

  it('回合打开但还没有步骤：没有可写工具事件的位置', () => {
    expect(positionOfSessionEvents([ev('turn/start', { turn: 9 })])).toBeUndefined()
  })

  it('空记录或形状不对：返回 undefined 而不是报错', () => {
    expect(positionOfSessionEvents([])).toBeUndefined()
    expect(positionOfSessionEvents([ev('step/start', null), ev('user/message', {})])).toBeUndefined()
    expect(positionOfSessionEvents([ev('step/start', 'not-an-object')])).toBeUndefined()
  })
})
