/**
 * Remote-agent Web control-plane vocabulary. Backend frames remain native
 * JSON-RPC/ACP values; only management operations use this protocol.
 * @module @threadharbor/protocol
 */

/** Opaque identifier whose text is only meaningful to its owning service. */
export type Branded<Brand extends string> = string & { readonly __brand: Brand }

/** JSON value accepted at the hostd and browser wire boundaries. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Exact Web-machine control endpoint. */
export const REMOTE_AGENT_GATEWAY_PATH = '/remote-agent/control'
/** Exact Web-machine WebSocket endpoint. */
export const REMOTE_AGENT_GATEWAY_WS_PATH = '/remote-agent/ws'
/** Exact hostd control endpoint. */
export const REMOTE_AGENT_HOSTD_PATH = '/v1/control'
/** Exact hostd WebSocket endpoint; shares the loopback port with the HTTP control endpoint. */
export const REMOTE_AGENT_HOSTD_WS_PATH = '/v1/ws'

/** Backend families managed by hostd. */
export const REMOTE_AGENT_BACKENDS = ['grok', 'codex', 'claude', 'dsh'] as const
/** One immutable session backend. */
export type RemoteAgentBackend = typeof REMOTE_AGENT_BACKENDS[number]
/** Agents whose official user configuration file can be edited through hostd. */
export const REMOTE_AGENT_CONFIG_BACKENDS = ['grok', 'codex', 'claude'] as const
/** Backend with a hostd-owned user configuration adapter. */
export type RemoteAgentConfigBackend = typeof REMOTE_AGENT_CONFIG_BACKENDS[number]

/** Stable Web-catalog host identity. */
export type RemoteHostId = Branded<'RemoteHostId'>
/** Stable Web-catalog project identity. */
export type RemoteProjectId = Branded<'RemoteProjectId'>
/** Stable Web-catalog session identity. */
export type RemoteSessionId = Branded<'RemoteSessionId'>
/** Stable hostd hold identity. */
export type RemoteHoldId = Branded<'RemoteHoldId'>
/** Stable transcript-entry identity. */
export type RemoteTranscriptId = Branded<'RemoteTranscriptId'>
/** Stable remote authentication flow identity. */
export type RemoteAuthFlowId = Branded<'RemoteAuthFlowId'>
/** Stable Web-gateway management operation identity. */
export type RemoteOperationId = Branded<'RemoteOperationId'>

/** Brand an id minted by the remote-agent catalog.
 * @param value - opaque host id text.
 * @returns the branded host id.
 */
export const RemoteHostId = (value: string): RemoteHostId => value as RemoteHostId
/** Brand an id minted by the remote-agent catalog.
 * @param value - opaque project id text.
 * @returns the branded project id.
 */
export const RemoteProjectId = (value: string): RemoteProjectId => value as RemoteProjectId
/** Brand an id minted by the remote-agent catalog.
 * @param value - opaque session id text.
 * @returns the branded session id.
 */
export const RemoteSessionId = (value: string): RemoteSessionId => value as RemoteSessionId
/** Brand an id minted by hostd.
 * @param value - opaque hold id text.
 * @returns the branded hold id.
 */
export const RemoteHoldId = (value: string): RemoteHoldId => value as RemoteHoldId
/** Brand an id minted by the transcript projection.
 * @param value - opaque transcript id text.
 * @returns the branded transcript id.
 */
export const RemoteTranscriptId = (value: string): RemoteTranscriptId => value as RemoteTranscriptId
/** Brand an id minted by a hostd authentication worker.
 * @param value - opaque authentication flow id text.
 * @returns the branded authentication flow id.
 */
export const RemoteAuthFlowId = (value: string): RemoteAuthFlowId => value as RemoteAuthFlowId
/** Brand an id minted by the Web gateway for an asynchronous management operation. */
export const RemoteOperationId = (value: string): RemoteOperationId => value as RemoteOperationId

/** Backend installation and runtime state returned by one hostd inventory. */
export interface RemoteBackendInventory {
  readonly backend: RemoteAgentBackend
  readonly installed: boolean
  readonly authenticated: boolean
  readonly running: boolean
  /** Whether hostd has a native session transport for this installed agent. */
  readonly sessionCapable: boolean
  readonly detail?: string
}

/** Whether an installed backend can create a ThreadHarbor session.
 * Claude and DSH use configuration-based credentials rather than interactive login.
 */
export function isRemoteBackendSessionReady(entry: RemoteBackendInventory): boolean {
  if (!entry.installed || !entry.sessionCapable) return false
  if (entry.backend === 'claude' || entry.backend === 'dsh') return true
  return entry.authenticated
}

/** SSH connection data stored only on the Web service. */
export interface RemoteSshConfig {
  /** OpenSSH host alias or hostname. */
  readonly target: string
  readonly port?: number
  readonly user?: string
  /** Absolute identity-file path on the Web service; key bytes never cross the browser protocol. */
  readonly identityFile?: string
  readonly proxyJump?: string
  /** Fingerprint explicitly approved before the managed known_hosts entry is written. */
  readonly hostKeyFingerprint: string
}

/** Result of scanning one SSH target before trust is persisted. */
export interface RemoteSshInspection {
  readonly target: string
  readonly hostKeyFingerprint: string
  readonly algorithm: string
}

/** One fixed-path, syntax-validated Agent user configuration document. */
export interface RemoteAgentConfigDocument {
  readonly backend: RemoteAgentConfigBackend
  readonly path: string
  readonly format: 'toml' | 'json'
  readonly exists: boolean
  readonly content: string
  /** Content revision required when saving, preventing concurrent overwrite. */
  readonly revision: string
  readonly maxBytes: number
}

/** Browser-safe DSH credential state. The API key itself is never returned. */
export interface RemoteDshCredentialStatus {
  readonly backend: 'dsh'
  readonly configured: boolean
}

/** Browser-safe view of a detached device/browser authorization flow. */
export interface RemoteAuthChallenge {
  readonly flowId: RemoteAuthFlowId
  readonly backend: RemoteAgentBackend
  readonly status: 'starting' | 'waiting-user' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  readonly verificationUri?: string
  readonly verificationUriComplete?: string
  readonly userCode?: string
  readonly message: string
  readonly expiresAt?: string
}

/** Long-running management actions whose progress remains visible outside the initiating panel. */
export type RemoteOperationKind = 'host-ssh-deploy'
/** Safe, finite operation lifecycle exposed to the browser. */
export type RemoteOperationStatus = 'queued' | 'running' | 'succeeded' | 'failed'
/** Predeclared progress stages; raw process output never crosses this boundary. */
export type RemoteOperationPhase =
  | 'queued'
  | 'connecting'
  | 'preparing'
  | 'uploading-hostd'
  | 'starting-hostd'
  | 'opening-tunnel'
  | 'refreshing'
  | 'completed'
  | 'failed'

/** Browser-safe view of one gateway-owned asynchronous management operation. */
export interface RemoteOperationView {
  readonly operationId: RemoteOperationId
  readonly kind: RemoteOperationKind
  readonly status: RemoteOperationStatus
  readonly phase: RemoteOperationPhase
  readonly title: string
  readonly detail: string
  readonly target: string
  readonly cancellable: boolean
  readonly hostId?: RemoteHostId
  readonly current?: number
  readonly total?: number
  readonly startedAt: string
  readonly updatedAt: string
  readonly finishedAt?: string
}

/** Point-in-time hostd health and backend inventory. */
export interface RemoteHostInventory {
  readonly protocolVersion: 1
  readonly hostdVersion: string
  readonly hostId: string
  readonly healthy: boolean
  readonly backends: readonly RemoteBackendInventory[]
}

/** A managed host stored on the Web machine. Credentials never appear here. */
export interface RemoteHostView {
  readonly hostId: RemoteHostId
  readonly title: string
  readonly endpoint: string
  readonly ssh?: RemoteSshConfig
  readonly createdAt: string
  readonly updatedAt: string
  readonly inventory?: RemoteHostInventory
  readonly inventoryError?: string
  /** Hidden hosts stay durable but are omitted from the normal browser projection. */
  readonly hiddenAt?: string
}

/** A project directory on exactly one managed host. */
export interface RemoteProjectView {
  readonly projectId: RemoteProjectId
  readonly hostId: RemoteHostId
  readonly title: string
  readonly cwd: string
  readonly createdAt: string
  readonly updatedAt: string
  /** Hidden projects stay durable but are omitted from the normal browser projection. */
  readonly hiddenAt?: string
}

/** Browser-visible channel state, independent from turn execution. */
export type RemoteChannelState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'lost'
/** Browser-visible turn state. */
export type RemoteTurnState = 'idle' | 'running' | 'waiting-permission' | 'failed'
/** Remote-session binding state. */
export type RemoteBindingState = 'active' | 'superseded' | 'lost'

/** Binding between a Web session and its backend-native session/hold. */
export interface RemoteSessionBinding {
  readonly holdId: RemoteHoldId
  readonly nativeSessionId?: string
  readonly generation: string
  readonly state: RemoteBindingState
  readonly lastSeq: number
}

/** One session in the host → project → session → child hierarchy. */
export interface RemoteSessionView {
  readonly sessionId: RemoteSessionId
  readonly projectId: RemoteProjectId
  readonly parentSessionId?: RemoteSessionId
  readonly title: string
  readonly backend: RemoteAgentBackend
  readonly channelState: RemoteChannelState
  readonly turnState: RemoteTurnState
  readonly createdAt: string
  readonly updatedAt: string
  /** Archived sessions stay durable but are omitted from the normal browser projection. */
  readonly archivedAt?: string
  readonly binding?: RemoteSessionBinding
}

/** Projected transcript entry stored separately from Harness SessionEventMap. */
export interface RemoteTranscriptEntry {
  readonly transcriptId: RemoteTranscriptId
  readonly sessionId: RemoteSessionId
  readonly seq: number
  readonly role: 'user' | 'assistant' | 'system' | 'tool' | 'permission'
  readonly kind: 'message' | 'reasoning' | 'tool-call' | 'tool-result' | 'status' | 'permission'
  readonly text: string
  readonly createdAt: string
  readonly nativeFrame?: JsonValue
  readonly requestId?: string
}

/** Complete browser bootstrap projection. */
export interface RemoteAgentState {
  /** Host-configured browser refresh cadence. */
  readonly pollIntervalMs: number
  readonly hosts: readonly RemoteHostView[]
  readonly projects: readonly RemoteProjectView[]
  readonly sessions: readonly RemoteSessionView[]
  readonly transcript: readonly RemoteTranscriptEntry[]
  /** Active and recent gateway-owned management operations. */
  readonly operations: readonly RemoteOperationView[]
  /** hostd artifact version bundled with the running gateway; used to detect
   *  hosts that need an upgrade or initial deployment. */
  readonly hostdArtifactVersion: string
  /** Stable browser-instance id used to scope WS follow sets and unread counts. */
  readonly browserId: string
  /** Per-session unread transcript counts; the gateway resets them on follow. */
  readonly unreadCounts: Readonly<Record<string, number>>
}

/** Hidden and archived catalog items the settings panel can restore or delete. */
export interface RemoteHiddenItems {
  readonly hosts: readonly RemoteHostView[]
  readonly projects: readonly RemoteProjectView[]
  readonly sessions: readonly RemoteSessionView[]
}

/** One native backend frame in a hold journal. */
export interface RemoteJournalEvent {
  readonly seq: number
  readonly generation: string
  readonly timestamp: string
  readonly frame: JsonValue
}

/** Cursor-based journal page; a gap requires a fresh attach. */
export interface RemoteJournalPage {
  readonly generation: string
  readonly latestSeq: number
  readonly droppedThrough: number
  readonly gap: boolean
  readonly events: readonly RemoteJournalEvent[]
}

/** Native client frame plus the stable admission key used for at-most-once turns. */
export interface RemoteNativeAdmission {
  readonly clientId: string
  readonly requestId: string
  readonly frame: JsonValue
}

/** hostd launch details resolved by the Web gateway. */
export interface RemoteSessionStartSpec {
  readonly sessionId: RemoteSessionId
  readonly backend: RemoteAgentBackend
  readonly cwd: string
  readonly parentNativeSessionId?: string
}

/** hostd start/attach result. */
export interface RemoteSessionAttachResult {
  readonly holdId: RemoteHoldId
  readonly generation: string
  readonly nativeSessionId?: string
  readonly latestSeq: number
}

/** Bounded directory entry returned by hostd. */
export interface RemoteDirectoryEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'directory' | 'file' | 'other'
}

/** Bounded directory listing returned by hostd. */
export interface RemoteDirectoryListing {
  readonly path: string
  readonly parent?: string
  readonly entries: readonly RemoteDirectoryEntry[]
  readonly truncated: boolean
}

/** Control methods accepted by the Web gateway. */
export type RemoteGatewayMethod =
  | 'state'
  | 'hidden.list'
  | 'inventory'
  | 'host.add'
  | 'host.update'
  | 'host.hide'
  | 'host.unhide'
  | 'host.delete'
  | 'host.ssh.inspect'
  | 'host.ssh.deploy'
  | 'operation.start'
  | 'operation.list'
  | 'agent.config.get'
  | 'agent.config.set'
  | 'agent.credential.status'
  | 'agent.credential.set'
  | 'auth.start'
  | 'auth.status'
  | 'auth.respond'
  | 'auth.cancel'
  | 'project.create'
  | 'project.rename'
  | 'project.hide'
  | 'project.unhide'
  | 'project.delete'
  | 'session.start'
  | 'session.attach'
  | 'session.rename'
  | 'session.archive'
  | 'session.unarchive'
  | 'session.delete'
  | 'session.prompt'
  | 'session.cancel'
  | 'session.permission'
  | 'events.read'
  | 'session.follow'
  | 'session.unfollow'
  | 'session.catchup'
  | 'browser.hello'
  | 'fs.list'

/** Control methods accepted directly by hostd. */
export type RemoteHostdMethod =
  | 'inventory'
  | 'agent.config.get'
  | 'agent.config.set'
  | 'agent.credential.status'
  | 'agent.credential.set'
  | 'auth.start'
  | 'auth.status'
  | 'auth.respond'
  | 'auth.cancel'
  | 'session.start'
  | 'session.adopt'
  | 'session.attach'
  | 'session.prompt'
  | 'session.cancel'
  | 'session.permission'
  | 'events.read'
  | 'fs.list'

/** JSON request envelope for either control endpoint. */
export interface RemoteControlRequest {
  readonly id: string
  readonly method: RemoteGatewayMethod | RemoteHostdMethod
  readonly params: Record<string, JsonValue>
}

/** JSON response envelope for either control endpoint. */
export type RemoteControlResponse =
  | { readonly id: string; readonly ok: true; readonly result: JsonValue }
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }


/** Server-initiated push event delivered over the WebSocket channel. */
export type RemoteGatewayWsEvent =
  | { readonly type: 'session.followed'; readonly sessionId: RemoteSessionId; readonly fromSeq: number }
  | { readonly type: 'session.unfollowed'; readonly sessionId: RemoteSessionId }
  | { readonly type: 'transcript.append'; readonly sessionId: RemoteSessionId; readonly entry: RemoteTranscriptEntry; readonly seq: number }
  | { readonly type: 'transcript.batch'; readonly sessionId: RemoteSessionId; readonly entries: readonly RemoteTranscriptEntry[]; readonly fromSeq: number; readonly toSeq: number }
  | { readonly type: 'transcript.gap'; readonly sessionId: RemoteSessionId; readonly droppedThrough: number }
  | { readonly type: 'session.view.changed'; readonly session: RemoteSessionView }
  | { readonly type: 'host.changed'; readonly host: RemoteHostView }
  | { readonly type: 'project.changed'; readonly project: RemoteProjectView }
  | { readonly type: 'operation.progress'; readonly operationId: string; readonly phase: string; readonly progress?: number }

/** Frame exchanged over the WebSocket control channel. */
export type RemoteGatewayWsFrame =
  | { readonly direction: 'request'; readonly id: string; readonly method: RemoteGatewayMethod; readonly params: Record<string, JsonValue> }
  | { readonly direction: 'response'; readonly id: string; readonly ok: true; readonly result: JsonValue }
  | { readonly direction: 'response'; readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  | { readonly direction: 'push'; readonly seq: number; readonly event: RemoteGatewayWsEvent }
  | { readonly direction: 'ping' }
  | { readonly direction: 'pong' }

/** Test whether a value is lossless JSON data.
 * @param value - candidate wire value.
 * @returns whether the value can cross the JSON control protocol.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}

/** Require a plain JSON object at a wire boundary.
 * @param value - candidate wire value.
 * @param label - field name used in validation failures.
 * @returns the validated JSON object.
 */
export function jsonObject(value: unknown, label: string): Record<string, JsonValue> {
  if (!isJsonValue(value) || value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError(`${label} must be a JSON object`)
  }
  return value
}

/** Require a non-empty string field at a wire boundary.
 * @param record - validated containing object.
 * @param key - required field name.
 * @returns the non-empty field value.
 */
export function stringField(record: Record<string, JsonValue>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${key} must be a non-empty string`)
  return value
}

/** Parse one backend name at a wire or configuration boundary.
 * @param value - candidate backend tag.
 * @returns the validated backend tag.
 */
export function remoteAgentBackend(value: unknown): RemoteAgentBackend {
  if (value === 'grok' || value === 'codex' || value === 'claude' || value === 'dsh') return value
  throw new TypeError(`backend must be one of ${REMOTE_AGENT_BACKENDS.join(', ')}`)
}

/** Parse a configurable Agent backend at a wire boundary.
 * @param value - candidate backend tag.
 * @returns a backend with a fixed user configuration file.
 */
export function remoteAgentConfigBackend(value: unknown): RemoteAgentConfigBackend {
  if (value === 'grok' || value === 'codex' || value === 'claude') return value
  throw new TypeError(`config backend must be one of ${REMOTE_AGENT_CONFIG_BACKENDS.join(', ')}`)
}

/** Parse one control request at an HTTP or Unix-socket boundary.
 * @param value - decoded JSON request.
 * @returns the validated control request.
 */
export function parseRemoteControlRequest(value: unknown): RemoteControlRequest {
  const record = jsonObject(value, 'control request')
  const id = stringField(record, 'id')
  const method = stringField(record, 'method') as RemoteControlRequest['method']
  const params = jsonObject(record['params'], 'params')
  return { id, method, params }
}

/** Server-initiated push event delivered from hostd to the gateway over the WS control channel. */
export type RemoteHostdWsEvent =
  | { readonly type: 'journal.page'; readonly sessionId: RemoteSessionId; readonly page: RemoteJournalPage; readonly subscribers: number }
  | { readonly type: 'journal.gap'; readonly sessionId: RemoteSessionId; readonly droppedThrough: number; readonly generation: string }

/** Frame exchanged over the hostd control WebSocket channel.
 *  Shares the request/response envelope with HTTP `/v1/control` so RPCs reuse the existing dispatcher;
 *  adds subscribe/unsubscribe/push for the push channel and ping/pong for liveness. */
export type RemoteHostdWsFrame =
  | { readonly direction: 'request'; readonly id: string; readonly method: RemoteHostdMethod; readonly params: Record<string, JsonValue> }
  | { readonly direction: 'response'; readonly id: string; readonly ok: true; readonly result: JsonValue }
  | { readonly direction: 'response'; readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  | { readonly direction: 'subscribe'; readonly sessionId: RemoteSessionId; readonly generation: string; readonly lastSeq: number }
  | { readonly direction: 'unsubscribe'; readonly sessionId: RemoteSessionId }
  | { readonly direction: 'push'; readonly seq: number; readonly event: RemoteHostdWsEvent }
  | { readonly direction: 'ping' }
  | { readonly direction: 'pong' }

/** Parse one hostd WebSocket frame at the wire boundary.
 *  Validates `direction`, the discriminator fields per direction, and JSON sub-structures.
 * @param value - decoded JSON frame.
 * @returns the validated frame.
 */
export function parseHostdWsFrame(value: unknown): RemoteHostdWsFrame {
  const record = jsonObject(value, 'hostd ws frame')
  const direction = stringField(record, 'direction')
  switch (direction) {
    case 'request': {
      const id = stringField(record, 'id')
      const method = stringField(record, 'method') as RemoteHostdMethod
      const params = jsonObject(record['params'], 'params')
      return { direction, id, method, params }
    }
    case 'response': {
      const id = stringField(record, 'id')
      if (record['ok'] === true) {
        const result = record['result']
        if (!isJsonValue(result)) throw new TypeError('result must be JSON')
        return { direction, id, ok: true, result }
      }
      const error = jsonObject(record['error'], 'error')
      const code = stringField(error, 'code')
      const message = stringField(error, 'message')
      return { direction, id, ok: false, error: { code, message } }
    }
    case 'subscribe': {
      const sessionId = RemoteSessionId(stringField(record, 'sessionId'))
      const generation = stringField(record, 'generation')
      const lastSeqRaw = record['lastSeq']
      if (!Number.isSafeInteger(lastSeqRaw) || (lastSeqRaw as number) < 0) {
        throw new TypeError('lastSeq must be a non-negative safe integer')
      }
      return { direction, sessionId, generation, lastSeq: lastSeqRaw as number }
    }
    case 'unsubscribe': {
      const sessionId = RemoteSessionId(stringField(record, 'sessionId'))
      return { direction, sessionId }
    }
    case 'push': {
      if (!Number.isSafeInteger(record['seq']) || (record['seq'] as number) < 0) {
        throw new TypeError('seq must be a non-negative safe integer')
      }
      const event = parseHostdWsEvent(record['event'])
      return { direction, seq: record['seq'] as number, event }
    }
    case 'ping':
      return { direction: 'ping' }
    case 'pong':
      return { direction: 'pong' }
    default:
      throw new TypeError(`unknown hostd ws frame direction ${direction}`)
  }
}

/** Parse a single hostd push event payload.
 * @param value - decoded JSON event.
 * @returns the validated event.
 */
export function parseHostdWsEvent(value: unknown): RemoteHostdWsEvent {
  const record = jsonObject(value, 'hostd ws event')
  const type = stringField(record, 'type')
  switch (type) {
    case 'journal.page': {
      const page = jsonObject(record['page'], 'page')
      const events = page['events']
      if (!Array.isArray(events)) throw new TypeError('page.events must be an array')
      const validatedEvents: RemoteJournalEvent[] = []
      for (const item of events) {
        const eventRecord = jsonObject(item, 'journal event')
        if (!Number.isSafeInteger(eventRecord['seq']) || (eventRecord['seq'] as number) < 0) {
          throw new TypeError('event.seq must be a non-negative safe integer')
        }
        if (typeof eventRecord['generation'] !== 'string' || typeof eventRecord['timestamp'] !== 'string'
          || !isJsonValue(eventRecord['frame'])) {
          throw new TypeError('journal event must carry generation/timestamp/frame')
        }
        validatedEvents.push(eventRecord as unknown as RemoteJournalEvent)
      }
      if (!Number.isSafeInteger(page['latestSeq']) || (page['latestSeq'] as number) < 0) {
        throw new TypeError('page.latestSeq must be a non-negative safe integer')
      }
      if (!Number.isSafeInteger(page['droppedThrough']) || (page['droppedThrough'] as number) < 0) {
        throw new TypeError('page.droppedThrough must be a non-negative safe integer')
      }
      const subscribersRaw = record['subscribers']
      if (!Number.isSafeInteger(subscribersRaw) || (subscribersRaw as number) < 0) {
        throw new TypeError('subscribers must be a non-negative safe integer')
      }
      return {
        type,
        sessionId: RemoteSessionId(stringField(record, 'sessionId')),
        page: {
          generation: stringField(page, 'generation'),
          latestSeq: page['latestSeq'] as number,
          droppedThrough: page['droppedThrough'] as number,
          gap: page['gap'] === true,
          events: validatedEvents,
        },
        subscribers: subscribersRaw as number,
      }
    }
    case 'journal.gap': {
      const sessionId = RemoteSessionId(stringField(record, 'sessionId'))
      if (!Number.isSafeInteger(record['droppedThrough']) || (record['droppedThrough'] as number) < 0) {
        throw new TypeError('droppedThrough must be a non-negative safe integer')
      }
      return {
        type,
        sessionId,
        droppedThrough: record['droppedThrough'] as number,
        generation: stringField(record, 'generation'),
      }
    }
    default:
      throw new TypeError(`unknown hostd ws event type ${type}`)
  }
}
