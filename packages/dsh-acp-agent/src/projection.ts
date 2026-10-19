/**
 * Translate one turn of ACP session updates into DSH session events.
 *
 * The projection itself is agent-agnostic: every field-reading decision is
 * delegated to an `AcpDialect`, because the three agents we drive disagree
 * about where a tool's name lives, where its output lives, and how it reports
 * tokens. What lives here is the shape of a DSH turn, which is fixed.
 */

import type { AcpFrame } from './acp-client.ts'
import type { AcpDialect, ToolCall, TurnUsage } from './dialects/types.ts'
import { assistantMessageEvent, toolCallAnnouncementEvent, toolResultMessageEvent, userMessageEvent } from './message-events.ts'

/**
 * One packed run of deltas, as the durable message embeds it.
 *
 * Lives here rather than with the stream writer: it is part of the message
 * shape on the wire, and the projection that writes that shape must not have to
 * depend on the package that streams it.
 */
export type StreamRecord =
  | { readonly type: 'text-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly texts: readonly string[] }
  | { readonly type: 'reasoning-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly texts: readonly string[] }

/** The DSH event names this projection writes. */
export type ProjectionEvent = { readonly type: string; readonly payload: unknown }

/**
 * A delegated run the agent reported through the ACP subagent draft
 * (#1992): a spawned subagent session or an async background task. Both are
 * synthetic tool cards — `subagent` and `async_task` are names the reference
 * DSH client renders (a dedicated view, the generic row), so the run is
 * visible in the transcript without pretending to be a DSH session.
 */
type SpawnedRun = {
  readonly call: ToolCall
  readonly kind: 'subagent' | 'task'
  /** True once the agent sent a terminal state for this run. */
  settled: boolean
}

type Accumulator = {
  thought: readonly string[]
  text: readonly string[]
  readonly tools: Map<string, ToolCall>
  /** Subagent and async-task runs, keyed like the cards that render them. */
  readonly spawned: Map<string, SpawnedRun>
  /** Session ids whose frames belong to a spawned subagent, not the parent. */
  readonly childSessions: ReadonlySet<string>
  /** The turn's usage, when the agent reported one complete enough to write. */
  usage?: TurnUsage | undefined
  /** The compacted live stream, filled in when the turn ran with streaming on. */
  stream?: readonly StreamRecord[]
}

/** Prefix that names a run the agent never reported a terminal state for. */
const STILL_RUNNING = '[still running]'

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOf(content: unknown): string {
  const entry = recordOf(content)
  return typeof entry['text'] === 'string' ? (entry['text'] as string) : ''
}

/**
 * A content block of the durable assistant message.
 *
 * The log validates a tool lifecycle by reading `tool-call` blocks out of this
 * message: a `tool/call` is only admissible once its id, name and arguments
 * have appeared here, and the step may not close with one still open. The ACP
 * projection used to write the `tool/call`/`tool/result` pair without the
 * announcement, so every card it persisted was an orphan the log refused at
 * open time. The native loop carries all three in one message; this is that
 * shape.
 */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }

function assistantEvent(
  dialect: AcpDialect,
  acc: Accumulator,
  content: readonly ContentBlock[],
  turn: number,
  step: number,
): ProjectionEvent {
  // DSH's `TokenUsage` requires the input/output pair; anything less is
  // not a usage but a fragment, and DSH's own token projection computes
  // its uncached-input bucket straight from `usage.inputTokens` — a
  // fragment there turned that bucket into `NaN` and made every later
  // history load of the session fail. Optional buckets ride along only
  // when the agent reported them; a missing report is never written as 0.
  const usage = writableUsage(acc.usage)
  // 形状由 message-events 的构造器保证（model 来源 + provider/model），这里只
  // 负责把非有限数挡在事件之外。
  const event = assistantMessageEvent({
    turn,
    step,
    content,
    provider: `acp-${dialect.id}`,
    model: dialect.id,
    stream: acc.stream ?? [],
    ...(usage === undefined ? {} : { usage }),
  })
  return { ...event, payload: withoutNonFinite(event.payload) }
}

/**
 * The usage as the session log may carry it, or nothing.
 *
 * The required pair must both be finite non-negative integers — that is the
 * same bar DSH's own token meter applies before it believes a usage. One
 * missing or broken half means the agent reported no usable usage, and a
 * fragment must not be written: there is no honest way to fill it in.
 */
function writableUsage(usage: TurnUsage | undefined): TurnUsage | undefined {
  if (usage === undefined) return undefined
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return undefined
  const buckets = {
    ...optionalBucket(usage.cacheReadTokens, 'cacheReadTokens'),
    ...optionalBucket(usage.cacheWriteTokens, 'cacheWriteTokens'),
    ...optionalBucket(usage.reasoningTokens, 'reasoningTokens'),
    ...optionalBucket(usage.totalTokens, 'totalTokens'),
  }
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...buckets }
}

/** DSH's own bar for a believable count: a safe, finite, non-negative integer. */
function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/** One optional bucket, kept only when the agent reported a believable count. */
function optionalBucket(value: number | undefined, name: keyof TurnUsage): Partial<TurnUsage> {
  return value !== undefined && isCount(value) ? { [name]: value } : {}
}

/**
 * The projection's last gate: a number that is not finite never reaches an
 * event.
 *
 * JSON has no way to carry NaN or Infinity, but a frame value like `1e999`
 * parses into exactly that, and the session log's writer rejects a whole
 * event on the first unrepresentable number — one bad field would take the
 * turn's answer down with it. This walk drops such a field instead, keeping
 * the event; values it does not touch are returned as the same reference, so
 * the happy path stays allocation-free.
 */
export function withoutNonFinite<T>(value: T): T {
  return clean(value) === DROP ? value : (clean(value) as T)
}

/** Signals "this value cannot be written"; never escapes the module. */
const DROP = Symbol('non-finite')

function clean(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : DROP
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined
    for (let index = 0; index < value.length; index++) {
      const item = clean(value[index])
      if (item === DROP) { copy ??= value.slice(0, index); continue }
      if (item !== value[index] && copy === undefined) copy = value.slice(0, index)
      copy?.push(item)
    }
    return copy ?? value
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    let copy: Record<string, unknown> | undefined
    for (const [key, member] of Object.entries(source)) {
      const cleanedMember = clean(member)
      if (cleanedMember === DROP) {
        copy ??= {}
        for (const [kept, keptValue] of Object.entries(source)) {
          if (kept === key) break
          copy[kept] = keptValue
        }
        continue
      }
      if (cleanedMember !== member && copy === undefined) {
        copy = {}
        for (const [kept, keptValue] of Object.entries(source)) {
          if (kept === key) break
          copy[kept] = keptValue
        }
      }
      if (copy !== undefined) copy[key] = cleanedMember
    }
    return copy ?? value
  }
  return value
}

/**
 * Fold one turn's ACP frames into the events that describe it.
 *
 * Returns an ordered event list; an empty list means the frames carried
 * nothing the session log records. The caller appends them in order.
 */
export function projectTurn(
  frames: readonly AcpFrame[],
  options: { readonly turn: number; readonly dialect: AcpDialect },
): ProjectionEvent[] {
  const { dialect, turn } = options
  return [
    { type: 'turn/start', payload: { turn } },
    { type: 'step/start', payload: { turn, step: 1 } },
    ...contentEvents(accumulate(frames, dialect), { dialect, turn, step: 1 }),
    { type: 'step/end', payload: { turn, step: 1 } },
    { type: 'turn/end', payload: { turn } },
  ]
}

/**
 * The model-visible events of one step, without the boundaries around them.
 *
 * For a plugin that replaces the loop's `step`: the surrounding native loop still
 * appends `step/start` before the call and `step/end` in its finally, so emitting
 * boundaries here too would write each one twice into the session log.
 */
export function projectStepContent(
  frames: readonly AcpFrame[],
  options: {
    readonly turn: number
    readonly step: number
    readonly dialect: AcpDialect
    /**
     * The compacted live stream, when the turn ran with streaming on.
     *
     * Without it the durable message carries `stream: []`: the user watches the
     * text arrive, reloads, and finds it gone. That is the whole transcript
     * disagreeing with what was just on screen.
     */
    readonly stream?: readonly StreamRecord[]
  },
): ProjectionEvent[] {
  const { dialect, turn, step } = options
  return contentEvents(accumulate(frames, dialect), {
    dialect,
    turn,
    step,
    ...(options.stream === undefined ? {} : { stream: options.stream }),
  })
}

/**
 * The tool events of one turn, in frame order.
 *
 * `projectTurn`/`projectStepContent` fold a whole turn first and write every
 * tool card when the turn is over, so nothing shows while a tool still runs.
 * This walk emits as the frames arrive instead: the FIRST frame seen for a
 * call id — whichever of `tool_call`/`tool_call_update` it is — opens the
 * card, the terminal frame (`completed`/`failed`) closes it with its result,
 * and the non-terminal updates in between fold into the accumulated call
 * without emitting (their state reaches the log through that result).
 *
 * One call, one result: a terminal frame already seen for the id never emits
 * a second one, matching the end-of-turn shape of exactly one result per
 * call. Call ids pair with their results downstream by the writer's
 * `turn:callId` key, so a call id reused in a later turn stays on its own
 * turn — this function is per-turn, and every payload carries its turn.
 */
export function projectTurnIncremental(
  frames: readonly AcpFrame[],
  options: { readonly turn: number; readonly dialect: AcpDialect },
): ProjectionEvent[] {
  const { dialect, turn } = options
  // Same numbering as `projectTurn`: one step per turn, announced by the loop.
  const step = 1
  const tools = new Map<string, ToolCall>()
  const opened = new Set<string>()
  const settled = new Set<string>()
  const events: ProjectionEvent[] = []

  for (const frame of frames) {
    if (frame.method !== 'session/update') continue
    const update = recordOf(recordOf(frame.params)['update'])
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind !== 'tool_call' && kind !== 'tool_call_update') continue
    const id = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : undefined
    const carried = id === undefined ? undefined : tools.get(id)
    const call = dialect.foldTool(carried, update)
    tools.set(typeof update['toolCallId'] === 'string' ? update['toolCallId'] : call.callId, call)
    if (!opened.has(call.callId)) {
      opened.add(call.callId)
      events.push(toolCallEvent(dialect, call, turn, step))
    }
    if ((call.status === 'completed' || call.status === 'failed') && !settled.has(call.callId)) {
      settled.add(call.callId)
      events.push(toolResultEvent(call, turn, step))
    }
  }
  return events
}

/**
 * The name a tool/call card carries, as the DSH client renders it.
 *
 * The agent reports its own native names — claude's Anthropic names ("Bash"),
 * codex/cursor's `kind` ("execute"), grok's first-frame title
 * ("run_terminal_command") — but the DSH client picks a card's view by matching
 * the event `name` against ITS known tool names (`classifyTool` and the keyed
 * `tool.call.toolview` registry). A name it does not know degrades to the
 * generic card. The dialect's `toolNameMap` (AcpCapabilities) carries the
 * measured translations, every value verified to be a name the reference DSH
 * client actually recognizes; a name with no entry passes through unchanged —
 * the generic card is the honest fallback, a made-up one renders nothing.
 */
export function mapToolName(dialect: AcpDialect, rawName: string): string {
  return dialect.capabilities.toolNameMap[rawName] ?? rawName
}

/** The log-only call card, the one shape `contentEvents` has always written. */
function toolCallEvent(dialect: AcpDialect, tool: ToolCall, turn: number, step: number): ProjectionEvent {
  return {
    type: 'tool/call',
    payload: withoutNonFinite({ turn, step, callId: tool.callId, name: mapToolName(dialect, tool.name), arguments: JSON.stringify(tool.arguments) }),
  }
}

/** The result message answering a call — identical from both projections. */
function toolResultEvent(tool: ToolCall, turn: number, step: number): ProjectionEvent {
  const isError = tool.status === 'failed'
  const event = toolResultMessageEvent({
    turn,
    step,
    callId: tool.callId,
    text: tool.output,
    isError,
    ...(isError
      ? { error: { name: 'tool', code: tool.status ?? 'failed', ...(tool.title === undefined ? {} : { reason: tool.title }) } }
      : {}),
  })
  return { ...event, payload: withoutNonFinite(event.payload) }
}

/**
 * The opening card of one tool frame, for mid-turn writing.
 *
 * The turn's full projection can only run when the turn is over; the runner
 * calls this as each frame arrives, so a card exists in the log while the
 * agent still works. It folds just this frame — the caller invokes it only
 * for a call id's first frame, where nothing is carried yet, exactly like the
 * first frame in `projectTurnIncremental`. The payload is the shared tool/call
 * shape, identical to what the end-of-turn projection emits for the same
 * frame; the caller also writes terminal results live and deduplicates both
 * against the final projection.
 */
export function projectToolCallFrame(
  frame: AcpFrame,
  options: { readonly turn: number; readonly step: number; readonly dialect: AcpDialect; readonly carried?: ToolCall },
): ProjectionEvent | undefined {
  const update = recordOf(recordOf(frame.params)['update'])
  const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
  if (kind !== 'tool_call' && kind !== 'tool_call_update') {
    // A spawned run opens its card the same way — the live writer calls this
    // the moment the frame arrives, and the shared construction keeps the
    // mid-turn card identical to the turn-end one.
    const spawned = spawnedCallOf(update)
    return spawned === undefined ? undefined : toolCallEvent(options.dialect, spawned, options.turn, options.step)
  }
  const call = options.dialect.foldTool(options.carried, update)
  return toolCallEvent(options.dialect, call, options.turn, options.step)
}

/**
 * The announcement message that must precede a `tool/call`, for the live path.
 *
 * The end-of-turn projection folds every call's block into the step's one
 * message, which is written after the cards — too late to admit them. So the
 * runner files this single-block message the moment a card opens, and the
 * turn-end message keeps only the answer text. The block carries exactly what
 * the `tool/call` payload carries (same name mapping, same serialized
 * arguments), or the log's "does not match one advertised tool call" fires on
 * open.
 */
export function projectToolCallAnnouncement(
  frame: AcpFrame,
  options: { readonly turn: number; readonly step: number; readonly dialect: AcpDialect; readonly carried?: ToolCall },
): ProjectionEvent | undefined {
  const update = recordOf(recordOf(frame.params)['update'])
  const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
  if (kind !== 'tool_call' && kind !== 'tool_call_update') {
    const spawned = spawnedCallOf(update)
    return spawned === undefined ? undefined : announcementEvent(options.dialect, spawned, options.turn, options.step)
  }
  const call = options.dialect.foldTool(options.carried, update)
  return announcementEvent(options.dialect, call, options.turn, options.step)
}

/** Project a completed/failed tool frame immediately, retaining earlier arguments and output. */
export function projectToolResultFrame(
  frame: AcpFrame,
  options: { readonly turn: number; readonly step: number; readonly dialect: AcpDialect; readonly carried?: ToolCall },
): ProjectionEvent | undefined {
  if (frame.method !== 'session/update') return undefined
  const update = recordOf(recordOf(frame.params)['update'])
  if (update['sessionUpdate'] !== 'tool_call' && update['sessionUpdate'] !== 'tool_call_update') return undefined
  const call = options.dialect.foldTool(options.carried, update)
  return call.status === 'completed' || call.status === 'failed'
    ? toolResultEvent(call, options.turn, options.step) : undefined
}

/** The one-block announcement message that admits a call's card. */
function announcementEvent(dialect: AcpDialect, call: ToolCall, turn: number, step: number): ProjectionEvent {
  const event = toolCallAnnouncementEvent({
    turn,
    step,
    callId: call.callId,
    name: mapToolName(dialect, call.name),
    arguments: JSON.stringify(call.arguments),
    provider: `acp-${dialect.id}`,
    model: dialect.id,
  })
  return { ...event, payload: withoutNonFinite(event.payload) }
}

function accumulate(frames: readonly AcpFrame[], dialect: AcpDialect): Accumulator {
  const thought: string[] = []
  const text: string[] = []
  const tools = new Map<string, ToolCall>()
  const spawned = new Map<string, SpawnedRun>()
  const childSessions = new Set<string>()
  let usage: TurnUsage | undefined

  for (const frame of frames) {
    if (frame.method === undefined) {
      // A reply frame — within a turn the only request this side sends is
      // `session/prompt`, so its reply is the one frame carrying usage. The
      // handshake replies (initialize, session/new) never reach a turn's
      // frames: they are answered while the session is being opened.
      if (frame.result !== undefined) usage = dialect.readReplyUsage(frame.result)
      continue
    }
    // The update gate is the dialect's: standard agents speak `session/update`,
    // grok also wraps lifecycle in a private method of its own.
    const update = dialect.frameUpdate === undefined
      ? (frame.method === 'session/update' ? recordOf(recordOf(frame.params)['update']) : undefined)
      : dialect.frameUpdate(frame)
    if (update === undefined) continue
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    // A frame tagged with a spawned subagent's session id belongs to that
    // child's own trace: its message chunks become the child card's reply,
    // and everything else it did stays out of the parent transcript.
    const frameSessionId = recordOf(frame.params)['sessionId']
    const childId = typeof frameSessionId === 'string' ? frameSessionId : undefined
    if (childId !== undefined && childSessions.has(childId)) {
      const run = spawned.get(childId)
      if (run !== undefined && kind === 'agent_message_chunk') {
        const chunk = textOf(update['content'])
        if (chunk.length > 0) run.call.output += chunk
      }
      continue
    }
    if (kind === 'agent_thought_chunk') thought.push(textOf(update['content']))
    else if (kind === 'agent_message_chunk') text.push(textOf(update['content']))
    else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const carried = typeof update['toolCallId'] === 'string' ? tools.get(update['toolCallId']) : undefined
      const call = dialect.foldTool(carried, update)
      tools.set(typeof update['toolCallId'] === 'string' ? update['toolCallId'] : call.callId, call)
    } else if (subagentUpdateOf(dialect, update) !== undefined) {
      // A spawned-run lifecycle update: one of the draft's own kinds, or a
      // vendor vocabulary the dialect normalized onto them (grok's).
      foldSubagentUpdate(subagentUpdateOf(dialect, update)!, spawned, childSessions)
    } else if (!dialect.isContent(update)) {
      // chatter — setup phases, command lists, context-window updates
    }
  }

  return { thought, text, tools, spawned, childSessions, usage }
}

/**
 * The draft-shaped subagent update this frame carries, or undefined.
 *
 * A dialect with a private subagent vocabulary (grok) normalizes FIRST — its
 * `subagent_spawned` shares the draft's kind name while carrying different
 * fields, so a kind-name shortcut would skip the normalization. The draft's
 * own kinds then pass through unchanged for dialects without a hook.
 */
function subagentUpdateOf(
  dialect: AcpDialect,
  update: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const normalized = dialect.normalizeSubagentUpdate?.(update)
  if (normalized !== undefined) return normalized
  const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
  if (kind === 'subagent_spawned' || kind === 'subagent_state_update'
    || kind === 'async_task_spawned' || kind === 'async_task_progress' || kind === 'async_task_state_update') return update
  return undefined
}

/** Fold one draft-shaped subagent lifecycle update into the spawned runs. */
function foldSubagentUpdate(
  update: Record<string, unknown>,
  spawned: Map<string, SpawnedRun>,
  childSessions: Set<string>,
): void {
  const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
  if (kind === 'subagent_spawned' || kind === 'async_task_spawned') {
    const call = spawnedCallOf(update)
    if (call !== undefined && !spawned.has(call.callId)) {
      spawned.set(call.callId, { kind: kind === 'subagent_spawned' ? 'subagent' : 'task', settled: false, call })
      if (kind === 'subagent_spawned') childSessions.add(call.callId)
    }
    return
  }
  if (kind === 'subagent_state_update') {
    const run = spawned.get(typeof update['subagentSessionId'] === 'string' ? update['subagentSessionId'] : '')
    if (run !== undefined && !run.settled) {
      // A vendor may deliver the child's whole reply on the terminal frame
      // (grok does); the draft's child-content routing already appended
      // whatever streamed earlier, so this only fills an empty output.
      if (typeof update['output'] === 'string' && run.call.output === '') run.call.output = update['output']
      run.settled = true
      run.call.status = update['state'] === 'completed' ? 'completed' : 'failed'
    }
    return
  }
  if (kind === 'async_task_progress') {
    const run = spawned.get(taskCallId(update))
    if (run !== undefined) {
      const summary = typeof update['summary'] === 'string' ? update['summary']
        : typeof update['description'] === 'string' ? update['description'] : undefined
      // The latest report is the task's visible state; an earlier one is
      // overwritten, exactly the way later tool frames overwrite a title.
      if (summary !== undefined) run.call.output = summary
    }
    return
  }
  if (kind === 'async_task_state_update') {
    const run = spawned.get(taskCallId(update))
    if (run !== undefined) {
      const summary = typeof update['summary'] === 'string' ? update['summary'] : undefined
      if (summary !== undefined) run.call.output = summary
      if (update['state'] === 'completed' || update['state'] === 'failed' || update['state'] === 'stopped') {
        run.settled = true
        run.call.status = update['state'] === 'completed' ? 'completed' : 'failed'
      }
    }
  }
}

/** The card key one async-task frame addresses, or '' when it names none. */
function taskCallId(update: Record<string, unknown>): string {
  return typeof update['asyncTaskId'] === 'string' ? `task-${update['asyncTaskId']}` : ''
}

/**
 * What one frame does to a spawned run's lifecycle, for a caller that tracks
 * runs across segment boundaries.
 *
 * The whole-turn fold (`accumulate`) sees every frame of a turn in one list and
 * needs no such reading; a segmenting pump does — a spawned run's birth, its
 * child's streaming output and its terminal frame can land in different
 * segments, so the pump mirrors `foldSubagentUpdate`'s per-frame effect here
 * instead of re-folding a frame list it no longer holds. The field rules are
 * the fold's own, verbatim: a subagent terminal's `output` fills only an empty
 * accumulated output, an async task's `summary` overwrites, and any terminal
 * state (completed/failed/stopped) settles.
 */
export type SpawnedFrameReading =
  | { readonly kind: 'spawn'; readonly call: ToolCall }
  | { readonly kind: 'progress'; readonly callId: string; readonly summary: string | undefined }
  | {
    readonly kind: 'state'
    readonly callId: string
    readonly settled: boolean
    readonly status: 'completed' | 'failed' | undefined
    /** The output text the frame carries, when it names one. */
    readonly output: string | undefined
    /** true = only fills an empty accumulated output; false = overwrites it. */
    readonly fillOnlyEmpty: boolean
  }

/** Read one frame's spawned-run effect, or undefined for any other frame. */
export function readSpawnedFrame(
  dialect: AcpDialect,
  update: Record<string, unknown>,
): SpawnedFrameReading | undefined {
  const spawnedUpdate = subagentUpdateOf(dialect, update)
  if (spawnedUpdate === undefined) return undefined
  const kind = typeof spawnedUpdate['sessionUpdate'] === 'string' ? spawnedUpdate['sessionUpdate'] : ''
  if (kind === 'subagent_spawned' || kind === 'async_task_spawned') {
    const call = spawnedCallOf(spawnedUpdate)
    return call === undefined ? undefined : { kind: 'spawn', call }
  }
  if (kind === 'subagent_state_update') {
    return {
      kind: 'state',
      callId: typeof spawnedUpdate['subagentSessionId'] === 'string' ? spawnedUpdate['subagentSessionId'] : '',
      settled: true,
      status: spawnedUpdate['state'] === 'completed' ? 'completed' : 'failed',
      output: typeof spawnedUpdate['output'] === 'string' ? spawnedUpdate['output'] : undefined,
      fillOnlyEmpty: true,
    }
  }
  if (kind === 'async_task_progress') {
    const summary = typeof spawnedUpdate['summary'] === 'string' ? spawnedUpdate['summary']
      : typeof spawnedUpdate['description'] === 'string' ? spawnedUpdate['description'] : undefined
    return { kind: 'progress', callId: taskCallId(spawnedUpdate), summary }
  }
  if (kind === 'async_task_state_update') {
    const state = spawnedUpdate['state']
    return {
      kind: 'state',
      callId: taskCallId(spawnedUpdate),
      settled: state === 'completed' || state === 'failed' || state === 'stopped',
      status: state === 'completed' ? 'completed' : state === 'stopped' || state === 'failed' ? 'failed' : undefined,
      output: typeof spawnedUpdate['summary'] === 'string' ? spawnedUpdate['summary'] : undefined,
      fillOnlyEmpty: false,
    }
  }
  return undefined
}

/** The result of one spawned run, for a caller that tracks the run itself. */
export function projectSpawnedResult(
  call: ToolCall,
  options: { readonly turn: number; readonly step: number },
): ProjectionEvent {
  return toolResultEvent(call, options.turn, options.step)
}

/**
 * The synthetic card one spawned-run update opens, or undefined for any other
 * update.
 *
 * Shared by the turn-end fold and the frame-scoped live projectors, so the
 * card a frame opens mid-turn is byte-identical to the one the turn-end write
 * would have produced — the writer pairs results to cards by that payload.
 */
function spawnedCallOf(update: Record<string, unknown>): ToolCall | undefined {
  const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
  if (kind === 'subagent_spawned') {
    const id = typeof update['subagentSessionId'] === 'string' ? update['subagentSessionId'] : undefined
    if (id === undefined) return undefined
    const name = typeof update['name'] === 'string' ? update['name'] : id
    const task = typeof update['task'] === 'string' ? update['task'] : ''
    return { callId: id, name: 'subagent', title: name, arguments: { prompt: task, agent: name }, output: '' }
  }
  if (kind === 'async_task_spawned') {
    const callId = taskCallId(update)
    if (callId === '') return undefined
    const name = typeof update['name'] === 'string' ? update['name'] : callId
    const args: Record<string, unknown> = { name }
    if (typeof update['taskType'] === 'string') args['taskType'] = update['taskType']
    if (typeof update['description'] === 'string' && update['description'] !== '') args['description'] = update['description']
    if (typeof update['outputFilePath'] === 'string') args['outputFilePath'] = update['outputFilePath']
    return { callId, name: 'async_task', title: name, arguments: args, output: '' }
  }
  return undefined
}

function contentEvents(
  acc: Accumulator,
  options: {
    readonly dialect: AcpDialect
    readonly turn: number
    readonly step: number
    readonly stream?: readonly StreamRecord[]
  },
): ProjectionEvent[] {
  const { dialect, turn, step } = options
  if (options.stream !== undefined) acc.stream = options.stream
  const { thought, text, tools, spawned } = acc
  const events: ProjectionEvent[] = []
  // One message per step, in the canonical native shape: the ordered blocks
  // carry the reasoning first, then the answer, then the tool-call blocks the
  // `tool/call` events below must have been announced by. Two separate messages
  // would survive in the log, but the conversation view folds each step's
  // message into one node by keeping the LAST assistant/message — a second
  // message would erase the first on screen.
  const runs = [...tools.values(), ...[...spawned.values()].map(run => run.call)]
  // Each block mirrors its `tool/call` exactly (same name mapping, same
  // serialization) — the validator compares the two, and a divergence is the
  // "does not match one advertised tool call" rejection.
  const content: ContentBlock[] = [
    ...(thought.length > 0 ? [{ type: 'reasoning' as const, text: thought.join('') }] : []),
    ...(text.length > 0 ? [{ type: 'text' as const, text: text.join('') }] : []),
    ...runs.map(tool => ({
      type: 'tool-call' as const,
      id: tool.callId,
      name: mapToolName(dialect, tool.name),
      arguments: JSON.stringify(tool.arguments),
    })),
  ]
  if (content.length > 0) events.push(assistantEvent(dialect, acc, content, turn, step))
  for (const tool of tools.values()) {
    events.push(toolCallEvent(dialect, tool, turn, step))
    events.push(toolResultEvent(tool, turn, step))
  }
  // A spawned run settles the same way a tool call does, with one addition:
  // the agent may still be running it when the turn ends, and the step cannot
  // close on an open card — that case says so in the result text instead of
  // posing as a silent success.
  for (const run of spawned.values()) {
    events.push(toolCallEvent(dialect, run.call, turn, step))
    events.push(toolResultEvent(run.settled ? run.call : { ...run.call, output: stillRunningText(run.call.output) }, turn, step))
  }
  return events
}

/** The honest result for a run with no terminal state: name the state, keep any visible progress. */
export function stillRunningText(output: string): string {
  return output === '' ? STILL_RUNNING : `${STILL_RUNNING} ${output}`
}



/** The user turn's own event, appended before the agent starts work. */
export function projectUserMessage(text: string, turn: number): ProjectionEvent[] {
  const message = userMessageEvent(turn, text)
  return [
    { ...message, payload: withoutNonFinite(message.payload) },
    { type: 'turn/start', payload: { turn } },
  ]
}