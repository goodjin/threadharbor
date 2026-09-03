/** Single-WS broadcaster and subscription tracker for the Web gateway. */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  type JsonValue,
  type RemoteGatewayWsEvent,
  type RemoteGatewayWsFrame,
  type RemoteSessionId,
  type RemoteTranscriptEntry,
} from '@threadharbor/protocol'

/** Handle one browser control request that arrived on the WebSocket. */
export type WsRequestHandler = (request: {
  readonly id: string
  readonly method: string
  readonly params: Record<string, JsonValue>
}) => Promise<JsonValue>

/** Per-connection subscriber state tracked alongside its socket. */
interface Subscriber {
  readonly ws: WebSocket
  browserId: string
  readonly followed: Set<RemoteSessionId>
  readonly supportsTranscriptBatch: boolean
}

/** Session-summary change emitted to non-following browsers for sidebar red dots. */
export interface BrowserSubscription {
  readonly browserId: string
  readonly sessionId: RemoteSessionId
  readonly action: 'follow' | 'unfollow'
}

/** Result of a hello handshake: which sessions the browser missed while disconnected. */
export interface HelloAck {
  readonly ok: true
  readonly broadcasts: readonly { readonly sessionId: RemoteSessionId; readonly fromSeq: number }[]
}

const WS_OPEN = 1

/** Routes WebSocket frames and tracks per-browser follow sets. */
export class WsBroadcaster {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly subscribers = new Map<WebSocket, Subscriber>()
  private readonly followedByBrowser = new Map<string, Set<RemoteSessionId>>()
  private pushSeq = 0
  private requestHandler: WsRequestHandler | undefined

  /** Bind the gateway dispatcher so browser WS frames can start follow/prompt loops. */
  setRequestHandler(handler: WsRequestHandler): void {
    this.requestHandler = handler
  }

  /** Complete an HTTP upgrade already accepted by `webServer.registerUpgrade`.
   * @param req - the original upgrade request, including `browserId` query.
   * @param socket - the raw TCP socket handed off by node:http.
   * @param head - leftover bytes from the handshake.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const browserId = url.searchParams.get('browserId') ?? 'anonymous'
      const capabilities = new Set((url.searchParams.get('capabilities') ?? '').split(','))
      this.registerConnection(ws, browserId, capabilities.has('transcript.batch'))
    })
  }

  /** Subscribe a session for a browser; used by both handleUpgrade() and dispatch('session.follow'). */
  follow(browserId: string, sessionId: RemoteSessionId): RemoteSessionId {
    const followed = this.followedByBrowser.get(browserId) ?? new Set<RemoteSessionId>()
    followed.add(sessionId)
    this.followedByBrowser.set(browserId, followed)
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.browserId === browserId) subscriber.followed.add(sessionId)
    }
    return sessionId
  }

  /** Stop pushing transcript frames for this browser; other subscribers are untouched. */
  unfollow(browserId: string, sessionId: RemoteSessionId): RemoteSessionId {
    this.followedByBrowser.get(browserId)?.delete(sessionId)
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.browserId === browserId) subscriber.followed.delete(sessionId)
    }
    return sessionId
  }

  /** Whether any active browser subscription is currently following this session. */
  hasFollowers(sessionId: RemoteSessionId): boolean {
    // HTTP fallback follow requests do not have a registered WS subscriber,
    // so retain the browser-scoped follow set until an explicit unfollow or
    // until the browser's last socket reports close/error.
    for (const followed of this.followedByBrowser.values()) {
      if (followed.has(sessionId)) return true
    }
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.followed.has(sessionId)) return true
    }
    return false
  }

  /** Push a server-initiated event to every subscriber.
   * @param event - server-initiated push event.
   */
  broadcast(event: RemoteGatewayWsEvent): void {
    if (event.type === 'transcript.batch') {
      this.broadcastTranscriptBatch(event.sessionId, event.entries)
      return
    }
    if (event.type === 'transcript.append') {
      this.broadcastFollowed(event.sessionId, event)
      return
    }
    this.sendAll(event)
  }

  /** Send to subscribers that have followed the given session only.
   * @param sessionId - session the frame belongs to.
   * @param event - server-initiated push event.
   */
  broadcastFollowed(sessionId: RemoteSessionId, event: RemoteGatewayWsEvent): void {
    this.sendMatching((subscriber) => subscriber.followed.has(sessionId), event)
  }

  /** Send one transcript batch to browsers following the session. */
  broadcastTranscriptBatch(sessionId: RemoteSessionId, entries: readonly RemoteTranscriptEntry[]): void {
    if (entries.length === 0) return
    if (entries.length === 1) {
      const [entry] = entries
      if (entry === undefined) return
      this.broadcastFollowed(sessionId, {
        type: 'transcript.append',
        sessionId,
        entry,
        seq: entry.seq,
      })
      return
    }
    const matching = [...this.subscribers.values()].filter(subscriber => subscriber.followed.has(sessionId))
    const batchSubscribers = matching.filter(subscriber => subscriber.supportsTranscriptBatch)
    const legacySubscribers = matching.filter(subscriber => !subscriber.supportsTranscriptBatch)
    const first = entries[0]
    const last = entries[entries.length - 1]
    if (first === undefined || last === undefined) return
    if (batchSubscribers.length > 0) {
      const event: RemoteGatewayWsEvent = {
        type: 'transcript.batch', sessionId, entries, fromSeq: first.seq, toSeq: last.seq,
      }
      const payload: RemoteGatewayWsFrame = { direction: 'push', seq: ++this.pushSeq, event }
      const json = JSON.stringify(payload)
      for (const subscriber of batchSubscribers) this.send(subscriber.ws, json)
    }
    for (const entry of entries) {
      if (legacySubscribers.length === 0) break
      const event: RemoteGatewayWsEvent = {
        type: 'transcript.append', sessionId, entry, seq: entry.seq,
      }
      const payload: RemoteGatewayWsFrame = { direction: 'push', seq: ++this.pushSeq, event }
      const json = JSON.stringify(payload)
      for (const subscriber of legacySubscribers) this.send(subscriber.ws, json)
    }
  }

  /** Send to one browser across all its open tabs. */
  sendToBrowser(browserId: string, event: RemoteGatewayWsEvent): void {
    this.sendMatching((subscriber) => subscriber.browserId === browserId, event)
  }

  /** Count active subscribers; useful for tests and graceful shutdown. */
  size(): number {
    return this.subscribers.size
  }

  /** Register a raw socket for a given browser; only used by tests. */
  registerForTesting(ws: WebSocket, browserId: string, supportsTranscriptBatch = false): void {
    this.registerConnection(ws, browserId, supportsTranscriptBatch)
  }

  private registerConnection(ws: WebSocket, browserId: string, supportsTranscriptBatch: boolean): void {
    const subscriber: Subscriber = {
      ws,
      browserId,
      followed: new Set(this.followedByBrowser.get(browserId) ?? []),
      supportsTranscriptBatch,
    }
    this.subscribers.set(ws, subscriber)
    ws.on('message', (data) => { void this.handleClientMessage(ws, data) })
    ws.on('close', () => { this.dropConnection(ws) })
    // A peer may disappear between readyState === OPEN and send(). Without an
    // error listener ws forwards the underlying TCP EPIPE as an uncaught
    // EventEmitter error and terminates the entire Web process.
    ws.on('error', () => { this.dropConnection(ws) })
  }

  private dropConnection(ws: WebSocket): void {
    const subscriber = this.subscribers.get(ws)
    if (subscriber === undefined) return
    this.subscribers.delete(ws)
    const browserStillConnected = [...this.subscribers.values()]
      .some(candidate => candidate.browserId === subscriber.browserId)
    if (!browserStillConnected) this.followedByBrowser.delete(subscriber.browserId)
  }

  private send(ws: WebSocket, payload: string): void {
    if (ws.readyState !== WS_OPEN) return
    try {
      ws.send(payload, (error) => {
        if (error !== undefined) this.dropConnection(ws)
      })
    } catch {
      this.dropConnection(ws)
    }
  }

  private async handleClientMessage(ws: WebSocket, data: unknown): Promise<void> {
    const text = typeof data === 'string'
      ? data
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
          : ''
    if (text === '') return
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const record = parsed as Record<string, unknown>
    if (record['direction'] === 'ping') {
      this.send(ws, JSON.stringify({ direction: 'pong' }))
      return
    }
    if (record['direction'] !== 'request' || typeof record['id'] !== 'string' || typeof record['method'] !== 'string') return
    const id = record['id']
    const handler = this.requestHandler
    const reply = (frame: Record<string, unknown>): void => {
      this.send(ws, JSON.stringify(frame))
    }
    if (handler === undefined) {
      reply({ direction: 'response', id, ok: false, error: { code: 'REMOTE_AGENT_ERROR', message: 'WebSocket dispatcher is not ready' } })
      return
    }
    const params = record['params'] !== null && typeof record['params'] === 'object' && !Array.isArray(record['params'])
      ? record['params'] as Record<string, JsonValue>
      : {}
    const claimedBrowserId = params['browserId']
    if ((record['method'] === 'browser.hello' || record['method'] === 'session.follow' || record['method'] === 'session.unfollow')
      && typeof claimedBrowserId === 'string' && claimedBrowserId !== '') {
      this.rebindBrowser(ws, claimedBrowserId)
    }
    try {
      const result = await handler({ id, method: record['method'], params })
      reply({ direction: 'response', id, ok: true, result })
    } catch (error) {
      reply({
        direction: 'response', id, ok: false,
        error: { code: 'REMOTE_AGENT_ERROR', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  /** Upgrade clients opened before browserId was added to the WS URL. */
  private rebindBrowser(ws: WebSocket, browserId: string): void {
    const subscriber = this.subscribers.get(ws)
    if (subscriber === undefined || subscriber.browserId === browserId) return
    const previousBrowserId = subscriber.browserId
    subscriber.browserId = browserId
    subscriber.followed.clear()
    for (const sessionId of this.followedByBrowser.get(browserId) ?? []) subscriber.followed.add(sessionId)
    const previousStillConnected = [...this.subscribers.values()]
      .some(candidate => candidate !== subscriber && candidate.browserId === previousBrowserId)
    if (!previousStillConnected) this.followedByBrowser.delete(previousBrowserId)
  }

  private sendAll(event: RemoteGatewayWsEvent): void {
    const payload: RemoteGatewayWsFrame = { direction: 'push', seq: ++this.pushSeq, event }
    const json = JSON.stringify(payload)
    for (const subscriber of this.subscribers.values()) {
      this.send(subscriber.ws, json)
    }
  }

  private sendMatching(
    predicate: (subscriber: Subscriber) => boolean,
    event: RemoteGatewayWsEvent,
  ): void {
    const payload: RemoteGatewayWsFrame = { direction: 'push', seq: ++this.pushSeq, event }
    const json = JSON.stringify(payload)
    for (const subscriber of this.subscribers.values()) {
      if (predicate(subscriber) && subscriber.ws.readyState === WS_OPEN) {
        this.send(subscriber.ws, json)
      }
    }
  }
}
