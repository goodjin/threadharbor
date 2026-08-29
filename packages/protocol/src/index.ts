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
/** Exact hostd control endpoint. */
export const REMOTE_AGENT_HOSTD_PATH = '/v1/control'

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

/** Fixed, reviewable installation operation. No browser-provided shell is accepted. */
export interface RemoteInstallStep {
  readonly title: string
  readonly command: string
}

/** Installation plan returned before a mutating operation. */
export interface RemoteInstallPlan {
  readonly component: 'hostd' | RemoteAgentBackend
  readonly version: string
  readonly alreadyInstalled: boolean
  readonly requiresConfirmation: true
  readonly steps: readonly RemoteInstallStep[]
  readonly unavailableReason?: string
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
}

/** A project directory on exactly one managed host. */
export interface RemoteProjectView {
  readonly projectId: RemoteProjectId
  readonly hostId: RemoteHostId
  readonly title: string
  readonly cwd: string
  readonly createdAt: string
  readonly updatedAt: string
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
  | 'inventory'
  | 'host.add'
  | 'host.ssh.inspect'
  | 'host.ssh.deploy'
  | 'agent.install.plan'
  | 'agent.install'
  | 'agent.config.get'
  | 'agent.config.set'
  | 'auth.start'
  | 'auth.status'
  | 'auth.respond'
  | 'auth.cancel'
  | 'project.create'
  | 'session.start'
  | 'session.attach'
  | 'session.prompt'
  | 'session.cancel'
  | 'session.permission'
  | 'events.read'
  | 'fs.list'

/** Control methods accepted directly by hostd. */
export type RemoteHostdMethod =
  | 'inventory'
  | 'agent.install.plan'
  | 'agent.install'
  | 'agent.config.get'
  | 'agent.config.set'
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
