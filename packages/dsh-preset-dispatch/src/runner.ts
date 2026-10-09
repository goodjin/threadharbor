/**
 * Driving one session's turns against a real ACP agent.
 *
 * The session is opened once and reused. `session/new` is expensive — codex and
 * grok both load a model catalogue and probe their environment during it — and a
 * DSH session is long-lived, so re-opening per turn would charge every turn a
 * setup the agent already paid.
 */

import type { AcpStepResult, StepDecisionLike, StepEndReason } from './dispatch.ts'

/** The JSON-RPC surface this runner needs, kept narrow so it can be stood in for. */
export type AcpClientPort = {
  request(method: string, params: unknown): Promise<unknown>
  notify(method: string, params: unknown): void
  /**
   * Register the sink for frames as they arrive.
   *
   * Per frame, not per batch: a delta has to reach the UI while the agent is
   * still working. Replaying collected frames afterwards is exactly the
   * "wait, then it all appears" behaviour streaming exists to remove.
   */
  onFrame(handler: (frame: unknown) => void): void
}

/** Where a turn's text and reasoning go as they arrive. */
export type TurnStreamPort = {
  textDelta(text: string): void
  reasoningDelta(text: string): void
}

/** How to reach an agent, and where its work happens. */
export type RunnerOptions = {
  readonly cwd: string
  /** Open the live stream for a turn. Omit to run without streaming. */
  readonly openStream?: () => TurnStreamPort
  /** Applied once, before the first turn; claude needs `default` to ask at all. */
  readonly modeId?: string
  readonly modelId?: string
}

type UserText = { readonly role?: unknown; readonly content?: unknown }

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOf(content: unknown): string {
  const entry = recordOf(content)
  if (typeof entry['text'] === 'string') return entry['text']
  const nested = recordOf(entry['content'])
  return typeof nested['text'] === 'string' ? nested['text'] : ''
}

/** Pull the user-authored text out of a step decision's messages. */
function promptText(messages: readonly unknown[]): string {
  const parts: string[] = []
  for (const message of messages as readonly UserText[]) {
    if (message.role !== undefined && message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') { parts.push(content); continue }
    if (!Array.isArray(content)) continue
    for (const block of content as { type?: unknown; text?: unknown }[]) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Map the agent's own stopping reason onto the loop's vocabulary.
 *
 * Only an ordinary end is `completed`. Anything else is reported under its own
 * kind so the turn closes as what actually happened rather than as a success.
 */
function toEndReason(stopReason: unknown): StepEndReason {
  switch (stopReason) {
    case 'end_turn':
    case undefined:
      return { kind: 'completed' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', reason: 'the agent reported the turn cancelled' }
    default:
      return { kind: 'blocked', reason: stopReason }
  }
}

export class AcpTurnRunner {
  private sessionId: string | undefined
  private opening: Promise<string> | undefined
  private turnFrames: unknown[] = []
  private stream: TurnStreamPort | undefined

  private readonly client: AcpClientPort
  private readonly options: RunnerOptions

  constructor(client: AcpClientPort, options: RunnerOptions) {
    this.client = client
    this.options = options
    // Registered once, here, rather than at the start of each turn: a frame
    // arriving between turns must not be dropped, and a handler installed
    // mid-turn misses whatever arrived before it.
    this.client.onFrame(frame => this.observe(frame))
  }

  /** Take one frame: keep it for projection, and stream its text immediately. */
  private observe(frame: unknown): void {
    this.turnFrames.push(frame)
    if (this.stream === undefined) return
    const update = recordOf(recordOf(recordOf(frame)['params'])['update'])
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') return
    const text = textOf(update['content'])
    if (text.length === 0) return
    if (kind === 'agent_thought_chunk') this.stream.reasoningDelta(text)
    else this.stream.textDelta(text)
  }

  /**
   * Run one turn.
   *
   * Failures propagate on purpose: the replacement step lets them reach the
   * loop's own error handling, which closes the turn as an error. Returning
   * something empty instead would show the user an agent that merely had nothing
   * to say.
   */
  async run(decision: StepDecisionLike): Promise<AcpStepResult> {
    const sessionId = await this.open()
    this.turnFrames = []
    this.stream = this.options.openStream?.()

    const text = promptText(decision.messages)
    const params: Record<string, unknown> = {
      sessionId,
      prompt: [{ type: 'text', text }],
    }
    if (this.options.modelId !== undefined) params['modelId'] = this.options.modelId
    const reply = await this.client.request('session/prompt', params)
    const stopReason = (reply as { stopReason?: unknown } | null)?.stopReason

    this.stream = undefined
    return { frames: [...this.turnFrames], end: toEndReason(stopReason) }
  }

  /** Open once, and remember — including when the first attempt failed. */
  private open(): Promise<string> {
    if (this.sessionId !== undefined) return Promise.resolve(this.sessionId)
    this.opening ??= this.doOpen().then(
      sessionId => { this.sessionId = sessionId; this.opening = undefined; return sessionId },
      error => { this.opening = undefined; throw error },
    )
    return this.opening
  }

  private async doOpen(): Promise<string> {
    await this.client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
    this.client.notify('initialized', {})
    const reply = (await this.client.request('session/new', {
      cwd: this.options.cwd,
      mcpServers: [],
    })) as { sessionId?: unknown } | null
    if (typeof reply?.sessionId !== 'string') {
      throw new Error('acp session/new returned no sessionId')
    }
    if (this.options.modeId !== undefined) {
      await this.client.request('session/set_mode', { sessionId: reply.sessionId, modeId: this.options.modeId })
    }
    return reply.sessionId
  }
}