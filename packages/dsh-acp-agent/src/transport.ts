/**
 * Line-oriented transport for ACP agents that speak JSON-RPC over stdio.
 *
 * Kept behind an interface so the client can be tested without a child process;
 * the grok agent needs a WebSocket instead, which is the other side of the same
 * interface.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createConnection, createServer } from 'node:net'

export interface AcpTransport {
  /** Write one newline-delimited JSON frame. */
  send(line: string): void
  /** Register the handler for frames arriving from the agent. */
  onLine(handler: (line: string) => void): void
  /**
   * Register the handler for the connection dying under us.
   *
   * Without this the client cannot tell "the agent is quiet" from "the agent is
   * gone", and every request in flight waits forever: a refused handshake, a
   * dropped socket and a killed child process all look identical from the
   * frame stream, which is silent in every one of those cases.
   */
  onDeath(handler: (reason: string) => void): void
  /**
   * Epoch ms of the last frame the agent sent. Frames are the smallest proof
   * of progress, so this is the timestamp a stall watchdog resets on.
   */
  lastFrameAt(): number
  /**
   * Epoch ms of the last stderr line. Deliberately NOT part of stall
   * detection: a backend wedged in its own retry loop keeps printing warnings
   * (2026-10-16 codex: "tls handshake eof" every so often for ten minutes),
   * and counting those as progress would make a dead turn look alive.
   */
  lastDiagnosticAt(): number
  /** The last stderr lines, oldest first, for error messages and status notes. */
  stderrTail(): readonly string[]
  close(): void
}

/**
 * One transport's activity record: frame progress and stderr diagnostics,
 * counted separately so a chatty-but-wedged agent is still recognizable as
 * silent (see `lastDiagnosticAt` for why the split exists).
 */
export class ActivityBeacon {
  private frameAt: number
  private diagnosticAt: number
  private readonly tail: string[] = []

  constructor() {
    const now = Date.now()
    this.frameAt = now
    this.diagnosticAt = now
  }

  /** A frame arrived from the agent: progress. */
  frame(): void {
    this.frameAt = Date.now()
  }

  /** A stderr line arrived: diagnostics, not progress. */
  diagnostic(line: string): void {
    this.diagnosticAt = Date.now()
    this.tail.push(line)
    // Bounded: a chatty agent must not turn a crash into a memory leak.
    if (this.tail.length > 20) this.tail.shift()
  }

  lastFrameAt(): number {
    return this.frameAt
  }

  lastDiagnosticAt(): number {
    return this.diagnosticAt
  }

  stderrTail(): readonly string[] {
    return [...this.tail]
  }
}

/**
 * Split a byte stream into lines.
 *
 * ACP stdio is newline-delimited JSON, but one frame can be split across chunks,
 * so this buffers rather than splitting each chunk blindly.
 */
function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return chunk => {
    buffer += chunk
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) onLine(line)
    }
  }
}

export type StdioTransportOptions = {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Agent diagnostics land here; they are never part of the protocol. */
  readonly onDiagnostic?: (line: string) => void
}

/** ACP over a child process's stdin/stdout, as codex and claude both speak it. */
export class StdioAcpTransport implements AcpTransport {
  private readonly child: ReturnType<typeof nodeSpawn>
  /** Frames and stderr lines, counted apart (see ActivityBeacon for why). */
  private readonly beacon = new ActivityBeacon()
  private handler: (line: string) => void = () => {}
  private death: (reason: string) => void = () => {}

  private readonly options: StdioTransportOptions

  constructor(options: StdioTransportOptions) {
    this.options = options
    // Spawned here rather than in a field initializer: with class fields, the
    // initializers run before the constructor assigns `this.options`, so a
    // field initializer would dereference an undefined options.
    this.child = nodeSpawn(this.options.command, [...(this.options.args ?? [])], {
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    })
    // Typed as possibly-null because spawn's stdio is a union; asking for
    // pipes above is what makes them present.
    const stdout = this.child.stdout
    const stderr = this.child.stderr
    const stdin = this.child.stdin
    if (stdout === null || stderr === null || stdin === null) {
      throw new Error(`acp agent ${this.options.command} did not start with pipes`)
    }
    stdout.setEncoding('utf8')
    stdout.on('data', lineSplitter(line => {
      this.beacon.frame()
      this.handler(line)
    }))
    stderr.setEncoding('utf8')
    stderr.on('data', chunk => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        this.beacon.diagnostic(trimmed)
        this.options.onDiagnostic?.(trimmed)
      }
    })
    this.child.on('error', error => {
      this.death(`acp agent ${this.options.command} could not run: ${error.message}`)
    })
    this.child.on('exit', (code, signal) => {
      const said = this.beacon.stderrTail().slice(-3).join(' / ')
      this.death(`acp agent ${this.options.command} exited (code=${code ?? 'none'} signal=${signal ?? 'none'})`
        + (said.length === 0 ? '' : `: ${said}`))
    })
  }

  lastFrameAt(): number {
    return this.beacon.lastFrameAt()
  }

  lastDiagnosticAt(): number {
    return this.beacon.lastDiagnosticAt()
  }

  stderrTail(): readonly string[] {
    return this.beacon.stderrTail()
  }

  onDeath(handler: (reason: string) => void): void {
    this.death = handler
  }

  send(line: string): void {
    this.child.stdin?.write(`${line}\n`)
  }

  onLine(handler: (line: string) => void): void {
    this.handler = handler
  }

  close(): void {
    this.child.kill('SIGTERM')
  }
}

/** The part of a WebSocket this transport needs, so tests can stand one in. */
export type SocketLike = {
  send(data: string): void
  close(): void
  onMessage(handler: (line: string) => void): void
  /** Called once the socket is ready to carry frames. */
  onOpen(handler: () => void): void
  /** Called once the socket is gone, with whatever reason it gave. */
  onDeath(handler: (reason: string) => void): void
}

export type WebSocketTransportOptions = {
  readonly url: string
  /** Injectable so the transport can be tested without a server. */
  readonly createSocket?: (url: string) => SocketLike
}

/**
 * The URL a `grok agent serve` expects.
 *
 * Grok carries its secret in the query as `server-key` and has **no
 * Authorization header** — neither is visible from the agent's code and both
 * have to be right or the handshake is refused. A bind with no port falls back
 * to grok's default.
 */
export function grokWebSocketUrl(bind: string, secret: string): string {
  const hostPort = bind.includes(':') ? bind : `${bind}:2419`
  return `ws://${hostPort}/ws?server-key=${encodeURIComponent(secret)}`
}

/** ACP over a WebSocket, which is how grok is reached. */
export class WebSocketAcpTransport implements AcpTransport {
  private handler: (line: string) => void = () => {}
  private death: (reason: string) => void = () => {}
  private readonly beacon = new ActivityBeacon()
  private readonly socket: SocketLike
  private ready = false
  private readonly pending: string[] = []

  constructor(options: WebSocketTransportOptions) {
    this.socket = options.createSocket?.(options.url) ?? openBrowserWebSocket(options.url)
    this.socket.onOpen(() => {
      this.ready = true
      // Flushed in order: a WebSocket is ordered, so reordering here would be
      // a protocol error the agent would reject with no useful detail.
      for (const line of this.pending) this.socket.send(line)
      this.pending.length = 0
    })
  }

  send(line: string): void {
    // A WebSocket connects asynchronously and throws on a premature send. The
    // first thing a client does is write `initialize` immediately after
    // opening, so without this queue the very first request throws.
    if (this.ready) this.socket.send(line)
    else this.pending.push(line)
  }

  onLine(handler: (line: string) => void): void {
    this.handler = handler
    this.socket.onMessage(line => {
      this.beacon.frame()
      this.handler(line)
    })
  }

  onDeath(handler: (reason: string) => void): void {
    this.death = handler
    this.socket.onDeath(reason => this.death(reason))
  }

  lastFrameAt(): number {
    return this.beacon.lastFrameAt()
  }

  /** A socket carries no stderr channel; the constructor stamp stands. */
  lastDiagnosticAt(): number {
    return this.beacon.lastDiagnosticAt()
  }

  stderrTail(): readonly string[] {
    return []
  }

  close(): void {
    this.socket.close()
  }
}

/** Open the platform WebSocket and adapt its events to `SocketLike`. */
function openBrowserWebSocket(url: string): SocketLike {
  const socket = new WebSocket(url)
  return {
    send: data => socket.send(data),
    close: () => socket.close(),
    onOpen: handler => { socket.onopen = () => handler() },
    onMessage: handler => {
      socket.onmessage = event => handler(String(event.data))
    },
    // A refused handshake and a dropped socket both used to arrive here as an
    // empty frame, which parsed to nothing and was dropped in silence: the turn
    // then waited forever on a connection that was already gone.
    onDeath: handler => {
      socket.onerror = () => handler('acp agent connection errored')
      socket.onclose = event => handler(`acp agent connection closed${event.reason === '' ? '' : `: ${event.reason}`}`)
    },
  }
}

// ---------------------------------------------------------------------------
// grok agent serve: spawn the WebSocket server, then connect to it.
//
// codex and claude are child processes the preset spawns and speaks to over
// stdio. grok is the opposite: it is a long-lived WebSocket server the preset
// has to start first, then dial. So the transport owns the whole lifecycle —
// pick a free port, spawn `grok agent serve`, wait until it actually accepts a
// connection, dial it, and kill it when the session closes. Nothing else in the
// preset layer knows how to do any of that; without this the grok entry would
// point at a URL no process is listening on.
// ---------------------------------------------------------------------------

/** The child process surface this transport needs, so tests can stand one in. */
export type GrokServeChild = {
  readonly stderr: { on(event: 'data', handler: (chunk: string) => void): void; setEncoding(encoding: string): void } | null
  on(event: 'error', handler: (error: Error) => void): void
  on(event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): void
  kill(signal?: NodeJS.Signals): void
}

/** What spawns the serve process; injectable so tests avoid a real child. */
export type GrokServeSpawn = (command: string, args: readonly string[], options: {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}) => GrokServeChild

export type GrokServeOptions = {
  /** Path to the grok binary. */
  readonly command: string
  /** Extra args after `agent serve --bind … --secret …`. */
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Bind host without a port; a free port is chosen. Default `127.0.0.1`. */
  readonly bind?: string
  /** Agent diagnostics land here; never part of the protocol. */
  readonly onDiagnostic?: (line: string) => void
  readonly createSocket?: (url: string) => SocketLike
  /** Injectable so tests avoid a real port scan. */
  readonly pickPort?: () => Promise<number>
  /** Injectable so tests avoid spawning a real grok. */
  readonly spawn?: GrokServeSpawn
  /** Injectable so tests avoid waiting on a real port. */
  readonly waitUntilReady?: (bind: string, port: number) => Promise<void>
  /** How long to wait for the serve process to accept a connection. */
  readonly readyTimeoutMs?: number
}

/** A 24-byte secret, so the server-key is not guessable from a public build. */
function randomSecret(): string {
  return randomBytes(24).toString('hex')
}

/** Ask the OS for a free port, then release it for grok to take. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * Wait until the serve process is actually accepting connections on `port`.
 *
 * A WebSocket constructed a moment too early gets a refused connect and dies,
 * which from the client's side looks like a grok that went silent — so the port
 * has to be listening before the dial. A TCP connect is the honest signal here;
 * the real protocol handshake still happens afterwards, over the WebSocket.
 */
function waitForPort(bind: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = createConnection({ host: bind, port })
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`grok agent serve did not accept a connection on ${bind}:${port} within ${timeoutMs}ms`))
        } else {
          setTimeout(attempt, 100)
        }
      })
    }
    attempt()
  })
}

/**
 * grok reached over a `grok agent serve` this transport starts and owns.
 *
 * Every frame method delegates to the inner WebSocket once it is up; the serve
 * process is the part that is different, so it is spawned here and killed on
 * close. A death of either the process or the socket reaches the session, the
 * same as for a stdio agent.
 */
export class GrokServeTransport implements AcpTransport {
  private readonly child: GrokServeChild
  private readonly inner: WebSocketAcpTransport
  /** The serve process's stderr: diagnostics, never frames. */
  private readonly beacon: ActivityBeacon
  private handler: (line: string) => void = () => {}
  private death: (reason: string) => void = () => {}
  private closed = false

  private constructor(child: GrokServeChild, inner: WebSocketAcpTransport, beacon: ActivityBeacon) {
    this.child = child
    this.inner = inner
    this.beacon = beacon
    child.on('error', error => this.die(`acp agent grok could not run: ${error.message}`))
    child.on('exit', (code, signal) => this.die(
      `acp agent grok exited (code=${code ?? 'none'} signal=${signal ?? 'none'})`
      + (this.beacon.stderrTail().length === 0 ? '' : `: ${this.beacon.stderrTail().slice(-3).join(' / ')}`),
    ))
    inner.onDeath(reason => this.die(reason))
  }

  /** Spawn the serve process, wait for it, and dial it. */
  static async create(options: GrokServeOptions): Promise<GrokServeTransport> {
    const bind = options.bind ?? '127.0.0.1'
    const port = await (options.pickPort?.() ?? pickFreePort())
    const secret = randomSecret()
    const args = ['agent', 'serve', '--bind', `${bind}:${port}`, '--secret', secret, ...(options.args ?? [])]
    const spawn = options.spawn ?? nodeSpawn
    const child = spawn(options.command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    })
    const onDiagnostic = options.onDiagnostic
    // Always read stderr — the beacon keeps the tail even when nobody asked for
    // the live lines, so a stall that ends the turn can still quote them.
    const beacon = new ActivityBeacon()
    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => {
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (trimmed.length === 0) continue
          beacon.diagnostic(trimmed)
          onDiagnostic?.(trimmed)
        }
      })
    }
    await (options.waitUntilReady?.(bind, port) ?? waitForPort(bind, port, options.readyTimeoutMs ?? 30_000))
    const url = grokWebSocketUrl(`${bind}:${port}`, secret)
    const inner = new WebSocketAcpTransport({
      url,
      ...(options.createSocket === undefined ? {} : { createSocket: options.createSocket }),
    })
    return new GrokServeTransport(child, inner, beacon)
  }

  /** A death already reported (our own close) must not reach the session. */
  private die(reason: string): void {
    if (this.closed) return
    this.death(reason)
  }

  send(line: string): void {
    this.inner.send(line)
  }

  onLine(handler: (line: string) => void): void {
    this.inner.onLine(handler)
  }

  onDeath(handler: (reason: string) => void): void {
    this.death = handler
  }

  /** Frames ride the inner WebSocket, so its stamp is the truthful one. */
  lastFrameAt(): number {
    return this.inner.lastFrameAt()
  }

  lastDiagnosticAt(): number {
    return this.beacon.lastDiagnosticAt()
  }

  stderrTail(): readonly string[] {
    return this.beacon.stderrTail()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.inner.close()
    this.child.kill('SIGTERM')
  }
}