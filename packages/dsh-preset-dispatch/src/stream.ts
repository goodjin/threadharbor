/**
 * Streaming an external agent's turn so it looks live.
 *
 * DSH's session log has no incremental append: an assistant message is written
 * once, after the whole turn. Live appearance comes from a separate,
 * process-local channel (`agent/assistant-stream`) whose chunks are explicitly
 * transient. So streaming is two things at once — frames on that channel while
 * the agent works, and exactly one durable message afterwards — joined by the
 * same attempt identity.
 *
 * Three details are easy to get wrong, and each one has a distinct failure:
 *
 *   - `revision` is monotone across the **whole agent lifecycle**. A per-turn
 *     counter restarts at 1 and the UI reads the new turn as a replacement
 *     stream, redrawing from scratch.
 *   - The durable append happens **before** the end frame. The reverse order
 *     reports a finished stream whose content cannot be found.
 *   - `assistant/message` carries the compacted stream inline and the field is
 *     required, so the packed runs are built rather than omitted.
 */

/** One packed run of deltas, as the durable message embeds it. */
export type StreamRecord =
  | { readonly type: 'text-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly texts: readonly string[] }
  | { readonly type: 'reasoning-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly texts: readonly string[] }

type MutableRun = {
  type: 'text-chunks' | 'reasoning-chunks'
  time0: number
  index: number
  dt: number[]
  texts: string[]
  lastTime: number
}

export type StreamOptions = {
  /** Publish one frame on the agent's stream channel. */
  readonly emit: (frame: Record<string, unknown>) => void
  /** Allocate the next frame revision. Shared across the agent's lifetime. */
  readonly nextRevision: () => number
  readonly sessionId: string
  /** Attempt counter within the attached session. */
  readonly attempt: number
  readonly turn: number
  readonly step: number
  /** Injectable for tests; defaults to the wall clock. */
  readonly now?: () => number
}

export class AcpAssistantStream {
  readonly attemptId: string
  private readonly runs: MutableRun[] = []
  private index = 0
  private ended = false

  constructor(private readonly options: StreamOptions) {
    this.attemptId = `${options.sessionId}:${options.attempt}`
  }

  /** Whether this attempt has already emitted its terminal frame. */
  get finished(): boolean { return this.ended }

  /** Publish the opening marker before the first delta. */
  start(): void {
    this.options.emit({
      type: 'start',
      attemptId: this.attemptId,
      revision: this.options.nextRevision(),
      turn: this.options.turn,
      step: this.options.step,
    })
  }

  textDelta(text: string, index = 0): void {
    this.pushDelta('text-chunks', text, index)
  }

  reasoningDelta(text: string, index = 0): void {
    this.pushDelta('reasoning-chunks', text, index)
  }

  /** The compacted stream the durable message embeds. */
  records(): readonly StreamRecord[] {
    return this.runs.map(run => ({
      type: run.type,
      time0: run.time0,
      index: run.index,
      dt: [...run.dt],
      texts: [...run.texts],
    }))
  }

  /**
   * Commit: write the durable event, then announce the stream ended.
   *
   * The order is the contract — an end frame carrying a sequence number proves
   * the content is already findable.
   */
  settle(eventType: 'assistant/message' | 'assistant/attempt', append: () => number): void {
    let seq: number
    try {
      seq = append()
    } catch (error: unknown) {
      // Nothing was written, so say so rather than claim a commit that did not
      // happen — and let the caller see the failure.
      this.abandon()
      throw error
    }
    this.ended = true
    this.options.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.options.nextRevision(),
      index: this.index,
      outcome: { kind: 'committed', eventType, seq },
    })
  }

  /** Report that no durable event could be committed. */
  abandon(): void {
    if (this.ended) return
    this.ended = true
    this.options.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.options.nextRevision(),
      index: this.index,
      outcome: { kind: 'abandoned' },
    })
  }

  private pushDelta(type: 'text-chunks' | 'reasoning-chunks', text: string, index: number): void {
    if (this.ended) {
      // A delta after settlement would land in a stream the UI already closed.
      throw new Error('acp stream: attempt already ended')
    }
    const time = this.options.now?.() ?? Date.now()
    const previous = this.runs.at(-1)
    if (previous !== undefined && previous.type === type && previous.index === index && time >= previous.lastTime) {
      previous.dt.push(time - previous.lastTime)
      previous.texts.push(text)
      previous.lastTime = time
    } else {
      this.runs.push({ type, time0: time, index, dt: [], texts: [text], lastTime: time })
    }
    this.options.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.options.nextRevision(),
      index: this.index++,
      time,
      chunk: type === 'text-chunks'
        ? { type: 'text-delta', index, text }
        : { type: 'reasoning-delta', index, text },
    })
  }
}