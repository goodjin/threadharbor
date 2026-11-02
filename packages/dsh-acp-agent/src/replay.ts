/**
 * Putting a finished conversation back on a record, one event at a time.
 *
 * A switch continues in a NEW session — a started session's agent cannot be
 * changed, and a fork of one replays that same lock. The conversation the user
 * was looking at therefore does not come along by itself: the new agent reads
 * it as primed text, and its session's own record starts empty. That is what
 * made the switch look like it lost the history — the user opened the new
 * session and read a blank thread.
 *
 * So the visible conversation is copied into the new session's log, event by
 * event and in order, before the new session is asked anything. What travels is
 * the record the user already read: the questions, the answers, the tool calls
 * and their results, and the turn and step boundaries that group them. What
 * stays behind is the old agent's own bookkeeping — its request header, its
 * system prompt, its retry records, its seed marker — because those belong to
 * the agent that is being left, not to the conversation.
 *
 * Two rules keep the copy honest:
 *
 * - it stops at the last completed turn. The turn that is switching away is
 *   open and holds the question, which is about to be asked in the new session;
 *   copying it would put one question in two conversations;
 * - a surface replacement (a compaction checkpoint) is left behind rather than
 *   replayed, because it names surface positions by sequence number and those
 *   positions belong to different events here.
 */

/** One event as a session log exposes it, read structurally. */
export type LoggedEvent = {
  readonly type: string
  readonly data?: unknown
  readonly surfaceOp?: unknown
}

/** One event to write into the new session, in the order it must be written. */
export type ReplayStep = {
  readonly type: string
  readonly data: unknown
  /** Model-visible messages enter the surface; the rest are log-only records. */
  readonly surface: boolean
}

export type ReplayPlan = {
  readonly steps: readonly ReplayStep[]
  /** How many finished turns the plan carries. */
  readonly turns: number
}

/**
 * The events a copied conversation is made of.
 *
 * Boundaries travel with the content because the view groups content under the
 * step the loop opened for it: content written under a step the view never saw
 * start is dropped by the client. The two bridged sub-call records travel with
 * the tool calls they belong to, so a nested call still renders inside its
 * parent's card.
 */
const CARRIED_TYPES: ReadonlySet<string> = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/ptc-dispatch-start',
  'tool/ptc-dispatch',
  'tool/result',
])

/** Events that enter the model-visible surface, and so need the append intent. */
const SURFACE_TYPES: ReadonlySet<string> = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
])

/** Whether this event is a plain surface append, or a replacement to leave behind. */
function isPlainAppend(event: LoggedEvent): boolean {
  return event.surfaceOp === undefined || event.surfaceOp === 'append'
}

/** One turn's worth of steps, with the boundaries that place them. */
function turnSteps(events: readonly LoggedEvent[]): ReplayStep[] {
  const steps: ReplayStep[] = []
  for (const event of events) {
    if (!CARRIED_TYPES.has(event.type)) continue
    if (!isPlainAppend(event)) continue
    steps.push({ type: event.type, data: event.data, surface: SURFACE_TYPES.has(event.type) })
  }
  return steps
}

/** Split a log's prefix into its finished turns, oldest first. */
function finishedTurns(events: readonly LoggedEvent[]): ReplayStep[][] {
  const turns: ReplayStep[][] = []
  let open: ReplayStep[] | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      // A turn that starts before another one closed means the log is not the
      // record this planner understands; the newest closed turn wins and the
      // half-open one is dropped with the tail.
      if (open !== undefined) open = undefined
      open = []
    }
    if (open === undefined) continue
    open.push(...turnSteps([event]))
    if (event.type === 'turn/end') {
      turns.push(open)
      open = undefined
    }
  }
  return turns
}

/**
 * The conversation to copy, as events ready to write.
 * @param events - the source session's log, in order; anything after the last completed turn is ignored.
 */
export function planReplay(events: readonly LoggedEvent[]): ReplayPlan {
  const turns = finishedTurns(events)
  return { steps: turns.flat(), turns: turns.length }
}

/** The session log's append, if this session has one. */
function appendOf(session: unknown): ((type: string, data: unknown, intent?: unknown) => unknown) | undefined {
  const holder = session as { append?: unknown } | undefined
  if (typeof holder?.append !== 'function') return undefined
  const append = holder.append as (this: unknown, type: string, data: unknown, intent?: unknown) => unknown
  return (type, data, intent) => (intent === undefined ? append.call(holder, type, data) : append.call(holder, type, data, intent))
}

/** Whether this session has a log to write into at all. */
export function hasLog(session: unknown): boolean {
  return appendOf(session) !== undefined
}

/**
 * Write one plan into a live session.
 *
 * A refusal part-way leaves the session holding half a conversation, so the
 * error names how far it got — the caller decides whether that session is
 * still worth continuing in.
 * @returns how many events were written.
 */
export function replayInto(session: unknown, steps: readonly ReplayStep[]): number {
  const append = appendOf(session)
  if (append === undefined) {
    throw new Error('cannot replay the conversation: this session has no log to append to')
  }
  let written = 0
  for (const step of steps) {
    try {
      if (step.surface) append(step.type, step.data, { surfaceOp: 'append' })
      else append(step.type, step.data)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `cannot replay the conversation: ${written} of ${steps.length} events written before this session refused one — ${reason}`,
      )
    }
    written += 1
  }
  return written
}
