/**
 * The ACP half of the adapter: JSON-RPC 2.0 on stdio, facing DSH's client.
 *
 * One adapter process serves one external conversation (DSH spawns one
 * command per session it opens), which keeps the state here a single
 * in-flight turn. The contract this satisfies, measured against
 * `packages/dsh-acp-agent/src/client.ts` and `runner.ts`:
 *
 * - `initialize` → reply, then the client notifies `initialized`.
 * - `session/new` {cwd} → spawn the app-server at that cwd, handshake, reply
 *   `{sessionId, modes, models.availableModels}` — the model list is what the
 *   picker serves after the first open.
 * - `session/prompt` → one reply at turn end `{stopReason, usage}`; the text
 *   arrives beforehand as `session/update` notifications.
 * - `session/cancel` notification → `session/stop` underneath; the pending
 *   prompt then resolves with stopReason `cancelled`.
 * - `session/request_permission` is sent **from** us with a numeric id; the
 *   answer comes back as a response echoing it.
 */

import { createInterface } from 'node:readline'
import { BUILTIN_MODELS, ZcodeAppServer, type ZcodeEvent, type ZcodePermissionRequest } from './app-server.ts'
import { defaultPaths, type ZcodePaths } from './paths.ts'

/** The modes this adapter exposes; ids are ZCode's own mode names. */
const MODES = [
  { id: 'build', name: 'Build', description: 'Reads, writes and runs' },
  { id: 'plan', name: 'Plan', description: 'Explores read-only and proposes a plan' },
  { id: 'edit', name: 'Edit', description: 'Edit-focused' },
  { id: 'guarded', name: 'Guarded', description: 'Cautious; asks more often' },
  { id: 'yolo', name: 'Yolo', description: 'Auto-approves and interrupts less' },
] as const

const DEFAULT_MODE = 'build'

/** ZCode tool names → the ACP `kind` of the tool call frame. */
const TOOL_KINDS: Readonly<Record<string, string>> = {
  Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Read: 'read', Grep: 'read', Glob: 'read', LS: 'read',
  Bash: 'execute', Shell: 'execute',
  WebFetch: 'fetch', WebSearch: 'fetch',
}

type TurnState = {
  cancelled: boolean
  finished: boolean
  resolve: (reply: Record<string, unknown>) => void
  /** Latest usage per model request, summed at the end. */
  usageByRequest: Map<string, { inputTokens: number; outputTokens: number; totalTokens?: number; thoughtTokens?: number }>
  /** Tool frames already opened, so later phases only update them. */
  openedTools: Set<string>
  /** Whether the opening frame already carried the tool's raw input. */
  tooledInput: Set<string>
  lastContent: undefined | string
  zcodeStopReason: undefined | string
  failure: undefined | { status: string; errorCode?: unknown; errorMessage?: unknown }
}

export type AcpAgentOptions = {
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  readonly paths?: ZcodePaths
  readonly model?: string
  readonly reasoningLevel?: string
  readonly startupWaitMs?: number
}

export class ZcodeAcpAgent {
  private readonly input: NodeJS.ReadableStream
  private readonly output: NodeJS.WritableStream
  private readonly paths: ZcodePaths
  private readonly model: string
  private readonly reasoningLevel: string
  private readonly startupWaitMs: number | undefined
  private server: ZcodeAppServer | undefined
  private sessionId: string | undefined
  private cwd: string | undefined
  private nextPermissionId = 1
  private readonly pendingPermissions = new Map<number, { resolve: (value: Record<string, unknown>) => void }>()
  private turn: TurnState | undefined

  constructor(options: AcpAgentOptions = {}) {
    this.input = options.input ?? process.stdin
    this.output = options.output ?? process.stdout
    this.paths = options.paths ?? defaultPaths()
    this.model = options.model ?? process.env['ZCODE_ACP_MODEL'] ?? 'GLM-5.3'
    this.reasoningLevel = options.reasoningLevel ?? process.env['ZCODE_ACP_LEVEL'] ?? 'high'
    this.startupWaitMs = options.startupWaitMs
  }

  start(): void {
    createInterface({ input: this.input }).on('line', line => {
      if (line.trim() === '') return
      try {
        this.receive(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // not a frame; ignore like the client ignores our diagnostics
      }
    })
  }

  private write(frame: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(frame)}\n`)
  }

  private reply(id: unknown, result: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  private replyError(id: unknown, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private notifySession(sessionId: string, update: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
  }

  private receive(frame: Record<string, unknown>): void {
    if (frame['jsonrpc'] !== '2.0') return
    const id = frame['id']
    const method = frame['method']

    // A response to one of our requests (a permission decision).
    if (id !== undefined && method === undefined && typeof id === 'number') {
      const pending = this.pendingPermissions.get(id)
      if (pending !== undefined) {
        this.pendingPermissions.delete(id)
        const result = (frame['result'] ?? { outcome: { outcome: 'cancelled' } }) as Record<string, unknown>
        pending.resolve(result)
      }
      return
    }
    if (typeof method !== 'string') return

    // A notification from the client.
    if (id === undefined) {
      if (method === 'session/cancel') void this.handleCancel((frame['params'] ?? {}) as Record<string, unknown>)
      else if (method === 'initialized') { /* nothing to do */ }
      return
    }

    // A request from the client.
    const params = (frame['params'] ?? {}) as Record<string, unknown>
    switch (method) {
      case 'initialize': {
        this.reply(id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          agentInfo: { name: 'zcode-acp', title: 'ZCode (GLM Coding Plan)', version: '0.1.0' },
          authMethods: [],
        })
        return
      }
      case 'authenticate': {
        this.reply(id, {})
        return
      }
      case 'session/new': {
        void this.handleNewSession(id, params)
        return
      }
      case 'session/prompt': {
        void this.handlePrompt(id, params)
        return
      }
      case 'session/set_mode': {
        void this.handleSetMode(id, params)
        return
      }
      default: {
        this.replyError(id, -32601, `zcode-acp does not serve ${method}`)
      }
    }
  }

  private async handleNewSession(id: unknown, params: Record<string, unknown>): Promise<void> {
    try {
      const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : process.cwd()
      this.cwd = cwd
      this.server = new ZcodeAppServer({
        cwd,
        paths: this.paths,
        ...(this.startupWaitMs === undefined ? {} : { startupWaitMs: this.startupWaitMs }),
        onPermission: request => this.forwardPermission(request),
        onEvent: event => this.routeEvent(event),
        onDeath: reason => this.failTurn(reason),
      })
      await this.server.ensureAccount()
      this.sessionId = await this.server.createSession(DEFAULT_MODE)
      await this.server.subscribe(this.sessionId)
      this.reply(id, {
        sessionId: this.sessionId,
        modes: { currentModeId: DEFAULT_MODE, availableModes: MODES.map(mode => ({ id: mode.id, name: mode.name })) },
        models: {
          currentModelId: this.model,
          availableModels: BUILTIN_MODELS.map(modelId => ({
            modelId,
            name: modelId.replace(/^GLM-/, 'GLM '),
            description: 'GLM Coding Plan via the local ZCode app',
          })),
        },
      })
    } catch (error) {
      this.replyError(id, -32000, error instanceof Error ? error.message : String(error))
    }
  }

  private async handleSetMode(id: unknown, params: Record<string, unknown>): Promise<void> {
    const modeId = params['modeId']
    if (this.server === undefined || this.sessionId === undefined || typeof modeId !== 'string') {
      this.replyError(id, -32602, 'no session to set a mode on')
      return
    }
    if (!MODES.some(mode => mode.id === modeId)) {
      this.replyError(id, -32602, `unknown mode ${modeId}`)
      return
    }
    try {
      await this.server.setMode(this.sessionId, modeId)
      this.reply(id, {})
    } catch (error) {
      this.replyError(id, -32000, error instanceof Error ? error.message : String(error))
    }
  }

  private async handlePrompt(id: unknown, params: Record<string, unknown>): Promise<void> {
    if (this.server === undefined || this.sessionId === undefined) {
      this.replyError(id, -32602, 'no session; session/new first')
      return
    }
    const blocks = Array.isArray(params['prompt']) ? params['prompt'] : []
    const text = blocks.map(block => {
      const entry = (block ?? {}) as { type?: unknown; text?: unknown }
      return entry.type === 'text' && typeof entry.text === 'string' ? entry.text : ''
    }).filter(part => part !== '').join('\n')
    if (text === '') {
      this.replyError(id, -32602, 'prompt carried no text')
      return
    }
    // DSH passes the picked model on the request; GLM ids must also carry a
    // reasoning level or the send is rejected as invalid_model_request.
    const requested = typeof params['modelId'] === 'string' ? params['modelId'] : this.model
    const modelId = requested.replace(/\[.*\]$/, '')
    const level = this.reasoningLevelFor(requested)

    const reply = await new Promise<Record<string, unknown>>(resolve => {
      this.turn = {
        cancelled: false,
        finished: false,
        resolve,
        usageByRequest: new Map(),
        openedTools: new Set(),
        tooledInput: new Set(),
        lastContent: undefined,
        zcodeStopReason: undefined,
        failure: undefined,
      }
      this.server!.sendTurn(this.sessionId!, text, modelId, level).catch(error => {
        // A refused send ends the turn as a refusal; the reply below is the
        // only one the client gets.
        this.notifySession(this.sessionId!, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `[发送失败] ${error instanceof Error ? error.message : String(error)}` },
        })
        if (this.turn !== undefined) this.turn.finished = true
        this.settleTurn('refusal')
      })
    })
    this.reply(id, reply)
  }

  /** Map a requested id (possibly `base[effort]`) onto ZCode's levels. */
  private reasoningLevelFor(requested: string): string {
    const suffix = /\[([^\]]*)\]\s*$/.exec(requested)?.[1]
    if (suffix === undefined) return this.reasoningLevel
    const effort = /(?:^|,)\s*(?:reasoning_)?effort\s*=\s*(\w+)/.exec(suffix)?.[1] ?? /(?:^|,)\s*(\w+)\s*=/.exec(suffix)?.[1]
    if (effort === undefined) return this.reasoningLevel
    if (['low', 'minimal', 'none'].includes(effort)) return 'low'
    if (['medium', 'high'].includes(effort)) return 'high'
    return 'max'
  }

  private async handleCancel(params: Record<string, unknown>): Promise<void> {
    if (this.turn === undefined || this.sessionId === undefined || this.server === undefined) return
    this.turn.cancelled = true
    await this.server.stopTurn(this.sessionId)
  }

  /** Every server notification, projected onto this conversation. */
  private routeEvent(event: ZcodeEvent): void {
    const turn = this.turn
    const params = event.params
    if (event.method === 'v4/telemetry/event') {
      const kind = params['kind']
      if (kind === 'tool.lifecycle') {
        this.onToolLifecycle(params)
        return
      }
      if (kind === 'usage.delta' && turn !== undefined) {
        const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : 'unknown'
        turn.usageByRequest.set(requestId, {
          inputTokens: numberOf(params['inputTokens']),
          outputTokens: numberOf(params['outputTokens']),
          ...numberOrOmit(params['totalTokens'], 'totalTokens'),
          ...numberOrOmit(params['thoughtTokens'] ?? params['reasoningTokens'], 'thoughtTokens'),
        })
        return
      }
      if (kind === 'turn.terminal') {
        if (turn === undefined) return
        turn.failure = params['status'] === 'failed'
          ? { status: 'failed', errorCode: params['errorCode'], errorMessage: params['errorMessage'] }
          : undefined
        this.finishTurn()
        return
      }
      return
    }
    if (event.method === 'session/event') {
      if (turn === undefined) return
      const payload = (params['payload'] ?? {}) as Record<string, unknown>
      if (typeof payload['content'] === 'string') turn.lastContent = payload['content']
      if (typeof payload['stopReason'] === 'string') turn.zcodeStopReason = payload['stopReason']
      return
    }
    // state.updated, computer-use/*, process/*: nothing the ACP side needs.
  }

  private onToolLifecycle(params: Record<string, unknown>): void {
    const turn = this.turn
    const sessionId = this.sessionId
    if (turn === undefined || sessionId === undefined) return
    const toolCallId = params['toolCallId']
    const toolName = params['toolName']
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string') return
    const phase = params['phase']
    if (!turn.openedTools.has(toolCallId)) {
      turn.openedTools.add(toolCallId)
      // The opening frame carries the tool's identity; the title repeats it on
      // purpose — our dialect latches the name from `title`, and a human
      // activity line is something ZCode never sends here.
      this.notifySession(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: toolName,
        kind: TOOL_KINDS[toolName] ?? 'other',
        status: 'pending',
        rawInput: {},
        content: [],
      })
      return
    }
    if (phase === 'started') {
      this.notifySession(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, title: toolName, status: 'in_progress' })
      return
    }
    if (phase === 'completed' || phase === 'finished' || phase === 'done' || phase === 'failed') {
      // ZCode exposes no tool output text; the completed frame still closes
      // the card, with the failure named when the phase says so.
      this.notifySession(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: toolName,
        status: phase === 'failed' ? 'failed' : 'completed',
        content: [],
      })
    }
  }

  private finishTurn(): void {
    const turn = this.turn
    const sessionId = this.sessionId
    if (turn === undefined || sessionId === undefined || turn.finished) return
    turn.finished = true

    if (turn.failure !== undefined) {
      const message = typeof turn.failure.errorMessage === 'string'
        ? turn.failure.errorMessage
        : typeof turn.failure.errorCode === 'string' ? turn.failure.errorCode : 'turn failed'
      this.notifySession(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `[轮次失败] ${message}` } })
      this.settleTurn('refusal')
      return
    }

    // Prefer the rich completion event; fall back to reading the transcript,
    // which is the path that never depends on event shapes.
    const body = turn.lastContent
    void this.server?.lastAssistantText(sessionId).then(fallback => {
      const text = body ?? fallback ?? '(no reply)'
      this.notifySession(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
      const stop = turn.cancelled
        ? 'cancelled'
        : ['length', 'max_tokens'].includes((turn.zcodeStopReason ?? '').toLowerCase()) ? 'max_tokens' : 'end_turn'
      this.settleTurn(stop)
    }).catch(() => {
      this.settleTurn(turn.cancelled ? 'cancelled' : 'end_turn')
    })
  }

  private settleTurn(stopReason: string): void {
    const turn = this.turn
    if (turn === undefined) return
    this.turn = undefined
    const usage = summarizeUsage(turn)
    turn.resolve({ stopReason, ...(usage === undefined ? {} : { usage }) })
  }

  private failTurn(reason: string): void {
    const turn = this.turn
    const sessionId = this.sessionId
    if (turn === undefined) return
    turn.finished = true
    if (sessionId !== undefined) {
      this.notifySession(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `[连接断开] ${reason}` } })
    }
    this.settleTurn('refusal')
  }

  /**
   * Forward one ZCode permission request to the DSH approval service.
   *
   * ZCode's own options each carry the `response` template it expects back,
   * so the client's choice maps onto that template verbatim — nothing about
   * the reply shape is guessed. The DSH client answers allow/reject by
   * picking one of the options we offer, which is why the kinds matter.
   */
  private async forwardPermission(request: ZcodePermissionRequest): Promise<Record<string, unknown>> {
    const sessionId = this.sessionId
    if (sessionId === undefined) return denyResponse(request.options)
    const id = this.nextPermissionId++
    const options = request.options.map(option => ({
      optionId: option.optionId,
      name: option.name,
      kind: acpPermissionKind(option.kind),
    }))
    if (options.length === 0) return denyResponse(request.options)

    // Enrich the open tool card with what the tool wants to do, if the
    // lifecycle frames have not carried it already.
    if (request.toolCallId !== undefined && this.turn !== undefined && !this.turn.tooledInput.has(request.toolCallId)) {
      this.turn.tooledInput.add(request.toolCallId)
      this.notifySession(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: request.toolCallId,
        ...(request.toolName === undefined ? {} : { title: request.toolName }),
        status: 'in_progress',
        rawInput: request.input ?? {},
      })
    }

    const outcome = await new Promise<Record<string, unknown>>(resolve => {
      this.pendingPermissions.set(id, { resolve })
      this.write({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: request.toolCallId ?? `perm_${String(id)}`,
            name: request.toolName ?? 'tool',
            title: request.reason ?? request.toolName ?? 'Tool call',
            kind: request.toolName === undefined ? 'other' : TOOL_KINDS[request.toolName] ?? 'other',
            status: 'pending',
            ...(request.input === undefined ? {} : { rawInput: request.input }),
          },
          options,
        },
      })
    })
    const selected = (outcome['outcome'] ?? {}) as Record<string, unknown>
    if (selected['outcome'] !== 'selected' || typeof selected['optionId'] !== 'string') {
      return denyResponse(request.options)
    }
    const match = request.options.find(option => option.optionId === selected['optionId'])
    return match === undefined ? denyResponse(request.options) : match.response
  }
}

/** `allow`/`deny`, ZCode's spellings, onto the four ACP option kinds. */
function acpPermissionKind(kind: string): string {
  if (kind.startsWith('allow')) return kind.includes('always') || kind.includes('project') ? 'allow_always' : 'allow_once'
  return 'reject_once'
}

function denyResponse(options: readonly { kind: string; optionId: string; response: Record<string, unknown> }[]): Record<string, unknown> {
  const deny = options.find(option => option.kind.startsWith('deny') || option.optionId === 'deny')
  return deny?.response ?? { decision: 'deny', reason: 'denied by zcode-acp' }
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function numberOrOmit(value: unknown, as: 'totalTokens' | 'thoughtTokens'): { totalTokens?: number } | { thoughtTokens?: number } {
  return typeof value === 'number' && Number.isFinite(value) ? { [as]: value } : {}
}

/**
 * The turn's usage: the latest report per model request, summed. ZCode sends
 * a running total per request, so last-wins per id is the correct fold —
 * summing every delta would count the same tokens twice.
 */
function summarizeUsage(turn: TurnState): { inputTokens: number; outputTokens: number; totalTokens?: number; thoughtTokens?: number } | undefined {
  if (turn.usageByRequest.size === 0) return undefined
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let thoughtTokens = 0
  let anyTotal = false
  let anyThought = false
  for (const usage of turn.usageByRequest.values()) {
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    if (usage.totalTokens !== undefined) { totalTokens += usage.totalTokens; anyTotal = true }
    if (usage.thoughtTokens !== undefined) { thoughtTokens += usage.thoughtTokens; anyThought = true }
  }
  if (inputTokens === 0 && outputTokens === 0) return undefined
  return {
    inputTokens,
    outputTokens,
    ...(anyTotal ? { totalTokens } : {}),
    ...(anyThought ? { thoughtTokens } : {}),
  }
}
