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