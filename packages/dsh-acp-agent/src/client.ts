/**
 * The agent-agnostic half of talking ACP: request/response bookkeeping and the
 * agent-initiated requests we have to answer.
 *
 * What lives here is the protocol; what varies per agent lives in its dialect.
 * The one thing worth reading closely is `answerPermission` — see the comment
 * there for the hang this shape was measured producing.
 */

import type { AcpFrame, AcpSession } from './acp-client.ts'
import type { AcpDialect } from './dialects/types.ts'
import type { AcpTransport } from './transport.ts'
import { TerminalService } from './terminals.ts'

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** A permission request, flattened out of the raw frame for the caller. */
export type PermissionRequest = {
  readonly requestId?: string | number
  readonly sessionId?: string
  /** The tool asking, when the agent names it. */
  readonly toolName?: string
  /** The tool's arguments, for rendering "this is what it wants to do". */
  readonly rawInput?: unknown
  readonly title?: string
  /** The agent's own choices, so a decision maps onto what it accepts. */
  readonly options: readonly { optionId: string; name: string; kind: string }[]
}

export type PermissionDecision =
  | { readonly outcome: 'allow' }
  | { readonly outcome: 'reject' }

/** A terminal an agent asked us to run a command in. */
export type TerminalCreateRequest = {
  readonly sessionId?: string
  readonly command: string
  readonly cwd?: string
}

export class AcpClient {
  private readonly pending = new Map<number, Pending>()
  private readonly frameObservers = new Set<(frame: AcpFrame) => void>()
  private nextId = 1

  onNotification: (frame: AcpFrame) => void = () => {}
  onPermissionRequest: (request: PermissionRequest) => Promise<PermissionDecision> = async () => ({ outcome: 'reject' })

  /**
   * Serves the terminal sub-protocol, when this client offers it.
   *
   * Some agents — grok among them — ask the client to run shell commands rather
   * than running them themselves, and then poll for the result. Left
   * unanswered, that is a stalled turn with no error and no timeout. Left unset,
   * every terminal call is answered with a JSON-RPC error so the agent can
   * report the failure rather than wait forever.
   */
  terminals: TerminalService | undefined = undefined

  constructor(private readonly transport: AcpTransport, private readonly dialect: { readonly id: string }) {
    this.transport.onLine(line => this.receive(line))
  }

  /** Send a request and resolve when the agent answers it. */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  /** Tell the agent something without waiting for an answer. */
  notify(method: string, params: unknown): void {
    this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  /**
   * Read the model list out of a `session/new` reply through the dialect.
   *
   * The three agents disagree on where it lives, so this delegates rather than
   * assuming a shape.
   */
  static toSession(reply: unknown, dialect: AcpDialect): AcpSession {
    const sessionId = (reply as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId !== 'string') throw new Error(`${dialect.id} session/new returned no sessionId`)
    const modes = (reply as { modes?: { currentModeId?: unknown } } | null)?.modes
    return {
      sessionId,
      models: dialect.readModels(reply),
      modeId: typeof modes?.currentModeId === 'string' ? modes.currentModeId : undefined,
    }
  }

  close(): void {
    this.transport.close()
    this.failAll(new Error('acp connection closed'))
  }

  private receive(line: string): void {
    let frame: AcpFrame
    try {
      frame = JSON.parse(line) as AcpFrame
    } catch {
      return // not a frame; agents write diagnostics to stdout too
    }
    this.observe(frame)

    // A frame with an id and no method is a reply to one of our calls.
    if (frame.id !== undefined && typeof frame.id === 'number' && frame.method === undefined) {
      const entry = this.pending.get(frame.id)
      if (entry === undefined) return
      this.pending.delete(frame.id)
      if (frame.error !== undefined) entry.reject(new Error(`acp error: ${JSON.stringify(frame.error)}`))
      else entry.resolve(frame.result)
      return
    }

    // An agent-initiated request. It carries an id the answer must echo.
    // Getting this wrong in either direction strands the turn: answer a
    // permission request with a notification and it hangs silently; fail to
    // answer a `terminal/create` and it hangs the same way.
    if (typeof frame.id === 'number' && frame.method !== undefined) {
      if (frame.method === 'session/request_permission') void this.answerPermission(frame)
      else if (frame.method.startsWith('terminal/')) void this.answerTerminal(frame)
      else this.respond(frame.id, undefined, `client cannot serve ${frame.method}`)
      return
    }
    if (frame.method !== undefined) this.onNotification(frame)
  }

  /** Register an observer of every inbound frame, replies included. */
  onFrame(handler: (frame: AcpFrame) => void): void {
    this.frameObservers.add(handler)
  }

  /**
   * Tell the observers, each in isolation.
   *
   * An observer is a bystander: one that throws must not take the turn with it,
   * so failures are swallowed here rather than left to escape into `receive`.
   */
  private observe(frame: AcpFrame): void {
    for (const observer of this.frameObservers) {
      try {
        observer(frame)
      } catch {
        // deliberately ignored
      }
    }
  }

  /** Send one JSON-RPC response, either a result or an error. */
  private respond(id: number, result: unknown, errorMessage?: string): void {
    this.transport.send(JSON.stringify(
      errorMessage === undefined
        ? { jsonrpc: '2.0', id, result }
        : { jsonrpc: '2.0', id, error: { code: -32601, message: errorMessage } },
    ))
  }

  /**
   * Serve one `terminal/*` call.
   *
   * All five are handled together on purpose: serving `terminal/create` but not
   * `terminal/wait_for_exit` looks like it worked — the turn finishes — while
   * the tool result is a complaint that a later call could not be served.
   */
  private async answerTerminal(frame: AcpFrame): Promise<void> {
    // The caller narrowed the id to a number; passing it keeps that narrowing
    // from being lost at the call boundary.
    const id = frame.id as number
    if (this.terminals === undefined) {
      this.respond(id, undefined, 'this client does not offer terminals')
      return
    }
    const params = (frame.params ?? {}) as { terminalId?: unknown; sessionId?: unknown; command?: unknown; cwd?: unknown }
    const terminalId = typeof params.terminalId === 'string' ? params.terminalId : ''
    try {
      const result = await (async () => {
        switch (frame.method) {
          case 'terminal/create':
            return this.terminals!.create({
              command: typeof params.command === 'string' ? params.command : '',
              ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
            })
          case 'terminal/wait_for_exit':
            return this.terminals!.waitForExit(terminalId)
          case 'terminal/output':
            return this.terminals!.output(terminalId)
          case 'terminal/kill':
            return this.terminals!.kill(terminalId)
          case 'terminal/release':
            return this.terminals!.release(terminalId)
          default:
            throw new Error(`unsupported terminal call ${String(frame.method)}`)
        }
      })()
      this.respond(id, result, undefined)
    } catch (error) {
      this.respond(id, undefined, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Answer a permission request.
   *
   * The answer **must** be a JSON-RPC response echoing the request's own id.
   * Answering with a notification (no id) is accepted silently by the agent and
   * the turn then never returns — measured: a real capture hung for the full
   * 240 s budget with no error, no timeout, no further frames.
   */
  private async answerPermission(frame: AcpFrame): Promise<void> {
    const params = (frame.params ?? {}) as {
      toolCall?: { name?: unknown; rawInput?: unknown; title?: unknown }
      options?: { optionId?: unknown; name?: unknown; kind?: unknown }[]
      sessionId?: unknown
      requestId?: unknown
    }
    const options = (params.options ?? []).flatMap(option => {
      const optionId = option.optionId
      if (typeof optionId !== 'string') return []
      return [{
        optionId,
        name: typeof option.name === 'string' ? option.name : optionId,
        kind: typeof option.kind === 'string' ? option.kind : 'unknown',
      }]
    })
    const request: PermissionRequest = {
      ...(typeof params.requestId === 'string' || typeof params.requestId === 'number' ? { requestId: params.requestId } : {}),
      ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
      ...(typeof params.toolCall?.name === 'string' ? { toolName: params.toolCall.name } : {}),
      ...(params.toolCall?.rawInput === undefined ? {} : { rawInput: params.toolCall.rawInput }),
      ...(typeof params.toolCall?.title === 'string' ? { title: params.toolCall.title } : {}),
      options,
    }

    let decision: PermissionDecision
    try {
      decision = await this.onPermissionRequest(request)
    } catch {
      decision = { outcome: 'reject' } // a failing decision path must still release the turn
    }

    const allow = options.find(option => option.kind === 'allow_once')
      ?? options.find(option => option.kind === 'allow_always')
      ?? options.find(option => option.optionId.startsWith('allow'))
    const reject = options.find(option => option.kind === 'reject_once' || option.kind === 'reject_always')
    const optionId = decision.outcome === 'allow'
      ? allow?.optionId ?? options[0]?.optionId
      : reject?.optionId ?? options.find(option => !option.optionId.startsWith('allow'))?.optionId

    this.transport.send(JSON.stringify({
      jsonrpc: '2.0',
      id: frame.id,
      result: { outcome: { outcome: 'selected', optionId: optionId ?? 'reject' } },
    }))
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}