/**
 * A foreign session's model request, answered in place.
 *
 * When a session this plugin does not drive picks one of our models, its
 * native step still assembles the request and hands it to the catalog
 * adapter. Instead of moving the conversation anywhere, the adapter borrows
 * the external agent as a model: one external conversation per DSH session,
 * primed with the transcript on first contact, then fed only the increments,
 * and its answer translated into the loop's own chunk vocabulary so the
 * reply lands in this session, this turn, this UI — nothing moves.
 *
 * What the gateway deliberately does not do: write the session log (the
 * native loop writes the assistant message from the chunks — that is its job
 * for every model), and translate the external agent's tools into harness
 * tool calls (two tool systems with two schemas; pretending to bridge them
 * would lie about who executed what).
 */

import { planFeed } from './gateway-feed.ts'
import type { FeedCursor } from './gateway-feed.ts'
import type { AcpSession } from './registry.ts'
import type { TurnContext, StepDecisionLike, TurnStreamHandle } from './dispatch.ts'

/** The step endings that reach the gateway, as the runner reports them. */
export type GatewayStepEnd =
  | { readonly kind: 'completed' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'aborted'; readonly reason?: unknown }
  | { readonly kind: 'error'; readonly error?: { readonly message?: string } }
  | { readonly kind: string; readonly [extra: string]: unknown }

/** The chunk vocabulary the native loop assembles a message from. */
export type GatewayChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: 'text' | 'reasoning' }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
    readonly type: 'block-end'
    readonly index: number
    readonly block: { readonly type: 'text' | 'reasoning'; readonly text: string }
  }
  | {
    readonly type: 'finish'
    readonly reason:
      | { readonly kind: 'stop' }
      | { readonly kind: 'max-tokens' }
      | { readonly kind: 'aborted'; readonly failure: { readonly message: string } }
      | { readonly kind: 'error'; readonly failure: { readonly message: string } }
  }

export type GatewaySink = { readonly chunk: (chunk: GatewayChunk) => void }

/**
 * A push-side queue the adapter's stream pulls from.
 *
 * The gateway answers by pushing chunks as the agent works; the loop consumes
 * an async iterable. Closing resolves the drained iteration; closing with an
 * error ends it with that error after every queued chunk was still delivered —
 * partial text is not lost just because the answer failed at the end.
 */
export class GatewayChunkQueue {
  private readonly chunks: GatewayChunk[] = []
  private waiters: (() => void)[] = []
  private error: unknown
  private closed = false

  push(chunk: GatewayChunk): void {
    if (this.closed) return
    this.chunks.push(chunk)
    this.flush()
  }

  close(error?: unknown): void {
    if (this.closed) return
    this.closed = true
    this.error = error
    this.flush()
  }

  private flush(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }

  async *iterate(): AsyncGenerator<GatewayChunk> {
    while (true) {
      const chunk = this.chunks.shift()
      if (chunk !== undefined) {
        yield chunk
        continue
      }
      if (this.closed) {
        if (this.error !== undefined) throw this.error
        return
      }
      await new Promise<void>(resolve => { this.waiters.push(resolve) })
    }
  }
}

/**
 * The turn's stream, translated.
 *
 * The runner pushes text and reasoning as they arrive; the loop needs them
 * wrapped in a block lifecycle with the finish strictly last. Text and
 * reasoning each own one block — interleaved deltas continue their own block,
 * the same slot discipline the assistant stream uses.
 */
export class GatewayChunkStream {
  private readonly blocks: { blockType: 'text' | 'reasoning'; index: number; text: string }[] = []
  private readonly byKind = new Map<'text' | 'reasoning', { blockType: 'text' | 'reasoning'; index: number; text: string }>()
  private readonly sink: GatewaySink

  // No constructor parameter property: the web host loads this module through
  // Node's strip-only TypeScript mode, which rejects them at import time.
  constructor(sink: GatewaySink) {
    this.sink = sink
  }

  /** The handle the runner's turn context expects; lifecycle extras are no-ops. */
  port(): TurnStreamHandle {
    return {
      start: () => {},
      textDelta: text => { this.push('text', text) },
      reasoningDelta: text => { this.push('reasoning', text) },
      records: () => [],
      settle: () => {},
      abandon: () => {},
    }
  }

  private push(kind: 'text' | 'reasoning', text: string): void {
    if (text === '') return
    let block = this.byKind.get(kind)
    if (block === undefined) {
      block = { blockType: kind, index: this.blocks.length, text: '' }
      this.blocks.push(block)
      this.byKind.set(kind, block)
      this.sink.chunk({ type: 'block-start', index: block.index, blockType: kind })
    }
    block.text += text
    this.sink.chunk(kind === 'text'
      ? { type: 'text-delta', index: block.index, text }
      : { type: 'reasoning-delta', index: block.index, text })
  }

  /** Close the open blocks and finish, mapping the step ending. */
  finish(end: GatewayStepEnd): void {
    for (const block of [...this.blocks].sort((a, b) => a.index - b.index)) {
      this.sink.chunk({ type: 'block-end', index: block.index, block: { type: block.blockType, text: block.text } })
    }
    this.sink.chunk({ type: 'finish', reason: this.finishReason(end) })
  }

  private finishReason(end: GatewayStepEnd): GatewayChunk extends { type: 'finish'; reason: infer R } ? R : never {
    if (end.kind === 'completed') return { kind: 'stop' } as never
    if (end.kind === 'max-tokens') return { kind: 'max-tokens' } as never
    if (end.kind === 'aborted') {
      return {
        kind: 'aborted',
        failure: { message: typeof end.reason === 'string' ? end.reason : 'the external answer was stopped' },
      } as never
    }
    const failure = (end as { error?: { message?: string } }).error
    return {
      kind: 'error',
      failure: { message: end.kind === 'error' ? failure?.message ?? 'the external agent failed' : `the external turn ended as ${end.kind}` },
    } as never
  }
}

/** How the gateway opens the external conversation for a DSH session. */
export type GatewayOpen = (presetId: string, options: {
  readonly dshSessionId: string
  readonly primer: {
    take(sessionId: string): string | undefined
    restore(sessionId: string, text: string): void
  }
}) => Promise<AcpSession>

export type GatewayAnswerRequest = {
  /** The loop's derived history for this step, exactly as the adapter got it. */
  readonly messages: readonly unknown[]
  readonly modelId?: string
  readonly reasoningEffort?: string
  readonly signal?: AbortSignal
  readonly position: { readonly turn: number; readonly step: number }
}

type Entry = {
  session: AcpSession | undefined
  cursor: FeedCursor | undefined
  primerText: string | undefined
  tail: Promise<unknown>
}

/**
 * The gateway itself: per-session external conversations, serialized prompts,
 * cursors that only advance on answers the session actually got.
 */
export class GatewayConversations {
  private readonly entries = new Map<string, Entry>()
  private readonly open: GatewayOpen
  private readonly report: (message: string) => void

  // Plain assignments, not parameter properties — same strip-only reason as
  // above; this module is host-loaded without a transpiler.
  constructor(open: GatewayOpen, report: (message: string) => void = () => {}) {
    this.open = open
    this.report = report
  }

  /** Answer one request in place; chunks reach the sink as the agent works. */
  answer(sessionId: string, presetId: string, request: GatewayAnswerRequest, sink: GatewaySink): Promise<void> {
    let entry = this.entries.get(sessionId)
    if (entry === undefined) {
      entry = { session: undefined, cursor: undefined, primerText: undefined, tail: Promise.resolve() }
      this.entries.set(sessionId, entry)
    }
    const run = entry.tail.catch(() => {}).then(async () => {
      await this.answerOnce(entry as Entry, sessionId, presetId, request, sink)
    })
    entry.tail = run
    return run
  }

  private async answerOnce(
    entry: Entry,
    sessionId: string,
    presetId: string,
    request: GatewayAnswerRequest,
    sink: GatewaySink,
  ): Promise<void> {
    const plan = planFeed(request.messages, entry.cursor)
    if (plan.kind === 'nothing') {
      throw new Error(`acp gateway: ${plan.reason} (session ${sessionId})`)
    }
    // The primer is set before anything runs: the runner's seam takes it when
    // the first prompt goes out and restores it if that prompt fails, so the
    // conversation is never silently continued without the history it was
    // promised.
    if (plan.kind === 'first' && plan.primer !== '') entry.primerText = plan.primer
    if (entry.session === undefined) {
      entry.session = await this.open(presetId, {
        dshSessionId: sessionId,
        primer: {
          take: id => {
            if (id !== sessionId) return undefined
            const text = entry.primerText
            entry.primerText = undefined
            return text
          },
          restore: (id, text) => { if (id === sessionId) entry.primerText = text },
        },
      })
    }
    const stream = new GatewayChunkStream(sink)
    // The catalog adapter has no step numbers of its own (GenerateOptions
    // carries none), so position degrades to a zero placeholder rather than
    // crashing the runner's card bookkeeping — the gateway writes nothing
    // durable anyway, the native loop owns placement.
    const position = request.position ?? { turn: 0, step: 0 }
    const decision: StepDecisionLike = {
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: plan.prompt }] }],
    }
    const turn = {
      sessionId,
      position,
      // The native loop owns the durable write; the gateway writes nothing.
      produce: () => [],
      write: () => 1,
      openStream: () => stream.port(),
      ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      ...(request.signal === undefined ? {} : { abort: () => request.signal }),
    } as unknown as TurnContext
    // The runner reports a whole step result; its `end` is the part that
    // maps onto a finish chunk.
    const result = await entry.session.run(decision, turn) as unknown as { end: GatewayStepEnd }
    const end = result.end
    stream.finish(end)
    if (end.kind === 'completed' || end.kind === 'max-tokens') {
      entry.cursor = plan.cursor
    } else if (end.kind !== 'aborted') {
      this.report(`acp gateway: session ${sessionId}'s in-place answer ended as ${end.kind}`)
    }
  }

  /** Drop one session's conversation; its next request starts over primed. */
  close(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return
    this.entries.delete(sessionId)
    if (entry.session !== undefined) entry.session.close()
  }
}
