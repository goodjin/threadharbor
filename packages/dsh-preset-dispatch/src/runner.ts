/**
 * Driving one session's turns against a real ACP agent.
 *
 * The session is opened once and reused. `session/new` is expensive — codex and
 * grok both load a model catalogue and probe their environment during it — and a
 * DSH session is long-lived, so re-opening per turn would charge every turn a
 * setup the agent already paid.
 */

import type { AcpStepResult, StepDecisionLike, StepEndReason, TurnContext } from './dispatch.ts'
import { UNDELIVERED } from './content-writer.ts'
import type { UndeliveredAttachment } from './content-writer.ts'
import { projectToolCallAnnouncement, projectToolCallFrame, projectToolResultFrame } from '@threadharbor/dsh-acp-agent'
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

export class AcpTurnRunner {
  private sessionId: string | undefined
  private dshSessionId: string | undefined
  private opening: Promise<string> | undefined
  private turnFrames: AcpFrame[] = []
  private stream: TurnStreamPort | undefined
  /** Set when this turn's stop signal fired; everything after it is dropped. */
  private aborted = false
  /**
   * The turn in flight, for writing a tool card as its first frame arrives.
   *
   * Bound for the prompt's duration only: a frame can reach the log as
   * mid-turn only while this turn's writer is the one that owns it, and a
   * frame arriving between turns belongs to no turn at all (it falls out of
   * the frame list when the next turn starts, exactly as before).
   */
  private liveCards: {
    readonly turn: number
    readonly step: number
    readonly write: TurnContext['write']
    /** Call ids whose opening card already went to the log this turn. */
    readonly written: Set<string>
    /** Call ids whose result already went to the log this turn. */
    readonly settled: Set<string>
  } | undefined

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
  private observe(frame: AcpFrame): void {
    // 中止后到达的帧一律丢弃: the agent had not processed the cancel yet and
    // kept talking. Those frames belong to a turn nobody is reading, and
    // projecting them would resurrect text under a turn that ended aborted.
    if (this.aborted) return
    this.turnFrames.push(frame)
    this.writeOpeningCard(frame)
    this.writeSettledResult(frame)
    const stream = this.stream
    if (stream === undefined) return
    // Held locally so nothing can clear it while this frame is being pushed.
    this.pushToStream(frame, stream)
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
    this.turnFrames = []
    this.aborted = false
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
          frames: [...this.turnFrames],
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

    const result: AcpStepResult = {
      frames: [...this.turnFrames],
      // The stop outranks whatever the agent replied — or whatever failure
      // raced out of the dying connection: once the turn was stopped and the
      // agent told to cancel, the turn is what the user made it — stopped.
      end: this.aborted
        ? { kind: 'aborted', reason: 'the turn was stopped; the agent was asked to cancel' }
        : failure !== undefined
          ? failureEndOf(failure)
          : toEndReason(stopReason),
      ...(stream === undefined ? {} : { stream: stream.records() }),
    }
    // Produce after the run, write after that, and only then announce the end:
    // the closing frame carries the message's sequence number, and pointing at
    // a message that is not written yet shows the user text that then vanishes.
    // Cards already written mid-turn are stripped here, and so are the results
    // the terminal frames already filed live; anything the mid-turn writer
    // could not track (a frame with no call id, a call whose live write
    // failed) still rides the turn-end write as before.
    const produced = turn.produce(result)
    // The held-back attachments are reported ahead of the turn's own content:
    // the drop happened when the prompt was built, and the writer expands the
    // marker into a call/result pair that never touches the message sequence
    // the stream settles on.
    // Same rule as the live-card binding above: no position means nothing may be
    // written, and this notice is content like any other — the writer expands it
    // into a tool call/result pair, which the log validates against the open turn.
    const notice = undelivered.length === 0 || turn.position === undefined
      ? []
      : [{
        type: UNDELIVERED,
        payload: {
          turn: turn.position.turn,
          step: turn.position.step,
          attachments: undelivered,
        },
      }]
    const events = [
      ...notice,
      ...(liveCards === undefined
        ? produced
        : produced.flatMap(event => {
            if (event.type === 'assistant/message') return withoutAnnouncedToolBlocks(event, liveCards.written)
            if (event.type === 'tool/result') {
              // A result whose terminal frame already filed it live would be a
              // second result for one call — skipped. An unsettled id keeps
              // its result here, which is exactly the fallback the live write
              // counts on when its own write failed.
              const toolCallId = resultCallIdOf(event)
              return toolCallId !== undefined && liveCards.settled.has(toolCallId) ? [] : [event]
            }
            if (event.type !== 'tool/call') return [event]
            const callId = recordOf(event.payload)['callId']
            return typeof callId === 'string' && liveCards.written.has(callId) ? [] : [event]
          })),
    ]
    const seq = turn.write(events)
    if (stream === undefined) return result
    if (seq === undefined) stream.abandon()
    else stream.settle('assistant/message', () => seq)
    return result
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