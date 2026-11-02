/**
 * The save-time lifecycle guard.
 *
 * The host checks payloads and surfaces on append but not the cross-event tool
 * lifecycle, so a second result is accepted live and only rejected when the
 * file is loaded again. This guard is the missing check — but it repairs
 * instead of throwing: a bad event must not abort the turn the user is
 * watching. A result that can still be expressed legally is rewritten; one
 * that cannot is dropped and reported.
 */

import { describe, expect, it } from 'vitest'
import type { SurfaceIntent } from '../src/content-writer.ts'
import { withLifecycleGuard } from '../src/session-lifecycle.ts'
import type { LifecycleAdjustment } from '../src/session-lifecycle.ts'

function session() {
  const calls: { type: string; payload: unknown; intent?: SurfaceIntent }[] = []
  let seq = 0
  return {
    calls,
    append(type: string, payload: unknown, intent?: SurfaceIntent) {
      calls.push({ type, payload, ...(intent === undefined ? {} : { intent }) })
      seq += 1
      return { seq }
    },
  }
}

const call = { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }
const result = {
  turn: 1,
  step: 1,
  message: {
    id: 'r1',
    role: 'tool',
    toolCallId: 'c1',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  },
}

function withAdjustments() {
  const adjustments: LifecycleAdjustment[] = []
  return { adjustments, note: (adjustment: LifecycleAdjustment) => adjustments.push(adjustment) }
}

describe('withLifecycleGuard', () => {
  it('lets one call be answered once', () => {
    const target = session()
    const append = withLifecycleGuard(target.append)
    expect(append('tool/call', call)?.seq).toBe(1)
    expect(append('tool/result', result, { surfaceOp: 'append', sourceEventSeqs: [1] })?.seq).toBe(2)
    expect(target.calls.map(entry => entry.type)).toEqual(['tool/call', 'tool/result'])
  })

  it('turns a second append result into a content replacement instead of failing the turn', () => {
    // This is the write that made a real session unloadable:
    // `tool/result <id> has no advertised tool lifecycle`. The output is kept;
    // only its form changes to the one the log accepts.
    const target = session()
    const { adjustments, note } = withAdjustments()
    const append = withLifecycleGuard(target.append, note)
    append('tool/call', call)
    append('tool/result', result, { surfaceOp: 'append', sourceEventSeqs: [1] })
    const later = {
      ...result,
      step: 2,
      message: { ...result.message, id: 'later', content: [{ type: 'text', text: 'ok, more' }] },
    }
    expect(append('tool/result', later, { surfaceOp: 'append', sourceEventSeqs: [1] })?.seq).toBe(3)
    const third = target.calls[2]!
    // Chained onto the current node, not the original append.
    expect(third.intent).toEqual({
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
      sourceEventSeqs: [2],
    })
    // Identity comes from the node being shadowed; only the content moves.
    expect(third.payload).toMatchObject({
      turn: 1,
      step: 1,
      message: { id: 'r1', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok, more' }] },
    })
    expect(adjustments).toEqual([{ kind: 'refined', callId: 'c1' }])
  })

  it('chains refinements onto the newest result node', () => {
    const target = session()
    const append = withLifecycleGuard(target.append)
    append('tool/call', call)
    append('tool/result', result, { surfaceOp: 'append', sourceEventSeqs: [1] })
    append('tool/result', { ...result, message: { ...result.message, content: [{ type: 'text', text: 'a' }] } }, { surfaceOp: 'append' })
    append('tool/result', { ...result, message: { ...result.message, content: [{ type: 'text', text: 'ab' }] } }, { surfaceOp: 'append' })
    const latest = target.calls.at(-1)!
    expect(latest.intent?.surfaceOp).toEqual({ op: 'replace', startSeq: 3, endSeq: 3 })
    expect(latest.payload).toMatchObject({ message: { content: [{ type: 'text', text: 'ab' }] } })
  })

  it('lets an explicit replacement through and tracks it as the current node', () => {
    // Live output updates are written this way by the content writer; the
    // guard must not count them as another answer.
    const target = session()
    const { adjustments, note } = withAdjustments()
    const append = withLifecycleGuard(target.append, note)
    append('tool/call', call)
    append('tool/result', result, { surfaceOp: 'append', sourceEventSeqs: [1] })
    const replaced = { ...result, message: { ...result.message, content: [{ type: 'text', text: 'done' }] } }
    append('tool/result', replaced, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] })
    append('tool/result', { ...result, message: { ...result.message, content: [{ type: 'text', text: 'later' }] } }, { surfaceOp: 'append' })
    expect(target.calls).toHaveLength(4)
    expect(target.calls[3]!.intent?.surfaceOp).toEqual({ op: 'replace', startSeq: 3, endSeq: 3 })
    // Only the trailing append was rewritten; the explicit replacement was not.
    expect(adjustments).toEqual([{ kind: 'refined', callId: 'c1' }])
  })

  it('drops a result whose call was never written, and reports it', () => {
    const target = session()
    const { adjustments, note } = withAdjustments()
    const append = withLifecycleGuard(target.append, note)
    expect(append('tool/result', result, { surfaceOp: 'append', sourceEventSeqs: [1] })).toBeUndefined()
    expect(target.calls).toEqual([])
    expect(adjustments).toEqual([{ kind: 'dropped', type: 'tool/result', callId: 'c1', reason: 'result has no started call behind it' }])
  })

  it('drops a result with no toolCallId, and reports it', () => {
    const target = session()
    const { adjustments, note } = withAdjustments()
    const append = withLifecycleGuard(target.append, note)
    append('tool/call', call)
    expect(append('tool/result', { turn: 1, step: 1, message: { id: 'r1', role: 'tool', content: [] } }, { surfaceOp: 'append' })).toBeUndefined()
    expect(target.calls).toHaveLength(1)
    expect(adjustments[0]).toMatchObject({ kind: 'dropped', type: 'tool/result', reason: 'result has no message.toolCallId' })
  })

  it('drops a second start for a call still in flight', () => {
    // A second `tool/call` for an open id is rejected by the load-time
    // validator; the first call is the one the result will answer.
    const target = session()
    const append = withLifecycleGuard(target.append)
    append('tool/call', call)
    expect(append('tool/call', call)).toBeUndefined()
    append('tool/result', result, { surfaceOp: 'append', sourceEventSeqs: [1] })
    expect(target.calls.map(entry => entry.type)).toEqual(['tool/call', 'tool/result'])
  })

  it('does not remember a call whose append the host refused', () => {
    // Host failures are not ours to swallow; the ledger changes only after the
    // host accepted the write, so a call that never landed cannot make a later
    // result look answered.
    let fail = true
    const target = session()
    const append = withLifecycleGuard((type, payload, intent) => {
      if (fail && type === 'tool/call') throw new Error('host refused the call')
      return target.append(type, payload, intent)
    })
    expect(() => append('tool/call', call)).toThrow('host refused the call')
    fail = false
    expect(append('tool/result', result, { surfaceOp: 'append' })).toBeUndefined()
    expect(target.calls).toEqual([])
  })

  it('allows the same call id again once its result is written', () => {
    // The load-time table deletes the call when its result arrives, so a later
    // turn may reuse the id — as a new lifecycle, with a new result node.
    const target = session()
    const append = withLifecycleGuard(target.append)
    append('tool/call', call)
    append('tool/result', result, { surfaceOp: 'append', sourceEventSeqs: [1] })
    append('tool/call', call)
    expect(append('tool/result', result, { surfaceOp: 'append', sourceEventSeqs: [3] })?.seq).toBe(4)
    expect(target.calls[3]!.intent?.surfaceOp).toBe('append')
  })

  it('passes non-tool events through untouched', () => {
    const target = session()
    const append = withLifecycleGuard(target.append)
    append('assistant/message', { turn: 1, step: 1, message: { content: [] } }, { surfaceOp: 'append' })
    append('turn/end', { turn: 1 })
    expect(target.calls.map(entry => entry.type)).toEqual(['assistant/message', 'turn/end'])
  })
})
