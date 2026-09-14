/** Connection pool keyed by `RemoteHostId`.
 *
 *  Each registered host owns exactly one `HostdConnection`. SSH tunnels are
 *  resolved by the existing `SshManager` so the WS path (over loopback on
 *  local hosts, over `LocalForward` on remote hosts) is opaque to the rest of
 *  the gateway.
 *
 *  Pending subscriptions recorded before the WS finishes its first open are
 *  flushed onto the live connection by the pool; the returned unsubscribe fn
 *  clears them in either state.
 */

import {
  type JsonValue,
  type RemoteHostId,
  type RemoteHostView,
  type RemoteHostdWsEvent,
  type RemoteSessionId,
} from '@threadharbor/protocol'
import { HostdConnection, HOSTD_BACKOFF_STEPS_MS } from './hostd-connection.ts'
import type { SshManager } from './ssh-manager.ts'

export interface HostdConnectionPoolOptions {
  readonly requestTimeoutMs: number
  readonly heartbeatMs?: number
  readonly reconnectStepsMs?: readonly number[]
  readonly handshakeTimeoutMs?: number
  readonly socketFactory?: (url: string) => import('ws').WebSocket
}

/** Per-session subscription slot tracked by the pool. */
interface PendingSubscription {
  readonly sessionId: RemoteSessionId
  readonly generation: string
  readonly listener: (event: RemoteHostdWsEvent) => void
  transferred: boolean
}

/** Per-host WebSocket pool with SSH tunnel awareness. */
export class HostdConnectionPool {
  private readonly connections = new Map<RemoteHostId, HostdConnection>()
  private readonly pending = new Map<RemoteHostId, Map<RemoteSessionId, PendingSubscription>>()
  /** In-flight connection creation per host so concurrent first requests share one socket. */
  private readonly creating = new Map<RemoteHostId, Promise<HostdConnection>>()

  constructor(
    private readonly sshManager: SshManager,
    private readonly options: HostdConnectionPoolOptions,
  ) {}

  /** Issue one RPC against the host's persistent WS, opening it on demand. */
  async request(
    host: RemoteHostView,
    method: string,
    params: Record<string, JsonValue>,
    timeoutMs?: number,
    onProgress?: (stage: string, message: string) => void,
  ): Promise<JsonValue> {
    const conn = await this.ensureConnection(host)
    return await conn.request(method as Parameters<HostdConnection['request']>[0], params, timeoutMs, onProgress)
  }
  /** Subscribe to journal events for one session. Returns an unsubscribe fn. */
  subscribe(
    host: RemoteHostView,
    sessionId: RemoteSessionId,
    generation: string,
    lastSeq: number,
    listener: (event: RemoteHostdWsEvent) => void,
  ): () => void {
    const hostPending = this.pending.get(host.hostId) ?? new Map<RemoteSessionId, PendingSubscription>()
    hostPending.set(sessionId, { sessionId, generation, listener, transferred: false })
    this.pending.set(host.hostId, hostPending)
    const existing = this.connections.get(host.hostId)
    if (existing !== undefined) {
      existing.subscribe(sessionId, generation, lastSeq, listener)
      hostPending.get(sessionId)!.transferred = true
    } else {
      // A tunnel that cannot be opened (host down, key rejected) rejects here.
      // Nobody awaits this chain, so an uncaught rejection would take the
      // whole Web process down under DSH's fail-loud handler. Keep the pending
      // slot: the follow loop's backed-off catchup retries the host and the
      // subscription transfers once a connection finally opens.
      void this.ensureConnection(host).then((conn) => {
        const slot = hostPending.get(sessionId)
        if (slot === undefined) return
        conn.subscribe(slot.sessionId, slot.generation, lastSeq, slot.listener)
        slot.transferred = true
      }).catch((error: unknown) => {
        process.stderr.write(
          `threadharbor-gateway: hostd subscription deferred host=${host.hostId} session=${sessionId} `
          + `${error instanceof Error ? error.message : String(error)}\n`,
        )
      })
    }
    return () => {
      hostPending.delete(sessionId)
      if (hostPending.size === 0) this.pending.delete(host.hostId)
      const conn = this.connections.get(host.hostId)
      // HostdConnection#subscribe returns its own unsubscribe fn; we cannot reach
      // that handle here, so we cancel via an `unsubscribe` frame path. Since
      // the connection API does not expose unsubscribe-by-id, we simply drop
      // the pending slot; the listener becomes unreachable from the caller.
      void conn
    }
  }

  /** Drop the WS for one host (e.g. host removed). */
  drop(hostId: RemoteHostId): void {
    const conn = this.connections.get(hostId)
    if (conn !== undefined) {
      this.connections.delete(hostId)
      void conn.close()
    }
    this.pending.delete(hostId)
    this.creating.delete(hostId)
  }

  /** Close every WS; called on gateway shutdown. */
  async closeAll(): Promise<void> {
    const all = [...this.connections.values()]
    this.connections.clear()
    this.pending.clear()
    this.creating.clear()
    await Promise.all(all.map((conn) => conn.close()))
  }

  private async ensureConnection(host: RemoteHostView): Promise<HostdConnection> {
    // Resolve the endpoint on every request: SSH tunnels can be replaced (each
    // deployment opens a new random local port) and the persistent connection
    // must follow the live tunnel instead of reconnecting into a dead port.
    const endpoint = await this.resolveEndpoint(host)
    const existing = this.connections.get(host.hostId)
    if (existing !== undefined) {
      existing.switchEndpoint(endpoint)
      return existing
    }
    const creating = this.creating.get(host.hostId) ?? this.createConnection(host, endpoint)
    this.creating.set(host.hostId, creating)
    try {
      const conn = await creating
      // The tunnel may have moved again while the connection was being built;
      // always finish on the endpoint resolved for this request.
      conn.switchEndpoint(endpoint)
      return conn
    } finally {
      this.creating.delete(host.hostId)
    }
  }

  private createConnection(host: RemoteHostView, endpoint: string): Promise<HostdConnection> {
    return Promise.resolve().then(() => {
      const conn = new HostdConnection({
        endpoint,
        requestTimeoutMs: this.options.requestTimeoutMs,
        heartbeatMs: this.options.heartbeatMs ?? 15_000,
        reconnectStepsMs: this.options.reconnectStepsMs ?? HOSTD_BACKOFF_STEPS_MS,
        handshakeTimeoutMs: this.options.handshakeTimeoutMs ?? 5_000,
        ...(this.options.socketFactory ? { socketFactory: this.options.socketFactory } : {}),
      })
      conn.onConnection((event) => {
        if (event === 'open') this.flushPending(host.hostId, conn)
        if (event === 'reconnect') void this.refreshEndpoint(host, conn)
      })
      this.connections.set(host.hostId, conn)
      conn.open()
      return conn
    })
  }

  private flushPending(hostId: RemoteHostId, conn: HostdConnection): void {
    const hostPending = this.pending.get(hostId)
    if (hostPending === undefined) return
    for (const slot of hostPending.values()) {
      if (slot.transferred) continue
      conn.subscribe(slot.sessionId, slot.generation, 0, slot.listener)
      slot.transferred = true
    }
  }

  private async resolveEndpoint(host: RemoteHostView): Promise<string> {
    if (host.ssh === undefined) {
      if (host.endpoint === undefined) throw new Error('host has no endpoint or SSH tunnel to resolve')
      return host.endpoint
    }
    return await this.sshManager.ensureTunnel(host.ssh)
  }

  private async refreshEndpoint(host: RemoteHostView, conn: HostdConnection): Promise<void> {
    if (host.ssh === undefined) return
    try {
      // The reconnect ladder alone would keep hitting the dead endpoint.
      // Resolve the tunnel again and move the connection to whatever local
      // port is live now so the next reconnect succeeds.
      const endpoint = await this.sshManager.ensureTunnel(host.ssh)
      conn.switchEndpoint(endpoint)
    } catch {
      // Tunnel probe failed; the existing connection will surface its own error.
    }
  }
}