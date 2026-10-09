/**
 * Line-oriented transport for ACP agents that speak JSON-RPC over stdio.
 *
 * Kept behind an interface so the client can be tested without a child process;
 * the grok agent needs a WebSocket instead, which is the other side of the same
 * interface.
 */

import { spawn } from 'node:child_process'

export interface AcpTransport {
  /** Write one newline-delimited JSON frame. */
  send(line: string): void
  /** Register the handler for frames arriving from the agent. */
  onLine(handler: (line: string) => void): void
  close(): void
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
  private readonly child: ReturnType<typeof spawn>
  private handler: (line: string) => void = () => {}

  constructor(private readonly options: StdioTransportOptions) {
    // Spawned here rather than in a field initializer: with class fields, the
    // initializers run before the constructor assigns `this.options`, so a
    // field initializer would dereference an undefined options.
    this.child = spawn(this.options.command, [...(this.options.args ?? [])], {
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
    stdout.on('data', lineSplitter(line => this.handler(line)))
    stderr.setEncoding('utf8')
    stderr.on('data', chunk => {
      if (this.options.onDiagnostic === undefined) return
      for (const line of chunk.split('\n')) {
        if (line.trim().length > 0) this.options.onDiagnostic(line.trim())
      }
    })
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
    this.socket.onMessage(line => this.handler(line))
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
      socket.onerror = () => handler('')
      socket.onclose = () => handler('')
    },
  }
}