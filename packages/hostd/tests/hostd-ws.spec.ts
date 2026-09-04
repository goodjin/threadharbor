/** End-to-end coverage of the hostd WebSocket hub against a fake hostd backend. */

import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  parseHostdWsFrame,
  type JsonValue,
  type RemoteHostdWsFrame,
  type RemoteJournalEvent,
  type RemoteJournalPage,
} from '@threadharbor/protocol'
import { HostdWsHub, type HostdWsHubOptions } from '../src/ws-hub.ts'
import type { HoldResponse } from '../src/hold-protocol.ts'
import type { HostdSessionRecord, RemoteAgentHostd } from '../src/server.ts'

interface FakeHold {
  nextSeq: number
  pages: RemoteJournalPage[]
  waiters: Array<{ resolve: (response: HoldResponse) => void; timer: NodeJS.Timeout }>
  dead?: boolean
}

interface FakeHostd {
  hostd: Pick<RemoteAgentHostd, 'dispatch' | 'findSessionRecord' | 'holdRequest'>
  sessions: Map<string, HostdSessionRecord>
  holds: Map<string, FakeHold>
}

function makeSessionRecord(id: string, generation = 'g1'): HostdSessionRecord {
  return {
    sessionId: id,
    holdId: `hold-${id}`,
    generation,
    backend: 'codex',
    cwd: '/repo',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function makeHostd(): FakeHostd {
  const sessions = new Map<string, HostdSessionRecord>()
  const holds = new Map<string, FakeHold>()
  const hostd = {
    dispatch: vi.fn(async (request: { id: string; method: string; params: Record<string, JsonValue> }) => {
      if (request.method === 'inventory') {
        return {
          protocolVersion: 1, hostdVersion: '0.1.0-test', hostId: 'test', healthy: true,
          backends: [],
        } as unknown as JsonValue
      }
      if (request.method === 'fs.list') {
        return { path: String(request.params['path'] ?? '/'), entries: [], truncated: false } as unknown as JsonValue
      }
      return { ok: true } as JsonValue
    }),
    findSessionRecord: (sessionId: string) => {
      const record = sessions.get(sessionId)
      if (record === undefined) throw new Error(`unknown hostd session ${sessionId}`)
      return record
    },
    holdRequest: vi.fn(async (record: HostdSessionRecord, request: Parameters<RemoteAgentHostd['holdRequest']>[1]) => {
      const hold = holds.get(record.holdId)
      if (hold === undefined) throw new Error(`unknown hold ${record.holdId}`)
      if (hold.dead === true) throw new Error('connect ECONNREFUSED /tmp/th-501/h-dead.sock')
      if (request.operation === 'ping') {
        return { ok: true, result: { latestSeq: hold.nextSeq - 1 } } as HoldResponse
      }
      if (request.operation === 'read') {
        const afterSeq = request.afterSeq
        const matching = hold.pages.flatMap((page) => page.events).filter((event) => event.seq > afterSeq)
        const latestSeq = hold.pages.at(-1)?.latestSeq ?? hold.nextSeq - 1
        return { ok: true, result: {
          generation: 'g1', latestSeq, droppedThrough: 0, gap: false, events: matching,
        } satisfies RemoteJournalPage } as HoldResponse
      }
      if (request.operation === 'wait-page') {
        const page = (afterSeq: number): HoldResponse => {
          const matching = hold.pages.flatMap((item) => item.events).filter((event) => event.seq > afterSeq)
          const latestSeq = hold.pages.at(-1)?.latestSeq ?? hold.nextSeq - 1
          return { ok: true, result: {
            generation: 'g1', latestSeq, droppedThrough: 0, gap: false, events: matching,
          } satisfies RemoteJournalPage } as HoldResponse
        }
        if (hold.nextSeq - 1 > request.afterSeq) return page(request.afterSeq)
        return await new Promise<HoldResponse>((resolve) => {
          const timer = setTimeout(() => { resolve(page(request.afterSeq)) }, request.timeoutMs)
          hold.waiters.push({ resolve, timer })
        })
      }
      if (request.operation === 'wait-seq') {
        if (hold.nextSeq - 1 > request.afterSeq) {
          return { ok: true, result: { latestSeq: hold.nextSeq - 1, timedOut: false } } as HoldResponse
        }
        return await new Promise<HoldResponse>((resolve) => {
          const timer = setTimeout(() => {
            resolve({ ok: true, result: { latestSeq: hold.nextSeq - 1, timedOut: true } })
          }, request.timeoutMs)
          hold.waiters.push({ resolve, timer })
        })
      }
      throw new Error(`unsupported ${request.operation}`)
    }),
  } as Pick<RemoteAgentHostd, 'dispatch' | 'findSessionRecord' | 'holdRequest'>
  return { hostd, sessions, holds }
}

interface WsHarness {
  hub: HostdWsHub
  fake: FakeHostd
  server: import('node:http').Server
  port: number
  connect(): WebSocket
  close(): Promise<void>
}

async function makeWsHarness(options?: Partial<HostdWsHubOptions>): Promise<WsHarness> {
  const fake = makeHostd()
  const hub = new HostdWsHub(fake.hostd as unknown as RemoteAgentHostd, {
    heartbeatMs: 60_000,
    waitTimeoutMs: 50,
    maxEventsPerPage: 100,
    ...options,
  })
  const server = createServer()
  await new Promise<void>((resolveStart) => server.listen(0, '127.0.0.1', () => resolveStart()))
  hub.attach(server)
  const address = server.address() as AddressInfo
  const port = address.port
  return {
    hub, fake, server, port,
    connect: () => new WebSocket(`ws://127.0.0.1:${port}/v1/ws`),
    close: async () => {
      await hub.close()
        ; await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

interface CollectedFrames {
  socket: WebSocket
  frames: RemoteHostdWsFrame[]
  send(frame: RemoteHostdWsFrame): void
  waitFor(predicate: (frames: RemoteHostdWsFrame[]) => boolean, options?: { timeout?: number }): Promise<void>
  close(): void
}

function attachCollector(socket: WebSocket): CollectedFrames {
  const frames: RemoteHostdWsFrame[] = []
  socket.on('message', (data) => {
    const text = data.toString('utf8')
    try { frames.push(parseHostdWsFrame(JSON.parse(text))) } catch { /* ignore */ }
  })
  return {
    socket,
    frames,
    send(frame: RemoteHostdWsFrame): void { socket.send(JSON.stringify(frame)) },
    waitFor(predicate, options) {
      const timeout = options?.timeout ?? 500
      return new Promise<void>((resolve, reject) => {
        if (predicate(frames)) { resolve(); return }
        const interval = setInterval(() => {
          if (predicate(frames)) {
            clearInterval(interval)
            clearTimeout(timer)
            resolve()
          }
        }, 5)
        const timer = setTimeout(() => {
          clearInterval(interval)
          reject(new Error(`waitFor timed out (${frames.length} frames received)`))
        }, timeout)
      })
    },
    close(): void { socket.close() },
  }
}

describe('HostdWsHub', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('round-trips request RPCs using the same dispatcher as HTTP /v1/control', async () => {
    const h = await makeWsHarness()
    try {
      const socket = await new Promise<WebSocket>((resolveOpen, rejectOpen) => {
        const ws = h.connect()
        ws.once('open', () => resolveOpen(ws))
        ws.once('error', rejectOpen)
      })
      const collector = attachCollector(socket)
      collector.send({ direction: 'request', id: 'r1', method: 'inventory', params: {} })
      await collector.waitFor(frames => frames.some(frame =>
        frame.direction === 'response' && frame.id === 'r1' && frame.ok === true))
      const response = collector.frames.find(frame => frame.direction === 'response' && frame.id === 'r1')!
      expect(response.ok).toBe(true)
      socket.close()
    } finally {
      await h.close()
    }
  })

  it('rejects malformed frames without closing the socket', async () => {
    const h = await makeWsHarness()
    try {
      const socket = await new Promise<WebSocket>((resolveOpen, rejectOpen) => {
        const ws = h.connect()
        ws.once('open', () => resolveOpen(ws))
        ws.once('error', rejectOpen)
      })
      let closed = false
      socket.on('close', () => { closed = true })
      socket.send('{not json}')
      socket.send(JSON.stringify({ direction: 'bogus' }))
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
      expect(closed).toBe(false)
      expect(socket.readyState).toBe(WebSocket.OPEN)
      socket.close()
    } finally {
      await h.close()
    }
  })

  it('responds to ping with pong', async () => {
    const h = await makeWsHarness()
    try {
      const socket = await new Promise<WebSocket>((resolveOpen, rejectOpen) => {
        const ws = h.connect()
        ws.once('open', () => resolveOpen(ws))
        ws.once('error', rejectOpen)
      })
      const collector = attachCollector(socket)
      collector.send({ direction: 'ping' })
      await collector.waitFor(frames => frames.some(frame => frame.direction === 'pong'))
      socket.close()
    } finally {
      await h.close()
    }
  })

  it('fans out a journal.page push to the subscriber of the session', async () => {
    const h = await makeWsHarness()
    try {
      const sessionId = 's1'
      const record = makeSessionRecord(sessionId)
      h.fake.sessions.set(sessionId, record)
      const event: RemoteJournalEvent = {
        seq: 1, generation: 'g1', timestamp: '2026-01-01T00:00:00Z',
        frame: { jsonrpc: '2.0', method: 'session/update', params: {} },
      }
      const page: RemoteJournalPage = {
        generation: 'g1', latestSeq: 1, droppedThrough: 0, gap: false, events: [event],
      }
      const hold: FakeHold = { nextSeq: 2, pages: [page], waiters: [] }
      h.fake.holds.set(record.holdId, hold)

      const socket = await new Promise<WebSocket>((resolveOpen, rejectOpen) => {
        const ws = h.connect()
        ws.once('open', () => resolveOpen(ws))
        ws.once('error', rejectOpen)
      })
      const collector = attachCollector(socket)
      collector.send({ direction: 'subscribe', sessionId, generation: 'g1', lastSeq: 0 })
      await collector.waitFor(frames => frames.some(frame =>
        frame.direction === 'push' && frame.event.type === 'journal.page' && frame.event.sessionId === sessionId))
      const push = collector.frames.find(frame => frame.direction === 'push'
        && frame.event.type === 'journal.page' && frame.event.sessionId === sessionId)!
      expect(push.event.type === 'journal.page' && push.event.page.latestSeq).toBe(1)
      socket.close()
    } finally {
      await h.close()
    }
  })

  it('emits a journal.gap push when the subscriber generation does not match', async () => {
    const h = await makeWsHarness()
    try {
      const sessionId = 's2'
      const record = makeSessionRecord(sessionId, 'g2')
      h.fake.sessions.set(sessionId, record)
      h.fake.holds.set(record.holdId, { nextSeq: 0, pages: [], waiters: [] })

      const socket = await new Promise<WebSocket>((resolveOpen, rejectOpen) => {
        const ws = h.connect()
        ws.once('open', () => resolveOpen(ws))
        ws.once('error', rejectOpen)
      })
      const collector = attachCollector(socket)
      collector.send({ direction: 'subscribe', sessionId, generation: 'g-old', lastSeq: 0 })
      await collector.waitFor(frames => frames.some(frame =>
        frame.direction === 'push' && frame.event.type === 'journal.gap' && frame.event.sessionId === sessionId))
      socket.close()
    } finally {
      await h.close()
    }
  })

  it('emits journal.gap when the hold socket is dead so the gateway can leave running', async () => {
    const h = await makeWsHarness()
    try {
      const sessionId = 's-dead'
      const record = makeSessionRecord(sessionId)
      h.fake.sessions.set(sessionId, record)
      h.fake.holds.set(record.holdId, { nextSeq: 0, pages: [], waiters: [], dead: true })
      const socket = await new Promise<WebSocket>((resolveOpen, rejectOpen) => {
        const ws = h.connect()
        ws.once('open', () => resolveOpen(ws))
        ws.once('error', rejectOpen)
      })
      const collector = attachCollector(socket)
      collector.send({ direction: 'subscribe', sessionId, generation: 'g1', lastSeq: 0 })
      await collector.waitFor(frames => frames.some(frame =>
        frame.direction === 'push' && frame.event.type === 'journal.gap' && frame.event.sessionId === sessionId))
      socket.close()
    } finally {
      await h.close()
    }
  })

  it('cleans up the per-hold waiter when the last subscriber unsubscribes', async () => {
    const h = await makeWsHarness()
    try {
      const sessionId = 's3'
      const record = makeSessionRecord(sessionId)
      h.fake.sessions.set(sessionId, record)
      h.fake.holds.set(record.holdId, { nextSeq: 1, pages: [{
        generation: 'g1', latestSeq: 1, droppedThrough: 0, gap: false,
        events: [{ seq: 1, generation: 'g1', timestamp: '2026-01-01T00:00:00Z',
          frame: { jsonrpc: '2.0', method: 'session/update', params: {} } }],
      } satisfies RemoteJournalPage], waiters: [] })

      const socket = await new Promise<WebSocket>((resolveOpen, rejectOpen) => {
        const ws = h.connect()
        ws.once('open', () => resolveOpen(ws))
        ws.once('error', rejectOpen)
      })
      const collector = attachCollector(socket)
      collector.send({ direction: 'subscribe', sessionId, generation: 'g1', lastSeq: 0 })
      await collector.waitFor(frames => frames.some(frame =>
        frame.direction === 'push' && frame.event.type === 'journal.page' && frame.event.sessionId === sessionId))
      expect(h.hub.waitersForTesting().has(record.holdId)).toBe(true)
      collector.send({ direction: 'unsubscribe', sessionId })
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
      expect(h.hub.waitersForTesting().has(record.holdId)).toBe(false)
      socket.close()
    } finally {
      await h.close()
    }
  })

  it('caps each journal.page push at maxEventsPerPage and emits the remainder on the next push', async () => {
    const h = await makeWsHarness({ maxEventsPerPage: 100 })
    try {
      const sessionId = 's4'
      const record = makeSessionRecord(sessionId)
      h.fake.sessions.set(sessionId, record)
      const events: RemoteJournalEvent[] = []
      for (let i = 1; i <= 250; i++) {
        events.push({
          seq: i, generation: 'g1', timestamp: '2026-01-01T00:00:00Z',
          frame: { jsonrpc: '2.0', method: 'session/update', params: { i } },
        })
      }
      const page: RemoteJournalPage = {
        generation: 'g1', latestSeq: 250, droppedThrough: 0, gap: false, events,
      }
      const hold: FakeHold = { nextSeq: 251, pages: [page], waiters: [] }
      h.fake.holds.set(record.holdId, hold)

      const socket = await new Promise<WebSocket>((resolveOpen, rejectOpen) => {
        const ws = h.connect()
        ws.once('open', () => resolveOpen(ws))
        ws.once('error', rejectOpen)
      })
      const collector = attachCollector(socket)
      collector.send({ direction: 'subscribe', sessionId, generation: 'g1', lastSeq: 0 })
      const pushes = await collector.waitFor(frames => {
        const journalPages = frames.filter(frame =>
          frame.direction === 'push' && frame.event.type === 'journal.page' && frame.event.sessionId === sessionId)
        const totalEvents = journalPages.reduce((sum, frame) => {
          if (frame.event.type !== 'journal.page') return sum
          return sum + frame.event.page.events.length
        }, 0)
        return totalEvents >= 250
      }, { timeout: 2000 })
      void pushes
      const journalPages = collector.frames.filter(frame =>
        frame.direction === 'push' && frame.event.type === 'journal.page' && frame.event.sessionId === sessionId)
      expect(journalPages.length).toBeGreaterThanOrEqual(3)
      for (const frame of journalPages) {
        if (frame.event.type !== 'journal.page') continue
        expect(frame.event.page.events.length).toBeLessThanOrEqual(100)
      }
      socket.close()
    } finally {
      await h.close()
    }
  })
})
