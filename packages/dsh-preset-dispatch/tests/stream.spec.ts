/**
 * Streaming an external agent's turn so it looks live.
 *
 * Three things are load-bearing here, and all three are easy to get wrong:
 *
 *   - `revision` is monotone across the **whole agent lifecycle**, not per turn.
 *     A per-turn counter restarts at 1 and the UI treats the new turn as a
 *     replacement stream, redrawing from scratch.
 *   - The durable event is appended **before** the end frame is emitted. The
 *     reverse order shows a finished stream whose content cannot be found.
 *   - `assistant/message` requires the compacted stream inline — it is not an
 *     optional field — so the packed runs have to be built, not faked.
 */

import { describe, expect, it } from 'vitest'
import { AcpAssistantStream } from '../src/stream.ts'

type AnyFrame = Record<string, unknown>

function collector() {
  const frames: AnyFrame[] = []
  let revision = 0
  const nextRevision = () => ++revision
  return { frames, nextRevision }
}

describe('AcpAssistantStream', () => {
  it('opens with a start frame naming the attempt', () => {
    const { frames, nextRevision } = collector()
    const stream = new AcpAssistantStream({ emit: f => frames.push(f), nextRevision, sessionId: 'sess-7', attempt: 2, turn: 1, step: 1 })

    stream.start()
    expect(frames[0]).toMatchObject({ type: 'start', attemptId: 'sess-7:2', turn: 1, step: 1 })
  })

  it('numbers chunk frames densely from zero within the attempt', () => {
    const { frames, nextRevision } = collector()
    const stream = new AcpAssistantStream({ emit: f => frames.push(f), nextRevision, sessionId: 's', attempt: 1, turn: 1, step: 1 })
    stream.start()
    stream.textDelta('a')
    stream.textDelta('b')

    const chunks = frames.filter(f => f['type'] === 'chunk')
    expect(chunks.map(c => c['index'])).toEqual([0, 1])
  })

  it('keeps the revision counter moving across turns', () => {
    const { frames, nextRevision } = collector()
    const first = new AcpAssistantStream({ emit: f => frames.push(f), nextRevision, sessionId: 's', attempt: 1, turn: 1, step: 1 })
    first.start()
    const second = new AcpAssistantStream({ emit: f => frames.push(f), nextRevision, sessionId: 's', attempt: 2, turn: 2, step: 1 })
    second.start()

    const revisions = frames.filter(f => f['type'] === 'start').map(f => f['revision'])
    expect(revisions).toEqual([1, 2])
  })

  it('packs consecutive same-index text deltas into one compact record', () => {
    const { nextRevision } = collector()
    let tick = 1_000
    const stream = new AcpAssistantStream({
      emit: () => {}, nextRevision, sessionId: 's', attempt: 1, turn: 1, step: 1, now: () => tick += 5,
    })
    stream.textDelta('Hello, ')
    stream.textDelta('world')

    // One record, two texts, and the gap between them preserved rather than
    // dropped — the timing is part of what the log replays.
    expect(stream.records()).toEqual([
      { type: 'text-chunks', time0: 1_005, index: 0, dt: [5], texts: ['Hello, ', 'world'] },
    ])
  })

  it('starts a new record when time goes backwards rather than writing a negative gap', () => {
    const { nextRevision } = collector()
    const times = [1_000, 900]
    const stream = new AcpAssistantStream({
      emit: () => {}, nextRevision, sessionId: 's', attempt: 1, turn: 1, step: 1, now: () => times.shift() ?? 900,
    })
    stream.textDelta('first')
    stream.textDelta('second')

    expect(stream.records().map(r => (r as { texts: readonly string[] }).texts)).toEqual([['first'], ['second']])
  })

  it('starts a new record when the block index changes', () => {
    const { nextRevision } = collector()
    const stream = new AcpAssistantStream({ emit: () => {}, nextRevision, sessionId: 's', attempt: 1, turn: 1, step: 1 })
    stream.textDelta('first block', 0)
    stream.textDelta('second block', 1)

    expect(stream.records().map(r => (r as { index: number }).index)).toEqual([0, 1])
  })

  it('keeps reasoning and text apart', () => {
    const { nextRevision } = collector()
    const stream = new AcpAssistantStream({ emit: () => {}, nextRevision, sessionId: 's', attempt: 1, turn: 1, step: 1 })
    stream.reasoningDelta('thinking')
    stream.textDelta('answering')

    expect(stream.records().map(r => r['type'])).toEqual(['reasoning-chunks', 'text-chunks'])
  })

  it('appends the durable event before announcing that the stream ended', () => {
    const order: string[] = []
    const { nextRevision } = collector()
    const stream = new AcpAssistantStream({
      emit: f => { order.push(`frame:${f['type']}`) },
      nextRevision,
      sessionId: 's',
      attempt: 1,
      turn: 1,
      step: 1,
    })
    stream.start()

    stream.settle('assistant/message', () => { order.push('append'); return 42 })
    expect(order.slice(-2)).toEqual(['append', 'frame:end'])
  })

  it('reports the committed sequence on the end frame', () => {
    const frames: AnyFrame[] = []
    const { nextRevision } = collector()
    const stream = new AcpAssistantStream({ emit: f => frames.push(f), nextRevision, sessionId: 's', attempt: 1, turn: 1, step: 1 })
    stream.start()
    stream.textDelta('hi')
    stream.settle('assistant/message', () => 42)

    const end = frames.find(f => f['type'] === 'end')!
    expect(end['outcome']).toEqual({ kind: 'committed', eventType: 'assistant/message', seq: 42 })
  })

  it('announces abandonment and rethrows when the durable append fails', () => {
    const frames: AnyFrame[] = []
    const { nextRevision } = collector()
    const stream = new AcpAssistantStream({ emit: f => frames.push(f), nextRevision, sessionId: 's', attempt: 1, turn: 1, step: 1 })
    stream.start()

    expect(() => stream.settle('assistant/message', () => { throw new Error('log write failed') })).toThrow(/log write failed/)
    expect(frames.find(f => f['type'] === 'end')!['outcome']).toEqual({ kind: 'abandoned' })
  })

  it('refuses a delta after the stream has already ended', () => {
    const { nextRevision } = collector()
    const stream = new AcpAssistantStream({ emit: () => {}, nextRevision, sessionId: 's', attempt: 1, turn: 1, step: 1 })
    stream.start()
    stream.settle('assistant/message', () => 1)
    expect(() => stream.textDelta('too late')).toThrow(/ended/i)
  })
})