/** One session's durable state inside a shared Agent bridge.
 *
 * Everything the bridge needs to keep per session lives here: the bounded
 * journal, its sequence space, the native session id, admission de-duplication,
 * the one-turn-at-a-time prompt queue with its idle guard, the long-poll waiters
 * and the text-chunk coalescer. The bridge process owns the single backend
 * connection; this object owns everything that must not be shared.
 *
 * The split is deliberate. A session slot is the unit of *durability* and
 * *turn bookkeeping*; the bridge is the unit of *process*. Keeping them in
 * separate objects is what makes "one backend, many sessions" a mechanical
 * change rather than a rewrite: this class is the per-session half of what used
 * to be one whole hold worker.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import {
  isJsonValue, jsonObject,
  type JsonValue, type RemoteJournalEvent, type RemoteJournalPage,
} from '@threadharbor/protocol'

import type { AgentSeqResult, AgentSessionConfig, AgentSessionState, AgentWaitResult } from './agent-protocol.ts'
import { CHUNK_COALESCE_IDLE_MS, ChunkCoalescer } from './chunk-coalescer.ts'
import { jsonLine, trace } from './hostd-util.ts'

/** How often the journal file is rewritten in full even without retention trimming. */
const JOURNAL_COMPACT_APPEND_INTERVAL = 512
/** How often an append is timed for the stderr journal metrics. */
const JOURNAL_LOG_APPEND_INTERVAL = 128

/** Everything the slot needs from its owning bridge process.
 *
 * Frame logging is deliberately absent: the bridge logs each frame once as it
 * crosses the shared connection, not once per session it fans out to.
 */
export interface BridgeSessionDeps {
  /** Write one frame to the shared backend connection. */
  readonly send: (frame: JsonValue) => void
  readonly logJournalMetric: (event: string, fields: Record<string, unknown>) => void
  /** Pid of the shared backend child, recorded into every session's state file. */
  readonly backendPid: () => number | undefined
}

/** Live state of one session sharing a bridge backend. */
export class AgentSession {
  private readonly journal: RemoteJournalEvent[]
  private journalBytes: number
  private droppedThrough = 0
  private nextSeq: number
  private nativeSessionId: string | undefined
  /**
   * Whether the live Agent actually knows this session.
   *
   *  Having an id is not the same as being bound: a revived session gets its
   *  slot and its recorded id long before any `session/resume` names it to the
   *  Agent. Treating "has an id" as "is bound" let a half-alive session look
   *  healthy, so prompts were accepted, forwarded, and rejected by an Agent that
   *  had never heard of them.
   */
  private nativeBound = false
  /** Admitted at most once per client request id for this session's lifetime. */
  private readonly admissions = new Set<string>()
  /** Outbound request ids this session is still waiting on, with the method. */
  private readonly requests = new Map<string, { method: string; sessionId?: string }>()
  /** Prompts the idle guard already gave up on; their real response can still
   *  arrive later and is then journaled as a normal completion. */
  private readonly timedOutPrompts = new Set<string>()
  /** Backend requests (permission, elicitation) for *this* session still awaiting
   *  an answer. While any is outstanding the agent waits on the user rather than
   *  stalling, so the idle guard is paused. */
  private readonly pendingBackendRequests = new Set<string>()
  private readonly promptQueue: JsonValue[] = []
  private promptActive = false
  private readonly waiters = new Set<FrameWaiter>()
  private readonly seqWaiters = new Set<SeqWaiter>()
  private readonly pageWaiters = new Set<PageWaiter>()
  /** One coalescer per session: a single shared slot would let interleaved
   *  sessions evict each other's pending chunk. */
  private readonly coalescer = new ChunkCoalescer()
  private currentPromptRpcId: string | undefined
  private currentPromptTimer: ReturnType<typeof setTimeout> | undefined
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined
  private appendsSinceCompact = 0
  private closed = false
  /** Set when this session could not record a frame, so a caller can say so. */
  private failure: string | undefined

  constructor(
    readonly config: AgentSessionConfig,
    private readonly deps: BridgeSessionDeps,
  ) {
    this.journal = parseJournal(config.journalPath)
    this.journalBytes = this.journal.reduce((sum, event) => sum + Buffer.byteLength(jsonLine(event)), 0)
    this.droppedThrough = this.previousDroppedThrough()
    // The highest seq in the file, not the last line's. A journal is not
    // guaranteed to be in seq order: a reopen replays what is on disk, and a
    // frame that arrived after a session was rebound can land below an earlier
    // one. Taking the last line's seq then hands out numbers a reader has
    // already passed, and those frames are invisible forever — a turn that
    // failed after a reopen would never reach the UI.
    const highestSeq = this.journal.reduce((highest, event) => Math.max(highest, event.seq), 0)
    this.nextSeq = Math.max(highestSeq, this.droppedThrough) + 1
    this.deps.logJournalMetric('recovered', { holdId: config.holdId })
  }

  get latestSeq(): number {
    return this.nextSeq - 1
  }

  /** True once this session has been detached; it accepts no further frames. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Why this session stopped being able to record, if it could not. */
  get failureReason(): string | undefined {
    return this.failure
  }

  /**
   * Run one frame-handling step, reporting rather than propagating a failure.
   *
   * Every entry point that touches the journal goes through here: appending
   * happens on hostd's event loop for every streamed frame, and from a timer for
   * the coalescing flush. An escaping error would become an uncaught exception
   * that takes the daemon — and the gateway's connection — down, so a session
   * that cannot record degrades to "not recording" instead.
   */
  private guard(step: string, task: () => void): void {
    try {
      task()
    } catch (error) {
      this.failure = `${step}: ${String(error)}`
      trace('agent-session.guard', { holdId: this.config.holdId, step, error: this.failure })
      process.stderr.write(`threadharbor-agent-session ${step} failed for ${this.config.holdId}: ${this.failure}\n`)
    }
  }

  /** Record an outbound request so its response can be recognised as ours. */
  noteOutboundRequest(rpcId: string, method: string, sessionId: string | undefined): void {
    this.requests.set(rpcId, { method, ...(sessionId === undefined ? {} : { sessionId }) })
  }

  /** The request this slot is still waiting on for `rpcId`, if any. */
  requestFor(rpcId: string): { method: string; sessionId?: string } | undefined {
    return this.requests.get(rpcId)
  }

  /**
   * One inbound frame that the bridge has routed to this session.
   *
   * @param frame - the verbatim JSON-RPC frame from the backend.
   */
  receive(frame: JsonValue): void {
    this.guard('receive', () => this.receiveUnsafe(frame))
  }

  private receiveUnsafe(frame: JsonValue): void {
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    const id = record?.['id']
    const rpcId = typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
    const isResponse = record !== undefined && record['method'] === undefined
      && (Object.hasOwn(record, 'result') || Object.hasOwn(record, 'error'))
    // A request from the backend (permission / elicitation) parks the turn on
    // the user; it must not count as agent silence.
    if (record !== undefined && rpcId !== undefined && typeof record['method'] === 'string') {
      this.pendingBackendRequests.add(rpcId)
    }
    // Any frame from the backend proves the agent is alive: restart the idle clock.
    this.touchPromptActivity()
    const request = rpcId === undefined ? undefined : this.requests.get(rpcId)
    // The response to a prompt the idle guard already concluded: still a real
    // turn completion, so journal it and let the gateway recover from `failed`.
    const lateResponse = request === undefined && rpcId !== undefined && isResponse && this.timedOutPrompts.has(rpcId)
    if (lateResponse && rpcId !== undefined) this.timedOutPrompts.delete(rpcId)
    if (request !== undefined && isResponse) {
      if (rpcId !== undefined) {
        this.requests.delete(rpcId)
        if (request.method === 'session/prompt') this.clearPromptTimeout()
      }
      if ((request.method === 'session/new' || request.method === 'session/fork') && record['error'] === undefined) {
        const result = record['result']
        const resultRecord = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : undefined
        if (typeof resultRecord?.['sessionId'] === 'string') this.nativeSessionId = resultRecord['sessionId']
      }
    }
    const journaled = this.journalFrames(this.coalescer.push(frame))
    const isPromptResponse = (request?.method === 'session/prompt' && isResponse) || lateResponse
    // A prompt response ends the turn whether it carries `result` OR `error`, so
    // the synthesized completion must be produced for both.
    const synthesizedCompletion = isPromptResponse && record !== undefined
      ? this.synthesizePromptCompletion(request ?? { method: 'session/prompt' }, record)
      : undefined
    if (synthesizedCompletion !== undefined) {
      this.journalFrames([synthesizedCompletion])
      // A late response belongs to a prompt the queue already moved past; the
      // currently admitted prompt (if any) keeps its slot.
      if (!lateResponse) {
        this.promptActive = false
        this.drainPromptQueue()
      }
    } else if (!isPromptResponse && this.completesPrompt(record)) {
      this.promptActive = false
      this.drainPromptQueue()
    }
    if (journaled.length > 0) this.publish()
    else this.scheduleCoalesceFlush()
  }

  /** Journal a transport-level frame (backend died, transport error). */
  recordTransportEnd(frame: JsonValue): void {
    this.guard('recordTransportEnd', () => this.recordTransportEndUnsafe(frame))
  }

  private recordTransportEndUnsafe(frame: JsonValue): void {
    this.clearPromptTimeout()
    const journaled = this.journalFrames(frame ? [frame] : [])
    if (journaled.length > 0) this.resolveWaiters()
    this.promptActive = false
    this.writeState(false)
  }

  /** Bypass the coalescer: used for frames that must land exactly as sent. */
  appendDirect(frame: JsonValue): void {
    this.journalFrames([frame])
    this.publish()
  }

  page(afterSeq: number, generation?: string): RemoteJournalPage {
    const latestSeq = this.latestSeq
    const generationChanged = generation !== undefined && generation !== this.config.generation
    if (afterSeq > latestSeq && !generationChanged) {
      return {
        generation: this.config.generation,
        latestSeq,
        droppedThrough: this.droppedThrough,
        gap: false,
        events: [],
      }
    }
    const effectiveAfter = afterSeq
    const gap = generationChanged || effectiveAfter < this.droppedThrough
    return {
      generation: this.config.generation,
      latestSeq,
      droppedThrough: this.droppedThrough,
      gap,
      events: this.journal.filter(event => event.seq > (gap ? this.droppedThrough : effectiveAfter)),
    }
  }

  findResponse(rpcId: string, afterSeq: number): RemoteJournalEvent | undefined {
    return this.journal.find((event) => {
      if (event.seq <= afterSeq || event.frame === null || typeof event.frame !== 'object' || Array.isArray(event.frame)) return false
      const id = event.frame['id']
      return (typeof id === 'string' || typeof id === 'number') && String(id) === rpcId
        && event.frame['method'] === undefined
    })
  }

  /** Admit a prompt (or any other frame) from hostd for this session. */
  admitPrompt(frame: JsonValue): void {
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    if (record?.['method'] !== 'session/prompt') {
      this.deps.send(frame)
      return
    }
    this.promptQueue.push(frame)
    this.drainPromptQueue()
  }

  /** A `session/cancel` clears this session's queued prompts only. */
  applyNativeCancel(frame: JsonValue): void {
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    if (record?.['method'] !== 'session/cancel') return
    this.promptQueue.length = 0
    this.promptActive = false
  }

  /** Called by the bridge after it wrote one of our requests to the backend. */
  onOutboundRequest(rpcId: string, method: string): void {
    if (method === 'session/prompt') this.armPromptTimeout(rpcId)
  }

  /** Called by the bridge after it wrote our answer to a backend request. */
  onOutboundResponse(): void {
    this.touchPromptActivity()
  }

  /**
   * The bridge forwarded our answer to a permission/elicitation request, so the
   * agent is working again and the idle clock restarts.
   *
   * @param rpcId - the backend request id we just answered.
   */
  onAnsweredBackendRequest(rpcId: string): void {
    this.pendingBackendRequests.delete(rpcId)
    this.touchPromptActivity()
  }

  /** True when this client request id was already admitted for this session. */
  hasAdmission(key: string): boolean {
    return this.admissions.has(key)
  }

  recordAdmission(key: string): void {
    this.admissions.add(key)
  }

  setNativeSessionId(nativeSessionId: string): void {
    this.nativeSessionId = nativeSessionId
    // Recording an id does not bind it: only a completed session RPC does.
    this.nativeBound = false
    this.writeState(true)
  }

  /** True when the live Agent has been told this session exists. */
  get bound(): boolean {
    return this.nativeBound
  }

  /** True while a turn is running or queued on this session. */
  get inFlight(): boolean {
    return this.promptActive || this.currentPromptRpcId !== undefined
      || this.promptQueue.length > 0
  }

  /** Record that a session RPC completed against the live Agent. The caller
   *  knows this; the slot cannot infer it, because the reply to a session RPC
   *  is broadcast to every session rather than routed to the one that asked. */
  markBound(): void {
    this.nativeBound = true
  }

  get currentNativeSessionId(): string | undefined {
    return this.nativeSessionId
  }

  /**
   * Flush and stop: release timers, drain waiters, persist final state.
   *
   * A detached session must not take the shared backend down with it.
   */
  close(): void {
    if (this.closed) return
    this.guard('close', () => this.closeUnsafe())
  }

  private closeUnsafe(): void {
    if (this.closed) return
    this.closed = true
    this.clearCoalesceTimer()
    this.clearPromptTimeout()
    for (const frame of this.coalescer.flush()) this.append(frame)
    for (const waiter of this.waiters) clearTimeout(waiter.timer)
    this.waiters.clear()
    for (const waiter of this.seqWaiters) clearTimeout(waiter.timer)
    this.seqWaiters.clear()
    for (const waiter of this.pageWaiters) clearTimeout(waiter.timer)
    this.pageWaiters.clear()
    this.guard('writeState', () => this.writeState(false))
  }

  writeState(ready: boolean): void {
    const backendPid = this.deps.backendPid()
    const state: AgentSessionState = {
      pid: process.pid,
      ...(backendPid === undefined ? {} : { backendPid }),
      ready,
      generation: this.config.generation,
      latestSeq: this.latestSeq,
      droppedThrough: this.droppedThrough,
      initialized: true,
      ...(this.nativeSessionId === undefined ? {} : { nativeSessionId: this.nativeSessionId }),
      updatedAt: new Date().toISOString(),
    }
    const temporary = `${this.config.statePath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.config.statePath)
  }

  // --- journal ------------------------------------------------------------

  private journalFrames(frames: readonly JsonValue[]): RemoteJournalEvent[] {
    if (frames.length === 0) return []
    this.clearCoalesceTimer()
    return frames.map(frame => this.append(frame))
  }

  private scheduleCoalesceFlush(): void {
    this.clearCoalesceTimer()
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined
      this.guard('coalesceFlush', () => {
        const journaled = this.journalFrames(this.coalescer.flush())
        if (journaled.length > 0) this.publish()
      })
    }, CHUNK_COALESCE_IDLE_MS)
  }

  private clearCoalesceTimer(): void {
    if (this.coalesceTimer === undefined) return
    clearTimeout(this.coalesceTimer)
    this.coalesceTimer = undefined
  }

  private append(frame: JsonValue): RemoteJournalEvent {
    const event: RemoteJournalEvent = {
      seq: this.nextSeq++,
      generation: this.config.generation,
      timestamp: new Date().toISOString(),
      frame,
    }
    this.journal.push(event)
    this.journalBytes += Buffer.byteLength(jsonLine(event))
    const trimmed = this.trimJournal()
    if (trimmed || ++this.appendsSinceCompact >= JOURNAL_COMPACT_APPEND_INTERVAL) {
      const reason = trimmed ? 'retention' : 'interval'
      const started = performance.now()
      this.compactJournal()
      this.deps.logJournalMetric('compact', { holdId: this.config.holdId, reason, durationMs: performance.now() - started })
    } else {
      const started = performance.now()
      appendFileSync(this.config.journalPath, jsonLine(event), { mode: 0o600 })
      if (this.appendsSinceCompact % JOURNAL_LOG_APPEND_INTERVAL === 0) {
        this.deps.logJournalMetric('append-sample', { holdId: this.config.holdId, durationMs: performance.now() - started })
      }
    }
    return event
  }

  private trimJournal(): boolean {
    let trimmed = false
    while (this.journal.length > this.config.maxJournalEvents
      || (this.journalBytes > this.config.maxJournalBytes && this.journal.length > 1)) {
      const removed = this.journal.shift()
      if (removed === undefined) break
      this.journalBytes -= Buffer.byteLength(jsonLine(removed))
      this.droppedThrough = removed.seq
      trimmed = true
    }
    return trimmed
  }

  private compactJournal(): void {
    const temporary = `${this.config.journalPath}.${process.pid}.tmp`
    writeFileSync(temporary, this.journal.map(jsonLine).join(''), { mode: 0o600 })
    renameSync(temporary, this.config.journalPath)
    this.appendsSinceCompact = 0
  }

  private previousDroppedThrough(): number {
    if (!existsSync(this.config.statePath)) return 0
    try {
      const value: unknown = JSON.parse(readFileSync(this.config.statePath, 'utf8'))
      const state = jsonObject(value, 'bridge session state')
      const droppedThrough = state['droppedThrough']
      return state['generation'] === this.config.generation && Number.isSafeInteger(droppedThrough)
        && (droppedThrough as number) >= 0
        ? droppedThrough as number
        : 0
    } catch (error) {
      throw new Error(`cannot recover bridge session state: ${String(error)}`)
    }
  }

  // --- waiters ------------------------------------------------------------

  /** Wake every waiter that the newest journal event or seq satisfies. */
  publish(): void {
    this.resolveWaiters()
    this.resolveSeqWaiters()
    this.guard('writeState', () => this.writeState(true))
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters) {
      const event = this.findResponse(waiter.rpcId, waiter.afterSeq)
      if (event === undefined) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve({ kind: 'frame', frame: event.frame })
    }
  }

  private resolveSeqWaiters(): void {
    const latestSeq = this.latestSeq
    for (const waiter of this.seqWaiters) {
      if (latestSeq <= waiter.afterSeq) continue
      clearTimeout(waiter.timer)
      this.seqWaiters.delete(waiter)
      waiter.resolve({ latestSeq, timedOut: false })
    }
    for (const waiter of this.pageWaiters) {
      if (latestSeq <= waiter.afterSeq) continue
      clearTimeout(waiter.timer)
      this.pageWaiters.delete(waiter)
      waiter.resolve(this.page(waiter.afterSeq, waiter.generation))
    }
  }

  registerWaiter(waiter: FrameWaiter): void {
    this.waiters.add(waiter)
  }

  registerSeqWaiter(waiter: SeqWaiter): void {
    this.seqWaiters.add(waiter)
  }

  registerPageWaiter(waiter: PageWaiter): void {
    this.pageWaiters.add(waiter)
  }

  dropWaiter(waiter: FrameWaiter): void {
    this.waiters.delete(waiter)
  }

  dropSeqWaiter(waiter: SeqWaiter): void {
    this.seqWaiters.delete(waiter)
  }

  dropPageWaiter(waiter: PageWaiter): void {
    this.pageWaiters.delete(waiter)
  }

  // --- prompt queue and idle guard ---------------------------------------

  private armPromptTimeout(rpcId: string): void {
    this.clearPromptTimeout()
    this.pendingBackendRequests.clear()
    this.currentPromptRpcId = rpcId
    this.schedulePromptTimer()
  }

  private schedulePromptTimer(): void {
    if (this.currentPromptTimer !== undefined) {
      clearTimeout(this.currentPromptTimer)
      this.currentPromptTimer = undefined
    }
    const rpcId = this.currentPromptRpcId
    if (rpcId === undefined || this.pendingBackendRequests.size > 0) return
    this.currentPromptTimer = setTimeout(() => {
      this.currentPromptTimer = undefined
      this.timeoutPrompt(rpcId)
    }, this.config.promptTimeoutMs)
  }

  private touchPromptActivity(): void {
    if (this.currentPromptRpcId !== undefined) this.schedulePromptTimer()
  }

  private clearPromptTimeout(): void {
    if (this.currentPromptTimer !== undefined) {
      clearTimeout(this.currentPromptTimer)
      this.currentPromptTimer = undefined
    }
    this.currentPromptRpcId = undefined
  }

  /**
   * Synthesize a timeout completion when the Agent backend stalls: drop the
   * in-flight request, append a JSON-RPC error so journal waiters unblock,
   * append the backend-native completion frame so the gateway flips turnState
   * back to idle, then drain this session's prompt queue.
   */
  private timeoutPrompt(rpcId: string): void {
    if (this.currentPromptRpcId !== rpcId) return
    const request = this.requests.get(rpcId)
    this.currentPromptRpcId = undefined
    this.requests.delete(rpcId)
    this.timedOutPrompts.add(rpcId)
    const reason = `prompt timed out after ${this.config.promptTimeoutMs}ms of agent silence`
    const errorResponse: JsonValue = {
      jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: reason },
    }
    const completionFrame = this.synthesizePromptCompletion(
      request ?? { method: 'session/prompt' },
      { error: { code: -32000, message: reason } },
    )
    const frames: JsonValue[] = [errorResponse]
    if (completionFrame !== undefined) frames.push(completionFrame)
    const journaled = this.journalFrames(frames)
    this.promptActive = false
    this.drainPromptQueue()
    if (journaled.length > 0) this.publish()
    else this.scheduleCoalesceFlush()
  }

  private drainPromptQueue(): void {
    if (this.promptActive) return
    const frame = this.promptQueue.shift()
    if (frame === undefined) return
    this.promptActive = true
    try {
      this.deps.send(frame)
    } catch (error) {
      this.promptActive = false
      this.append({
        jsonrpc: '2.0', method: '_dsh/transport_error', params: { message: String(error) },
      })
      this.drainPromptQueue()
    }
  }

  private completesPrompt(record: Record<string, JsonValue> | undefined): boolean {
    if (record === undefined) return false
    // Grok's agent server has no prompt response; every other backend answers
    // `session/prompt` itself, so the response path already ends the turn.
    return this.config.backend === 'grok' && record['method'] === '_x.ai/session/prompt_complete'
  }

  /**
   * Build a backend-native turn-completion frame for a `session/prompt` response,
   * carrying the backend's own error text so a failed turn shows *why*.
   */
  private synthesizePromptCompletion(
    request: { method: string; sessionId?: string },
    responseRecord: Record<string, JsonValue>,
  ): JsonValue | undefined {
    const result = responseRecord['result']
    const resultRecord = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : undefined
    const explicitStopReason = typeof resultRecord?.['stopReason'] === 'string'
      ? resultRecord['stopReason'] : undefined
    const stopReason = explicitStopReason ?? (responseRecord['error'] === undefined ? 'end_turn' : 'error')
    const sessionId = request.sessionId ?? this.nativeSessionId ?? ''
    const errorRecord = responseRecord['error'] !== null && typeof responseRecord['error'] === 'object'
      && !Array.isArray(responseRecord['error']) ? responseRecord['error'] as Record<string, JsonValue> : undefined
    const errorData = errorRecord?.['data'] !== null && typeof errorRecord?.['data'] === 'object'
      && !Array.isArray(errorRecord?.['data']) ? errorRecord['data'] as Record<string, JsonValue> : undefined
    const failureMessage = typeof errorData?.['message'] === 'string' ? errorData['message']
      : typeof errorRecord?.['message'] === 'string' ? errorRecord['message'] : undefined
    return {
      jsonrpc: '2.0',
      method: '_x.ai/session/prompt_complete',
      params: { sessionId, stopReason, ...(failureMessage === undefined ? {} : { message: failureMessage }) },
    }
  }
}

/** One caller waiting for a specific backend response. */
export interface FrameWaiter {
  readonly rpcId: string
  readonly afterSeq: number
  readonly resolve: (result: AgentWaitResult) => void
  readonly timer: NodeJS.Timeout
}

/** One caller waiting for a session's journal to advance. */
export interface SeqWaiter {
  readonly afterSeq: number
  readonly resolve: (result: AgentSeqResult) => void
  readonly timer: NodeJS.Timeout
}

/** One caller waiting for a session's next journal page. */
export interface PageWaiter {
  readonly afterSeq: number
  readonly generation?: string
  readonly resolve: (page: RemoteJournalPage) => void
  readonly timer: NodeJS.Timeout
}

function parseJournal(path: string): RemoteJournalEvent[] {
  if (!existsSync(path)) return []
  const events: RemoteJournalEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const value: unknown = JSON.parse(line)
    if (!isJsonValue(value)) throw new Error('invalid bridge journal event')
    const record = jsonObject(value, 'bridge journal event')
    const seq = record['seq']
    if (!Number.isSafeInteger(seq) || typeof record['generation'] !== 'string'
      || typeof record['timestamp'] !== 'string' || !isJsonValue(record['frame'])) {
      throw new Error('invalid bridge journal event')
    }
    events.push({
      seq: seq as number,
      generation: record['generation'],
      timestamp: record['timestamp'],
      frame: record['frame'] as JsonValue,
    })
  }
  return events
}
