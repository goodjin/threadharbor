/** Unit tests for the gateway-side hostd WebSocket client. */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type JsonValue,
  type RemoteHostdMethod,
  type RemoteHostdWsEvent,
  RemoteSessionId,
  parseHostdWsFrame,
  type RemoteHostdWsFrame,
} from '@threadharbor/protocol'
import { HostdConnection } from '../src/hostd-connection.ts'

interface MockSocket extends EventEmitter {
  readyState: number
  send(payload: string): void
  close(code?: number, reason?: string): void
}

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

interface ScriptedResponse {
  matchRequest: (frame: Record<string, unknown>) => boolean
  reply: (frame: Record<string, unknown>) => string | undefined
}

interface SocketFactory {
  factory: (url: string) => MockSocket
  sockets: MockSocket[]
  /** Register a scripted response for the next request that matches. */
  scriptResponse(script: ScriptedResponse): void
  /** Trigger 'open' on the most recently created socket. */
  openLatest(): void
  /** Close the most recently created socket. */
  closeLatest(): void
  /** Push a frame into the most recently created socket (server → client). */
  pushToLatest(frame: RemoteHostdWsEvent | { direction: 'pong' } | { direction: 'push'; seq: number; event: RemoteHostdWsEvent }): void
}

function makeSocketFactory(): SocketFactory {
  const sockets: MockSocket[] = []
  const scripts: ScriptedResponse[] = []
  const factory = (url: string): MockSocket => {
    void url
    const sent: string[] = []
    const socket = new EventEmitter() as MockSocket
    socket.readyState = CONNECTING
    socket.send = (payload: string): void => {
      sent.push(payload)
      let frame: { direction: string } & Record<string, unknown>
      try { frame = JSON.parse(payload) as { direction: string } & Record<string, unknown> } catch { return }
      if (frame.direction === 'request') {
        const index = scripts.findIndex(script => script.matchRequest(frame))
        if (index === -1) return
        const script = scripts.splice(index, 1)[0]!
        const reply = script.reply(frame)
        if (reply !== undefined) {
          setImmediate(() => socket.emit('message', reply))
        }
        return
      }
      if (frame.direction === 'ping') {
        setImmediate(() => socket.emit('message', JSON.stringify({ direction: 'pong' })))
      }
    }
    socket.close = (code?: number, reason?: string): void => {
      void code
      void reason
      socket.readyState = CLOSED
      socket.emit('close')
    }
    ;(socket as unknown as { _sent: string[] })._sent = sent
    sockets.push(socket)
    return socket
  }
  return {
    factory,
    sockets,
    scriptResponse(script) { scripts.push(script) },
    openLatest() {
      const last = sockets.at(-1)
      if (last === undefined) throw new Error('no sockets')
      last.readyState = OPEN
      last.emit('open')
    },
    closeLatest() {
      const last = sockets.at(-1)
      if (last === undefined) throw new Error('no sockets')
      last.readyState = CLOSING
      last.emit('close')
    },
    pushToLatest(frame) {
      const last = sockets.at(-1)
      if (last === undefined) throw new Error('no sockets')
      last.emit('message', JSON.stringify(frame))
    },
  }
}

describe('HostdConnection', () => {
  afterEach(() => { vi.useRealTimers() })

  it('opens on demand when the first request is issued', async () => {
    const scripts = makeSocketFactory()
    const conn = new HostdConnection({
      endpoint: 'http://127.0.0.1:1',
      requestTimeoutMs: 1000,
      heartbeatMs: 60_000,
      reconnectStepsMs: [10, 10, 10],
      handshakeTimeoutMs: 100,
      socketFactory: scripts.factory as unknown as (url: string) => import('ws').WebSocket,
    })
    conn.open()
    scripts.openLatest()
    expect(scripts.sockets).toHaveLength(1)
    scripts.scriptResponse({
      matchRequest: frame => frame['method'] === 'inventory',
      reply: (frame) => JSON.stringify({ direction: 'response', id: frame['id'] as string, ok: true, result: { ok: true } }),
    })
    const result = await conn.request('inventory', {})
    expect(result).toEqual({ ok: true })
    void conn
    await conn.close()
  })

  it('multiplexes concurrent requests by id without interleaving', async () => {
    const scripts = makeSocketFactory()
    const conn = new HostdConnection({
      endpoint: 'http://127.0.0.1:1',
      requestTimeoutMs: 1000,
      heartbeatMs: 60_000,
      reconnectStepsMs: [10, 10, 10],
      handshakeTimeoutMs: 100,
      socketFactory: scripts.factory as unknown as (url: string) => import('ws').WebSocket,
    })
    conn.open()
    scripts.openLatest()
    for (let i = 0; i < 50; i++) {
      scripts.scriptResponse({
        matchRequest: frame => frame['method'] === 'inventory',
        reply: (frame) => JSON.stringify({
          direction: 'response', id: frame['id'] as string, ok: true, result: { id: frame['id'] },
        }),
      })
    }
    const promises: Promise<JsonValue>[] = []
    for (let i = 0; i < 50; i++) promises.push(conn.request('inventory', {}))
    const results = await Promise.all(promises)
    const ids = new Set(results.map(r => (r as { id: string }).id))
    expect(ids.size).toBe(50)
    void conn
    await conn.close()
  })

  it('times out requests that never receive a response', async () => {
    const scripts = makeSocketFactory()
    const conn = new HostdConnection({
      endpoint: 'http://127.0.0.1:1',
      requestTimeoutMs: 50,
      heartbeatMs: 60_000,
      reconnectStepsMs: [10, 10, 10],
      handshakeTimeoutMs: 100,
      socketFactory: scripts.factory as unknown as (url: string) => import('ws').WebSocket,
    })
    conn.open()
    scripts.openLatest()
    await expect(conn.request('inventory', {})).rejects.toThrow(/timed out/)
    void conn
    await conn.close()
  })

  it('rejects pending requests with a clear error when the connection is closed', async () => {
    const scripts = makeSocketFactory()
    const conn = new HostdConnection({
      endpoint: 'http://127.0.0.1:1',
      requestTimeoutMs: 1000,
      heartbeatMs: 60_000,
      reconnectStepsMs: [10, 10, 10],
      handshakeTimeoutMs: 100,
      socketFactory: scripts.factory as unknown as (url: string) => import('ws').WebSocket,
    })
    conn.open()
    scripts.openLatest()
    const promise = conn.request('inventory', {})
    void conn.close()
    await expect(promise).rejects.toThrow(/closed/)
  })

  it('rejects requests with the remote error message when hostd returns ok:false', async () => {
    const scripts = makeSocketFactory()
    const conn = new HostdConnection({
      endpoint: 'http://127.0.0.1:1',
      requestTimeoutMs: 1000,
      heartbeatMs: 60_000,
      reconnectStepsMs: [10, 10, 10],
      handshakeTimeoutMs: 100,
      socketFactory: scripts.factory as unknown as (url: string) => import('ws').WebSocket,
    })
    conn.open()
    scripts.openLatest()
    scripts.scriptResponse({
      matchRequest: () => true,
      reply: (frame) => JSON.stringify({
        direction: 'response', id: frame['id'] as string, ok: false,
        error: { code: 'X', message: 'hostd rejected' },
      }),
    })
    await expect(conn.request('inventory', {})).rejects.toThrow('hostd rejected')
    void conn
    await conn.close()
  })

  it('never opens an HTTP fetch when WS is closed', async () => {
    const scripts = makeSocketFactory()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const conn = new HostdConnection({
      endpoint: 'http://127.0.0.1:1',
      requestTimeoutMs: 200,
      heartbeatMs: 60_000,
      reconnectStepsMs: [10, 10, 10],
      handshakeTimeoutMs: 100,
      socketFactory: scripts.factory as unknown as (url: string) => import('ws').WebSocket,
    })
    conn.open()
    scripts.openLatest()
    scripts.closeLatest()
    await expect(conn.request('inventory', {})).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    void conn
    await conn.close()
  })

  it('dispatches journal.page push events to subscribers by sessionId', async () => {
    const scripts = makeSocketFactory()
    const conn = new HostdConnection({
      endpoint: 'http://127.0.0.1:1',
      requestTimeoutMs: 1000,
      heartbeatMs: 60_000,
      reconnectStepsMs: [10, 10, 10],
      handshakeTimeoutMs: 100,
      socketFactory: scripts.factory as unknown as (url: string) => import('ws').WebSocket,
    })
    conn.open()
    scripts.openLatest()
    const sessionId = RemoteSessionId('s-1')
    let received = 0
    conn.subscribe(sessionId, 'g1', 0, () => { received += 1 })
    scripts.pushToLatest({
      direction: 'push', seq: 1,
      event: { type: 'journal.page', sessionId, page: { generation: 'g1', latestSeq: 1, droppedThrough: 0, gap: false, events: [] }, subscribers: 1 },
    })
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
    expect(received).toBe(1)
    void conn
    await conn.close()
  })

  it('skips push events whose sessionId is not subscribed', async () => {
    const scripts = makeSocketFactory()
    const conn = new HostdConnection({
      endpoint: 'http://127.0.0.1:1',
      requestTimeoutMs: 1000,
      heartbeatMs: 60_000,
      reconnectStepsMs: [10, 10, 10],
      handshakeTimeoutMs: 100,
      socketFactory: scripts.factory as unknown as (url: string) => import('ws').WebSocket,
    })
    conn.open()
    scripts.openLatest()
    const sessionId = RemoteSessionId('s-2')
    let received = 0
    conn.subscribe(sessionId, 'g1', 0, () => { received += 1 })
    scripts.pushToLatest({
      direction: 'push', seq: 1,
      event: { type: 'journal.page', sessionId: RemoteSessionId('other'), page: { generation: 'g1', latestSeq: 1, droppedThrough: 0, gap: false, events: [] }, subscribers: 0 },
    })
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
    expect(received).toBe(0)
    void conn
    await conn.close()
  })

  it('flushes pending requests after a socket reconnect', async () => {
    const scripts = makeSocketFactory()
    const conn = new HostdConnection({
      endpoint: 'http://127.0.0.1:1',
      requestTimeoutMs: 1000,
      heartbeatMs: 60_000,
      reconnectStepsMs: [10, 10, 10],
      handshakeTimeoutMs: 100,
      socketFactory: scripts.factory as unknown as (url: string) => import('ws').WebSocket,
    })
    conn.open()
    scripts.openLatest()
    scripts.scriptResponse({
      matchRequest: frame => frame['method'] === 'inventory',
      reply: (frame) => JSON.stringify({ direction: 'response', id: frame['id'] as string, ok: true, result: { id: frame['id'] } }),
    })
    scripts.scriptResponse({
      matchRequest: frame => frame['method'] === 'inventory',
      reply: (frame) => JSON.stringify({ direction: 'response', id: frame['id'] as string, ok: true, result: { id: frame['id'] } }),
    })
    const promise = conn.request('inventory', {})
    scripts.closeLatest()
    scripts.openLatest()
    const result = await promise
    expect(result).toMatchObject({ id: expect.any(String) })
    void conn
    await conn.close()
  })
})