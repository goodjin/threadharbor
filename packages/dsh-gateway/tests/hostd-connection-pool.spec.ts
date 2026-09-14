/** Unit tests for the per-host hostd connection pool and SSH tunnel awareness. */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RemoteHostId,
  RemoteSessionId,
  type RemoteHostView,
} from '@threadharbor/protocol'
import { HostdConnectionPool } from '../src/hostd-connection-pool.ts'
import type { SshManager } from '../src/ssh-manager.ts'

interface MockSocket extends EventEmitter {
  readyState: number
  send(payload: string): void
  close(code?: number, reason?: string): void
}

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

interface SocketHarness {
  factory: (url: string) => MockSocket
  urls: string[]
  sockets: MockSocket[]
  script(method: string, result: Record<string, unknown>): void
  openLatest(): void
}

function makeSocketHarness(): SocketHarness {
  const sockets: MockSocket[] = []
  const urls: string[] = []
  const scripts: Array<{ method: string; result: Record<string, unknown> }> = []
  const factory = (url: string): MockSocket => {
    urls.push(url)
    const socket = new EventEmitter() as MockSocket
    socket.readyState = CONNECTING
    socket.send = (payload: string): void => {
      let frame: { direction?: string; method?: string; id?: string }
      try { frame = JSON.parse(payload) as { direction?: string; method?: string; id?: string } } catch { return }
      if (frame.direction !== 'request') return
      const index = scripts.findIndex(script => script.method === frame.method)
      if (index === -1) return
      const script = scripts.splice(index, 1)[0]!
      setImmediate(() => socket.emit('message', JSON.stringify({
        direction: 'response', id: frame.id, ok: true, result: script.result,
      })))
    }
    socket.close = (code?: number, reason?: string): void => {
      void code
      void reason
      socket.readyState = CLOSED
      socket.emit('close')
    }
    sockets.push(socket)
    return socket
  }
  return {
    factory,
    urls,
    sockets,
    script(method, result) { scripts.push({ method, result }) },
    openLatest() {
      const last = sockets.at(-1)
      if (last === undefined) throw new Error('no sockets')
      last.readyState = OPEN
      last.emit('open')
    },
  }
}

function hostWithSsh(endpoint: string): RemoteHostView {
  return {
    hostId: RemoteHostId('pool-host'),
    title: 'pool-host',
    endpoint,
    ssh: { target: 'example.test', hostKeyFingerprint: 'SHA256:fake' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

/** Wait until the factory created `expected` sockets, then open the newest one. */
async function openWhenReady(harness: SocketHarness, expected = 1): Promise<void> {
  await vi.waitFor(() => {
    if (harness.sockets.length < expected) throw new Error(`only ${harness.sockets.length}/${expected} sockets`)
  }, { timeout: 2000, interval: 5 })
  harness.openLatest()
}

describe('HostdConnectionPool', () => {
  afterEach(() => { })

  it('routes each request over the tunnel endpoint the ssh manager currently resolves', async () => {
    const harness = makeSocketHarness()
    let resolved = 'http://127.0.0.1:4100'
    const ensureTunnel = async (): Promise<string> => resolved
    const pool = new HostdConnectionPool(
      { ensureTunnel } as unknown as SshManager,
      {
        requestTimeoutMs: 1000,
        heartbeatMs: 60_000,
        reconnectStepsMs: [10, 10, 10],
        handshakeTimeoutMs: 100,
        socketFactory: harness.factory as unknown as (url: string) => import('ws').WebSocket,
      },
    )
    try {
      const host = hostWithSsh('http://127.0.0.1:9999')
      harness.script('inventory', { healthy: true })
      const pending = pool.request(host, 'inventory', {})
      await openWhenReady(harness)
      expect(await pending).toEqual({ healthy: true })
      expect(harness.urls).toEqual(['ws://127.0.0.1:4100/v1/ws'])
    } finally {
      await pool.closeAll()
    }
  })

  it('does not leak an unhandled rejection when a subscription cannot open its tunnel', async () => {
    const harness = makeSocketHarness()
    const ensureTunnel = async (): Promise<string> => { throw new Error('SSH tunnel exited with status 0: ') }
    const pool = new HostdConnectionPool(
      { ensureTunnel } as unknown as SshManager,
      {
        requestTimeoutMs: 1000,
        heartbeatMs: 60_000,
        reconnectStepsMs: [10, 10, 10],
        handshakeTimeoutMs: 100,
        socketFactory: harness.factory as unknown as (url: string) => import('ws').WebSocket,
      },
    )
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const host = hostWithSsh('http://127.0.0.1:9999')
      const unsubscribe = pool.subscribe(host, RemoteSessionId('sess-1'), 'g1', 0, () => undefined)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
      expect(stderr.mock.calls.some(call => String(call[0]).includes('hostd subscription deferred'))).toBe(true)
      expect(harness.sockets).toHaveLength(0)
      unsubscribe()
    } finally {
      stderr.mockRestore()
      process.off('unhandledRejection', onUnhandled)
      await pool.closeAll()
    }
  })

  it('moves the pooled connection when the tunnel endpoint changes between requests', async () => {
    const harness = makeSocketHarness()
    let resolved = 'http://127.0.0.1:4100'
    const ensureTunnel = async (): Promise<string> => resolved
    const pool = new HostdConnectionPool(
      { ensureTunnel } as unknown as SshManager,
      {
        requestTimeoutMs: 1000,
        heartbeatMs: 60_000,
        reconnectStepsMs: [10, 10, 10],
        handshakeTimeoutMs: 100,
        socketFactory: harness.factory as unknown as (url: string) => import('ws').WebSocket,
      },
    )
    try {
      const host = hostWithSsh('http://127.0.0.1:9999')
      harness.script('inventory', { first: true })
      const first = pool.request(host, 'inventory', {})
      await openWhenReady(harness)
      expect(await first).toEqual({ first: true })
      expect(harness.urls).toEqual(['ws://127.0.0.1:4100/v1/ws'])

      // A redeploy replaced the tunnel on a fresh local port.
      resolved = 'http://127.0.0.1:4101'
      harness.script('inventory', { second: true })
      const second = pool.request(host, 'inventory', {})
      await openWhenReady(harness, 2)
      expect(await second).toEqual({ second: true })
      // The same pooled connection moved to the new endpoint: no extra
      // per-host socket was created and the old one was closed.
      expect(harness.urls).toEqual(['ws://127.0.0.1:4100/v1/ws', 'ws://127.0.0.1:4101/v1/ws'])
      expect(harness.sockets.at(0)?.readyState).toBe(CLOSED)
    } finally {
      await pool.closeAll()
    }
  })

  it('opens a single connection when concurrent first requests race', async () => {
    const harness = makeSocketHarness()
    const ensureTunnel = async (): Promise<string> => {
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
      return 'http://127.0.0.1:4102'
    }
    const pool = new HostdConnectionPool(
      { ensureTunnel } as unknown as SshManager,
      {
        requestTimeoutMs: 2000,
        heartbeatMs: 60_000,
        reconnectStepsMs: [10, 10, 10],
        handshakeTimeoutMs: 100,
        socketFactory: harness.factory as unknown as (url: string) => import('ws').WebSocket,
      },
    )
    try {
      const host = hostWithSsh('http://127.0.0.1:9999')
      harness.script('inventory', { a: true })
      harness.script('inventory', { b: true })
      const first = pool.request(host, 'inventory', {})
      const second = pool.request(host, 'inventory', {})
      await openWhenReady(harness)
      const results = await Promise.all([first, second])
      expect(results).toEqual([{ a: true }, { b: true }])
      expect(harness.sockets).toHaveLength(1)
      expect(harness.urls).toHaveLength(1)
    } finally {
      await pool.closeAll()
    }
  })
})
