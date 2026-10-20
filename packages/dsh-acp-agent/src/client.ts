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
import { FsService } from './files.ts'

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

/** One question the agent asked, with the choices it offered. */
export type AskQuestionItem = {
  /** The agent's question id, echoed back in the answer. */
  readonly id: string
  /** The question to display. */
  readonly prompt: string
  readonly options: readonly { readonly id: string; readonly label: string }[]
  /** Whether more than one option may be selected. */
  readonly allowMultiple: boolean
}

/** An agent's ask-the-user request, flattened out of the raw frame. */
export type AskQuestionRequest = {
  /** The session the frame names, when it names one. */
  readonly sessionId?: string
  /** The agent's tool call the question belongs to, when sent. */
  readonly toolCallId?: string
  /** One heading for the whole ask, when sent. */
  readonly title?: string
  readonly questions: readonly AskQuestionItem[]
}

/** The human's answer, as the text the asker should read. */
export type AskQuestionAnswer = { readonly answer: string }

/**
 * Cursor's reply envelope for `cursor/ask_question` (`docs/agent-acp/cursor.md`).
 * An answered question names option **ids**; `skipped` is both the user
 * dismissing the question and the only channel for an answer those ids cannot
 * express, which is why the optional `reason` travels with it.
 */
export type AskQuestionOutcome = {
  readonly outcome: { readonly outcome: 'answered' | 'skipped'; readonly answers?: unknown; readonly reason?: string }
}

/** A terminal an agent asked us to run a command in. */
export type TerminalCreateRequest = {
  readonly sessionId?: string
  readonly command: string
  readonly cwd?: string
}

/**
 * What the client needs of a dialect: an identity, and optionally the place its
 * permission requests hide the tool name (Qoder: `_meta.qoder.toolName`).
 */
type PermissionToolNameReader = {
  readonly id: string
  readonly readPermissionToolName?: ((toolCall: Record<string, unknown>) => string | undefined) | undefined
}

export class AcpClient {
  private readonly pending = new Map<number, Pending>()
  private readonly frameObservers = new Set<(frame: AcpFrame) => void>()
  private nextId = 1

  onNotification: (frame: AcpFrame) => void = () => {}
  onPermissionRequest: (request: PermissionRequest) => Promise<PermissionDecision> = async () => ({ outcome: 'reject' })

  /**
   * Serves the agent's ask-the-user request, when this client can put the
   * question in front of a human.
   *
   * Cursor's `cursor/ask_question` is blocking: unanswered, the turn stalls
   * with no error. With this hook set the question is handed over and the
   * returned answer goes back in cursor's `answered` envelope — the answer text
   * mapped onto the offered option labels, since the envelope names option ids.
   * An answer matching no offered option has no faithful encoding there, so it
   * travels as `skipped` with the user's own words in `reason`; a throwing hook
   * answers `skipped` too, because a question that cannot be presented must
   * still release the turn. Left unset, the request falls through to
   * `onExtensionRequest` — the factory's auto-answer — exactly as before.
   */
  onAskQuestion: ((request: AskQuestionRequest) => Promise<AskQuestionAnswer>) | undefined = undefined

  /**
   * Answers an agent-initiated request the built-in handlers do not recognize.
   *
   * Cursor sends two blocking custom methods — `cursor/ask_question` and
   * `cursor/create_plan` — that stall the turn if left unanswered (the default
   * here is a JSON-RPC error, which the agent does not treat as a resolution).
   * Return true to mean "I answered this frame"; the client then sends nothing
   * further. Return false to fall through to the default error. Wired by the
   * factory per agent, so the client itself stays agent-agnostic.
   */
  onExtensionRequest: (frame: AcpFrame) => boolean = () => false

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

  /**
   * Serves the file sub-protocol, when this client offers it.
   *
   * Same reasoning as the terminal: grok reaches for the file API before it
   * reaches for a shell, and an unanswered call stalls the turn with no error.
   */
  files: FsService | undefined = new FsService()

  private readonly transport: AcpTransport
  private readonly dialect: PermissionToolNameReader

  constructor(transport: AcpTransport, dialect: PermissionToolNameReader) {
    this.transport = transport
    this.dialect = dialect
    this.transport.onLine(line => this.receive(line))
    // The connection dying is the one event the frame stream cannot report:
    // there is no frame for it. Without this, every request in flight waits
    // for an answer from an agent that is no longer running.
    this.transport.onDeath(reason => this.failAll(new Error(reason)))
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
      else if (frame.method.startsWith('fs/')) void this.answerFile(frame)
      // The ask hook takes the question before the extension hook, so a wired
      // human answer beats the benign auto-answer; unset, the request reaches
      // the extension hook unchanged.
      else if (frame.method === 'cursor/ask_question' && this.onAskQuestion !== undefined) void this.answerAskQuestion(frame)
      // An agent-specific extension the built-in handlers do not know. Give the
      // wired hook first crack (cursor's blocking `cursor/*` methods); only when
      // it declines do we send the generic "cannot serve" error.
      else if (this.onExtensionRequest(frame)) return
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
   * Send a JSON-RPC result for an agent-initiated request, by id.
   *
   * The public face of `respond`, for the wired `onExtensionRequest` hook:
   * a per-agent extension handler answers the frame itself (cursor's blocking
   * `cursor/*` methods) and returns true so the default error is not sent.
   */
  reply(id: number | string, result: unknown): void {
    this.respond(id as number, result, undefined)
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

  /** Answer a file read/write the agent asked for. */
  private async answerFile(frame: AcpFrame): Promise<void> {
    const id = frame.id as number
    if (this.files === undefined) {
      this.respond(id, undefined, 'this client does not offer file access')
      return
    }
    const params = (frame.params ?? {}) as { path?: unknown; content?: unknown; line?: unknown; limit?: unknown }
    try {
      switch (frame.method) {
        case 'fs/read_text_file':
          this.respond(id, await this.files.readTextFile({
            ...(typeof params.path === 'string' ? { path: params.path } : {}),
            ...(typeof params.line === 'number' ? { line: params.line } : {}),
            ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
          }))
          return
        case 'fs/write_text_file':
          await this.files.writeTextFile({
            ...(typeof params.path === 'string' ? { path: params.path } : {}),
            ...(typeof params.content === 'string' ? { content: params.content } : {}),
          })
          this.respond(id, {})
          return
        default:
          this.respond(id, undefined, `client cannot serve ${frame.method}`)
          return
      }
    } catch (error) {
      // The agent reads this text and decides what to try next, so naming the
      // file is the difference between moving on and looking stuck.
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
      toolCall?: Record<string, unknown>
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
    const toolCall = params.toolCall ?? {}
    // Draft agents name the tool on `toolCall.name`; qoder only under
    // `toolCall._meta.qoder.toolName`, so the dialect gets first say.
    const toolName = this.dialect.readPermissionToolName?.(toolCall)
      ?? (typeof toolCall['name'] === 'string' ? toolCall['name'] : undefined)
    const request: PermissionRequest = {
      ...(typeof params.requestId === 'string' || typeof params.requestId === 'number' ? { requestId: params.requestId } : {}),
      ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
      ...(toolName === undefined ? {} : { toolName }),
      ...(toolCall['rawInput'] === undefined ? {} : { rawInput: toolCall['rawInput'] }),
      ...(typeof toolCall['title'] === 'string' ? { title: toolCall['title'] } : {}),
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

  /** Serve one `cursor/ask_question`: hand it to the hook, return the answer. */
  private async answerAskQuestion(frame: AcpFrame): Promise<void> {
    const id = frame.id as number
    const request = parseAskQuestion(frame.params)
    let answer: AskQuestionAnswer
    try {
      answer = await this.onAskQuestion!(request)
    } catch {
      // Unpresented is not unanswered: the turn must end either way, and the
      // reason is structural — the error's text may carry question payload.
      this.respond(id, skipOutcome('the host could not present this question; the user was not asked'), undefined)
      return
    }
    this.respond(id, answeredOutcome(request.questions, answer.answer), undefined)
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}

/** Long enough for an answer, short enough to stay a bounded agent-facing field. */
const REASON_LIMIT = 500

/** Read the question off the wire, tolerating the shapes cursor omits fields in. */
function parseAskQuestion(params: unknown): AskQuestionRequest {
  const raw = (params ?? {}) as { sessionId?: unknown; toolCallId?: unknown; title?: unknown; questions?: unknown }
  const questions = Array.isArray(raw.questions) ? raw.questions : []
  return {
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.toolCallId === 'string' ? { toolCallId: raw.toolCallId } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    questions: questions.map((item, index) => {
      const question = (item ?? {}) as { id?: unknown; prompt?: unknown; options?: unknown; allowMultiple?: unknown }
      const options = Array.isArray(question.options) ? question.options : []
      return {
        id: typeof question.id === 'string' && question.id !== '' ? question.id : `q${index}`,
        prompt: typeof question.prompt === 'string' ? question.prompt : '',
        options: options.map(option => {
          const choice = (option ?? {}) as { id?: unknown; label?: unknown }
          const label = typeof choice.label === 'string' ? choice.label : ''
          return { id: typeof choice.id === 'string' && choice.id !== '' ? choice.id : label, label }
        }),
        allowMultiple: question.allowMultiple === true,
      }
    }),
  }
}

/** `skipped`, with the reason cursor's envelope leaves room for — and no reason field when there is nothing to say. */
function skipOutcome(reason: string): AskQuestionOutcome {
  const bounded = reason.trim().slice(0, REASON_LIMIT)
  return { outcome: { outcome: 'skipped', ...(bounded === '' ? {} : { reason: bounded }) } }
}

/**
 * The user's answer as cursor's reply.
 *
 * The `answered` envelope names option ids, so the answer text is matched
 * against each question's offered labels. An answer no question offers — the
 * ordinary free-text path — cannot be encoded as a selection: replying
 * `answered` with an empty selection would read as "asked and chose nothing"
 * and drop the user's words, so the reply is `skipped` with those words in the
 * reason, which the agent reads.
 */
function answeredOutcome(questions: readonly AskQuestionItem[], answer: string): AskQuestionOutcome {
  const text = answer.trim()
  const answers: { questionId: string; selectedOptionIds: string[] }[] = []
  for (const question of questions) {
    const ids = question.options.filter(option => option.label.trim() === text).map(option => option.id)
    if (ids.length === 0) return skipOutcome(text === '' ? '' : `the user answered in free text: ${text}`)
    answers.push({ questionId: question.id, selectedOptionIds: ids })
  }
  return answers.length === 0
    ? skipOutcome(text === '' ? '' : `the user answered in free text: ${text}`)
    : { outcome: { outcome: 'answered', answers } }
}