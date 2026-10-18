/**
 * Driving one session's turns against a real ACP agent.
 *
 * The session is opened once and reused. `session/new` is expensive — codex and
 * grok both load a model catalogue and probe their environment during it — and a
 * DSH session is long-lived, so re-opening per turn would charge every turn a
 * setup the agent already paid.
 */

import type { AcpStepResult, StepDecisionLike, StepEndReason, TurnContext, TurnStreamHandle } from './dispatch.ts'
import { UNDELIVERED } from './content-writer.ts'
import type { UndeliveredAttachment } from './content-writer.ts'
import { AcpSegmenter, projectToolCallAnnouncement, projectToolCallFrame, projectToolResultFrame } from '@threadharbor/dsh-acp-agent'
import type { AcpDialect, AcpFrame, ProjectionEvent } from '@threadharbor/dsh-acp-agent'

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
  onFrame(handler: (frame: AcpFrame) => void): void

  /**
   * The agent's `authenticate` round-trip, when it has one.
   *
   * Cursor must authenticate (after an interactive `agent login`) between
   * `initialize` and `session/new`; the other agents have no such step, so the
   * port omits this and the runner skips it. Absent means "no authenticate".
   */
  authenticate?(): Promise<unknown>
}

/** Where a turn's text and reasoning go as they arrive. */
export type TurnStreamPort = {
  textDelta(text: string): void
  reasoningDelta(text: string): void
}

/** How to reach an agent, and where its work happens. */
export type RunnerOptions = {
  readonly cwd: string
  /**
   * The DSH session this runner drives, when the opener knows it.
   *
   * The runner's own `sessionId` is the external conversation's; this one
   * names the host session, which is what host-side services (the question
   * card, notably) resolve an agent by.
   */
  readonly dshSessionId?: string
  /** Applied once, before the first turn; claude needs `default` to ask at all. */
  readonly modeId?: string
  readonly modelId?: string
  /**
   * How long to wait for the agent to open a session before giving up.
   *
   * An agent that accepts a connection and then says nothing — wrong secret,
   * wrong path, an agent that is up but wedged — would otherwise hold the
   * session open forever with nothing on screen and no way to tell that is what
   * is happening. Give up loudly instead.
   */
  readonly openTimeoutMs?: number
  /**
   * The frame dialect of the agent this runner drives, when known.
   *
   * With it, the runner writes each tool's opening card the moment the call's
   * first frame arrives — the card exists in the log while the agent still
   * works, and the turn-end write strips those already written. Without it
   * (or for a frame without a call id, which cannot be tracked to stay
   * single) the turn writes everything at its end, exactly as before.
   */
  readonly dialect?: AcpDialect
  /**
   * A conversation handed over from another session, keyed by session.
   *
   * A switch into this preset continues in a new DSH session, and this
   * runner's external conversation starts empty — the takeover sends only the
   * new turn's user text. The handed-over text rides the first model request
   * here, ahead of it, which is the whole of the handover: the agent reads the
   * prior conversation and then the question. Taken on the first attempt and
   * put back if that attempt failed to deliver, so a failed turn never
   * silently continues without the history it was promised.
   */
  readonly primer?: {
    take(sessionId: string): string | undefined
    restore(sessionId: string, text: string): void
  }
  /**
   * This session's earlier conversation, read from the host's own transcript.
   *
   * An external conversation starts empty even when the DSH session's record
   * does not — a host restart forgets the connection but not the log — so the
   * first request of a fresh external conversation carries the transcript
   * ahead of the question, framed as previous conversation. Consulted only on
   * the session's first open, and only when no handover primer exists: the
   * handover is the fresher copy of the same conversation. Never put back —
   * unlike a primer it is read from the host, so a retry can simply take it
   * again — and when the agent then refuses the prompt, the turn ends naming
   * the refusal rather than dying with the agent's bare error.
   */
  readonly replay?: {
    take(sessionId: string): string | undefined
  }
  /**
   * The current turn's stop signal, when the host can stop the turn.
   *
   * Consulted once per turn, before the prompt goes out — the listener has to
   * exist before the user can stop. On abort the runner tells the agent
   * `session/cancel` and discards whatever still arrives; the turn ends
   * aborted no matter what the agent then replies. Absent (or resolving to
   * nothing for this turn) means the turn cannot be stopped, and runs exactly
   * as before.
   */
  readonly abort?: () => AbortSignal | undefined
  /**
   * The model list the agent reported with this session, as the dialect read
   * it off the `session/new` reply.
   *
   * The model picker serves what the agent serves, and only an opened session
   * can answer that — so every open reports, an empty list included: an agent
   * that serves nothing must be able to say so, and swallowing the report
   * would leave a stale answer standing. Absent means nobody listens; the
   * open proceeds exactly as before.
   */
  readonly onModels?: (models: readonly { id: string; name: string; description?: string }[]) => void
}

/** Long enough for a cold process to start, short enough to not strand a turn. */
const DEFAULT_OPEN_TIMEOUT_MS = 60_000

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

/** The message an error carries, however it was shaped. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Pull the user-authored text out of a step decision's messages. */
export function promptText(messages: readonly unknown[]): string {
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

/** An image block as the ACP `session/prompt` payload carries it. */
export type PromptImage = {
  readonly type: 'image'
  readonly data: string
  readonly mimeType: string
}

/** What one turn's prompt is made of, after the capability table has spoken. */
export type PromptContent = {
  /** The user-authored text, as `promptText` assembles it. */
  readonly text: string
  /** Image blocks cleared to ride the prompt, in message order. */
  readonly images: readonly PromptImage[]
  /**
   * Blocks held back from the prompt, in the order they were met.
   *
   * An image lands here when the agent's capability table declines it; every
   * other non-text block (a file, a resource) lands here always — none is sent
   * to any agent today. The runner hands the list to the writer, which turns it
   * into the row that tells the user the attachment did not arrive.
   */
  readonly undelivered: readonly UndeliveredAttachment[]
}

/**
 * Pull the user-authored content out of a step decision's messages, routed by
 * the capability table.
 *
 * A dialect that does not declare `acceptsImageContent` reads as "cannot":
 * sending what we cannot verify the agent takes is the one outcome this routing
 * exists to prevent, so an unknown (or absent) dialect never carries images.
 * Text is extracted exactly as `promptText` does, so a text-only turn builds
 * the same prompt as before.
 */
export function promptContent(messages: readonly unknown[], dialect: AcpDialect | undefined): PromptContent {
  const parts: string[] = []
  const images: PromptImage[] = []
  const undelivered: UndeliveredAttachment[] = []
  const acceptsImages = dialect?.capabilities.acceptsImageContent === true
  for (const message of messages as readonly UserText[]) {
    if (message.role !== undefined && message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') { parts.push(content); continue }
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      const type = typeof block?.['type'] === 'string' ? block['type'] : ''
      if (type === 'text') {
        if (typeof block['text'] === 'string') parts.push(block['text'])
        continue
      }
      if (type === 'image') {
        if (acceptsImages && typeof block['data'] === 'string' && typeof block['mimeType'] === 'string') {
          images.push({ type: 'image', data: block['data'], mimeType: block['mimeType'] })
        } else {
          undelivered.push({
            kind: 'image',
            ...(typeof block['mimeType'] === 'string' ? { mimeType: block['mimeType'] } : {}),
          })
        }
        continue
      }
      // Any other block kind — a file, a resource — is held back wholesale
      // (spec §8.1): no agent is sent one today, so it takes the same
      // undelivered road as a declined image. A block without a recognizable
      // type is skipped, exactly as the text-only extraction always skipped it.
      if (type !== '') {
        undelivered.push({
          kind: 'file',
          ...(typeof block['mimeType'] === 'string' ? { mimeType: block['mimeType'] } : {}),
        })
      }
    }
  }
  return { text: parts.join('\n'), images, undelivered }
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

/** The prefix the client puts on every JSON-RPC error reply before it reaches here. */
const ACP_ERROR_PREFIX = 'acp error: '
/**
 * The marker every connection-family failure carries: our transports, client
 * and handshake all phrase their reasons with the `acp ` prefix (see
 * `failureEndOf` for the inventory). An error without it is not about the
 * connection, and must not borrow its reconnect advice.
 */
const CONNECTION_PREFIX = 'acp '

/**
 * An agent refusal about authorization, not about the transport.
 *
 * The JSON-RPC error reply carries no structured class this side can read, so
 * the classification reads the reply's own text for the authorization
 * vocabulary the agents document (cursor's login requirement, claude's
 * permission errors, codex's auth updates). Anything matching ends the turn
 * with the approval hint; a JSON-RPC error without the signal keeps the raw
 * string — the spec's third bucket.
 */
const PERMISSION_SIGNAL = /auth|permission|login|unauthorized|forbidden|denied/i

/**
 * Map a turn failure onto the error end the loop records, with copy the
 * turn-error row can show as advice rather than as a raw string.
 *
 * The row renders `error.message` verbatim, so this is where the spec's
 * mapping lives: a dead or never-established connection points at resending
 * (the next turn opens a fresh session on its own); an authorization refusal
 * points at approving or logging in; anything else stays the agent's own
 * words. Every message keeps the original detail — a hint without the cause
 * is a dead end for diagnosis.
 */
export function failureEndOf(error: unknown): StepEndReason {
  const detail = messageOf(error)
  if (detail.startsWith(ACP_ERROR_PREFIX)) {
    if (PERMISSION_SIGNAL.test(detail)) {
      return {
        kind: 'error',
        error: {
          code: 'ACP_PERMISSION',
          message: `外部 agent 需要授权：${detail}。完成 agent 登录或在审批中放行后，重新发送即可。`,
        },
      }
    }
    return { kind: 'error', error: { code: 'ACP_ERROR', message: detail } }
  }
  // Every connection-family failure our own stack raises names itself with the
  // `acp ` prefix — the spawn/exit lines (`acp agent … could not run / exited`),
  // the socket close text (`acp agent connection closed: …`), the client's own
  // close (`acp connection closed`), the handshake deadline (`acp agent did
  // not answer within …`) and the missing session id (`acp session/new
  // returned no sessionId`). Anything else reaching this point is not a
  // connection failure at all — a bug inside the turn's own handling — and
  // must not wear the reconnect hint: the label has to tell the truth about
  // the cause even when the detail already would let someone diagnose it.
  if (detail.startsWith(CONNECTION_PREFIX)) {
    return {
      kind: 'error',
      error: {
        code: 'ACP_CONNECTION',
        message: `外部 agent 连接已断开：${detail}。重新发送这条消息即可重试，下一次会自动连接新的外部会话。`,
      },
    }
  }
  return {
    kind: 'error',
    error: {
      code: 'ACP_INTERNAL',
      message: `回合处理出错：${detail}`,
    },
  }
}

/** 本段实时写卡的登记：已写卡的公告/卡片与已实时落结果的 callId（投影后键）。 */
type LiveCards = {
  readonly turn: number
  readonly step: number
  readonly write: TurnContext['write']
  /** Call ids whose opening card already went to the log this segment. */
  readonly written: Set<string>
  /** Call ids whose result already went to the log this segment. */
  readonly settled: Set<string>
}

export class AcpTurnRunner {
  private sessionId: string | undefined
  private dshSessionId: string | undefined
  private opening: Promise<string> | undefined
  /**
   * 帧队列：observe 只入队，泵从队首消费。
   *
   * 队列随 prompt 生命周期清空（beginPrompt）——两次回合之间到达的帧属于无主
   * 回合，与旧 `turnFrames = []` 一样在下一个 prompt 发出时丢弃。
   */
  private readonly queue: AcpFrame[] = []
  /** 当前段的帧；run 路径不分段，它就是整个回合的帧。 */
  private frames: AcpFrame[] = []
  /**
   * 本回合的驱动方式：`run` 是网关路径（无段概念，入队后立即泵空，实时行为
   * 与逐帧 observe 相同）；`steps` 是接管路径（泵由当次 runSteps 调用驱动，
   * 按段推进）。随 prompt 生命周期设置。
   */
  private promptMode: 'run' | 'steps' | undefined
  /**
   * 当前段的分段器。仅 steps 路径创建——网关没有段概念，回合末一次投影。
   * 随 prompt 生命周期重建：段状态（哪些调用还开着）不能跨回合携带。
   */
  private segmenter: AcpSegmenter | undefined
  private stream: TurnStreamPort | undefined
  /** Set when this turn's stop signal fired; everything after it is dropped. */
  private aborted = false
  /** 应答已落定（成功或失败）——末段的闭合条件之一。 */
  private promptSettled = false
  /** 应答给出的停止原因；应答失败时无意义。 */
  private replyStop: unknown
  /** 应答的失败；分类在 promptEnd 里做，与 run() 同一映射。 */
  private promptFailure: unknown
  /** 本回合的 prompt 携带了历史回灌（首段职责记录，随 prompt 生命周期）。 */
  private replayRode = false
  /** 组装 prompt 时被挡下的附件；随首段的落盘写成未送达公告。 */
  private undelivered: readonly UndeliveredAttachment[] = []
  /** 未送达公告只随首段写一次。 */
  private noticeWritten = false
  /** 段活动（帧入队 / 中止 / 应答落定）的唤醒回调；无人等待时是空操作。 */
  private wake: (() => void) | undefined
  /**
   * The segment in flight, for writing a tool card as its first frame arrives.
   *
   * Bound for one runSteps call (one segment) or for run()'s whole turn: a
   * frame can reach the log as mid-segment only while this binding owns the
   * write, and frames arriving between calls stay queued untouched — the next
   * call writes their cards under its own step number.
   */
  private liveCards: LiveCards | undefined

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

  /** Take one frame: keep it queued; the pump does everything else. */
  private observe(frame: AcpFrame): void {
    // 中止后到达的帧一律丢弃: the agent had not processed the cancel yet and
    // kept talking. Those frames belong to a turn nobody is reading, and
    // projecting them would resurrect text under a turn that ended aborted.
    if (this.aborted) return
    this.queue.push(frame)
    if (this.promptMode === 'run') {
      // 网关路径：入队后立即泵空。同一 tick 内逐帧处理，实时行为与旧的逐帧
      // observe 逐字节相同——流增量、开卡、实时结果的调用点原样搬进泵内。
      while (this.queue.length > 0) this.pumpNext()
      return
    }
    // 接管路径：泵由当次 runSteps 调用驱动（段闭合前不能越过边界），这里只
    // 唤醒等待中的泵。
    this.wakeup()
  }

  /**
   * 泵走队首一帧：归档进当前段，再做实时动作（开卡 → 实时结果 → 流增量）。
   *
   * 返回 true 表示该帧宣告上一段闭合、自身属于新段（分段器的契约）：调用方
   * 必须先收掉旧段，且不消费这一帧——它留在队首，由下一次 runSteps 调用在
   * 新段里处理（它的流增量与开卡都归新段）。只在绑定了分段器的 steps 路径
   * 可能返回 true；run 路径没有分段器，永不闭段。
   */
  private pumpNext(): boolean {
    const frame = this.queue[0]!
    // 子会话帧（子代理流）不进父泵的流与切段：投影时它们折进子代理卡片的
    // 结果（accumulate 的既有待遇），泵里对它们没有任何按段动作。判定只有
    // 一次会话 id 比较；params 不带会话 id 的帧（应答帧）视作父会话。
    const frameSessionId = recordOf(recordOf(frame)['params'])['sessionId']
    if (typeof frameSessionId === 'string' && frameSessionId !== this.sessionId) {
      this.queue.shift()
      this.frames.push(frame)
      return false
    }
    if (this.segmenter?.observe(frame) === true) return true
    this.queue.shift()
    this.frames.push(frame)
    this.writeOpeningCard(frame)
    this.writeSettledResult(frame)
    const stream = this.stream
    if (stream === undefined) return false
    // Held locally so nothing can clear it while this frame is being pushed.
    this.pushToStream(frame, stream)
    return false
  }

  /** Wake a runSteps call waiting for segment activity; nobody waiting is a no-op. */
  private wakeup(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /**
   * Wait until a frame is queued, the stop fires, or the prompt settles.
   *
   * The caller re-checks every condition after each wake, so a wake that fires
   * while it is mid-drain is simply a no-op. The check and the wait are one
   * synchronous block — nothing can slip in between on a single thread.
   */
  private waitForActivity(): Promise<void> {
    return new Promise(resolve => { this.wake = resolve })
  }

  /**
   * 开始一个外部 prompt 的生命周期：清队列、重建段状态与中止旗标。
   *
   * 队列里的残余帧在这里丢弃（两次回合之间的帧属于无主回合）；分段器只随
   * steps 路径创建——网关没有段概念，回合末一次投影。
   */
  private beginPrompt(mode: 'run' | 'steps'): void {
    this.queue.length = 0
    this.frames = []
    this.promptMode = mode
    this.segmenter = mode === 'steps' && this.options.dialect !== undefined
      ? new AcpSegmenter(this.options.dialect)
      : undefined
    this.aborted = false
    this.promptSettled = false
    this.replyStop = undefined
    this.promptFailure = undefined
    this.replayRode = false
    this.undelivered = []
    this.noticeWritten = false
  }

  /**
   * Write a tool's opening card the moment its first frame arrives.
   *
   * The card is the projection's own tool/call — the exact payload the
   * turn-end write would have produced — so the session writer files it under
   * the same `turn:callId` key it pairs results with. Only the first frame for
   * an id writes; the turn-end write strips these and carries the results.
   * The written-set is keyed on the PROJECTED card's callId, not the raw
   * frame's `toolCallId`: a dialect may sanitize the id when it folds (cursor
   * collapses a newline it joins two ids with), and the turn-end strip reads
   * the same folded payload — keying both ends alike is what makes "exactly
   * once" hold by construction rather than by agreement.
   * A failed append wrote nothing (the session validates before it commits),
   * so the id is left unwritten and the card falls to the turn-end write as
   * always — and the frame handler, which also drives the live stream, must
   * never let a write error kill it.
   */
  private writeOpeningCard(frame: AcpFrame): void {
    const live = this.liveCards
    const dialect = this.options.dialect
    if (live === undefined || dialect === undefined) return
    const event = projectToolCallFrame(frame, { turn: live.turn, step: live.step, dialect })
    if (event === undefined) return
    const callId = recordOf(event.payload)['callId']
    if (typeof callId !== 'string' || live.written.has(callId)) return
    // Announce the call before its card: the log admits a `tool/call` only
    // after an `assistant/message` carried a matching `tool-call` block, and
    // the end-of-turn message is written after this card. The declaration is
    // filed live with the card, so the validator finds it in order.
    const announcement = projectToolCallAnnouncement(frame, { turn: live.turn, step: live.step, dialect })
    try {
      live.write(announcement === undefined ? [event] : [announcement, event])
    } catch {
      return
    }
    live.written.add(callId)
  }

  /**
   * Write a tool's result the moment its terminal frame arrives.
   *
   * A card that opens live but waits for the turn end for its output sits
   * outputless through everything the agent still does — minutes, for a long
   * external-agent turn. The terminal frame (folded `completed`/`failed`) is
   * the moment the outcome exists, so this files the shared tool/result right
   * then, and the id lands in `settled` — the record the turn-end filter reads
   * to skip a result it would otherwise write a second time.
   *
   * The guard is the same discipline the card path obeyed to become legal: a
   * live result is written ONLY under a card this turn wrote live
   * (`written.has`), because a result whose call was never announced is an
   * orphan the log refuses. A card whose live write failed stays unwritten,
   * and its result waits for the turn end, where call and result land as the
   * pair. The callId is read off the PROJECTED payload (`message.toolCallId`),
   * the same folded id the card carried and the turn-end result will carry —
   * keying all three alike is what keeps "exactly once" holding by
   * construction. A failed append wrote nothing, so the id stays unsettled
   * and the turn-end pair covers it; the frame handler, which also drives the
   * live stream, must never let a write error kill it.
   */
  private writeSettledResult(frame: AcpFrame): void {
    const live = this.liveCards
    const dialect = this.options.dialect
    if (live === undefined || dialect === undefined) return
    const event = projectToolResultFrame(frame, { turn: live.turn, step: live.step, dialect })
    if (event === undefined) return
    const callId = resultCallIdOf(event)
    if (callId === undefined || !live.written.has(callId)) return
    // 同一 callId 的第二个收尾帧（重复投递）不许再写一次：已 settle 即跳过，
    // 实时结果对每个调用恰好一次由构造保证，而不靠投递方自律。
    if (live.settled.has(callId)) return
    try {
      live.write([event])
    } catch {
      return
    }
    live.settled.add(callId)
  }

  /** Feed one frame's text to the live stream. */
  private pushToStream(frame: AcpFrame, stream: NonNullable<typeof this.stream>): void {
    const update = recordOf(recordOf(recordOf(frame)['params'])['update'])
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') return
    const text = textOf(update['content'])
    if (text.length === 0) return
    if (kind === 'agent_thought_chunk') stream.reasoningDelta(text)
    else stream.textDelta(text)
  }

  /**
   * Run one turn.
   *
   * Failures propagate on purpose: the replacement step lets them reach the
   * loop's own error handling, which closes the turn as an error. Returning
   * something empty instead would show the user an agent that merely had nothing
   * to say.
   */
  /**
   * Run one turn, and own everything its answer produces.
   *
   * The write lives here rather than in the caller on purpose: the stream's
   * closing frame can only be emitted after the durable message exists, and it
   * has to carry that message's sequence number. Split across two places, the
   * two can be reordered, and the result is a frame pointing at a message that
   * was never written.
   */
  async run(decision: StepDecisionLike, turn: TurnContext): Promise<AcpStepResult> {
    // Whether this run opens the external conversation, decided before `open`
    // settles: a different session asking, or no external session yet (first
    // turn, or the last attempt failed), means the transcript has not been
    // replayed into it. Only that first request carries the history — a later
    // request would read it to the agent a second time.
    const firstOpen = this.dshSessionId !== turn.sessionId || this.sessionId === undefined
    let sessionId: string
    try {
      sessionId = await this.open(turn.sessionId)
    } catch (error: unknown) {
      // An agent that never opened (missing binary, handshake timeout, refused
      // login) is the reconnect case just as much as one that died mid-turn:
      // the turn ends as a classified error instead of a thrown raw one.
      return { frames: [], end: failureEndOf(error) }
    }
    // 网关路径整回合一个 prompt：清残余、按 run 模式重建（无分段器）。observe
    // 从此入队即泵空，帧的实时处理与旧的逐帧 observe 相同。
    this.beginPrompt('run')
    // Bound before the prompt goes out: a tool frame only arrives once the
    // agent has the question, but the binding must not be able to lose the
    // race with it. Held in a local too — the field is cleared the moment the
    // prompt settles, and the turn-end write below still needs the written
    // record to know which cards not to write a second time.
    //
    // A turn context with no position (the in-place gateway answers with one
    // when it knows the open turn, and without one when it does not) gets no
    // live-card binding. These cards are live-stream bookkeeping only — the
    // turn-end write below is what reaches the session log — so skipping them
    // costs visibility, not the answer, and a fabricated 0/0 here is exactly
    // what used to make the log unloadable.
    const liveCards = this.options.dialect === undefined || turn.position === undefined ? undefined : {
      turn: turn.position.turn,
      step: turn.position.step,
      write: turn.write,
      written: new Set<string>(),
      settled: new Set<string>(),
    }
    this.liveCards = liveCards
    // Registered before the prompt goes out: the stop lands while the agent is
    // still working, and a listener added afterwards would never hear it.
    const detachStop = this.watchStop(sessionId)
    const stream = turn.openStream?.()
    this.stream = stream
    stream?.start()

    // The handed-over conversation rides ahead of this turn's question, on the
    // first request only. Taken before the request and put back if the request
    // failed: a retry that re-sends it would double the history, but a retry
    // without it would silently drop the conversation — and that is the one
    // outcome a handover must never produce.
    const handedOver = this.options.primer?.take(turn.sessionId)
    // The host transcript rides the first request too, but only when no
    // handover exists — the handover is the fresher copy of the same
    // conversation, and carrying both would read the history twice.
    const replayed = handedOver === undefined && firstOpen
      ? this.options.replay?.take(turn.sessionId)
      : undefined
    const { text: question, images, undelivered } = promptContent(decision.messages, this.options.dialect)
    // 未送达公告走段收尾的统一通道（run 路径即回合末），与 runSteps 同一写法。
    this.undelivered = undelivered
    const text = handedOver !== undefined
      ? `${handedOver}\n\n${question}`
      : replayed !== undefined
        ? `【之前对话】\n${replayed}\n\n【当前问题】\n${question}`
        : question
    const params: Record<string, unknown> = {
      sessionId,
      // The images ride after the text, in the order the messages carried them;
      // when the capability table declines them this list is text-only, and the
      // held-back ones are reported below instead.
      prompt: [{ type: 'text', text }, ...images],
    }
    // The session's own selection outranks the configured default: it is what
    // the user picked for this conversation.
    const modelId = turn.modelId ?? this.options.modelId
    if (modelId !== undefined) params['modelId'] = modelId

    let reply: unknown
    let failure: unknown
    try {
      reply = await this.client.request('session/prompt', params)
    } catch (error: unknown) {
      // Remember it and settle the listeners; the classification below turns
      // it into the end the turn-error row can show as advice.
      failure = error
    } finally {
      // A listener must not outlive its turn, or a later turn would inherit
      // this one's stop and end aborted before it began. The same goes for
      // the mid-turn card writer: frames trailing the reply belong to the
      // turn-end write, not to a mid-turn one racing it.
      detachStop()
      this.liveCards = undefined
    }
    const stopReason = (reply as { stopReason?: unknown } | null)?.stopReason

    this.stream = undefined

    if (failure !== undefined) {
      // The handover goes back first: a retry must keep the history.
      if (handedOver !== undefined) this.options.primer?.restore(turn.sessionId, handedOver)
      // A stop outranks the replay rejection too: if the user stopped the turn
      // AND the prompt then rejected (the dying connection's error reply), the
      // turn is what the user made it — stopped — and the frames it sent before
      // the stop must still be written. Fall through to the shared tail, which
      // ends aborted and produces/writes them, rather than dying here with the
      // replay reason and orphaning the pre-stop content.
      if (replayed !== undefined && !this.aborted) {
        // The transcript rode this very prompt, so it is the likeliest reason
        // the agent refused it — a first request suddenly oversized or in a
        // shape the agent does not take. End the turn naming that instead of
        // dying with the agent's bare error: the user keeps their question on
        // the record and reads why the answer never came, rather than watching
        // the turn vanish into an opaque failure. Not classified further — any
        // failure of a prompt that carried the replay says so here.
        stream?.abandon()
        return {
          frames: [...this.frames],
          end: {
            kind: 'error',
            error: {
              message: `历史回灌被拒绝：${messageOf(failure)}`,
              code: 'REPLAY_REJECTED',
            },
          },
        }
      }
      // Everything else falls through to the shared tail: the frames the agent
      // sent before failing are produced and written like any turn's, and the
      // end names the failure class with copy the row can show as advice.
    }

    // The stop outranks whatever the agent replied — or whatever failure raced
    // out of the dying connection: once the turn was stopped and the agent told
    // to cancel, the turn is what the user made it — stopped.
    const end = this.aborted
      ? abortedEnd()
      : failure !== undefined
        ? failureEndOf(failure)
        : toEndReason(stopReason)
    // The turn's frames, snapshotted before the close (closing the segment
    // archives them — the next segment starts empty, and there is no next
    // segment on this path).
    const frames = [...this.frames]
    // Produce after the run, write after that, and only then announce the end:
    // the closing frame carries the message's sequence number, and pointing at
    // a message that is not written yet shows the user text that then vanishes.
    // Cards already written mid-turn are stripped here, and so are the results
    // the terminal frames already filed live; anything the mid-turn writer
    // could not track (a frame with no call id, a call whose live write
    // failed) still rides the turn-end write as before. Same tail the segment
    // path closes every segment with — one projection, one write, one settle.
    this.closeSegment(turn, stream, liveCards, end)
    return {
      frames,
      end,
      ...(stream === undefined ? {} : { stream: stream.records() }),
    }
  }

  /**
   * 按段驱动一个外部回合：每次调用消费一个闭合段，一段一个 DSH 步骤。
   *
   * 返回 null 表示「回合还没结束」——原生循环会补上下一步的边界再调一次，
   * 届时 first=false。段边界由分段器宣告：工具批次全部收尾后的第一条新内容
   * 帧闭合上一段，且该帧归新段（留在队首由下一次调用处理）。首段调用
   * （first=true）独占回合级职责：开外部会话、重建段状态、挂停止监听、历史
   * 回灌、组装并发送 prompt；后续调用只绑本段的实时登记、开本段的流、泵帧、
   * 收段。用户消息与模型选择不归这里——接管分支（dispatch）自己写。
   *
   * 末段（应答落定 / 中止 / 失败）才返回真实结束原因，优先级与 run() 一致：
   * 中止 > 失败分类 > 应答停止原因。中止把已到的内容当末段写掉，之后的帧照旧
   * 丢弃；应答半路被拒同理，按分类错误收场。
   */
  async runSteps(decision: StepDecisionLike, turn: TurnContext, options: { readonly first: boolean }): Promise<StepEndReason | null> {
    if (options.first) {
      // Whether this run opens the external conversation, decided before `open`
      // settles: a different session asking, or no external session yet, means
      // the transcript has not been replayed into it. Only that first request
      // carries the history.
      const firstOpen = this.dshSessionId !== turn.sessionId || this.sessionId === undefined
      let sessionId: string
      try {
        sessionId = await this.open(turn.sessionId)
      } catch (error: unknown) {
        // 外部会话没开成（缺二进制、握手超时、拒绝登录）：与 run() 同一条分类
        // 路径，回合以错误收场，无段落事件。
        return failureEndOf(error)
      }
      this.beginPrompt('steps')
      // Registered before the prompt goes out: the stop lands while the agent
      // is still working, and a listener added afterwards would never hear it.
      // 解除随应答落定（成功或失败），不得跨段存活。
      const detachStop = this.watchStop(sessionId)
      // The handed-over conversation rides ahead of this turn's question, on
      // the first request only. Taken before the request and put back if the
      // request failed.
      const handedOver = this.options.primer?.take(turn.sessionId)
      const replayed = handedOver === undefined && firstOpen
        ? this.options.replay?.take(turn.sessionId)
        : undefined
      this.replayRode = replayed !== undefined
      const { text: question, images, undelivered } = promptContent(decision.messages, this.options.dialect)
      // 未送达公告随首段落盘（组装 prompt 的那次调用才知道挡下了什么）。
      this.undelivered = undelivered
      const text = handedOver !== undefined
        ? `${handedOver}\n\n${question}`
        : replayed !== undefined
          ? `【之前对话】\n${replayed}\n\n【当前问题】\n${question}`
          : question
      const params: Record<string, unknown> = {
        sessionId,
        prompt: [{ type: 'text', text }, ...images],
      }
      const modelId = turn.modelId ?? this.options.modelId
      if (modelId !== undefined) params['modelId'] = modelId
      // prompt 不在本次调用里等完：应答落定只是末段的闭合条件之一，段边界才是
      // 本次调用的返回时机。落定后续接只做三件事——记录结果、解除监听、唤醒泵。
      void this.client.request('session/prompt', params).then(
        reply => {
          this.promptSettled = true
          this.replyStop = (reply as { stopReason?: unknown } | null)?.stopReason
          detachStop()
          this.wakeup()
        },
        error => {
          this.promptSettled = true
          this.promptFailure = error
          // The handover goes back first: a retry must keep the history.
          if (handedOver !== undefined) this.options.primer?.restore(turn.sessionId, handedOver)
          detachStop()
          this.wakeup()
        },
      )
    }
    return this.pumpSegment(turn)
  }

  /**
   * 泵到本段闭合：从队首逐帧处理（流增量 → 开卡 → 实时结果），直到分段器
   * 宣告边界、中止旗标竖起、或应答落定且队列清空。
   *
   * 每次调用开自己的流（turn.openStream 的新 attempt，计数器全程递增）与自己的
   * 实时登记——段与段之间到达的帧留着不动，由下一次调用在本段的步骤号下处理。
   */
  private async pumpSegment(turn: TurnContext): Promise<StepEndReason | null> {
    // 同 run() 的绑定规则：没有方言或没有位置就没有实时登记——开卡/实时结果
    // 只剩段末投影这一条路，答案不受影响。
    const liveCards = this.options.dialect === undefined || turn.position === undefined ? undefined : {
      turn: turn.position.turn,
      step: turn.position.step,
      write: turn.write,
      written: new Set<string>(),
      settled: new Set<string>(),
    }
    this.liveCards = liveCards
    const stream = turn.openStream?.()
    this.stream = stream
    stream?.start()
    try {
      while (true) {
        while (this.queue.length > 0) {
          if (this.pumpNext()) {
            // 边界帧属于新段：留在队首，下一次调用在它自己的段里处理。
            // 中间段的 end 只是类型占位——投影只读 frames/stream，回合的真实
            // 结束原因只随末段返回。
            this.closeSegment(turn, stream, liveCards, { kind: 'completed' })
            return null
          }
        }
        if (this.aborted || this.promptSettled) {
          const end = this.promptEnd()
          if (this.promptFailure !== undefined && this.replayRode && !this.aborted) {
            // 历史回灌被拒：与 run() 同款——流作废、不落任何事件。
            stream?.abandon()
            return end
          }
          // 空末段：上一次闭合之后、应答/中止之前什么都没到——没有事件可写，
          // 结束原因走返回值（公告待写时不算空，见 noticePending）。
          if (this.frames.length === 0 && !this.noticePending()) {
            stream?.abandon()
            return end
          }
          this.closeSegment(turn, stream, liveCards, end)
          return end
        }
        // 段未闭合、应答未落定：等下一帧、中止或应答（observe / watchStop /
        // 应答续延唤醒）。
        await this.waitForActivity()
      }
    } finally {
      this.liveCards = undefined
      this.stream = undefined
    }
  }

  /** 首段的未送达公告是否还没落盘：公告待写时，空段也要写一次再收。 */
  private noticePending(): boolean {
    return !this.noticeWritten && this.undelivered.length > 0
  }

  /** 本 prompt 的真实结束原因，优先级与 run() 一致：中止 > 失败分类 > 应答停止原因。 */
  private promptEnd(): StepEndReason {
    if (this.aborted) return abortedEnd()
    if (this.promptFailure !== undefined) {
      if (this.replayRode) {
        // The transcript rode this very prompt, so it is the likeliest reason
        // the agent refused it. Not classified further — any failure of a
        // prompt that carried the replay says so here.
        return {
          kind: 'error',
          error: {
            message: `历史回灌被拒绝：${messageOf(this.promptFailure)}`,
            code: 'REPLAY_REJECTED',
          },
        }
      }
      return failureEndOf(this.promptFailure)
    }
    return toEndReason(this.replyStop)
  }

  /**
   * 收段：投影、落盘、收流。
   *
   * 投影先于写、写先于收流：闭合帧携带消息的序号，指向一条还没写的消息会让
   * 用户看到文字又消失。已实时写过的卡与结果在此剥离；未送达公告只随首段
   * 落盘（它在段事件之前展开，永不触碰消息的序号）。收完段帧清空——下一段
   * 从空段开始。run 路径的回合末也走这里：无条件 produce+write，回合末残余
   * 的补写语义保持现状；「空段不产事件」是 steps 路径末段的规则，由调用方
   * 在此之前把守。
   */
  private closeSegment(turn: TurnContext, stream: TurnStreamHandle | undefined, liveCards: LiveCards | undefined, end: StepEndReason): void {
    const position = turn.position
    const notice = !this.noticeWritten && this.undelivered.length > 0 && position !== undefined
      ? [{
        type: UNDELIVERED,
        payload: {
          turn: position.turn,
          step: position.step,
          attachments: this.undelivered,
        },
      }]
      : []
    if (notice.length > 0) this.noticeWritten = true
    const result: AcpStepResult = {
      frames: [...this.frames],
      end,
      ...(stream === undefined ? {} : { stream: stream.records() }),
    }
    const produced = turn.produce(result)
    const events = [
      ...notice,
      ...(liveCards === undefined ? produced : withoutLiveWritten(produced, liveCards)),
    ]
    const seq = turn.write(events)
    if (stream === undefined) return
    if (seq === undefined) stream.abandon()
    else stream.settle('assistant/message', () => seq)
    // 段已归档：清空段帧，下一段（下一次调用的泵）从空段开始。边界帧从不在这
    // 里——它还留在队首，正等着归入新段。
    this.frames = []
  }

  /**
   * Listen for this turn's stop, so the agent is told and its late frames are
   * discarded.
   *
   * Returns the detacher, called when the prompt settles. Absent option, or
   * one that resolves to nothing for this turn, means no stop wiring — the
   * turn runs exactly as before.
   */
  private watchStop(sessionId: string): () => void {
    const signal = this.options.abort?.()
    if (signal === undefined) return () => {}
    const onStop = (): void => {
      this.aborted = true
      // 唤醒按段等待中的泵：中止要立刻把当前段当末段收掉。run 路径无人等待，
      // 是空操作。
      this.wakeup()
      // The host's stop does not reach the external process on its own;
      // without this notice the agent would keep generating into a turn
      // nobody is reading.
      try {
        this.client.notify('session/cancel', { sessionId })
      } catch {
        // A connection that died under the stop cannot be told; the turn
        // still ends aborted, and the next turn opens a fresh session.
      }
    }
    // Stopped before we listened: a turn opened onto a signal that had
    // already fired counts as stopped from its first moment.
    if (signal.aborted) onStop()
    else signal.addEventListener('abort', onStop, { once: true })
    return () => { signal.removeEventListener('abort', onStop) }
  }

  /**
   * Open once per DSH session, and remember — including when the first attempt
   * failed.
   *
   * Keyed by the session that asked, so two conversations in the same preset do
   * not end up sharing one external conversation.
   */
  private open(dshSessionId: string): Promise<string> {
    if (this.dshSessionId !== undefined && this.dshSessionId !== dshSessionId) {
      // A different session asking: its own external conversation.
      return this.freshOpen(dshSessionId)
    }
    this.dshSessionId = dshSessionId
    return this.openingNow()
  }

  private async freshOpen(dshSessionId: string): Promise<string> {
    this.dshSessionId = dshSessionId
    this.sessionId = undefined
    return this.openingNow()
  }

  private openingNow(): Promise<string> {
    if (this.sessionId !== undefined) return Promise.resolve(this.sessionId)
    const ms = this.options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    this.opening ??= withDeadline(
      this.doOpen(),
      ms,
      `acp agent did not answer within ${String(ms)}ms`,
    ).then(
      sessionId => { this.sessionId = sessionId; this.opening = undefined; return sessionId },
      error => { this.opening = undefined; throw error },
    )
    return this.opening
  }

  private async doOpen(): Promise<string> {
    await this.client.request('initialize', {
      protocolVersion: 1,
      // `subagents` opts into the ACP subagent draft (#1992): adapters that
      // implement it (codex-acp, claude-agent-acp) then report subagent and
      // async-task lifecycle as native frames instead of folding the whole
      // run into one opaque tool call. Agents without the draft ignore the
      // field, so grok and cursor are unaffected.
      //
      // The released @agentclientprotocol/sdk STRIPS the draft field off
      // clientCapabilities at initialize (measured 2026-10-20: with only this
      // spelling, both adapters still surfaced delegations as ordinary tool
      // calls). The adapters' documented fallback is the `_meta.jetbrains.air`
      // extension — version 1 plus a capability list — which the schema
      // passes through, so both spellings ride the handshake: the meta one
      // works today, the canonical one wins once the SDK ships it.
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        subagents: {},
        _meta: { jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] } } },
      },
    })
    this.client.notify('initialized', {})
    // Cursor authenticates here; the other agents have no such step.
    if (this.client.authenticate !== undefined) await this.client.authenticate()
    const reply = (await this.client.request('session/new', {
      cwd: this.options.cwd,
      mcpServers: [],
    })) as { sessionId?: unknown } | null
    if (typeof reply?.sessionId !== 'string') {
      throw new Error('acp session/new returned no sessionId')
    }
    // The picker serves what the agent reported; the dialect knows where the
    // list lives. Reported even when empty — an agent that serves nothing must
    // be able to replace whatever was believed before.
    if (this.options.dialect !== undefined && this.options.onModels !== undefined) {
      this.options.onModels(this.options.dialect.readModels(reply))
    }
    if (this.options.modeId !== undefined) {
      await this.client.request('session/set_mode', { sessionId: reply.sessionId, modeId: this.options.modeId })
    }
    return reply.sessionId
  }
}

/**
 * Fail a handshake that never finishes.
 *
 * The timer is cleared on whichever side wins, so a turn that finished normally
 * does not leave a pending rejection behind to surface in an unrelated place.
 */
function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, ms)
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * The call id a tool/result answers, read off the PROJECTED payload.
 *
 * The id lives in `message.toolCallId` — the folded id the card carried and
 * the end-of-turn result carries, so the live settle and the turn-end strip
 * key on exactly the same string ("exactly once" by construction).
 */
function resultCallIdOf(event: ProjectionEvent): string | undefined {
  const message = recordOf(recordOf(event.payload)['message'])
  const callId = message['toolCallId']
  return typeof callId === 'string' ? callId : undefined
}

/** 回合被宿主停止时的结束原因——run 与 runSteps 共用同一文案。 */
function abortedEnd(): StepEndReason {
  return { kind: 'aborted', reason: 'the turn was stopped; the agent was asked to cancel' }
}

/**
 * The projection with the calls already written live removed.
 *
 * The live path files a one-block announcement before each card and the result
 * the moment a terminal frame arrives; those would be doubles here. An
 * unsettled id keeps its result, which is exactly the fallback the live write
 * counts on when its own write failed. Shared by run()'s turn-end write and
 * every segment close — one filter, one notion of "already on the log".
 */
function withoutLiveWritten(produced: readonly ProjectionEvent[], liveCards: LiveCards): readonly ProjectionEvent[] {
  return produced.flatMap(event => {
    if (event.type === 'assistant/message') return withoutAnnouncedToolBlocks(event, liveCards.written)
    if (event.type === 'tool/result') {
      const toolCallId = resultCallIdOf(event)
      return toolCallId !== undefined && liveCards.settled.has(toolCallId) ? [] : [event]
    }
    if (event.type !== 'tool/call') return [event]
    const callId = recordOf(event.payload)['callId']
    return typeof callId === 'string' && liveCards.written.has(callId) ? [] : [event]
  })
}

/**
 * The end-of-turn message with the calls already announced live removed.
 *
 * The live path files a one-block announcement before each card, so those
 * `tool-call` blocks are already in the log; leaving them in the step's message
 * too would register the same call twice, which the log rejects. Only the
 * blocks for calls written live are dropped — a call whose live write failed
 * keeps its block here, so its card (filed at turn end) still has an
 * announcement ahead of it. A message left with nothing but dropped blocks is
 * removed entirely; the answer text, if any, is kept.
 */
function withoutAnnouncedToolBlocks(event: ProjectionEvent, written: ReadonlySet<string>): ProjectionEvent[] {
  if (event.type !== 'assistant/message') return [event]
  const payload = event.payload as Record<string, unknown>
  const message = payload['message'] as Record<string, unknown> | undefined
  const content = message?.['content']
  if (!Array.isArray(content)) return [event]
  const kept = content.filter(block => {
    const b = block as { type?: unknown; id?: unknown }
    if (b?.type !== 'tool-call') return true
    return !(typeof b.id === 'string' && written.has(b.id))
  })
  if (kept.length === content.length) return [event]
  if (kept.length === 0) return []
  return [{ ...event, payload: { ...payload, message: { ...(message as Record<string, unknown>), content: kept } } }]
}