/** Persistent WebSocket fan-out for the hostd control channel.
 *
 *  One `WebSocketServer({ noServer: true })` is `attach()`ed to the hostd HTTP server
 *  and serves `/v1/ws`. Each browser- or gateway-side connection multiplexes:
 *
 *    - RPC requests with `direction: "request"` (re-uses `RemoteAgentHostd.dispatch`),
 *    - subscribe/unsubscribe for native-frame push per session,
 *    - server-initiated `journal.page` and `journal.gap` events,
 *    - ping/pong heartbeats.
 *
 *  A single per-hold waiter (`holdRequest('wait-page')`) feeds all subscribers of
 *  the same session, eliminating the 1s poll fallback and an extra local socket round trip.
 */

import type http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  REMOTE_AGENT_HOSTD_WS_PATH,
  parseHostdWsFrame,
  RemoteSessionId,
  type JsonValue,
  type RemoteHostdMethod,
  type RemoteHostdWsEvent,
  type RemoteHostdWsFrame,
  type RemoteJournalPage,
} from '@threadharbor/protocol'
import type { HoldResponse } from './hold-protocol.ts'
import type { HostdSessionRecord, RemoteAgentHostd } from './server.ts'

/** WS_OPEN is the only readyState where we may send frames. */
const WS_OPEN = 1

/** Tunables for the WS hub; injected to keep tests deterministic. */
export interface HostdWsHubOptions {
  readonly heartbeatMs: number
  readonly waitTimeoutMs: number
  readonly maxEventsPerPage: number
}

/** Per-session subscription state. */
interface Subscriber {
  readonly ws: WebSocket
  lastSeq: number
}

/** Per-hold waiter driver state. */
interface PerHoldWaiter {
  readonly record: HostdSessionRecord
  readonly abort: AbortController
}

/** Persistent hostd WebSocket fan-out: RPC multiplexing, single-waiter-per-hold push, heartbeat. */
export class HostdWsHub {
  private readonly wss: WebSocketServer
  private readonly waiters = new Map<string, PerHoldWaiter>()
  private readonly subscribersBySession = new Map<RemoteSessionId, Map<WebSocket, Subscriber>>()
  private readonly socketToSessions = new WeakMap<WebSocket, Set<RemoteSessionId>>()
  private readonly recordByHoldId = new Map<string, HostdSessionRecord>()
  private pushSeq = 0
  private heartbeatTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(
    private readonly hostd: RemoteAgentHostd,
    private readonly options: HostdWsHubOptions,
  ) {
    this.wss = new WebSocketServer({ noServer: true })
  }

  /** Bind the upgrade handler to the hostd HTTP server.
   * @param server - cordis-owned loopback HTTP server.
   */
  attach(server: http.Server): void {
    server.on('upgrade', (req, socket, head) => {
      const path = req.url?.split('?')[0]
      if (path !== REMOTE_AGENT_HOSTD_WS_PATH) return
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.registerConnection(ws)
      })
    })
    this.heartbeatTimer = setInterval(() => this.sendHeartbeats(), this.options.heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  /** Close all sockets and stop the heartbeat. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    for (const waiter of this.waiters.values()) waiter.abort.abort()
    this.waiters.clear()
    for (const sessionSubs of this.subscribersBySession.values()) {
      for (const ws of sessionSubs.keys()) {
        if (ws.readyState === WS_OPEN) ws.close(1001, 'hostd shutting down')
      }
      sessionSubs.clear()
    }
    this.subscribersBySession.clear()
    for (const client of this.wss.clients) {
      if (client.readyState === WS_OPEN) client.close(1001, 'hostd shutting down')
    }
    await new Promise<void>((resolveClose) => {
      this.wss.close(() => resolveClose())
    })
  }

  /** Number of connected sockets; useful for tests and graceful shutdown. */
  size(): number {
    return this.wss.clients.size
  }

  /** Per-hold waiter map (test seam). */
  waitersForTesting(): Map<string, PerHoldWaiter> {
    return this.waiters
  }

  /** Drop all in-memory state for a hold; called when a session is dropped or restarted. */
  forgetHold(holdId: string): void {
    const waiter = this.waiters.get(holdId)
    if (waiter !== undefined) {
      waiter.abort.abort()
      this.waiters.delete(holdId)
    }
    const record = this.recordByHoldId.get(holdId)
    if (record === undefined) return
    const sessionSubs = this.subscribersBySession.get(RemoteSessionId(record.sessionId))
    if (sessionSubs !== undefined) {
      for (const subscriber of sessionSubs.values()) {
        subscriber.ws.close(1011, `hold ${holdId} dropped`)
      }
      sessionSubs.clear()
      this.subscribersBySession.delete(RemoteSessionId(record.sessionId))
    }
    this.recordByHoldId.delete(holdId)
  }

  private registerConnection(ws: WebSocket): void {
    ws.on('message', (data) => { void this.handleClientMessage(ws, data) })
    ws.on('close', () => { this.handleSocketClose(ws) })
    ws.on('error', () => { /* swallow; the close handler cleans up */ })
  }

  private async handleClientMessage(ws: WebSocket, data: unknown): Promise<void> {
    const text = wsText(data)
    if (text === '') return
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return }
    let frame: RemoteHostdWsFrame
    try { frame = parseHostdWsFrame(parsed) } catch { return }
    if (frame.direction === 'ping') {
      if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ direction: 'pong' }))
      return
    }
    if (frame.direction === 'pong') return
    if (frame.direction === 'request') {
      await this.handleRequest(ws, frame.id, frame.method, frame.params)
      return
    }
    if (frame.direction === 'subscribe') {
      this.handleSubscribe(ws, frame.sessionId, frame.generation, frame.lastSeq)
      return
    }
    if (frame.direction === 'unsubscribe') {
      this.handleUnsubscribe(ws, frame.sessionId)
      return
    }
  }

  private async handleRequest(
    ws: WebSocket,
    id: string,
    method: RemoteHostdMethod,
    params: Record<string, JsonValue>,
  ): Promise<void> {
    const reply = (frame: RemoteHostdWsFrame): void => {
      if (ws.readyState !== WS_OPEN) return
      ws.send(JSON.stringify(frame))
    }
    try {
      const result = await this.hostd.dispatch({ id, method, params })
      reply({ direction: 'response', id, ok: true, result })
    } catch (error) {
      reply({
        direction: 'response', id, ok: false,
        error: {
          code: 'HOSTD_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private handleSubscribe(ws: WebSocket, sessionId: RemoteSessionId, generation: string, lastSeq: number): void {
    let record: HostdSessionRecord
    try { record = this.hostd.findSessionRecord(sessionId as unknown as string) }
    catch { return }
    if (this.holdGenerationChanged(record, generation)) {
      const gapEvent: RemoteHostdWsEvent = {
        type: 'journal.gap',
        sessionId,
        droppedThrough: lastSeq,
        generation,
      }
      this.sendTo(ws, { direction: 'push', seq: ++this.pushSeq, event: gapEvent })
    }
    const subscribers = this.subscribersBySession.get(sessionId) ?? new Map<WebSocket, Subscriber>()
    const previous = subscribers.get(ws)
    subscribers.set(ws, { ws, lastSeq: previous?.lastSeq ?? lastSeq })
    this.subscribersBySession.set(sessionId, subscribers)
    const sessions = this.socketToSessions.get(ws) ?? new Set<RemoteSessionId>()
    sessions.add(sessionId)
    this.socketToSessions.set(ws, sessions)
    this.recordByHoldId.set(record.holdId, record)
    this.ensureWaiter(record, subscribers.get(ws)!.lastSeq)
  }

  private handleUnsubscribe(ws: WebSocket, sessionId: RemoteSessionId): void {
    const subscribers = this.subscribersBySession.get(sessionId)
    if (subscribers === undefined) return
    subscribers.delete(ws)
    this.socketToSessions.get(ws)?.delete(sessionId)
    if (subscribers.size === 0) {
      this.subscribersBySession.delete(sessionId)
      this.stopWaiterIfEmpty(sessionId)
    }
  }

  private handleSocketClose(ws: WebSocket): void {
    const sessions = this.socketToSessions.get(ws)
    if (sessions === undefined) return
    for (const sessionId of [...sessions]) {
      const subscribers = this.subscribersBySession.get(sessionId)
      if (subscribers === undefined) continue
      subscribers.delete(ws)
      if (subscribers.size === 0) {
        this.subscribersBySession.delete(sessionId)
        this.stopWaiterIfEmpty(sessionId)
      }
    }
    this.socketToSessions.delete(ws)
  }

  private ensureWaiter(record: HostdSessionRecord, _initialLastSeq: number): void {
    const holdId = record.holdId
    const existing = this.waiters.get(holdId)
    if (existing !== undefined) return
    const abort = new AbortController()
    const waiter: PerHoldWaiter = { record, abort }
    this.waiters.set(holdId, waiter)
    void this.runWaiter(waiter)
  }

  private stopWaiterIfEmpty(sessionId: RemoteSessionId): void {
    const holdId = this.holdIdForSession(sessionId)
    if (holdId === undefined) return
    if (this.holdHasSubscribers(holdId)) return
    const waiter = this.waiters.get(holdId)
    if (waiter === undefined) return
    waiter.abort.abort()
    this.waiters.delete(holdId)
  }

  private holdHasSubscribers(holdId: string): boolean {
    for (const record of this.recordByHoldId.values()) {
      if (record.holdId !== holdId) continue
      const sessionSubs = this.subscribersBySession.get(RemoteSessionId(record.sessionId))
      if (sessionSubs !== undefined && sessionSubs.size > 0) return true
    }
    return false
  }

  private holdIdForSession(sessionId: RemoteSessionId): string | undefined {
    for (const record of this.recordByHoldId.values()) {
      if (record.sessionId === (sessionId as unknown as string)) return record.holdId
    }
    return undefined
  }

  private holdGenerationChanged(record: HostdSessionRecord, generation: string): boolean {
    return record.generation !== generation
  }

  private async runWaiter(waiter: PerHoldWaiter): Promise<void> {
    const { record, abort } = waiter
    let afterSeq = this.minLastSeqForHold(record.holdId)
    while (!abort.signal.aborted) {
      const subscriberCount = this.subscribersFor(record).size
      if (subscriberCount === 0) {
        this.waiters.delete(record.holdId)
        return
      }
      try {
        let response: HoldResponse
        try {
          response = await this.hostd.holdRequest(
            record,
            {
              operation: 'wait-page',
              afterSeq,
              timeoutMs: this.options.waitTimeoutMs,
              generation: record.generation,
            },
            undefined,
            abort.signal,
          ) as HoldResponse
        } catch {
          if (abort.signal.aborted) return
          await this.hostd.holdRequest(
            record,
            { operation: 'wait-seq', afterSeq, timeoutMs: this.options.waitTimeoutMs },
            undefined,
            abort.signal,
          )
          response = await this.hostd.holdRequest(
            record,
            { operation: 'read', afterSeq, generation: record.generation },
            undefined,
            abort.signal,
          ) as HoldResponse
        }
        if (!response.ok) {
          if (abort.signal.aborted) return
          continue
        }
        const page = response.result as unknown as RemoteJournalPage
        if (abort.signal.aborted) return
        const trimmed = this.capPage(page)
        this.fanoutPage(record, trimmed)
        // Track afterSeq by the last event we actually pushed so the next read
        // picks up where this push left off rather than restarting at latestSeq.
        const lastPushed = trimmed.events.at(-1)?.seq ?? page.latestSeq
        afterSeq = lastPushed
        // If the page was capped, immediately drain the remainder so a busy hold
        // flushes in bounded chunks instead of waiting for new events.
        if (page.events.length > this.options.maxEventsPerPage) continue
      } catch (error) {
        if (abort.signal.aborted) return
        if (holdSocketDead(error)) this.fanoutHoldDead(record)
        this.waiters.delete(record.holdId)
        return
      }
    }
  }

  private minLastSeqForHold(holdId: string): number {
    let min = Number.POSITIVE_INFINITY
    for (const record of this.recordByHoldId.values()) {
      if (record.holdId !== holdId) continue
      const sessionSubs = this.subscribersBySession.get(RemoteSessionId(record.sessionId))
      if (sessionSubs === undefined) continue
      for (const subscriber of sessionSubs.values()) {
        if (subscriber.lastSeq < min) min = subscriber.lastSeq
      }
    }
    return min === Number.POSITIVE_INFINITY ? 0 : min
  }

  private capPage(page: RemoteJournalPage): RemoteJournalPage {
    if (page.events.length <= this.options.maxEventsPerPage) return page
    return { ...page, events: page.events.slice(0, this.options.maxEventsPerPage) }
  }

  private subscribersFor(record: HostdSessionRecord): Map<WebSocket, Subscriber> {
    return this.subscribersBySession.get(RemoteSessionId(record.sessionId)) ?? new Map()
  }

  private fanoutHoldDead(record: HostdSessionRecord): void {
    for (const candidate of this.recordByHoldId.values()) {
      if (candidate.holdId !== record.holdId) continue
      const sessionId = RemoteSessionId(candidate.sessionId)
      const sessionSubs = this.subscribersBySession.get(sessionId)
      if (sessionSubs === undefined || sessionSubs.size === 0) continue
      const event: RemoteHostdWsEvent = {
        type: 'journal.gap',
        sessionId,
        droppedThrough: 0,
        generation: candidate.generation,
      }
      const payload = JSON.stringify({ direction: 'push', seq: ++this.pushSeq, event } satisfies RemoteHostdWsFrame)
      for (const subscriber of sessionSubs.values()) {
        if (subscriber.ws.readyState === WS_OPEN) subscriber.ws.send(payload)
      }
    }
  }

  private fanoutPage(record: HostdSessionRecord, page: RemoteJournalPage): void {
    const sessionSubs = this.subscribersBySession.get(RemoteSessionId(record.sessionId))
    if (sessionSubs === undefined || sessionSubs.size === 0) return
    const subscribers = [...sessionSubs.values()]
    const event: RemoteHostdWsEvent = {
      type: 'journal.page',
      sessionId: RemoteSessionId(record.sessionId),
      page,
      subscribers: subscribers.length,
    }
    const frame: RemoteHostdWsFrame = { direction: 'push', seq: ++this.pushSeq, event }
    const payload = JSON.stringify(frame)
    for (const subscriber of subscribers) {
      subscriber.lastSeq = page.latestSeq
      if (subscriber.ws.readyState === WS_OPEN) subscriber.ws.send(payload)
    }
  }

  private sendTo(ws: WebSocket, frame: RemoteHostdWsFrame): void {
    if (ws.readyState !== WS_OPEN) return
    ws.send(JSON.stringify(frame))
  }

  private sendHeartbeats(): void {
    for (const ws of this.wss.clients) {
      if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ direction: 'ping' }))
    }
  }
}

function holdSocketDead(error: unknown): boolean {
  return /ECONNREFUSED|ENOENT|EPIPE|ENOTSOCK|ECONNRESET/i
    .test(error instanceof Error ? error.message : String(error))
}

function wsText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return ''
}
