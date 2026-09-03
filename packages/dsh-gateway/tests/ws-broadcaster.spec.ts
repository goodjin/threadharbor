/** Single-WS broadcaster and per-session follow semantics. */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { WsBroadcaster } from '../src/ws-broadcaster.ts'
import {
  REMOTE_AGENT_GATEWAY_WS_PATH,
  type JsonValue,
  type RemoteGatewayWsEvent,
  type RemoteGatewayWsFrame,
  RemoteSessionId,
} from '@threadharbor/protocol'

interface MockSocket {
  readyState: OPEN
  sent: string[]
  on(event: 'close' | 'error' | 'message', listener: (...args: unknown[]) => void): void
  send(payload: string): void
  close(): void
  emit(event: 'error'): void
  emit(event: 'message', data: string): void
}

const OPEN = 1 as const

function makeSocket(): MockSocket {
  const socket = {
    readyState: OPEN,
    sent: [],
    send(payload: string) {
      this.sent.push(payload)
    },
    close() {
      this.readyState = 3 as never
      for (const listener of this['_listeners'].close ?? []) listener()
    },
    on(event: 'close' | 'error' | 'message', listener: (...args: unknown[]) => void) {
      (this['_listeners'][event] ??= []).push(listener)
    },
    emit(event: 'error' | 'message', data?: string) {
      for (const listener of this['_listeners'][event] ?? []) listener(data)
    },
    _listeners: {
      close: [] as (() => void)[],
      error: [] as (() => void)[],
      message: [] as ((data: string) => void)[],
    },
  }
  return socket as MockSocket
}

describe('WsBroadcaster', () => {
  let broadcaster: WsBroadcaster
  let vi_useFakeTimers: typeof vi
  beforeEach(() => {
    vi.useFakeTimers()
    broadcaster = new WsBroadcaster()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function parseSent(socket: MockSocket): RemoteGatewayWsFrame[] {
    return socket.sent.map(payload => JSON.parse(payload) as RemoteGatewayWsFrame)
  }

  function register(ws: MockSocket, browserId: string, supportsTranscriptBatch = false): void {
    Object.defineProperty(ws, 'readyState', { configurable: true, value: OPEN })
    broadcaster.registerForTesting(ws as unknown as WebSocket, browserId, supportsTranscriptBatch)
  }

  it('logs when a transcript batch has no live follower', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    try {
      const alice = makeSocket()
      register(alice, 'alice')
      broadcaster.broadcastTranscriptBatch(RemoteSessionId('session-a'), [1, 2].map((seq) => ({
        transcriptId: `t${seq}`, sessionId: RemoteSessionId('session-a'), seq,
        role: 'assistant', kind: 'message', text: String(seq), createdAt: 'now',
      })))
      expect(parseSent(alice)).toEqual([])
      expect(writes.some(line => line.includes('reason=no-follower') && line.includes('session=session-a'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('logs when every follower socket is already closed', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    try {
      const alice = makeSocket()
      register(alice, 'alice')
      broadcaster.follow('alice', RemoteSessionId('session-a'))
      Object.defineProperty(alice, 'readyState', { configurable: true, value: 3 })
      broadcaster.broadcastTranscriptBatch(RemoteSessionId('session-a'), [{
        transcriptId: 't1', sessionId: RemoteSessionId('session-a'), seq: 4,
        role: 'assistant', kind: 'message', text: 'x', createdAt: 'now',
      }])
      expect(parseSent(alice)).toEqual([])
      expect(writes.some(line => line.includes('reason=socket-closed') && line.includes('fromSeq=4'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('delivers transcript frames only to subscribers that follow the session', () => {
    const alice = makeSocket()
    const bob = makeSocket()
    register(alice, 'alice')
    register(bob, 'bob')
    broadcaster.follow('alice', RemoteSessionId('session-a'))
    const event: RemoteGatewayWsEvent = {
      type: 'transcript.append', sessionId: RemoteSessionId('session-a'),
      entry: { transcriptId: 't1', sessionId: 'session-a', seq: 1, role: 'assistant', kind: 'message', text: 'hi', createdAt: 'now' } as unknown as JsonValue,
      seq: 1,
    } as unknown as RemoteGatewayWsEvent
    broadcaster.broadcastFollowed(RemoteSessionId('session-a'), event)
    expect(parseSent(alice).length).toBe(1)
    expect(parseSent(bob).length).toBe(0)
  })

  it('sends multiple transcript entries as one batch frame', () => {
    const alice = makeSocket()
    register(alice, 'alice', true)
    broadcaster.follow('alice', RemoteSessionId('session-a'))
    broadcaster.broadcastTranscriptBatch(RemoteSessionId('session-a'), [1, 2, 3, 4, 5].map((i) => ({
      transcriptId: `t${i}`,
      sessionId: RemoteSessionId('session-a'),
      seq: i,
      role: 'assistant',
      kind: 'message',
      text: String(i),
      createdAt: 'now',
    })))
    const frames = parseSent(alice)
    expect(frames.length).toBe(1)
    expect(frames[0]?.event).toMatchObject({ type: 'transcript.batch', fromSeq: 1, toSeq: 5 })
  })

  it('keeps transcript batches compatible with an already-open legacy client', () => {
    const legacy = makeSocket()
    register(legacy, 'legacy')
    broadcaster.follow('legacy', RemoteSessionId('session-a'))
    broadcaster.broadcastTranscriptBatch(RemoteSessionId('session-a'), [1, 2, 3].map((seq) => ({
      transcriptId: `t${seq}`, sessionId: RemoteSessionId('session-a'), seq,
      role: 'assistant', kind: 'message', text: String(seq), createdAt: 'now',
    })))
    expect(parseSent(legacy).map(frame => frame.event.type)).toEqual([
      'transcript.append', 'transcript.append', 'transcript.append',
    ])
  })

  it('rebinds a legacy anonymous socket from the browserId in session.follow', async () => {
    const legacy = makeSocket()
    register(legacy, 'anonymous')
    broadcaster.setRequestHandler(async (request) => {
      broadcaster.follow(String(request.params['browserId']), RemoteSessionId(String(request.params['sessionId'])))
      return { ok: true }
    })
    legacy.emit('message', JSON.stringify({
      direction: 'request', id: 'follow-legacy', method: 'session.follow',
      params: { browserId: 'actual-browser', sessionId: 'session-a' },
    }))
    await Promise.resolve()
    legacy.sent.length = 0
    broadcaster.broadcastTranscriptBatch(RemoteSessionId('session-a'), [1, 2].map((seq) => ({
      transcriptId: `t${seq}`, sessionId: RemoteSessionId('session-a'), seq,
      role: 'assistant', kind: 'message', text: String(seq), createdAt: 'now',
    })))
    expect(parseSent(legacy).map(frame => frame.event.type)).toEqual(['transcript.append', 'transcript.append'])
  })

  it('follow / unfollow updates which sockets receive frames', () => {
    const alice = makeSocket()
    register(alice, 'alice')
    broadcaster.follow('alice', RemoteSessionId('session-a'))
    broadcaster.unfollow('alice', RemoteSessionId('session-a'))
    broadcaster.broadcastFollowed(RemoteSessionId('session-a'), {
      type: 'transcript.append', sessionId: RemoteSessionId('session-a'),
      entry: { seq: 1 } as unknown as never, seq: 1,
    } as unknown as RemoteGatewayWsEvent)
    expect(parseSent(alice).length).toBe(0)
  })

  it('answers follow requests so the gateway can start event sync', async () => {
    const alice = makeSocket()
    register(alice, 'alice')
    broadcaster.setRequestHandler(async (request) => {
      expect(request.method).toBe('session.follow')
      return { sessionId: 'session-a', fromSeq: 4 }
    })
    alice.emit('message', JSON.stringify({
      direction: 'request', id: 'req-1', method: 'session.follow',
      params: { browserId: 'alice', sessionId: 'session-a' },
    }))
    await Promise.resolve()
    expect(JSON.parse(alice.sent[0]!)).toMatchObject({
      direction: 'response', id: 'req-1', ok: true, result: { sessionId: 'session-a', fromSeq: 4 },
    })
  })

  it('summary events go to every subscriber without debounce', () => {
    const alice = makeSocket()
    const bob = makeSocket()
    register(alice, 'alice')
    register(bob, 'bob')
    broadcaster.broadcast({
      type: 'host.changed',
      host: { hostId: 'h1', title: 'a', endpoint: 'http://127.0.0.1:1', createdAt: 'now', updatedAt: 'now' } as unknown as never,
    } as unknown as RemoteGatewayWsEvent)
    expect(parseSent(alice).length).toBe(1)
    expect(parseSent(bob).length).toBe(1)
  })

  it('size reports the number of active subscribers', () => {
    expect(broadcaster.size()).toBe(0)
    const alice = makeSocket()
    register(alice, 'alice')
    expect(broadcaster.size()).toBe(1)
  })

  it('isolates a disconnected browser socket error and stops its follow loop', () => {
    const alice = makeSocket()
    register(alice, 'alice')
    broadcaster.follow('alice', RemoteSessionId('session-a'))
    expect(broadcaster.hasFollowers(RemoteSessionId('session-a'))).toBe(true)

    alice.emit('error')

    expect(broadcaster.size()).toBe(0)
    expect(broadcaster.hasFollowers(RemoteSessionId('session-a'))).toBe(false)
    expect(() => {
      broadcaster.broadcast({ type: 'session.unfollowed', sessionId: RemoteSessionId('session-a') })
    }).not.toThrow()
  })

  it('completes an HTTP upgrade for /remote-agent/ws and registers the browser', async () => {
    vi.useRealTimers()
    const server = createServer()
    server.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      if (path !== REMOTE_AGENT_GATEWAY_WS_PATH) {
        socket.destroy()
        return
      }
      broadcaster.handleUpgrade(req, socket, head)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
    const port = (server.address() as AddressInfo).port
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${REMOTE_AGENT_GATEWAY_WS_PATH}?browserId=alice`)
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })
      expect(broadcaster.size()).toBe(1)
      const received: string[] = []
      socket.on('message', (data) => { received.push(String(data)) })
      broadcaster.follow('alice', RemoteSessionId('session-a'))
      broadcaster.broadcastFollowed(RemoteSessionId('session-a'), {
        type: 'transcript.append', sessionId: RemoteSessionId('session-a'),
        entry: { seq: 1 } as unknown as never, seq: 1,
      } as unknown as RemoteGatewayWsEvent)
      await vi.waitFor(() => { expect(received.length).toBe(1) }, { timeout: 500, interval: 10 })
      const closed = new Promise<void>((resolve) => { socket.once('close', () => resolve()) })
      socket.close()
      await closed
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
  })
})
