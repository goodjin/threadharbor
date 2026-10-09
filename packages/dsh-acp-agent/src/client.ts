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

export class AcpClient {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  onNotification: (frame: AcpFrame) => void = () => {}
  onPermissionRequest: (request: PermissionRequest) => Promise<PermissionDecision> = async () => ({ outcome: 'reject' })

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
    if (frame.method === 'session/request_permission') {
      void this.answerPermission(frame)
      return
    }
    if (frame.method !== undefined) this.onNotification(frame)
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