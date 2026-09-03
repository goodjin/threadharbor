/** Single-host persistent WebSocket to a hostd daemon.
 *
 *  One `HostdConnection` per `RemoteHostId`. Replaces the legacy per-RPC
 *  `fetch POST /v1/control` with a multiplexed WS that carries:
 *
 *    - request/response RPCs (id-correlated),
 *    - subscribe/unsubscribe for journal push,
 *    - server-initiated `journal.page` and `journal.gap` pushes,
 *    - ping/pong heartbeats.
 *
 *  The connection auto-reconnects with the standard
 *  `BACKOFF_STEPS_MS = [500, 1_000, 2_000, 5_000, 10_000]` ladder, fan-outs
 *  every queued RPC and resubscribes every tracked session on the next open.
 *
 *  This client intentionally never falls back to HTTP `/v1/control`; an older
 *  hostd simply looks "unreachable" and the gateway's caller surfaces the
 *  reconnect attempt (and the SSH tunnel path).
 */

import { WebSocket } from 'ws'
import {
  REMOTE_AGENT_HOSTD_WS_PATH,
  RemoteSessionId,
  parseHostdWsFrame,
  type JsonValue,
  type RemoteHostdMethod,
  type RemoteHostdWsEvent,
  type RemoteHostdWsFrame,
} from '@threadharbor/protocol'

/** Stable WebSocket-only endpoint derived from an HTTP endpoint. */
function wsEndpoint(httpEndpoint: string): string {
  const trimmed = httpEndpoint.replace(/\/$/, '')
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return trimmed
  return trimmed.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://')
}

/** Reconnect ladder; matches the cordis-client `ws-transport.ts` default. */
export const HOSTD_BACKOFF_STEPS_MS: readonly number[] = [500, 1_000, 2_000, 5_000, 10_000]

//** Tunables for the connection. Injected for tests. */
export interface HostdConnectionOptions {
  readonly endpoint: string
  readonly requestTimeoutMs: number
  readonly heartbeatMs: number
  readonly reconnectStepsMs: readonly number[]
  readonly handshakeTimeoutMs: number
  /** Override the WebSocket constructor (used by tests to inject a fake). */
  readonly socketFactory?: (url: string) => WebSocket
}

/** Per-session subscription entry. */
interface Subscription {
  readonly sessionId: RemoteSessionId
  readonly generation: string
  listener: (event: RemoteHostdWsEvent) => void
  lastSeq: number
  subscribed: boolean
}

/** Resolver for one in-flight RPC. */
interface PendingRequest {
  readonly resolve: (result: JsonValue) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
  readonly method: RemoteHostdMethod
  readonly params: Record<string, JsonValue>
}

/** Connection-level push sink used by tests. */
export type ConnectionListener = (event: 'open' | 'close' | 'error' | 'reconnect') => void

/** Persistent hostd WebSocket client: multiplexed RPC, session push, reconnect ladder, heartbeat. */
export class HostdConnection {
  private ws: WebSocket | undefined
  private state: 'connecting' | 'open' | 'closed' = 'closed'
  private nextId = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly subscriptions = new Map<RemoteSessionId, Subscription>()
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private pongTimer: NodeJS.Timeout | undefined
  private closed = false
  private readonly connectionListeners = new Set<ConnectionListener>()

  constructor(readonly options: HostdConnectionOptions) {}

  /** Open the underlying WS. Idempotent. */
  open(): void {
    if (this.closed) return
    if (this.state !== 'closed') return
    this.connect()
  }

  /** Close the underlying WS, reject pending requests, and stop reconnecting. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.clearHeartbeat()
    this.state = 'closed'
    const ws = this.ws
    this.ws = undefined
    if (ws !== undefined) {
      ws.removeAllListeners()
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'hostd connection closed')
      }
    }
    this.failPending(new Error('hostd connection closed'))
  }

  /** Issue one RPC and await its result. Throws on timeout or remote error. */
  async request(method: RemoteHostdMethod, params: Record<string, JsonValue>): Promise<JsonValue> {
    if (this.closed) throw new Error('hostd connection is closed')
    if (this.state === 'closed') this.open()
    const id = this.allocateId()
    const frame: RemoteHostdWsFrame = { direction: 'request', id, method, params }
    return await new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`hostd request ${method} timed out`))
      }, this.options.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer, method, params })
      this.send(frame)
    })
  }

  /** Subscribe a session. Returns an unsubscribe function. */
  subscribe(
    sessionId: RemoteSessionId,
    generation: string,
    lastSeq: number,
    listener: (event: RemoteHostdWsEvent) => void,
  ): () => void {
    const existing = this.subscriptions.get(sessionId)
    if (existing !== undefined) {
      existing.listener = listener
      existing.lastSeq = lastSeq
      if (this.state === 'open') this.sendSubscribe(existing)
      return () => this.unsubscribe(sessionId)
    }
    const sub: Subscription = { sessionId, generation, listener, lastSeq, subscribed: false }
    this.subscriptions.set(sessionId, sub)
    if (this.state === 'open') this.sendSubscribe(sub)
    return () => this.unsubscribe(sessionId)
  }

  /** Number of in-flight requests; useful for tests. */
  pendingCount(): number {
    return this.pending.size
  }

  /** Number of active subscriptions; useful for tests. */
  subscriptionCount(): number {
    return this.subscriptions.size
  }

  /** Current connection state; useful for tests. */
  currentState(): 'connecting' | 'open' | 'closed' {
    return this.state
  }

  /** Subscribe to connection-level lifecycle events. */
  onConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  private unsubscribe(sessionId: RemoteSessionId): void {
    const sub = this.subscriptions.get(sessionId)
    if (sub === undefined) return
    if (this.state === 'open' && sub.subscribed) {
      const frame: RemoteHostdWsFrame = { direction: 'unsubscribe', sessionId }
      this.send(frame)
    }
    this.subscriptions.delete(sessionId)
  }

  private allocateId(): string {
    this.nextId += 1
    return `r${this.nextId}`
  }

  private send(frame: RemoteHostdWsFrame): boolean {
    const ws = this.ws
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(frame))
    return true
  }

  private sendSubscribe(sub: Subscription): void {
    const frame: RemoteHostdWsFrame = {
      direction: 'subscribe',
      sessionId: sub.sessionId,
      generation: sub.generation,
      lastSeq: sub.lastSeq,
    }
    if (this.send(frame)) sub.subscribed = true
  }

  private connect(): void {
    if (this.state !== 'closed') return
    this.state = 'connecting'
    this.emitLifecycle('reconnect')
    const url = `${wsEndpoint(this.options.endpoint)}${REMOTE_AGENT_HOSTD_WS_PATH}`
    const ws = this.options.socketFactory
      ? this.options.socketFactory(url)
      : new WebSocket(url, { handshakeTimeout: this.options.handshakeTimeoutMs })
    this.ws = ws
    const onOpen = (): void => {
      this.state = 'open'
      this.reconnectAttempts = 0
      this.emitLifecycle('open')
      this.startHeartbeat()
      for (const sub of this.subscriptions.values()) this.sendSubscribe(sub)
      this.flushPending()
    }
    const onMessage = (data: unknown): void => {
      void this.handleMessage(data)
    }
    const onClose = (): void => {
      this.handleSocketGone('close')
    }
    const onError = (error: unknown): void => {
      this.emitLifecycle('error')
      void error
    }
    ws.once('open', onOpen)
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onError)
  }

  private handleSocketGone(_cause: 'close'): void {
    this.clearHeartbeat()
    const wasOpen = this.state === 'open'
    this.state = 'closed'
    this.ws = undefined
    for (const sub of this.subscriptions.values()) sub.subscribed = false
    // Pending requests are NOT rejected here; they will be re-sent on the next
    // open via flushPending(), or rejected by the explicit `close()` path or
    // their per-request timeout.
    this.emitLifecycle('close')
    if (this.closed) return
    if (!wasOpen && this.reconnectAttempts === 0) {
      // First failure: do not delay before retrying so a fresh hostd start is seen quickly.
      void this.scheduleReconnect(0)
      return
    }
    void this.scheduleReconnect(this.nextBackoff())
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.closed) return
    if (this.reconnectTimer !== undefined) return
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delayMs)
  }

  private nextBackoff(): number {
    const ladder = this.options.reconnectStepsMs
    const index = Math.min(this.reconnectAttempts, ladder.length - 1)
    return ladder[index] ?? ladder[ladder.length - 1] ?? 1000
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'open') return
      this.send({ direction: 'ping' })
      this.pongTimer = setTimeout(() => {
        const ws = this.ws
        if (ws !== undefined && ws.readyState === WebSocket.OPEN) ws.terminate()
      }, this.options.heartbeatMs)
    }, this.options.heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.pongTimer !== undefined) {
      clearTimeout(this.pongTimer)
      this.pongTimer = undefined
    }
  }

  private failPending(reason: Error): void {
    if (this.pending.size === 0) return
    const inflight = [...this.pending.values()]
    this.pending.clear()
    for (const entry of inflight) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
  }

  private flushPending(): void {
    if (this.pending.size === 0) return
    const inflight = [...this.pending.entries()]
    for (const [id, entry] of inflight) {
      const frame: RemoteHostdWsFrame = { direction: 'request', id, method: entry.method, params: entry.params }
      if (this.state === 'open') this.send(frame)
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text = wsText(data)
    if (text === '') return
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return }
    let frame: RemoteHostdWsFrame
    try { frame = parseHostdWsFrame(parsed) } catch { return }
    if (frame.direction === 'pong') {
      if (this.pongTimer !== undefined) {
        clearTimeout(this.pongTimer)
        this.pongTimer = undefined
      }
      return
    }
    if (frame.direction === 'ping') {
      this.send({ direction: 'pong' })
      return
    }
    if (frame.direction === 'push') {
      this.fanoutPush(frame.seq, frame.event)
      return
    }
    if (frame.direction === 'response') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.ok) pending.resolve(frame.result)
      else pending.reject(new Error(frame.error.message))
      return
    }
  }

  private fanoutPush(_seq: number, event: RemoteHostdWsEvent): void {
    if (event.type === 'journal.page') {
      const sessionSubs = this.subscriptions.get(event.sessionId)
      if (sessionSubs !== undefined) {
        sessionSubs.lastSeq = event.page.latestSeq
        sessionSubs.listener(event)
      }
      return
    }
    if (event.type === 'journal.gap') {
      const sessionSubs = this.subscriptions.get(event.sessionId)
      if (sessionSubs !== undefined) {
        sessionSubs.listener(event)
      }
      return
    }
  }

  private emitLifecycle(event: 'open' | 'close' | 'error' | 'reconnect'): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(event)
      } catch {
        // listener errors must never break the connection
      }
    }
  }
}

function wsText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return ''
}