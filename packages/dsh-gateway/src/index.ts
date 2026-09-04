/** Web-machine remote-agent catalog, hostd proxy, and transcript projection. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOSTD_ARTIFACT_FILES, hostdArtifactVersionFromDirectory } from '@threadharbor/hostd/version'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  REMOTE_AGENT_GATEWAY_PATH,
  REMOTE_AGENT_GATEWAY_WS_PATH,
  REMOTE_AGENT_HOSTD_PATH,
  RemoteHostId,
  RemoteOperationId,
  RemoteProjectId,
  RemoteSessionId,
  RemoteTranscriptId,
  REMOTE_TRANSCRIPT_PAGE_MAX,
  REMOTE_TRANSCRIPT_PAGE_SIZE,
  isRemoteBackendSessionReady,
  isJsonValue,
  jsonObject,
  parseRemoteControlRequest,
  remoteAgentBackend,
  stringField,
  type JsonValue,
  type RemoteAgentState,
  type RemoteControlRequest,
  type RemoteControlResponse,
  type RemoteDirectoryListing,
  type RemoteHostInventory,
  type RemoteHiddenItems,
  type RemoteHostView,
  type RemoteJournalPage,
  type RemoteOperationPhase,
  type RemoteOperationView,
  type RemoteProjectView,
  type RemoteSessionAttachResult,
  type RemoteChannelState,
  type RemoteSessionView,
  type RemoteSshConfig,
  type RemoteTranscriptEntry,
  type RemoteTranscriptPage,
} from '@threadharbor/protocol'
import { projectNativeFrame } from './projection.ts'
import { remoteAgentDomainSpec, type RemoteAgentCatalogState } from './spec.ts'
import { SshManager, type SshDeploymentProgress } from './ssh-manager.ts'
import { restartLoopbackHostd } from './local-hostd.ts'
import { WsBroadcaster } from './ws-broadcaster.ts'
import { HostdConnectionPool } from './hostd-connection-pool.ts'

export { remoteAgentDomainSpec } from './spec.ts'
export { projectNativeFrame } from './projection.ts'
export { RemoteAgentHostd, type HostdOptions } from '@threadharbor/hostd'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Web-machine catalog and hostd proxy; never creates an in-process Agent. */
    remoteAgentGateway: RemoteAgentGateway
  }
}

/** Web gateway deployment configuration. */
export interface Config {
  /** Maximum browser request body. */
  maxRequestBytes: number
  /** Complete hostd HTTP request bound. */
  hostdRequestTimeoutMs: number
  /** Browser journal refresh cadence. */
  pollIntervalMs: number
  /** Durable projected entries retained per session. */
  maxTranscriptEntriesPerSession: number
  /** Web-service-owned OpenSSH known_hosts file. */
  sshKnownHostsPath: string
  /** SSH connection and key-scan timeout. */
  sshConnectTimeoutMs: number
  /** Hostd npm installation and service-start timeout. */
  sshInstallTimeoutMs: number
  /** Loopback port used by hostd on every managed SSH host. */
  hostdRemotePort: number
  /** Safe deployment namespace that isolates remote releases, state, services, and Agent binaries. */
  deploymentChannel: string
}

interface Tables {
  readonly hosts: KvTable<ReturnType<typeof RemoteHostId>, RemoteHostView>
  readonly projects: KvTable<ReturnType<typeof RemoteProjectId>, RemoteProjectView>
  readonly sessions: KvTable<ReturnType<typeof RemoteSessionId>, RemoteSessionView>
  readonly transcript: KvTable<ReturnType<typeof RemoteTranscriptId>, RemoteTranscriptEntry>
}

interface NativeChildUpdate {
  readonly nativeSessionId: string
  readonly parentNativeSessionId?: string
  readonly title: string
  readonly finished: boolean
  readonly failed: boolean
}

type TranscriptInput = Omit<RemoteTranscriptEntry, 'sessionId' | 'seq' | 'createdAt'>

/** Bound each durability slice so a large recovered journal cannot starve the Web event loop. */
const MAX_JOURNAL_EVENTS_PER_SYNC = 100

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function firstText(record: Record<string, JsonValue>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function nativeFrameSessionId(frame: JsonValue): string | undefined {
  const record = jsonRecord(frame)
  const params = jsonRecord(record?.['params'])
  return typeof params?.['sessionId'] === 'string' ? params['sessionId'] : undefined
}

function nativeChildUpdate(frame: JsonValue): NativeChildUpdate | undefined {
  const record = jsonRecord(frame)
  const method = record?.['method']
  const params = jsonRecord(record?.['params'])
  if (method === 'subagent.started' || method === 'subagent.finished') {
    const nativeSessionId = params?.['childSessionId']
    if (typeof nativeSessionId !== 'string' || nativeSessionId === '') return undefined
    return {
      nativeSessionId,
      ...(typeof params?.['parentSessionId'] === 'string' ? { parentNativeSessionId: params['parentSessionId'] } : {}),
      title: firstText(params ?? {}, ['title', 'description', 'role']) ?? '子任务',
      finished: method === 'subagent.finished',
      failed: params?.['status'] === 'error' || params?.['status'] === 'failed',
    }
  }
  if (method !== 'session/update') return undefined
  const update = jsonRecord(params?.['update'])
  const kind = update?.['sessionUpdate']
  if (kind !== 'subagent_spawned' && kind !== 'subagent_progress' && kind !== 'subagent_finished') return undefined
  const detail = jsonRecord(update?.['subagent']) ?? update
  if (detail === undefined) return undefined
  const nativeSessionId = firstText(detail, ['child_session_id', 'subagent_id', 'sessionId'])
  if (nativeSessionId === undefined) return undefined
  const status = firstText(detail, ['status', 'subagentStatus', 'subagent_status'])
  return {
    nativeSessionId,
    ...(typeof params?.['sessionId'] === 'string' ? { parentNativeSessionId: params['sessionId'] } : {}),
    title: firstText(detail, ['description', 'title', 'role', 'subagent_type', 'subagentType']) ?? '子任务',
    finished: kind === 'subagent_finished' || ['completed', 'failed', 'cancelled', 'expired'].includes(status ?? ''),
    failed: status === 'failed',
  }
}

function optionalString(record: Record<string, JsonValue>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  return value
}

function optionalNonNegativeInteger(record: Record<string, JsonValue>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${key} must be a non-negative integer`)
  return value as number
}

function requiredName(record: Record<string, JsonValue>, key: string): string {
  const value = stringField(record, key).trim()
  if (value === '') throw new Error(`${key} must not be blank`)
  return value
}

function loopbackEndpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('host endpoint must be a loopback http URL; reach remote hostd through an SSH tunnel')
  }
  if (url.username !== '' || url.password !== '') throw new Error('host endpoint must not contain credentials')
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.href.replace(/\/$/, '')
}

function sameSshTunnel(left: RemoteSshConfig, right: RemoteSshConfig): boolean {
  return left.target === right.target && left.port === right.port
}

function localPath(value: string): string {
  return resolve(value.startsWith('~/') ? `${homedir()}${value.slice(1)}` : value)
}

function hostdArtifactDirectory(): string {
  return fileURLToPath(new URL('../../hostd/lib/', import.meta.url))
}

const HOSTD_VERSION_CACHE: { stamp?: string; value?: string } = {}

function hostdArtifactStamp(directory: string): string {
  return HOSTD_ARTIFACT_FILES.map((file) => {
    const path = join(directory, file)
    try {
      if (!existsSync(path)) return `${file}:missing`
      const stats = statSync(path)
      return `${file}:${stats.size}:${stats.mtimeMs}`
    } catch {
      return `${file}:missing`
    }
  }).join('|')
}

function hostdArtifactVersion(): string {
  const directory = hostdArtifactDirectory()
  const stamp = hostdArtifactStamp(directory)
  if (HOSTD_VERSION_CACHE.value !== undefined && HOSTD_VERSION_CACHE.stamp === stamp) return HOSTD_VERSION_CACHE.value
  const value = hostdArtifactVersionFromDirectory(directory)
  HOSTD_VERSION_CACHE.stamp = stamp
  HOSTD_VERSION_CACHE.value = value
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inventoryFailure(error: unknown): string {
  const message = errorMessage(error)
  if (/fetch failed|Failed to fetch|ECONNREFUSED|ECONNRESET/i.test(message)) {
    return '无法连接到 hostd。请确认远端服务已启动后再试。'
  }
  if (/timed out|timeout|TimeoutError|AbortError/i.test(message)) {
    return '连接 hostd 超时。请检查网络或 SSH 隧道后再试。'
  }
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(message)) {
    return '找不到主机地址。请检查主机名或网络。'
  }
  return message
}

function displayError(error: unknown): string {
  const message = errorMessage(error).replaceAll(/[\r\n\0]+/g, ' ').trim()
  return message.length <= 500 ? message : `${message.slice(0, 499)}…`
}

function holdUnreachable(error: unknown): boolean {
  return /ECONNREFUSED|ENOENT|EPIPE|ENOTSOCK|fetch failed|process is not running|did not start/i
    .test(errorMessage(error))
}

function holdSessionFailure(error: unknown): string {
  const message = errorMessage(error)
  if (holdUnreachable(error) || /\.sock|named pipe/i.test(message)) {
    return '远程会话进程已停止。可以点「在当前会话重开」，系统会在当前会话上重启 Agent，对话记录会保留。'
  }
  return displayError(error)
}

function operationFailureDetail(kind: RemoteOperationView['kind'], error: unknown): string {
  const message = errorMessage(error)
  if (/timed out|timeout/i.test(message)) return '操作超时，请检查远端主机状态后重试。'
  if (kind === 'agent-install') return displayError(error) || 'Agent 部署失败，请检查远端主机的 npm/python 和网络后重试。'
  if (/host key changed|approved fingerprint/i.test(message)) return 'SSH 主机密钥与已批准的指纹不一致。'
  if (/Node\.js 22/i.test(message)) return '远端主机需要 Node.js 22 或更高版本。'
  if (/configured SSH credentials/i.test(message)) return '无法使用当前 SSH 配置连接远端主机。'
  return 'SSH 部署失败，请检查主机连接和远端服务日志。'
}

function responseJson(res: ServerResponse, status: number, response: RemoteControlResponse): void {
  const body = JSON.stringify(response)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Durable remote-agent Web service and control endpoint. */
export class RemoteAgentGateway extends Service {
  static inject = ['storageDomain', 'webServer']
  static Config: z<Config> = z.object({
    maxRequestBytes: z.natural().min(1).required(),
    hostdRequestTimeoutMs: z.natural().min(1).required(),
    pollIntervalMs: z.natural().min(1).required(),
    maxTranscriptEntriesPerSession: z.natural().min(1).required(),
    sshKnownHostsPath: z.string().required(),
    sshConnectTimeoutMs: z.natural().min(1).required(),
    sshInstallTimeoutMs: z.natural().min(1).required(),
    hostdRemotePort: z.natural().min(1).max(65535).required(),
    deploymentChannel: z.string().required(),
  })

  private tables?: Tables
  private global?: DomainGlobal<RemoteAgentCatalogState>
  private operationTail: Promise<void> = Promise.resolve()
  private readonly operations = new Map<ReturnType<typeof RemoteOperationId>, RemoteOperationView>()
  private readonly sshManager: SshManager
  private readonly wsBroadcaster = new WsBroadcaster()
  private readonly followedSyncing = new Set<string>()
  private readonly journalApply = new Map<string, Promise<void>>()
  private hostdConnections!: HostdConnectionPool
  private syncStopped = false

  /** @param ctx - Host context carrying storage-domain and webserver. @param config - validated bounds. */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'remoteAgentGateway')
    this.sshManager = new SshManager({
      knownHostsPath: localPath(config.sshKnownHostsPath),
      connectTimeoutMs: config.sshConnectTimeoutMs,
      installTimeoutMs: config.sshInstallTimeoutMs,
      hostdRemotePort: config.hostdRemotePort,
      deploymentChannel: config.deploymentChannel,
      hostdArtifactDirectory: hostdArtifactDirectory(),
    })
    this.hostdConnections = new HostdConnectionPool(this.sshManager, {
      requestTimeoutMs: config.hostdRequestTimeoutMs,
    })
    ctx.effect(() => () => { this.sshManager.close() }, 'threadharbor.sshClose')
    ctx.effect(() => () => { void this.hostdConnections.closeAll() }, 'remoteAgent.hostdConnectionsClose')
    ctx.effect(() => () => { this.syncStopped = true }, 'remoteAgent.sessionSyncClose')
  }

  /** Replace the WebSocket factory (test-only seam). */
  setHostdSocketFactory(factory: (url: string) => import('ws').WebSocket): void {
    this.hostdConnections = new HostdConnectionPool(this.sshManager, {
      requestTimeoutMs: this.config.hostdRequestTimeoutMs,
      socketFactory: factory,
    })
  }

  /** Attach a mock browser socket so tests can observe gateway WS pushes. */
  registerBrowserForTesting(ws: import('ws').WebSocket, browserId: string): void {
    this.wsBroadcaster.registerForTesting(ws, browserId)
  }

  /** Open the independent catalog domain and register its exact control route. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(remoteAgentDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'remoteAgent.domainClose')
    this.tables = {
      hosts: domain.table('hosts'),
      projects: domain.table('projects'),
      sessions: domain.table('sessions'),
      transcript: domain.table('transcript'),
    }
    this.global = domain.global
    this.validateCatalog()
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact', path: REMOTE_AGENT_GATEWAY_PATH, handler: (req, res) => this.handleHttp(req, res),
    }), 'remoteAgent.controlRoute')
    this.ctx.effect(() => {
      this.wsBroadcaster.setRequestHandler(async (request) => await this.dispatch({
        id: request.id,
        method: request.method as RemoteControlRequest['method'],
        params: request.params,
      }))
      return this.ctx.webServer.registerUpgrade({
        path: REMOTE_AGENT_GATEWAY_WS_PATH,
        handler: (req, socket, head) => {
          this.wsBroadcaster.handleUpgrade(req, socket, head)
        },
      })
    }, 'remoteAgent.wsRoute')
    for (const sessionId of this.requireGlobal().get().sessionIds) {
      const session = this.requireTables().sessions.get(sessionId)
      if (session?.turnState === 'running' || session?.turnState === 'waiting-permission') {
        this.ensureFollowedSync(sessionId)
      }
    }
  }

  /** Complete current browser catalog projection. Transcript bodies are loaded per session. */
  state(): RemoteAgentState {
    const state = this.requireGlobal().get()
    const tables = this.requireTables()
    return {
      pollIntervalMs: this.config.pollIntervalMs,
      hosts: state.hostIds
        .map(id => this.requireRecord(tables.hosts, id, 'host'))
        .filter(host => host.hiddenAt === undefined),
      projects: state.projectIds
        .map(id => this.requireRecord(tables.projects, id, 'project'))
        .filter(project => project.hiddenAt === undefined && tables.hosts.get(project.hostId)?.hiddenAt === undefined),
      sessions: state.sessionIds
        .map(id => this.requireRecord(tables.sessions, id, 'session'))
        .filter(session => this.sessionIsVisible(session))
        .map(session => this.withTranscriptHead(session, state)),
      transcript: [],
      operations: [...this.operations.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
      hostdArtifactVersion: hostdArtifactVersion(),
      browserId: 'gateway',
      unreadCounts: {},
    }
  }

  /** Dispatch one browser control request.
   * @param request - validated browser request.
   * @returns the JSON result for the request method.
   */
  async dispatch(request: RemoteControlRequest): Promise<JsonValue> {
    switch (request.method) {
      case 'state':
        return this.state() as unknown as JsonValue
      case 'host.add':
        return await this.enqueue(() => this.addHost(request.params)) as unknown as JsonValue
      case 'host.update':
        return await this.enqueue(() => this.updateHost(request.params)) as unknown as JsonValue
      case 'host.hide':
        return await this.enqueue(() => this.hideHost(request.params)) as unknown as JsonValue
      case 'host.unhide':
        return await this.enqueue(() => this.unhideHost(request.params)) as unknown as JsonValue
      case 'host.delete':
        return await this.enqueue(() => this.deleteHost(request.params)) as unknown as JsonValue
      case 'hidden.list':
        return this.hiddenItems() as unknown as JsonValue
      case 'host.ssh.inspect':
        return await this.sshManager.inspect(this.sshManager.parseInspectionConfig(request.params['ssh'])) as unknown as JsonValue
      case 'host.ssh.deploy':
        return await this.enqueue(() => this.deploySshHost(request.params)) as unknown as JsonValue
      case 'host.upgrade':
        return await this.enqueue(() => this.upgradeHost(request.params)) as unknown as JsonValue
      case 'operation.start':
        return this.startOperation(request.params) as unknown as JsonValue
      case 'operation.list':
        return [...this.operations.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)) as unknown as JsonValue
      case 'agent.install.plan':
      case 'agent.install':
      case 'agent.config.get':
      case 'agent.config.set':
      case 'agent.credential.status':
      case 'agent.credential.set':
      case 'auth.start':
      case 'auth.status':
      case 'auth.respond':
      case 'auth.cancel':
        return await this.proxyHostOperation(request.method, request.params)
      case 'inventory':
        return await this.enqueue(() => this.refreshInventory(request.params)) as unknown as JsonValue
      case 'project.create':
        return await this.enqueue(() => this.createProject(request.params)) as unknown as JsonValue
      case 'project.rename':
        return await this.enqueue(() => this.renameProject(request.params)) as unknown as JsonValue
      case 'project.hide':
        return await this.enqueue(() => this.hideProject(request.params)) as unknown as JsonValue
      case 'project.unhide':
        return await this.enqueue(() => this.unhideProject(request.params)) as unknown as JsonValue
      case 'project.delete':
        return await this.enqueue(() => this.deleteProject(request.params)) as unknown as JsonValue
      case 'session.start':
        return await this.enqueue(() => this.startSession(request.params)) as unknown as JsonValue
      case 'session.attach':
        return await this.enqueue(() => this.attachSession(request.params)) as unknown as JsonValue
      case 'session.rename':
        return await this.enqueue(() => this.renameSession(request.params)) as unknown as JsonValue
      case 'session.archive':
        return await this.enqueue(() => this.archiveSession(request.params)) as unknown as JsonValue
      case 'session.unarchive':
        return await this.enqueue(() => this.unarchiveSession(request.params)) as unknown as JsonValue
      case 'session.delete':
        return await this.enqueue(() => this.deleteSession(request.params)) as unknown as JsonValue
      case 'session.prompt':
        return await this.enqueue(() => this.prompt(request.params))
      case 'session.cancel':
        return await this.enqueue(() => this.cancel(request.params))
      case 'session.permission':
        return await this.enqueue(() => this.permission(request.params))
      case 'transcript.read':
        return this.readTranscript(request.params) as unknown as JsonValue
      case 'events.read':
        return await this.enqueue(() => this.syncEvents(request.params)) as unknown as JsonValue
      case 'session.follow':
        return await this.enqueue(() => this.handleFollow(request.params)) as unknown as JsonValue
      case 'session.unfollow':
        return await this.enqueue(() => this.handleUnfollow(request.params)) as unknown as JsonValue
      case 'session.catchup':
        return await this.enqueue(() => this.syncEvents(request.params)) as unknown as JsonValue
      case 'browser.hello':
        return await this.enqueue(() => this.handleHello(request.params)) as unknown as JsonValue
      case 'fs.list':
        return await this.listDirectory(request.params) as unknown as JsonValue
      default:
        throw new Error(`Web gateway does not implement method ${request.method}`)
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    let bytes = 0
    const chunks: Uint8Array[] = []
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      bytes += chunk.length
      if (bytes > this.config.maxRequestBytes) throw new Error('request body exceeds configured limit')
      chunks.push(chunk)
    }
    let request: RemoteControlRequest
    let responseId = 'request'
    try {
      request = parseRemoteControlRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      responseId = request.id
      const result = await this.dispatch(request)
      responseJson(res, 200, { id: request.id, ok: true, result })
    } catch (error) {
      responseJson(res, 400, {
        id: responseId, ok: false, error: { code: 'REMOTE_AGENT_ERROR', message: errorMessage(error) },
      })
    }
  }

  private async addHost(params: Record<string, JsonValue>): Promise<RemoteHostView> {
    const endpoint = loopbackEndpoint(stringField(params, 'endpoint'))
    const title = requiredName(params, 'title')
    const tables = this.requireTables()
    const duplicate = [...tables.hosts.entries()].find(([, host]) => host.endpoint === endpoint)
    if (duplicate !== undefined) {
      const renamed = { ...duplicate[1], title, updatedAt: new Date().toISOString() }
      await tables.hosts.put(duplicate[0], renamed)
      return await this.refreshHostInventory(renamed)
    }
    const hostId = RemoteHostId(randomUUID())
    const now = new Date().toISOString()
    const host: RemoteHostView = { hostId, title, endpoint, createdAt: now, updatedAt: now }
    await tables.hosts.put(hostId, host)
    const state = this.requireGlobal().get()
    await this.requireGlobal().set({ ...state, hostIds: [...state.hostIds, hostId] })
    return await this.refreshHostInventory(host)
  }

  private async updateHost(
    params: Record<string, JsonValue>,
    onProgress?: (progress: SshDeploymentProgress) => void,
  ): Promise<RemoteHostView> {
    const hostId = RemoteHostId(stringField(params, 'hostId'))
    const current = this.requireHost(hostId)
    const title = requiredName(params, 'title')
    const hasEndpoint = params['endpoint'] !== undefined
    const hasSsh = params['ssh'] !== undefined
    if (hasEndpoint && hasSsh) throw new Error('host update cannot include both endpoint and ssh')
    const tables = this.requireTables()

    if (!hasEndpoint && !hasSsh) {
      const updated: RemoteHostView = { ...current, title, updatedAt: new Date().toISOString() }
      await tables.hosts.put(hostId, updated)
      return updated
    }

    if (hasEndpoint) {
      const endpoint = loopbackEndpoint(stringField(params, 'endpoint'))
      const duplicate = [...tables.hosts.entries()].find(([candidateId, host]) =>
        candidateId !== hostId && host.endpoint === endpoint)
      if (duplicate !== undefined) throw new Error('another host already uses this endpoint')
      const { ssh: _ssh, ...rest } = current
      const updated: RemoteHostView = { ...rest, title, endpoint, updatedAt: new Date().toISOString() }
      await tables.hosts.put(hostId, updated)
      if (current.ssh !== undefined) this.sshManager.releaseTunnel(current.ssh)
      return await this.refreshHostInventory(updated)
    }

    if (params['confirm'] !== true) throw new Error('hostd deployment requires confirm: true')
    const ssh = this.sshManager.parseApprovedConfig(params['ssh'])
    const duplicate = [...tables.hosts.entries()].find(([candidateId, host]) =>
      candidateId !== hostId
      && host.ssh?.target === ssh.target
      && host.ssh.port === ssh.port
      && host.ssh.user === ssh.user)
    if (duplicate !== undefined) throw new Error('another host already uses this SSH connection')
    const endpoint = await this.sshManager.deploy(ssh, onProgress)
    const updated: RemoteHostView = { ...current, title, endpoint, ssh, updatedAt: new Date().toISOString() }
    await tables.hosts.put(hostId, updated)
    if (current.ssh !== undefined && !sameSshTunnel(current.ssh, ssh)) this.sshManager.releaseTunnel(current.ssh)
    return await this.refreshHostInventory(updated)
  }

  private async upgradeHost(params: Record<string, JsonValue>): Promise<RemoteHostView> {
    if (params['confirm'] !== true) throw new Error('hostd upgrade requires confirm: true')
    const host = this.requireHost(RemoteHostId(stringField(params, 'hostId')))
    if (host.ssh !== undefined) {
      throw new Error('SSH 主机请用「升级 hostd」走自动部署，不要对本机隧道端口重启')
    }
    const url = new URL(host.endpoint)
    const port = url.port === '' ? 80 : Number(url.port)
    if (!Number.isSafeInteger(port) || port <= 0) throw new Error('本机 hostd 地址没有有效端口')
    await restartLoopbackHostd(port, hostdArtifactDirectory())
    return await this.refreshHostInventory(host)
  }

  private async deploySshHost(
    params: Record<string, JsonValue>,
    onProgress?: (progress: SshDeploymentProgress) => void,
  ): Promise<RemoteHostView> {
    if (params['confirm'] !== true) throw new Error('hostd deployment requires confirm: true')
    const title = requiredName(params, 'title')
    const ssh = this.sshManager.parseApprovedConfig(params['ssh'])
    const tables = this.requireTables()
    const duplicate = [...tables.hosts.entries()].find(([, host]) =>
      host.ssh?.target === ssh.target && host.ssh.port === ssh.port && host.ssh.user === ssh.user)
    if (duplicate !== undefined) {
      const endpoint = await this.sshManager.deploy(ssh, onProgress)
      const redeployed = { ...duplicate[1], title, endpoint, ssh, updatedAt: new Date().toISOString() }
      await tables.hosts.put(duplicate[0], redeployed)
      return await this.refreshHostInventory(redeployed)
    }
    const endpoint = await this.sshManager.deploy(ssh, onProgress)
    const hostId = RemoteHostId(randomUUID())
    const now = new Date().toISOString()
    const host: RemoteHostView = { hostId, title, endpoint, ssh, createdAt: now, updatedAt: now }
    await tables.hosts.put(hostId, host)
    const state = this.requireGlobal().get()
    await this.requireGlobal().set({ ...state, hostIds: [...state.hostIds, hostId] })
    return await this.refreshHostInventory(host)
  }

  /** Start a gateway-owned long operation and return before its queued work executes. */
  private startOperation(params: Record<string, JsonValue>): RemoteOperationView {
    if (params['confirm'] !== true) throw new Error('operation.start requires confirm: true')
    const kind = stringField(params, 'kind')
    if (kind === 'host-ssh-deploy') {
      const title = requiredName(params, 'title')
      const ssh = this.sshManager.parseApprovedConfig(params['ssh'])
      const hostIdText = optionalString(params, 'hostId')
      const hostId = hostIdText === undefined ? undefined : RemoteHostId(hostIdText)
      if (hostId !== undefined) this.requireHost(hostId)
      const target = hostId === undefined
        ? `ssh:${ssh.user ?? ''}@${ssh.target}:${ssh.port ?? 22}`
        : `host:${hostId}`
      return this.launchOperation({
        kind,
        title: hostId === undefined ? `部署 ${title}` : `重新部署 ${title}`,
        detail: '部署任务已排队。',
        target,
        ...(hostId === undefined ? {} : { hostId }),
      }, async (report) => {
        const input = { ...params, title, ssh: ssh as unknown as JsonValue }
        const host = hostId === undefined
          ? await this.deploySshHost(input, report)
          : await this.updateHost(input, report)
        report({ phase: 'refreshing', detail: '正在刷新主机和 Agent 状态。' })
        if (host.inventoryError !== undefined || host.inventory?.healthy !== true) {
          throw new Error('deployed hostd did not pass its inventory health check')
        }
        return { hostId: host.hostId }
      })
    }
    if (kind === 'agent-install') {
      const hostId = RemoteHostId(stringField(params, 'hostId'))
      const host = this.requireHost(hostId)
      const backend = remoteAgentBackend(params['backend'])
      return this.launchOperation({
        kind,
        title: `部署 ${backend}`,
        detail: `已在 ${host.title} 上排队部署 ${backend}。`,
        target: `host:${hostId}:agent:${backend}`,
        hostId,
        backend,
      }, async (report) => {
        report({ phase: 'installing', detail: `正在 ${host.title} 上执行 ${backend} 的官方安装命令。` })
        await this.callHostd(host, 'agent.install', { backend, confirm: true }, this.config.sshInstallTimeoutMs)
        report({ phase: 'verifying', detail: `正在验证 ${backend} 安装结果。` })
        report({ phase: 'refreshing', detail: '正在刷新 Agent 库存状态。' })
        const refreshed = await this.refreshHostInventory(this.requireHost(hostId))
        const installed = refreshed.inventory?.backends.find(candidate => candidate.backend === backend)?.installed === true
        if (refreshed.inventoryError !== undefined || !installed) {
          throw new Error('installed Agent did not pass inventory verification')
        }
        return { hostId }
      })
    }
    throw new Error('operation kind must be host-ssh-deploy or agent-install')
  }

  /** Register one background task, serialize its mutation, and retain a safe result summary. */
  private launchOperation(
    input: Pick<RemoteOperationView, 'kind' | 'title' | 'detail' | 'target'>
      & Partial<Pick<RemoteOperationView, 'hostId' | 'backend'>>,
    work: (report: (progress: SshDeploymentProgress | { phase: RemoteOperationPhase; detail: string }) => void) => Promise<{ hostId?: ReturnType<typeof RemoteHostId> }>,
  ): RemoteOperationView {
    const duplicate = [...this.operations.values()].find(operation =>
      operation.target === input.target && (operation.status === 'queued' || operation.status === 'running'))
    if (duplicate !== undefined) throw new Error(`${duplicate.title} 已在运行`)
    const operationId = RemoteOperationId(randomUUID())
    const now = new Date().toISOString()
    const initial: RemoteOperationView = {
      operationId,
      kind: input.kind,
      status: 'queued',
      phase: 'queued',
      title: input.title,
      detail: input.detail,
      target: input.target,
      cancellable: false,
      ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
      ...(input.backend === undefined ? {} : { backend: input.backend }),
      startedAt: now,
      updatedAt: now,
    }
    this.operations.set(operationId, initial)
    this.pruneOperations()
    void this.enqueue(async () => {
      this.updateOperation(operationId, { status: 'running' })
      try {
        const result = await work((progress) => { this.updateOperation(operationId, progress) })
        this.updateOperation(operationId, {
          status: 'succeeded', phase: 'completed', detail: `${input.title}已完成。`,
          ...(result.hostId === undefined ? {} : { hostId: result.hostId }),
          finishedAt: new Date().toISOString(),
        })
      } catch (error) {
        this.updateOperation(operationId, {
          status: 'failed', phase: 'failed', detail: operationFailureDetail(input.kind, error), finishedAt: new Date().toISOString(),
        })
      }
    })
    return initial
  }

  private updateOperation(
    operationId: ReturnType<typeof RemoteOperationId>,
    update: Partial<Omit<RemoteOperationView, 'operationId' | 'kind' | 'title' | 'target' | 'startedAt'>>,
  ): void {
    const current = this.operations.get(operationId)
    if (current === undefined) return
    this.operations.set(operationId, { ...current, ...update, updatedAt: new Date().toISOString() })
  }

  private pruneOperations(): void {
    const finished = [...this.operations.values()]
      .filter(operation => operation.status === 'succeeded' || operation.status === 'failed')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    for (const operation of finished.slice(20)) this.operations.delete(operation.operationId)
  }

  private async proxyHostOperation(
    method: RemoteControlRequest['method'],
    params: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const host = this.requireHost(RemoteHostId(stringField(params, 'hostId')))
    const { hostId: _hostId, ...forwarded } = params
    return await this.callHostd(host, method, forwarded)
  }

  private async refreshInventory(params: Record<string, JsonValue>): Promise<RemoteHostView> {
    const host = this.requireHost(RemoteHostId(stringField(params, 'hostId')))
    return await this.refreshHostInventory(host)
  }

  private async refreshHostInventory(host: RemoteHostView, retried = false): Promise<RemoteHostView> {
    try {
      const inventory = await this.callHostd(host, 'inventory', {}) as unknown as RemoteHostInventory
      const { inventoryError: _inventoryError, ...current } = this.requireHost(host.hostId)
      const updated: RemoteHostView = { ...current, inventory, updatedAt: new Date().toISOString() }
      await this.requireTables().hosts.put(host.hostId, updated)
      return updated
    } catch (error) {
      if (host.ssh !== undefined && !retried) {
        this.sshManager.releaseTunnel(host.ssh)
        return await this.refreshHostInventory(this.requireHost(host.hostId), true)
      }
      const current = this.requireHost(host.hostId)
      const { inventory: _inventory, inventoryError: _inventoryError, ...rest } = current
      const updated: RemoteHostView = {
        ...rest, inventoryError: inventoryFailure(error), updatedAt: new Date().toISOString(),
      }
      await this.requireTables().hosts.put(host.hostId, updated)
      return updated
    }
  }

  private async createProject(params: Record<string, JsonValue>): Promise<RemoteProjectView> {
    const host = this.requireHost(RemoteHostId(stringField(params, 'hostId')))
    const listing = await this.callHostd(host, 'fs.list', { path: stringField(params, 'cwd') }) as unknown as RemoteDirectoryListing
    const cwd = listing.path
    const tables = this.requireTables()
    const duplicate = [...tables.projects.entries()].find(([, project]) => project.hostId === host.hostId && project.cwd === cwd)
    if (duplicate !== undefined) return duplicate[1]
    const projectId = RemoteProjectId(randomUUID())
    const now = new Date().toISOString()
    const project: RemoteProjectView = {
      projectId, hostId: host.hostId, title: stringField(params, 'title'), cwd, createdAt: now, updatedAt: now,
    }
    await tables.projects.put(projectId, project)
    const state = this.requireGlobal().get()
    await this.requireGlobal().set({ ...state, projectIds: [...state.projectIds, projectId] })
    return project
  }

  /** Rename one catalogued project without touching its remote directory. */
  private async renameProject(params: Record<string, JsonValue>): Promise<RemoteProjectView> {
    const projectId = RemoteProjectId(stringField(params, 'projectId'))
    const current = this.requireProject(projectId)
    const title = requiredName(params, 'title')
    if (title === current.title) return current
    const updated: RemoteProjectView = { ...current, title, updatedAt: new Date().toISOString() }
    await this.requireTables().projects.put(projectId, updated)
    return updated
  }

  /** Enumerate hidden hosts/projects and archived sessions for the settings catalog. */
  private hiddenItems(): RemoteHiddenItems {
    const state = this.requireGlobal().get()
    const tables = this.requireTables()
    const hosts = state.hostIds
      .map(id => tables.hosts.get(id))
      .filter((host): host is RemoteHostView => host !== undefined && host.hiddenAt !== undefined)
    const projects = state.projectIds
      .map(id => tables.projects.get(id))
      .filter((project): project is RemoteProjectView => {
        if (project === undefined) return false
        if (project.hiddenAt !== undefined) return true
        return tables.hosts.get(project.hostId)?.hiddenAt !== undefined
      })
    const sessions = state.sessionIds
      .map(id => tables.sessions.get(id))
      .filter((session): session is RemoteSessionView => session !== undefined && !this.sessionIsVisible(session))
    return { hosts, projects, sessions }
  }

  /** Mark a catalogued host as hidden so the browser omits it from the normal projection. */
  private async hideHost(params: Record<string, JsonValue>): Promise<RemoteHostView> {
    const hostId = RemoteHostId(stringField(params, 'hostId'))
    const current = this.requireHost(hostId)
    if (current.hiddenAt !== undefined) return current
    const tables = this.requireTables()
    const now = new Date().toISOString()
    const hidden: RemoteHostView = { ...current, hiddenAt: now, updatedAt: now }
    await tables.hosts.put(hostId, hidden)
    for (const [projectId, project] of tables.projects.entries()) {
      if (project.hostId !== hostId || project.hiddenAt !== undefined) continue
      await tables.projects.put(projectId, { ...project, hiddenAt: now, updatedAt: now })
      await this.archiveProjectSessions(projectId, now)
    }
    return hidden
  }

  /** Restore a previously hidden host so the browser shows it again. */
  private async unhideHost(params: Record<string, JsonValue>): Promise<RemoteHostView> {
    const hostId = RemoteHostId(stringField(params, 'hostId'))
    const current = this.requireHost(hostId)
    if (current.hiddenAt === undefined) return current
    const tables = this.requireTables()
    const now = new Date().toISOString()
    const { hiddenAt: _hiddenAt, ...without } = current
    const restored: RemoteHostView = { ...without, updatedAt: now }
    await tables.hosts.put(hostId, restored)
    const hostHiddenAt = current.hiddenAt
    for (const [projectId, project] of tables.projects.entries()) {
      if (project.hostId !== hostId || project.hiddenAt === undefined || project.hiddenAt !== hostHiddenAt) continue
      const { hiddenAt: _projectHiddenAt, ...projectWithout } = project
      await tables.projects.put(projectId, { ...projectWithout, updatedAt: now })
    }
    return restored
  }

  /** Permanently delete a catalogued host and every project + session that lives on it. */
  private async deleteHost(params: Record<string, JsonValue>): Promise<RemoteHostView> {
    const hostId = RemoteHostId(stringField(params, 'hostId'))
    const current = this.requireHost(hostId)
    const tables = this.requireTables()
    const global = this.requireGlobal()
    const state = global.get()
    const projectIds = state.projectIds.filter(id => tables.projects.get(id)?.hostId === hostId)
    const sessionIds = state.sessionIds.filter(id => {
      const session = tables.sessions.get(id)
      return session !== undefined && projectIds.includes(session.projectId)
    })
    if (current.ssh !== undefined) this.sshManager.releaseTunnel(current.ssh)
    await this.deleteSessionRecords(sessionIds)
    for (const id of projectIds) await tables.projects.delete(id)
    await tables.hosts.delete(hostId)
    await global.set({
      ...state,
      hostIds: state.hostIds.filter(id => id !== hostId),
      projectIds: state.projectIds.filter(id => !projectIds.includes(id)),
      sessionIds: state.sessionIds.filter(id => !sessionIds.includes(id)),
    })
    return current
  }

  /** Mark a catalogued project as hidden so the browser omits it from the normal projection. */
  private async hideProject(params: Record<string, JsonValue>): Promise<RemoteProjectView> {
    const projectId = RemoteProjectId(stringField(params, 'projectId'))
    const current = this.requireProject(projectId)
    if (current.hiddenAt !== undefined) return current
    const now = new Date().toISOString()
    const hidden: RemoteProjectView = { ...current, hiddenAt: now, updatedAt: now }
    await this.requireTables().projects.put(projectId, hidden)
    await this.archiveProjectSessions(projectId, now)
    return hidden
  }

  /** Restore a previously hidden project so the browser shows it again. */
  private async unhideProject(params: Record<string, JsonValue>): Promise<RemoteProjectView> {
    const projectId = RemoteProjectId(stringField(params, 'projectId'))
    const current = this.requireProject(projectId)
    if (current.hiddenAt === undefined) return current
    const host = this.requireHost(current.hostId)
    if (host.hiddenAt !== undefined) throw new Error('请先恢复所属主机')
    const now = new Date().toISOString()
    const { hiddenAt: _hiddenAt, ...without } = current
    const restored: RemoteProjectView = { ...without, updatedAt: now }
    await this.requireTables().projects.put(projectId, restored)
    return restored
  }

  /** Permanently delete a catalogued project and every session that lives on it. */
  private async deleteProject(params: Record<string, JsonValue>): Promise<RemoteProjectView> {
    const projectId = RemoteProjectId(stringField(params, 'projectId'))
    const current = this.requireProject(projectId)
    const tables = this.requireTables()
    const global = this.requireGlobal()
    const state = global.get()
    const sessionIds = state.sessionIds.filter(id => tables.sessions.get(id)?.projectId === projectId)
    await this.deleteSessionRecords(sessionIds)
    await tables.projects.delete(projectId)
    await global.set({
      ...state,
      projectIds: state.projectIds.filter(id => id !== projectId),
      sessionIds: state.sessionIds.filter(id => !sessionIds.includes(id)),
    })
    return current
  }

  private async startSession(params: Record<string, JsonValue>): Promise<RemoteSessionView> {
    const tables = this.requireTables()
    const project = this.requireProject(RemoteProjectId(stringField(params, 'projectId')))
    const parentIdValue = optionalString(params, 'parentSessionId')
    const parent = parentIdValue === undefined ? undefined : this.requireSession(RemoteSessionId(parentIdValue))
    if (parent !== undefined && parent.projectId !== project.projectId) throw new Error('child session must use its parent project')
    const requestedBackend = params['backend'] === undefined ? undefined : remoteAgentBackend(params['backend'])
    const backend = parent?.backend ?? requestedBackend
    if (backend === undefined) throw new Error('root session.start requires backend')
    if (parent !== undefined && requestedBackend !== undefined && requestedBackend !== parent.backend) {
      throw new Error('child session backend is immutable and must equal its parent backend')
    }
    const cached = this.requireHost(project.hostId)
    const host = cached.inventoryError === undefined && cached.inventory?.healthy === true
      ? cached
      : await this.refreshHostInventory(cached)
    const available = host.inventory?.backends.find(entry => entry.backend === backend)
    if (available === undefined || !available.installed) throw new Error(`backend ${backend} is not installed on host ${host.title}`)
    if (!available.sessionCapable) throw new Error(`backend ${backend} has no configured ThreadHarbor session adapter`)
    if (backend === 'dsh' && !available.authenticated) throw new Error('DSH 需要先在主机设置中配置 API Key')
    if (!isRemoteBackendSessionReady(available)) throw new Error(`backend ${backend} is not authenticated on host ${host.title}`)
    const sessionId = RemoteSessionId(randomUUID())
    const now = new Date().toISOString()
    const session: RemoteSessionView = {
      sessionId,
      projectId: project.projectId,
      ...(parent === undefined ? {} : { parentSessionId: parent.sessionId }),
      title: optionalString(params, 'title') ?? '新会话',
      backend,
      channelState: 'connecting',
      turnState: 'idle',
      createdAt: now,
      updatedAt: now,
    }
    await tables.sessions.put(sessionId, session)
    const state = this.requireGlobal().get()
    await this.requireGlobal().set({ ...state, sessionIds: [...state.sessionIds, sessionId] })
    const text = optionalString(params, 'text')
    const clientId = optionalString(params, 'clientId')
    const requestId = optionalString(params, 'requestId')
    if (text !== undefined && clientId !== undefined && requestId !== undefined) {
      await this.appendTranscript(sessionId, {
        transcriptId: RemoteTranscriptId(`user:${sessionId}:${clientId}:${requestId}`),
        role: 'user',
        kind: 'message',
        text,
        requestId,
      })
    }
    // Persist and announce the connecting-state row immediately so the caller
    // (and any future re-attach from a refreshed browser) sees the session
    // before the remote hold exists. The hostd call runs after we return.
    const announced = this.withTranscriptHead(session)
    this.broadcastSessionView(announced)
    const completion = this.completeStart(host, session, parent?.binding?.nativeSessionId)
    this.inflightStarts.set(sessionId, completion)
    void completion.finally(() => { this.inflightStarts.delete(sessionId) })
    return announced
  }

  /** In-flight session.start completions keyed by session id, so callers
   *  (especially tests) can block until the remote hold is up or has failed. */
  private readonly inflightStarts = new Map<ReturnType<typeof RemoteSessionId>, Promise<void>>()

  /** Resolve a freshly created session row by talking to hostd.
   * Runs detached so the caller is not blocked on remote hold startup. The
   * final state is broadcast via session.view.changed so any open browser
   * (current or future) reflects it. Failures flip the row to lost/failed
   * rather than removing it — the user keeps a tombstone to retry from. */
  private async completeStart(
    host: RemoteHostView,
    initial: RemoteSessionView,
    parentNativeSessionId: string | undefined,
  ): Promise<void> {
    const tables = this.requireTables()
    try {
      const attached = await this.callHostd(host, 'session.start', {
        sessionId: initial.sessionId,
        backend: initial.backend,
        cwd: this.requireProject(initial.projectId).cwd,
        ...(parentNativeSessionId === undefined ? {} : { parentNativeSessionId }),
      }) as unknown as RemoteSessionAttachResult
      const ready = this.withAttachment(initial, attached)
      await tables.sessions.put(initial.sessionId, ready)
      this.broadcastSessionView(ready)
    } catch (error) {
      const failed: RemoteSessionView = {
        ...initial,
        channelState: 'lost',
        turnState: 'failed',
        updatedAt: new Date().toISOString(),
      }
      await tables.sessions.put(initial.sessionId, failed)
      this.broadcastSessionView(failed)
      this.wsBroadcaster.broadcast({
        type: 'operation.progress',
        operationId: `session-start-${initial.sessionId}`,
        phase: 'failed',
      })
    }
  }

  private async attachSession(params: Record<string, JsonValue>): Promise<RemoteSessionView> {
    const session = this.requireSession(RemoteSessionId(stringField(params, 'sessionId')))
    const project = this.requireProject(session.projectId)
    const host = this.requireHost(project.hostId)
    let attached: RemoteSessionAttachResult
    try {
      attached = await this.callHostd(host, 'session.attach', { sessionId: session.sessionId }) as unknown as RemoteSessionAttachResult
    } catch (error) {
      await this.requireTables().sessions.put(session.sessionId, {
        ...session,
        channelState: 'lost',
        turnState: session.turnState === 'running' ? 'failed' : session.turnState,
        ...(session.binding === undefined ? {} : { binding: { ...session.binding, state: 'lost' } }),
        updatedAt: new Date().toISOString(),
      })
      throw new Error(holdSessionFailure(error))
    }
    if (session.binding !== undefined && session.binding.generation !== attached.generation) {
      const lost: RemoteSessionView = {
        ...session,
        channelState: 'lost',
        turnState: session.turnState === 'running' ? 'failed' : session.turnState,
        binding: { ...session.binding, state: 'lost' },
        updatedAt: new Date().toISOString(),
      }
      await this.requireTables().sessions.put(session.sessionId, lost)
      throw new Error('remote hold generation changed; any in-flight prompt outcome is unknown and was not resent')
    }
    const reopened = attached.reopened === true
    const base: RemoteSessionView = reopened && (session.turnState === 'running' || session.turnState === 'waiting-permission')
      ? { ...session, turnState: 'failed' }
      : session
    const ready = this.withAttachment(base, attached, reopened)
    await this.requireTables().sessions.put(session.sessionId, ready)
    this.broadcastSessionView(ready)
    if (reopened) {
      await this.appendTranscript(session.sessionId, {
        transcriptId: RemoteTranscriptId(`reopen:${session.sessionId}:${attached.generation}:${attached.latestSeq}`),
        role: 'system',
        kind: 'status',
        text: '远程 Agent 已在当前会话上重新打开。先前的模型上下文可能未恢复，可以继续发送新请求。',
      })
      await this.markChildrenLost(session.sessionId)
    }
    return ready
  }

  private async renameSession(params: Record<string, JsonValue>): Promise<RemoteSessionView> {
    const sessionId = RemoteSessionId(stringField(params, 'sessionId'))
    const session = this.requireSession(sessionId)
    const title = requiredName(params, 'title')
    const updated: RemoteSessionView = { ...session, title, updatedAt: new Date().toISOString() }
    await this.requireTables().sessions.put(sessionId, updated)
    return updated
  }

  private async archiveSession(params: Record<string, JsonValue>): Promise<RemoteSessionView> {
    const sessionId = RemoteSessionId(stringField(params, 'sessionId'))
    const root = this.requireSession(sessionId)
    const archivedAt = new Date().toISOString()
    await this.archiveSessionIds(this.sessionSubtree(sessionId), archivedAt)
    return { ...root, archivedAt: root.archivedAt ?? archivedAt, updatedAt: root.archivedAt === undefined ? archivedAt : root.updatedAt }
  }

  private async unarchiveSession(params: Record<string, JsonValue>): Promise<RemoteSessionView> {
    const sessionId = RemoteSessionId(stringField(params, 'sessionId'))
    const root = this.requireSession(sessionId)
    const project = this.requireProject(root.projectId)
    if (project.hiddenAt !== undefined || this.requireHost(project.hostId).hiddenAt !== undefined) {
      throw new Error('请先恢复所属主机或项目')
    }
    const tables = this.requireTables()
    const now = new Date().toISOString()
    let restored: RemoteSessionView = root
    for (const id of this.sessionSubtree(sessionId)) {
      const session = tables.sessions.get(id)
      if (session === undefined || session.archivedAt === undefined) continue
      const { archivedAt: _archivedAt, ...without } = session
      const next = { ...without, updatedAt: now }
      await tables.sessions.put(id, next)
      if (id === sessionId) restored = next
    }
    return restored
  }

  private async deleteSession(params: Record<string, JsonValue>): Promise<RemoteSessionView> {
    const sessionId = RemoteSessionId(stringField(params, 'sessionId'))
    const root = this.requireSession(sessionId)
    const ids = [...this.sessionSubtree(sessionId)]
    await this.deleteSessionRecords(ids)
    const state = this.requireGlobal().get()
    await this.requireGlobal().set({
      ...state,
      sessionIds: state.sessionIds.filter(id => !ids.includes(id)),
    })
    return root
  }

  private sessionSubtree(sessionId: ReturnType<typeof RemoteSessionId>): Set<ReturnType<typeof RemoteSessionId>> {
    const sessions = [...this.requireTables().sessions.entries()]
    const ids = new Set<ReturnType<typeof RemoteSessionId>>([sessionId])
    for (let changed = true; changed;) {
      changed = false
      for (const [id, session] of sessions) {
        if (session.parentSessionId !== undefined && ids.has(session.parentSessionId) && !ids.has(id)) {
          ids.add(id)
          changed = true
        }
      }
    }
    return ids
  }

  private sessionIsVisible(session: RemoteSessionView): boolean {
    if (session.archivedAt !== undefined) return false
    const project = this.requireTables().projects.get(session.projectId)
    if (project === undefined || project.hiddenAt !== undefined) return false
    return this.requireTables().hosts.get(project.hostId)?.hiddenAt === undefined
  }

  private async archiveProjectSessions(
    projectId: ReturnType<typeof RemoteProjectId>,
    archivedAt: string,
  ): Promise<void> {
    const ids = this.requireGlobal().get().sessionIds.filter(id => {
      const session = this.requireTables().sessions.get(id)
      return session !== undefined && session.projectId === projectId && session.archivedAt === undefined
    })
    await this.archiveSessionIds(ids, archivedAt)
  }

  private async archiveSessionIds(
    ids: Iterable<ReturnType<typeof RemoteSessionId>>,
    archivedAt: string,
  ): Promise<void> {
    const tables = this.requireTables()
    for (const id of ids) {
      const session = tables.sessions.get(id)
      if (session === undefined || session.archivedAt !== undefined) continue
      await tables.sessions.put(id, { ...session, archivedAt, updatedAt: archivedAt })
    }
  }

  private async deleteSessionRecords(ids: readonly ReturnType<typeof RemoteSessionId>[]): Promise<void> {
    const tables = this.requireTables()
    for (const id of ids) {
      const session = tables.sessions.get(id)
      if (session !== undefined) {
        for (const [transcriptId, entry] of tables.transcript.entries()) {
          if (entry.sessionId === session.sessionId) await tables.transcript.delete(transcriptId)
        }
      }
      await tables.sessions.delete(id)
    }
  }

  private withAttachment(
    session: RemoteSessionView,
    attached: RemoteSessionAttachResult,
    skipCatchup = false,
  ): RemoteSessionView {
    return {
      ...session,
      channelState: 'open',
      binding: {
        holdId: attached.holdId,
        ...(attached.nativeSessionId === undefined ? {} : { nativeSessionId: attached.nativeSessionId }),
        generation: attached.generation,
        state: 'active',
        lastSeq: skipCatchup ? attached.latestSeq : session.binding?.lastSeq ?? 0,
      },
      updatedAt: new Date().toISOString(),
    }
  }

  private async markChildrenLost(parentSessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    const tables = this.requireTables()
    const now = new Date().toISOString()
    for (const [id, child] of tables.sessions.entries()) {
      if (child.parentSessionId !== parentSessionId || child.channelState === 'lost') continue
      const lost: RemoteSessionView = {
        ...child,
        channelState: 'lost',
        turnState: child.turnState === 'running' || child.turnState === 'waiting-permission' ? 'failed' : child.turnState,
        ...(child.binding === undefined ? {} : { binding: { ...child.binding, state: 'lost' } }),
        updatedAt: now,
      }
      await tables.sessions.put(id, lost)
      this.broadcastSessionView(lost)
    }
  }

  private async prompt(params: Record<string, JsonValue>): Promise<JsonValue> {
    const session = this.requireSession(RemoteSessionId(stringField(params, 'sessionId')))
    const binding = this.requireBinding(session)
    const clientId = stringField(params, 'clientId')
    const requestId = stringField(params, 'requestId')
    const text = stringField(params, 'text')
    const userTranscriptId = RemoteTranscriptId(`user:${session.sessionId}:${clientId}:${requestId}`)
    if (this.requireTables().transcript.get(userTranscriptId) === undefined) {
      await this.appendTranscript(session.sessionId, {
        transcriptId: userTranscriptId, role: 'user', kind: 'message', text, requestId,
      })
    }
    const nativeSessionId = binding.nativeSessionId ?? session.sessionId
    const frame = session.backend === 'dsh'
      ? { jsonrpc: '2.0', id: requestId, method: 'session/prompt', params: { sessionId: nativeSessionId, contentBlocks: [{ type: 'text', text }] } }
      : { jsonrpc: '2.0', id: requestId, method: 'session/prompt', params: { sessionId: nativeSessionId, prompt: [{ type: 'text', text }] } }
    const running: RemoteSessionView = {
      ...session, turnState: 'running', channelState: 'open', updatedAt: new Date().toISOString(),
    }
    await this.requireTables().sessions.put(session.sessionId, running)
    this.broadcastSessionView(running)
    // A running turn must keep projecting its journal even when the browser
    // disconnects or hostd push delivery is temporarily silent.
    this.ensureFollowedSync(session.sessionId)
    try {
      return await this.callSessionHostd(running, 'session.prompt', {
        sessionId: running.sessionId,
        admission: { clientId, requestId, frame },
      })
    } catch (error) {
      const failed: RemoteSessionView = {
        ...running, turnState: 'failed', updatedAt: new Date().toISOString(),
      }
      await this.requireTables().sessions.put(session.sessionId, failed)
      this.broadcastSessionView(failed)
      const failureId = RemoteTranscriptId(`delivery:${session.sessionId}:${clientId}:${requestId}`)
      if (this.requireTables().transcript.get(failureId) === undefined) {
        await this.appendTranscript(session.sessionId, {
          transcriptId: failureId,
          role: 'system',
          kind: 'status',
          text: `消息提交失败：${displayError(error)}`,
          requestId,
        })
      }
      throw error
    }
  }

  private async cancel(params: Record<string, JsonValue>): Promise<JsonValue> {
    const session = this.requireSession(RemoteSessionId(stringField(params, 'sessionId')))
    const binding = this.requireBinding(session)
    const frame = {
      jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: binding.nativeSessionId ?? session.sessionId },
    }
    // User-initiated stop must leave the waiting UI immediately. Native cancel
    // can be a no-op (Claude already end_turn) or hang on a stuck hold.
    if (session.turnState === 'running' || session.turnState === 'waiting-permission') {
      await this.concludeTurn(session, 'stopped', '用户主动停止')
    }
    try {
      return await this.callSessionHostd(session, 'session.cancel', { sessionId: session.sessionId, frame })
    } catch (error) {
      if (holdUnreachable(error)) {
        const current = this.requireTables().sessions.get(session.sessionId)
        if (current !== undefined && current.channelState === 'open') {
          const next = { ...current, channelState: 'reconnecting' as const, updatedAt: new Date().toISOString() }
          await this.requireTables().sessions.put(session.sessionId, next)
          this.broadcastSessionView(next)
        }
      }
      throw error
    }
  }

  private async permission(params: Record<string, JsonValue>): Promise<JsonValue> {
    const session = this.requireSession(RemoteSessionId(stringField(params, 'sessionId')))
    const requestId = stringField(params, 'requestId')
    const outcome = params['outcome']
    if (!isJsonValue(outcome)) throw new TypeError('outcome must be JSON')
    const id = Number.isSafeInteger(Number(requestId)) ? Number(requestId) : requestId
    const result = await this.callSessionHostd(session, 'session.permission', {
      sessionId: session.sessionId,
      frame: { jsonrpc: '2.0', id, result: this.permissionNativeResult(session.sessionId, requestId, outcome) },
    })
    this.ensureFollowedSync(session.sessionId)
    await this.catchupSessionJournal(session.sessionId)
    return result
  }

  /** Format the native JSON-RPC result for a permission grant or an elicitation form. */
  private permissionNativeResult(
    sessionId: ReturnType<typeof RemoteSessionId>,
    requestId: string,
    outcome: JsonValue,
  ): JsonValue {
    const entry = this.sessionTranscriptEntries(sessionId).findLast(item => item.requestId === requestId)
    const frame = entry?.nativeFrame
    const method = frame !== null && typeof frame === 'object' && !Array.isArray(frame) && typeof frame['method'] === 'string'
      ? frame['method'] : ''
    if (method === 'elicitation/create') {
      if (outcome !== null && typeof outcome === 'object' && !Array.isArray(outcome) && typeof outcome['action'] === 'string') {
        return outcome
      }
      if (outcome !== null && typeof outcome === 'object' && !Array.isArray(outcome) && outcome['outcome'] === 'cancelled') {
        return { action: 'cancel' }
      }
      return { action: 'accept', content: outcome }
    }
    return { outcome }
  }

  /** Pull any journal frames that arrived after a control RPC so the UI can leave waiting-permission. */
  private async catchupSessionJournal(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    const current = this.requireTables().sessions.get(sessionId)
    const binding = current?.binding
    if (current === undefined || binding === undefined || binding.state !== 'active') return
    try {
      const page = await this.callSessionHostd(current, 'events.read', {
        sessionId: current.sessionId,
        afterSeq: binding.lastSeq,
        generation: binding.generation,
        limit: MAX_JOURNAL_EVENTS_PER_SYNC,
      }) as unknown as RemoteJournalPage
      await this.applyJournalPage(current, binding, page)
    } catch (error) {
      if (holdUnreachable(error)) throw error
    }
  }

  private async syncEvents(params: Record<string, JsonValue>): Promise<RemoteAgentState> {
    const sessionId = RemoteSessionId(stringField(params, 'sessionId'))
    const session = this.requireSession(sessionId)
    const binding = this.requireBinding(session)
    let page: RemoteJournalPage
    try {
      page = await this.callSessionHostd(session, 'events.read', {
        sessionId: session.sessionId,
        afterSeq: binding.lastSeq,
        generation: binding.generation,
        limit: MAX_JOURNAL_EVENTS_PER_SYNC,
      }) as unknown as RemoteJournalPage
      await this.applyJournalPage(session, binding, page)
    } catch (error) {
      if (holdUnreachable(error) && (session.turnState === 'running' || session.turnState === 'waiting-permission')) {
        await this.concludeTurn(session, 'failed', '远程 Agent 进程已停止', 'reconnecting')
        process.stderr.write(
          `threadharbor-gateway: turn failed session=${session.sessionId} reason=hold-unreachable ${errorMessage(error)}\n`,
        )
        return this.state()
      }
      await this.requireTables().sessions.put(session.sessionId, {
        ...session, channelState: 'reconnecting', updatedAt: new Date().toISOString(),
      })
      throw error
    }
    return this.state()
  }

  /** Serialize journal projection with user-stop / failure markers for one session. */
  private async withSessionJournalApply<T>(
    sessionId: ReturnType<typeof RemoteSessionId>,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.journalApply.get(sessionId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    this.journalApply.set(sessionId, previous.then(() => gate, () => gate))
    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
    }
  }

  /** Apply one journal page (catchup or live push) to the durable projection.
   *  Shared by `syncEvents` (HTTP catchup) and the WS push listener. */
  private async applyJournalPage(
    session: RemoteSessionView,
    binding: NonNullable<RemoteSessionView['binding']>,
    page: RemoteJournalPage,
  ): Promise<number> {
    return await this.withSessionJournalApply(session.sessionId, async () => {
      const latest = this.requireTables().sessions.get(session.sessionId) ?? session
      const currentBinding = latest.binding ?? binding
      if (currentBinding.state !== 'active') return currentBinding.lastSeq
      return await this.projectJournalPage(latest, currentBinding, page)
    })
  }

  private async projectJournalPage(
    session: RemoteSessionView,
    binding: NonNullable<RemoteSessionView['binding']>,
    page: RemoteJournalPage,
  ): Promise<number> {
    if (page.generation !== binding.generation) {
      const lost: RemoteSessionView = {
        ...session, channelState: 'lost', turnState: session.turnState === 'running' ? 'failed' : session.turnState,
        binding: { ...binding, state: 'lost' }, updatedAt: new Date().toISOString(),
      }
      await this.requireTables().sessions.put(session.sessionId, lost)
      this.broadcastSessionView(lost)
      throw new Error('remote hold generation changed; in-flight outcome is unknown')
    }
    const transcript: TranscriptInput[] = []
    if (page.gap) transcript.push({
      transcriptId: RemoteTranscriptId(`gap:${session.sessionId}:${page.generation}:${page.droppedThrough}`),
      role: 'system', kind: 'status', text: `远程日志在序号 ${page.droppedThrough} 前已截断`,
    })
    let turnState = session.turnState
    const events = page.events
      .filter(event => event.seq > binding.lastSeq)
      .slice(0, MAX_JOURNAL_EVENTS_PER_SYNC)
    const suppressNativeTranscript = session.turnState === 'stopped'
    for (const event of events) {
      const child = nativeChildUpdate(event.frame)
      if (child !== undefined) await this.upsertNativeChild(session, child)
      if (suppressNativeTranscript) continue
      const targetSessionId = nativeFrameSessionId(event.frame)
      const nativeSessionId = binding.nativeSessionId ?? session.sessionId
      if (targetSessionId !== nativeSessionId
        && (targetSessionId !== undefined || session.parentSessionId !== undefined)) continue
      for (const [fragmentIndex, fragment] of projectNativeFrame(session.backend, event.frame).entries()) {
        const previous = transcript.at(-1)
        if (fragment.role === 'assistant' && previous?.role === 'assistant'
          && previous.kind === fragment.kind && previous.requestId === undefined) {
          transcript[transcript.length - 1] = { ...previous, text: `${previous.text}${fragment.text}` }
        } else {
          transcript.push({
            transcriptId: RemoteTranscriptId(`native:${session.sessionId}:${page.generation}:${event.seq}:${fragmentIndex}`),
            role: fragment.role,
            kind: fragment.kind,
            text: fragment.text,
            ...(fragment.role === 'assistant' ? {} : { nativeFrame: event.frame }),
            ...(fragment.requestId === undefined ? {} : { requestId: fragment.requestId }),
          })
        }
        if (fragment.turnState !== undefined) turnState = fragment.turnState
      }
    }
    await this.appendTranscriptBatch(session.sessionId, transcript)
    const processedThrough = events.at(-1)?.seq ?? binding.lastSeq
    const latest = this.requireTables().sessions.get(session.sessionId) ?? session
    if (latest.turnState === 'stopped' && turnState !== 'failed') {
      // User-initiated stop is a durable marker until the next prompt.
      // A later native end_turn must not rewrite it back to idle/running.
      turnState = 'stopped'
    } else if (latest.turnState === 'failed'
      && (turnState === 'running' || turnState === 'waiting-permission')) {
      // Hold-unreachable / transport failure is terminal until the next prompt.
      // Idle is not: Claude may emit prompt_complete and then AskUserQuestion.
      turnState = 'failed'
    }
    const updated: RemoteSessionView = {
      ...latest,
      channelState: latest.channelState === 'lost' ? 'lost' : 'open',
      turnState,
      binding: { ...binding, lastSeq: processedThrough },
      updatedAt: new Date().toISOString(),
    }
    await this.requireTables().sessions.put(session.sessionId, updated)
    if (turnState !== session.turnState || processedThrough !== binding.lastSeq) {
      this.broadcastSessionView(updated)
    }
    return processedThrough
  }

  private async upsertNativeChild(parent: RemoteSessionView, update: NativeChildUpdate): Promise<void> {
    const parentNativeSessionId = parent.binding?.nativeSessionId ?? parent.sessionId
    if (update.parentNativeSessionId !== undefined && update.parentNativeSessionId !== parentNativeSessionId) return
    const tables = this.requireTables()
    const existing = [...tables.sessions.entries()].find(([, candidate]) =>
      candidate.projectId === parent.projectId && candidate.binding?.nativeSessionId === update.nativeSessionId)
    if (existing !== undefined) {
      const [id, child] = existing
      if (child.parentSessionId !== parent.sessionId || child.backend !== parent.backend) return
      await tables.sessions.put(id, {
        ...child,
        title: child.title === '子任务' ? update.title : child.title,
        channelState: 'open',
        turnState: update.finished ? update.failed ? 'failed' : 'idle' : 'running',
        updatedAt: new Date().toISOString(),
      })
      return
    }
    const sessionId = RemoteSessionId(randomUUID())
    const project = this.requireProject(parent.projectId)
    const host = this.requireHost(project.hostId)
    const attached = await this.callHostd(host, 'session.adopt', {
      parentSessionId: parent.sessionId,
      childSessionId: sessionId,
      nativeSessionId: update.nativeSessionId,
    }) as unknown as RemoteSessionAttachResult
    const now = new Date().toISOString()
    const child: RemoteSessionView = {
      sessionId,
      projectId: parent.projectId,
      parentSessionId: parent.sessionId,
      title: update.title,
      backend: parent.backend,
      channelState: 'open',
      turnState: update.finished ? update.failed ? 'failed' : 'idle' : 'running',
      binding: {
        holdId: attached.holdId,
        nativeSessionId: update.nativeSessionId,
        generation: attached.generation,
        state: 'active',
        lastSeq: 0,
      },
      createdAt: now,
      updatedAt: now,
    }
    await tables.sessions.put(sessionId, child)
    const state = this.requireGlobal().get()
    await this.requireGlobal().set({ ...state, sessionIds: [...state.sessionIds, sessionId] })
  }

  private async concludeTurn(
    session: RemoteSessionView,
    turnState: 'idle' | 'stopped' | 'failed',
    text: string,
    channelState?: RemoteChannelState,
  ): Promise<void> {
    await this.withSessionJournalApply(session.sessionId, async () => {
      const current = this.requireTables().sessions.get(session.sessionId) ?? session
      if (current.turnState !== 'running' && current.turnState !== 'waiting-permission') return
      const next: RemoteSessionView = {
        ...current,
        turnState,
        channelState: channelState ?? current.channelState,
        updatedAt: new Date().toISOString(),
      }
      await this.requireTables().sessions.put(session.sessionId, next)
      this.broadcastSessionView(next)
      const transcriptId = RemoteTranscriptId(`turn:${session.sessionId}:${turnState}:${current.binding?.generation ?? 'none'}:${current.binding?.lastSeq ?? 0}`)
      if (this.requireTables().transcript.get(transcriptId) === undefined) {
        await this.appendTranscript(session.sessionId, {
          transcriptId, role: 'system', kind: 'status', text,
        })
      }
    })
  }

  private withTranscriptHead(
    session: RemoteSessionView,
    state = this.requireGlobal().get(),
  ): RemoteSessionView {
    return { ...session, latestTranscriptSeq: (state.nextTranscriptSeq[session.sessionId] ?? 0) - 1 }
  }

  private broadcastSessionView(session: RemoteSessionView): void {
    this.wsBroadcaster.broadcast({ type: 'session.view.changed', session: this.withTranscriptHead(session) })
  }

  private sessionTranscriptEntries(sessionId: ReturnType<typeof RemoteSessionId>): RemoteTranscriptEntry[] {
    return [...this.requireTables().transcript.entries()]
      .map(([, entry]) => entry)
      .filter(entry => entry.sessionId === sessionId)
      .sort((left, right) => left.seq - right.seq)
  }

  private readTranscript(params: Record<string, JsonValue>): RemoteTranscriptPage {
    const sessionId = RemoteSessionId(stringField(params, 'sessionId'))
    this.requireSession(sessionId)
    const afterSeq = optionalNonNegativeInteger(params, 'afterSeq')
    const beforeSeq = optionalNonNegativeInteger(params, 'beforeSeq')
    if (afterSeq !== undefined && beforeSeq !== undefined) {
      throw new TypeError('transcript.read accepts afterSeq or beforeSeq, not both')
    }
    const requested = optionalNonNegativeInteger(params, 'limit') ?? REMOTE_TRANSCRIPT_PAGE_SIZE
    const limit = Math.min(Math.max(requested, 1), REMOTE_TRANSCRIPT_PAGE_MAX)
    const entries = this.sessionTranscriptEntries(sessionId)
    const latestSeq = entries.at(-1)?.seq ?? -1
    const page = afterSeq !== undefined
      ? entries.filter(entry => entry.seq > afterSeq).slice(0, limit)
      : beforeSeq !== undefined
        ? entries.filter(entry => entry.seq < beforeSeq).slice(-limit)
        : entries.slice(-limit)
    const remaining = afterSeq !== undefined
      ? entries.filter(entry => entry.seq > afterSeq).length
      : beforeSeq !== undefined
        ? entries.filter(entry => entry.seq < beforeSeq).length
        : entries.length
    return {
      sessionId,
      entries: page,
      afterSeq: afterSeq ?? -1,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      fromSeq: page.at(0)?.seq ?? -1,
      toSeq: page.at(-1)?.seq ?? -1,
      latestSeq,
      hasMore: remaining > page.length,
    }
  }

  private async listDirectory(params: Record<string, JsonValue>): Promise<RemoteDirectoryListing> {
    const host = this.requireHost(RemoteHostId(stringField(params, 'hostId')))
    const path = optionalString(params, 'path')
    return await this.callHostd(host, 'fs.list', path === undefined ? {} : { path }) as unknown as RemoteDirectoryListing
  }

  private async appendTranscript(
    sessionId: ReturnType<typeof RemoteSessionId>,
    input: TranscriptInput,
  ): Promise<RemoteTranscriptEntry> {
    const [entry] = await this.appendTranscriptBatch(sessionId, [input])
    if (entry === undefined) throw new Error('transcript append produced no entry')
    return entry
  }

  private async appendTranscriptBatch(
    sessionId: ReturnType<typeof RemoteSessionId>,
    inputs: readonly TranscriptInput[],
  ): Promise<readonly RemoteTranscriptEntry[]> {
    if (inputs.length === 0) return []
    const tables = this.requireTables()
    const novel = inputs.filter(input => tables.transcript.get(input.transcriptId) === undefined)
    if (novel.length === 0) return []
    const global = this.requireGlobal()
    const state = global.get()
    const firstSeq = state.nextTranscriptSeq[sessionId] ?? 0
    const createdAt = new Date().toISOString()
    const entries = novel.map((input, index): RemoteTranscriptEntry => ({
      ...input, sessionId, seq: firstSeq + index, createdAt,
    }))
    for (const entry of entries) await tables.transcript.put(entry.transcriptId, entry)
    const excess = [...this.requireTables().transcript.entries()]
      .filter(([, candidate]) => candidate.sessionId === sessionId)
      .sort((left, right) => left[1].seq - right[1].seq)
      .slice(0, -this.config.maxTranscriptEntriesPerSession)
    for (const [id] of excess) await this.requireTables().transcript.delete(id)
    await global.set({
      ...state,
      nextTranscriptSeq: { ...state.nextTranscriptSeq, [sessionId]: firstSeq + entries.length },
    })
    this.wsBroadcaster.broadcastTranscriptBatch(sessionId, entries)
    return entries
  }

  private async handleFollow(params: Record<string, JsonValue>): Promise<JsonValue> {
    const browserId = stringField(params, 'browserId')
    const sessionId = RemoteSessionId(stringField(params, 'sessionId'))
    this.wsBroadcaster.follow(browserId, sessionId)
    const starting = this.inflightStarts.get(sessionId)
    if (starting !== undefined) await starting.catch(() => undefined)
    const session = this.requireSession(sessionId)
    if (session.channelState !== 'connecting'
      && (session.binding?.state !== 'active'
        || session.channelState === 'reconnecting'
        || session.channelState === 'lost')) {
      try { await this.attachSession({ sessionId }) } catch { /* follow loop will retry */ }
    }
    this.ensureFollowedSync(sessionId)
    const current = this.requireTables().sessions.get(sessionId)
    const fromSeq = current?.binding?.lastSeq ?? 0
    this.wsBroadcaster.broadcast({ type: 'session.followed', sessionId, fromSeq })
    return { sessionId, fromSeq }
  }

  private ensureFollowedSync(sessionId: ReturnType<typeof RemoteSessionId>): void {
    if (this.followedSyncing.has(sessionId)) return
    this.followedSyncing.add(sessionId)
    void this.runFollowedLoop(sessionId)
      .catch(() => { /* a later follow or prompt restarts projection */ })
      .finally(() => { this.followedSyncing.delete(sessionId) })
  }

  private sessionNeedsSync(sessionId: ReturnType<typeof RemoteSessionId>): boolean {
    if (this.syncStopped) return false
    if (this.wsBroadcaster.hasFollowers(sessionId)) return true
    const turnState = this.requireTables().sessions.get(sessionId)?.turnState
    return turnState === 'running' || turnState === 'waiting-permission'
  }

  private async runFollowedLoop(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    while (this.sessionNeedsSync(sessionId)) {
      const session = this.requireSession(sessionId)
      const binding = this.requireBinding(session)
      const project = this.requireProject(session.projectId)
      const host = this.requireHost(project.hostId)

      // One-time catchup via the WS-multiplexed `events.read`. After this we
      // stay subscribed to hostd's push until the session is unbound or the
      // host reports a generation gap — no more per-second HTTP polling.
      try {
        const catchup = await this.callSessionHostd(session, 'events.read', {
          sessionId: session.sessionId,
          afterSeq: binding.lastSeq,
          generation: binding.generation,
          limit: MAX_JOURNAL_EVENTS_PER_SYNC,
        }) as unknown as RemoteJournalPage
        await this.applyJournalPage(session, binding, catchup)
        if (catchup.events.length >= MAX_JOURNAL_EVENTS_PER_SYNC) continue
      } catch (error) {
        if (holdUnreachable(error)) {
          await this.concludeTurn(session, 'failed', '远程 Agent 进程已停止', 'reconnecting')
          const current = this.requireTables().sessions.get(sessionId) ?? session
          if (current.channelState === 'open') {
            const reconnecting: RemoteSessionView = {
              ...current, channelState: 'reconnecting', updatedAt: new Date().toISOString(),
            }
            await this.requireTables().sessions.put(sessionId, reconnecting)
            this.broadcastSessionView(reconnecting)
          }
          process.stderr.write(
            `threadharbor-gateway: turn failed session=${sessionId} reason=hold-unreachable ${errorMessage(error)}\n`,
          )
          break
        }
      }

      if (!this.sessionNeedsSync(sessionId)) break

      const live = this.requireSession(sessionId)
      const liveBinding = this.requireBinding(live)

      const queue: RemoteJournalPage[] = []
      let flushing = false
      let lost = false
      const flushQueue = async (): Promise<void> => {
        if (flushing) return
        flushing = true
        try {
          while (queue.length > 0) {
            const page = queue.shift()!
            const current = this.requireTables().sessions.get(sessionId)
            if (current === undefined) return
            const cb = current.binding
            if (cb === undefined || cb.state !== 'active') continue
            try { await this.applyJournalPage(current, cb, page) } catch { /* swallow */ }
          }
        } finally {
          flushing = false
        }
      }

      const unsubscribe = this.hostdConnections.subscribe(
        host,
        sessionId,
        liveBinding.generation,
        liveBinding.lastSeq,
        (event) => {
          if (event.type === 'journal.page') {
            queue.push(event.page)
            void flushQueue()
          } else if (event.type === 'journal.gap') {
            const current = this.requireTables().sessions.get(sessionId)
            if (current === undefined) return
            const cb = current.binding
            if (cb === undefined) return
            const next: RemoteSessionView = {
              ...current,
              channelState: 'lost',
              turnState: current.turnState === 'running' ? 'failed' : current.turnState,
              binding: { ...cb, state: 'lost' },
              updatedAt: new Date().toISOString(),
            }
            void this.requireTables().sessions.put(sessionId, next)
            this.broadcastSessionView(next)
            lost = true
          }
        },
      )

      try {
        // Stay subscribed until the session stops needing projection, a gap
        // is reported, or hostd's WS gives up. The tick is local-only — no
        // HTTP traffic — so it just wakes us to re-evaluate session state.
        while (this.sessionNeedsSync(sessionId) && !lost) {
          await new Promise<void>((resolveWait) => {
            const timer = setTimeout(resolveWait, this.config.pollIntervalMs)
            timer.unref?.()
          })
          await flushQueue()
          const waiting = this.requireTables().sessions.get(sessionId)
          // Live journal.page already covers a running turn. Re-reading the
          // journal here races the push path and re-projects the same seqs.
          // waiting-permission still catchups because some ACP adapters stall
          // the wait-page until the permission RPC returns.
          if (waiting?.turnState === 'waiting-permission') {
            try {
              await this.catchupSessionJournal(sessionId)
            } catch (error) {
              if (holdUnreachable(error)) {
                await this.concludeTurn(waiting, 'failed', '远程 Agent 进程已停止', 'reconnecting')
                process.stderr.write(
                  `threadharbor-gateway: turn failed session=${sessionId} reason=hold-unreachable ${errorMessage(error)}\n`,
                )
                lost = true
              }
            }
          }
        }
      } finally {
        unsubscribe()
      }

      if (lost) {
        // Mark the session as recoverable once hostd reconnects; the next
        // prompt or follow will trigger another `runFollowedLoop` that
        // re-catchups against the fresh generation.
        break
      }
    }
  }

  private async handleUnfollow(params: Record<string, JsonValue>): Promise<JsonValue> {
    const browserId = stringField(params, 'browserId')
    const sessionId = RemoteSessionId(stringField(params, 'sessionId'))
    this.wsBroadcaster.unfollow(browserId, sessionId)
    this.wsBroadcaster.broadcast({ type: 'session.unfollowed', sessionId })
    return { sessionId }
  }

  private async handleHello(params: Record<string, JsonValue>): Promise<JsonValue> {
    const browserId = stringField(params, 'browserId')
    const lastSeen = jsonObject(params['lastSeenSeqs'] ?? {}, 'lastSeenSeqs')
    const result: { readonly sessionId: ReturnType<typeof RemoteSessionId>; readonly fromSeq: number }[] = []
    for (const [key, raw] of Object.entries(lastSeen)) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
      const sessionId = RemoteSessionId(key)
      const session = this.requireTables().sessions.get(sessionId)
      const current = session?.binding?.lastSeq ?? 0
      if (current > raw) result.push({ sessionId, fromSeq: raw })
    }
    return { browserId, missed: result as unknown as JsonValue }
  }

  private async callSessionHostd(session: RemoteSessionView, method: RemoteControlRequest['method'], params: Record<string, JsonValue>): Promise<JsonValue> {
    const project = this.requireProject(session.projectId)
    return await this.callHostd(this.requireHost(project.hostId), method, params)
  }

  private async callHostd(
    host: RemoteHostView,
    method: RemoteControlRequest['method'],
    params: Record<string, JsonValue>,
    timeoutMs?: number,
  ): Promise<JsonValue> {
    return await this.hostdConnections.request(host, method, params, timeoutMs)
  }

  private requireHost(id: ReturnType<typeof RemoteHostId>): RemoteHostView {
    return this.requireRecord(this.requireTables().hosts, id, 'host')
  }

  private requireProject(id: ReturnType<typeof RemoteProjectId>): RemoteProjectView {
    return this.requireRecord(this.requireTables().projects, id, 'project')
  }

  private requireSession(id: ReturnType<typeof RemoteSessionId>): RemoteSessionView {
    return this.requireRecord(this.requireTables().sessions, id, 'session')
  }

  private requireBinding(session: RemoteSessionView): NonNullable<RemoteSessionView['binding']> {
    if (session.binding === undefined || session.binding.state !== 'active') throw new Error(`session ${session.sessionId} has no active remote binding`)
    return session.binding
  }

  private requireRecord<K extends string, V>(table: KvTable<K, V>, id: K, kind: string): V {
    const value = table.get(id)
    if (value === undefined) throw new Error(`unknown ${kind} ${id}`)
    return value
  }

  private requireTables(): Tables {
    if (this.tables === undefined) throw new Error('remote-agent catalog is not initialized')
    return this.tables
  }

  private requireGlobal(): DomainGlobal<RemoteAgentCatalogState> {
    if (this.global === undefined) throw new Error('remote-agent catalog is not initialized')
    return this.global
  }

  private validateCatalog(): void {
    const state = this.requireGlobal().get()
    const tables = this.requireTables()
    for (const id of state.hostIds) this.requireRecord(tables.hosts, id, 'host')
    for (const id of state.projectIds) {
      const project = this.requireRecord(tables.projects, id, 'project')
      this.requireRecord(tables.hosts, project.hostId, 'host')
    }
    for (const id of state.sessionIds) {
      const session = this.requireRecord(tables.sessions, id, 'session')
      this.requireRecord(tables.projects, session.projectId, 'project')
      if (session.parentSessionId === undefined) continue
      const parent = this.requireRecord(tables.sessions, session.parentSessionId, 'parent session')
      if (parent.projectId !== session.projectId || parent.backend !== session.backend) {
        throw new Error(`session ${id} violates inherited project/backend ownership`)
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operationTail.then(operation, operation)
    this.operationTail = current.then(() => {}, () => {})
    return current
  }
}

export default RemoteAgentGateway
