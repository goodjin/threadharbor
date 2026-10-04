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
 *  A single per-session waiter (`holdRequest('wait-page')`) feeds all subscribers
 *  of that session, eliminating the poll fallback. Waiters are keyed by *session*,
 *  not by hold: with a shared Agent connection, several sessions no longer share a
 *  process, and keying by hold made the first subscriber's record stand in for the
 *  rest — so a second session bound to the same Agent got no frames of its own.
 */

import type http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  REMOTE_AGENT_HOSTD_WS_PATH,
  parseHostdWsFrame,
  RemoteSessionId,
  type JsonValue,
  type RemoteHostdMethod,
  type RemoteHostdSessionStartStage,
  type RemoteHostdWsEvent,
  type RemoteHostdWsFrame,
  type RemoteJournalPage,
} from '@threadharbor/protocol'
import type { HostdSessionResponse } from './agent-protocol.ts'
import type { HostdSessionRecord, RemoteAgentHostd } from './server.ts'

/** WS_OPEN is the only readyState where we may send frames. */
const WS_OPEN = 1

/** Whether an error means this session's Agent connection is not running, which
 *  is the in-process equivalent of the old "hold socket is dead" check. */
function bridgeGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no running \w+ bridge/.test(message) || /unknown agent session/.test(message)
}

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

/** Per-session waiter driver state. */
interface PerSessionWaiter {
  readonly record: HostdSessionRecord
  readonly abort: AbortController
}

/** Persistent hostd WebSocket fan-out: RPC multiplexing, single-waiter-per-hold push, heartbeat. */
export class HostdWsHub {
  private readonly wss: WebSocketServer
  private readonly waiters = new Map<RemoteSessionId, PerSessionWaiter>()
  private readonly subscribersBySession = new Map<RemoteSessionId, Map<WebSocket, Subscriber>>()
  private readonly socketToSessions = new WeakMap<WebSocket, Set<RemoteSessionId>>()
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

  /** Per-session waiter map (test seam). */
  waitersForTesting(): Map<RemoteSessionId, PerSessionWaiter> {
    return this.waiters
  }

  private registerConnection(ws: WebSocket): void {
    ws.on('message', (data) => { void this.handleClientMessage(ws, data) })
    ws.on('close', () => { this.handleSocketClose(ws) })
    ws.on('error', () => { /* swallow; the close handler cleans up */ })
  }

  /** Drop all in-memory state for one session; called when it is released or restarted. */
  forgetSession(sessionId: RemoteSessionId): void {
    const waiter = this.waiters.get(sessionId)
    if (waiter !== undefined) {
      waiter.abort.abort()
      this.waiters.delete(sessionId)
    }
    const sessionSubs = this.subscribersBySession.get(sessionId)
    if (sessionSubs === undefined) return
    for (const subscriber of sessionSubs.values()) {
      subscriber.ws.close(1011, `session ${sessionId} dropped`)
    }
    sessionSubs.clear()
    this.subscribersBySession.delete(sessionId)
  }

  private async handleClientMessage(ws: WebSocket, data: unknown): Promise<void> {
    const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8')
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
    // Relay fine-grained session.start progress to the requesting gateway
    // before the final response arrives (only session.start emits stages).
    const onProgress = (stage: RemoteHostdSessionStartStage, sessionId: string, message: string): void => {
      if (ws.readyState !== WS_OPEN) return
      const sessionIdBranded = RemoteSessionId(sessionId)
      const event: RemoteHostdWsEvent = {
        type: 'session.start.progress',
        requestId: id,
        sessionId: sessionIdBranded,
        stage,
        message,
      }
      reply({ direction: 'push', seq: ++this.pushSeq, event })
    }
    try {
      const result = await this.hostd.dispatch({ id, method, params }, method === 'session.start' ? onProgress : undefined)
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
    this.ensureWaiter(record)
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

  private ensureWaiter(record: HostdSessionRecord): void {
    const sessionId = RemoteSessionId(record.sessionId)
    if (this.waiters.has(sessionId)) return
    const abort = new AbortController()
    const waiter: PerSessionWaiter = { record, abort }
    this.waiters.set(sessionId, waiter)
    void this.runWaiter(waiter)
  }

  private stopWaiterIfEmpty(sessionId: RemoteSessionId): void {
    if (this.sessionHasSubscribers(sessionId)) return
    const waiter = this.waiters.get(sessionId)
    if (waiter === undefined) return
    waiter.abort.abort()
    this.waiters.delete(sessionId)
  }

  /**
   * Whether any browser still streams this session. The idle reaper consults
   * this so a session someone is actively watching is never reclaimed underneath
   * them, even if no new prompt has been sent for a while.
   */
  sessionHasSubscribers(sessionId: RemoteSessionId): boolean {
    return (this.subscribersBySession.get(sessionId)?.size ?? 0) > 0
  }

  private holdGenerationChanged(record: HostdSessionRecord, generation: string): boolean {
    return record.generation !== generation
  }

  private async runWaiter(waiter: PerSessionWaiter): Promise<void> {
    const { record, abort } = waiter
    const sessionId = RemoteSessionId(record.sessionId)
    let afterSeq = this.minLastSeqForSession(sessionId)
    while (!abort.signal.aborted) {
      const subscriberCount = this.subscribersFor(record).size
      if (subscriberCount === 0) {
        this.waiters.delete(sessionId)
        return
      }
      try {
        let response: HostdSessionResponse
        try {
          response = await this.hostd.holdRequest(
            record,
            {
              operation: 'wait-page',
              afterSeq,
              timeoutMs: this.options.waitTimeoutMs,
              generation: record.generation,
            },
            abort.signal,
          )
        } catch {
          if (abort.signal.aborted) return
          await this.hostd.holdRequest(
            record,
            { operation: 'wait-seq', afterSeq, timeoutMs: this.options.waitTimeoutMs },
            abort.signal,
          )
          response = await this.hostd.holdRequest(
            record,
            { operation: 'read', afterSeq, generation: record.generation },
            abort.signal,
          )
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
        if (bridgeGone(error)) this.fanoutBridgeGone(record)
        this.waiters.delete(sessionId)
        return
      }
    }
  }

  private minLastSeqForSession(sessionId: RemoteSessionId): number {
    const sessionSubs = this.subscribersBySession.get(sessionId)
    if (sessionSubs === undefined) return 0
    let min = Number.POSITIVE_INFINITY
    for (const subscriber of sessionSubs.values()) {
      if (subscriber.lastSeq < min) min = subscriber.lastSeq
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

  /**
   * Tell the gateway this session's Agent connection is gone, so it can leave the
   * session `running` and re-attach rather than waiting for frames that will
   * never come.
   */
  private fanoutBridgeGone(record: HostdSessionRecord): void {
    const sessionId = RemoteSessionId(record.sessionId)
    const sessionSubs = this.subscribersBySession.get(sessionId)
    if (sessionSubs === undefined || sessionSubs.size === 0) return
    const event: RemoteHostdWsEvent = {
      type: 'journal.gap',
      sessionId,
      droppedThrough: 0,
      generation: record.generation,
    }
    const payload = JSON.stringify({ direction: 'push', seq: ++this.pushSeq, event } satisfies RemoteHostdWsFrame)
    for (const subscriber of sessionSubs.values()) {
      if (subscriber.ws.readyState === WS_OPEN) subscriber.ws.send(payload)
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
