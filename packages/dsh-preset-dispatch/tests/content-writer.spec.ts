/**
 * Writing projected content back onto the session.
 *
 * The three event types are not interchangeable at the call site, and getting
 * it wrong fails quietly rather than loudly:
 *
 * - a message is a *surface* event, so its append must carry a surface intent;
 * - a tool call is *log-only*, where a third argument is not just useless but
 *   rejected — passing one loses the event;
 * - a tool result is a surface event that must point back at the call it
 *   answers, by sequence number. Without that link the result lands in the
 *   transcript as an orphan the UI cannot pair with anything.
 *
 * So the shape is decided once, here, rather than at each call site.
 */

import { describe, expect, it } from 'vitest'
import { makeContentWriter } from '../src/content-writer.ts'

interface Call {
  type: string
  payload: unknown
  intent?: { surfaceOp?: string; sourceEventSeqs?: readonly number[] }
}

function session() {
  const calls: Call[] = []
  let seq = 0
  return {
    calls,
    append(type: string, payload: unknown, intent?: Call['intent']) {
      calls.push({ type, payload, ...(intent === undefined ? {} : { intent }) })
      seq += 1
      return { seq }
    },
  }
}

const message = { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }
const call = { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: { command: 'ls' } }
const result = { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }

describe('makeContentWriter', () => {
  it('marks a message as a surface append', () => {
    const target = session()
    makeContentWriter(target.append)([{ type: 'assistant/message', payload: message }])
    expect(target.calls[0]).toMatchObject({ type: 'assistant/message', intent: { surfaceOp: 'append' } })
  })

  it('writes a tool call without a surface intent', () => {
    // A tool call is log-only. Passing an intent here loses the event, so the
    // absence of the third argument is the correct call, not an oversight.
    const target = session()
    makeContentWriter(target.append)([{ type: 'tool/call', payload: call }])
    expect(target.calls[0]!.intent).toBeUndefined()
  })

  it('points a tool result back at the call it answers', () => {
    const target = session()
    const write = makeContentWriter(target.append)
    write([{ type: 'tool/call', payload: call }])
    write([{ type: 'tool/result', payload: result }])
    const resultCall = target.calls.find(c => c.type === 'tool/result')!
    expect(resultCall.intent).toEqual({ surfaceOp: 'append', sourceEventSeqs: [1] })
  })

  it('keeps each call answerable when several run in one turn', () => {
    const target = session()
    const write = makeContentWriter(target.append)
    write([
      { type: 'tool/call', payload: { ...call, callId: 'c1' } },
      { type: 'tool/call', payload: { ...call, callId: 'c2' } },
    ])
    write([
      { type: 'tool/result', payload: { ...result, message: { ...result.message, toolCallId: 'c2' } } },
    ])
    const answer = target.calls.find(c => c.type === 'tool/result')!
    // Sequence 2 is the second call, not the first.
    expect(answer.intent?.sourceEventSeqs).toEqual([2])
  })

  it('still writes a result whose call it cannot find', () => {
    // Dropping it would lose the agent's output; an unpaired result is better
    // than a missing one, and the reason is reported by the caller.
    const target = session()
    makeContentWriter(target.append)([{ type: 'tool/result', payload: result }])
    expect(target.calls).toHaveLength(1)
    expect(target.calls[0]!.intent).toEqual({ surfaceOp: 'append' })
  })

  it('reports which result had no call behind it', () => {
    const target = session()
    const orphans: string[] = []
    makeContentWriter(target.append, result => orphans.push(result))([
      { type: 'tool/result', payload: result },
    ])
    expect(orphans).toEqual(['c1'])
  })

  it('skips an event type it does not know', () => {
    // Unknown types are someone else's events; writing them under our guess
    // would corrupt the transcript.
    const target = session()
    makeContentWriter(target.append)([{ type: 'assistant/attempt', payload: {} }])
    expect(target.calls).toEqual([])
  })

  it('lets one bad event not swallow the rest of the turn', () => {
    const target = session()
    const write = makeContentWriter(target.append)
    write([{ type: 'assistant/message', payload: message }])
    write([{ type: 'tool/call', payload: call }])
    expect(target.calls.map(c => c.type)).toEqual(['assistant/message', 'tool/call'])
  })

  it('stops pairing after a new turn starts', () => {
    // Turn numbers restart per turn, so a call id reused later must not pick up
    // an earlier turn's sequence number.
    const target = session()
    const write = makeContentWriter(target.append)
    write([{ type: 'tool/call', payload: { ...call, callId: 'c1', turn: 1 } }])
    write([{ type: 'tool/result', payload: { ...result, message: { ...result.message, toolCallId: 'c1' }, turn: 2 } }])
    expect(target.calls.find(c => c.type === 'tool/result')!.intent?.sourceEventSeqs).toBeUndefined()
  })
})