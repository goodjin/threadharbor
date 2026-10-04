import { describe, expect, it, vi } from 'vitest'

import {
  acceptFrame,
  createRelay,
  filterCommitted,
  followAssistantStream,
  installBridge,
  armBridge,
  liveMessageId,
  notifyThroughBridge,
} from '../deploy/acp-stream/live-stream.mjs'

const SESSION = 'session-a'
const ATTEMPT = 'session-a:1'

const start = (attemptId = ATTEMPT) => ({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })
const chunk = (payload, index = 0) => ({ type: 'chunk', attemptId: ATTEMPT, revision: 2, index, time: 1, chunk: payload })
const reasoning = (text, index = 0) => chunk({ type: 'reasoning-delta', index, text }, index)
const text = (value, index = 1) => chunk({ type: 'text-delta', index, text: value }, index)
const blockStart = (blockType, index = 0) => chunk({ type: 'block-start', index, blockType }, index)
const end = (kind = 'committed') => ({
  type: 'end', attemptId: ATTEMPT, revision: 9, index: 5, outcome: { kind },
})

/** A relay plus a recorder, driven exactly as the ctx subscription drives it. */
function harness() {
  const relay = createRelay()
  const sent = []
  const send = (notification) => { sent.push(notification); return Promise.resolve() }
  const feed = (frame) => acceptFrame(relay, SESSION, frame, send)
  return { relay, sent, feed }
}

function committed(sessionUpdate, body, messageId = 'm1') {
  return { sessionId: SESSION, update: { sessionUpdate, messageId, content: { type: 'text', text: body } } }
}

describe('live stream forwarding', () => {
  it('sends a reasoning delta the moment it arrives', () => {
    const { sent, feed } = harness()
    feed(start())
    expect(feed(reasoning('thinking'))).toBe(1)
    expect(sent).toEqual([{
      sessionId: SESSION,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: liveMessageId(ATTEMPT),
        content: { type: 'text', text: 'thinking' },
      },
    }])
  })

  it('routes text deltas to the message update and keeps them in order', () => {
    const { sent, feed } = harness()
    feed(start())
    feed(blockStart('text'))
    feed(text('a'))
    feed(text('b'))
    expect(sent.map((n) => n.update.content.text)).toEqual(['a', 'b'])
    expect(new Set(sent.map((n) => n.update.sessionUpdate))).toEqual(new Set(['agent_message_chunk']))
  })

  it('keeps interleaved reasoning and answer text apart', () => {
    const { sent, feed } = harness()
    feed(start())
    feed(reasoning('think'))
    feed(text('answer'))
    expect(sent.map((n) => n.update.sessionUpdate)).toEqual(['agent_thought_chunk', 'agent_message_chunk'])
  })

  it('ignores frames it cannot present as text', () => {
    const { sent, feed } = harness()
    feed(start())
    expect(feed(chunk({ type: 'tool-call-delta', index: 0, id: 't1', name: 'read', args: '{}' }))).toBe(0)
    expect(feed(chunk({ type: 'block-end', index: 0 }))).toBe(0)
    expect(feed(chunk({ type: 'usage', usage: { total: 5 } }))).toBe(0)
    expect(feed(reasoning(''))).toBe(0)
    expect(feed({ type: 'nonsense' })).toBe(0)
    expect(feed(null)).toBe(0)
    expect(sent).toEqual([])
  })

  it('accepts a delta that arrives without its block marker', () => {
    const { sent, feed } = harness()
    feed(start())
    expect(feed(reasoning('orphan'))).toBe(1)
    expect(sent[0].update.sessionUpdate).toBe('agent_thought_chunk')
  })

  it('drops deltas that arrive before any attempt started', () => {
    const { sent, feed } = harness()
    expect(feed(reasoning('early'))).toBe(0)
    expect(sent).toEqual([])
  })

  it('uses a new message id for a retried attempt so the client starts fresh', () => {
    const { relay, sent, feed } = harness()
    feed(start())
    feed(reasoning('first try'))
    feed(end('abandoned'))
    feed(start('session-a:2'))
    feed(reasoning('second try'))
    const ids = new Set(sent.map((n) => n.update.messageId))
    expect(ids.size).toBe(2)
    expect(relay.sessions.size).toBe(1)
  })

  it('counts frames and notifications for the verify tool', () => {
    const { relay, feed } = harness()
    feed(start())
    feed(reasoning('a'))
    feed(text('b'))
    expect(relay.framesSeen).toBe(3)
    expect(relay.notificationsSent).toBe(2)
  })

  it('bounds how many sessions one relay tracks', () => {
    const relay = createRelay()
    const send = () => {}
    for (let index = 0; index < 80; index += 1) {
      acceptFrame(relay, `s${index}`, start(`s${index}:1`), send)
    }
    expect(relay.sessions.size).toBeLessThanOrEqual(64)
  })
})

describe('de-duplicating the committed copy', () => {
  it('drops a committed block the live stream already delivered', () => {
    const { relay, sent, feed } = harness()
    feed(start())
    feed(blockStart('reasoning'))
    feed(reasoning('whole block'))
    feed(end())
    expect(filterCommitted(relay, SESSION, committed('agent_thought_chunk', 'whole block'))).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('keeps only the tail when the commit carries more than the stream did', () => {
    const { relay, feed } = harness()
    feed(start())
    feed(reasoning('first '))
    const tail = filterCommitted(relay, SESSION, committed('agent_thought_chunk', 'first second'))
    expect(tail.update.content.text).toBe('second')
  })

  it('passes through a block the live stream never saw', () => {
    const { relay, feed } = harness()
    feed(start())
    feed(reasoning('unrelated'))
    const other = committed('agent_thought_chunk', 'a different block')
    expect(filterCommitted(relay, SESSION, other)).toBe(other)
  })

  it('passes through kinds the relay does not stream', () => {
    const { relay, feed } = harness()
    feed(start())
    feed(reasoning('x'))
    const tool = { sessionId: SESSION, update: { sessionUpdate: 'tool_call', content: {} } }
    expect(filterCommitted(relay, SESSION, tool)).toBe(tool)
  })

  it('matches the right block when one attempt holds several', () => {
    const { relay, feed } = harness()
    feed(start())
    feed(reasoning('think ', 0))
    feed(text('answer', 1))
    expect(filterCommitted(relay, SESSION, committed('agent_thought_chunk', 'think '))).toBeNull()
    const answer = filterCommitted(relay, SESSION, committed('agent_message_chunk', 'answer'))
    expect(answer).toBeNull()
    expect(relay.sessions.size).toBe(0)
  })

  it('forgets an abandoned attempt so a later commit is not swallowed', () => {
    const { relay, feed } = harness()
    feed(start())
    feed(reasoning('partial'))
    feed(end('abandoned'))
    const later = committed('agent_thought_chunk', 'partial')
    expect(filterCommitted(relay, SESSION, later)).toBe(later)
  })

  it('leaves other sessions alone', () => {
    const { relay, feed } = harness()
    feed(start())
    feed(reasoning('mine'))
    const theirs = { sessionId: 'session-b', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'mine' } } }
    expect(filterCommitted(relay, 'session-b', theirs)).toBe(theirs)
  })
})

describe('bridge wiring', () => {
  it('subscribes globally and forwards the session of each frame', () => {
    const relay = createRelay()
    const sent = []
    let handler
    const on = vi.fn((_event, fn, options) => { handler = fn; return () => {} })
    followAssistantStream({ on }, relay, (n) => { sent.push(n) })
    expect(on).toHaveBeenCalledWith('agent/assistant-stream', expect.any(Function), { global: true })

    handler({ agent: { session: { id: 'session-z' } }, frame: start('session-z:1') })
    handler({ agent: { session: { id: 'session-z' } }, frame: reasoning('live') })
    expect(sent[0].sessionId).toBe('session-z')
    expect(sent[0].update.content.text).toBe('live')
  })

  it('survives a malformed frame without disturbing the loop', () => {
    const relay = createRelay()
    const send = vi.fn()
    let handler
    followAssistantStream({ on: (_e, fn) => { handler = fn } }, relay, send)
    expect(() => handler({ agent: { session: { id: SESSION } }, frame: { type: 'chunk' } })).not.toThrow()
    expect(send).not.toHaveBeenCalled()
    expect(() => handler({ frame: start() })).not.toThrow()
  })

  it('hands the connection to the armed callback exactly once', () => {
    const relay = createRelay()
    const onBridge = vi.fn()
    armBridge({ onBridge, relay })
    installBridge({}, { client: { session: { update: 'session/update' } } })
    expect(onBridge).toHaveBeenCalledTimes(1)
    armBridge(null)
  })
})

describe('the patched notify call', () => {
  it('drops a committed block and forwards nothing', async () => {
    const relay = createRelay()
    const send = vi.fn(async () => {})
    armBridge({ onBridge: () => {}, relay })
    acceptFrame(relay, SESSION, start(), () => {})
    acceptFrame(relay, SESSION, reasoning('done'), () => {})
    await notifyThroughBridge(committed('agent_thought_chunk', 'done'), send)
    expect(send).not.toHaveBeenCalled()
  })

  it('still paces a block the live stream never carried', async () => {
    const relay = createRelay()
    const send = vi.fn(async () => {})
    armBridge({ onBridge: () => {}, relay })
    acceptFrame(relay, SESSION, start(), () => {})
    const big = committed('agent_message_chunk', 'y'.repeat(2000))
    const sent = await notifyThroughBridge(big, send, { sliceChars: 800, minIntervalMs: 0, maxIntervalMs: 0, maxTotalMs: 0, sliceKinds: new Set(['agent_message_chunk']) })
    expect(sent).toBe(3)
    expect(send).toHaveBeenCalledTimes(3)
  })
})
