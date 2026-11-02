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
import { makeContentWriter, makeToolOnlyWriter } from '../src/content-writer.ts'

interface Call {
  type: string
  payload: unknown
  intent?: {
    surfaceOp?: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
    sourceEventSeqs?: readonly number[]
  }
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
const result = { turn: 1, step: 1, message: { id: 'result-1', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }

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

  it('drops a result whose call it cannot find', () => {
    // The log refuses the whole file over one result with no lifecycle
    // (`tool/result … has no advertised tool lifecycle`). Losing this output is
    // the smaller loss, and the caller is told which call lost it.
    const target = session()
    const orphans: string[] = []
    makeContentWriter(target.append, callId => orphans.push(callId))([
      { type: 'tool/result', payload: result },
    ])
    expect(target.calls).toEqual([])
    expect(orphans).toEqual(['c1'])
  })

  it('reports which result had no call behind it', () => {
    const target = session()
    const orphans: string[] = []
    makeContentWriter(target.append, result => orphans.push(result))([
      { type: 'tool/result', payload: result },
    ])
    expect(orphans).toEqual(['c1'])
  })

  it('refines a repeated result instead of appending a second one', () => {
    // One call answers once; a second append is what made the session
    // unloadable. Live output updates arrive as content-only replacements of
    // the result already on the log.
    const target = session()
    const write = makeContentWriter(target.append)
    write([{ type: 'tool/call', payload: call }])
    write([{ type: 'tool/result', payload: result }])
    write([{
      type: 'tool/result',
      payload: {
        ...result,
        message: {
          ...result.message,
          id: 'later-message',
          content: [{ type: 'text', text: 'ok, more' }],
        },
      },
    }])
    const writes = target.calls.filter(c => c.type === 'tool/result')
    expect(writes).toHaveLength(2)
    expect(writes[0]!.intent).toEqual({ surfaceOp: 'append', sourceEventSeqs: [1] })
    // Replacement targets the current result node and rewrites exactly it.
    expect(writes[1]!.intent).toEqual({
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
      sourceEventSeqs: [2],
    })
    // Only the content may change: the message id stays the first one's, or
    // the live append path refuses the replacement.
    expect(writes[1]!.payload).toMatchObject({
      message: { id: 'result-1', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok, more' }] },
    })
  })

  it('chains replacements onto the newest result node', () => {
    const target = session()
    const write = makeContentWriter(target.append)
    write([{ type: 'tool/call', payload: call }])
    write([{ type: 'tool/result', payload: result }])
    write([{ type: 'tool/result', payload: { ...result, message: { ...result.message, content: [{ type: 'text', text: 'a' }] } } }])
    write([{ type: 'tool/result', payload: { ...result, message: { ...result.message, content: [{ type: 'text', text: 'ab' }] } } }])
    const writes = target.calls.filter(c => c.type === 'tool/result')
    expect(writes[2]!.intent?.surfaceOp).toEqual({ op: 'replace', startSeq: 3, endSeq: 3 })
    expect(writes[2]!.payload).toMatchObject({ message: { content: [{ type: 'text', text: 'ab' }] } })
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

  it('writes a system note as a surface append', () => {
    // 状态提示走的就是这条路：形状由 systemNoteEvent 保证，写入器只补 surface 意图。
    const target = session()
    const note = {
      turn: 1,
      step: 1,
      message: {
        id: 'n1',
        role: 'system',
        content: [{ type: 'text', text: 'codex 正在压缩上下文' }],
        source: { kind: 'system-prompt' },
      },
    }
    makeContentWriter(target.append)([{ type: 'system/message', payload: note }])
    expect(target.calls[0]).toMatchObject({ type: 'system/message', intent: { surfaceOp: 'append' } })
  })

  it('stops pairing after a new turn starts', () => {
    // Turn numbers restart per turn, so a call id reused later must not pick up
    // an earlier turn's sequence number — and a result with no call of its own
    // turn is the orphan the log refuses, so it is dropped.
    const target = session()
    const write = makeContentWriter(target.append)
    write([{ type: 'tool/call', payload: { ...call, callId: 'c1', turn: 1 } }])
    write([{ type: 'tool/result', payload: { ...result, message: { ...result.message, toolCallId: 'c1' }, turn: 2 } }])
    expect(target.calls.filter(c => c.type === 'tool/result')).toEqual([])
  })
})

/**
 * The in-place answer path's writer.
 *
 * It exists so the gateway can file a tool card without also filing the answer
 * message — the loop assembles that itself, and a second message per step is
 * erased by the view's fold. But the message the projection now carries also
 * holds the `tool-call` blocks the log requires to admit the `tool/call` that
 * follows. Dropping the whole message drops the announcement with it, which is
 * exactly the orphan that made these sessions unopenable. So the split is by
 * content, not by type: a message with nothing but the answer is still dropped,
 * a message carrying an announcement is kept.
 */
describe('makeToolOnlyWriter', () => {
  const announcement = {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
  }

  it('drops a text-only answer message, leaving the tool events', () => {
    const target = session()
    makeToolOnlyWriter(target.append)([
      { type: 'assistant/message', payload: message },
      { type: 'tool/call', payload: call },
    ])
    expect(target.calls.map(c => c.type)).toEqual(['tool/call'])
  })

  it('keeps a message that announces a tool call, so the log can admit the call', () => {
    const target = session()
    makeToolOnlyWriter(target.append)([
      { type: 'assistant/message', payload: announcement },
      { type: 'tool/call', payload: call },
    ])
    expect(target.calls.map(c => c.type)).toEqual(['assistant/message', 'tool/call'])
  })

  it('keeps the announcement and the tool events in one pass, in order', () => {
    const target = session()
    makeToolOnlyWriter(target.append)([
      { type: 'assistant/message', payload: announcement },
      { type: 'tool/call', payload: call },
      { type: 'tool/result', payload: result },
    ])
    expect(target.calls.map(c => c.type)).toEqual(['assistant/message', 'tool/call', 'tool/result'])
  })

  it('passes a system note through: gateway 路径的状态提示靠它落地', () => {
    const target = session()
    const note = { turn: 1, step: 1, message: { role: 'system', content: [] } }
    makeToolOnlyWriter(target.append)([{ type: 'system/message', payload: note }])
    expect(target.calls).toEqual([{ type: 'system/message', payload: note, intent: { surfaceOp: 'append' } }])
  })
})