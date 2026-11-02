/**
 * Putting a finished conversation back on a record, one event at a time.
 *
 * A switch continues in a new session, and the conversation that came before it
 * has to be visible there — otherwise the user opens the new session and reads
 * an empty thread while the agent has the whole history. The events that carry
 * the visible conversation are copied in order; everything else is the old
 * agent's own bookkeeping (its request header, its system prompt, its retry
 * records, its seed marker) and stays behind.
 *
 * The properties these tests pin:
 *
 * - the copy stops at the last completed turn, so the turn that is switching
 *   away — open, and holding the question that is about to be asked in the new
 *   session — is never carried twice;
 * - turn and step boundaries travel with the content, because the view groups
 *   content under the step the loop opened for it;
 * - a surface replacement (a compaction checkpoint) is left behind rather than
 *   replayed against surface positions that no longer exist.
 */

import { describe, expect, it } from 'vitest'
import { planReplay, replayInto } from '../src/replay.ts'
import type { LoggedEvent } from '../src/replay.ts'

/** One finished turn: a question, an answer, and one tool call between them. */
function turn(turnNumber: number, marker: string): LoggedEvent[] {
  return [
    { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'chat' } }, reason: 'initial' } },
    { type: 'system/message', data: { turn: turnNumber, step: 1, message: { role: 'system', content: [{ type: 'text', text: '旧系统提示' }] } } },
    { type: 'turn/start', data: { turn: turnNumber } },
    { type: 'step/start', data: { turn: turnNumber, step: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `问题${marker}` }] } },
    { type: 'assistant/message', data: { turn: turnNumber, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `我要查一下${marker}` }] }, stream: [] } },
    { type: 'tool/call', data: { turn: turnNumber, step: 1, callId: `call-${marker}`, name: 'read', arguments: '{}' } },
    { type: 'tool/result', data: { turn: turnNumber, step: 1, message: { role: 'tool', content: [{ type: 'text', text: `结果${marker}` }], source: { callId: `call-${marker}` }, toolCallId: `call-${marker}` } } },
    { type: 'assistant/message', data: { turn: turnNumber, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `回答${marker}` }] }, stream: [] } },
    { type: 'step/end', data: { turn: turnNumber, step: 1 } },
    { type: 'turn/end', data: { turn: turnNumber, reason: { kind: 'completed' } } },
  ]
}

/** The turn the switch itself is running in: open, and holding the new question. */
function openTurn(turnNumber: number): LoggedEvent[] {
  return [
    { type: 'turn/start', data: { turn: turnNumber } },
    { type: 'step/start', data: { turn: turnNumber, step: 1 } },
    { type: 'agent/inbox/spliced', data: { target: 'queue' } },
  ]
}

describe('planReplay', () => {
  it('carries the conversation with its boundaries and leaves the old bookkeeping behind', () => {
    const plan = planReplay([...turn(1, 'a'), ...turn(2, 'b')])

    expect(plan.steps.map(step => step.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'assistant/message',
      'step/end',
      'turn/end',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(plan.turns).toBe(2)
  })

  it('carries the words themselves, not a summary of them', () => {
    const plan = planReplay(turn(1, 'a'))
    const asked = plan.steps.find(step => step.type === 'user/message')

    expect(asked?.data).toEqual({ role: 'user', content: [{ type: 'text', text: '问题a' }] })
    const answer = plan.steps.filter(step => step.type === 'assistant/message')[1]
    expect(answer?.data).toMatchObject({ message: { content: [{ type: 'text', text: '回答a' }] } })
  })

  it('stops at the last completed turn, so the switching turn is never carried', () => {
    // The turn doing the switch is open: its question is about to be asked in
    // the new session, and copying it here would put one question in two logs.
    const plan = planReplay([...turn(1, 'a'), ...openTurn(2)])

    expect(plan.turns).toBe(1)
    expect(JSON.stringify(plan.steps)).not.toContain('agent/inbox/spliced')
  })

  it('marks only the model-visible messages as needing the surface intent', () => {
    const plan = planReplay(turn(1, 'a'))

    expect(plan.steps.filter(step => step.surface).map(step => step.type))
      .toEqual(['user/message', 'assistant/message', 'tool/result', 'assistant/message'])
  })

  it('leaves a surface replacement behind instead of replaying it', () => {
    // A compaction checkpoint replaces an earlier range by sequence number; in
    // the new session those positions belong to different events.
    const plan = planReplay([
      ...turn(1, 'a'),
      { type: 'user/message', surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, data: { role: 'user', content: [{ type: 'text', text: '压缩检查点' }] } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])

    expect(JSON.stringify(plan.steps)).not.toContain('压缩检查点')
  })

  it('never leaves an inherited seed marker on a session that is not seeded', () => {
    // That marker is only legal in a seeded session's inherited prefix; a
    // copied one would make the new session's own log unreadable on reload.
    const plan = planReplay([
      { type: 'session/end-seed', data: { inherited: true } },
      ...turn(1, 'a'),
    ])

    expect(plan.steps.map(step => step.type)).not.toContain('session/end-seed')
  })

  it('carries every finished turn, oldest first', () => {
    const plan = planReplay([...turn(1, 'a'), ...turn(2, 'b')])

    expect(plan.turns).toBe(2)
    expect(JSON.stringify(plan.steps).indexOf('问题a')).toBeLessThan(JSON.stringify(plan.steps).indexOf('问题b'))
  })

  it('has nothing to carry in a session that never finished a turn', () => {
    expect(planReplay(openTurn(1)).steps).toEqual([])
    expect(planReplay([]).steps).toEqual([])
  })
})

describe('replayInto', () => {
  /** A session stand-in recording exactly what was appended and how. */
  function recordingSession(): { session: object; calls: { type: string; data: unknown; intent?: unknown }[] } {
    const calls: { type: string; data: unknown; intent?: unknown }[] = []
    return {
      session: {
        append(type: string, data: unknown, intent?: unknown): { seq: number } {
          calls.push({ type, data, ...(intent === undefined ? {} : { intent }) })
          return { seq: calls.length }
        },
      },
      calls,
    }
  }

  it('appends the plan in order, giving the surface intent to messages and nothing else', () => {
    const plan = planReplay(turn(1, 'a'))
    const { session, calls } = recordingSession()

    expect(replayInto(session, plan.steps)).toBe(plan.steps.length)
    expect(calls.map(call => call.type)).toEqual(plan.steps.map(step => step.type))
    expect(calls.find(call => call.type === 'user/message')?.intent).toEqual({ surfaceOp: 'append' })
    expect(calls.find(call => call.type === 'tool/call')?.intent).toBeUndefined()
    expect(calls.find(call => call.type === 'turn/start')?.intent).toBeUndefined()
  })

  it('says so when the session cannot take events, rather than reporting a partial copy', () => {
    expect(() => replayInto({}, planReplay(turn(1, 'a')).steps))
      .toThrow(/cannot replay the conversation/)
  })

  it('names how far it got when one event is refused', () => {
    const plan = planReplay(turn(1, 'a'))
    let seen = 0
    const session = {
      append(): { seq: number } {
        seen += 1
        if (seen === 3) throw new Error('surface rejected this one')
        return { seq: seen }
      },
    }

    expect(() => replayInto(session, plan.steps))
      .toThrow(new RegExp(`2 of ${plan.steps.length} events.*surface rejected this one`))
  })
})
