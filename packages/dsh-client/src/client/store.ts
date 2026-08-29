/** React-free browser object layer for the remote-agent control endpoint. */

import {
  REMOTE_AGENT_BACKENDS,
  REMOTE_AGENT_GATEWAY_PATH,
  RemoteHoldId,
  RemoteHostId,
  RemoteProjectId,
  RemoteSessionId,
  RemoteTranscriptId,
  RemoteAuthFlowId,
  jsonObject,
  remoteAgentBackend,
  remoteAgentConfigBackend,
  stringField,
  type JsonValue,
  type RemoteAgentBackend,
  type RemoteAgentConfigBackend,
  type RemoteAgentConfigDocument,
  type RemoteAgentState,
  type RemoteAuthChallenge,
  type RemoteBackendInventory,
  type RemoteDirectoryListing,
  type RemoteHostInventory,
  type RemoteHostView,
  type RemoteInstallPlan,
  type RemoteProjectView,
  type RemoteSessionView,
  type RemoteTranscriptEntry,
  type RemoteSshConfig,
  type RemoteSshInspection,
} from '@threadharbor/protocol'

/** Browser interaction snapshot. */
export interface RemoteAgentSnapshot {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly state: RemoteAgentState
  readonly currentSessionId?: ReturnType<typeof RemoteSessionId>
  readonly pending: boolean
  readonly error?: string
}

const EMPTY_STATE: RemoteAgentState = {
  pollIntervalMs: 1000,
  hosts: [],
  projects: [],
  sessions: [],
  transcript: [],
}

function withoutError(snapshot: RemoteAgentSnapshot): RemoteAgentSnapshot {
  const { error: _error, ...rest } = snapshot
  return rest
}

function array(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value
}

function booleanField(record: Record<string, JsonValue>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`)
  return value
}

function integerField(record: Record<string, JsonValue>, key: string): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${key} must be a non-negative integer`)
  return value as number
}

function optionalText(record: Record<string, JsonValue>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  return value
}

function optionalHttpsUrl(record: Record<string, JsonValue>, key: string): string | undefined {
  const value = optionalText(record, key)
  if (value === undefined) return undefined
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new TypeError(`${key} must be an HTTPS URL`)
  return url.href
}

function parseInventory(value: JsonValue | undefined): RemoteHostInventory | undefined {
  if (value === undefined) return undefined
  const record = jsonObject(value, 'inventory')
  const backends: RemoteBackendInventory[] = array(record['backends'], 'inventory.backends').map((entry) => {
    const backend = jsonObject(entry, 'inventory backend')
    const detail = optionalText(backend, 'detail')
    return {
      backend: remoteAgentBackend(backend['backend']),
      installed: booleanField(backend, 'installed'),
      authenticated: booleanField(backend, 'authenticated'),
      running: booleanField(backend, 'running'),
      sessionCapable: booleanField(backend, 'sessionCapable'),
      ...(detail === undefined ? {} : { detail }),
    }
  })
  if (record['protocolVersion'] !== 1) throw new TypeError('inventory.protocolVersion must be 1')
  return {
    protocolVersion: 1,
    hostdVersion: stringField(record, 'hostdVersion'),
    hostId: stringField(record, 'hostId'),
    healthy: booleanField(record, 'healthy'),
    backends,
  }
}

function parseHost(value: JsonValue): RemoteHostView {
  const record = jsonObject(value, 'host')
  const inventory = parseInventory(record['inventory'])
  const inventoryError = optionalText(record, 'inventoryError')
  const sshValue = record['ssh']
  const ssh = sshValue === undefined ? undefined : jsonObject(sshValue, 'ssh')
  const port = ssh === undefined || ssh['port'] === undefined ? undefined : integerField(ssh, 'port')
  const user = ssh === undefined ? undefined : optionalText(ssh, 'user')
  const identityFile = ssh === undefined ? undefined : optionalText(ssh, 'identityFile')
  const proxyJump = ssh === undefined ? undefined : optionalText(ssh, 'proxyJump')
  return {
    hostId: RemoteHostId(stringField(record, 'hostId')),
    title: stringField(record, 'title'),
    endpoint: stringField(record, 'endpoint'),
    ...(ssh === undefined ? {} : {
      ssh: {
        target: stringField(ssh, 'target'),
        ...(port === undefined ? {} : { port }),
        ...(user === undefined ? {} : { user }),
        ...(identityFile === undefined ? {} : { identityFile }),
        ...(proxyJump === undefined ? {} : { proxyJump }),
        hostKeyFingerprint: stringField(ssh, 'hostKeyFingerprint'),
      },
    }),
    createdAt: stringField(record, 'createdAt'),
    updatedAt: stringField(record, 'updatedAt'),
    ...(inventory === undefined ? {} : { inventory }),
    ...(inventoryError === undefined ? {} : { inventoryError }),
  }
}

function parseSshInspection(value: JsonValue): RemoteSshInspection {
  const record = jsonObject(value, 'SSH inspection')
  return {
    target: stringField(record, 'target'),
    hostKeyFingerprint: stringField(record, 'hostKeyFingerprint'),
    algorithm: stringField(record, 'algorithm'),
  }
}

function parseInstallPlan(value: JsonValue): RemoteInstallPlan {
  const record = jsonObject(value, 'install plan')
  const unavailableReason = optionalText(record, 'unavailableReason')
  const component = stringField(record, 'component')
  if (component !== 'hostd' && !REMOTE_AGENT_BACKENDS.includes(component as RemoteAgentBackend)) throw new Error('install plan has an invalid component')
  if (record['requiresConfirmation'] !== true) throw new Error('install plan must require confirmation')
  return {
    component: component as RemoteInstallPlan['component'],
    version: stringField(record, 'version'),
    alreadyInstalled: booleanField(record, 'alreadyInstalled'),
    requiresConfirmation: true,
    steps: array(record['steps'], 'install steps').map((value) => {
      const step = jsonObject(value, 'install step')
      return { title: stringField(step, 'title'), command: stringField(step, 'command') }
    }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  }
}

/** Validate one fixed-path Agent user configuration document from hostd.
 * @param value - decoded gateway result.
 * @returns browser-safe configuration editor state.
 */
export function parseAgentConfigDocument(value: JsonValue): RemoteAgentConfigDocument {
  const record = jsonObject(value, 'Agent configuration')
  const content = record['content']
  if (typeof content !== 'string') throw new TypeError('Agent configuration content must be a string')
  return {
    backend: remoteAgentConfigBackend(record['backend']),
    path: stringField(record, 'path'),
    format: oneOf(record['format'], ['toml', 'json'] as const, 'config.format'),
    exists: booleanField(record, 'exists'),
    content,
    revision: stringField(record, 'revision'),
    maxBytes: integerField(record, 'maxBytes'),
  }
}

function parseAuthChallenge(value: JsonValue): RemoteAuthChallenge {
  const record = jsonObject(value, 'auth challenge')
  const verificationUri = optionalHttpsUrl(record, 'verificationUri')
  const verificationUriComplete = optionalHttpsUrl(record, 'verificationUriComplete')
  const userCode = optionalText(record, 'userCode')
  const expiresAt = optionalText(record, 'expiresAt')
  return {
    flowId: RemoteAuthFlowId(stringField(record, 'flowId')),
    backend: remoteAgentBackend(record['backend']),
    status: oneOf(record['status'], ['starting', 'waiting-user', 'succeeded', 'failed', 'cancelled', 'expired'] as const, 'auth.status'),
    message: stringField(record, 'message'),
    ...(verificationUri === undefined ? {} : { verificationUri }),
    ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
    ...(userCode === undefined ? {} : { userCode }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

function parseProject(value: JsonValue): RemoteProjectView {
  const record = jsonObject(value, 'project')
  return {
    projectId: RemoteProjectId(stringField(record, 'projectId')),
    hostId: RemoteHostId(stringField(record, 'hostId')),
    title: stringField(record, 'title'),
    cwd: stringField(record, 'cwd'),
    createdAt: stringField(record, 'createdAt'),
    updatedAt: stringField(record, 'updatedAt'),
  }
}

function oneOf<T extends string>(value: JsonValue | undefined, values: readonly T[], key: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new TypeError(`${key} has an invalid value`)
  return value as T
}

function parseSession(value: JsonValue): RemoteSessionView {
  const record = jsonObject(value, 'session')
  const bindingValue = record['binding']
  const binding = bindingValue === undefined ? undefined : jsonObject(bindingValue, 'binding')
  const parentSessionId = optionalText(record, 'parentSessionId')
  const nativeSessionId = binding === undefined ? undefined : optionalText(binding, 'nativeSessionId')
  return {
    sessionId: RemoteSessionId(stringField(record, 'sessionId')),
    projectId: RemoteProjectId(stringField(record, 'projectId')),
    ...(parentSessionId === undefined ? {} : { parentSessionId: RemoteSessionId(parentSessionId) }),
    title: stringField(record, 'title'),
    backend: remoteAgentBackend(record['backend']),
    channelState: oneOf(record['channelState'], ['connecting', 'open', 'reconnecting', 'closed', 'lost'] as const, 'channelState'),
    turnState: oneOf(record['turnState'], ['idle', 'running', 'waiting-permission', 'failed'] as const, 'turnState'),
    createdAt: stringField(record, 'createdAt'),
    updatedAt: stringField(record, 'updatedAt'),
    ...(binding === undefined ? {} : {
      binding: {
        holdId: RemoteHoldId(stringField(binding, 'holdId')),
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
        generation: stringField(binding, 'generation'),
        state: oneOf(binding['state'], ['active', 'superseded', 'lost'] as const, 'binding.state'),
        lastSeq: integerField(binding, 'lastSeq'),
      },
    }),
  }
}

function parseTranscript(value: JsonValue): RemoteTranscriptEntry {
  const record = jsonObject(value, 'transcript entry')
  const nativeFrame = record['nativeFrame']
  const requestId = optionalText(record, 'requestId')
  return {
    transcriptId: RemoteTranscriptId(stringField(record, 'transcriptId')),
    sessionId: RemoteSessionId(stringField(record, 'sessionId')),
    seq: integerField(record, 'seq'),
    role: oneOf(record['role'], ['user', 'assistant', 'system', 'tool', 'permission'] as const, 'role'),
    kind: oneOf(record['kind'], ['message', 'reasoning', 'tool-call', 'tool-result', 'status', 'permission'] as const, 'kind'),
    text: typeof record['text'] === 'string' ? record['text'] : (() => { throw new TypeError('text must be a string') })(),
    createdAt: stringField(record, 'createdAt'),
    ...(nativeFrame === undefined ? {} : { nativeFrame }),
    ...(requestId === undefined ? {} : { requestId }),
  }
}

function parseDirectoryListing(value: JsonValue): RemoteDirectoryListing {
  const record = jsonObject(value, 'directory listing')
  const parent = optionalText(record, 'parent')
  return {
    path: stringField(record, 'path'),
    ...(parent === undefined ? {} : { parent }),
    entries: array(record['entries'], 'directory entries').map((value) => {
      const entry = jsonObject(value, 'directory entry')
      return {
        name: stringField(entry, 'name'),
        path: stringField(entry, 'path'),
        kind: oneOf(entry['kind'], ['directory', 'file', 'other'] as const, 'entry.kind'),
      }
    }),
    truncated: booleanField(record, 'truncated'),
  }
}

/** Validate the complete browser bootstrap projection.
 * @param value - decoded gateway result.
 * @returns the validated remote-agent state.
 */
export function parseRemoteAgentState(value: JsonValue): RemoteAgentState {
  const record = jsonObject(value, 'remote-agent state')
  return {
    pollIntervalMs: integerField(record, 'pollIntervalMs'),
    hosts: array(record['hosts'], 'hosts').map(parseHost),
    projects: array(record['projects'], 'projects').map(parseProject),
    sessions: array(record['sessions'], 'sessions').map(parseSession),
    transcript: array(record['transcript'], 'transcript').map(parseTranscript),
  }
}

/** Remote-agent controller with one observable state account and one polling owner. */
export class RemoteAgentStore {
  private snapshot: RemoteAgentSnapshot = { phase: 'loading', state: EMPTY_STATE, pending: false }
  private readonly listeners = new Set<() => void>()
  private timer: number | undefined
  private disposed = false
  private requestSerial = 0

  /** Read the stable current snapshot. */
  getSnapshot = (): RemoteAgentSnapshot => this.snapshot
  /** Subscribe to top-level snapshot replacement. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Load the durable catalog and begin current-session journal refresh. */
  async start(): Promise<void> {
    try {
      await this.reload()
    } catch (error) {
      this.publish({ ...this.snapshot, phase: 'error', error: String(error) })
    } finally {
      this.schedule()
    }
  }

  /** Stop timers and ignore later in-flight completions. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }

  /** Select a session, attach its hold, then sync available native frames.
   * @param sessionId - catalog session to select.
   */
  async selectSession(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    this.publish({ ...withoutError(this.snapshot), currentSessionId: sessionId })
    await this.run(async () => {
      await this.call('session.attach', { sessionId })
      await this.sync(sessionId)
    })
  }

  /** Add a loopback/SSH-forwarded hostd endpoint.
   * @param title - browser-visible host name.
   * @param endpoint - credential-free loopback HTTP endpoint.
   */
  addHost(title: string, endpoint: string): Promise<void> {
    return this.mutate('host.add', { title, endpoint })
  }

  /** Inspect a remote SSH host key before trusting or mutating the host.
   * @param ssh - connection fields whose identity path refers to the Web service.
   * @returns fingerprint requiring explicit user approval.
   */
  inspectSsh(ssh: Omit<RemoteSshConfig, 'hostKeyFingerprint'>): Promise<RemoteSshInspection> {
    return this.run(async () => parseSshInspection(await this.call('host.ssh.inspect', { ssh: ssh as unknown as JsonValue })))
  }

  /** Deploy hostd after the displayed fingerprint is approved.
   * @param title - browser-visible host name.
   * @param ssh - approved SSH fields and fingerprint.
   */
  deploySshHost(title: string, ssh: RemoteSshConfig): Promise<void> {
    return this.mutate('host.ssh.deploy', { title, ssh: ssh as unknown as JsonValue, confirm: true })
  }

  /** Fetch a non-mutating agent installation plan.
   * @param hostId - target host.
   * @param backend - agent to install.
   * @returns exact configured plan.
   */
  installPlan(hostId: ReturnType<typeof RemoteHostId>, backend: RemoteAgentBackend): Promise<RemoteInstallPlan> {
    return this.run(async () => parseInstallPlan(await this.call('agent.install.plan', { hostId, backend })))
  }

  /** Execute a confirmed predeclared agent installer.
   * @param hostId - target host.
   * @param backend - agent to install.
   */
  installAgent(hostId: ReturnType<typeof RemoteHostId>, backend: RemoteAgentBackend): Promise<void> {
    return this.mutate('agent.install', { hostId, backend, confirm: true })
  }

  /** Read one Agent's official user configuration file.
   * @param hostId - target host.
   * @param backend - Agent with a fixed configuration adapter.
   * @returns editable content and concurrent-write revision.
   */
  readAgentConfig(
    hostId: ReturnType<typeof RemoteHostId>,
    backend: RemoteAgentConfigBackend,
  ): Promise<RemoteAgentConfigDocument> {
    return this.run(async () => parseAgentConfigDocument(await this.call('agent.config.get', { hostId, backend })))
  }

  /** Validate and atomically save one Agent user configuration file.
   * @param hostId - target host.
   * @param backend - Agent with a fixed configuration adapter.
   * @param content - complete JSON or TOML document.
   * @param expectedRevision - revision returned when editing began.
   * @returns the saved document and its new revision.
   */
  writeAgentConfig(
    hostId: ReturnType<typeof RemoteHostId>,
    backend: RemoteAgentConfigBackend,
    content: string,
    expectedRevision: string,
  ): Promise<RemoteAgentConfigDocument> {
    return this.run(async () => parseAgentConfigDocument(await this.call('agent.config.set', {
      hostId, backend, content, expectedRevision,
    })))
  }

  /** Start a detached login command on hostd.
   * @param hostId - target host.
   * @param backend - installed agent.
   * @returns current login challenge.
   */
  startAuth(hostId: ReturnType<typeof RemoteHostId>, backend: RemoteAgentBackend): Promise<RemoteAuthChallenge> {
    return this.run(async () => parseAuthChallenge(await this.call('auth.start', { hostId, backend })))
  }

  /** Poll an existing detached login command.
   * @param hostId - target host.
   * @param flowId - hostd-owned flow id.
   * @returns current login challenge.
   */
  authStatus(hostId: ReturnType<typeof RemoteHostId>, flowId: ReturnType<typeof RemoteAuthFlowId>): Promise<RemoteAuthChallenge> {
    return this.run(async () => parseAuthChallenge(await this.call('auth.status', { hostId, flowId })))
  }

  /** Send a bounded one-time response to a login CLI.
   * @param hostId - target host.
   * @param flowId - hostd-owned flow id.
   * @param response - one-line returned authorization code.
   */
  respondAuth(hostId: ReturnType<typeof RemoteHostId>, flowId: ReturnType<typeof RemoteAuthFlowId>, response: string): Promise<void> {
    return this.mutate('auth.respond', { hostId, flowId, response })
  }

  /** Cancel an authentication process.
   * @param hostId - target host.
   * @param flowId - hostd-owned flow id.
   */
  cancelAuth(hostId: ReturnType<typeof RemoteHostId>, flowId: ReturnType<typeof RemoteAuthFlowId>): Promise<void> {
    return this.mutate('auth.cancel', { hostId, flowId })
  }

  /** Refresh one host's backend inventory.
   * @param hostId - host whose inventory should be read.
   */
  refreshInventory(hostId: ReturnType<typeof RemoteHostId>): Promise<void> {
    return this.mutate('inventory', { hostId })
  }

  /** Register one remote directory as a host-owned project.
   * @param hostId - owning host.
   * @param title - browser-visible project name.
   * @param cwd - host-local directory.
   */
  createProject(hostId: ReturnType<typeof RemoteHostId>, title: string, cwd: string): Promise<void> {
    return this.mutate('project.create', { hostId, title, cwd })
  }

  /** List one host directory without exposing host credentials to the browser.
   * @param hostId - host on which the directory exists.
   * @param path - host-local directory to list.
   * @returns the bounded directory listing.
   */
  listDirectory(hostId: ReturnType<typeof RemoteHostId>, path: string): Promise<RemoteDirectoryListing> {
    return this.run(async () => parseDirectoryListing(await this.call('fs.list', { hostId, path })))
  }

  /** Start a root or child session.
   * @param input - project, title, and root backend or parent identity.
   */
  async createSession(input: {
    projectId: ReturnType<typeof RemoteProjectId>
    title: string
    backend?: RemoteAgentBackend
    parentSessionId?: ReturnType<typeof RemoteSessionId>
  }): Promise<void> {
    await this.run(async () => {
      const result = await this.call('session.start', {
        projectId: input.projectId,
        title: input.title,
        ...(input.backend === undefined ? {} : { backend: input.backend }),
        ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      })
      const session = parseSession(result)
      await this.reload(session.sessionId)
    })
  }

  /** Admit one prompt with a stable browser identity and request id.
   * @param sessionId - root session receiving the prompt.
   * @param text - user text forwarded unchanged.
   */
  async prompt(sessionId: ReturnType<typeof RemoteSessionId>, text: string): Promise<void> {
    const clientId = this.clientId()
    const requestId = `${clientId}-${Date.now()}-${++this.requestSerial}`
    await this.run(async () => {
      await this.call('session.prompt', { sessionId, clientId, requestId, text })
      await this.reload(sessionId)
    })
  }

  /** Cancel the selected backend-native turn.
   * @param sessionId - session whose current work should stop.
   */
  cancel(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    return this.mutate('session.cancel', { sessionId })
  }

  /** Answer one backend-native permission request.
   * @param sessionId - session that emitted the request.
   * @param requestId - backend-native request id.
   * @param outcome - backend-native option value.
   */
  permission(sessionId: ReturnType<typeof RemoteSessionId>, requestId: string, outcome: JsonValue): Promise<void> {
    return this.mutate('session.permission', { sessionId, requestId, outcome })
  }

  private async mutate(method: string, params: Record<string, JsonValue>): Promise<void> {
    await this.run(async () => {
      await this.call(method, params)
      await this.reload()
    })
  }

  private async reload(currentSessionId = this.snapshot.currentSessionId): Promise<void> {
    const state = parseRemoteAgentState(await this.call('state', {}))
    const current = currentSessionId !== undefined && state.sessions.some(session => session.sessionId === currentSessionId)
      ? currentSessionId
      : state.sessions.at(0)?.sessionId
    this.publish({
      phase: 'ready', state, pending: this.snapshot.pending,
      ...(current === undefined ? {} : { currentSessionId: current }),
    })
  }

  private async sync(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    const state = parseRemoteAgentState(await this.call('events.read', { sessionId }))
    this.publish({ ...withoutError(this.snapshot), phase: 'ready', state })
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      const current = this.snapshot.currentSessionId
      const task = current === undefined ? this.reload() : this.sync(current)
      task.catch((error: unknown) => { this.publish({ ...this.snapshot, phase: 'error', error: String(error) }) })
        .finally(() => { this.schedule() })
    }, this.snapshot.state.pollIntervalMs)
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    this.publish({ ...withoutError(this.snapshot), pending: true })
    try {
      const value = await operation()
      this.publish({ ...withoutError(this.snapshot), phase: 'ready', pending: false })
      return value
    } catch (error) {
      this.publish({ ...this.snapshot, phase: 'error', pending: false, error: String(error) })
      throw error
    }
  }

  private async call(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    const id = crypto.randomUUID()
    const response = await fetch(REMOTE_AGENT_GATEWAY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, method, params }),
    })
    const raw: unknown = await response.json()
    const record = jsonObject(raw, 'remote-agent response')
    if (record['id'] !== id) throw new Error('remote-agent response id did not match request')
    if (record['ok'] !== true) {
      const error = jsonObject(record['error'], 'remote-agent error')
      throw new Error(stringField(error, 'message'))
    }
    const result = record['result']
    if (result === undefined) throw new Error('remote-agent response omitted result')
    return result
  }

  private clientId(): string {
    const key = 'dsh.remote-agent.client-id'
    const existing = window.sessionStorage.getItem(key)
    if (existing !== null) return existing
    const value = crypto.randomUUID()
    window.sessionStorage.setItem(key, value)
    return value
  }

  private publish(snapshot: RemoteAgentSnapshot): void {
    if (this.disposed) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

/** Backends shown in stable picker order. */
export const BACKEND_ORDER = REMOTE_AGENT_BACKENDS
