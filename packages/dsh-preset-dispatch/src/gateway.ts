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
import { makeToolOnlyWriter } from './content-writer.ts'
import type { SessionAppend } from './content-writer.ts'
import type { AcpSession } from './registry.ts'
import type { TurnContext, StepDecisionLike, StepPosition, TurnStreamHandle } from './dispatch.ts'

/** The step endings that reach the gateway, as the runner reports them. */
export type GatewayStepEnd =
  | { readonly kind: 'completed' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'aborted'; readonly reason?: unknown }
  | { readonly kind: 'error'; readonly error?: { readonly message?: string; readonly code?: string } }
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
      | { readonly kind: 'aborted'; readonly failure: GatewayFailure }
      | { readonly kind: 'error'; readonly failure: GatewayFailure }
  }

/**
 * A terminal failure as the native loop reads it.
 *
 * `code` is required, not optional: the loop rebuilds this into its own typed
 * failure, whose constructor refuses an empty code and would replace the agent's
 * diagnosis with a validation message about its own argument. The runner's code
 * (`ACP_ERROR`, `ACP_CONNECTION`, `ACP_PERMISSION`, `ACP_INTERNAL`,
 * `REPLAY_REJECTED`) rides through verbatim, so the row keeps saying what went
 * wrong and whether resending will help.
 */
type GatewayFailure = {
  readonly message: string
  readonly code: string
}

/** The code a failure the runner did not classify reports itself under. */
const UNCLASSIFIED_CODE = 'ACP_ERROR'

/**
 * How long one in-place answer may run before the gateway ends the turn as an
 * error itself. The observed failure (2026-10-16 session 03067bcc) was a
 * backend wedged in its own retry loop: the turn stayed open for hours with
 * the UI silent, because nothing but the external agent could end it. The
 * gateway owns a deadline so a hung answer becomes a bounded one. Zero
 * disables it.
 */
const DEFAULT_ANSWER_TIMEOUT_MS = 600_000

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
        failure: {
          message: typeof end.reason === 'string' ? end.reason : 'the external answer was stopped',
          // The loop recognizes this one code as an abort rather than a fault
          // (reference `adapterFailureChunk`), so a stopped answer stops instead
          // of being reported as an error worth retrying.
          code: 'ABORTED',
        },
      } as never
    }
    const error = (end as { error?: { message?: string; code?: unknown } }).error
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : UNCLASSIFIED_CODE
    return {
      kind: 'error',
      failure: {
        message: end.kind === 'error' ? error?.message ?? 'the external agent failed' : `the external turn ended as ${end.kind}`,
        code,
      },
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

/**
 * The session's log writer, resolved per DSH session.
 *
 * Absent when the host composes no session store; the answer still goes out,
 * only the tool events have nowhere to land.
 * @param sessionId - the DSH session the in-place answer belongs to.
 * @returns the session's append, or undefined when no live session has that id.
 */
export type GatewaySessionAppend = (sessionId: string) => SessionAppend | undefined

export type GatewayAnswerRequest = {
  /** The loop's derived history for this step, exactly as the adapter got it. */
  readonly messages: readonly unknown[]
  readonly modelId?: string
  readonly reasoningEffort?: string
  readonly signal?: AbortSignal
  /**
   * The open turn and step, for a caller that already knows them. The gateway
   * resolves this from the loop's own announcement by default (see the
   * `positionOf` dependency); a number supplied here is a last resort and is
   * only written when it is a real position, never invented.
   */
  readonly position?: { readonly turn: number; readonly step: number }
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
  private readonly sessionAppend: GatewaySessionAppend | undefined
  private readonly positionOf: ((sessionId: string) => StepPosition | undefined) | undefined
  private readonly answerTimeoutMs: number | ((presetId: string) => number | undefined) | undefined

  // Plain assignments, not parameter properties — same strip-only reason as
  // above; this module is host-loaded without a transpiler.
  constructor(
    open: GatewayOpen,
    report: (message: string) => void = () => {},
    sessionAppend?: GatewaySessionAppend,
    positionOf?: (sessionId: string) => StepPosition | undefined,
    answerTimeoutMs?: number | ((presetId: string) => number | undefined),
  ) {
    this.open = open
    this.report = report
    this.sessionAppend = sessionAppend
    this.positionOf = positionOf
    this.answerTimeoutMs = answerTimeoutMs
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
    // The catalog adapter carries no step numbers (GenerateOptions has no such
    // field), so the open turn and step come from what the loop announced for
    // this session. That number is not decoration: the session log checks a
    // tool/call against the turn and step open when it was written, and the
    // check runs when the session is OPENED. A zero placeholder used to pass
    // unnoticed because the live view places a card by where the event sits
    // between the loop's own boundaries — and then made the whole log
    // permanently unloadable. With no position there is nothing honest to
    // write, so this answers without tool events and says so.
    const position = this.positionOf?.(sessionId) ?? request.position
    const decision: StepDecisionLike = {
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: plan.prompt }] }],
    }
    // The loop writes the assistant message from the chunks it assembles. The
    // runner's tool events are the ones nothing up there can see, so this is
    // where they are written — through a writer that leaves the message alone.
    const append = this.sessionAppend?.(sessionId)
    if (position === undefined) {
      this.report(`acp gateway: session ${sessionId} answered with no open turn/step known — tool events skipped, transcript keeps the answer`)
    }
    // The gateway owns this answer's cancellation: the deadline below ends
    // the turn through this controller, and an external abort (the loop
    // stopping the session) is forwarded into it, so the runner watches one
    // signal either way.
    const controller = new AbortController()
    request.signal?.addEventListener('abort', () => controller.abort())
    const configured = typeof this.answerTimeoutMs === 'function' ? this.answerTimeoutMs(presetId) : this.answerTimeoutMs
    const timeoutMs = configured ?? DEFAULT_ANSWER_TIMEOUT_MS
    const turn = {
      sessionId,
      position,
      produce: () => [],
      write: append === undefined || position === undefined ? () => 1 : makeToolOnlyWriter(append),
      openStream: () => stream.port(),
      abort: () => controller.signal,
      ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    } as unknown as TurnContext
    // The runner reports a whole step result; its `end` is the part that
    // maps onto a finish chunk. The deadline races it: a backend wedged in
    // its own retry loop never returns, and without this race the turn — and
    // every later answer serialized behind it — would wait forever.
    const run = entry.session.run(decision, turn) as Promise<unknown>
    run.catch(() => {}) // a late rejection from an already-ended turn must not crash the host
    const result = await new Promise<{ end: GatewayStepEnd }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (value: { end: GatewayStepEnd }): void => {
        if (timer !== undefined) clearTimeout(timer)
        resolve(value)
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.report(`acp gateway: session ${sessionId} answer timed out after ${timeoutMs}ms — ending the turn as error`)
          controller.abort()
          done({
            end: {
              kind: 'error',
              error: { message: `answer timed out after ${timeoutMs}ms`, code: 'ACP_TIMEOUT' },
            },
          })
        }, timeoutMs)
      }
      run.then(
        value => done(value as { end: GatewayStepEnd }),
        reject,
      )
    })
    const end = result.end
    stream.finish(end)
    if (end.kind === 'completed' || end.kind === 'max-tokens') {
      entry.cursor = plan.cursor
    } else if (end.kind !== 'aborted') {
      this.report(`acp gateway: session ${sessionId}'s in-place answer ended as ${end.kind}`)
    }
    // ACP_CONNECTION's message promises the next request opens a fresh external
    // conversation. Keeping the entry would break that promise twice over: the
    // retry reuses a transport whose process is wedged or dead (2026-10-16
    // session f60dcf2b: three identical 60s handshake timeouts in a row), and
    // the wedged child itself leaks until dsh restarts. Drop the whole entry —
    // close() also kills the child — so the next request reopens and re-primes.
    // Other error codes keep the conversation: an agent-side failure leaves a
    // live session, and continuing it spares the full-history primer.
    if (end.kind === 'error' && (end.error as { code?: string } | undefined)?.code === 'ACP_CONNECTION') {
      this.close(sessionId)
      this.report(`acp gateway: session ${sessionId}'s connection-class failure dropped the external conversation — the next request opens a fresh one`)
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
