/** One Agent connection shared by every session of that backend on this machine.
 *
 * Before this existed, hostd spawned one detached worker per remote session and
 * each worker spawned its own Agent backend. A DSH ACP backend is a full harness
 * runtime (~435 MB resident), so N sessions cost N × 435 MB even though the
 * protocol has always supported many sessions on one connection. This class owns
 * one connection and hands it to any number of `AgentSession` slots.
 *
 * It is a plain module inside hostd, not a process: a personal tool is deployed
 * one user per instance, so there is no cross-user turn to protect by surviving
 * a hostd restart, and a detached process buys nothing that a machine reboot
 * would not take away anyway.
 *
 * Routing rules, with no guessing:
 * - a backend response lands in the slot that recorded the request id;
 * - a backend notification or request lands in the slot whose native session id
 *   matches `params.sessionId`;
 * - anything else (a transport-level event) reaches every session, because
 *   every session's transcript has to record that the backend went away.
 *
 * Frames are never rewritten here. Protocol unification is ACP's job, not this
 * class's: the one exception is turn completion, where a backend that does not
 * emit one gets one, so every session ends its turn the same way.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'

import {
  isJsonValue,
  type JsonValue, type RemoteAgentBackend, type RemoteJournalPage,
} from '@threadharbor/protocol'

import type {
  AgentSendResult, AgentSeqResult, AgentSessionConfig, AgentTransport, AgentWaitResult,
} from './agent-protocol.ts'
import { AgentSession } from './agent-session.ts'
import {
  frameLogMax, journalMetricsEnabled, jsonLine, logNativeFrame, rawDataText, trace,
} from './hostd-util.ts'

/** How much Agent stderr to keep for a start-up failure message. */
const STDERR_TAIL_BYTES = 4_096

/** Append the Agent's stderr tail to a start-up error, when it said anything. */
function diagnosticsTail(message: string, tail: string): string {
  return tail.trim() === '' ? message : `${message}；Agent 日志尾部：${tail.trim()}`
}

/** How the bridge is launched. */
export interface AgentBridgeOptions {
  readonly backend: RemoteAgentBackend
  /** Working directory for the backend process. Sessions carry their own cwd in
   *  `session/new`, so this only matters for backend start-up itself. */
  readonly cwd: string
  readonly transport: AgentTransport
}

/** Upper bound on waiting for the backend child to exit during shutdown. */
const BRIDGE_CHILD_EXIT_TIMEOUT_MS = 2_000

/**
 * A waiter timer that also ends on abort, so a closed subscription stops
 * waiting at once instead of holding a timer for the rest of the timeout.
 */
function cancellableTimer(
  session: AgentSession,
  drop: () => void,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onEnd: () => void,
): ReturnType<typeof setTimeout> {
  if (signal?.aborted === true) {
    drop()
    onEnd()
    return setTimeout(() => undefined, 0)
  }
  const timer = setTimeout(() => { drop(); onEnd() }, timeoutMs)
  if (signal === undefined) return timer
  signal.addEventListener('abort', () => {
    clearTimeout(timer)
    drop()
    onEnd()
  }, { once: true })
  return timer
}

function logJournalMetric(backend: string, event: string, fields: Record<string, unknown>): void {
  if (!journalMetricsEnabled()) return
  const parts = Object.entries({ event, backend, ...fields })
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  process.stderr.write(`threadharbor-hold-journal ${parts}\n`)
}

/** One shared Agent connection, with a session slot per remote session. */
export class AgentBridge {
  private readonly sessions = new Map<string, AgentSession>()
  /**
   * native session id -> the holdIds bound to it.
   *
   * A set, not a single id: `session.adopt` binds a second hostd session to an
   * Agent session that is already bound, and both have to receive that
   * session's frames. A one-to-one map would silently starve the second one.
   */
  private readonly byNativeSession = new Map<string, Set<string>>()
  private child: ChildProcessWithoutNullStreams | undefined
  private upstream: WebSocket | undefined
  private closeTask: Promise<void> | undefined
  /** Rpc ids the bridge itself asked the backend (currently just initialize). */
  private readonly bootRequests = new Set<string>()
  /** Set once the transport can no longer carry frames. */
  private dead = false
  /** Rolling stderr tail, so a failed boot is diagnosable after the fact. */
  private stderr = ''
  private initializeResponse: JsonValue | undefined
  private readonly initializeDone: Promise<void>
  private resolveInitialize!: () => void
  /** Cached frame-log line cap, read once at launch like the hold worker did. */
  private readonly frameLogMax = frameLogMax()

  constructor(readonly options: AgentBridgeOptions) {
    this.initializeDone = new Promise<void>((resolve) => { this.resolveInitialize = resolve })
  }

  /** Open the connection and complete the Agent handshake. */
  async start(): Promise<void> {
    try {
      if (this.options.transport.kind === 'stdio') this.startStdio()
      else await this.startWebSocket(this.options.transport.url, this.options.transport.secret)
      // The handshake belongs to the connection, not to a session: the connection
      // exists before any session does, so no slot could carry this frame.
      this.beginInitialize()
      const response = await this.initialize()
      if (response === undefined) {
        throw new Error('the Agent did not complete the ACP handshake')
      }
    } catch (error) {
      // A bad command, a rejected Grok handshake or an Agent that dies on boot
      // all have one line of explanation on its stderr. The worker used to write
      // that to an owner-only log file; in-process there is no log file, so the
      // tail travels with the error instead of vanishing into the parent.
      throw new Error(diagnosticsTail(`${this.options.backend} bridge did not start: ${String(error)}`, this.stderrTail()))
    }
  }

  /** Last stderr the Agent produced, capped so an error message stays readable. */
  private stderrTail(): string {
    if (this.stderr.length === 0) return ''
    return this.stderr.slice(-STDERR_TAIL_BYTES)
  }

  get backendPid(): number | undefined {
    return this.child?.pid
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  get initialized(): boolean {
    return this.initializeResponse !== undefined
  }

  /**
   * Whether this connection can still carry a turn.
   *
   * A dead Agent is the normal way a shared connection goes away, and nothing
   * restarts it by itself — the owner has to notice. Without this, an attach
   * would happily read a session's transcript off a connection whose process
   * died minutes ago and report the session as healthy, and the next prompt
   * would be written into a closed stdin.
   */
  get alive(): boolean {
    return !this.dead
  }

  has(holdId: string): boolean {
    return this.sessions.has(holdId)
  }

  /** Whether the live Agent knows this session, as opposed to the slot merely
   *  existing with a recorded id. */
  isBound(holdId: string): boolean {
    return this.sessions.get(holdId)?.bound === true
  }

  /** Whether a turn is running or queued on this session. */
  isInFlight(holdId: string): boolean {
    return this.sessions.get(holdId)?.inFlight === true
  }

  /** Note that the live Agent now knows this session. */
  markBound(holdId: string): void {
    this.sessions.get(holdId)?.markBound()
  }

  /** Resolve once the backend handshake answers; resolves `undefined` on timeout. */
  initialize(timeoutMs = 30_000): Promise<JsonValue | undefined> {
    return Promise.race([
      this.initializeDone.then(() => this.initializeResponse),
      new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), timeoutMs).unref?.() }),
    ])
  }

  /**
   * Create (or replace) a session slot, recovering its journal from disk.
   *
   * Re-opening an existing `holdId` keeps the journal sequence, which is what
   * makes a restart or a revived session continue rather than start over.
   */
  open(config: AgentSessionConfig): void {
    const existing = this.sessions.get(config.holdId)
    if (existing !== undefined) {
      this.forget(existing)
      existing.close()
    }
    const session = new AgentSession(config, {
      send: frame => this.writeFrame(frame, config.holdId),
      logJournalMetric: (event, fields) => logJournalMetric(this.options.backend, event, fields),
      backendPid: () => this.child?.pid,
    })
    this.sessions.set(config.holdId, session)
    const native = session.currentNativeSessionId
    if (native !== undefined) this.rememberNativeSession(session, native)
  }

  /** Close one session slot without disturbing the shared connection. */
  detach(holdId: string): boolean {
    const session = this.sessions.get(holdId)
    if (session === undefined) return false
    this.forget(session)
    session.close()
    this.sessions.delete(holdId)
    return true
  }

  read(holdId: string, afterSeq: number, generation?: string): RemoteJournalPage {
    return this.require(holdId).page(afterSeq, generation)
  }

  latestSeq(holdId: string): number {
    return this.require(holdId).latestSeq
  }

  nativeSessionId(holdId: string): string | undefined {
    return this.sessions.get(holdId)?.currentNativeSessionId
  }

  setNativeSession(holdId: string, nativeSessionId: string): void {
    const session = this.require(holdId)
    const previous = session.currentNativeSessionId
    if (previous !== undefined && previous !== nativeSessionId) this.unbind(previous, holdId)
    session.setNativeSessionId(nativeSessionId)
    this.bind(nativeSessionId, holdId)
  }

  /** Admit one prompt. A repeated client request id is not sent twice. */
  send(holdId: string, admission: { clientId: string; requestId: string; frame: JsonValue }): AgentSendResult {
    const session = this.require(holdId)
    const key = `${admission.clientId}:${admission.requestId}`
    if (session.hasAdmission(key)) return { accepted: true, duplicate: true }
    session.recordAdmission(key)
    session.admitPrompt(admission.frame)
    return { accepted: true, duplicate: false }
  }

  /** Write one frame for a session, e.g. a permission answer or a cancel. */
  sendFrame(holdId: string, frame: JsonValue): void {
    const session = this.require(holdId)
    session.applyNativeCancel(frame)
    this.writeFrame(frame, holdId)
  }

  waitFor(
    holdId: string, rpcId: string, afterSeq: number, timeoutMs: number, signal?: AbortSignal,
  ): Promise<AgentWaitResult> {
    const session = this.require(holdId)
    const existing = session.findResponse(rpcId, afterSeq)
    if (existing !== undefined) return Promise.resolve({ kind: 'frame', frame: existing.frame })
    return new Promise<AgentWaitResult>((resolve) => {
      const waiter = {
        rpcId,
        afterSeq,
        resolve,
        timer: cancellableTimer(session, () => session.dropWaiter(waiter), timeoutMs, signal, () => {
          resolve({ kind: 'timeout' as const })
        }),
      }
      session.registerWaiter(waiter)
    })
  }

  waitSeq(holdId: string, afterSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<AgentSeqResult> {
    const session = this.require(holdId)
    if (session.latestSeq > afterSeq) return Promise.resolve({ latestSeq: session.latestSeq, timedOut: false })
    return new Promise<AgentSeqResult>((resolve) => {
      const waiter = {
        afterSeq,
        resolve,
        timer: cancellableTimer(session, () => session.dropSeqWaiter(waiter), timeoutMs, signal, () => {
          resolve({ latestSeq: session.latestSeq, timedOut: true })
        }),
      }
      session.registerSeqWaiter(waiter)
    })
  }

  waitPage(
    holdId: string, afterSeq: number, timeoutMs: number, generation?: string, signal?: AbortSignal,
  ): Promise<RemoteJournalPage> {
    const session = this.require(holdId)
    if (session.latestSeq > afterSeq) return Promise.resolve(session.page(afterSeq, generation))
    return new Promise<RemoteJournalPage>((resolve) => {
      const waiter = {
        afterSeq,
        ...(generation === undefined ? {} : { generation }),
        resolve,
        timer: cancellableTimer(session, () => session.dropPageWaiter(waiter), timeoutMs, signal, () => {
          resolve(session.page(afterSeq, generation))
        }),
      }
      session.registerPageWaiter(waiter)
    })
  }

  // --- backend connection -------------------------------------------------

  private startStdio(): void {
    const transport = this.options.transport
    if (transport.kind !== 'stdio') return
    const child = spawn(transport.command, [...transport.args], {
      cwd: this.options.cwd,
      ...(transport.env === undefined ? {} : { env: { ...process.env, ...transport.env } }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.dead = false
    child.stderr.pipe(process.stderr)
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_BYTES)
    })
    child.on('error', (error: Error) => {
      this.recordTransportEnd({
        jsonrpc: '2.0', method: '_dsh/transport_error', params: { message: String(error) },
      })
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.recordTransportEnd({
        jsonrpc: '2.0', method: '_dsh/transport_closed', params: { code, signal },
      })
    })
    createInterface({ input: child.stdout }).on('line', line => this.receiveText(line))
  }

  private async startWebSocket(baseUrl: string, secret: string | undefined): Promise<void> {
    const url = new URL(baseUrl)
    if (secret !== undefined) url.searchParams.set('server-key', secret)
    const socket = new WebSocket(url)
    this.upstream = socket
    socket.on('message', (data) => this.receiveText(rawDataText(data)))
    socket.on('close', (code: number, reason: Buffer) => {
      this.recordTransportEnd({
        jsonrpc: '2.0', method: '_dsh/transport_closed', params: { code, reason: reason.toString('utf8') },
      })
    })
    socket.on('error', (error: Error) => {
      this.recordTransportEnd({
        jsonrpc: '2.0', method: '_dsh/transport_error', params: { message: String(error) },
      })
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  }

  private require(holdId: string): AgentSession {
    const session = this.sessions.get(holdId)
    if (session === undefined) throw new Error(`unknown agent session: ${holdId}`)
    return session
  }

  /** Send the Agent handshake on the shared connection. */
  private beginInitialize(): void {
    const id = `bridge-initialize-${process.pid}`
    this.bootRequests.add(id)
    try {
      this.writeTransport({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 1 } })
    } catch (error) {
      this.bootRequests.delete(id)
      process.stderr.write(`threadharbor-agent-bridge initialize failed to send: ${String(error)}\n`)
      // Unblock waiters so a caller reports a handshake failure instead of hanging.
      this.resolveInitialize()
    }
  }

  private receiveText(text: string): void {
    let frame: JsonValue
    try {
      const value: unknown = JSON.parse(text)
      frame = isJsonValue(value) ? value : { raw: text }
    } catch {
      frame = { raw: text }
    }
    logNativeFrame('in', frame, this.frameLogMax)
    this.route(frame)
  }

  /**
   * Deliver one backend frame to the session it belongs to.
   *
   * This runs on hostd's event loop for every streamed frame and must never
   * throw: a bug in session bookkeeping would otherwise take the daemon — and
   * with it the gateway's connection — down. Anything raised is reported here and
   * swallowed.
   */
  private route(frame: JsonValue): void {
    try {
      this.routeUnsafe(frame)
    } catch (error) {
      trace('bridge.route', { backend: this.options.backend, ok: false, error: String(error) })
      process.stderr.write(`threadharbor-agent-bridge frame routing failed: ${String(error)}\n`)
    }
  }

  private routeUnsafe(frame: JsonValue): void {
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    const id = record?.['id']
    const rpcId = typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
    if (rpcId !== undefined && this.bootRequests.has(rpcId)) {
      // A frame the bridge itself asked for. It belongs to no session, so it is
      // never written into a session journal.
      this.bootRequests.delete(rpcId)
      this.initializeResponse = frame
      this.resolveInitialize()
      return
    }
    if (rpcId !== undefined) {
      for (const session of this.sessions.values()) {
        if (session.requestFor(rpcId) !== undefined) {
          session.receive(frame)
          return
        }
      }
    }
    const params = record?.['params'] !== null && typeof record?.['params'] === 'object'
      && !Array.isArray(record?.['params']) ? record['params'] as Record<string, JsonValue> : undefined
    const sessionId = typeof params?.['sessionId'] === 'string' ? params['sessionId'] : undefined
    if (sessionId !== undefined) {
      const holdIds = this.byNativeSession.get(sessionId)
      if (holdIds !== undefined) {
        let delivered = false
        for (const holdId of holdIds) {
          const session = this.sessions.get(holdId)
          if (session === undefined) continue
          session.receive(frame)
          delivered = true
        }
        if (delivered) return
      }
      // The frame named a session, and it is not one of ours. An Agent runs
      // sessions of its own — a subagent it spawned, a background task — and
      // those are none of this hostd's business. Fanning them out to every
      // session wrote another session's conversation into this one's transcript,
      // where it read as if someone else had been talking. Drop it and say so.
      trace('bridge.frameDropped', {
        backend: this.options.backend, reason: 'unknown-native-session',
        nativeSessionId: sessionId, ok: true,
      })
      process.stderr.write(
        `threadharbor-agent-bridge: dropped a frame for an unmanaged session ${sessionId} `
        + `(the Agent is running a session this hostd does not own)\n`,
      )
      return
    }
    // No session named at all: only a broadcast can get it anywhere.
    for (const session of this.sessions.values()) session.receive(frame)
  }

  private recordTransportEnd(frame: JsonValue): void {
    this.dead = true
    // An Agent that dies during the handshake will never answer it. Settle the
    // wait now instead of making the caller sit out the whole handshake budget
    // for a process that is already gone.
    this.resolveInitialize()
    try {
      for (const session of this.sessions.values()) session.recordTransportEnd(frame)
    } catch (error) {
      process.stderr.write(`threadharbor-agent-bridge transport-end journaling failed: ${String(error)}\n`)
    }
  }

  /** Write one frame to the shared backend, telling its owning session first. */
  private writeFrame(frame: JsonValue, holdId: string | undefined): void {
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    const id = record?.['id']
    const rpcId = typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
    const method = record?.['method']
    const session = holdId === undefined ? undefined : this.sessions.get(holdId)
    if (record !== undefined && rpcId !== undefined) {
      if (typeof method === 'string') {
        const params = record['params'] !== null && typeof record['params'] === 'object'
          && !Array.isArray(record['params']) ? record['params'] as Record<string, JsonValue> : undefined
        const target = typeof params?.['sessionId'] === 'string' ? params['sessionId'] : undefined
        session?.noteOutboundRequest(rpcId, method, target)
        session?.onOutboundRequest(rpcId, method)
        this.rememberNativeSession(session, target)
      } else {
        // Our answer to a permission/elicitation request: the agent is no longer
        // parked on the user, and the idle clock restarts.
        session?.onAnsweredBackendRequest(rpcId)
      }
    }
    this.writeTransport(frame)
  }

  /** Write one frame straight to the shared transport, logging it once. */
  private writeTransport(frame: JsonValue): void {
    logNativeFrame('out', frame, this.frameLogMax)
    const line = jsonLine(frame)
    if (this.child !== undefined) {
      if (this.child.stdin.destroyed) throw new Error('backend transport is not open')
      this.child.stdin.write(line)
      return
    }
    if (this.upstream !== undefined && this.upstream.readyState === WebSocket.OPEN) {
      this.upstream.send(line)
      return
    }
    throw new Error('backend transport is not open')
  }

  private rememberNativeSession(session: AgentSession | undefined, nativeSessionId: string | undefined): void {
    if (session === undefined || nativeSessionId === undefined) return
    const previous = session.currentNativeSessionId
    if (previous !== undefined && previous !== nativeSessionId) this.unbind(previous, session.config.holdId)
    // Re-recording the id this slot already holds must NOT unbind it. Such a
    // frame (a config switch, a cancel) says nothing about whether the Agent
    // still knows the session — only a completed session RPC does. Clearing
    // the flag here made the next prompt try to reopen a session the Agent was
    // demonstrably still holding.
    if (previous !== nativeSessionId) session.setNativeSessionId(nativeSessionId)
    this.bind(nativeSessionId, session.config.holdId)
  }

  private bind(nativeSessionId: string, holdId: string): void {
    const holdIds = this.byNativeSession.get(nativeSessionId) ?? new Set<string>()
    holdIds.add(holdId)
    this.byNativeSession.set(nativeSessionId, holdIds)
  }

  private unbind(nativeSessionId: string, holdId: string): void {
    const holdIds = this.byNativeSession.get(nativeSessionId)
    if (holdIds === undefined) return
    holdIds.delete(holdId)
    if (holdIds.size === 0) this.byNativeSession.delete(nativeSessionId)
  }

  private forget(session: AgentSession): void {
    const native = session.currentNativeSessionId
    if (native !== undefined) this.unbind(native, session.config.holdId)
  }

  // --- shutdown -----------------------------------------------------------

  close(): Promise<void> {
    this.closeTask ??= this.performClose()
    return this.closeTask
  }

  private async performClose(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      this.forget(session)
      session.close()
    }
    this.sessions.clear()
    this.byNativeSession.clear()
    const child = this.child
    // A child that died from a signal keeps `exitCode === null` forever, so the
    // liveness test must look at `signalCode` too, and the wait must be bounded:
    // a bridge that cannot close is one hostd cannot shut down.
    const childAlive = child !== undefined && child.exitCode === null && child.signalCode === null
    const childClosed = childAlive
      ? new Promise<void>((resolve) => {
        const settle = (): void => resolve()
        const timer = setTimeout(settle, BRIDGE_CHILD_EXIT_TIMEOUT_MS)
        child.once('close', () => { clearTimeout(timer); settle() })
      })
      : Promise.resolve()
    // Closing stdin is the tidiest stop: these Agents read it as "shut down" and
    // exit on their own, which is also what happens if hostd is killed outright.
    if (child !== undefined && !child.stdin.destroyed) child.stdin.end()
    if (childAlive) child.kill('SIGTERM')
    this.upstream?.close()
    await childClosed
    trace('bridge.close', { backend: this.options.backend, sessions: 0, ok: true })
  }
}
