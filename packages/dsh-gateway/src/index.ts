/** Web-machine remote-agent catalog, hostd proxy, and transcript projection. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  REMOTE_AGENT_GATEWAY_PATH,
  REMOTE_AGENT_HOSTD_PATH,
  RemoteHostId,
  RemoteProjectId,
  RemoteSessionId,
  RemoteTranscriptId,
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
  type RemoteHostView,
  type RemoteJournalPage,
  type RemoteProjectView,
  type RemoteSessionAttachResult,
  type RemoteSessionView,
  type RemoteTranscriptEntry,
} from '@threadharbor/protocol'
import { projectNativeFrame } from './projection.ts'
import { remoteAgentDomainSpec, type RemoteAgentCatalogState } from './spec.ts'
import { SshManager } from './ssh-manager.ts'

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

function localPath(value: string): string {
  return resolve(value.startsWith('~/') ? `${homedir()}${value.slice(1)}` : value)
}

function hostdArtifactDirectory(): string {
  return fileURLToPath(new URL('../../hostd/lib/', import.meta.url))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  })

  private tables?: Tables
  private global?: DomainGlobal<RemoteAgentCatalogState>
  private operationTail: Promise<void> = Promise.resolve()
  private readonly sshManager: SshManager

  /** @param ctx - Host context carrying storage-domain and webserver. @param config - validated bounds. */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'remoteAgentGateway')
    this.sshManager = new SshManager({
      knownHostsPath: localPath(config.sshKnownHostsPath),
      connectTimeoutMs: config.sshConnectTimeoutMs,
      installTimeoutMs: config.sshInstallTimeoutMs,
      hostdRemotePort: config.hostdRemotePort,
      hostdArtifactDirectory: hostdArtifactDirectory(),
    })
    ctx.effect(() => () => { this.sshManager.close() }, 'threadharbor.sshClose')
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
  }

  /** Complete current browser projection in durable order.
   * @returns the current catalog and transcript projection.
   */
  state(): RemoteAgentState {
    const state = this.requireGlobal().get()
    const tables = this.requireTables()
    return {
      pollIntervalMs: this.config.pollIntervalMs,
      hosts: state.hostIds.map(id => this.requireRecord(tables.hosts, id, 'host')),
      projects: state.projectIds.map(id => this.requireRecord(tables.projects, id, 'project')),
      sessions: state.sessionIds.map(id => this.requireRecord(tables.sessions, id, 'session')),
      transcript: [...tables.transcript.entries()].map(([, entry]) => entry)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq),
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
      case 'host.ssh.inspect':
        return await this.sshManager.inspect(this.sshManager.parseInspectionConfig(request.params['ssh'])) as unknown as JsonValue
      case 'host.ssh.deploy':
        return await this.enqueue(() => this.deploySshHost(request.params)) as unknown as JsonValue
      case 'agent.install.plan':
      case 'agent.install':
      case 'auth.start':
      case 'auth.status':
      case 'auth.respond':
      case 'auth.cancel':
        return await this.proxyHostOperation(request.method, request.params)
      case 'inventory':
        return await this.enqueue(() => this.refreshInventory(request.params)) as unknown as JsonValue
      case 'project.create':
        return await this.enqueue(() => this.createProject(request.params)) as unknown as JsonValue
      case 'session.start':
        return await this.enqueue(() => this.startSession(request.params)) as unknown as JsonValue
      case 'session.attach':
        return await this.enqueue(() => this.attachSession(request.params)) as unknown as JsonValue
      case 'session.prompt':
        return await this.enqueue(() => this.prompt(request.params))
      case 'session.cancel':
        return await this.enqueue(() => this.cancel(request.params))
      case 'session.permission':
        return await this.enqueue(() => this.permission(request.params))
      case 'events.read':
        return await this.enqueue(() => this.syncEvents(request.params)) as unknown as JsonValue
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
    const title = stringField(params, 'title')
    const tables = this.requireTables()
    const duplicate = [...tables.hosts.entries()].find(([, host]) => host.endpoint === endpoint)
    if (duplicate !== undefined) return duplicate[1]
    const hostId = RemoteHostId(randomUUID())
    const now = new Date().toISOString()
    const host: RemoteHostView = { hostId, title, endpoint, createdAt: now, updatedAt: now }
    await tables.hosts.put(hostId, host)
    const state = this.requireGlobal().get()
    await this.requireGlobal().set({ ...state, hostIds: [...state.hostIds, hostId] })
    return await this.refreshHostInventory(host)
  }

  private async deploySshHost(params: Record<string, JsonValue>): Promise<RemoteHostView> {
    if (params['confirm'] !== true) throw new Error('hostd deployment requires confirm: true')
    const title = stringField(params, 'title')
    const ssh = this.sshManager.parseApprovedConfig(params['ssh'])
    const tables = this.requireTables()
    const duplicate = [...tables.hosts.entries()].find(([, host]) =>
      host.ssh?.target === ssh.target && host.ssh.port === ssh.port && host.ssh.user === ssh.user)
    if (duplicate !== undefined) return await this.refreshHostInventory(duplicate[1])
    const endpoint = await this.sshManager.deploy(ssh)
    const hostId = RemoteHostId(randomUUID())
    const now = new Date().toISOString()
    const host: RemoteHostView = { hostId, title, endpoint, ssh, createdAt: now, updatedAt: now }
    await tables.hosts.put(hostId, host)
    const state = this.requireGlobal().get()
    await this.requireGlobal().set({ ...state, hostIds: [...state.hostIds, hostId] })
    return await this.refreshHostInventory(host)
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

  private async refreshHostInventory(host: RemoteHostView): Promise<RemoteHostView> {
    try {
      const inventory = await this.callHostd(host, 'inventory', {}) as unknown as RemoteHostInventory
      const { inventoryError: _inventoryError, ...current } = host
      const updated: RemoteHostView = { ...current, inventory, updatedAt: new Date().toISOString() }
      await this.requireTables().hosts.put(host.hostId, updated)
      return updated
    } catch (error) {
      const updated: RemoteHostView = {
        ...host, inventoryError: errorMessage(error), updatedAt: new Date().toISOString(),
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

  private async startSession(params: Record<string, JsonValue>): Promise<RemoteSessionView> {
    const tables = this.requireTables()
    const project = this.requireProject(RemoteProjectId(stringField(params, 'projectId')))
    const host = this.requireHost(project.hostId)
    const parentIdValue = optionalString(params, 'parentSessionId')
    const parent = parentIdValue === undefined ? undefined : this.requireSession(RemoteSessionId(parentIdValue))
    if (parent !== undefined && parent.projectId !== project.projectId) throw new Error('child session must use its parent project')
    const requestedBackend = params['backend'] === undefined ? undefined : remoteAgentBackend(params['backend'])
    const backend = parent?.backend ?? requestedBackend
    if (backend === undefined) throw new Error('root session.start requires backend')
    if (parent !== undefined && requestedBackend !== undefined && requestedBackend !== parent.backend) {
      throw new Error('child session backend is immutable and must equal its parent backend')
    }
    const refreshed = await this.refreshHostInventory(host)
    const available = refreshed.inventory?.backends.find(entry => entry.backend === backend)
    if (!available?.installed || !available.authenticated) {
      throw new Error(`backend ${backend} is not installed and authenticated on host ${host.title}`)
    }
    if (!available.sessionCapable) throw new Error(`backend ${backend} has no configured ThreadHarbor session adapter`)
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
    try {
      const attached = await this.callHostd(host, 'session.start', {
        sessionId,
        backend,
        cwd: project.cwd,
        ...(parent?.binding?.nativeSessionId === undefined ? {} : { parentNativeSessionId: parent.binding.nativeSessionId }),
      }) as unknown as RemoteSessionAttachResult
      const ready = this.withAttachment(session, attached)
      await tables.sessions.put(sessionId, ready)
      return ready
    } catch (error) {
      await tables.sessions.put(sessionId, {
        ...session, channelState: 'lost', turnState: 'failed', updatedAt: new Date().toISOString(),
      })
      throw error
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
      throw error
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
    const ready = this.withAttachment(session, attached)
    await this.requireTables().sessions.put(session.sessionId, ready)
    return ready
  }

  private withAttachment(session: RemoteSessionView, attached: RemoteSessionAttachResult): RemoteSessionView {
    return {
      ...session,
      channelState: 'open',
      binding: {
        holdId: attached.holdId,
        ...(attached.nativeSessionId === undefined ? {} : { nativeSessionId: attached.nativeSessionId }),
        generation: attached.generation,
        state: 'active',
        lastSeq: session.binding?.lastSeq ?? 0,
      },
      updatedAt: new Date().toISOString(),
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
    return await this.callSessionHostd(running, 'session.prompt', {
      sessionId: running.sessionId,
      admission: { clientId, requestId, frame },
    })
  }

  private async cancel(params: Record<string, JsonValue>): Promise<JsonValue> {
    const session = this.requireSession(RemoteSessionId(stringField(params, 'sessionId')))
    const binding = this.requireBinding(session)
    const frame = {
      jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: binding.nativeSessionId ?? session.sessionId },
    }
    return await this.callSessionHostd(session, 'session.cancel', { sessionId: session.sessionId, frame })
  }

  private async permission(params: Record<string, JsonValue>): Promise<JsonValue> {
    const session = this.requireSession(RemoteSessionId(stringField(params, 'sessionId')))
    const requestId = stringField(params, 'requestId')
    const outcome = params['outcome']
    if (!isJsonValue(outcome)) throw new TypeError('outcome must be JSON')
    const id = Number.isSafeInteger(Number(requestId)) ? Number(requestId) : requestId
    return await this.callSessionHostd(session, 'session.permission', {
      sessionId: session.sessionId,
      frame: { jsonrpc: '2.0', id, result: { outcome } },
    })
  }

  private async syncEvents(params: Record<string, JsonValue>): Promise<RemoteAgentState> {
    const session = this.requireSession(RemoteSessionId(stringField(params, 'sessionId')))
    const binding = this.requireBinding(session)
    let page: RemoteJournalPage
    try {
      page = await this.callSessionHostd(session, 'events.read', {
        sessionId: session.sessionId,
        afterSeq: binding.lastSeq,
        generation: binding.generation,
      }) as unknown as RemoteJournalPage
    } catch (error) {
      await this.requireTables().sessions.put(session.sessionId, {
        ...session, channelState: 'reconnecting', updatedAt: new Date().toISOString(),
      })
      throw error
    }
    if (page.generation !== binding.generation) {
      await this.requireTables().sessions.put(session.sessionId, {
        ...session, channelState: 'lost', turnState: session.turnState === 'running' ? 'failed' : session.turnState,
        binding: { ...binding, state: 'lost' }, updatedAt: new Date().toISOString(),
      })
      throw new Error('remote hold generation changed; in-flight outcome is unknown')
    }
    if (page.gap) {
      await this.appendTranscript(session.sessionId, {
        transcriptId: RemoteTranscriptId(randomUUID()), role: 'system', kind: 'status',
        text: `远程日志在序号 ${page.droppedThrough} 前已截断`,
      })
    }
    let turnState = session.turnState
    for (const event of page.events) {
      const child = nativeChildUpdate(event.frame)
      if (child !== undefined) await this.upsertNativeChild(session, child)
      const targetSessionId = nativeFrameSessionId(event.frame)
      const nativeSessionId = binding.nativeSessionId ?? session.sessionId
      if (targetSessionId !== nativeSessionId
        && (targetSessionId !== undefined || session.parentSessionId !== undefined)) continue
      for (const fragment of projectNativeFrame(session.backend, event.frame)) {
        await this.appendTranscript(session.sessionId, {
          transcriptId: RemoteTranscriptId(randomUUID()),
          role: fragment.role,
          kind: fragment.kind,
          text: fragment.text,
          nativeFrame: event.frame,
          ...(fragment.requestId === undefined ? {} : { requestId: fragment.requestId }),
        })
        if (fragment.turnState !== undefined) turnState = fragment.turnState
      }
    }
    await this.requireTables().sessions.put(session.sessionId, {
      ...session,
      channelState: 'open',
      turnState,
      binding: { ...binding, lastSeq: page.latestSeq },
      updatedAt: new Date().toISOString(),
    })
    return this.state()
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

  private async listDirectory(params: Record<string, JsonValue>): Promise<RemoteDirectoryListing> {
    const host = this.requireHost(RemoteHostId(stringField(params, 'hostId')))
    return await this.callHostd(host, 'fs.list', { path: stringField(params, 'path') }) as unknown as RemoteDirectoryListing
  }

  private async appendTranscript(
    sessionId: ReturnType<typeof RemoteSessionId>,
    input: Omit<RemoteTranscriptEntry, 'sessionId' | 'seq' | 'createdAt'>,
  ): Promise<RemoteTranscriptEntry> {
    const global = this.requireGlobal()
    const state = global.get()
    const seq = state.nextTranscriptSeq[sessionId] ?? 0
    const entry: RemoteTranscriptEntry = {
      ...input, sessionId, seq, createdAt: new Date().toISOString(),
    }
    await this.requireTables().transcript.put(entry.transcriptId, entry)
    const excess = [...this.requireTables().transcript.entries()]
      .filter(([, candidate]) => candidate.sessionId === sessionId)
      .sort((left, right) => left[1].seq - right[1].seq)
      .slice(0, -this.config.maxTranscriptEntriesPerSession)
    for (const [id] of excess) await this.requireTables().transcript.delete(id)
    await global.set({
      ...state,
      nextTranscriptSeq: { ...state.nextTranscriptSeq, [sessionId]: seq + 1 },
    })
    return entry
  }

  private async callSessionHostd(session: RemoteSessionView, method: RemoteControlRequest['method'], params: Record<string, JsonValue>): Promise<JsonValue> {
    const project = this.requireProject(session.projectId)
    return await this.callHostd(this.requireHost(project.hostId), method, params)
  }

  private async callHostd(host: RemoteHostView, method: RemoteControlRequest['method'], params: Record<string, JsonValue>): Promise<JsonValue> {
    if (host.ssh !== undefined) await this.sshManager.ensureTunnel(host.ssh, host.endpoint)
    const id = randomUUID()
    const response = await fetch(`${host.endpoint}${REMOTE_AGENT_HOSTD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, method, params }),
      signal: AbortSignal.timeout(this.config.hostdRequestTimeoutMs),
    })
    const raw: unknown = await response.json()
    const record = jsonObject(raw, 'hostd response')
    if (record['id'] !== id) throw new Error('hostd response id did not match request')
    if (record['ok'] !== true) {
      const error = jsonObject(record['error'], 'hostd error')
      throw new Error(stringField(error, 'message'))
    }
    const result = record['result']
    if (!isJsonValue(result)) throw new Error('hostd result was not JSON')
    return result
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
