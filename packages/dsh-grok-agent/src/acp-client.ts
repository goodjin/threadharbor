/**
 * Minimal ACP client for one `grok agent serve` process.
 *
 * The transport is a loopback WebSocket whose URL carries the secret as
 * `server-key`; there is no Authorization header handshake. That detail is
 * only visible from a real serve process, so it is encoded here once.
 */

/** One JSON-RPC frame in either direction. */
export type AcpFrame = {
  readonly jsonrpc?: string
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

export type AcpSession = {
  readonly sessionId: string
  readonly models: {
    readonly currentModelId: string
    readonly availableModels: readonly {
      readonly modelId: string
      readonly name: string
      readonly description?: string
      readonly _meta?: Record<string, unknown>
    }[]
  }
}

export type AcpClientOptions = {
  readonly bind: string
  readonly secret: string
  readonly command?: string
}

/** Resolve a pending RPC by id. */
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/**
 * A connected Grok ACP agent.
 *
 * Notified frames arrive through `onNotification`; RPC replies resolve the
 * caller's own promise. Turn completion for Grok arrives as a response to
 * `session/prompt`, so the caller drives settlement off the promise, not off
 * a separate notification.
 */
export class GrokAcpClient {
  private socket: WebSocket | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private sessionId: string | undefined

  private readonly options: AcpClientOptions

  constructor(options: AcpClientOptions) {
    this.options = options
  }

  onNotification: (frame: AcpFrame) => void = () => {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /** Open the WebSocket and complete the ACP `initialize` handshake. */
  async connect(timeoutMs = 30_000): Promise<unknown> {
    const { bind, secret } = this.options
    const hostPort = bind.includes(':') ? bind : `${bind}:2419`
    const url = `ws://${hostPort}/ws?server-key=${encodeURIComponent(secret)}`
    const socket = new WebSocket(url)
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`grok acp connect timeout: ${url}`)), timeoutMs)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => { clearTimeout(timer); reject(new Error(`grok acp connect failed: ${url}`)) }
    })

    socket.onmessage = event => this.receive(String(event.data))
    socket.onclose = () => this.failAll(new Error('grok acp connection closed'))

    return this.request('initialize', { protocolVersion: 1 })
  }

  /** Create the native agent session; its reply carries the real model list. */
  async newSession(cwd: string): Promise<AcpSession> {
    const result = await this.request('session/new', { cwd, mcpServers: [] })
    const record = (result ?? {}) as { sessionId?: unknown; models?: AcpSession['models'] }
    if (typeof record.sessionId !== 'string') throw new Error('grok acp session/new returned no sessionId')
    this.sessionId = record.sessionId
    return {
      sessionId: record.sessionId,
      models: record.models ?? { currentModelId: '', availableModels: [] },
    }
  }

  /** Submit one user turn. Resolves when Grok finishes the turn. */
  prompt(text: string, modelId?: string): Promise<unknown> {
    if (this.sessionId === undefined) throw new Error('grok acp session not started')
    const params: Record<string, unknown> = {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }
    if (modelId !== undefined) params.modelId = modelId
    return this.request('session/prompt', params)
  }

  /** Ask Grok to abandon the running turn. */
  async cancel(): Promise<void> {
    if (this.sessionId === undefined) return
    try {
      await this.request('session/cancel', { sessionId: this.sessionId })
    } catch {
      // A turn that already settled rejects cancellation; that is not a failure.
    }
  }

  close(): void {
    this.socket?.close()
    this.socket = undefined
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('grok acp not connected'))
    const id = this.nextId++
    const frame: AcpFrame = { jsonrpc: '2.0', id, method, params }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        socket.send(JSON.stringify(frame))
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private receive(raw: string): void {
    let frame: AcpFrame
    try {
      frame = JSON.parse(raw) as AcpFrame
    } catch {
      return
    }
    if (typeof frame.id === 'number' && (frame.method === undefined)) {
      const entry = this.pending.get(frame.id)
      if (entry === undefined) return
      this.pending.delete(frame.id)
      if (frame.error !== undefined) entry.reject(new Error(`grok acp ${String(frame.error)}`))
      else entry.resolve(frame.result)
      return
    }
    if (frame.method !== undefined) this.onNotification(frame)
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}