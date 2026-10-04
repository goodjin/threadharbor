/** Persistent remote-agent host daemon and native-frame control endpoint. */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import {
  REMOTE_AGENT_HOSTD_PATH,
  RemoteHoldId,
  RemoteSessionId,
  isJsonValue,
  jsonObject,
  parseRemoteControlRequest,
  remoteAgentBackend,
  remoteAgentConfigBackend,
  remoteErrorFixMessage,
  stringField,
  type JsonValue,
  type RemoteControlRequest,
  type RemoteControlResponse,
  type RemoteDirectoryEntry,
  type RemoteDirectoryListing,
  type RemoteHostInventory,
  type RemoteJournalPage,
  type RemoteNativeAdmission,
  type RemoteSessionAttachResult,
  type RemoteSessionStartSpec,
  type RemoteAgentBackend,
  type RemoteHostdSessionStartStage,
} from '@threadharbor/protocol'
import { AgentBridge } from './agent-bridge.ts'
import { AgentManager, requireInstallConfirmation } from './agent-manager.ts'
import type {
  AgentSessionConfig, AgentTransport, HostdSessionRequest, HostdSessionResponse,
} from './agent-protocol.ts'
import { optionalSessionContext, CONTEXT_SEED_MAX_CHARS, type SessionContextSeed } from './hostd-util.ts'
import { HostdWsHub } from './ws-hub.ts'
import { runningHostdVersion } from './version.ts'
import {
  findTcpListenerPid,
  grokServeSecretFromCommandLine,
  looksLikeGrokAgentServe,
  persistGrokServeSecret,
  probeGrokServe,
  readFileTail,
  readProcessCommandLine,
  resolveGrokServeSecret,
  stopProcess,
} from './grok-serve.ts'

export {
  HOSTD_ARTIFACT_FILES,
  hostdArtifactVersionFromDirectory,
  hostdVersionFromFiles,
  readHostdPackageVersion,
  runningHostdVersion,
} from './version.ts'

/** Fully resolved hostd deployment configuration. */
export interface HostdOptions {
  readonly host: '127.0.0.1'
  readonly port: number
  readonly dataDir: string
  readonly maxRequestBytes: number
  readonly operationTimeoutMs: number
  readonly workerStartupTimeoutMs: number
  readonly maxJournalEvents: number
  readonly maxJournalBytes: number
  readonly maxDirectoryEntries: number
  readonly authTimeoutMs: number
  readonly installTimeoutMs: number
  /**
   * Maximum wall-clock time the hold-worker waits for the Agent backend to respond
   * to a single `session/prompt`. On expiry the worker synthesizes a timeout
   * completion frame so journal readers unblock and the prompt queue drains
   * instead of hanging until the backend process eventually dies.
   */
  readonly promptTimeoutMs: number
  /**
   * How long a hold may sit with no subscriber and no client activity before
   * hostd releases it. A detached hold is meant to survive disconnects, not to
   * outlive the session forever; `0` disables reaping (tests, embedded use).
   */
  readonly holdIdleTimeoutMs: number
  readonly agentConfigHome: string
  readonly maxAgentConfigBytes: number
  readonly codexCliCommand: string
  readonly codexCommand: string
  readonly codexArgs: readonly string[]
  readonly claudeCommand: string
  readonly claudeAcpCommand: string
  readonly claudeAcpArgs: readonly string[]
  readonly dshCommand: string
  readonly dshArgs: readonly string[]
  readonly grokCommand: string
  readonly grokServeHost: '127.0.0.1'
  readonly grokServePort: number
  readonly grokArgs: readonly string[]
  /**
   * Whether to accept legacy `POST /v1/control` requests in addition to the
   * WebSocket channel. Defaults to `false`: gateway now speaks WS-only and an
   * older hostd should appear unreachable so SSH reconnect kicks in.
   */
  readonly hostdHttpFallback: boolean
  /** Test seam; production is package version plus a digest of this process's files. */
  readonly hostdVersion?: string
}

interface HostdSessionRecord {
  readonly sessionId: string
  readonly holdId: string
  readonly generation: string
  readonly backend: 'grok' | 'codex' | 'claude' | 'dsh'
  readonly cwd: string
  readonly nativeSessionId?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type { HostdSessionRecord }

interface HostdSessionsFile {
  readonly version: 1
  readonly sessions: readonly HostdSessionRecord[]
}

function parseSessionRecord(value: JsonValue): HostdSessionRecord {
  const record = jsonObject(value, 'hostd session record')
  const backend = remoteAgentBackend(record['backend'])
  const nativeSessionId = optionalString(record, 'nativeSessionId')
  return {
    sessionId: stringField(record, 'sessionId'),
    holdId: stringField(record, 'holdId'),
    generation: stringField(record, 'generation'),
    backend,
    cwd: stringField(record, 'cwd'),
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    createdAt: stringField(record, 'createdAt'),
    updatedAt: stringField(record, 'updatedAt'),
  }
}

function safeInteger(value: JsonValue | undefined, key: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${key} must be a non-negative safe integer`)
  return value as number
}

function optionalString(record: Record<string, JsonValue>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  return value
}

function ownerSuffix(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : 'nouid'
}

/** Unix domain socket paths are short; keep the directory well under the platform limit. */
const HOLD_RUNTIME_DIR_MAX = 48

/** How long a released hold waits for its worker to exit before it is signalled. */
const RELEASE_EXIT_TIMEOUT_MS = 5_000

/** Timestamp of the last client-driven request per session, in epoch ms. */
type SessionActivity = Map<string, number>

/** Hold operations that represent real client activity; everything else is
 *  hostd's own polling and must not reset the idle clock. */
const HOLD_ACTIVITY_OPERATIONS: ReadonlySet<HostdSessionRequest['operation']> = new Set([
  'send', 'send-frame', 'set-native-session',
])

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

function holdRuntimeDirectory(): string {
  const uid = ownerSuffix()
  const candidates: string[] = []
  const xdg = process.env['XDG_RUNTIME_DIR']
  if (typeof xdg === 'string' && xdg !== '') candidates.push(join(xdg, 'th'))
  if (uid !== 'nouid') candidates.push(join('/run/user', uid, 'th'))
  candidates.push(join('/tmp', `th-${uid}`))
  let lastError: unknown
  for (const dir of candidates) {
    if (dir.length > HOLD_RUNTIME_DIR_MAX) continue
    try {
      ensureOwnerOnlyDirectory(dir)
      return dir
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('unable to create hold runtime directory')
}

function holdSocketDead(error: unknown): boolean {
  return /ECONNREFUSED|ENOENT|EPIPE|ENOTSOCK|ECONNRESET/i
    .test(error instanceof Error ? error.message : String(error))
}

function ensureOwnerOnlyDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stats = statSync(path)
  if (!stats.isDirectory()) throw new Error(`${path} is not a directory`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && stats.uid !== uid) throw new Error(`${path} is not owned by the current user`)
  if ((stats.mode & 0o077) !== 0) chmodSync(path, 0o700)
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

async function tcpOpen(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveOpen) => {
    const socket = connect({ host, port })
    const settle = (open: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolveOpen(open)
    }
    socket.once('connect', () => { settle(true) })
    socket.once('error', () => { settle(false) })
    socket.setTimeout(500, () => { settle(false) })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

/** Standalone host daemon. Closing its HTTP listener intentionally leaves detached holds alive. */
export class RemoteAgentHostd {
  private readonly sessions = new Map<string, HostdSessionRecord>()
  private readonly hostId: string
  private readonly sessionsPath: string
  private server: Server | undefined
  private listenedPort: number | undefined
  private readonly agentManager: AgentManager
  private readonly wsHub: HostdWsHub
  private readonly holdLocks = new Map<string, Promise<unknown>>()
  private readonly codeVersion: string
  /** hostd-owned Grok serve secret; resolved lazily from file → env → new. */
  private grokServeSecretValue: string | undefined
  /** Listener pid whose Grok reachability was already verified this process. */
  private grokServeVerifiedPid: number | undefined
  /**
   * One shared Agent connection per backend kind.
   *
   * Every session of a backend rides the same connection, so the process count
   * follows the number of Agent *types* in use, not the number of sessions.
   */
  private readonly bridges = new Map<RemoteAgentBackend, AgentBridge>()
  /** Serializes bridge creation per backend; two sessions must not race it. */
  private readonly bridgeLocks = new Map<RemoteAgentBackend, Promise<unknown>>()
  /** Last client-driven request per session, used by the idle reaper. */
  private readonly sessionActivity: SessionActivity = new Map()
  /** Periodic idle-hold reaper; `undefined` when disabled. */
  private idleReaper: ReturnType<typeof setInterval> | undefined
  /** Context text offered by the current attach, consumed only if resume fails. */
  private pendingContextSeed: { sessionId: string; transcript: string; truncated: boolean } | undefined
  /**
   * How each session's live context was obtained, remembered so a later attach
   * of an already-bound session reports the same truth instead of defaulting to
   * "nothing" simply because it skipped the work.
   */
  private readonly contextSources = new Map<string, 'resumed' | 'reconstructed' | 'none'>()

  /** @param options - fully resolved deployment configuration. */
  constructor(readonly options: HostdOptions) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
    const identityPath = join(options.dataDir, 'host-id')
    if (!existsSync(identityPath)) writeFileSync(identityPath, `${randomUUID()}\n`, { mode: 0o600 })
    this.hostId = readFileSync(identityPath, 'utf8').trim()
    this.sessionsPath = join(options.dataDir, 'sessions.json')
    this.codeVersion = options.hostdVersion
      ?? runningHostdVersion(fileURLToPath(new URL('.', import.meta.url)))
    this.agentManager = new AgentManager({
      installTimeoutMs: options.installTimeoutMs,
      authTimeoutMs: options.authTimeoutMs,
      agentConfigHome: options.agentConfigHome,
      maxAgentConfigBytes: options.maxAgentConfigBytes,
      codexCliCommand: options.codexCliCommand,
      codexAcpCommand: options.codexCommand,
      claudeCommand: options.claudeCommand,
      claudeAcpCommand: options.claudeAcpCommand,
      grokCommand: options.grokCommand,
      dshCommand: options.dshCommand,
    })
    this.loadSessions()
    this.wsHub = new HostdWsHub(this, {
      heartbeatMs: 15_000,
      waitTimeoutMs: 15_000,
      maxEventsPerPage: 100,
    })
  }

  /** Actual listen port, including an OS-assigned port when configured with zero. */
  get port(): number {
    if (this.listenedPort === undefined) throw new Error('hostd has not started')
    return this.listenedPort
  }

  /** Start the loopback HTTP control endpoint. */
  async start(): Promise<void> {
    if (this.server !== undefined) return
    this.sweepLegacyHoldWorkers()
    const server = createServer((req, res) => {
      this.handleHttp(req, res).catch((error: unknown) => {
        if (res.headersSent) {
          res.destroy()
          return
        }
        this.respond(res, 400, {
          id: 'invalid', ok: false, error: { code: 'INVALID_REQUEST', message: String(error) },
        })
      })
    })
    this.server = server
    try {
      await new Promise<void>((resolveStart, reject) => {
        server.once('error', reject)
        server.listen(this.options.port, this.options.host, () => {
          server.off('error', reject)
          const address = server.address()
          if (address === null || typeof address === 'string') {
            reject(new Error('hostd did not bind a TCP port'))
            return
          }
          this.listenedPort = address.port
          resolveStart()
        })
      })
      this.wsHub.attach(server)
      this.startIdleReaper()
    } catch (error) {
      this.server = undefined
      this.listenedPort = undefined
      if (server.listening) {
        await new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) })
      }
      throw error
    }
  }

  /** Stop accepting control requests without terminating backend holds. */
  async close(): Promise<void> {
    if (this.idleReaper !== undefined) {
      clearInterval(this.idleReaper)
      this.idleReaper = undefined
    }
    const server = this.server
    this.server = undefined
    // Stop the Agents first. They hold a write handle on their own session
    // store, and dsh refuses to reopen a session another live process owns — so
    // an Agent that outlives hostd locks its sessions out of every future run,
    // not just this one. Closing only the listener would leave them running and
    // the next hostd would be unable to recover a single one of their sessions.
    await this.stopAllBridges()
    if (server === undefined) return
    await this.wsHub.close()
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => {
        if (error === undefined) resolveClose()
        else reject(error)
      })
    })
  }

  /** Stop every backend connection, so no Agent outlives this process. */
  private async stopAllBridges(): Promise<void> {
    const bridges = [...this.bridges.values()]
    this.bridges.clear()
    this.bridgeLocks.clear()
    await Promise.all(bridges.map(async bridge => {
      await bridge.close().catch(() => undefined)
      trace('bridge.stop', { backend: bridge.options.backend, reason: 'shutdown', ok: true })
    }))
  }

  /** Dispatch one already-parsed control request.
   * @param request - validated hostd request.
   * @param onProgress - optional per-stage progress sink used by streaming
   *  requests (currently `session.start`). Invoked as each backend phase is
   *  entered so a WebSocket caller can relay progress before the RPC resolves.
   * @returns the JSON result for the request method.
   */
  async dispatch(
    request: RemoteControlRequest,
    onProgress?: (stage: RemoteHostdSessionStartStage, sessionId: string, message: string) => void,
  ): Promise<JsonValue> {
    const dispatchStartedAt = performance.now()
    const sessionId = typeof request.params['sessionId'] === 'string' ? request.params['sessionId'] : undefined
    const finishDispatch = (ok: boolean, error?: unknown): void => {
      trace('dispatch', {
        method: request.method,
        ...(sessionId === undefined ? {} : { sessionId }),
        elapsedMs: Number((performance.now() - dispatchStartedAt).toFixed(2)),
        ok,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
      })
    }
    try {
      const result = await this.dispatchInner(request, onProgress)
      finishDispatch(true)
      return result
    } catch (error) {
      finishDispatch(false, error)
      throw error
    }
  }

  /** Switch over the validated control request. Wrapped by `dispatch` for tracing. */
  private async dispatchInner(
    request: RemoteControlRequest,
    onProgress?: (stage: RemoteHostdSessionStartStage, sessionId: string, message: string) => void,
  ): Promise<JsonValue> {
    switch (request.method) {
      case 'inventory':
        return await this.inventory() as unknown as JsonValue
      case 'agent.install.plan':
        return await this.agentManager.installPlan(remoteAgentBackend(request.params['backend'])) as unknown as JsonValue
      case 'agent.install':
        requireInstallConfirmation(request.params['confirm'])
        return await this.agentManager.install(
          remoteAgentBackend(request.params['backend']),
          { upgrade: request.params['upgrade'] === true },
        ) as unknown as JsonValue
      case 'agent.config.get':
        return this.agentManager.readConfig(remoteAgentConfigBackend(request.params['backend'])) as unknown as JsonValue
      case 'agent.config.set': {
        const content = request.params['content']
        if (typeof content !== 'string') throw new TypeError('content must be a string')
        return this.agentManager.writeConfig(
          remoteAgentConfigBackend(request.params['backend']),
          content,
          stringField(request.params, 'expectedRevision'),
        ) as unknown as JsonValue
      }
      case 'agent.credential.status':
        return this.agentManager.dshCredentialStatus() as unknown as JsonValue
      case 'agent.credential.set': {
        const apiKey = request.params['apiKey']
        if (typeof apiKey !== 'string') throw new TypeError('apiKey must be a string')
        return this.agentManager.setDshApiKey(apiKey) as unknown as JsonValue
      }
      case 'auth.start':
        return this.agentManager.startAuth(remoteAgentBackend(request.params['backend'])) as unknown as JsonValue
      case 'auth.status':
        return this.agentManager.authStatus(stringField(request.params, 'flowId')) as unknown as JsonValue
      case 'auth.respond':
        this.agentManager.respondAuth(stringField(request.params, 'flowId'), stringField(request.params, 'response'))
        return { accepted: true }
      case 'auth.cancel':
        this.agentManager.cancelAuth(stringField(request.params, 'flowId'))
        return { cancelled: true }
      case 'session.start':
        return await this.startSession(request.params, onProgress) as unknown as JsonValue
      case 'session.adopt':
        return await this.adoptSession(request.params) as unknown as JsonValue
      case 'session.attach':
        return await this.attachSession(request.params) as unknown as JsonValue
      case 'session.restart':
        if (request.params['confirm'] !== true) throw new Error('session.restart requires confirm: true')
        return await this.restartSession(request.params) as unknown as JsonValue
      case 'session.release':
        return await this.releaseSession(request.params) as unknown as JsonValue
      case 'session.prompt':
        return await this.sendAdmission(request.params)
      case 'session.cancel':
      case 'session.permission':
      case 'session.native':
        return await this.sendNativeFrame(request.params)
      case 'events.read':
        return await this.readEvents(request.params) as unknown as JsonValue
      case 'fs.list':
        return this.listDirectory(request.params) as unknown as JsonValue
      case 'grok.serve.inspect':
        return await this.grokServeInspect() as unknown as JsonValue
      case 'grok.serve.adopt':
        return await this.adoptGrokServe() as unknown as JsonValue
      case 'grok.serve.restart':
        return await this.restartGrokServe() as unknown as JsonValue
      default:
        throw new Error(`hostd does not implement method ${request.method}`)
    }
  }

  /** Current discovery/authentication/runtime inventory.
   * @returns independent discovery, authentication, and running facts.
   */
  async inventory(): Promise<RemoteHostInventory> {
    const running = new Set<RemoteAgentBackend>()
    for (const session of this.sessions.values()) {
      try {
        await this.holdRequest(session, { operation: 'ping' })
        running.add(session.backend)
      } catch {
        // A stale recovered record is not running.
      }
    }
    if (await tcpOpen(this.options.grokServeHost, this.options.grokServePort)) running.add('grok')
    return {
      protocolVersion: 1,
      hostdVersion: this.codeVersion,
      hostId: this.hostId,
      healthy: true,
      backends: await this.agentManager.inventory(running),
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://hostd').pathname !== REMOTE_AGENT_HOSTD_PATH) {
      res.writeHead(404)
      res.end()
      return
    }
    if (!this.options.hostdHttpFallback) {
      this.respond(res, 410, {
        id: 'invalid', ok: false,
        error: { code: 'HTTP_FALLBACK_DISABLED', message: 'POST /v1/control is disabled; use /v1/ws' },
      })
      return
    }
    let bytes = 0
    const chunks: Uint8Array[] = []
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      bytes += chunk.length
      if (bytes > this.options.maxRequestBytes) throw new Error('request body exceeds configured limit')
      chunks.push(chunk)
    }
    const request = parseRemoteControlRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
    try {
      const result = await this.dispatch(request)
      this.respond(res, 200, { id: request.id, ok: true, result })
    } catch (error) {
      this.respond(res, 400, {
        id: request.id, ok: false, error: { code: 'HOSTD_ERROR', message: String(error) },
      })
    }
  }

  private respond(res: ServerResponse, status: number, response: RemoteControlResponse): void {
    const body = JSON.stringify(response)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  private async startSession(
    params: Record<string, JsonValue>,
    onProgress?: (stage: RemoteHostdSessionStartStage, sessionId: string, message: string) => void,
  ): Promise<RemoteSessionAttachResult> {
    const parentNativeSessionId = optionalString(params, 'parentNativeSessionId')
    const spec: RemoteSessionStartSpec = {
      sessionId: RemoteSessionId(stringField(params, 'sessionId')),
      backend: remoteAgentBackend(params['backend']),
      cwd: realpathSync(stringField(params, 'cwd')),
      ...(parentNativeSessionId === undefined ? {} : { parentNativeSessionId }),
    }
    const existing = this.sessions.get(spec.sessionId)
    if (existing !== undefined) {
      if (existing.backend !== spec.backend || existing.cwd !== spec.cwd) {
        throw new Error('session.start cannot change an existing session backend or cwd')
      }
      return await this.attachRecord(existing)
    }
    if (spec.backend === 'grok') await this.ensureGrokServer()
    const holdId = RemoteHoldId(randomUUID())
    const generation = randomUUID()
    const now = new Date().toISOString()
    const record: HostdSessionRecord = {
      sessionId: spec.sessionId,
      holdId,
      generation,
      backend: spec.backend,
      cwd: spec.cwd,
      createdAt: now,
      updatedAt: now,
    }
    onProgress?.('spawn-hold', record.sessionId, '正在准备 Agent 连接')
    await this.ensureSession(record)
    trace('session.start', { stage: 'ensureSession', sessionId: record.sessionId, backend: record.backend })
    onProgress?.('initialize-agent', record.sessionId, '正在初始化 Agent 连接')
    // The handshake belongs to the shared connection and completed with it; the
    // stage stays so callers still see the same three steps.
    trace('session.start', { stage: 'initializeAgent', sessionId: record.sessionId })
    onProgress?.('bind-session', record.sessionId, '正在创建原生会话')
    const ready = await this.bindNativeSession(record, {
      ...(spec.parentNativeSessionId === undefined ? {} : { parentNativeSessionId: spec.parentNativeSessionId }),
    })
    trace('session.start', { stage: 'bindNativeSession', sessionId: record.sessionId })
    return await this.snapshotHold(ready.record)
  }

  private async attachSession(params: Record<string, JsonValue>): Promise<RemoteSessionAttachResult> {
    const sessionId = stringField(params, 'sessionId')
    const record = this.sessions.get(sessionId)
    if (record === undefined) throw new Error(`unknown hostd session ${sessionId}`)
    // Conversation text the caller can offer if the Agent turns out not to be
    // able to reopen its own session. The Agent's real memory always wins; this
    // is only the fallback, and it is applied only after resume has failed.
    const seed = optionalSessionContext(params)
    this.pendingContextSeed = seed === undefined ? undefined : { sessionId, ...seed }
    try {
      return await this.attachRecord(record)
    } finally {
      this.pendingContextSeed = undefined
    }
  }

  private async adoptSession(params: Record<string, JsonValue>): Promise<RemoteSessionAttachResult> {
    const parentId = stringField(params, 'parentSessionId')
    const childId = stringField(params, 'childSessionId')
    const nativeSessionId = stringField(params, 'nativeSessionId')
    const parent = this.sessions.get(parentId)
    if (parent === undefined) throw new Error(`unknown parent hostd session ${parentId}`)
    const existing = this.sessions.get(childId)
    if (existing !== undefined) {
      if (existing.backend !== parent.backend || existing.nativeSessionId !== nativeSessionId) {
        throw new Error('session.adopt cannot change an existing child binding')
      }
      return await this.attachRecord(existing)
    }
    const now = new Date().toISOString()
    // The child gets its own slot: a slot is a session's own bookkeeping (journal,
    // sequence space, prompt queue), which is exactly what must not be shared.
    // What it shares with the parent is the backend connection and the native
    // session, and the bridge fans that session's frames out to both.
    const child: HostdSessionRecord = {
      sessionId: childId,
      holdId: RemoteHoldId(randomUUID()),
      generation: randomUUID(),
      backend: parent.backend,
      cwd: parent.cwd,
      nativeSessionId,
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(childId, child)
    this.saveSessions()
    await this.ensureSession(child)
    this.bridgeFor(child).setNativeSession(child.holdId, nativeSessionId)
    return await this.snapshotHold(child)
  }

  private async attachRecord(record: HostdSessionRecord): Promise<RemoteSessionAttachResult> {
    return await this.withHoldLock(record.holdId, async () => {
      // The bridge may not be up at all: a hostd restart loses every in-process
      // connection, and a dead backend loses its own. Both are the same repair —
      // start the shared connection and re-open this session on it.
      const bridge = this.bridges.get(record.backend)
      // A session with no native binding has to be bound, even when its slot is
      // open: that is exactly the state a failed reopen leaves behind, and
      // skipping the bind here would report a blank Agent as a healthy reopen.
      // The slot existing is not enough: a shared connection opens a slot for
      // every session of the backend at once, and only the one being attached
      // gets bound. Skipping the bind for the others left them accepting
      // prompts that the Agent rejects on arrival, with the UI still reporting
      // a live turn.
      // A running turn outranks the binding check: the Agent is demonstrably
      // serving this session, and re-binding it mid-turn can break a turn that
      // is waiting on a permission or a tool result. Binding is for sessions
      // that look alive but were never named to the Agent, which is exactly the
      // state a revive leaves a sibling session in.
      if (bridge === undefined || !bridge.alive || !bridge.has(record.holdId)
        || (!bridge.isBound(record.holdId) && !bridge.isInFlight(record.holdId))) {
        return await this.reviveHold(record)
      }
      return await this.snapshotHold(record)
    })
  }

  private async snapshotHold(
    record: HostdSessionRecord,
    reopened = false,
    contextSource?: RemoteSessionAttachResult['contextSource'],
  ): Promise<RemoteSessionAttachResult> {
    contextSource ??= this.contextSources.get(record.sessionId) ?? 'none'
    const latestSeq = await this.latestSeq(record)
    return {
      holdId: RemoteHoldId(record.holdId),
      generation: record.generation,
      ...(record.nativeSessionId === undefined ? {} : { nativeSessionId: record.nativeSessionId }),
      latestSeq,
      ...(reopened ? { reopened: true } : {}),
      // Reported even when nothing went wrong, so the UI can tell a real resume
      // from a rebuilt context instead of showing both as a healthy reopen.
      contextSource,
    }
  }

  private async reviveHold(record: HostdSessionRecord): Promise<RemoteSessionAttachResult> {
    if (this.bridges.get(record.backend)?.alive === true) {
      // Only this session is missing its slot or its binding; the shared
      // connection is fine.
      this.bridgeFor(record).open(this.sessionConfig(record))
    } else {
      await this.reviveBackendSessions(record.backend)
    }
    const ready = await this.bindNativeSession(record, { loadExisting: true })
    return await this.snapshotHold(ready.record, ready.reopened, ready.contextSource)
  }

  private bridgeFor(record: HostdSessionRecord): AgentBridge {
    return this.requireBridge(record)
  }

  /**
   * User-confirmed restart of one wedged session.
   *
   * This used to kill a per-session process. The connection is now shared, so a
   * restart clears the *session* instead: the slot is torn down and re-opened,
   * which drops the stuck prompt queue, its waiters and its pending chunks while
   * the live agent session — and its context — stay put. That is both narrower
   * and safer than the old behaviour, which killed the agent and then depended on
   * a resume to rebuild what it had.
   */
  private async restartSession(params: Record<string, JsonValue>): Promise<RemoteSessionAttachResult> {
    const record = this.requireSession(params)
    await this.withHoldLock(record.holdId, async () => {
      const bridge = await this.ensureSession(record)
      // Cancel any turn still in flight, so the agent is not left working on a
      // prompt the user has just abandoned.
      if (record.nativeSessionId !== undefined) {
        bridge.sendFrame(record.holdId, {
          jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: record.nativeSessionId },
        })
      }
      bridge.open(this.sessionConfig(record))
      if (record.nativeSessionId !== undefined) {
        bridge.setNativeSession(record.holdId, record.nativeSessionId)
      }
      // Drop the WS hub's cached cursor: the slot's head did not move, but its
      // in-memory state did, and a stale waiter would never see the new slot.
      this.wsHub.forgetSession(RemoteSessionId(record.sessionId))
      trace('session.restart', { sessionId: record.sessionId, holdId: record.holdId, backend: record.backend, ok: true })
    })
    return await this.snapshotHold(record)
  }

  private async releaseSession(params: Record<string, JsonValue>): Promise<JsonValue> {
    const record = this.requireSession(params)
    const result = await this.withHoldLock(record.holdId, async () => await this.releaseHold(record))
    return result as unknown as JsonValue
  }

  /**
   * Permanently release one session: close its slot, forget the record, and
   * delete the hold's runtime directory.
   *
   * A release must not disturb the other sessions on the same Agent, so the
   * shared connection is only stopped when this was its last session. It is
   * idempotent, so a retry after a partial failure still converges.
   */
  private async releaseHold(record: HostdSessionRecord): Promise<Record<string, JsonValue>> {
    const bridge = this.bridges.get(record.backend)
    const backendPid = bridge?.backendPid
    let released = false
    if (bridge !== undefined) {
      released = bridge.detach(record.holdId)
      if (bridge.sessionCount === 0) {
        // Nothing is using this Agent any more, so give the memory back rather
        // than holding ~435 MB for an idle connection.
        await this.stopBridge(record.backend)
      }
    }
    this.sessionActivity.delete(record.sessionId)
    this.wsHub.forgetSession(RemoteSessionId(record.sessionId))
    this.sessions.delete(record.sessionId)
    this.saveSessions()
    if (process.platform !== 'win32') {
      try {
        rmSync(join(this.options.dataDir, 'holds', record.holdId), { recursive: true, force: true })
      } catch {
        // A leftover directory is harmless: the next release retries.
      }
    }
    trace('session.release', {
      sessionId: record.sessionId, holdId: record.holdId, backend: record.backend,
      ...(backendPid === undefined ? {} : { backendPid }),
    })
    return {
      sessionId: record.sessionId,
      holdId: record.holdId,
      backend: record.backend,
      released: true,
      // Whether this session had a live slot; there is no per-session process
      // to report any more, the connection is shared and may outlive this session.
      hadSlot: released,
    }
  }

  /** Resolve once a pid is gone, or after the budget expires; never rejects. */
  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      await wait(100)
    }
  }

  /**
   * Reclaim holds nobody can still be using: no subscriber is streaming from
   * them and no client has sent anything for the idle budget. Runs from
   * `start()` so an abandoned daemon with no gateway attached self-cleans
   * instead of accumulating one agent process per session forever.
   */
  /**
   * Shut down hold-workers left behind by an older hostd.
   *
   * Before the Agent moved in-process, every session had its own detached
   * worker holding a control socket. Those workers survive the daemon that
   * started them, so an upgrade leaves them running forever — one dsh, one
   * codex or one claude per session, at hundreds of megabytes each. They are
   * unreachable through any channel this version has, so the only way to reach
   * them is the one thing they still speak: their own socket.
   */
  private sweepLegacyHoldWorkers(): void {
    if (process.platform === 'win32') return
    let entries: string[]
    try {
      entries = readdirSync(holdRuntimeDirectory())
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.startsWith('h-') || !entry.endsWith('.sock')) continue
      const socketPath = join(holdRuntimeDirectory(), entry)
      try {
        if (!existsSync(socketPath)) continue
      } catch {
        continue
      }
      const socket = createConnection(socketPath)
      // Best effort: a worker that does not answer is already gone, and its
      // socket is unlinked below either way.
      socket.once('connect', () => { socket.write('{"operation":"shutdown"}\n') })
      socket.once('error', () => { socket.destroy() })
      socket.once('end', () => { socket.destroy() })
      socket.setTimeout(500, () => { socket.destroy() })
      try {
        unlinkSync(socketPath)
      } catch {
        // Another hostd on this machine may have just replaced it.
      }
    }
    trace('sweep.legacyHoldWorkers', { swept: entries.length, ok: true })
  }

  private startIdleReaper(): void {
    const idleMs = this.options.holdIdleTimeoutMs
    if (idleMs <= 0 || this.idleReaper !== undefined) return
    const intervalMs = Math.max(30_000, Math.min(Math.floor(idleMs / 4), 10 * 60_000))
    this.idleReaper = setInterval(() => { void this.reapIdleSessions(idleMs) }, intervalMs)
    // A daemon's whole job is to outlive its clients; the reaper must not be
    // the reason this process stays scheduled awake.
    this.idleReaper.unref()
    // Sweep once at startup so a daemon that was down long enough for its
    // recovered records to age out does not first spend a whole interval
    // holding an agent for every session in sessions.json.
    setTimeout(() => { void this.reapIdleSessions(idleMs) }, 1_000).unref()
  }

  /** Test seam: run one idle-reap pass without waiting for the interval. */
  async reapIdleHoldsForTesting(): Promise<void> {
    await this.reapIdleSessions(this.options.holdIdleTimeoutMs)
  }

  private async reapIdleSessions(idleMs: number): Promise<void> {
    const now = Date.now()
    for (const record of [...this.sessions.values()]) {
      if (this.wsHub.sessionHasSubscribers(RemoteSessionId(record.sessionId))) continue
      const last = this.sessionActivity.get(record.sessionId) ?? Date.parse(record.updatedAt)
      const since = Number.isFinite(last) ? last : now
      if (now - since < idleMs) continue
      try {
        await this.withHoldLock(record.holdId, async () => {
          // Re-check inside the lock: an attach may have revived the hold while
          // we were queued, and releasing a session the user just opened would
          // be far worse than leaking one worker.
          const latest = this.sessions.get(record.sessionId)
          if (latest === undefined || this.wsHub.sessionHasSubscribers(RemoteSessionId(latest.sessionId))) return
          const latestSince = this.sessionActivity.get(latest.sessionId) ?? Date.parse(latest.updatedAt)
          if (Number.isFinite(latestSince) && now - latestSince < idleMs) return
          trace('session.reap', {
            sessionId: latest.sessionId, holdId: latest.holdId, backend: latest.backend,
            idleMs: now - latestSince,
          })
          await this.releaseHold(latest)
        })
      } catch (error) {
        process.stderr.write(`threadharbor-hostd idle reap failed: ${String(error)}\n`)
      }
    }
  }

  private async withHoldLock<T>(holdId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.holdLocks.get(holdId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const current = previous.then(() => gate, () => gate)
    this.holdLocks.set(holdId, current)
    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
      if (this.holdLocks.get(holdId) === current) this.holdLocks.delete(holdId)
    }
  }

  private async initializeHold(record: HostdSessionRecord): Promise<void> {
    const before = await this.latestSeq(record)
    const initializeId = `hostd-initialize-${randomUUID()}`
    // Every backend ThreadHarbor drives now speaks ACP: the agent loop and its
    // model route come from the backend's own composition, not from hostd.
    const initialize = {
      jsonrpc: '2.0', id: initializeId, method: 'initialize', params: {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          elicitation: { form: {} },
          plan: {},
        },
      },
    }
    await this.holdRequest(record, { operation: 'send-frame', frame: initialize })
    this.requireRpcSuccess(await this.holdRequest(record, {
      operation: 'wait', rpcId: initializeId, afterSeq: before, timeoutMs: this.options.operationTimeoutMs,
    }), initializeId)
  }

  private async bindNativeSession(
    record: HostdSessionRecord,
    options: { readonly parentNativeSessionId?: string; readonly loadExisting?: boolean } = {},
  ): Promise<{ record: HostdSessionRecord; reopened: boolean; contextSource: RemoteSessionAttachResult['contextSource'] }> {
    let nativeSessionId = record.nativeSessionId ?? record.sessionId
    let reopened = false
    let contextSource: RemoteSessionAttachResult['contextSource'] = 'none'
    if (options.loadExisting === true && record.nativeSessionId !== undefined) {
      // Codex/Claude implement the standard ACP `session/load`; the Harness ACP
      // profile deliberately does not, and offers `session/resume` for the same
      // job.
      const method = record.backend === 'dsh' ? 'session/resume' : 'session/load'
      try {
        nativeSessionId = await this.nativeSessionRpc(record, method, {
          sessionId: record.nativeSessionId, cwd: record.cwd, mcpServers: [],
        })
        contextSource = 'resumed'
      } catch (error) {
        const detail = String(error)
        const held = record.nativeSessionId !== undefined
          && detail.includes('session is already active')
          && detail.includes(record.nativeSessionId)
        if (held) {
          // dsh-acp refuses to activate a session it already holds. That is
          // proof the session is alive, not a dead end: the binding this caller
          // wanted to re-establish is already there. Count the reopen as done
          // instead of dropping the id and telling the user the history is gone.
          nativeSessionId = record.nativeSessionId
          contextSource = 'resumed'
        } else {
          const seed = this.takeContextSeed(record.sessionId)
          // Whatever happens next, this session's old native binding is gone.
          // Recording that now is what stops a later attach from mistaking a
          // half-revived slot for a healthy session.
          const { nativeSessionId: _dropped, ...unbound } = record
          void _dropped
          this.sessions.set(record.sessionId, unbound)
          this.saveSessions()
          if (seed === undefined) {
            // Nothing to fall back on, so say what actually went wrong. Starting a
            // blank session here is the one thing that must not happen: the user
            // would read a reply that ignores everything they said.
            throw new Error(/already owned by an active write handle/.test(detail)
              ? `另一个 ${record.backend} 进程还占着会话 ${record.nativeSessionId}，先把它关掉再重开：${detail}`
              : `agent ${record.backend} could not reopen session ${record.nativeSessionId}: ${detail}；`
                + '它的历史可能已经不在了，请新建会话')
          }
          // The Agent lost its own memory, but the conversation did not: the
          // caller has the transcript. Start a fresh session and hand it over, so
          // the model can at least read what was already discussed. This is a
          // reconstruction and is reported as one, never as a resume.
          nativeSessionId = await this.nativeSessionRpc(record, 'session/new', { cwd: record.cwd, mcpServers: [] })
          reopened = true
          contextSource = 'reconstructed'
          await this.seedContext(record, nativeSessionId, seed)
          trace('session.contextReconstructed', {
            sessionId: record.sessionId, backend: record.backend,
            chars: seed.transcript.length, truncated: seed.truncated, ok: true,
          })
        }
      }
    } else {
      const method = options.parentNativeSessionId === undefined ? 'session/new' : 'session/fork'
      nativeSessionId = await this.nativeSessionRpc(record, method, {
        ...(options.parentNativeSessionId === undefined ? {} : { sessionId: options.parentNativeSessionId }),
        cwd: record.cwd, mcpServers: [],
      })
      // A reopen whose old binding is already gone cannot resume, so this is the
      // second chance to put the conversation back rather than start blank.
      const seed = options.loadExisting === true ? this.takeContextSeed(record.sessionId) : undefined
      if (seed !== undefined) {
        contextSource = 'reconstructed'
        await this.seedContext(record, nativeSessionId, seed)
        trace('session.contextReconstructed', {
          sessionId: record.sessionId, backend: record.backend,
          chars: seed.transcript.length, truncated: seed.truncated, ok: true,
        })
      }
    }
    await this.holdRequest(record, { operation: 'set-native-session', nativeSessionId })
    // The Agent answered a session RPC for this slot, so it now knows it.
    this.bridges.get(record.backend)?.markBound(record.holdId)
    this.contextSources.set(record.sessionId, contextSource)
    const ready: HostdSessionRecord = { ...record, nativeSessionId, updatedAt: new Date().toISOString() }
    this.sessions.set(ready.sessionId, ready)
    this.saveSessions()
    return { record: ready, reopened, contextSource }
  }

  /** Take the context seed offered for this session, if any, and only once. */
  private takeContextSeed(sessionId: string): SessionContextSeed | undefined {
    const pending = this.pendingContextSeed
    if (pending === undefined || pending.sessionId !== sessionId) return undefined
    this.pendingContextSeed = undefined
    return { transcript: pending.transcript, truncated: pending.truncated }
  }

  /**
   * Hand the conversation to a fresh Agent session as its first turn.
   *
   *  This is text, not a replay: no Agent-internal format is written, so nothing
   *  here depends on how a given Agent stores its own messages. The trade is
   *  honest and worth stating — the model *reads* the history rather than
   *  remembering it, and tool calls in the transcript come back as prose, not as
   *  re-runnable results.
   */
  private async seedContext(
    record: HostdSessionRecord,
    nativeSessionId: string,
    seed: SessionContextSeed,
  ): Promise<void> {
    const bridge = this.requireBridge(record)
    bridge.setNativeSession(record.holdId, nativeSessionId)
    const notice = [
      '这是一次重开：你的 Agent 会话记录无法恢复，所以下面是重开之前这段对话的文字记录。',
      '请先读完它再继续，把里面的内容当成之前已经讨论过的事实，而不是新的问题。',
      seed.truncated
        ? `（记录过长，只保留了最近的部分，最早的内容已经不在了。）`
        : '',
      '',
      '--- 以下是之前的对话记录 ---',
      seed.transcript,
    ].filter(line => line !== '').join('\n')
    const rpcId = `hostd-context-${randomUUID()}`
    const before = bridge.latestSeq(record.holdId)
    bridge.sendFrame(record.holdId, {
      jsonrpc: '2.0', id: rpcId, method: 'session/prompt',
      params: { sessionId: nativeSessionId, prompt: [{ type: 'text', text: notice }] },
    })
    // Wait for the seed turn so the next real prompt queues behind it instead of
    // racing it, and so a seed the Agent rejected is visible rather than silent.
    await bridge.waitFor(record.holdId, rpcId, before, this.options.operationTimeoutMs)
  }

  private async nativeSessionRpc(
    record: HostdSessionRecord,
    method: 'session/new' | 'session/fork' | 'session/load' | 'session/resume',
    params: Record<string, JsonValue>,
  ): Promise<string> {
    const rpcId = `hostd-session-${randomUUID()}`
    const before = await this.latestSeq(record)
    await this.holdRequest(record, {
      operation: 'send-frame',
      frame: { jsonrpc: '2.0', id: rpcId, method, params },
    })
    const response = this.requireRpcSuccess(await this.holdRequest(record, {
      operation: 'wait', rpcId, afterSeq: before, timeoutMs: this.options.operationTimeoutMs,
    }), rpcId)
    // ACP `session/load` and `session/resume` answer with configuration state
    // but no `sessionId` (the caller named the session it wanted reopened);
    // `session/new` and `session/fork` always return one. Treating the missing
    // field as a failure made every reopen fall back to `session/new`, silently
    // discarding the model context that the reopen had just restored.
    const result = response['result'] === null || response['result'] === undefined
      ? {}
      : jsonObject(response['result'], 'session create result')
    const returned = result['sessionId']
    if (typeof returned === 'string' && returned !== '') return returned
    if (method === 'session/load' || method === 'session/resume') return stringField(params, 'sessionId')
    return stringField(result, 'sessionId')
  }

  private async sendAdmission(params: Record<string, JsonValue>): Promise<JsonValue> {
    const record = this.requireSession(params)
    // A prompt is the one frame that must never go to an Agent that has not
    // been told the session exists. After a hostd restart the gateway can still
    // believe a session is open, and the prompt is then admitted into a live
    // bridge that has never heard of it — the Agent rejects it on arrival and
    // the user sees a failed turn with no cause. Binding first turns that into
    // the session working.
    await this.ensureBound(record)
    const admissionValue = jsonObject(params['admission'], 'admission')
    const frame = admissionValue['frame']
    if (!isJsonValue(frame)) throw new TypeError('admission.frame must be JSON')
    const admission: RemoteNativeAdmission = {
      clientId: stringField(admissionValue, 'clientId'),
      requestId: stringField(admissionValue, 'requestId'),
      frame,
    }
    const response = await this.holdRequest(record, { operation: 'send', admission })
    if (!response.ok) throw new Error(response.error)
    return response.result as JsonValue
  }

  /**
   * Make sure the live Agent knows this session, reviving it if it does not.
   *
   * Binding is per-process knowledge: the session lives in the Agent's memory
   * and in a file, and a restarted hostd starts with neither. The file is the
   * recoverable half, so resume it rather than reporting a session that is
   * intact on disk as unknown.
   */
  private async ensureBound(record: HostdSessionRecord): Promise<void> {
    if (record.nativeSessionId === undefined) return
    if (this.slotIsBound(record)) return
    await this.withHoldLock(record.holdId, async () => {
      const latest = this.sessions.get(record.sessionId) ?? record
      if (this.slotIsBound(latest)) return
      await this.bindNativeSession(latest, { loadExisting: true })
    })
  }

  /** Whether the live Agent already knows this session. */
  private slotIsBound(record: HostdSessionRecord): boolean {
    const bridge = this.bridges.get(record.backend)
    return bridge !== undefined && bridge.alive && bridge.has(record.holdId) && bridge.isBound(record.holdId)
  }

  private async sendNativeFrame(params: Record<string, JsonValue>): Promise<JsonValue> {
    const record = this.requireSession(params)
    const frame = params['frame']
    if (!isJsonValue(frame)) throw new TypeError('frame must be JSON')
    const response = await this.holdRequest(record, { operation: 'send-frame', frame })
    if (!response.ok) throw new Error(response.error)
    return response.result as JsonValue
  }

  private async readEvents(params: Record<string, JsonValue>): Promise<RemoteJournalPage> {
    const record = this.requireSession(params)
    const generation = optionalString(params, 'generation')
    const afterSeq = safeInteger(params['afterSeq'], 'afterSeq')
    const waitMs = params['waitMs']
    if (typeof waitMs === 'number' && Number.isFinite(waitMs) && waitMs > 0) {
      try {
        const response = await this.holdRequest(record, {
          operation: 'wait-page',
          afterSeq,
          timeoutMs: Math.min(Math.floor(waitMs), 15_000),
          ...(generation === undefined ? {} : { generation }),
        })
        if (!response.ok) throw new Error(response.error)
        return response.result as unknown as RemoteJournalPage
      } catch {
        // Older hold workers do not implement wait-page; fall through to a plain read.
      }
    }
    const response = await this.holdRequest(record, {
      operation: 'read',
      afterSeq,
      ...(generation === undefined ? {} : { generation }),
    })
    if (!response.ok) throw new Error(response.error)
    return response.result as unknown as RemoteJournalPage
  }

  private listDirectory(params: Record<string, JsonValue>): RemoteDirectoryListing {
    // The browser's "添加项目" panel mounts with an empty `path` so the user
    // can pick a starting directory; hostd must default to a sensible root
    // instead of throwing "path must be a non-empty string".
    const requested = optionalString(params, 'path')
    const target = requested?.trim() === '' || requested === undefined
      ? homedir()
      : requested
    const path = realpathSync(target)
    if (!statSync(path).isDirectory()) throw new Error(`not a directory: ${target}`)
    const names = readdirSync(path).sort((a, b) => a.localeCompare(b))
    const entries: RemoteDirectoryEntry[] = []
    for (const name of names.slice(0, this.options.maxDirectoryEntries)) {
      const entryPath = join(path, name)
      const stat = statSync(entryPath, { throwIfNoEntry: false })
      entries.push({
        name,
        path: entryPath,
        kind: stat?.isDirectory() === true ? 'directory' : stat?.isFile() === true ? 'file' : 'other',
      })
    }
    const parent = dirname(path)
    return {
      path,
      ...(parent === path ? {} : { parent }),
      entries,
      truncated: names.length > this.options.maxDirectoryEntries,
    }
  }

  private requireSession(params: Record<string, JsonValue>): HostdSessionRecord {
    const sessionId = stringField(params, 'sessionId')
    const record = this.sessions.get(sessionId)
    if (record === undefined) throw new Error(`unknown hostd session ${sessionId}`)
    return record
  }

  /** Look up a persisted session record by its sessionId; used by the WS hub.
   * @param sessionId - hostd session identifier.
   * @returns the matching record.
   */
  findSessionRecord(sessionId: string): HostdSessionRecord {
    const record = this.sessions.get(sessionId)
    if (record === undefined) throw new Error(`unknown hostd session ${sessionId}`)
    return record
  }

  /** How one backend is reached. Grok is a shared serve; the rest are stdio. */
  private async transportFor(record: HostdSessionRecord): Promise<AgentTransport> {
    if (record.backend === 'grok') {
      return {
        kind: 'websocket',
        url: `ws://${this.options.grokServeHost}:${this.options.grokServePort}/ws`,
        secret: this.grokServeSecret(),
      }
    }
    if (record.backend === 'codex') return { kind: 'stdio', command: this.options.codexCommand, args: this.options.codexArgs }
    if (record.backend === 'claude') {
      return { kind: 'stdio', command: this.options.claudeAcpCommand, args: this.options.claudeAcpArgs }
    }
    // The ACP profile owns models and credentials through the host user's own
    // $DSH_HOME; a key stored here is only an explicit override injected into the
    // process environment, which the DeepSeek adapter's credential ladder reads.
    const dshCommand = await this.agentManager.resolvedDshLaunch()
    // The ACP profile owns models and credentials through the host user's own
    // $DSH_HOME; a key stored here is only an explicit override injected into the
    // process environment, which the DeepSeek adapter's credential ladder reads.
    const dshKey = this.agentManager.dshApiKey()
    return {
      kind: 'stdio',
      command: dshCommand ?? this.options.dshCommand,
      args: this.options.dshArgs,
      ...(dshKey === undefined ? {} : { env: { DEEPSEEK_API_KEY: dshKey } }),
    }
  }

  private sessionConfig(record: HostdSessionRecord): AgentSessionConfig {
    const directory = join(this.options.dataDir, 'holds', record.holdId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return {
      holdId: record.holdId,
      generation: record.generation,
      backend: record.backend,
      cwd: record.cwd,
      journalPath: join(directory, 'journal.jsonl'),
      statePath: join(directory, 'state.json'),
      maxJournalEvents: this.options.maxJournalEvents,
      maxJournalBytes: this.options.maxJournalBytes,
      promptTimeoutMs: this.options.promptTimeoutMs,
    }
  }

  /**
   * Get or start the shared bridge for a session's backend.
   *
   * Two sessions of the same backend must not race the launch, so creation is
   * serialized per backend. The bridge handshakes the Agent itself, once, on
   * start-up — there is no per-session initialize any more.
   */
  private async ensureBridge(record: HostdSessionRecord): Promise<AgentBridge> {
    const existing = this.bridges.get(record.backend)
    if (existing !== undefined) {
      if (existing.alive) return existing
      // The Agent died under us. Drop the corpse so the next start is clean.
      await this.stopBridge(record.backend)
    }
    return await this.withBridgeLock(record.backend, async () => {
      const raced = this.bridges.get(record.backend)
      if (raced !== undefined && raced.alive) return raced
      if (record.backend === 'grok') await this.ensureGrokServer()
      const bridge = new AgentBridge({
        backend: record.backend,
        cwd: record.cwd,
        transport: await this.transportFor(record),
      })
      try {
        await bridge.start()
      } catch (error) {
        await bridge.close().catch(() => undefined)
        throw new Error(`${record.backend} bridge did not start: ${String(error)}`)
      }
      this.bridges.set(record.backend, bridge)
      trace('bridge.start', { backend: record.backend, backendPid: bridge.backendPid, ok: true })
      return bridge
    })
  }

  private withBridgeLock<T>(backend: RemoteAgentBackend, task: () => Promise<T>): Promise<T> {
    const previous = this.bridgeLocks.get(backend) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.bridgeLocks.set(backend, next.catch(() => undefined))
    return next
  }

  /** Make sure this session has a slot on its backend's shared connection. */
  private async ensureSession(record: HostdSessionRecord): Promise<AgentBridge> {
    const bridge = await this.ensureBridge(record)
    if (!bridge.has(record.holdId)) {
      const config = this.sessionConfig(record)
      if (!existsSync(config.journalPath)) writeFileSync(config.journalPath, '', { mode: 0o600 })
      bridge.open(config)
    }
    return bridge
  }

  /** Stop one backend's shared connection, dropping every session on it. */
  private async stopBridge(backend: RemoteAgentBackend): Promise<void> {
    const bridge = this.bridges.get(backend)
    if (bridge === undefined) return
    this.bridges.delete(backend)
    await bridge.close().catch(() => undefined)
    trace('bridge.stop', { backend, sessions: 0, ok: true })
  }

  /**
   * Stop the shared connection for a backend and re-open every session on it.
   *
   * The fault domain is the backend, not the session: a DSH/Codex/Claude process
   * that died takes its sessions' live connection with it, so recovery has to be
   * per backend. Each session's journal is on disk, so re-opening resumes the
   * transcript and rebinds the native session.
   */
  private async reviveBackendSessions(backend: RemoteAgentBackend): Promise<void> {
    await this.stopBridge(backend)
    const records = [...this.sessions.values()].filter(record => record.backend === backend)
    for (const record of records) {
      const bridge = await this.ensureBridge(record)
      const config = this.sessionConfig(record)
      bridge.open(config)
      if (record.nativeSessionId !== undefined) {
        bridge.setNativeSession(record.holdId, record.nativeSessionId)
      }
    }
    trace('bridge.revive', { backend, sessions: records.length, ok: true })
  }

  /**
   * Serve one session request from the in-process bridge.
   *
   * The request shape is unchanged from the old control protocol so the WS hub
   * and every internal caller keep working; only the transport changed, from a
   * unix socket per hold to a direct call into the shared connection. `signal`
   * cancels a long-poll waiter so a closed subscription stops waiting at once.
   */
  async holdRequest(
    record: HostdSessionRecord,
    request: HostdSessionRequest,
    signal?: AbortSignal,
  ): Promise<HostdSessionResponse> {
    const startedAt = performance.now()
    // Only operations a *client* drives count as activity. The journal readers
    // and `ping` are also issued by hostd's own liveness/subscription machinery;
    // counting them would keep an idle session alive forever and defeat the reaper.
    if (HOLD_ACTIVITY_OPERATIONS.has(request.operation)) {
      this.sessionActivity.set(record.sessionId, Date.now())
    }
    const bridge = this.bridges.get(record.backend)
    if (bridge === undefined || !bridge.has(record.holdId)) {
      // The caller is responsible for reviving: a missing bridge is a backend
      // that is not running, not a transport hiccup to retry here.
      throw new Error(`no running ${record.backend} bridge for session ${record.sessionId}`)
    }
    const finish = (ok: boolean, error?: unknown): void => {
      const fields: Record<string, unknown> = {
        op: request.operation,
        holdId: record.holdId,
        elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
        ok,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
      }
      if ('afterSeq' in request) fields['afterSeq'] = request.afterSeq
      if (request.operation === 'wait') fields['rpcId'] = request.rpcId
      trace('holdRequest', fields)
    }
    try {
      const result = await this.dispatchToBridge(bridge, record, request, signal)
      finish(true)
      return { ok: true, result }
    } catch (error) {
      finish(false, error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async dispatchToBridge(
    bridge: AgentBridge,
    record: HostdSessionRecord,
    request: HostdSessionRequest,
    signal: AbortSignal | undefined,
  ): Promise<JsonValue | RemoteJournalPage> {
    switch (request.operation) {
      case 'ping':
        return { generation: record.generation, latestSeq: bridge.latestSeq(record.holdId) } as unknown as JsonValue
      case 'read':
        return bridge.read(record.holdId, request.afterSeq, request.generation)
      case 'send':
        return bridge.send(record.holdId, request.admission) as unknown as JsonValue
      case 'send-frame':
        bridge.sendFrame(record.holdId, request.frame)
        return { accepted: true } as JsonValue
      case 'set-native-session':
        bridge.setNativeSession(record.holdId, request.nativeSessionId)
        return { nativeSessionId: request.nativeSessionId } as JsonValue
      case 'wait': {
        const outcome = await bridge.waitFor(
          record.holdId, request.rpcId, request.afterSeq, request.timeoutMs, signal,
        )
        if (outcome.kind === 'timeout') throw new Error(`timed out waiting for RPC ${request.rpcId}`)
        return outcome.frame
      }
      case 'wait-seq':
        return bridge.waitSeq(record.holdId, request.afterSeq, request.timeoutMs, signal) as unknown as JsonValue
      case 'wait-page':
        return bridge.waitPage(record.holdId, request.afterSeq, request.timeoutMs, request.generation, signal)
      default: {
        const exhaustive: never = request
        throw new Error(`unsupported session request: ${JSON.stringify(exhaustive)}`)
      }
    }
  }

  private async latestSeq(record: HostdSessionRecord): Promise<number> {
    const bridge = this.requireBridge(record)
    return bridge.latestSeq(record.holdId)
  }

  private requireBridge(record: HostdSessionRecord): AgentBridge {
    const bridge = this.bridges.get(record.backend)
    if (bridge === undefined) throw new Error(`no running ${record.backend} bridge for session ${record.sessionId}`)
    return bridge
  }

  private requireRpcSuccess(response: HostdSessionResponse, rpcId: string): Record<string, JsonValue> {
    if (!response.ok) throw new Error(response.error)
    const frame = jsonObject(response.result, `RPC ${rpcId} response`)
    if (frame['error'] !== undefined) throw new Error(`RPC ${rpcId} failed: ${JSON.stringify(frame['error'])}`)
    return frame
  }

  /** hostd-owned Grok serve secret: persisted file → parent env → generated. */
  private grokServeSecret(): string {
    if (this.grokServeSecretValue === undefined) {
      this.grokServeSecretValue = resolveGrokServeSecret(
        this.options.dataDir,
        process.env['GROK_AGENT_SECRET'],
      )
    }
    return this.grokServeSecretValue
  }

  /**
   * Ensure a reachable `grok agent serve` bound to the configured port.
   *
   * Unlike a bare TCP check, this verifies the WebSocket handshake with the
   * hostd-owned secret — but only for listeners that are actually a Grok serve
   * (identified from the owning process command line). Anything else is left
   * untouched: probing an unrelated service would open a stray connection and
   * we have no repair for a foreign listener. A serve started by an earlier
   * hostd generation (whose secret this process lost) is detected here instead
   * of surfacing as a mysterious 15-second "hold did not start" on the next
   * reopen, and the caller can offer adopt/restart as a confirm-to-fix action.
   */
  private async ensureGrokServer(): Promise<void> {
    const host = this.options.grokServeHost
    const port = this.options.grokServePort
    if (!(await tcpOpen(host, port))) {
      await this.startGrokServe()
      return
    }
    const pid = await findTcpListenerPid(port)
    if (pid !== undefined && this.grokServeVerifiedPid === pid) return
    const commandLine = pid === undefined ? undefined : await readProcessCommandLine(pid)
    if (!looksLikeGrokAgentServe(commandLine, port)) return
    if (await probeGrokServe(host, port, this.grokServeSecret())) {
      if (pid !== undefined) this.grokServeVerifiedPid = pid
      return
    }
    // A keyed Grok serve this hostd cannot talk to. Destructive (restart) and
    // non-destructive (adopt) repairs exist, so surface an actionable error.
    throw new Error(remoteErrorFixMessage('grok-serve',
      `${host}:${port} 上已有一个由旧 hostd 启动的 Grok 服务，但当前 hostd 不知道它的密钥，会话无法连接。`
      + '可点「接管现有服务」读取该服务的密钥（不中断其他会话），或点「重启服务」用 hostd 自己的密钥重新启动（会中断该主机正在运行的 Grok 会话）。'))
  }

  /** Spawn a detached `grok agent serve` with the hostd-owned secret. */
  private async startGrokServe(): Promise<void> {
    const host = this.options.grokServeHost
    const port = this.options.grokServePort
    const secret = this.grokServeSecret()
    let child: ChildProcess
    try {
      child = spawn(this.options.grokCommand, [
        ...this.options.grokArgs,
        'agent', 'serve', '--bind', `${host}:${port}`, '--secret', secret,
      ], {
        detached: process.platform !== 'win32',
        env: process.env,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      throw this.grokServeFailure(error)
    }
    let spawnError: unknown
    child.once('error', (error) => { spawnError = error })
    child.unref()
    const deadline = Date.now() + this.options.workerStartupTimeoutMs
    while (Date.now() < deadline) {
      if (spawnError !== undefined) throw this.grokServeFailure(spawnError)
      if (await tcpOpen(host, port)) {
        const pid = await findTcpListenerPid(port)
        if (pid !== undefined) this.grokServeVerifiedPid = pid
        return
      }
      await wait(50)
    }
    throw this.grokServeFailure(new Error('Grok agent server did not become ready'))
  }

  /** Translate a Grok serve launch failure into an actionable hostd error. */
  private grokServeFailure(error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error)
    const mention = /ENOENT|not found|Cannot find module/i.test(detail)
      ? `找不到 Grok 可执行文件（${this.options.grokCommand}）`
      : 'Grok 服务无法启动'
    return new Error(remoteErrorFixMessage('agent-missing',
      `${mention}：${detail}。请到「主机设置」安装 Grok 或确认 grok 命令可用后重试。`))
  }

  /** Read-only Grok serve diagnostics for the Web UI (no secret is returned). */
  private async grokServeInspect(): Promise<Record<string, JsonValue>> {
    const host = this.options.grokServeHost
    const port = this.options.grokServePort
    const listening = await tcpOpen(host, port)
    const pid = listening ? await findTcpListenerPid(port) : undefined
    const commandLine = pid === undefined ? undefined : await readProcessCommandLine(pid)
    const grokAgentServe = looksLikeGrokAgentServe(commandLine, port)
    const secret = this.grokServeSecret()
    // Only probe an attributed Grok serve; probing a foreign listener would
    // open a stray connection for no actionable answer.
    const reachable = grokAgentServe ? await probeGrokServe(host, port, secret) : false
    return {
      host, port, listening,
      ...(pid === undefined ? {} : { pid }),
      grokAgentServe,
      secretAdoptable: grokServeSecretFromCommandLine(commandLine) !== undefined,
      reachable,
      ours: pid !== undefined && pid === this.grokServeVerifiedPid,
    }
  }

  /**
   * Non-destructive repair: adopt the secret of the serve already listening on
   * the Grok port by reading its command line. Only touches hostd state; live
   * sessions on that serve keep running.
   */
  private async adoptGrokServe(): Promise<Record<string, JsonValue>> {
    const host = this.options.grokServeHost
    const port = this.options.grokServePort
    if (!(await tcpOpen(host, port))) {
      throw new Error(`端口 ${port} 上没有正在运行的 Grok 服务，无需接管。`)
    }
    const pid = await findTcpListenerPid(port)
    if (pid === undefined) throw new Error(`无法识别 ${port} 端口上服务的进程。`)
    const commandLine = await readProcessCommandLine(pid)
    if (!looksLikeGrokAgentServe(commandLine, port)) {
      throw new Error(`端口 ${port} 上的进程（pid ${pid}）不是 Grok agent serve，hostd 不会接管它。`)
    }
    const secret = grokServeSecretFromCommandLine(commandLine)
    if (secret === undefined) {
      throw new Error(`端口 ${port} 上的 Grok 服务命令行里没有可读取的 --secret，无法接管。可改用「重启 Grok 服务」。`)
    }
    persistGrokServeSecret(this.options.dataDir, secret)
    this.grokServeSecretValue = secret
    this.grokServeVerifiedPid = pid
    if (!(await probeGrokServe(host, port, secret))) {
      throw new Error('已保存该服务的密钥，但 WebSocket 握手仍然失败。可改用「重启 Grok 服务」。')
    }
    return { adopted: true, host, port, pid }
  }

  /**
   * Destructive repair (user-confirmed in the Web UI): stop the Grok serve on
   * the configured port and start a fresh one with the hostd-owned secret.
   * Refuses to terminate a listener that does not look like `grok agent serve`.
   */
  private async restartGrokServe(): Promise<Record<string, JsonValue>> {
    const host = this.options.grokServeHost
    const port = this.options.grokServePort
    const pid = await findTcpListenerPid(port)
    if (pid !== undefined) {
      const commandLine = await readProcessCommandLine(pid)
      if (!looksLikeGrokAgentServe(commandLine, port)) {
        throw new Error(`无法重启：${port} 被一个非 Grok 的进程占用（pid ${pid}），hostd 不会终止它。请手动释放端口后重试。`)
      }
      await stopProcess(pid)
    }
    await this.startGrokServe()
    return { restarted: true, host, port }
  }

  private loadSessions(): void {
    if (!existsSync(this.sessionsPath)) return
    const file = jsonObject(readJson(this.sessionsPath), 'hostd sessions file')
    if (file['version'] !== 1 || !Array.isArray(file['sessions'])) throw new Error('invalid hostd sessions file')
    for (const value of file['sessions']) {
      const record = parseSessionRecord(value)
      this.sessions.set(record.sessionId, record)
      const updatedAt = Date.parse(record.updatedAt)
      this.sessionActivity.set(record.sessionId, Number.isFinite(updatedAt) ? updatedAt : Date.now())
    }
  }

  private saveSessions(): void {
    const file: HostdSessionsFile = { version: 1, sessions: [...this.sessions.values()] }
    writeJsonAtomic(this.sessionsPath, file)
  }
}
