#!/usr/bin/env node
/** Detached backend owner: native frame proxy, bounded journal, and prompt ledger. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocket, { type RawData } from 'ws'
import {
  isJsonValue, jsonObject, type JsonValue, type RemoteJournalEvent, type RemoteJournalPage,
} from '@threadharbor/protocol'
import type { HoldRequest, HoldResponse, HoldWorkerConfig, HoldWorkerState } from './hold-protocol.ts'
import { ChunkCoalescer, CHUNK_COALESCE_IDLE_MS } from './chunk-coalescer.ts'

const JOURNAL_COMPACT_APPEND_INTERVAL = 512
const JOURNAL_LOG_APPEND_INTERVAL = 128
const STDIO_RESTART_TIMEOUT_MS = 8_000
const STDIO_REINITIALIZE_TIMEOUT_MS = 10_000

export function parseConfig(path: string): HoldWorkerConfig {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const value = jsonObject(raw, 'hold worker config')
  if (value['version'] !== 1) throw new Error('hold worker config version must be 1')
  const text = (key: string): string => {
    const item = value[key]
    if (typeof item !== 'string' || item === '') throw new Error(`hold worker config ${key} must be a string`)
    return item
  }
  const integer = (key: string): number => {
    const item = value[key]
    if (!Number.isSafeInteger(item) || (item as number) <= 0) throw new Error(`hold worker config ${key} must be positive`)
    return item as number
  }
  const backend = text('backend')
  if (backend !== 'grok' && backend !== 'codex' && backend !== 'claude' && backend !== 'dsh') throw new Error('invalid hold backend')
  const promptTimeoutMs = integer('promptTimeoutMs')
  const transportValue = jsonObject(value['transport'], 'hold worker transport')
  const kind = transportValue['kind']
  const transport: HoldWorkerConfig['transport'] = kind === 'stdio'
    ? {
      kind,
      command: typeof transportValue['command'] === 'string' ? transportValue['command'] : '',
      args: Array.isArray(transportValue['args'])
        ? transportValue['args'].map((arg) => {
          if (typeof arg !== 'string') throw new Error('hold worker transport args must be strings')
          return arg
        })
        : [],
    }
    : kind === 'websocket' && typeof transportValue['url'] === 'string'
      ? {
        kind,
        url: transportValue['url'],
        ...(typeof transportValue['secret'] === 'string' && transportValue['secret'] !== ''
          ? { secret: transportValue['secret'] }
          : {}),
      }
      : (() => { throw new Error('invalid hold worker transport') })()
  if (transport.kind === 'stdio' && transport.command === '') throw new Error('stdio transport command must not be empty')
  return {
    version: 1,
    holdId: text('holdId'),
    generation: text('generation'),
    backend,
    cwd: text('cwd'),
    socketPath: text('socketPath'),
    journalPath: text('journalPath'),
    statePath: text('statePath'),
    maxJournalEvents: integer('maxJournalEvents'),
    maxJournalBytes: integer('maxJournalBytes'),
    promptTimeoutMs,
    ...(typeof value['sessionRoot'] === 'string' && value['sessionRoot'] !== ''
      ? { sessionRoot: value['sessionRoot'] as string }
      : {}),
    transport,
  }
}

function parseJournal(path: string): RemoteJournalEvent[] {
  if (!existsSync(path)) return []
  const events: RemoteJournalEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue
    const value: unknown = JSON.parse(line)
    const record = jsonObject(value, 'journal event')
    if (!Number.isSafeInteger(record['seq']) || typeof record['generation'] !== 'string'
      || typeof record['timestamp'] !== 'string' || !isJsonValue(record['frame'])) {
      throw new Error('invalid hold journal event')
    }
    events.push(record as unknown as RemoteJournalEvent)
  }
  return events
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function journalMetricsEnabled(): boolean {
  return process.env['THREADHARBOR_HOLD_JOURNAL_METRICS'] !== '0' && process.env['NODE_ENV'] !== 'test'
}

/** Trace toggle: default ON in non-test runs so latency investigations always
 *  have data; explicit `THREADHARBOR_TRACE=0` silences. */
function traceEnabled(): boolean {
  return process.env['THREADHARBOR_TRACE'] !== '0' && process.env['NODE_ENV'] !== 'test'
}

/** Emit one structured trace line for an in-process stage. */
function trace(stage: string, fields: Record<string, unknown>): void {
  if (!traceEnabled()) return
  const parts = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  process.stderr.write(`threadharbor-hostd ${stage} ${parts}\n`)
}

/** Opt-in verbatim native frame dump for upstream protocol analysis.
 *
 *  Turned off by default; enable with `THREADHARBOR_FRAME_LOG=1` on the hostd
 *  process (the toggle is inherited by detached hold workers). Intended for
 *  discovering exactly what fields a real Codex/Grok/Claude/DSH stream
 *  carries (token usage, timing, cost, tool metadata) before wiring any of
 *  it into the Web projection — do not run it permanently, and treat every
 *  logged line as sensitive (frames may embed tool input/output or model
 *  content). Default per-line cap keeps runaway tool payloads from flooding
 *  the log; raise it with `THREADHARBOR_FRAME_LOG_MAX` when capturing usage
 *  frames whose fields sit past the truncation point.
 */
function frameLogEnabled(): boolean {
  return process.env['THREADHARBOR_FRAME_LOG'] === '1' || process.env['THREADHARBOR_FRAME_LOG'] === 'true'
}

function frameLogMax(): number {
  const raw = process.env['THREADHARBOR_FRAME_LOG_MAX']
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 32_768
}

/** Truncate a serialized frame line without breaking the JSON tail markers
 *  the analysis tooling greps for. */
function truncateFrameLine(line: string, max: number): string {
  if (line.length <= max) return line
  return `${line.slice(0, Math.max(0, max - 16))}…[truncated ${line.length - max} chars]`
}

/** Live worker runtime. Its process lifetime is intentionally independent from hostd. */
export class HoldWorker {
  private readonly journal: RemoteJournalEvent[]
  private journalBytes: number
  private droppedThrough = 0
  private nextSeq: number
  private initialized = false
  private initializeResult: JsonValue | undefined
  private nativeSessionId: string | undefined
  private backendPid: number | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private upstream: WebSocket | undefined
  private server: Server | undefined
  private closeTask: Promise<void> | undefined
  private readonly admissions = new Set<string>()
  private readonly requests = new Map<string, { method: string; sessionId?: string }>()
  /** Prompts the idle guard already gave up on. Their real response can still
   *  arrive later (a turn that merely took long); it is then journaled as a
   *  normal completion so the gateway can leave `failed`. */
  private readonly timedOutPrompts = new Set<string>()
  /** Backend → client requests (permission prompts, elicitations) still
   *  awaiting our answer. While any is outstanding the agent is waiting on
   *  the user, not stalled, so the prompt idle guard is paused. */
  private readonly pendingBackendRequests = new Set<string>()
  private readonly promptQueue: JsonValue[] = []
  private promptActive = false
  private readonly waiters = new Set<{
    readonly rpcId: string
    readonly afterSeq: number
    readonly socket: Socket
    readonly timer: NodeJS.Timeout
  }>()
  private readonly seqWaiters = new Set<{
    readonly afterSeq: number
    readonly socket: Socket
    readonly timer: NodeJS.Timeout
  }>()
  private readonly pageWaiters = new Set<{
    readonly afterSeq: number
    readonly generation?: string
    readonly socket: Socket
    readonly timer: NodeJS.Timeout
  }>()
  private readonly coalescer = new ChunkCoalescer()
  /** RpcId of the in-flight session/prompt; cleared when its response lands or it times out. */
  private currentPromptRpcId: string | undefined
  /** Wall-clock guard for `currentPromptRpcId`. Fires when the Agent backend stalls. */
  private currentPromptTimer: ReturnType<typeof setTimeout> | undefined
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined
  private appendsSinceCompact = 0
  private stdioEpoch = 0
  private restartingStdio = false
  private stdioGate: Promise<void> = Promise.resolve()
  private lastInitializeFrame: JsonValue | undefined
  private readonly frameLog: boolean
  private readonly frameLogMax: number

  /** @param config - immutable owner-only launch record. */
  constructor(private readonly config: HoldWorkerConfig) {
    this.journal = parseJournal(config.journalPath)
    this.journalBytes = this.journal.reduce((sum, event) => sum + Buffer.byteLength(jsonLine(event)), 0)
    this.droppedThrough = this.previousDroppedThrough()
    this.nextSeq = Math.max(this.journal.at(-1)?.seq ?? 0, this.droppedThrough) + 1
    this.frameLog = frameLogEnabled()
    this.frameLogMax = frameLogMax()
    this.logJournalMetric('recovered', {})
  }

  /** Start the backend, local socket, and state publication. */
  async start(): Promise<void> {
    mkdirSync(dirname(this.config.socketPath), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32' && existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath)
    if (this.config.transport.kind === 'stdio') this.startStdio(this.config.transport.command, this.config.transport.args)
    else await this.startWebSocket(this.config.transport.url)

    const server = createServer((socket) => { this.handleSocket(socket) })
    this.server = server
    server.on('error', (error) => {
      process.stderr.write(`threadharbor-hostd hold socket: ${String(error)}\n`)
      process.exitCode = 1
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.config.socketPath, () => {
          server.off('error', reject)
          if (process.platform !== 'win32') chmodSync(this.config.socketPath, 0o600)
          resolve()
        })
      })
      this.writeState(true)

      process.once('SIGTERM', this.stopFromSignal)
      process.once('SIGINT', this.stopFromSignal)
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /** Close the private listener and backend transport. */
  close(): Promise<void> {
    this.closeTask ??= this.performClose()
    return this.closeTask
  }

  private readonly stopFromSignal = (): void => {
    this.close().catch((error: unknown) => {
      process.stderr.write(`threadharbor-hostd hold close: ${String(error)}\n`)
      process.exitCode = 1
    })
  }

  private async performClose(): Promise<void> {
    this.clearCoalesceTimer()
    this.clearPromptTimeout()
    for (const frame of this.coalescer.flush()) this.append(frame)
    process.off('SIGTERM', this.stopFromSignal)
    process.off('SIGINT', this.stopFromSignal)
    const server = this.server
    this.server = undefined
    const child = this.child
    const childClosed = child !== undefined && child.exitCode === null
      ? new Promise<void>(resolveClose => child.once('close', () => { resolveClose() }))
      : undefined
    child?.kill('SIGTERM')
    this.upstream?.close()
    if (server?.listening === true) {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error === undefined) resolveClose()
          else reject(error)
        })
      })
    }
    await childClosed
    if (process.platform !== 'win32' && existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath)
    this.writeState(false)
  }

  private startStdio(command: string, args: readonly string[]): void {
    const epoch = ++this.stdioEpoch
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (this.config.sessionRoot !== undefined) {
      // DSH writes JSONL under $DSH_SESSION_ROOT/<projectKey(cwd)>/<sessionId>/...
      // Without this env var the bundled cordis.yml falls back to cwd-relative
      // ./.sessions and pollutes the project directory.
      env['DSH_SESSION_ROOT'] = this.config.sessionRoot
    }
    const child = spawn(command, [...args], {
      cwd: this.config.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr.pipe(process.stderr)
    this.backendPid = child.pid
    child.on('error', (error) => {
      if (epoch !== this.stdioEpoch) return
      this.append({
        jsonrpc: '2.0', method: '_dsh/transport_error', params: { message: String(error) },
      })
    })
    child.on('exit', (code, signal) => {
      if (epoch !== this.stdioEpoch || this.restartingStdio) return
      this.recordTransportEnd({
        jsonrpc: '2.0', method: '_dsh/transport_closed', params: {
          code: code ?? null, signal: signal ?? null,
        },
      })
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (epoch !== this.stdioEpoch) return
      this.receiveText(line)
    })
  }

  private async startWebSocket(baseUrl: string): Promise<void> {
    // The config secret is hostd-authoritative: hostd resolves the secret once
    // (file → env → generated) and pins it into every hold config. The parent
    // env is only a fallback for configs written by an older hostd, so a stale
    // GROK_AGENT_SECRET can never override the secret hostd actually owns.
    const configSecret = this.config.transport.kind === 'websocket'
      ? this.config.transport.secret
      : undefined
    const envSecret = process.env['GROK_AGENT_SECRET']
    const secret = configSecret !== undefined && configSecret !== '' ? configSecret : envSecret
    const url = new URL(baseUrl)
    if (secret !== undefined && secret !== '') url.searchParams.set('server-key', secret)
    const socket = new WebSocket(url)
    this.upstream = socket
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.on('message', (data) => { this.receiveText(rawDataText(data)) })
    socket.on('close', (code, reason) => {
      this.recordTransportEnd({
        jsonrpc: '2.0', method: '_dsh/transport_closed', params: { code, reason: reason.toString() },
      })
    })
    socket.on('error', (error) => {
      this.append({
        jsonrpc: '2.0', method: '_dsh/transport_error', params: { message: String(error) },
      })
    })
  }

  /** Emit one verbatim native frame line to stderr for upstream protocol
   *  analysis (opt-in, see `frameLogEnabled`). The frame is dumped as it
   *  crosses the hold boundary, i.e. before ACP/DSH text-chunk coalescing
   *  and before any projection, so nothing the Agent emitted is hidden. */
  private logFrame(direction: 'in' | 'out', frame: JsonValue): void {
    if (!this.frameLog) return
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    const method = record?.['method']
    const id = record?.['id']
    const line = truncateFrameLine(
      `threadharbor-hostd frame-${direction} ${typeof method === 'string' ? `method=${method}` : 'method='}`
        + `${id === undefined ? '' : ` id=${typeof id === 'string' ? id : String(id)}`} frame=${jsonLine(frame).trim()}`,
      this.frameLogMax,
    )
    process.stderr.write(`${line}\n`)
  }

  private receiveText(text: string): void {
    let frame: JsonValue
    try {
      const value: unknown = JSON.parse(text)
      frame = isJsonValue(value) ? value : { raw: text }
    } catch {
      frame = { raw: text }
    }
    this.logFrame('in', frame)
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
      if (request.method === 'initialize' && record['error'] === undefined) {
        this.initialized = true
        this.initializeResult = record['result']
      }
      if ((request.method === 'session/new' || request.method === 'session/fork') && record['error'] === undefined) {
        const result = record['result']
        const resultRecord = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : undefined
        if (typeof resultRecord?.['sessionId'] === 'string') this.nativeSessionId = resultRecord['sessionId']
      }
    }
    const journaled = this.journalFrames(this.coalescer.push(frame))
    const isPromptResponse = (request?.method === 'session/prompt' && isResponse) || lateResponse
    // A prompt response ends the turn whether it carries `result` OR `error`.
    // Synthesize the backend-native completion frame for both so the gateway
    // flips turnState out of `running`. Previously an error response (e.g. a
    // Codex `usageLimitExceeded` wrapped as -32603 Internal error) only cleared
    // promptActive without journaling a completion, stranding the browser on
    // “正在创建远程会话 / running” until the 75s client timeout. This mirrors the
    // prompt-timeout path, which already synthesizes a completion from an error.
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
    if (journaled.length > 0) {
      this.resolveWaiters(journaled[journaled.length - 1]!)
      this.resolveSeqWaiters()
      this.writeState(true)
    } else {
      this.scheduleCoalesceFlush()
    }
  }

  private recordTransportEnd(frame: JsonValue): void {
    this.clearPromptTimeout()
    const journaled = this.journalFrames(frame ? [frame] : [])
    if (journaled.length > 0) {
      this.resolveWaiters(journaled[journaled.length - 1]!)
      this.resolveSeqWaiters()
    }
    this.promptActive = false
    this.writeState(false)
  }

  private journalFrames(frames: readonly JsonValue[]): RemoteJournalEvent[] {
    if (frames.length === 0) return []
    this.clearCoalesceTimer()
    return frames.map(frame => this.append(frame))
  }

  private scheduleCoalesceFlush(): void {
    this.clearCoalesceTimer()
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined
      const journaled = this.journalFrames(this.coalescer.flush())
      if (journaled.length === 0) return
      this.resolveWaiters(journaled[journaled.length - 1]!)
      this.resolveSeqWaiters()
      this.writeState(true)
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
      this.logJournalMetric('compact', { reason, durationMs: performance.now() - started })
    } else {
      const started = performance.now()
      appendFileSync(this.config.journalPath, jsonLine(event), { mode: 0o600 })
      if (this.appendsSinceCompact % JOURNAL_LOG_APPEND_INTERVAL === 0) {
        this.logJournalMetric('append-sample', { durationMs: performance.now() - started })
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

  private logJournalMetric(event: string, fields: Record<string, unknown>): void {
    if (!journalMetricsEnabled()) return
    const payload = {
      event,
      holdId: this.config.holdId,
      backend: this.config.backend,
      generation: this.config.generation,
      pid: process.pid,
      journalEvents: this.journal.length,
      journalBytes: this.journalBytes,
      latestSeq: this.nextSeq - 1,
      droppedThrough: this.droppedThrough,
      appendsSinceCompact: this.appendsSinceCompact,
      ...fields,
    }
    process.stderr.write(`threadharbor-hold-journal ${JSON.stringify(payload)}\n`)
  }

  private isNativeCancel(frame: JsonValue): boolean {
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    return record?.['method'] === 'session/cancel'
  }

  private applyNativeCancel(frame: JsonValue): void {
    if (!this.isNativeCancel(frame)) return
    this.promptQueue.length = 0
    this.promptActive = false
  }

  private enqueueStdio<T>(task: () => Promise<T>): Promise<T> {
    const run = this.stdioGate.then(task, task)
    this.stdioGate = run.then(() => {}, () => {})
    return run
  }

  private waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('stdio backend did not exit after cancel'))
      }, timeoutMs)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async waitUntilInitialized(timeoutMs: number): Promise<void> {
    if (this.initialized) return
    const deadline = Date.now() + timeoutMs
    while (!this.initialized && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (!this.initialized) throw new Error('stdio backend did not re-initialize after cancel')
  }

  /** DSH's SDK JSON-RPC server has no session/cancel; abandoning a turn requires a new process. */
  private async restartStdioBackend(): Promise<void> {
    if (this.config.transport.kind !== 'stdio') return
    this.restartingStdio = true
    this.initialized = false
    try {
      const child = this.child
      this.child = undefined
      if (child !== undefined) {
        child.kill('SIGTERM')
        try {
          await this.waitForClose(child, STDIO_RESTART_TIMEOUT_MS)
        } catch {
          child.kill('SIGKILL')
          await this.waitForClose(child, 1_000).catch(() => undefined)
        }
      }
      this.startStdio(this.config.transport.command, this.config.transport.args)
      if (this.lastInitializeFrame !== undefined) {
        this.sendFrame(this.lastInitializeFrame)
        await this.waitUntilInitialized(STDIO_REINITIALIZE_TIMEOUT_MS)
      }
      this.writeState(true)
    } finally {
      this.restartingStdio = false
    }
  }

  private sendFrame(frame: JsonValue): void {
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    const id = record?.['id']
    const method = record?.['method']
    if (method === 'initialize') this.lastInitializeFrame = frame
    if (record !== undefined && (typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      const params = record['params']
      const paramsRecord = params !== null && typeof params === 'object' && !Array.isArray(params) ? params : undefined
      this.requests.set(String(id), {
        method,
        ...(typeof paramsRecord?.['sessionId'] === 'string' ? { sessionId: paramsRecord['sessionId'] } : {}),
      })
      if (method === 'session/prompt') this.armPromptTimeout(String(id))
    } else if (record !== undefined && (typeof id === 'string' || typeof id === 'number') && method === undefined) {
      // Our answer to a backend request (permission grant etc.): the agent is
      // working again, so the idle guard resumes from now.
      this.pendingBackendRequests.delete(String(id))
      this.touchPromptActivity()
    }
    this.logFrame('out', frame)
    const line = jsonLine(frame)
    if (this.child !== undefined) {
      this.child.stdin.write(line)
      return
    }
    if (this.upstream?.readyState !== WebSocket.OPEN) throw new Error('backend websocket is not open')
    this.upstream.send(JSON.stringify(frame))
  }

  /** Start the wall-clock guard for a single in-flight session/prompt. */
  /** Start the *idle* guard for a single in-flight session/prompt. The clock
   *  measures silence from the backend, not the turn's total length: every
   *  inbound frame restarts it (`touchPromptActivity`) and it is paused while
   *  a permission / elicitation request awaits the user. A 10-minute total
   *  cap used to mark a healthy hour-long Claude turn as failed and then
   *  discard its real completion. */
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

  /** Cancel the wall-clock guard if one is armed. Safe to call when no prompt is in flight. */
  private clearPromptTimeout(): void {
    if (this.currentPromptTimer !== undefined) {
      clearTimeout(this.currentPromptTimer)
      this.currentPromptTimer = undefined
    }
    this.currentPromptRpcId = undefined
  }

  /**
   * Synthesize a timeout completion when the Agent backend stalls. Drops the in-flight
   * request, appends a JSON-RPC error response so journal waiters unblock, appends the
   * backend-native completion frame so the gateway flips turnState back to idle, then
   * drains the prompt queue.
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
    if (journaled.length > 0) {
      this.resolveWaiters(journaled[journaled.length - 1]!)
      this.resolveSeqWaiters()
      this.writeState(true)
    } else {
      this.scheduleCoalesceFlush()
    }
  }

  private admitPrompt(frame: JsonValue): void {
    const record = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : undefined
    if (record?.['method'] !== 'session/prompt') {
      this.sendFrame(frame)
      return
    }
    this.promptQueue.push(frame)
    this.drainPromptQueue()
  }

  private drainPromptQueue(): void {
    if (this.promptActive) return
    const frame = this.promptQueue.shift()
    if (frame === undefined) return
    this.promptActive = true
    try {
      this.sendFrame(frame)
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
    if (this.config.backend === 'grok') return record['method'] === '_x.ai/session/prompt_complete'
    if (this.config.backend !== 'dsh') return false
    if (record['method'] === 'session.status') {
      const params = record['params']
      return params !== null && typeof params === 'object' && !Array.isArray(params)
        && params['status'] === 'idle'
    }
    if (record['method'] !== 'session.event') return false
    const params = record['params']
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return false
    const event = params['event']
    return event !== null && typeof event === 'object' && !Array.isArray(event) && event['type'] === 'turn/end'
  }

  /**
   * Build a backend-native turn-completion frame for a `session/prompt` JSON-RPC response.
   * The JSON-RPC response is the only completion signal that all four backends reliably
   * emit; we synthesize the appropriate native frame so the gateway can flip `turnState`
   * back to `idle` even if the backend never sends its own follow-up notification.
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
    // Carry the backend's own error text so a failed turn shows *why* (e.g.
    // "Authentication required") instead of a bare "远程轮次失败". Some backends
    // stream the reason as an assistant message before erroring (Codex), but
    // others (Claude ACP auth errors) return it only on the JSON-RPC error, so
    // the completion frame is the sole place the browser can learn it.
    const errorRecord = responseRecord['error'] !== null && typeof responseRecord['error'] === 'object'
      && !Array.isArray(responseRecord['error']) ? responseRecord['error'] as Record<string, JsonValue> : undefined
    const errorData = errorRecord?.['data'] !== null && typeof errorRecord?.['data'] === 'object'
      && !Array.isArray(errorRecord?.['data']) ? errorRecord['data'] as Record<string, JsonValue> : undefined
    const failureMessage = typeof errorData?.['message'] === 'string' ? errorData['message']
      : typeof errorRecord?.['message'] === 'string' ? errorRecord['message'] : undefined
    if (this.config.backend === 'dsh') {
      const failed = stopReason === 'error'
      const reason: Record<string, JsonValue> = { kind: failed ? 'error' : 'completed' }
      if (failed) reason['message'] = failureMessage ?? stopReason
      return {
        jsonrpc: '2.0',
        method: 'session.event',
        params: {
          sessionId,
          event: { type: 'turn/end', data: { reason } },
        },
      }
    }
    return {
      jsonrpc: '2.0',
      method: '_x.ai/session/prompt_complete',
      params: { sessionId, stopReason, ...(failureMessage === undefined ? {} : { message: failureMessage }) },
    }
  }

  private previousDroppedThrough(): number {
    if (!existsSync(this.config.statePath)) return 0
    try {
      const value: unknown = JSON.parse(readFileSync(this.config.statePath, 'utf8'))
      const state = jsonObject(value, 'hold worker state')
      const droppedThrough = state['droppedThrough']
      return state['generation'] === this.config.generation && Number.isSafeInteger(droppedThrough)
        && (droppedThrough as number) >= 0
        ? droppedThrough as number
        : 0
    } catch (error) {
      throw new Error(`cannot recover hold worker state: ${String(error)}`)
    }
  }

  private page(afterSeq: number, generation?: string): RemoteJournalPage {
    const latestSeq = this.nextSeq - 1
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

  private handleSocket(socket: Socket): void {
    socket.setEncoding('utf8')
    let input = ''
    socket.on('data', (chunk: string) => {
      input += chunk
      const newline = input.indexOf('\n')
      if (newline === -1) return
      const line = input.slice(0, newline)
      input = ''
      try {
        const request = JSON.parse(line) as HoldRequest
        this.handleRequest(socket, request)
      } catch (error) {
        this.reply(socket, { ok: false, error: String(error) })
      }
    })
  }

  private handleRequest(socket: Socket, request: HoldRequest): void {
    const requestStartedAt = performance.now()
    const traceFields = (extra: Record<string, unknown>): Record<string, unknown> => {
      const base: Record<string, unknown> = {
        op: request.operation,
        elapsedMs: Number((performance.now() - requestStartedAt).toFixed(2)),
        ...extra,
      }
      if (request.operation === 'wait') {
        base['rpcId'] = request.rpcId
        base['afterSeq'] = request.afterSeq
        base['timeoutMs'] = request.timeoutMs
      } else if (request.operation === 'wait-seq') {
        base['afterSeq'] = request.afterSeq
        base['timeoutMs'] = request.timeoutMs
      } else if (request.operation === 'wait-page') {
        base['afterSeq'] = request.afterSeq
        base['timeoutMs'] = request.timeoutMs
        if (request.generation !== undefined) base['generation'] = request.generation
      } else if (request.operation === 'read') {
        base['afterSeq'] = request.afterSeq
        if (request.generation !== undefined) base['generation'] = request.generation
      }
      return base
    }
    const traceOp = (ok: boolean, extra: Record<string, unknown> = {}): void => {
      trace('hold-worker.handle', traceFields({ ok, ...extra }))
    }
    switch (request.operation) {
      case 'ping':
        this.reply(socket, { ok: true, result: { generation: this.config.generation, latestSeq: this.nextSeq - 1 } })
        traceOp(true)
        return
      case 'read': {
        const page = this.page(request.afterSeq, request.generation)
        this.reply(socket, { ok: true, result: page })
        traceOp(true, { events: page.events.length })
        return
      }
      case 'send': {
        void this.enqueueStdio(async () => {
          const key = `${request.admission.clientId}:${request.admission.requestId}`
          if (this.admissions.has(key)) {
            this.reply(socket, { ok: true, result: { accepted: true, duplicate: true } })
            traceOp(true, { duplicate: true })
            return
          }
          this.admissions.add(key)
          this.admitPrompt(request.admission.frame)
          this.reply(socket, { ok: true, result: { accepted: true, duplicate: false } })
          traceOp(true, { duplicate: false })
        }).catch((error: unknown) => {
          this.reply(socket, { ok: false, error: String(error) })
          traceOp(false, { error: String(error) })
        })
        return
      }
      case 'send-frame':
        void this.enqueueStdio(async () => {
          this.applyNativeCancel(request.frame)
          if (this.isNativeCancel(request.frame) && this.config.backend === 'dsh'
            && this.config.transport.kind === 'stdio') {
            await this.restartStdioBackend()
            this.reply(socket, { ok: true, result: { accepted: true } })
            traceOp(true, { restart: true })
            return
          }
          this.sendFrame(request.frame)
          this.reply(socket, { ok: true, result: { accepted: true } })
          traceOp(true)
        }).catch((error: unknown) => {
          this.reply(socket, { ok: false, error: String(error) })
          traceOp(false, { error: String(error) })
        })
        return
      case 'wait-seq': {
        if (this.nextSeq - 1 > request.afterSeq) {
          this.reply(socket, { ok: true, result: { latestSeq: this.nextSeq - 1, timedOut: false } })
          traceOp(true, { timedOut: false })
          return
        }
        const timer = setTimeout(() => {
          for (const waiter of this.seqWaiters) {
            if (waiter.socket !== socket) continue
            this.seqWaiters.delete(waiter)
            this.reply(socket, { ok: true, result: { latestSeq: this.nextSeq - 1, timedOut: true } })
            traceOp(true, { timedOut: true })
            break
          }
        }, request.timeoutMs)
        this.seqWaiters.add({ afterSeq: request.afterSeq, socket, timer })
        socket.once('close', () => {
          for (const waiter of this.seqWaiters) {
            if (waiter.socket !== socket) continue
            clearTimeout(waiter.timer)
            this.seqWaiters.delete(waiter)
          }
        })
        return
      }
      case 'wait-page': {
        if (this.nextSeq - 1 > request.afterSeq) {
          const page = this.page(request.afterSeq, request.generation)
          this.reply(socket, { ok: true, result: page })
          traceOp(true, { events: page.events.length, immediate: true })
          return
        }
        const timer = setTimeout(() => {
          for (const waiter of this.pageWaiters) {
            if (waiter.socket !== socket) continue
            this.pageWaiters.delete(waiter)
            const page = this.page(waiter.afterSeq, waiter.generation)
            this.reply(socket, { ok: true, result: page })
            traceOp(true, { events: page.events.length, timedOut: true })
            break
          }
        }, request.timeoutMs)
        this.pageWaiters.add({
          afterSeq: request.afterSeq,
          ...(request.generation === undefined ? {} : { generation: request.generation }),
          socket,
          timer,
        })
        socket.once('close', () => {
          for (const waiter of this.pageWaiters) {
            if (waiter.socket !== socket) continue
            clearTimeout(waiter.timer)
            this.pageWaiters.delete(waiter)
          }
        })
        return
      }
      case 'wait': {
        const existing = this.findResponse(request.rpcId, request.afterSeq)
        if (existing !== undefined) {
          this.reply(socket, { ok: true, result: existing.frame })
          traceOp(true, { immediate: true })
          return
        }
        const timer = setTimeout(() => {
          for (const waiter of this.waiters) {
            if (waiter.socket !== socket) continue
            this.waiters.delete(waiter)
            this.reply(socket, { ok: false, error: `timed out waiting for RPC ${request.rpcId}` })
            traceOp(false, { timedOut: true })
            break
          }
        }, request.timeoutMs)
        this.waiters.add({ rpcId: request.rpcId, afterSeq: request.afterSeq, socket, timer })
        socket.once('close', () => {
          for (const waiter of this.waiters) {
            if (waiter.socket !== socket) continue
            clearTimeout(waiter.timer)
            this.waiters.delete(waiter)
          }
        })
        return
      }
      case 'set-native-session':
        this.nativeSessionId = request.nativeSessionId
        this.writeState(true)
        this.reply(socket, { ok: true, result: { nativeSessionId: request.nativeSessionId } })
        return
      case 'shutdown':
        this.reply(socket, { ok: true, result: { stopping: true } })
        process.kill(process.pid, 'SIGTERM')
        return
      default:
        request satisfies never
    }
  }

  private findResponse(rpcId: string, afterSeq: number): RemoteJournalEvent | undefined {
    return this.journal.find((event) => {
      if (event.seq <= afterSeq || event.frame === null || typeof event.frame !== 'object' || Array.isArray(event.frame)) return false
      const id = event.frame['id']
      return (typeof id === 'string' || typeof id === 'number') && String(id) === rpcId
        && event.frame['method'] === undefined
    })
  }

  private resolveWaiters(event: RemoteJournalEvent): void {
    if (event.frame === null || typeof event.frame !== 'object' || Array.isArray(event.frame)) return
    const id = event.frame['id']
    if (typeof id !== 'string' && typeof id !== 'number') return
    for (const waiter of this.waiters) {
      if (event.seq <= waiter.afterSeq || String(id) !== waiter.rpcId || event.frame['method'] !== undefined) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      this.reply(waiter.socket, { ok: true, result: event.frame })
      trace('hold-worker.handle', {
        op: 'wait',
        rpcId: waiter.rpcId,
        afterSeq: waiter.afterSeq,
        elapsedMs: 0,
        ok: true,
        resolved: true,
        seq: event.seq,
      })
    }
  }

  private resolveSeqWaiters(): void {
    const latestSeq = this.nextSeq - 1
    for (const waiter of this.seqWaiters) {
      if (latestSeq <= waiter.afterSeq) continue
      clearTimeout(waiter.timer)
      this.seqWaiters.delete(waiter)
      this.reply(waiter.socket, { ok: true, result: { latestSeq, timedOut: false } })
      trace('hold-worker.handle', {
        op: 'wait-seq',
        afterSeq: waiter.afterSeq,
        elapsedMs: 0,
        ok: true,
        resolved: true,
        seq: latestSeq,
      })
    }
    for (const waiter of this.pageWaiters) {
      if (latestSeq <= waiter.afterSeq) continue
      clearTimeout(waiter.timer)
      this.pageWaiters.delete(waiter)
      const page = this.page(waiter.afterSeq, waiter.generation)
      this.reply(waiter.socket, { ok: true, result: page })
      trace('hold-worker.handle', {
        op: 'wait-page',
        ...(waiter.generation === undefined ? {} : { generation: waiter.generation }),
        afterSeq: waiter.afterSeq,
        elapsedMs: 0,
        ok: true,
        resolved: true,
        seq: latestSeq,
        events: page.events.length,
      })
    }
  }

  private reply(socket: Socket, response: HoldResponse): void {
    if (socket.destroyed) return
    socket.end(jsonLine(response))
  }

  private writeState(ready: boolean): void {
    const state: HoldWorkerState = {
      pid: process.pid,
      ...(this.backendPid === undefined ? {} : { backendPid: this.backendPid }),
      ready,
      generation: this.config.generation,
      latestSeq: this.nextSeq - 1,
      droppedThrough: this.droppedThrough,
      initialized: this.initialized,
      ...(this.initializeResult === undefined ? {} : { initializeResult: this.initializeResult }),
      ...(this.nativeSessionId === undefined ? {} : { nativeSessionId: this.nativeSessionId }),
      updatedAt: new Date().toISOString(),
    }
    const temporary = `${this.config.statePath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.config.statePath)
  }
}

/** Run the detached worker from its configuration path.
 * @param configPath - owner-only hold configuration file.
 */
export async function runHoldWorker(configPath: string): Promise<void> {
  await new HoldWorker(parseConfig(configPath)).start()
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = process.argv[2]
  if (configPath === undefined) throw new Error('usage: hold-worker <config.json>')
  await runHoldWorker(configPath)
}
