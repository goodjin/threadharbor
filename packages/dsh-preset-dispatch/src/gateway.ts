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

import { randomUUID } from 'node:crypto'

import { planFeed } from './gateway-feed.ts'
import type { FeedCursor } from './gateway-feed.ts'
import { makeToolOnlyWriter } from './content-writer.ts'
import type { SessionAppend } from './content-writer.ts'
import type { AcpSession } from './registry.ts'
import type { TurnContext, StepDecisionLike, StepPosition, TurnStreamHandle, AcpStepResult, ContentEvent } from './dispatch.ts'
import { systemNoteEvent } from '@threadharbor/dsh-acp-agent'

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
 * Default frame-silence deadline: a turn whose agent sends no frame for this
 * long ends as an error, whatever its process is still doing. The observed
 * failure (2026-10-16 session 03067bcc) was a backend wedged in its own retry
 * loop: the turn stayed open for hours with the UI silent, because nothing
 * but the external agent could end it. Zero disables it.
 */
const DEFAULT_STALL_MS = 120_000

/**
 * Default absolute cap on one answer, however chatty the agent stays. The
 * silence watchdog cannot end a turn that streams forever; this one can.
 * Zero disables it.
 */
const DEFAULT_TOTAL_MS = 1_800_000

/**
 * How long a user stop waits for the agent to settle on its own before the
 * gateway kills the process and drops the conversation. The stop must show
 * immediately either way; the grace only decides the process's fate.
 * Zero kills at once.
 */
const DEFAULT_GRACE_MS = 3_000

/**
 * Default frame-silence threshold for the one status note written mid-turn
 * ("still waiting — last output was …"). Disabled when `0`, and moot when it
 * is not strictly below the stall deadline.
 */
const DEFAULT_WARN_MS = 30_000

/** Watchdog limits one preset may override; absent fields use the defaults. */
export type GatewayLimits = {
  /** Frame-silence deadline — see `stallMs` on the preset config. */
  readonly stallMs?: number
  /** Absolute cap on one answer, however chatty — `totalMs` on the preset. */
  readonly totalMs?: number
  /** Frame-silence threshold for the one status note — `warnMs` on the preset. */
  readonly warnMs?: number
  /** Post-stop grace before the kill — `graceMs` on the preset. */
  readonly graceMs?: number
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
 * wrapped in a block lifecycle with the finish strictly last. Blocks follow
 * arrival order — a switch between text and reasoning opens the next block,
 * same-kind deltas keep writing the current one — the same block order the
 * assistant stream and native model streams use. Per-kind slots would fold a
 * mid-turn thought back onto the text block's index, above text already on
 * screen.
 */
export class GatewayChunkStream {
  private readonly blocks: { blockType: 'text' | 'reasoning'; index: number; text: string }[] = []
  /** The block same-kind deltas are writing; replaced by a fresh one on a switch. */
  private current: { blockType: 'text' | 'reasoning'; index: number; text: string } | undefined
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
    if (this.current === undefined || this.current.blockType !== kind) {
      this.current = { blockType: kind, index: this.blocks.length, text: '' }
      this.blocks.push(this.current)
      this.sink.chunk({ type: 'block-start', index: this.current.index, blockType: kind })
    }
    this.current.text += text
    this.sink.chunk(kind === 'text'
      ? { type: 'text-delta', index: this.current.index, text }
      : { type: 'reasoning-delta', index: this.current.index, text })
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
  /**
   * Set while a user stop's grace window is open and the stopped run has not
   * settled: the conversation that run still floats on. A request arriving
   * inside the window must NOT reuse it — two runs in one runner reset each
   * other's abort/drop state, and the floating run's late frames would land
   * in the new turn (final review 2026-10-16: cross-turn content bleed).
   * Cleared when the run settles (the conversation is healthy again) or when
   * the grace kills it.
   */
  stopping: AcpSession | undefined
}

/**
 * The gateway itself: per-session external conversations, serialized prompts,
 * cursors that advance when a prompt is delivered to the external
 * conversation — a turn that later errors does not re-feed what it sent.
 */
export class GatewayConversations {
  private readonly entries = new Map<string, Entry>()
  private readonly open: GatewayOpen
  private readonly report: (message: string) => void
  private readonly sessionAppend: GatewaySessionAppend | undefined
  private readonly positionOf: ((sessionId: string) => StepPosition | undefined) | undefined
  private readonly limits: ((presetId: string) => GatewayLimits) | undefined
  private readonly produceOf: ((presetId: string) => ((result: AcpStepResult, position: StepPosition) => readonly ContentEvent[]) | undefined) | undefined

  // Plain assignments, not parameter properties — same strip-only reason as
  // above; this module is host-loaded without a transpiler.
  constructor(
    open: GatewayOpen,
    report: (message: string) => void = () => {},
    sessionAppend?: GatewaySessionAppend,
    positionOf?: (sessionId: string) => StepPosition | undefined,
    limits?: (presetId: string) => GatewayLimits,
    produceOf?: (presetId: string) => ((result: AcpStepResult, position: StepPosition) => readonly ContentEvent[]) | undefined,
  ) {
    this.open = open
    this.report = report
    this.sessionAppend = sessionAppend
    this.positionOf = positionOf
    this.limits = limits
    this.produceOf = produceOf
  }

  /** One preset's watchdog limits, defaults unfilled so `??` stays meaningful. */
  private limitsOf(presetId: string): GatewayLimits {
    return this.limits?.(presetId) ?? {}
  }

  /** Answer one request in place; chunks reach the sink as the agent works. */
  answer(sessionId: string, presetId: string, request: GatewayAnswerRequest, sink: GatewaySink): Promise<void> {
    let entry = this.entries.get(sessionId)
    if (entry === undefined) {
      entry = { session: undefined, cursor: undefined, primerText: undefined, tail: Promise.resolve(), stopping: undefined }
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
    // A stop's grace window is still open: the conversation below still has a
    // run floating on it. Reusing it would run two turns in one runner — the
    // floating run's late frames would write into this new turn. Drop the old
    // conversation now (its runner's abort state already discards late frames)
    // and open fresh below.
    if (entry.stopping !== undefined) {
      const stale = entry.stopping
      entry.stopping = undefined
      entry.session = undefined
      stale.close()
      this.report(`acp gateway: session ${sessionId} reopened inside a stop's grace — the floating conversation was dropped`)
    }
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
    // The gateway owns this answer's cancellation: the deadline below ends
    // the turn through this controller, and an external abort (the loop
    // stopping the session) is forwarded into it, so the runner watches one
    // signal either way.
    const controller = new AbortController()
    const limits = this.limitsOf(presetId)
    const graceMs = limits.graceMs ?? DEFAULT_GRACE_MS
    const configured = limits.stallMs
    const timeoutMs = configured ?? DEFAULT_STALL_MS
    const totalMs = limits.totalMs ?? DEFAULT_TOTAL_MS
    // 子代理在跑时静默看门狗的容忍上限：从「最后一次信号」起算，最多安静这么久。
    // 取一个回合自己的预算那么多（总上限关掉时取默认的 30 分钟）。子代理真卡死
    // 时兜底仍在——只是多等这一段；子代理还在报东西时，这段从头再算。
    const stallHoldLimitMs = totalMs > 0 ? totalMs : DEFAULT_TOTAL_MS
    // The deadline is an IDLE deadline, not a total-duration cap: every
    // streamed chunk and every tool write re-arms it. A turn may legitimately
    // run for hours while it keeps producing (2026-10-16 session 03067bcc:
    // grok turns 8/11/12 died at exactly 600s mid-thought under the old cap,
    // and the user had to switch agents); what it may not do is go silent —
    // a backend wedged in its own retry loop never returns, and without this
    // watch the turn — and every later answer serialized behind it — would
    // wait forever.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let totalTimer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setInterval> | undefined
    // The total cap's clock. While the external agent waits on its OWN
    // delegated runs (its subagents, its background tasks) the clock is held:
    // that wait is not this turn's own time, and ending the turn there says
    // "wedged" about work that is still running — 2026-10-20 session
    // 7165a323: codex spawned 5 subagents and waited for them; the 30-minute
    // cap fired, the parent turn ended as ACP_TIMEOUT, all five results were
    // lost, and the UI showed a timed-out parent next to children still
    // running. The remaining budget is kept, not spent, so the cap still
    // applies to the time the turn actually spends on its own.
    let totalDeadlineAt = 0
    let totalRemainingMs: number | undefined = undefined
    // 静默看门狗当前用的是哪个期限：外部 agent 在等自己的子代理时用更长的
    // 那一个（见 stallHoldLimitMs），子代理收尾后换回原来的。
    let stallHeld = false
    let settled = false
    // Set the moment the answer settles: the loop then closes the step, and a
    // write arriving after it lands outside every open step — the runner's
    // floating run may still try its turn-end write long after a watchdog or a
    // user stop ended the turn. Those writes are refused here; the cards'
    // closing results are the stop listener's job, written before this.
    let answerEnded = false
    let warned = false
    let lastActivityWall = Date.now()
    let lastSeenFrameAt = entry.session?.diagnostics().lastFrameAt ?? Date.now()
    let settle!: (value: { end: GatewayStepEnd }) => void
    const stderrTailNow = (): readonly string[] => entry.session?.diagnostics().stderrTail ?? []
    /** The tail block every forced ending carries, so「为什么停」self-explains. */
    const tailLines = (): string => {
      const lines = stderrTailNow().slice(-5).map(line => (line.length > 200 ? `${line.slice(0, 200)}…` : line))
      return lines.length === 0 ? '（无）' : lines.join('\n')
    }
    /**
     * 挂静默看门狗：期限从「最后一次信号」起算。
     *
     * 期限有两个：平时是 `stallMs`；外部 agent 在等自己的子代理时用更长的
     * `stallHoldLimitMs`。两者都从最后一次信号起算——子代理只要还报东西，
     * 静默的钟就重新开始，所以这不是「等一个固定时间」，而是「最多安静多久」。
     */
    const armStall = (limitMs: number): void => {
      if (settled || timeoutMs <= 0) return
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      const silentForMs = Date.now() - lastActivityWall
      deadlineTimer = setTimeout(fireStall, Math.max(0, limitMs - silentForMs))
    }
    const fireStall = (): void => {
      // 外部 agent 在等自己的子代理：连接安静不等于卡死——子代理可能正在安静
      // 干活（2026-10-20 与总上限同族：父会话等子代理时被静默看门狗按超时收
      // 尾，子会话还在跑）。给这段安静更长的容忍度，且从最后一次信号起算：
      // 子代理还在报东西就一直等，一直不报才按卡死收场——兜底仍在。
      if (delegatedLive() > 0) {
        const silentForMs = Date.now() - lastActivityWall
        if (silentForMs < stallHoldLimitMs) {
          armStall(stallHoldLimitMs)
          this.report(`acp gateway: session ${sessionId} is waiting on ${String(delegatedLive())} delegated run(s) — the silence watchdog tolerates ${String(stallHoldLimitMs)}ms of silence since the last signal`)
          return
        }
      }
      const silentForMs = Date.now() - lastActivityWall
      this.report(`acp gateway: session ${sessionId} answer stalled — no agent activity for ${String(silentForMs)}ms (limit ${String(timeoutMs)}ms) — ending the turn as error`)
      controller.abort()
      done({
        end: {
          kind: 'error',
          error: {
            message: `外部 agent 静默 ${String(Math.round(silentForMs / 1000))}s 无进展，已自动停止并重开新会话。进程处置：已终止；agent 输出尾部：\n${tailLines()}`,
            code: 'ACP_STALLED',
          },
        },
      })
    }
    /** 外部 agent 自己的委托运行（子代理 / 后台任务）还开着几个。 */
    const delegatedLive = (): number => entry.session?.diagnostics().liveDelegatedRuns ?? 0
    /**
     * 总上限的钟：外部 agent 在等自己的子代理时停表，等它们收尾再按剩下的预算继续。
     *
     * 返回 true 表示「现在正在等子代理」，调用方据此不收场。
     */
    const holdTotal = (): boolean => {
      if (totalRemainingMs === undefined) return false
      if (delegatedLive() <= 0) return false
      if (totalTimer !== undefined) {
        clearTimeout(totalTimer)
        totalTimer = undefined
        // 只扣掉已经走掉的那段：等的这段时间不算这一回合自己的预算。
        totalRemainingMs = Math.max(0, totalDeadlineAt - Date.now())
      }
      return true
    }
    /** 子代理收尾后，把总上限的钟按剩下的预算重新挂上。 */
    const resumeTotal = (): void => {
      if (settled || totalTimer !== undefined || totalRemainingMs === undefined) return
      if (delegatedLive() > 0) return
      totalDeadlineAt = Date.now() + totalRemainingMs
      totalTimer = setTimeout(fireTotal, totalRemainingMs)
    }
    const fireTotal = (): void => {
      // 外部 agent 还在等自己的子代理：这一回合没有超时可报。让总上限的钟
      // 停住，等子代理收尾后再按剩下的预算算——把「还在干活」说成「卡住了」
      // 是更糟的错，2026-10-20 会话 7165a323 就是这么把 5 个子代理的结果丢掉的。
      if (holdTotal()) {
        this.report(`acp gateway: session ${sessionId} is waiting on ${String(delegatedLive())} delegated run(s) — the total cap is held until they settle`)
        return
      }
      const silentForMs = Date.now() - lastActivityWall
      this.report(`acp gateway: session ${sessionId} answer exceeded the total cap of ${String(totalMs)}ms — ending the turn as error`)
      controller.abort()
      done({
        end: {
          kind: 'error',
          error: {
            message: `外部 agent 回合超过总上限 ${String(totalMs)}ms，已自动停止并重开新会话。静默 ${String(Math.round(silentForMs / 1000))}s；进程处置：已终止；agent 输出尾部：\n${tailLines()}`,
            code: 'ACP_TIMEOUT',
          },
        },
      })
    }
    const done = (value: { end: GatewayStepEnd }): void => {
      settled = true
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      if (totalTimer !== undefined) clearTimeout(totalTimer)
      if (pollTimer !== undefined) clearInterval(pollTimer)
      totalRemainingMs = undefined
      answerEnded = true
      settle(value)
    }
    const noteActivity = (): void => {
      if (settled || timeoutMs <= 0) return
      lastActivityWall = Date.now()
      armStall(stallHeld ? stallHoldLimitMs : timeoutMs)
    }
    const tappingSink: GatewaySink = { chunk: chunk => { noteActivity(); sink.chunk(chunk) } }
    const stream = new GatewayChunkStream(tappingSink)
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
    const append = this.sessionAppend?.(sessionId)
    // The turn-end projector, resolved once here: a card written live is a
    // promise its result follows at produce time, and without a projector the
    // produce below can only answer []. Cards that can never close must not
    // open — 2026-10-18 session 928fbb8e turns 19-22 wrote 119 of them and
    // made the log permanently unloadable ("step/end leaves unresolved tool
    // call"), because a long-running host was still on the code whose produce
    // was a stub. The transcript keeps the answer either way; only the cards
    // depend on this gate.
    const projector = this.produceOf?.(presetId)
    if (append !== undefined && position !== undefined && projector === undefined) {
      this.report(`acp gateway: preset ${presetId} has no turn-end projector — tool cards stay out of the log for this answer`)
    }
    // Tool writes are activity too: a turn can be mid-tool for a long stretch
    // with no text stream at all, and those cards prove the agent is alive.
    const toolWriter = append === undefined || position === undefined || projector === undefined
      ? undefined
      : makeToolOnlyWriter(append)
    // Any write call is activity, even the no-op path (no session append, no
    // position): it means the runner just handled a frame, which is liveness
    // even when the card itself has nowhere to go.
    const writingTools = (events: readonly { type: string; payload: unknown }[]): number | undefined => {
      noteActivity()
      if (answerEnded) return undefined
      return toolWriter === undefined ? 1 : toolWriter(events)
    }
    if (position === undefined) {
      this.report(`acp gateway: session ${sessionId} answered with no open turn/step known — tool events skipped, transcript keeps the answer`)
    }
    const decision: StepDecisionLike = {
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: plan.prompt }] }],
    }
    const turn = {
      sessionId,
      position,
      // The runner writes live opening cards itself, but a tool's RESULT only
      // exists in the turn-end projection — an empty produce leaves every
      // call unresolved and the session unloadable afterwards (2026-10-17
      // session 423817a9: "step/end leaves unresolved tool call"). So the
      // gateway projects through the preset's dialect and hands the events to
      // the same tool-only writer, which keeps the announcements honest.
      produce: (result: AcpStepResult) => {
        const project = this.produceOf?.(presetId)
        if (project === undefined || position === undefined) return []
        return project(result, position)
      },
      write: writingTools,
      openStream: () => stream.port(),
      abort: () => controller.signal,
      ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    } as unknown as TurnContext
    // Delivery anchors the cursor: once run() hands the prompt to the
    // external conversation, those user texts live in its history for good —
    // a turn that later errors must not re-feed them (2026-10-16 session
    // 03067bcc: a re-sent approval arrived at the agent twice). A failure
    // BEFORE this point — the open handshake above — still leaves the cursor
    // where it was, so a question never sent is asked in full next time.
    entry.cursor = plan.cursor
    const run = entry.session.run(decision, turn) as Promise<unknown>
    run.catch(() => {}) // a late rejection from an already-ended turn must not crash the host
    // The total cap bounds one answer however chatty it is. It is armed once at
    // delivery and never re-armed — EXCEPT while the external agent waits on
    // its own delegated runs: that wait is held out of the budget (see
    // holdTotal), so the cap still measures the time this turn spends on its
    // own work.
    if (totalMs > 0) {
      totalRemainingMs = totalMs
      totalDeadlineAt = Date.now() + totalMs
      totalTimer = setTimeout(fireTotal, totalMs)
    }
    // The frame beacon watches the one signal neither the chunk tap nor the
    // tool writes can see: an agent whose process stays alive but answers
    // nothing (2026-10-16 codex — "tls handshake eof" on stderr, zero frames,
    // every stop press swallowed for ten minutes). stderr deliberately does
    // NOT count as activity here; it only feeds the note and the package.
    //
    // The same poll carries the total cap's hold: while the external agent
    // waits on its own delegated runs, the cap's clock is stopped, and it
    // starts again with the remaining budget once they settle. Without it the
    // cap fires mid-wait and the children lose their results (2026-10-20
    // session 7165a323).
    if (timeoutMs > 0 || totalMs > 0) {
      const warnMs = limits.warnMs ?? DEFAULT_WARN_MS
      const pollMs = Math.min(1_000, Math.max(200, Math.floor((timeoutMs > 0 ? timeoutMs : totalMs) / 4)))
      pollTimer = setInterval(() => {
        if (settled) return
        if (totalRemainingMs !== undefined) {
          if (delegatedLive() > 0) holdTotal()
          else resumeTotal()
        }
        // 静默看门狗的期限跟着子代理走：子代理开着就用长的那个（从最后一次信号
        // 起算），子代理收尾后换回原来的那个。子代理还在报东西时，静默的钟
        // 每次都重新开始——所以这不是「等一个固定时间」。
        if (delegatedLive() > 0 && !stallHeld) {
          stallHeld = true
          armStall(stallHoldLimitMs)
        } else if (delegatedLive() === 0 && stallHeld) {
          stallHeld = false
          armStall(timeoutMs)
        }
        if (timeoutMs <= 0) return
        const diagnostics = entry.session?.diagnostics()
        if (diagnostics !== undefined && diagnostics.lastFrameAt > lastSeenFrameAt) {
          lastSeenFrameAt = diagnostics.lastFrameAt
          noteActivity()
        }
        if (warned || warnMs <= 0 || warnMs >= timeoutMs) return
        const silentForMs = Date.now() - lastActivityWall
        if (silentForMs < warnMs) return
        // A message event must carry its turn/step numbers: the host's format
        // layer validates data.turn on persist, and a note without them killed
        // the whole turn asynchronously (2026-10-18 session b60d6fa4: 本轮运行
        // 失败「system/message turn must be a non-negative safe integer」).
        // With no announced position there is no honest number to write — skip
        // the note, exactly like the tool writer does.
        if (position === undefined) return
        warned = true
        const tail = stderrTailNow()
        const rawLast = tail.length === 0 ? '（无输出）' : tail.at(-1) ?? '（无输出）'
        const last = rawLast.length > 160 ? `${rawLast.slice(0, 160)}…` : rawLast
        try {
          // 形状由构造器保证：system/message 的 source 必须是 system-prompt，
          // 写错一次整份日志就永久加载不了（session-3575e031 的 seq 203）。
          const note = systemNoteEvent(position.turn, position.step, `等待外部 agent——已静默 ${String(Math.round(silentForMs / 1000))}s；agent 最近输出：${last}`)
          append?.(note.type, note.payload, { surfaceOp: 'append' })
        } catch {
          // A failed note must not kill the answer it was trying to explain.
        }
      }, pollMs)
    }
    const result = await new Promise<{ end: GatewayStepEnd }>((resolve, reject) => {
      settle = resolve
      // A user stop ends the answer HERE, not whenever the agent gets around
      // to it. The turn is the user's to close — 2026-10-16 session 423817a9:
      // codex network-dead in its own retry loop, every stop press swallowed
      // for ten minutes until the deadline ended the turn as if by accident.
      // The cancel still goes out first; the grace timer below decides only
      // whether the process survives it.
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      let runSettled = false
      const stopped = (): void => {
        controller.abort()
        entry.stopping = entry.session ?? undefined
        done({ end: { kind: 'aborted', reason: 'stopped by user' } })
        const kill = (): void => {
          if (runSettled) { entry.stopping = undefined; return }
          const stale = entry.stopping
          entry.stopping = undefined
          if (stale === undefined) return
          // Kill the conversation the stop was aimed at — and only it. If a
          // newer request already swapped in its own, the entry below still
          // names that newer one and must survive (final review 2026-10-16:
          // the grace once closed whatever was current and killed the new
          // turn's conversation by mistake).
          if (this.entries.get(sessionId) === entry && entry.session === stale) {
            entry.session = undefined
            this.entries.delete(sessionId)
          }
          stale.close()
          this.report(`acp gateway: session ${sessionId} did not settle within ${String(graceMs)}ms of stop — external conversation dropped`)
        }
        if (graceMs <= 0) { kill(); return }
        graceTimer = setTimeout(kill, graceMs)
      }
      if (request.signal?.aborted === true) stopped()
      else request.signal?.addEventListener('abort', stopped, { once: true })
      noteActivity()
      run.then(
        value => {
          runSettled = true
          entry.stopping = undefined
          if (graceTimer !== undefined) clearTimeout(graceTimer)
          done(value as { end: GatewayStepEnd })
        },
        error => {
          runSettled = true
          entry.stopping = undefined
          if (graceTimer !== undefined) clearTimeout(graceTimer)
          reject(error)
        },
      )
    })
    const end = result.end
    stream.finish(end)
    if (end.kind !== 'completed' && end.kind !== 'max-tokens' && end.kind !== 'aborted') {
      this.report(`acp gateway: session ${sessionId}'s in-place answer ended as ${end.kind}`)
    }
    // Forced endings drop the conversation — every one of them, not only the
    // connection's: keeping the entry would break the "next request opens
    // fresh" promise twice over. The retry reuses a transport whose process
    // is wedged or dead (2026-10-16 session f60dcf2b: three identical 60s
    // handshake timeouts in a row), and the wedged child itself leaks until
    // dsh restarts. Worse, a cap that kept the entry handed the next request
    // the same dead process — 2026-10-16 session 423817a9: ACP_TIMEOUT
    // rounds of exactly 600s in a loop until the user restarted the host.
    // Other error codes keep the conversation: an agent-side failure leaves
    // a live session, and continuing it spares the full-history primer.
    const endCode = end.kind === 'error' ? (end.error as { code?: string } | undefined)?.code : undefined
    if (endCode === 'ACP_CONNECTION' || endCode === 'ACP_STALLED' || endCode === 'ACP_TIMEOUT') {
      this.close(sessionId)
      this.report(`acp gateway: session ${sessionId}'s forced ending (${String(endCode)}) dropped the external conversation — the next request opens a fresh one`)
    }
  }

  /** Drop one session's conversation; its next request starts over primed. */
  close(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return
    this.entries.delete(sessionId)
    if (entry.session !== undefined) entry.session.close()
  }

  /**
   * Drop every conversation at once.
   *
   * The process-exit hook: close() kills each external child, so a normal
   * shutdown — including a default-handled SIGTERM — leaves no orphan retrying
   * in the background (2026-10-16 17:31's restart leaked a grok child that
   * kept cycling for 12 minutes). A SIGKILL beats any in-process hook; that
   * case belongs to whoever supervises the process.
   */
  closeAll(): void {
    for (const sessionId of [...this.entries.keys()]) this.close(sessionId)
  }
}
