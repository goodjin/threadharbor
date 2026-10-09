/**
 * A DSH `Agent` driven by a Grok ACP session.
 *
 * DSH's own loop calls an LLM API directly; this one forwards the turn to a
 * `grok agent serve` process and folds the frames it streams back into session
 * events. The contract it satisfies is the open `Agent` interface, which is why
 * a plugin can supply one at all.
 *
 * Turn boundaries are synthesized here rather than read from the agent: Grok
 * decides its own stepping internally and never reports it, so the projection
 * derives one step per turn. That is the main deliberate simplification.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { GrokAcpClient, type AcpFrame } from './acp-client.ts'
import { projectTurn, type ProjectionEvent } from './projection.ts'

/** Structural views of the DSH contracts, kept local so this file needs no DSH build. */
type SessionLike = { append(type: string, payload: unknown): unknown }
type SessionId = string
type UserMessageLike = { id?: string; content: readonly { type: string; text?: string }[] }
type InboxTarget = 'next-turn' | 'next-step'
type AgentCancelCause = { kind: string; [key: string]: unknown }
type CancelOptions = { keepInbox?: boolean | undefined }
type AgentStatus = 'idle' | 'running'
type AgentOptions = {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

type InboxContract = {
  readonly nextTurn: readonly UserMessageLike[]
  readonly nextStep: readonly UserMessageLike[]
  clear(): void
  append(target: InboxTarget, message: UserMessageLike): void
  prepend(target: InboxTarget, message: UserMessageLike): void
  replace(messageId: string, newMessage: UserMessageLike): boolean
  remove(messageId: string): boolean
  splice(target: InboxTarget, start: number, deleteCount: number, inserted: readonly UserMessageLike[]): UserMessageLike[]
}

/**
 * Process-local pending work. Durable inbox state is owned by DSH's session
 * projections; this instance is the live view the driver reads.
 */
export class GrokInbox implements InboxContract {
  private readonly queue: Record<InboxTarget, UserMessageLike[]> = { 'next-turn': [], 'next-step': [] }
  /** Announced splices, so the session log records queue movement like the native loop does. */
  private readonly session: SessionLike
  private readonly onChange: ((target: InboxTarget, start: number, removed: number, inserted: readonly UserMessageLike[]) => void) | undefined

  constructor(
    session: SessionLike,
    onChange?: (target: InboxTarget, start: number, removed: number, inserted: readonly UserMessageLike[]) => void,
  ) {
    this.session = session
    this.onChange = onChange
  }

  get nextTurn(): readonly UserMessageLike[] { return this.queue['next-turn'] }
  get nextStep(): readonly UserMessageLike[] { return this.queue['next-step'] }

  clear(): void { this.splice('next-step', 0, this.queue['next-step'].length, []); this.splice('next-turn', 0, this.queue['next-turn'].length, []) }
  append(target: InboxTarget, message: UserMessageLike): void { this.splice(target, this.queue[target].length, 0, [message]) }
  prepend(target: InboxTarget, message: UserMessageLike): void { this.splice(target, 0, 0, [message]) }

  replace(messageId: string, next: UserMessageLike): boolean {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.queue[target].findIndex(item => item.id === messageId)
      if (index >= 0) { this.splice(target, index, 1, [next]); return true }
    }
    return false
  }

  remove(messageId: string): boolean {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.queue[target].findIndex(item => item.id === messageId)
      if (index >= 0) { this.splice(target, index, 1, []); return true }
    }
    return false
  }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: readonly UserMessageLike[]): UserMessageLike[] {
    const list = this.queue[target]
    const removed = list.splice(start, deleteCount, ...inserted)
    this.session.append('agent/inbox/spliced', { target, start, removedCount: removed.length, inserted: [...inserted] })
    this.onChange?.(target, start, removed.length, inserted)
    return removed
  }
}

export type GrokAgentOptions = {
  readonly ctx: Context
  readonly id: SessionId
  readonly session: SessionLike
  readonly options?: AgentOptions
  readonly bind: string
  readonly secret: string
  readonly cwd: string
  readonly modelId?: string
}

/** Result of starting an agent: its native session and the models it offers. */
export type GrokAgentStarted = {
  readonly sessionId: string
  readonly currentModelId: string
  readonly availableModels: readonly { readonly modelId: string; readonly name: string }[]
}

export class GrokAcpAgent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: SessionLike
  readonly inbox: GrokInbox
  readonly ctx: Context

  private readonly client: GrokAcpClient
  private readonly cwd: string
  private readonly modelId: string | undefined
  private current: AgentStatus = 'idle'
  private driving: Promise<void> | undefined
  private abort: AbortController | undefined
  private turnNumber = 0
  private nativeSessionId: string | undefined
  private frames: AcpFrame[] = []
  private idleWaiters: (() => void)[] = []

  constructor(options: GrokAgentOptions) {
    this.id = options.id
    this.ctx = options.ctx
    this.session = options.session
    this.options = options.options ?? {}
    this.cwd = options.cwd
    this.modelId = options.modelId
    this.client = new GrokAcpClient({ bind: options.bind, secret: options.secret })
    this.client.onNotification = frame => this.onFrame(frame)
    this.inbox = new GrokInbox(options.session, target => { if (target === 'next-turn') this.wake() })
  }

  get status(): AgentStatus { return this.current }

  /** Connect and open the native agent session; returns the real model list. */
  async start(): Promise<GrokAgentStarted> {
    await this.client.connect()
    const session = await this.client.newSession(this.cwd)
    this.nativeSessionId = session.sessionId
    return {
      sessionId: session.sessionId,
      currentModelId: session.models.currentModelId,
      availableModels: session.models.availableModels.map(model => ({ modelId: model.modelId, name: model.name })),
    }
  }

  /** Queue one ordinary follow-up turn and wake the driver. */
  followup(message: UserMessageLike): void { this.inbox.append('next-turn', message); this.wake() }

  /** Queue input for the next step; with one step per turn this lands next turn. */
  steer(message: UserMessageLike): void { this.inbox.append('next-step', message); this.wake() }

  /** Queue model-facing context without waking the driver. */
  inject(message: UserMessageLike): void { this.inbox.append('next-step', message) }

  send(message: UserMessageLike, target: InboxTarget, wakeup: boolean): void {
    this.inbox.append(target, message)
    if (wakeup) this.wake()
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    this.abort?.abort(new Error(`grok agent cancelled: ${cause.kind}`))
    void this.client.cancel()
    if (options?.keepInbox !== true) this.inbox.clear()
    this.current = 'idle'
  }

  async whenIdle(): Promise<void> {
    while (this.current !== 'idle' || this.driving !== undefined) {
      await new Promise<void>(resolve => this.idleWaiters.push(resolve))
    }
  }

  /** Run one maintenance task from the idle phase; Grok exposes none today. */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.current !== 'idle') throw new Error('grok agent is not idle')
    return task(new AbortController().signal)
  }

  /** Resolve after the current turn settles; used by tests and shutdown. */
  async settle(): Promise<void> { await this.driving?.catch(() => undefined) }

  private wake(): void {
    if (this.driving !== undefined) return
    if (this.inbox.nextTurn.length === 0 && this.inbox.nextStep.length === 0) return
    this.driving = this.run().finally(() => {
      this.driving = undefined
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const waiter of waiters) waiter()
    })
  }

  private async run(): Promise<void> {
    while (this.inbox.nextTurn.length > 0 || this.inbox.nextStep.length > 0) {
      const claimed = [...this.inbox.nextStep, ...this.inbox.nextTurn]
      this.inbox.splice('next-step', 0, this.inbox.nextStep.length, [])
      this.inbox.splice('next-turn', 0, this.inbox.nextTurn.length, [])
      await this.turn(claimed)
      if (this.current === 'idle') break
    }
    this.current = 'idle'
  }

  private async turn(messages: readonly UserMessageLike[]): Promise<void> {
    this.current = 'running'
    const turn = ++this.turnNumber
    const abort = new AbortController()
    this.abort = abort

    const text = messages
      .flatMap(message => message.content)
      .map(block => (block.type === 'text' ? block.text ?? '' : ''))
      .join('')
      .trim()
    if (text.length > 0) {
      this.session.append('user/message', {
        turn,
        message: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { source: 'user' } },
      })
    }

    this.frames = []
    try {
      await this.client.prompt(text, this.modelId)
    } catch (error) {
      if (!abort.signal.aborted) {
        this.session.append('turn/end', { turn, reason: String(error) })
      }
      this.current = 'idle'
      this.abort = undefined
      return
    }

    const events: ProjectionEvent[] = projectTurn(this.frames, { turn })
    this.frames = []
    if (!abort.signal.aborted) {
      for (const event of events) this.session.append(event.type, event.payload)
    }
    this.current = 'idle'
    this.abort = undefined
  }

  private onFrame(frame: AcpFrame): void {
    if (frame.method === 'session/update') this.frames.push(frame)
  }

  /** Native session identity, for a host that wants to resume it. */
  get nativeSession(): string | undefined { return this.nativeSessionId }

  dispose(): void { this.client.close() }
}