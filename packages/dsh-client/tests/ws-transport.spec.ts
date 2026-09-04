// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WsTransport, type TransportPhase } from '../src/client/ws-transport.ts'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  readonly sent: string[] = []
  readyState = 1
  url: string
  closed = false
  listeners = new Map<string, ((event: unknown) => void)[]>()
  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  send(payload: string): void { this.sent.push(payload) }
  close(): void {
    this.closed = true
    this.readyState = 3
    this.dispatch('close', {})
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  on(type: string, listener: (event: unknown) => void): void {
    this.addEventListener(type, listener)
  }
  removeEventListener(): void { /* noop */ }
  dispatch(type: string, event: unknown): void {
    const list = this.listeners.get(type) ?? []
    for (const fn of list) fn(event)
  }
  fakeOpen(): void {
    this.readyState = 1
    this.dispatch('open', {})
  }
  fakeMessage(payload: string): void {
    this.dispatch('message', { data: payload })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  MockWebSocket.instances.length = 0
})

describe('WsTransport', () => {
  it('identifies the browser and advertises transcript batch support on the upgrade URL', () => {
    const ctor = vi.fn((url: string) => new MockWebSocket(url))
    vi.stubGlobal('WebSocket', ctor)
    const transport = new WsTransport({ url: 'ws://test/ws', browserId: 'browser-1' })
    transport.connect()
    const url = new URL(MockWebSocket.instances[0]!.url)
    expect(url.searchParams.get('browserId')).toBe('browser-1')
    expect(url.searchParams.get('capabilities')).toBe('transcript.batch')
    transport.close()
  })

  it('reports phase changes as the socket moves through open/close cycles', () => {
    const ctor = vi.fn((url: string) => new MockWebSocket(url))
    vi.stubGlobal('WebSocket', ctor)
    const transport = new WsTransport({ url: 'ws://test/ws' })
    const phases: TransportPhase[] = []
    transport.onPhase((p) => phases.push(p))
    transport.connect()
    expect(MockWebSocket.instances.length).toBe(1)
    const sock = MockWebSocket.instances[0]!
    sock.fakeOpen()
    expect(phases).toContain('live')
    sock.close()
    expect(phases[phases.length - 1]).toBe('reconnecting')
    transport.close()
  })

  it('routes a request and resolves with the matching response', async () => {
    const ctor = vi.fn((url: string) => new MockWebSocket(url))
    vi.stubGlobal('WebSocket', ctor)
    const transport = new WsTransport({ url: 'ws://test/ws' })
    transport.connect()
    const sock = MockWebSocket.instances[0]!
    sock.fakeOpen()
    const promise = transport.call('state', {})
    const requestSent = sock.sent.find((line) => line.includes('"method":"state"'))
    expect(requestSent).toBeDefined()
    const id = JSON.parse(requestSent!)['id'] as string
    sock.fakeMessage(JSON.stringify({ direction: 'response', id, ok: true, result: { pollIntervalMs: 1 } }))
    await expect(promise).resolves.toEqual({ pollIntervalMs: 1 })
    transport.close()
  })

  it('rejects the request when the response is an error', async () => {
    const ctor = vi.fn((url: string) => new MockWebSocket(url))
    vi.stubGlobal('WebSocket', ctor)
    const transport = new WsTransport({ url: 'ws://test/ws' })
    transport.connect()
    const sock = MockWebSocket.instances[0]!
    sock.fakeOpen()
    const promise = transport.call('state', {})
    const requestSent = sock.sent.find((line) => line.includes('"method":"state"'))
    expect(requestSent).toBeDefined()
    const id = JSON.parse(requestSent!)['id'] as string
    sock.fakeMessage(JSON.stringify({ direction: 'response', id, ok: false, error: { code: 'X', message: 'bad' } }))
    await expect(promise).rejects.toThrow('bad')
    transport.close()
  })

  it('dispatches push frames to onPush subscribers', () => {
    const ctor = vi.fn((url: string) => new MockWebSocket(url))
    vi.stubGlobal('WebSocket', ctor)
    const transport = new WsTransport({ url: 'ws://test/ws' })
    transport.connect()
    const sock = MockWebSocket.instances[0]!
    sock.fakeOpen()
    const frames: unknown[] = []
    transport.onPush((frame) => { frames.push(frame) })
    sock.fakeMessage(JSON.stringify({ direction: 'push', seq: 1, event: { type: 'host.changed', host: {} } }))
    expect(frames.length).toBe(1)
    transport.close()
  })

  it('sends follow and other control RPCs over HTTP while reconnecting', async () => {
    vi.stubGlobal('WebSocket', () => { throw new Error('protocol not supported') })
    const calls: { method: string }[] = []
    vi.stubGlobal('fetch', async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { id: string; method: string }
      calls.push({ method: body.method })
      return {
        json: async () => ({ id: body.id, ok: true, result: { pollIntervalMs: 1 } }),
      }
    })
    const transport = new WsTransport({ url: 'ws://test/ws', browserId: 'browser-1' })
    transport.connect()
    expect(transport.getPhase()).toBe('reconnecting')
    transport.follow('session-1')
    await expect(transport.call('state', {})).resolves.toEqual({ pollIntervalMs: 1 })
    await vi.waitFor(() => {
      expect(calls.map(call => call.method).sort()).toEqual(['session.follow', 'state'])
    })
    transport.close()
  })

  it('keeps reconnecting when the WebSocket constructor itself throws', async () => {
    vi.useFakeTimers()
    const ctor = vi.fn(() => { throw new Error('protocol not supported') })
    vi.stubGlobal('WebSocket', ctor)
    const transport = new WsTransport({ url: 'ws://test/ws' })
    try {
      const phases: TransportPhase[] = []
      transport.onPhase((p) => phases.push(p))
      transport.connect()
      expect(phases.at(-1)).toBe('reconnecting')
      expect(ctor).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(ctor).toHaveBeenCalledTimes(2)
    } finally {
      transport.close()
      vi.useRealTimers()
    }
  })

  it('follows a session and unfollows it again', () => {
    const ctor = vi.fn((url: string) => new MockWebSocket(url))
    vi.stubGlobal('WebSocket', ctor)
    const transport = new WsTransport({ url: 'ws://test/ws' })
    transport.connect()
    const sock = MockWebSocket.instances[0]!
    sock.fakeOpen()
    transport.follow('s1')
    transport.follow('s2')
    const sent = sock.sent.map((line) => JSON.parse(line))
    expect(sent.filter((s: { method?: string }) => s.method === 'session.follow').length).toBe(2)
    transport.unfollow('s1')
    const after = sock.sent.map((line) => JSON.parse(line))
    expect(after.filter((s: { method?: string }) => s.method === 'session.unfollow').length).toBe(1)
    transport.followOnly('s2')
    const only = sock.sent.map((line) => JSON.parse(line))
    expect(only.filter((s: { method?: string; params?: { sessionId?: string } }) => s.method === 'session.follow' && s.params?.sessionId === 's2').length).toBe(1)
    transport.close()
  })

  it('falls back to HTTP for prompt and transcript.read while reconnecting', async () => {
    const ctor = vi.fn((url: string) => new MockWebSocket(url))
    vi.stubGlobal('WebSocket', ctor)
    const calls: { method: string }[] = []
    vi.stubGlobal('fetch', async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { id: string; method: string }
      calls.push({ method: body.method })
      return {
        json: async () => ({ id: body.id, ok: true, result: { accepted: true } }),
      }
    })
    const transport = new WsTransport({ url: 'ws://test/ws', browserId: 'browser-1' })
    try {
      transport.connect()
      expect(transport.getPhase()).toBe('connecting')
      await expect(transport.call('session.prompt', { sessionId: 's1', text: 'hi' })).resolves.toEqual({ accepted: true })
      await expect(transport.call('transcript.read', { sessionId: 's1' })).resolves.toEqual({ accepted: true })
      expect(calls.map(call => call.method)).toEqual(['session.prompt', 'transcript.read'])
    } finally {
      transport.close()
    }
  })

  it('keeps retrying the socket after the backoff ladder instead of falling back to HTTP', async () => {
    vi.useFakeTimers()
    const ctor = vi.fn((url: string) => new MockWebSocket(url))
    vi.stubGlobal('WebSocket', ctor)
    const transport = new WsTransport({ url: 'ws://test/ws' })
    try {
      transport.connect()
      for (let i = 0; i < 8; i++) {
        MockWebSocket.instances.at(-1)?.close()
        await vi.advanceTimersByTimeAsync(20_000)
      }
      expect(transport.getPhase()).toBe('reconnecting')
      expect(MockWebSocket.instances.length).toBeGreaterThan(6)
    } finally {
      transport.close()
      vi.useRealTimers()
    }
  })

  it('sends browser.hello with last seen transcript seqs after reconnect', async () => {
    vi.useFakeTimers()
    const ctor = vi.fn((url: string) => new MockWebSocket(url))
    vi.stubGlobal('WebSocket', ctor)
    const transport = new WsTransport({ url: 'ws://test/ws', browserId: 'browser-1' })
    try {
      transport.connect()
      const first = MockWebSocket.instances[0]!
      first.fakeOpen()
      first.fakeMessage(JSON.stringify({
        direction: 'push', seq: 7, event: { type: 'transcript.append', sessionId: 's1', seq: 4 },
      }))
      first.fakeMessage(JSON.stringify({
        direction: 'push', seq: 8, event: { type: 'transcript.batch', sessionId: 's2', fromSeq: 1, toSeq: 6, entries: [] },
      }))
      first.close()
      await vi.advanceTimersByTimeAsync(500)
      const second = MockWebSocket.instances.at(-1)!
      second.fakeOpen()
      const hello = second.sent.map((line) => JSON.parse(line) as { method?: string; params?: { lastSeenSeqs?: Record<string, number> } })
        .find(frame => frame.method === 'browser.hello')
      expect(hello?.params?.lastSeenSeqs).toEqual({ s1: 4, s2: 6 })
    } finally {
      transport.close()
      vi.useRealTimers()
    }
  })
})
