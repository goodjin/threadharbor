/**
 * Driving one session's turns against a real ACP agent.
 *
 * The session is opened once and reused. `session/new` is expensive — codex and
 * grok both load a model catalogue and probe their environment during it — and a
 * DSH session is long-lived, so re-opening per turn would charge every turn a
 * setup the agent already paid.
 */

import type { AcpStepResult, StepDecisionLike, StepEndReason, TurnContext } from './dispatch.ts'
import { projectToolCallFrame } from '@threadharbor/dsh-acp-agent'
import type { AcpDialect, AcpFrame } from '@threadharbor/dsh-acp-agent'

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
    try {
      live.write([event])
    } catch {
      return
    }
    live.written.add(callId)
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
    const sessionId = await this.open(turn.sessionId)
    this.turnFrames = []
    this.aborted = false
    // Bound before the prompt goes out: a tool frame only arrives once the
    // agent has the question, but the binding must not be able to lose the
    // race with it. Held in a local too — the field is cleared the moment the
    // prompt settles, and the turn-end write below still needs the written
    // record to know which cards not to write a second time.
    const liveCards = this.options.dialect === undefined ? undefined : {
      turn: turn.position.turn,
      step: turn.position.step,
      write: turn.write,
      written: new Set<string>(),
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
    const question = promptText(decision.messages)
    const text = handedOver !== undefined
      ? `${handedOver}\n\n${question}`
      : replayed !== undefined
        ? `【之前对话】\n${replayed}\n\n【当前问题】\n${question}`
        : question
    const params: Record<string, unknown> = {
      sessionId,
      prompt: [{ type: 'text', text }],
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
      // Remember it, settle what was streamed, then rethrow: the caller owns the
      // error handling, and a turn that failed must not leave a stream hanging.
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
      // The turn produced nothing worth keeping; close the stream without
      // claiming a commit that will not happen.
      stream?.abandon()
      if (handedOver !== undefined) this.options.primer?.restore(turn.sessionId, handedOver)
      if (replayed !== undefined) {
        // The transcript rode this very prompt, so it is the likeliest reason
        // the agent refused it — a first request suddenly oversized or in a
        // shape the agent does not take. End the turn naming that instead of
        // dying with the agent's bare error: the user keeps their question on
        // the record and reads why the answer never came, rather than watching
        // the turn vanish into an opaque failure. Not classified further — any
        // failure of a prompt that carried the replay says so here.
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
      throw failure
    }

    const result: AcpStepResult = {
      frames: [...this.turnFrames],
      // The stop outranks whatever the agent replied: once the turn was
      // stopped and the agent told to cancel, the turn is what the user made
      // it — stopped — whatever raced out of the agent on the way down.
      end: this.aborted
        ? { kind: 'aborted', reason: 'the turn was stopped; the agent was asked to cancel' }
        : toEndReason(stopReason),
      ...(stream === undefined ? {} : { stream: stream.records() }),
    }
    // Produce after the run, write after that, and only then announce the end:
    // the closing frame carries the message's sequence number, and pointing at
    // a message that is not written yet shows the user text that then vanishes.
    // Cards already written mid-turn are stripped here, so the log carries
    // each exactly once; anything the mid-turn writer could not track (a frame
    // with no call id) still rides the turn-end write as before.
    const produced = turn.produce(result)
    const events = liveCards === undefined
      ? produced
      : produced.filter(event => {
          if (event.type !== 'tool/call') return true
          const callId = recordOf(event.payload)['callId']
          return !(typeof callId === 'string' && liveCards.written.has(callId))
        })
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
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
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