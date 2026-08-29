/** Persistent remote-agent host daemon and native-frame control endpoint. */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import {
  REMOTE_AGENT_HOSTD_PATH,
  RemoteHoldId,
  RemoteSessionId,
  isJsonValue,
  jsonObject,
  parseRemoteControlRequest,
  remoteAgentBackend,
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
} from '@threadharbor/protocol'
import { AgentManager, requireInstallConfirmation } from './agent-manager.ts'
import type { HoldRequest, HoldResponse, HoldWorkerConfig } from './hold-protocol.ts'

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
  readonly installPrefix: string
  readonly installTimeoutMs: number
  readonly authTimeoutMs: number
  readonly codexCliCommand: string
  readonly codexCommand: string
  readonly codexArgs: readonly string[]
  readonly codexPackage: string
  readonly codexAcpPackage: string
  readonly claudeCommand: string
  readonly claudePackage: string
  readonly dshCommand: string
  readonly dshArgs: readonly string[]
  readonly dshProvider: string
  readonly dshModel: string
  readonly grokCommand: string
  readonly grokServeHost: '127.0.0.1'
  readonly grokServePort: number
  readonly grokArgs: readonly string[]
  readonly grokInstall?: readonly [command: string, ...args: string[]]
  /** Built worker entry; injectable for packaged runtimes and tests. */
  readonly workerScript: string
}

interface HostdSessionRecord {
  readonly sessionId: string
  readonly holdId: string
  readonly generation: string
  readonly backend: 'grok' | 'codex' | 'dsh'
  readonly cwd: string
  readonly nativeSessionId?: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface HostdSessionsFile {
  readonly version: 1
  readonly sessions: readonly HostdSessionRecord[]
}

function parseSessionRecord(value: JsonValue): HostdSessionRecord {
  const record = jsonObject(value, 'hostd session record')
  const backend = remoteAgentBackend(record['backend'])
  if (backend === 'claude') throw new Error('Claude Code session records require a configured native adapter')
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

  /** @param options - fully resolved deployment configuration. */
  constructor(readonly options: HostdOptions) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
    const identityPath = join(options.dataDir, 'host-id')
    if (!existsSync(identityPath)) writeFileSync(identityPath, `${randomUUID()}\n`, { mode: 0o600 })
    this.hostId = readFileSync(identityPath, 'utf8').trim()
    this.sessionsPath = join(options.dataDir, 'sessions.json')
    this.agentManager = new AgentManager({
      installPrefix: options.installPrefix,
      installTimeoutMs: options.installTimeoutMs,
      authTimeoutMs: options.authTimeoutMs,
      codexCliCommand: options.codexCliCommand,
      codexAcpCommand: options.codexCommand,
      codexPackage: options.codexPackage,
      codexAcpPackage: options.codexAcpPackage,
      claudeCommand: options.claudeCommand,
      claudePackage: options.claudePackage,
      grokCommand: options.grokCommand,
      ...(options.grokInstall === undefined ? {} : { grokInstall: options.grokInstall }),
      dshCommand: options.dshCommand,
    })
    this.loadSessions()
  }

  /** Actual listen port, including an OS-assigned port when configured with zero. */
  get port(): number {
    if (this.listenedPort === undefined) throw new Error('hostd has not started')
    return this.listenedPort
  }

  /** Start the loopback HTTP control endpoint. */
  async start(): Promise<void> {
    if (this.server !== undefined) return
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
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => {
        if (error === undefined) resolveClose()
        else reject(error)
      })
    })
  }

  /** Dispatch one already-parsed control request.
   * @param request - validated hostd request.
   * @returns the JSON result for the request method.
   */
  async dispatch(request: RemoteControlRequest): Promise<JsonValue> {
    switch (request.method) {
      case 'inventory':
        return await this.inventory() as unknown as JsonValue
      case 'agent.install.plan':
        return this.agentManager.installPlan(remoteAgentBackend(request.params['backend'])) as unknown as JsonValue
      case 'agent.install':
        requireInstallConfirmation(request.params['confirm'])
        return await this.agentManager.install(remoteAgentBackend(request.params['backend'])) as unknown as JsonValue
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
        return await this.startSession(request.params) as unknown as JsonValue
      case 'session.adopt':
        return await this.adoptSession(request.params) as unknown as JsonValue
      case 'session.attach':
        return await this.attachSession(request.params) as unknown as JsonValue
      case 'session.prompt':
        return await this.sendAdmission(request.params)
      case 'session.cancel':
      case 'session.permission':
        return await this.sendNativeFrame(request.params)
      case 'events.read':
        return await this.readEvents(request.params) as unknown as JsonValue
      case 'fs.list':
        return this.listDirectory(request.params) as unknown as JsonValue
      default:
        throw new Error(`hostd does not implement method ${request.method}`)
    }
  }

  /** Current installation/authentication/runtime inventory.
   * @returns independent installation, authentication, and running facts.
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
      hostdVersion: '0.1.0',
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

  private async startSession(params: Record<string, JsonValue>): Promise<RemoteSessionAttachResult> {
    const parentNativeSessionId = optionalString(params, 'parentNativeSessionId')
    const spec: RemoteSessionStartSpec = {
      sessionId: RemoteSessionId(stringField(params, 'sessionId')),
      backend: remoteAgentBackend(params['backend']),
      cwd: realpathSync(stringField(params, 'cwd')),
      ...(parentNativeSessionId === undefined ? {} : { parentNativeSessionId }),
    }
    if (spec.backend === 'claude') throw new Error('Claude Code session transport is not configured; install and login are available')
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
    await this.spawnHold(record)
    const before = await this.latestSeq(record)
    const initializeId = `hostd-initialize-${randomUUID()}`
    const initialize = spec.backend === 'dsh'
      ? {
        jsonrpc: '2.0', id: initializeId, method: 'initialize', params: {
          cwd: spec.cwd, provider: this.options.dshProvider, model: this.options.dshModel,
        },
      }
      : {
        jsonrpc: '2.0', id: initializeId, method: 'initialize', params: {
          protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
        },
      }
    await this.holdRequest(record, { operation: 'send-frame', frame: initialize })
    this.requireRpcSuccess(await this.holdRequest(record, {
      operation: 'wait', rpcId: initializeId, afterSeq: before, timeoutMs: this.options.operationTimeoutMs,
    }), initializeId)

    let nativeSessionId = spec.sessionId as string
    if (spec.backend !== 'dsh') {
      const createId = `hostd-session-${randomUUID()}`
      const method = spec.parentNativeSessionId === undefined ? 'session/new' : 'session/fork'
      const createFrame = {
        jsonrpc: '2.0', id: createId, method, params: {
          ...(spec.parentNativeSessionId === undefined ? {} : { sessionId: spec.parentNativeSessionId }),
          cwd: spec.cwd, mcpServers: [],
        },
      }
      const createBefore = await this.latestSeq(record)
      await this.holdRequest(record, { operation: 'send-frame', frame: createFrame })
      const response = this.requireRpcSuccess(await this.holdRequest(record, {
        operation: 'wait', rpcId: createId, afterSeq: createBefore, timeoutMs: this.options.operationTimeoutMs,
      }), createId)
      const result = jsonObject(response['result'], 'session create result')
      nativeSessionId = stringField(result, 'sessionId')
    }
    await this.holdRequest(record, { operation: 'set-native-session', nativeSessionId })
    const ready: HostdSessionRecord = { ...record, nativeSessionId, updatedAt: new Date().toISOString() }
    this.sessions.set(spec.sessionId, ready)
    this.saveSessions()
    return await this.attachRecord(ready)
  }

  private async attachSession(params: Record<string, JsonValue>): Promise<RemoteSessionAttachResult> {
    const sessionId = stringField(params, 'sessionId')
    const record = this.sessions.get(sessionId)
    if (record === undefined) throw new Error(`unknown hostd session ${sessionId}`)
    return await this.attachRecord(record)
  }

  private async adoptSession(params: Record<string, JsonValue>): Promise<RemoteSessionAttachResult> {
    const parentId = stringField(params, 'parentSessionId')
    const childId = stringField(params, 'childSessionId')
    const nativeSessionId = stringField(params, 'nativeSessionId')
    const parent = this.sessions.get(parentId)
    if (parent === undefined) throw new Error(`unknown parent hostd session ${parentId}`)
    const existing = this.sessions.get(childId)
    if (existing !== undefined) {
      if (existing.holdId !== parent.holdId || existing.generation !== parent.generation
        || existing.nativeSessionId !== nativeSessionId) {
        throw new Error('session.adopt cannot change an existing child binding')
      }
      return await this.attachRecord(existing)
    }
    const now = new Date().toISOString()
    const child: HostdSessionRecord = {
      sessionId: childId,
      holdId: parent.holdId,
      generation: parent.generation,
      backend: parent.backend,
      cwd: parent.cwd,
      nativeSessionId,
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(childId, child)
    this.saveSessions()
    return await this.attachRecord(child)
  }

  private async attachRecord(record: HostdSessionRecord): Promise<RemoteSessionAttachResult> {
    const latestSeq = await this.latestSeq(record)
    return {
      holdId: RemoteHoldId(record.holdId),
      generation: record.generation,
      ...(record.nativeSessionId === undefined ? {} : { nativeSessionId: record.nativeSessionId }),
      latestSeq,
    }
  }

  private async sendAdmission(params: Record<string, JsonValue>): Promise<JsonValue> {
    const record = this.requireSession(params)
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
    const response = await this.holdRequest(record, {
      operation: 'read',
      afterSeq: safeInteger(params['afterSeq'], 'afterSeq'),
      ...(generation === undefined ? {} : { generation }),
    })
    if (!response.ok) throw new Error(response.error)
    return response.result as unknown as RemoteJournalPage
  }

  private listDirectory(params: Record<string, JsonValue>): RemoteDirectoryListing {
    const requested = stringField(params, 'path')
    const path = realpathSync(requested)
    if (!statSync(path).isDirectory()) throw new Error(`not a directory: ${requested}`)
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

  private async spawnHold(record: HostdSessionRecord): Promise<void> {
    const directory = join(this.options.dataDir, 'holds', record.holdId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\threadharbor-hostd-${record.holdId}`
      : join(directory, 'control.sock')
    const configPath = join(directory, 'config.json')
    const config: HoldWorkerConfig = {
      version: 1,
      holdId: record.holdId,
      generation: record.generation,
      backend: record.backend,
      cwd: record.cwd,
      socketPath,
      journalPath: join(directory, 'journal.jsonl'),
      statePath: join(directory, 'state.json'),
      maxJournalEvents: this.options.maxJournalEvents,
      maxJournalBytes: this.options.maxJournalBytes,
      transport: record.backend === 'grok'
        ? { kind: 'websocket', url: `ws://${this.options.grokServeHost}:${this.options.grokServePort}/ws` }
        : record.backend === 'codex'
          ? { kind: 'stdio', command: this.options.codexCommand, args: this.options.codexArgs }
          : { kind: 'stdio', command: this.options.dshCommand, args: this.options.dshArgs },
    }
    writeJsonAtomic(configPath, config)
    const child = spawn(process.execPath, [this.options.workerScript, configPath], {
      cwd: record.cwd,
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    const deadline = Date.now() + this.options.workerStartupTimeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await this.holdRequest(record, { operation: 'ping' }, socketPath)
        return
      } catch (error) {
        lastError = error
        await wait(50)
      }
    }
    throw new Error(`hold ${record.holdId} did not start: ${String(lastError)}`)
  }

  private holdSocket(record: HostdSessionRecord): string {
    return process.platform === 'win32'
      ? `\\\\.\\pipe\\threadharbor-hostd-${record.holdId}`
      : join(this.options.dataDir, 'holds', record.holdId, 'control.sock')
  }

  private async holdRequest(record: HostdSessionRecord, request: HoldRequest, socketPath = this.holdSocket(record)): Promise<HoldResponse> {
    return await new Promise<HoldResponse>((resolveResponse, reject) => {
      const socket = createConnection(socketPath)
      let settled = false
      let text = ''
      const finishError = (error: unknown): void => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const timer = setTimeout(() => {
        finishError(new Error(`hold ${record.holdId} request timed out`))
      }, request.operation === 'wait' ? request.timeoutMs + 500 : this.options.operationTimeoutMs)
      socket.setEncoding('utf8')
      socket.once('connect', () => { socket.write(`${JSON.stringify(request)}\n`) })
      socket.on('data', (chunk: string) => { text += chunk })
      socket.once('error', finishError)
      socket.once('end', () => {
        if (settled) return
        clearTimeout(timer)
        settled = true
        try {
          resolveResponse(JSON.parse(text) as HoldResponse)
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }

  private async latestSeq(record: HostdSessionRecord): Promise<number> {
    const response = await this.holdRequest(record, { operation: 'ping' })
    if (!response.ok) throw new Error(response.error)
    const result = jsonObject(response.result, 'hold ping')
    return safeInteger(result['latestSeq'], 'latestSeq')
  }

  private requireRpcSuccess(response: HoldResponse, rpcId: string): Record<string, JsonValue> {
    if (!response.ok) throw new Error(response.error)
    const frame = jsonObject(response.result, `RPC ${rpcId} response`)
    if (frame['error'] !== undefined) throw new Error(`RPC ${rpcId} failed: ${JSON.stringify(frame['error'])}`)
    return frame
  }

  private async ensureGrokServer(): Promise<void> {
    if (await tcpOpen(this.options.grokServeHost, this.options.grokServePort)) return
    const secret = process.env['GROK_AGENT_SECRET']
    if (secret === undefined || secret === '') throw new Error('GROK_AGENT_SECRET is required to start Grok')
    const child = spawn(this.options.grokCommand, [
      ...this.options.grokArgs,
      'agent', 'serve', '--bind', `${this.options.grokServeHost}:${this.options.grokServePort}`, '--secret', secret,
    ], {
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    const deadline = Date.now() + this.options.workerStartupTimeoutMs
    while (Date.now() < deadline) {
      if (await tcpOpen(this.options.grokServeHost, this.options.grokServePort)) return
      await wait(50)
    }
    throw new Error('Grok agent server did not become ready')
  }

  private loadSessions(): void {
    if (!existsSync(this.sessionsPath)) return
    const file = jsonObject(readJson(this.sessionsPath), 'hostd sessions file')
    if (file['version'] !== 1 || !Array.isArray(file['sessions'])) throw new Error('invalid hostd sessions file')
    for (const value of file['sessions']) {
      const record = parseSessionRecord(value)
      this.sessions.set(record.sessionId, record)
    }
  }

  private saveSessions(): void {
    const file: HostdSessionsFile = { version: 1, sessions: [...this.sessions.values()] }
    writeJsonAtomic(this.sessionsPath, file)
  }
}

/** Default worker path beside the built hostd entry.
 * @returns the built detached-worker module path.
 */
export function defaultHoldWorkerScript(): string {
  return fileURLToPath(new URL('./hold-worker.js', import.meta.url))
}
