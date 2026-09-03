/** Browser-side WebSocket transport. HTTP is only used to rebuild `state` while reconnecting. */

import {
  REMOTE_AGENT_GATEWAY_PATH,
  REMOTE_AGENT_GATEWAY_WS_PATH,
  jsonObject,
  stringField,
  type JsonValue,
} from '@threadharbor/protocol'

/** Phase reported by the transport so the UI can render a connection indicator. */
export type TransportPhase = 'connecting' | 'live' | 'reconnecting' | 'closed'

/** Push event delivered to the snapshot via consume. */
export interface WsPushFrame {
  readonly seq: number
  readonly event: JsonValue
}

/** Optional event sink; receive every parsed server-initiated push. */
export type PushSink = (frame: WsPushFrame) => void

/** Optional phase sink; receives phase changes for UI indicators. */
export type PhaseSink = (phase: TransportPhase) => void

/** Pending request awaiting its response frame. */
interface PendingRequest {
  readonly method: string
  readonly resolve: (result: JsonValue) => void
  readonly reject: (error: Error) => void
}

const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 75_000
const LIVE_WAIT_MS = 5_000
const BACKOFF_STEPS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const

/** Build the WebSocket URL for the gateway control channel. */
function buildWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${REMOTE_AGENT_GATEWAY_WS_PATH}`
}

/** Identify the browser on the upgrade request and opt into compatible batch pushes. */
function browserWsUrl(url: string, browserId: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set('browserId', browserId)
  parsed.searchParams.set('capabilities', 'transcript.batch')
  return parsed.toString()
}

/** Local decoded shape; we do not import RemoteGatewayWsFrame because the wire event payload
 *  is opaque (entry: RemoteTranscriptEntry is not assignable to JsonValue in TS). */
type DecodedFrame =
  | { readonly direction: 'push'; readonly seq: number; readonly event: JsonValue }
  | { readonly direction: 'response'; readonly id: string; readonly ok: true; readonly result: JsonValue }
  | { readonly direction: 'response'; readonly id: string; readonly ok: false; readonly message: string }

/** Decode one frame or null on parse failure. */
function decodeFrame(raw: string): DecodedFrame | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  try {
    const record = jsonObject(parsed, 'ws frame')
    const direction = record['direction']
    if (direction === 'push') {
      const seq = record['seq']
      if (typeof seq !== 'number') return null
      const event = record['event']
      if (event === undefined) return null
      return { direction: 'push', seq, event: event as JsonValue }
    }
    if (direction === 'response') {
      const id = stringField(record, 'id')
      const ok = record['ok']
      if (ok === true) return { direction: 'response', id, ok: true, result: (record['result'] ?? null) as JsonValue }
      if (ok === false) {
        const error = jsonObject(record['error'], 'response error')
        const message = stringField(error, 'message')
        return { direction: 'response', id, ok: false, message }
      }
      return null
    }
    return null
  } catch {
    return null
  }
}

/** Encode a request frame ready for the wire. */
function encodeRequest(id: string, method: string, params: Record<string, JsonValue>): string {
  return JSON.stringify({ direction: 'request', id, method, params })
}

/** Record the highest transcript seq seen in a push event, if the event names a session. */
function rememberSeq(target: Record<string, number>, event: JsonValue): void {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return
  const sessionId = event['sessionId']
  const seq = event['seq']
  const toSeq = event['toSeq']
  const candidate = typeof seq === 'number' && Number.isFinite(seq)
    ? seq
    : typeof toSeq === 'number' && Number.isFinite(toSeq)
      ? toSeq
      : undefined
  if (typeof sessionId !== 'string' || sessionId === '' || candidate === undefined) return
  const current = target[sessionId]
  if (current === undefined || candidate > current) target[sessionId] = candidate
}

/** Read or mint a stable browserId stored in localStorage. */
function readBrowserId(): string {
  const key = 'dsh.remote-agent.browser-id'
  const existing = window.localStorage.getItem(key)
  if (existing !== null && existing !== '') return existing
  const minted = crypto.randomUUID()
  window.localStorage.setItem(key, minted)
  return minted
}

/** One-shot HTTP POST used only to rebuild catalog `state` while the socket is down. */
async function httpRebuildState(params: Record<string, JsonValue>): Promise<JsonValue> {
  const id = crypto.randomUUID()
  const response = await fetch(REMOTE_AGENT_GATEWAY_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, method: 'state', params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const raw: unknown = await response.json()
  const record = jsonObject(raw, 'remote-agent response')
  if (record['id'] !== id) throw new Error('remote-agent response id did not match request')
  if (record['ok'] !== true) {
    const error = jsonObject(record['error'], 'remote-agent error')
    throw new Error(stringField(error, 'message'))
  }
  const result = record['result']
  if (result === undefined) throw new Error('remote-agent response omitted result')
  return result
}

/** Browser-side WebSocket transport. Live RPCs and pushes share one socket. */
export class WsTransport {
  private socket: WebSocket | undefined
  private pending = new Map<string, PendingRequest>()
  private phase: TransportPhase = 'connecting'
  private attempt = 0
  private reconnectTimer: number | undefined
  private heartbeatTimer: number | undefined
  private heartbeatTimeoutTimer: number | undefined
  private readonly browserId: string
  private readonly url: string
  private closed = false
  private readonly sinks: { push: PushSink[]; phase: PhaseSink[] } = { push: [], phase: [] }
  private readonly followSessions = new Set<string>()
  private readonly lastSeenSeqs: Record<string, number> = {}

  constructor(options?: { browserId?: string; url?: string }) {
    this.browserId = options?.browserId ?? readBrowserId()
    this.url = browserWsUrl(options?.url ?? buildWsUrl(), this.browserId)
  }

  /** Current connection phase. */
  getPhase(): TransportPhase {
    return this.phase
  }

  /** Stable browser id used by the gateway to scope follow sets and unread counts. */
  getBrowserId(): string {
    return this.browserId
  }

  /** Subscribe to push frames delivered over the WS channel. */
  onPush(sink: PushSink): () => void {
    this.sinks.push.push(sink)
    return () => { this.sinks.push = this.sinks.push.filter(entry => entry !== sink) }
  }

  /** Subscribe to connection-phase changes. */
  onPhase(sink: PhaseSink): () => void {
    this.sinks.phase.push(sink)
    sink(this.phase)
    return () => { this.sinks.phase = this.sinks.phase.filter(entry => entry !== sink) }
  }

  /** Subscribe a session; subsequent transcript frames flow into the snapshot. */
  follow(sessionId: string): void {
    this.followSessions.add(sessionId)
    if (this.phase === 'live') {
      void this.call('session.follow', { browserId: this.browserId, sessionId }).catch(() => undefined)
    }
  }

  /** Stop pushing transcript frames for this session. */
  unfollow(sessionId: string): void {
    this.followSessions.delete(sessionId)
    if (this.phase === 'live') void this.call('session.unfollow', { browserId: this.browserId, sessionId }).catch(() => undefined)
  }

  /** Follow at most one session; used when the visible conversation changes. */
  followOnly(sessionId: string | undefined): void {
    for (const existing of [...this.followSessions]) {
      if (existing !== sessionId) this.unfollow(existing)
    }
    if (sessionId !== undefined && !this.followSessions.has(sessionId)) this.follow(sessionId)
  }

  /** Open the WebSocket and start the reconnect loop. */
  connect(): void {
    if (this.closed) return
    this.open()
  }

  /** Send a control request on the live socket.
   *  `state` may rebuild over HTTP while reconnecting; every other method waits for WS. */
  async call(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    if (this.closed) throw new Error('transport closed')
    if (method === 'state' && this.phase !== 'live') return httpRebuildState(params)
    if (this.phase !== 'live' || this.socket === undefined) {
      await this.waitForLive(LIVE_WAIT_MS)
    }
    return await new Promise<JsonValue>((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`request ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        method,
        resolve: (result) => { window.clearTimeout(timer); resolve(result) },
        reject: (error) => { window.clearTimeout(timer); reject(error) },
      })
      try {
        this.socket?.send(encodeRequest(id, method, params))
      } catch (error) {
        this.pending.delete(id)
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Stop timers, close the socket, and freeze the phase. */
  close(): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    if (this.heartbeatTimer !== undefined) { window.clearTimeout(this.heartbeatTimer); this.heartbeatTimer = undefined }
    if (this.heartbeatTimeoutTimer !== undefined) { window.clearTimeout(this.heartbeatTimeoutTimer); this.heartbeatTimeoutTimer = undefined }
    if (this.socket !== undefined) {
      try { this.socket.close() } catch { /* noop */ }
      this.socket = undefined
    }
    this.rejectPending(new Error('transport closed'))
    this.setPhase('closed')
  }

  private open(): void {
    if (this.closed) return
    this.setPhase(this.attempt === 0 ? 'connecting' : 'reconnecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      this.attempt = 0
      this.setPhase('live')
      this.sendHello()
      this.armHeartbeat()
      for (const sessionId of this.followSessions) {
        void this.call('session.follow', { browserId: this.browserId, sessionId }).catch(() => undefined)
      }
    })
    socket.addEventListener('message', (event) => {
      this.armHeartbeat()
      const raw = typeof event.data === 'string' ? event.data : ''
      if (raw.includes('"direction":"pong"')) return
      const frame = decodeFrame(raw)
      if (frame === null) return
      if (frame.direction === 'response') {
        const pending = this.pending.get(frame.id)
        if (pending === undefined) return
        this.pending.delete(frame.id)
        if (frame.ok) pending.resolve(frame.result)
        else pending.reject(new Error(frame.message))
        return
      }
      if (frame.direction === 'push') {
        rememberSeq(this.lastSeenSeqs, frame.event)
        for (const sink of this.sinks.push) sink({ seq: frame.seq, event: frame.event })
      }
    })
    socket.addEventListener('close', () => this.scheduleReconnect())
    socket.addEventListener('error', () => { /* close will follow */; })
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    if (this.heartbeatTimer !== undefined) { window.clearTimeout(this.heartbeatTimer); this.heartbeatTimer = undefined }
    if (this.heartbeatTimeoutTimer !== undefined) { window.clearTimeout(this.heartbeatTimeoutTimer); this.heartbeatTimeoutTimer = undefined }
    if (this.socket !== undefined) { this.socket = undefined }
    this.rejectPending(new Error('实时通道已断开，正在重连'))
    if (this.reconnectTimer !== undefined) return
    this.setPhase('reconnecting')
    const delay = BACKOFF_STEPS_MS[Math.min(this.attempt, BACKOFF_STEPS_MS.length - 1)] ?? 10_000
    this.attempt += 1
    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = undefined; this.open() }, delay)
  }

  private rejectPending(reason: Error): void {
    if (this.pending.size === 0) return
    const inflight = [...this.pending.values()]
    this.pending.clear()
    for (const entry of inflight) entry.reject(reason)
  }

  private setPhase(next: TransportPhase): void {
    if (this.phase === next) return
    this.phase = next
    for (const sink of this.sinks.phase) sink(next)
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) window.clearTimeout(this.heartbeatTimer)
    if (this.heartbeatTimeoutTimer !== undefined) {
      window.clearTimeout(this.heartbeatTimeoutTimer)
      this.heartbeatTimeoutTimer = undefined
    }
    this.heartbeatTimer = window.setTimeout(() => {
      this.heartbeatTimer = undefined
      try { this.socket?.send(JSON.stringify({ direction: 'ping' })) } catch { /* socket will close */ }
      this.heartbeatTimeoutTimer = window.setTimeout(() => {
        try { this.socket?.close() } catch { /* noop */ }
      }, HEARTBEAT_TIMEOUT_MS)
    }, HEARTBEAT_INTERVAL_MS)
  }

  private sendHello(): void {
    void this.call('browser.hello', { browserId: this.browserId, lastSeenSeqs: { ...this.lastSeenSeqs } }).catch(() => undefined)
  }

  private waitForLive(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.phase === 'live') { resolve(); return }
      const timer = window.setTimeout(() => {
        unsubscribe()
        reject(new Error('ws did not reach live phase in time'))
      }, timeoutMs)
      const unsubscribe = this.onPhase((phase) => {
        if (phase === 'live') {
          window.clearTimeout(timer)
          unsubscribe()
          resolve()
          return
        }
        if (phase === 'closed') {
          window.clearTimeout(timer)
          unsubscribe()
          reject(new Error('transport closed'))
        }
      })
    })
  }
}
