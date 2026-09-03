import { describe, expect, it } from 'vitest'
import { parseHostdWsEvent, parseHostdWsFrame, parseRemoteControlRequest, remoteAgentBackend, remoteAgentConfigBackend } from '../src/index.ts'

describe('remote-agent control protocol', () => {
  it('parses JSON request envelopes and branded backend values', () => {
    expect(parseRemoteControlRequest({ id: 'r1', method: 'state', params: {} })).toEqual({
      id: 'r1', method: 'state', params: {},
    })
    expect(remoteAgentBackend('codex')).toBe('codex')
    expect(remoteAgentBackend('claude')).toBe('claude')
    expect(remoteAgentConfigBackend('grok')).toBe('grok')
  })

  it('rejects non-JSON params and unknown backend values at wire boundaries', () => {
    expect(() => parseRemoteControlRequest({ id: 'r1', method: 'state', params: { bad: Number.NaN } }))
      .toThrow('control request must be a JSON object')
    expect(() => remoteAgentBackend('other')).toThrow('backend must be one of grok, codex, claude, dsh')
    expect(() => remoteAgentConfigBackend('dsh')).toThrow('config backend must be one of grok, codex, claude')
  })
})

describe('hostd WebSocket frames', () => {
  it('parses every direction with its discriminator fields', () => {
    expect(parseHostdWsFrame({ direction: 'request', id: 'a', method: 'inventory', params: {} })).toEqual({
      direction: 'request', id: 'a', method: 'inventory', params: {},
    })
    expect(parseHostdWsFrame({ direction: 'response', id: 'a', ok: true, result: { protocolVersion: 1 } })).toEqual({
      direction: 'response', id: 'a', ok: true, result: { protocolVersion: 1 },
    })
    expect(parseHostdWsFrame({ direction: 'response', id: 'b', ok: false, error: { code: 'X', message: 'm' } })).toEqual({
      direction: 'response', id: 'b', ok: false, error: { code: 'X', message: 'm' },
    })
    expect(parseHostdWsFrame({ direction: 'subscribe', sessionId: 's1', generation: 'g', lastSeq: 5 })).toEqual({
      direction: 'subscribe', sessionId: 's1', generation: 'g', lastSeq: 5,
    })
    expect(parseHostdWsFrame({ direction: 'unsubscribe', sessionId: 's1' })).toEqual({
      direction: 'unsubscribe', sessionId: 's1',
    })
    expect(parseHostdWsFrame({ direction: 'ping' })).toEqual({ direction: 'ping' })
    expect(parseHostdWsFrame({ direction: 'pong' })).toEqual({ direction: 'pong' })
  })

  it('parses a journal.page push event with its embedded journal page', () => {
    const parsed = parseHostdWsFrame({
      direction: 'push',
      seq: 7,
      event: {
        type: 'journal.page',
        sessionId: 's1',
        page: {
          generation: 'gen1',
          latestSeq: 9,
          droppedThrough: 0,
          gap: false,
          events: [
            { seq: 7, generation: 'gen1', timestamp: '2026-01-01T00:00:00Z', frame: { jsonrpc: '2.0', method: 'session/update', params: {} } },
            { seq: 8, generation: 'gen1', timestamp: '2026-01-01T00:00:01Z', frame: { jsonrpc: '2.0', id: 'r1', result: {} } },
          ],
        },
        subscribers: 2,
      },
    })
    if (parsed.direction !== 'push' || parsed.event.type !== 'journal.page') throw new Error('expected journal.page')
    expect(parsed.seq).toBe(7)
    expect(parsed.event.sessionId).toBe('s1')
    expect(parsed.event.page.latestSeq).toBe(9)
    expect(parsed.event.page.events).toHaveLength(2)
    expect(parsed.event.subscribers).toBe(2)
  })

  it('rejects unknown directions, negative seq, and malformed events', () => {
    expect(() => parseHostdWsFrame({ direction: 'bogus' })).toThrow('unknown hostd ws frame direction')
    expect(() => parseHostdWsFrame({ direction: 'push', seq: -1, event: {} })).toThrow('seq must be')
    expect(() => parseHostdWsEvent({ type: 'journal.page', page: { generation: 'g', latestSeq: 0, droppedThrough: 0, gap: false, events: [] }, subscribers: -1 })).toThrow('subscribers must be')
    expect(() => parseHostdWsEvent({ type: 'journal.page', sessionId: 's1', page: { generation: 'g', latestSeq: 0, droppedThrough: 0, gap: false, events: 'no' }, subscribers: 0 })).toThrow('events must be an array')
    expect(() => parseHostdWsEvent({ type: 'journal.page', page: { generation: 'g', latestSeq: 0, droppedThrough: 0, gap: false, events: [] }, subscribers: 0 })).toThrow('sessionId must be')
  })
})
