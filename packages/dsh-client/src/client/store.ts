/** React-free browser object layer for the remote-agent control endpoint. */

import {
  archiveCutoff,
  readDisplayPreferences,
  writeDisplayPreferences,
  type DisplayPreferences,
} from './display-preferences.ts'
import { TranscriptCache } from './transcript-cache.ts'
import {
  REMOTE_AGENT_BACKENDS,
  REMOTE_AGENT_GATEWAY_PATH,
  RemoteHoldId,
  RemoteHostId,
  RemoteOperationId,
  RemoteProjectId,
  RemoteSessionId,
  RemoteTranscriptId,
  RemoteAuthFlowId,
  REMOTE_TRANSCRIPT_PAGE_SIZE,
  isRemoteBackendSessionReady,
  hostdArtifactSame,
  jsonObject,
  parseRemoteErrorFix,
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
  type RemoteErrorFixKind,
  type RemoteHiddenItems,
  type RemoteHostDeployState,
  type RemoteHostInventory,
  type RemoteHostView,
  type RemoteInstallPlan,
  type RemoteOperationView,
  type RemoteProjectView,
  type RemoteSessionConfigOption,
  type RemoteSessionView,
  type RemoteTranscriptEntry,
  type RemoteTranscriptPage,
  type RemoteTranscriptUsage,
  type RemoteSshConfig,
  type RemoteSshInspection,
} from '@threadharbor/protocol'

/** Single browser-local slot that holds the next user message while a previous
 *  turn is still in flight. Released automatically once the live turn ends or
 *  discarded when the user cancels or switches sessions. */
export interface RemoteQueuedPrompt {
  readonly sessionId: ReturnType<typeof RemoteSessionId>
  readonly text: string
  readonly requestId: string
  readonly queuedAt: number
}

/** A prompt whose admission RPC was interrupted by a transport drop before the
 *  gateway answered. Redelivered automatically once the live channel returns,
 *  reusing the original requestId so the server can deduplicate the admission
 *  and the user transcript entry. Browser-local only; a page refresh forgets it
 *  (the message is then visibly failed and available for a manual resend). */
interface PendingRedelivery {
  readonly sessionId: ReturnType<typeof RemoteSessionId>
  readonly projectId: ReturnType<typeof RemoteProjectId>
  readonly clientId: string
  readonly requestId: string
  readonly text: string
  readonly baselineSeq: number
  readonly startedAt: number
  attempts: number
}

/** How many reconnect-driven redelivery attempts before giving up (transport
 *  drops only; hostd-unreachable retries are bounded by age, not this count). */
const REDELIVERY_MAX_ATTEMPTS = 5
/** Wall-clock window during which an interrupted prompt may still be redelivered. */
const REDELIVERY_MAX_AGE_MS = 5 * 60_000
/** Backoff between redelivery attempts while the remote hostd is unreachable but
 *  the browser↔gateway socket is still live (a hostd restart/redeploy). Nothing
 *  else re-pumps the queue in that window, so we drive it on this timer. */
const REDELIVERY_BACKOFF_MS = 4_000

/** Errors the browser transport raises when a request was dropped before the
 *  gateway answered — a socket loss or a failed reconnect — where redelivering
 *  with the same requestId cannot double-admit a prompt the server never saw.
 *  Deliberately excludes request timeouts: there the far side may already have
 *  admitted the prompt, so the message is surfaced as failed instead. */
function isTransportDropError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /实时通道已断开|did not reach live phase|transport closed|connection lost/i.test(message)
}

/** Errors where the gateway reached us but the remote hostd was momentarily down
 *  — a hostd restart or redeploy: the SSH tunnel refuses the TCP connection
 *  (ECONNREFUSED) or the process is not up yet. The prompt was provably NOT
 *  admitted, so redelivering with the same requestId is safe and succeeds once
 *  hostd is back. Deliberately NARROW: excludes ambiguous request timeouts (the
 *  far side may have admitted), backend rejections (auth / usage limit), and a
 *  genuinely dead hold socket — the gateway rewrites that to the "在当前会话重开"
 *  reopen hint, which owns its own recovery UX and must not be silently retried. */
function isHoldUnreachableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/在当前会话重开|\.sock|named pipe/i.test(message)) return false
  return /process is not running|did not start|ECONNREFUSED|ENOTSOCK/i.test(message)
}

/** Any delivery failure safe to auto-redeliver by reusing the same requestId. */
function isRedeliverableError(error: unknown): boolean {
  return isTransportDropError(error) || isHoldUnreachableError(error)
}

/** Browser interaction snapshot. */
export interface RemoteAgentSnapshot {
  readonly phase: 'loading' | 'ready' | 'reconnecting' | 'error'
  readonly state: RemoteAgentState
  readonly currentSessionId?: ReturnType<typeof RemoteSessionId>
  readonly attachingSessionId?: ReturnType<typeof RemoteSessionId>
  readonly draftSession?: RemoteSessionDraft
  readonly panel?: RemoteAgentPanel
  readonly pending: boolean
  readonly promptProgress?: RemotePromptProgress
  /** Next message held in the browser until the live turn finishes. */
  readonly queuedPrompt?: RemoteQueuedPrompt
  readonly error?: string
  /** Hidden hosts/projects and archived sessions; loaded when the settings panel opens. */
  readonly hiddenItems?: RemoteHiddenItems
}

/** Browser-owned lifecycle for the most recent prompt before backend events exist. */
export interface RemotePromptProgress {
  readonly projectId: ReturnType<typeof RemoteProjectId>
  readonly sessionId?: ReturnType<typeof RemoteSessionId>
  readonly phase: 'connecting' | 'sending' | 'waiting' | 'reconnecting' | 'failed'
  readonly startedAt: number
  readonly baselineSeq: number
  readonly message?: string
}

/** Unsaved root session shown immediately after the user clicks “new session”. */
export interface RemoteSessionDraft {
  readonly projectId: ReturnType<typeof RemoteProjectId>
  readonly title: string
}

/** Browser-local operation surface shown in the main conversation region. */
export type RemoteAgentPanel =
  | { readonly kind: 'add-host' }
  | { readonly kind: 'add-project'; readonly hostId?: ReturnType<typeof RemoteHostId> }
  | { readonly kind: 'host-settings'; readonly hostId: ReturnType<typeof RemoteHostId> }
  | { readonly kind: 'hidden' }

/** Inventory status rendered by the DSH StateDot primitive.
 * Running means the backend service is ready; it is not an in-progress operation.
 */
export function backendInventoryState(
  host: RemoteHostView,
  backend: RemoteAgentBackend,
): 'done' | 'warning' | 'error' {
  const entry = host.inventory?.backends.find(candidate => candidate.backend === backend)
  if (host.inventoryError !== undefined) return 'error'
  if (entry !== undefined && isRemoteBackendSessionReady(entry)) return 'done'
  return 'warning'
}

/** Compare a host's reported hostd health and version with the gateway artifact.
 *  - `checking`: inventory has not returned yet.
 *  - `missing`: hostd is unreachable or reports unhealthy.
 *  - `outdated`: hostd is alive but its version differs from the gateway artifact.
 *  - `deployed`: hostd is alive and matches the gateway artifact.
 */
export type HostDeploymentState = 'checking' | 'missing' | 'outdated' | 'deployed'

export function hostDeployment(
  host: RemoteHostView,
  artifactVersion: string | undefined,
): HostDeploymentState {
  if (host.inventory === undefined && host.inventoryError === undefined) return 'checking'
  if (host.inventoryError !== undefined || host.inventory === undefined || host.inventory.healthy !== true) return 'missing'
  // Digest comparison, not full-string: an SSH-deployed hostd reports
  // `unknown+<digest>` (no package.json next to its uploaded artifacts) for
  // the same artifact bytes the gateway stamps `0.1.0+<digest>`.
  if (artifactVersion !== undefined && artifactVersion !== '' && artifactVersion !== 'unknown'
    && !hostdArtifactSame(host.inventory.hostdVersion, artifactVersion)) {
    return 'outdated'
  }
  return 'deployed'
}

/** Best-effort human-readable IP or hostname for a host row. */
export function hostIpLabel(host: RemoteHostView): string {
  if (host.ssh !== undefined && host.ssh.target !== '') return host.ssh.target
  if (host.endpoint === undefined) return ''
  try { return new URL(host.endpoint).host } catch { return host.endpoint }
}

/** Localised connection status text for the sidebar host row. */
export function hostConnectionLabel(host: RemoteHostView, artifactVersion: string | undefined): string {
  // Deploy lifecycle takes precedence over liveness: a host that has never
  // finished a deploy is not merely "offline", and a failed deploy needs to
  // read as actionable rather than a transient disconnect.
  if (host.deployState === 'deploying' || host.deployState === 'pending') return '部署中…'
  if (host.deployState === 'failed') return '部署失败'
  const state = hostDeployment(host, artifactVersion)
  if (host.inventoryError !== undefined) return '离线'
  if (state === 'deployed') return '已连接'
  if (state === 'outdated') return '已连接，待升级'
  if (state === 'missing') return '未部署'
  return '检查中'
}

/** Inline action badge prompting the user about a pending hostd change. */
export type HostDeploymentBadge = { readonly label: string; readonly tone: 'warn' | 'muted' | 'error' }
export function hostDeploymentBadge(
  host: RemoteHostView,
  artifactVersion: string | undefined,
): HostDeploymentBadge | undefined {
  if (host.deployState === 'deploying' || host.deployState === 'pending') return { label: '部署中', tone: 'muted' }
  if (host.deployState === 'failed') return { label: '重试', tone: 'error' }
  if (host.inventoryError !== undefined) return undefined
  const state = hostDeployment(host, artifactVersion)
  if (state === 'missing') return { label: '部署', tone: 'muted' }
  if (state === 'outdated') return { label: '升级', tone: 'warn' }
  return undefined
}

export function isLoopbackHostEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  } catch {
    return false
  }
}

/** Whether the host settings card can offer 升级/部署 hostd. */
export function canUpgradeHostd(host: RemoteHostView, artifactVersion: string | undefined): boolean {
  const state = hostDeployment(host, artifactVersion)
  if (host.ssh?.hostKeyFingerprint !== undefined) return state === 'outdated' || state === 'missing'
  return state === 'outdated' && host.endpoint !== undefined && isLoopbackHostEndpoint(host.endpoint)
}

/** Turn a hostd reachability failure into a short, actionable reason. */
export function describeHostConnectFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/u, '').trim()
  if (message === '' || /^fetch failed$/i.test(message) || /Failed to fetch/i.test(message) || /ECONNREFUSED|ECONNRESET/i.test(message)) {
    return '无法连接到 hostd。请确认远端服务已启动后再试。'
  }
  if (/timed out|timeout|TimeoutError|AbortError/i.test(message)) {
    return '连接超时。请检查网络或 SSH 隧道后再试。'
  }
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(message)) {
    return '找不到主机地址。请检查主机名或网络。'
  }
  return message
}

/** Whether an RPC error means the remote hold/session process is gone. */
export function isSessionHoldFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/u, '').trim()
  if (message.includes('在当前会话') || message.includes('远程会话进程已停止')) return true
  return /ECONNREFUSED|ENOENT|ENOTSOCK|EPIPE|ECONNRESET|fetch failed|process is not running|did not start/i.test(message)
}

/** Turn a session-hold reconnect failure into a short, actionable reason. */
export function describeSessionReconnectFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/u, '').trim()
  if (message.includes('在当前会话') || message.includes('远程会话进程已停止')) return message
  if (isSessionHoldFailure(error) && /\.sock|named pipe|hold /i.test(message)) {
    return '远程会话进程已停止。可以点「在当前会话重开」，系统会在当前会话上重启 Agent，对话记录会保留。'
  }
  return message
}

/** A reopen failure the UI can explain, plus the repair it can confirm. */
export type ReopenFixKind = RemoteErrorFixKind

/** Parsed reopen failure shown on the conversation banner. */
export interface ReopenFailureIssue {
  /** Human-readable reason for the failed reopen. */
  readonly reason: string
  /** Repair the Web UI can offer when one exists (adopt/restart for Grok, etc.). */
  readonly fix?: ReopenFixKind
}

const REOPEN_FIX_FALLBACK_REASON: Record<RemoteErrorFixKind, string> = {
  'grok-serve': 'Grok 服务无法连接，会话没能重新打开。',
  'agent-missing': '远程 Agent 组件缺失或未安装，会话没能重新打开。',
}

/**
 * Turn a failed reopen error into a banner-visible reason and an optional
 * confirm-to-fix action. hostd marks actionable failures with
 * `[th-fix:<kind>] <detail>`; a genuinely dead hold socket keeps the legacy
 * hint; any other hostd/gateway reply is shown verbatim so a reopen never
 * hides the real reason behind a generic "click reopen again".
 */
export function parseReopenFailure(error: unknown): ReopenFailureIssue {
  const raw = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/u, '').trim()
  const marker = parseRemoteErrorFix(raw)
  if (marker !== undefined) {
    return {
      fix: marker.kind,
      reason: marker.detail === '' ? REOPEN_FIX_FALLBACK_REASON[marker.kind] : marker.detail,
    }
  }
  if (isSessionHoldFailure(error) && /\.sock|named pipe/.test(raw)) {
    return { reason: '远程会话进程已停止。可以点「在当前会话重开」，系统会在当前会话上重启 Agent，对话记录会保留。' }
  }
  return { reason: raw }
}

/** Turn an Agent deploy failure into a short, actionable reason. */
export function describeAgentInstallFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/u, '').trim()
  if (/does not implement method agent\.install/i.test(message)) {
    return '当前 hostd 过旧，还不支持 Agent 部署。请先在主机设置里升级 hostd，再点部署。'
  }
  if (/externally-managed-environment/i.test(message)) {
    return '这台主机的 Python 由系统管理（例如 Homebrew），旧版 hostd 的 pip install --user 会被拒绝。请先升级并重启 hostd，再点部署。'
  }
  return message
}

const EMPTY_STATE: RemoteAgentState = {
  pollIntervalMs: 1000,
  hosts: [],
  projects: [],
  sessions: [],
  transcript: [],
  operations: [],
  hostdArtifactVersion: 'unknown',
  browserId: 'unknown',
  unreadCounts: {},
}

// The browser must outlive the Gateway's 45s hostd bound plus projection persistence.
// Recovery polling remains active after this outer guard fires.
const CONTROL_REQUEST_TIMEOUT_MS = 75_000
/** Maximum time to wait for session.start to publish an open binding. */
const SESSION_OPEN_TIMEOUT_MS = 75_000
/** Poll cadence while waiting for a new session to open, so a missed `session.view`
 *  push (WS drop / frozen background tab) cannot strand the create. */
const SESSION_OPEN_POLL_MS = 2_000
/** Wall-clock cap for one auto-archive sweep. Anything still pending is left
 *  for the next reload — the goal is to never strand the settings panel on
 *  "清理中…" longer than this, not to guarantee every stale row is retired
 *  in one pass. */
const ARCHIVE_BUDGET_MS = 60_000
const LIVE_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const
const CURRENT_SESSION_STORAGE_KEY = 'dsh.remote-agent.current-session-id'

function readPersistedCurrentSessionId(): string | undefined {
  try {
    const value = window.localStorage?.getItem(CURRENT_SESSION_STORAGE_KEY)
    return value === null || value === undefined || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

function writePersistedCurrentSessionId(sessionId: string): void {
  try {
    window.localStorage?.setItem(CURRENT_SESSION_STORAGE_KEY, sessionId)
  } catch {
    // ignore quota / disabled storage
  }
}

function withoutError(snapshot: RemoteAgentSnapshot): RemoteAgentSnapshot {
  const { error: _error, ...rest } = snapshot
  return rest
}

function promptTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? ''
  return firstLine.length <= 40 ? firstLine : `${firstLine.slice(0, 39)}…`
}

/** If a draft create is in flight, prefer the session that start already produced. */
function inFlightCreatedSessionId(
  state: RemoteAgentState,
  draft: RemoteSessionDraft | undefined,
  progress: RemotePromptProgress | undefined,
  currentSessionId: ReturnType<typeof RemoteSessionId> | undefined,
): ReturnType<typeof RemoteSessionId> | undefined {
  if (progress === undefined || progress.phase === 'failed') return undefined
  // A prompt in flight only pins the selection while the user is still on
  // that session (or has no selection yet, i.e. it was just created from a
  // draft). Every catalog reload during "等待 Agent 响应" runs through here;
  // re-adopting the prompting session unconditionally yanked the user back
  // from whichever other session they had just clicked.
  if (progress.sessionId !== undefined
    && (currentSessionId === undefined || currentSessionId === progress.sessionId)
    && state.sessions.some(session => session.sessionId === progress.sessionId)) {
    return progress.sessionId
  }
  if (currentSessionId !== undefined && state.sessions.some(session => session.sessionId === currentSessionId)) {
    return currentSessionId
  }
  if (draft === undefined || progress.sessionId !== undefined) return undefined
  const matches = state.sessions.filter(session =>
    session.projectId === draft.projectId
    && session.parentSessionId === undefined
    && Date.parse(session.createdAt) >= progress.startedAt - 2_000)
  const latest = matches.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
  return latest === undefined ? undefined : latest.sessionId
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lastTranscriptSeq(state: RemoteAgentState, sessionId: ReturnType<typeof RemoteSessionId>): number {
  let last = -1
  for (const entry of state.transcript) {
    if (entry.sessionId === sessionId && entry.seq > last) last = entry.seq
  }
  return last
}

/** Insert or replace one session row so a just-created session is visible before the next catalog reload.
 *  New sessions are prepended so they appear at the top of the project list, matching the
 *  server-side `state()` projection (which sorts by `updatedAt` desc). Prepending keeps the
 *  optimistic local insert aligned with the eventual server order, so users do not see the new
 *  session flash from the bottom to the top during the next reload. */
function withSessionView(state: RemoteAgentState, session: RemoteSessionView): RemoteAgentState {
  const exists = state.sessions.some(existing => existing.sessionId === session.sessionId)
  return {
    ...state,
    sessions: exists
      ? state.sessions.map(existing => existing.sessionId === session.sessionId ? session : existing)
      : [session, ...state.sessions],
  }
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

function seqField(record: Record<string, JsonValue>, key: string): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < -1) throw new TypeError(`${key} must be an integer >= -1`)
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
  const hiddenAt = optionalText(record, 'hiddenAt')
  const endpoint = optionalText(record, 'endpoint')
  const deployState = parseHostDeployState(record['deployState'])
  const deployError = optionalText(record, 'deployError')
  return {
    hostId: RemoteHostId(stringField(record, 'hostId')),
    title: stringField(record, 'title'),
    ...(endpoint === undefined ? {} : { endpoint }),
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
    ...(deployState === undefined ? {} : { deployState }),
    ...(deployError === undefined ? {} : { deployError }),
    ...(hiddenAt === undefined ? {} : { hiddenAt }),
  }
}

const HOST_DEPLOY_STATES: readonly RemoteHostDeployState[] = ['pending', 'deploying', 'deployed', 'failed']
function parseHostDeployState(value: JsonValue | undefined): RemoteHostDeployState | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !HOST_DEPLOY_STATES.includes(value as RemoteHostDeployState)) {
    throw new TypeError('host.deployState must be a known deploy state')
  }
  return value as RemoteHostDeployState
}

function parseSshInspection(value: JsonValue): RemoteSshInspection {
  const record = jsonObject(value, 'SSH inspection')
  return {
    target: stringField(record, 'target'),
    hostKeyFingerprint: stringField(record, 'hostKeyFingerprint'),
    algorithm: stringField(record, 'algorithm'),
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
  const hiddenAt = optionalText(record, 'hiddenAt')
  return {
    projectId: RemoteProjectId(stringField(record, 'projectId')),
    hostId: RemoteHostId(stringField(record, 'hostId')),
    title: stringField(record, 'title'),
    cwd: stringField(record, 'cwd'),
    createdAt: stringField(record, 'createdAt'),
    updatedAt: stringField(record, 'updatedAt'),
    ...(hiddenAt === undefined ? {} : { hiddenAt }),
  }
}

function oneOf<T extends string>(value: JsonValue | undefined, values: readonly T[], key: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new TypeError(`${key} has an invalid value`)
  return value as T
}

/** Backend-advertised session settings; tolerant of a gateway that predates them. */
function parseConfigOptions(value: JsonValue | undefined): RemoteSessionConfigOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options = value.flatMap((entry): RemoteSessionConfigOption[] => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
    const id = entry['id']
    const currentValue = entry['currentValue']
    const setter = entry['setter']
    const choices = Array.isArray(entry['options']) ? entry['options'] : []
    if (typeof id !== 'string' || typeof currentValue !== 'string') return []
    if (setter !== 'config' && setter !== 'mode' && setter !== 'model') return []
    const parsedChoices = choices.flatMap((choice) => {
      if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) return []
      const choiceValue = choice['value']
      if (typeof choiceValue !== 'string') return []
      const description = choice['description']
      return [{
        value: choiceValue,
        name: typeof choice['name'] === 'string' ? choice['name'] : choiceValue,
        ...(typeof description === 'string' ? { description } : {}),
      }]
    })
    if (parsedChoices.length === 0) return []
    const description = entry['description']
    const category = entry['category']
    return [{
      id,
      name: typeof entry['name'] === 'string' ? entry['name'] : id,
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof category === 'string' ? { category } : {}),
      currentValue,
      options: parsedChoices,
      setter,
    }]
  })
  return options.length === 0 ? undefined : options
}

function parseSession(value: JsonValue): RemoteSessionView {
  const record = jsonObject(value, 'session')
  const bindingValue = record['binding']
  const binding = bindingValue === undefined ? undefined : jsonObject(bindingValue, 'binding')
  const parentSessionId = optionalText(record, 'parentSessionId')
  const nativeSessionId = binding === undefined ? undefined : optionalText(binding, 'nativeSessionId')
  const archivedAt = optionalText(record, 'archivedAt')
  const lastPromptAt = optionalText(record, 'lastPromptAt')
  const configOptions = parseConfigOptions(record['configOptions'])
  return {
    sessionId: RemoteSessionId(stringField(record, 'sessionId')),
    projectId: RemoteProjectId(stringField(record, 'projectId')),
    ...(parentSessionId === undefined ? {} : { parentSessionId: RemoteSessionId(parentSessionId) }),
    title: stringField(record, 'title'),
    backend: remoteAgentBackend(record['backend']),
    channelState: oneOf(record['channelState'], ['connecting', 'open', 'reconnecting', 'closed', 'lost'] as const, 'channelState'),
    turnState: oneOf(record['turnState'], ['idle', 'running', 'waiting-permission', 'stopped', 'failed'] as const, 'turnState'),
    createdAt: stringField(record, 'createdAt'),
    updatedAt: stringField(record, 'updatedAt'),
    ...(record['latestTranscriptSeq'] === undefined ? {} : { latestTranscriptSeq: seqField(record, 'latestTranscriptSeq') }),
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(lastPromptAt === undefined ? {} : { lastPromptAt }),
    ...(configOptions === undefined ? {} : { configOptions }),
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

function optionalUsage(value: Record<string, unknown>): RemoteTranscriptUsage | undefined {
  const raw = value['usage']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const numbers: Record<string, number> = {}
  for (const key of ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens',
    'reasoningTokens', 'totalTokens'] as const) {
    const item = record[key]
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0) numbers[key] = item
  }
  if (Object.keys(numbers).length === 0) return undefined
  return numbers as RemoteTranscriptUsage
}

function parseTranscript(value: JsonValue): RemoteTranscriptEntry {
  const record = jsonObject(value, 'transcript entry')
  const nativeFrame = record['nativeFrame']
  const requestId = optionalText(record, 'requestId')
  const usage = optionalUsage(record)
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
    ...(usage === undefined ? {} : { usage }),
  }
}

function parseTranscriptPage(value: JsonValue): RemoteTranscriptPage {
  const record = jsonObject(value, 'transcript page')
  const beforeSeq = record['beforeSeq'] === undefined ? undefined : integerField(record, 'beforeSeq')
  return {
    sessionId: RemoteSessionId(stringField(record, 'sessionId')),
    entries: array(record['entries'], 'entries').map(parseTranscript),
    afterSeq: seqField(record, 'afterSeq'),
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    fromSeq: seqField(record, 'fromSeq'),
    toSeq: seqField(record, 'toSeq'),
    latestSeq: seqField(record, 'latestSeq'),
    hasMore: booleanField(record, 'hasMore'),
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

/** Validate a reviewable Agent installation plan. */
export function parseInstallPlan(value: JsonValue): RemoteInstallPlan {
  const record = jsonObject(value, 'install plan')
  const unavailableReason = optionalText(record, 'unavailableReason')
  const component = stringField(record, 'component')
  if (component !== 'hostd' && !REMOTE_AGENT_BACKENDS.includes(component as RemoteAgentBackend)) {
    throw new Error('install plan has an invalid component')
  }
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

/** Validate one browser-safe long-running management operation. */
export function parseOperation(value: JsonValue): RemoteOperationView {
  const record = jsonObject(value, 'operation')
  const hostId = optionalText(record, 'hostId')
  const current = record['current'] === undefined ? undefined : integerField(record, 'current')
  const total = record['total'] === undefined ? undefined : integerField(record, 'total')
  const finishedAt = optionalText(record, 'finishedAt')
  return {
    operationId: RemoteOperationId(stringField(record, 'operationId')),
    kind: oneOf(record['kind'], ['host-ssh-deploy', 'agent-install'] as const, 'operation.kind'),
    status: oneOf(record['status'], ['queued', 'running', 'succeeded', 'failed'] as const, 'operation.status'),
    phase: oneOf(record['phase'], [
      'queued', 'connecting', 'preparing', 'uploading-hostd', 'starting-hostd',
      'opening-tunnel', 'installing', 'verifying', 'refreshing', 'completed', 'failed',
    ] as const, 'operation.phase'),
    title: stringField(record, 'title'),
    detail: stringField(record, 'detail'),
    target: stringField(record, 'target'),
    cancellable: booleanField(record, 'cancellable'),
    ...(hostId === undefined ? {} : { hostId: RemoteHostId(hostId) }),
    ...(record['backend'] === undefined ? {} : { backend: remoteAgentBackend(record['backend']) }),
    ...(current === undefined ? {} : { current }),
    ...(total === undefined ? {} : { total }),
    startedAt: stringField(record, 'startedAt'),
    updatedAt: stringField(record, 'updatedAt'),
    ...(finishedAt === undefined ? {} : { finishedAt }),
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
    transcript: record['transcript'] === undefined ? [] : array(record['transcript'], 'transcript').map(parseTranscript),
    operations: record['operations'] === undefined ? [] : array(record['operations'], 'operations').map(parseOperation),
    hostdArtifactVersion: optionalText(record, 'hostdArtifactVersion') ?? 'unknown',
    browserId: optionalText(record, 'browserId') ?? 'unknown',
    unreadCounts: parseUnreadCounts(record['unreadCounts']),
  }
}

/** Validate the hidden-items projection returned by `hidden.list`. */
export function parseHiddenItems(value: JsonValue): RemoteHiddenItems {
  const record = jsonObject(value, 'hidden items')
  return {
    hosts: array(record['hosts'], 'hidden.hosts').map(parseHost),
    projects: array(record['projects'], 'hidden.projects').map(parseProject),
    sessions: record['sessions'] === undefined ? [] : array(record['sessions'], 'hidden.sessions').map(parseSession),
  }
}

function parseUnreadCounts(value: JsonValue | undefined): Readonly<Record<string, number>> {
  if (value === undefined) return {}
  const record = jsonObject(value, 'unreadCounts')
  const result: Record<string, number> = {}
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) result[key] = Math.floor(raw)
  }
  return result
}

/** Remote-agent controller with one observable snapshot. Live RPCs go through the WebSocket. */
export class RemoteAgentStore {
  private snapshot: RemoteAgentSnapshot = { phase: 'loading', state: EMPTY_STATE, pending: false }
  private readonly listeners = new Set<() => void>()
  private operationTimer: number | undefined
  private disposed = false
  private requestSerial = 0
  private attachSerial = 0
  private pendingCount = 0
  private followHandler: ((sessionId: string | undefined) => void) | undefined
  private followedSessionId: string | undefined
  private connectionPhase: 'ready' | 'reconnecting' = 'ready'
  private transport: { call(method: string, params: Record<string, JsonValue>): Promise<JsonValue> } | undefined
  private rebuildInFlight = false
  private transcriptWork = 0
  private backgroundQueue: string[] = []
  private backgroundBusy = false
  private liveSyncing = false
  private liveBackoffIndex = 0
  private liveWait: { timer: number; resolve: () => void } | undefined
  private reloadSerial = 0
  private autoArchiveInFlight = false
  private readonly cache: TranscriptCache | null
  /** Prompts interrupted by a transport drop or hostd restart, awaiting automatic redelivery. */
  private redeliverQueue: PendingRedelivery[] = []
  private redeliveryBusy = false
  /** Backoff timer driving redelivery retries while hostd is unreachable. */
  private redeliveryTimer: number | undefined

  /** Emit one trace line for a promptProgress phase transition so devtools
   *  shows the user-visible latency breakdown. Suppressed in test runs. */
  private tracePromptPhase(
    phase: 'connecting' | 'sending' | 'waiting' | 'reconnecting' | 'failed',
    startedAt: number,
    extra: Record<string, unknown> = {},
  ): void {
    // `process` is a Node global that does not exist in the browser, and the
    // client build does not replace `process.env.NODE_ENV` — referencing it bare
    // throws `ReferenceError: process is not defined`, which aborted every
    // prompt/session.start right after publishing the "connecting" state and
    // left the composer permanently disabled. Guard the access so it only skips
    // tracing under the Node test runner and is a no-op in the browser.
    if (typeof process !== 'undefined' && process.env?.['NODE_ENV'] === 'test') return
    const elapsedMs = Number((Date.now() - startedAt).toFixed(1))
    const fields: Record<string, unknown> = { phase, elapsedMs, ...extra }
    const parts = Object.entries(fields)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ')
    // eslint-disable-next-line no-console
    console.debug(`threadharbor-store promptProgress ${parts}`)
  }

  /** Build a controller. Pass `{ cache }` to inject a custom transcript cache
   *  (tests use an in-memory shim) or `{ cache: null }` to disable the cache
   *  entirely. Defaults to a fresh `TranscriptCache` that talks to IndexedDB. */
  constructor(options: { cache?: TranscriptCache | null } = {}) {
    this.cache = options.cache === undefined ? new TranscriptCache() : options.cache
  }

  /** Read the stable current snapshot. */
  getSnapshot = (): RemoteAgentSnapshot => this.snapshot
  /** Subscribe to top-level snapshot replacement. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }


  /** Apply one server-initiated push event to the local snapshot.
   * @param event - decoded push event from the WebSocket channel.
   */
  consume(event: JsonValue): void {
    const record = jsonObject(event, 'push event')
    const type = stringField(record, 'type')
    switch (type) {
      case 'transcript.append': {
        const sessionId = RemoteSessionId(stringField(record, 'sessionId'))
        const entryValue = record['entry']
        if (entryValue === undefined) return
        const entry = parseTranscript(entryValue) as RemoteTranscriptEntry
        this.applyTranscriptEntries(sessionId, [entry])
        return
      }
      case 'transcript.batch': {
        const sessionId = RemoteSessionId(stringField(record, 'sessionId'))
        const entries = array(record['entries'], 'entries').map(parseTranscript) as RemoteTranscriptEntry[]
        this.applyTranscriptEntries(sessionId, entries)
        return
      }
      case 'operation.progress': {
        this.scheduleOperationPoll(0)
        return
      }
      case 'session.view.changed': {
        // Upsert the session row in place. session.start returns before the
        // local catalog has the row; reloading here would leave a gap where
        // the UI has neither the draft placeholder nor the new session.
        const sessionValue = record['session']
        if (sessionValue === undefined) { void this.reload(); return }
        const session = parseSession(sessionValue) as RemoteSessionView
        const nextState = withSessionView(this.snapshot.state, session)
        const promptProgress = this.reconcilePromptProgress(nextState, { ...this.snapshot, state: nextState })
        const adopted = inFlightCreatedSessionId(
          nextState, this.snapshot.draftSession, this.snapshot.promptProgress, this.snapshot.currentSessionId,
        )
        const { promptProgress: _cleared, draftSession: _draft, ...rest } = {
          ...withoutError(this.snapshot), state: nextState,
        }
        const keepDraft = this.snapshot.draftSession !== undefined && adopted === undefined
        this.publish({
          ...rest,
          ...(promptProgress === undefined ? {} : { promptProgress }),
          ...(keepDraft ? { draftSession: this.snapshot.draftSession } : {}),
          ...(adopted === undefined ? {} : { currentSessionId: adopted }),
        })
        const priority = session.sessionId === (adopted ?? this.snapshot.currentSessionId) ? 'high' : 'low'
        void this.catchupTranscript(session.sessionId, priority)
        if (priority === 'high') this.ensureLiveTranscriptSync()
        return
      }
      case 'session.progress': {
        // The gateway relays each session.start hostd stage as a push so the
        // UI can show which remote step is currently in flight (spawn hold →
        // initialize agent → bind native session → prompt delivered).
        const sessionId = RemoteSessionId(stringField(record, 'sessionId'))
        const message = stringField(record, 'message')
        const progress = this.snapshot.promptProgress
        if (progress?.sessionId === sessionId
          && (progress.phase === 'connecting' || progress.phase === 'sending')) {
          const { message: _previousMessage, ...rest } = progress
          this.publish({
            ...withoutError(this.snapshot),
            promptProgress: { ...rest, message },
            pending: this.snapshot.pending,
          })
        }
        return
      }
      case 'session.followed': {
        const sessionId = RemoteSessionId(stringField(record, 'sessionId'))
        void this.catchupTranscript(sessionId, 'high')
        return
      }
      case 'session.unfollowed':
      case 'transcript.gap':
      case 'host.changed':
      case 'project.changed':
        void this.reload()
        return
      default:
        return
    }
  }

  private applyTranscriptEntries(
    sessionId: ReturnType<typeof RemoteSessionId>,
    entries: readonly RemoteTranscriptEntry[],
    options?: { readonly countUnread?: boolean },
  ): void {
    if (entries.length === 0) return
    const current = this.snapshot.state
    const existingIds = new Set(current.transcript.map(entry => entry.transcriptId))
    const freshEntries = entries.filter(entry => !existingIds.has(entry.transcriptId))
    if (freshEntries.length === 0) return
    const nextTranscript = [...current.transcript, ...freshEntries]
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq)
    const countUnread = options?.countUnread === true && sessionId !== this.snapshot.currentSessionId
    const unread = current.unreadCounts[sessionId] ?? 0
    const nextState = {
      ...current,
      transcript: nextTranscript,
      unreadCounts: countUnread
        ? { ...current.unreadCounts, [sessionId]: unread + freshEntries.length }
        : current.unreadCounts,
    }
    const nextSnapshot = {
      ...withoutError(this.snapshot),
      state: nextState,
      ...(this.snapshot.phase === 'error' && this.connectionPhase === 'ready' ? { phase: 'ready' as const } : {}),
    }
    const promptProgress = this.reconcilePromptProgress(nextState, { ...this.snapshot, state: nextState })
    const { promptProgress: _cleared, ...rest } = nextSnapshot
    this.publish(promptProgress === undefined ? rest : { ...rest, promptProgress })
    if (sessionId === this.snapshot.currentSessionId) this.liveBackoffIndex = 0
    this.drainQueuedPromptIfIdle()
    // Fire-and-forget cache write. `putEntries` is synchronous and dedupes
    // by transcriptId, so the optimistic local user bubble, the WebSocket
    // push, and the HTTP catchup all converge on the same cache row without
    // extra coordination.
    this.writeCache(sessionId, freshEntries)
  }

  /** Best-effort cache write. Never throws — the cache layer itself swallows
   *  IDB errors and reports them on its own event channel. */
  private writeCache(
    sessionId: ReturnType<typeof RemoteSessionId>,
    entries: readonly RemoteTranscriptEntry[],
  ): void {
    if (this.cache === null || entries.length === 0) return
    try {
      this.cache.putEntries(sessionId, entries)
    } catch {
      // Cache must never break the live flow.
    }
  }

  /** Mark a session's transcript as read; zeros its unread counter. */
  markRead(sessionId: ReturnType<typeof RemoteSessionId>): void {
    const current = this.snapshot.state
    if ((current.unreadCounts[sessionId] ?? 0) === 0) return
    const { [sessionId]: _cleared, ...rest } = current.unreadCounts
    void _cleared
    this.publish({ ...withoutError(this.snapshot), state: { ...current, unreadCounts: rest } })
  }

  /** Update the connection phase (driven by the WebSocket transport). */
  setPhase(phase: 'loading' | 'ready' | 'reconnecting' | 'error'): void {
    const becameReady = phase === 'ready'
      && (this.connectionPhase === 'reconnecting' || this.snapshot.phase === 'reconnecting')
    if (phase === 'ready' || phase === 'reconnecting') this.connectionPhase = phase
    if (this.snapshot.phase !== phase) {
      this.publish({ ...withoutError(this.snapshot), phase })
      if (phase === 'reconnecting') this.rebuildFromHttp()
    }
    if (!becameReady) return
    this.liveBackoffIndex = 0
    if (this.liveWait !== undefined) {
      window.clearTimeout(this.liveWait.timer)
      const resolve = this.liveWait.resolve
      this.liveWait = undefined
      resolve()
    }
    void this.pumpPromptRedeliveries()
    const current = this.snapshot.currentSessionId
    if (current === undefined) return
    void this.catchupTranscript(current, 'high')
    this.ensureLiveTranscriptSync()
  }

  /** Route live RPCs through the WebSocket; tests omit this and keep using fetch. */
  setTransport(transport: { call(method: string, params: Record<string, JsonValue>): Promise<JsonValue> }): void {
    this.transport = transport
  }

  /** Receive the live-channel follow hook so selecting a session does not HTTP-poll. */
  setFollowHandler(handler: (sessionId: string | undefined) => void): void {
    this.followHandler = handler
    handler(this.snapshot.currentSessionId)
  }

  /** Load the durable catalog. Journal updates arrive over the live WebSocket. */
  async start(): Promise<void> {
    try {
      await this.reload()
      // Hydrate every catalog session from the local cache before the first
      // HTTP catchup so a refreshed tab can render prior content immediately.
      // Cache failures are logged by the cache itself and never bubble up.
      await this.warmCacheFromLocal()
      const hosts = this.snapshot.state.hosts.filter(host => host.inventory === undefined)
      if (hosts.length > 0) {
        await Promise.all(hosts.map(host => this.refreshInventory(host.hostId).catch(() => undefined)))
      }
      const current = this.snapshot.currentSessionId
      if (current !== undefined) {
        await this.catchupTranscript(current, 'high')
        void this.backfillOpenedTranscript(current, this.transcriptWork)
      }
      this.queueBackgroundTranscripts()
      this.ensureLiveTranscriptSync()
    } catch (error) {
      this.publish({ ...this.snapshot, phase: 'error', error: String(error) })
    }
  }

  /** Stop timers and ignore later in-flight completions. */
  dispose(): void {
    this.disposed = true
    this.redeliverQueue = []
    if (this.redeliveryTimer !== undefined) window.clearTimeout(this.redeliveryTimer)
    this.redeliveryTimer = undefined
    this.transcriptWork += 1
    this.backgroundQueue = []
    if (this.operationTimer !== undefined) window.clearTimeout(this.operationTimer)
    this.operationTimer = undefined
    if (this.liveWait !== undefined) {
      window.clearTimeout(this.liveWait.timer)
      const resolve = this.liveWait.resolve
      this.liveWait = undefined
      resolve()
    }
    this.listeners.clear()
    if (this.cache !== null) {
      try { this.cache.dispose() } catch { /* dispose must never throw */ }
    }
  }

  /** Select a session for the live conversation. Existing transcript is shown immediately;
   * the WebSocket follow loop attaches and pushes new frames without a blocking round-trip.
   * @param sessionId - catalog session to select.
   */
  async selectSession(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    this.attachSerial += 1
    this.transcriptWork += 1
    const { draftSession: _draftSession, panel: _panel, attachingSessionId: _attaching, queuedPrompt: _queuedPrompt, ...snapshot } = withoutError(this.snapshot)
    void _queuedPrompt
    this.publish({ ...snapshot, currentSessionId: sessionId })
    this.markRead(sessionId)
    const promptProgress = this.reconcilePromptProgress(this.snapshot.state)
    if (promptProgress !== this.snapshot.promptProgress) {
      const { promptProgress: _cleared, ...rest } = this.snapshot
      this.publish(promptProgress === undefined ? rest : { ...rest, promptProgress })
    }
    this.liveBackoffIndex = 0
    await this.catchupTranscript(sessionId, 'high')
    void this.backfillOpenedTranscript(sessionId, this.transcriptWork)
    this.queueBackgroundTranscripts()
    this.ensureLiveTranscriptSync()
  }

  /** Open an unsaved conversation placeholder. The Agent is chosen at first send. */
  startSessionDraft(projectId: ReturnType<typeof RemoteProjectId>): void {
    const { currentSessionId: _currentSessionId, panel: _panel, promptProgress: _promptProgress, ...snapshot } = withoutError(this.snapshot)
    this.publish({ ...snapshot, draftSession: { projectId, title: '新会话' } })
  }

  /** Show a browser-local operation panel without mutating the durable catalog.
   * @param panel - operation surface to render in the main area.
   */
  showPanel(panel: RemoteAgentPanel): void {
    const { currentSessionId: _currentSessionId, draftSession: _draftSession, ...snapshot } = withoutError(this.snapshot)
    this.publish({ ...snapshot, panel })
  }

  /** Close the current operation panel and return to the selected session or welcome surface. */
  closePanel(): void {
    const { panel: _panel, ...snapshot } = withoutError(this.snapshot)
    this.publish(snapshot)
  }

  /** Load hidden hosts/projects and archived sessions for the settings panel. */
  async loadHiddenItems(): Promise<void> {
    const items = await this.run(async () => parseHiddenItems(await this.call('hidden.list', {})))
    this.publish({ ...withoutError(this.snapshot), hiddenItems: items })
  }

  /** Add a loopback/SSH-forwarded hostd endpoint.
   * @param title - browser-visible host name.
   * @param endpoint - credential-free loopback HTTP endpoint.
   */
  addHost(title: string, endpoint: string): Promise<void> {
    return this.mutate('host.add', { title, endpoint })
  }

  /** Update one catalogued host to use a loopback hostd endpoint.
   * @param hostId - catalogued host to update.
   * @param title - browser-visible host name.
   * @param endpoint - credential-free loopback HTTP endpoint.
   */
  updateHost(hostId: ReturnType<typeof RemoteHostId>, title: string, endpoint: string): Promise<void> {
    return this.mutate('host.update', { hostId, title, endpoint })
  }

  /** Update only a host's browser-visible name without reconnecting or redeploying it. */
  updateHostTitle(hostId: ReturnType<typeof RemoteHostId>, title: string): Promise<void> {
    return this.mutate('host.update', { hostId, title })
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
  deploySshHost(title: string, ssh: RemoteSshConfig): Promise<RemoteOperationView> {
    return this.startOperation({ kind: 'host-ssh-deploy', title, ssh: ssh as unknown as JsonValue, confirm: true })
  }

  /** Add an SSH host immediately; hostd deploys in the background (trust-on-first-use).
   *
   * The host is catalogued as soon as this resolves — connectivity and
   * deployment run afterward and never block the add. A failed deploy leaves
   * the host with `deployState: 'failed'` for the user to retry.
   * @param title - browser-visible host name.
   * @param ssh - SSH connection fields (no fingerprint needed).
   */
  addSshHost(title: string, ssh: Omit<RemoteSshConfig, 'hostKeyFingerprint'>): Promise<void> {
    return this.mutate('host.ssh.add', { title, ssh: ssh as unknown as JsonValue })
  }

  /** Re-run the background deploy for a catalogued SSH host (retry after failure). */
  redeploySshHost(hostId: ReturnType<typeof RemoteHostId>): Promise<RemoteOperationView> {
    return this.run(async () => parseOperation(await this.call('host.ssh.redeploy', { hostId })))
  }

  /** Redeploy and update one catalogued SSH host after its fingerprint is approved.
   * @param hostId - catalogued host to update.
   * @param title - browser-visible host name.
   * @param ssh - approved SSH fields and fingerprint.
   */
  updateSshHost(hostId: ReturnType<typeof RemoteHostId>, title: string, ssh: RemoteSshConfig): Promise<RemoteOperationView> {
    return this.startOperation({ kind: 'host-ssh-deploy', hostId, title, ssh: ssh as unknown as JsonValue, confirm: true })
  }

  /** Upgrade hostd: SSH hosts redeploy (trust-on-first-use); loopback endpoint hosts restart the local process. */
  upgradeHostd(hostId: ReturnType<typeof RemoteHostId>): Promise<RemoteOperationView | void> {
    const host = this.snapshot.state.hosts.find(candidate => candidate.hostId === hostId)
    if (host?.ssh !== undefined) return this.redeploySshHost(hostId)
    return this.mutate('host.upgrade', { hostId, confirm: true })
  }

  /** Fetch a non-mutating agent installation plan.
   * @param hostId - target host.
   * @param backend - agent to install.
   * @returns exact configured plan.
   */
  installPlan(hostId: ReturnType<typeof RemoteHostId>, backend: RemoteAgentBackend): Promise<RemoteInstallPlan> {
    return this.run(async () => parseInstallPlan(await this.call('agent.install.plan', { hostId, backend })))
  }

  /** Execute a confirmed predeclared agent installer on the target host.
   * @param hostId - target host.
   * @param backend - agent to install.
   */
  installAgent(hostId: ReturnType<typeof RemoteHostId>, backend: RemoteAgentBackend): Promise<RemoteOperationView> {
    return this.startOperation({ kind: 'agent-install', hostId, backend, confirm: true })
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

  /** Persist a DSH API key without ever reading the saved value back into the browser.
   * @param hostId - target host.
   * @param apiKey - replacement DeepSeek API key.
   */
  setDshApiKey(hostId: ReturnType<typeof RemoteHostId>, apiKey: string): Promise<void> {
    return this.mutate('agent.credential.set', { hostId, apiKey })
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

  /** Retry reaching hostd on one catalogued host and fail if it is still unreachable. */
  async reconnectHost(hostId: ReturnType<typeof RemoteHostId>): Promise<void> {
    await this.refreshInventory(hostId)
    const host = this.snapshot.state.hosts.find(candidate => candidate.hostId === hostId)
    if (host?.inventoryError !== undefined) throw new Error(host.inventoryError)
  }

  /** Re-attach one catalogued session after the remote hold dropped. */
  async reconnectSession(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    await this.run(async () => {
      try {
        await this.call('session.attach', { sessionId })
      } catch (error) {
        // Explicit reopen: propagate the raw hostd/gateway reason (including
        // `[th-fix:...]` markers) instead of collapsing it into the generic
        // "click reopen again" hint — that is exactly what this call is doing.
        throw error instanceof Error ? error : new Error(String(error))
      }
      await this.reload(sessionId)
      await this.catchupTranscript(sessionId, 'high')
      this.ensureLiveTranscriptSync()
    })
  }

  /** Owning host of a catalogued session (session → project → host). */
  private requireSessionHostId(sessionId: ReturnType<typeof RemoteSessionId>): ReturnType<typeof RemoteHostId> {
    const session = this.snapshot.state.sessions.find(candidate => candidate.sessionId === sessionId)
    if (session === undefined) throw new Error('unknown session')
    const project = this.snapshot.state.projects.find(candidate => candidate.projectId === session.projectId)
    if (project === undefined) throw new Error('unknown session project')
    return project.hostId
  }

  /** Read-only Grok serve diagnostics for the session's host (never secret values). */
  async inspectGrokServe(sessionId: ReturnType<typeof RemoteSessionId>): Promise<Record<string, JsonValue>> {
    const result = await this.call('grok.serve.inspect', { hostId: this.requireSessionHostId(sessionId) })
    return jsonObject(result, 'grok.serve.inspect result') as unknown as Record<string, JsonValue>
  }

  /**
   * Confirm-to-fix for a failed session reopen: run the hostd repair (`adopt`
   * is non-destructive, `restart` stops the Grok serve and starts a fresh one)
   * and then re-attempt the reopen automatically. Failures reject with the
   * repair reason so the UI can keep explaining.
   */
  async repairGrokServe(
    sessionId: ReturnType<typeof RemoteSessionId>,
    action: 'adopt' | 'restart',
  ): Promise<void> {
    await this.run(async () => {
      await this.call(action === 'adopt' ? 'grok.serve.adopt' : 'grok.serve.restart', {
        hostId: this.requireSessionHostId(sessionId),
      })
    })
    await this.reconnectSession(sessionId)
  }

  /**
   * Force-restart a session whose Agent stopped responding (user confirmed in
   * the UI): the gateway asks hostd to stop the hold worker/backend process
   * and reopen the same session id with its native session reloaded.
   */
  async forceRestartSession(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    await this.run(async () => {
      try {
        await this.call('session.restart', { sessionId })
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error))
      }
      await this.reload(sessionId)
      await this.catchupTranscript(sessionId, 'high')
      this.ensureLiveTranscriptSync()
    })
  }

  /** Register one remote directory as a host-owned project.
   * @param hostId - owning host.
   * @param title - browser-visible project name.
   * @param cwd - host-local directory.
   */
  createProject(hostId: ReturnType<typeof RemoteHostId>, title: string, cwd: string): Promise<void> {
    return this.mutate('project.create', { hostId, title, cwd })
  }

  /** Rename one browser-catalogued project without touching its remote directory. */
  renameProject(projectId: ReturnType<typeof RemoteProjectId>, title: string): Promise<void> {
    return this.mutate('project.rename', { projectId, title })
  }

  /** List one host directory without exposing host credentials to the browser.
   * @param hostId - host on which the directory exists.
   * @param path - host-local directory to list.
   * @returns the bounded directory listing.
   */
  listDirectory(hostId: ReturnType<typeof RemoteHostId>, path?: string): Promise<RemoteDirectoryListing> {
    return this.run(async () => parseDirectoryListing(await this.call('fs.list', {
      hostId,
      ...(path === undefined || path.trim() === '' ? {} : { path: path.trim() }),
    })))
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
      const nextState = withSessionView(this.snapshot.state, session)
      this.publish({ ...withoutError(this.snapshot), state: nextState, currentSessionId: session.sessionId })
      await this.reload(session.sessionId)
    }, true)
  }

  /**
   * Submit the visible draft's first message together with `session.start`.
   * The gateway acknowledges immediately (connecting row) and drives hold
   * startup in the background, delivering the first message automatically once
   * the remote session is bound. The browser performs a single RPC: the UI
   * moves to `sending` as soon as the message is accepted, and each remote
   * stage (`session.progress`) is shown until backend events take over.
   * Once the Agent starts, the Agent cannot be changed even when prompt
   * delivery subsequently reports an error.
   */
  async promptSessionDraft(backend: RemoteAgentBackend, text: string): Promise<void> {
    const draft = this.snapshot.draftSession
    if (draft === undefined) throw new Error('no new-session draft is active')
    const clientId = this.clientId()
    const requestId = `${clientId}-${Date.now()}-${++this.requestSerial}`
    const startedAt = Date.now()
    this.publish({
      ...withoutError(this.snapshot),
      promptProgress: { projectId: draft.projectId, phase: 'connecting', startedAt, baselineSeq: -1 },
    })
    this.tracePromptPhase('connecting', startedAt, { projectId: draft.projectId })
    try {
      await this.run(async () => {
        const result = await this.call('session.start', {
          projectId: draft.projectId,
          title: promptTitle(text),
          backend,
          text,
          clientId,
          requestId,
        })
        const session = parseSession(result)
        const nextState = withSessionView(this.snapshot.state, session)
        // The gateway accepts the message in the same RPC, so the UI can stop
        // showing a bare "connecting" the moment the session row exists: the
        // hold is being created and the first prompt is queued for auto-delivery.
        const sending: RemotePromptProgress = {
          projectId: draft.projectId,
          sessionId: session.sessionId,
          phase: 'sending',
          startedAt,
          baselineSeq: -1,
          message: '消息已提交，正在建立远程会话',
        }
        const { draftSession: _draftSession, panel: _panel, ...snapshot } = withoutError(this.snapshot)
        this.publish({
          ...snapshot,
          state: nextState,
          currentSessionId: session.sessionId,
          promptProgress: sending,
          pending: true,
        })
        this.tracePromptPhase('sending', startedAt, { sessionId: session.sessionId, stage: 'rpcReturned' })
        this.applyTranscriptEntries(session.sessionId, [{
          transcriptId: RemoteTranscriptId(`user:${session.sessionId}:${clientId}:${requestId}`),
          sessionId: session.sessionId,
          seq: 0,
          role: 'user',
          kind: 'message',
          text,
          requestId,
          createdAt: new Date().toISOString(),
        }])
        this.liveBackoffIndex = 0
        await this.catchupTranscript(session.sessionId, 'high')
        this.ensureLiveTranscriptSync()
        // Wait for the remote session to open. The gateway auto-delivers the
        // first message once the hold is bound, so no second session.prompt RPC
        // is issued here; failure surfaces as a lost/failed row or a delivery
        // failure status entry that reconcilePromptProgress turns into `failed`.
        await this.awaitSessionOpen(session.sessionId)
        this.tracePromptPhase('sending', startedAt, { sessionId: session.sessionId, stage: 'holdOpen' })
        try {
          await this.reload(session.sessionId)
        } finally {
          void this.catchupTranscript(session.sessionId, 'high')
        }
        const current = this.snapshot.state.sessions.find(candidate => candidate.sessionId === session.sessionId)
        if (current?.turnState === 'running') {
          this.publish({ ...withoutError(this.snapshot), promptProgress: { ...sending, phase: 'waiting' } })
          this.tracePromptPhase('waiting', startedAt, { sessionId: session.sessionId })
        } else if (current?.turnState === 'failed' || current?.channelState === 'lost') {
          const failedMessage = this.snapshot.error
            ?? (current.channelState === 'lost' ? '远程会话已丢失，可以点「在当前会话重开」再试。' : '消息未能送达远程 Agent。')
          this.publish({
            ...withoutError(this.snapshot),
            promptProgress: { ...sending, phase: 'failed', message: failedMessage },
          })
          this.tracePromptPhase('failed', startedAt, { sessionId: session.sessionId, message: failedMessage })
        } else {
          const { promptProgress: _promptProgress, ...snapshot } = withoutError(this.snapshot)
          this.publish(snapshot)
        }
      }, true)
    } catch (error) {
      const progress = this.snapshot.promptProgress
      this.publish({
        ...this.snapshot,
        promptProgress: {
          projectId: draft.projectId,
          ...(progress?.sessionId === undefined ? {} : { sessionId: progress.sessionId }),
          phase: 'failed', startedAt, baselineSeq: progress?.baselineSeq ?? -1, message: errorText(error),
        },
      })
      this.tracePromptPhase('failed', startedAt, { message: errorText(error) })
      throw error
    }
  }

  /** Wait until the snapshot's session view reports an active binding, or fail
   * loudly if the session gets marked lost/failed within the wait window. */
  private awaitSessionOpen(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    const start = this.snapshot.state.sessions.find(candidate => candidate.sessionId === sessionId)
    if (start?.channelState === 'open') return Promise.resolve()
    if (start?.channelState === 'lost' || start?.turnState === 'failed') {
      return Promise.reject(new Error('远程会话建立失败，请重试'))
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        window.clearInterval(poll)
        unsubscribe()
        fn()
      }
      // Resolve/reject purely from the observed session row, whether it was
      // updated by a live push OR by the poll below.
      const check = (): void => {
        const session = this.snapshot.state.sessions.find(candidate => candidate.sessionId === sessionId)
        if (session?.channelState === 'open') finish(resolve)
        else if (session?.channelState === 'lost' || session?.turnState === 'failed') {
          finish(() => reject(new Error('远程会话建立失败，请重试')))
        }
      }
      const timer = window.setTimeout(() => { finish(() => reject(new Error('远程会话建立超时'))) }, SESSION_OPEN_TIMEOUT_MS)
      const unsubscribe = this.subscribe(check)
      // Poll fallback: the `session.view` open/running push can be missed when
      // the WS drops or Chrome freezes a backgrounded tab. Reload the catalog
      // (HTTP fallback when the socket is down) so the create is never stranded
      // on "正在建立远程会话" waiting for a push that already fired.
      const poll = window.setInterval(() => {
        void this.reload(sessionId).then(() => check()).catch(() => undefined)
      }, SESSION_OPEN_POLL_MS)
    })
  }

  /** Forward one prompt; if the hold is dead, re-attach once and retry the same request. */
  private async deliverPrompt(
    sessionId: ReturnType<typeof RemoteSessionId>,
    clientId: string,
    requestId: string,
    text: string,
  ): Promise<void> {
    try {
      await this.call('session.prompt', { sessionId, clientId, requestId, text })
    } catch (error) {
      if (!isSessionHoldFailure(error)) throw error
      try {
        await this.call('session.attach', { sessionId })
      } catch (attachError) {
        throw new Error(describeSessionReconnectFailure(attachError))
      }
      await this.call('session.prompt', { sessionId, clientId, requestId, text })
    }
  }

  /** Admit one prompt with a stable browser identity and request id.
   * @param sessionId - root session receiving the prompt.
   * @param text - user text forwarded unchanged.
   */
  async prompt(sessionId: ReturnType<typeof RemoteSessionId>, text: string): Promise<void> {
    const clientId = this.clientId()
    const requestId = `${clientId}-${Date.now()}-${++this.requestSerial}`
    const session = this.snapshot.state.sessions.find(candidate => candidate.sessionId === sessionId)
    if (session === undefined) throw new Error(`unknown session ${sessionId}`)
    const baselineSeq = lastTranscriptSeq(this.snapshot.state, sessionId)
    // Optimistic local user bubble so Send feels instantaneous. The transcriptId
    // matches `promptSessionDraft`'s shape so the gateway can echo the same id
    // and `applyTranscriptEntries` will dedup the eventual server-side push.
    this.applyTranscriptEntries(sessionId, [{
      transcriptId: RemoteTranscriptId(`user:${sessionId}:${clientId}:${requestId}`),
      sessionId,
      seq: baselineSeq + 1,
      role: 'user',
      kind: 'message',
      text,
      requestId,
      createdAt: new Date().toISOString(),
    }])
    const progress: RemotePromptProgress = {
      projectId: session.projectId,
      sessionId,
      phase: 'sending',
      startedAt: Date.now(),
      baselineSeq,
    }
    this.publish({ ...withoutError(this.snapshot), promptProgress: progress })
    this.tracePromptPhase('sending', progress.startedAt, { sessionId })
    this.liveBackoffIndex = 0
    this.ensureLiveTranscriptSync()
    try {
      await this.run(async () => {
        await this.deliverPrompt(sessionId, clientId, requestId, text)
        // Admission accepted. Leave "正在发送" immediately — the turn's transcript
        // and its idle/failed conclusion arrive over the live push stream, so the
        // header must not block on the tunnel-bound reload+catchup below (a busy
        // host used to strand this on "正在把请求提交到远程 Agent"). reconcile-
        // PromptProgress clears this 'waiting' once the session goes idle or a
        // backend event lands.
        this.publish({ ...withoutError(this.snapshot), promptProgress: { ...progress, phase: 'waiting' } })
        this.tracePromptPhase('waiting', progress.startedAt, { sessionId })
        this.ensureLiveTranscriptSync()
        // Reconcile catalog + transcript in the background; never block the UI
        // transition on it.
        void this.reload(sessionId)
          .then(() => this.catchupTranscript(sessionId, 'high'))
          .catch(() => undefined)
      }, true)
    } catch (error) {
      if (isRedeliverableError(error)) {
        // Either the socket dropped before the gateway answered (web restart),
        // or the gateway reached us but the remote hostd was momentarily
        // unreachable (hostd restart/redeploy). In both cases the prompt was not
        // admitted, so keep the optimistic bubble and redeliver the same request
        // automatically once the far side is back — instead of failing silently
        // and losing the message.
        this.queuePromptRedelivery({
          sessionId, projectId: progress.projectId, clientId, requestId, text,
          baselineSeq, startedAt: progress.startedAt, attempts: 0,
        })
        const message = isTransportDropError(error)
          ? '通道已断开，正在等待重连后自动重发。'
          : '远端 hostd 暂时不可用，正在自动重试发送。'
        this.publish({
          ...withoutError(this.snapshot),
          promptProgress: { ...progress, phase: 'sending', message },
        })
        this.tracePromptPhase('sending', progress.startedAt, { sessionId, stage: 'queuedForRedelivery' })
        return
      }
      this.publish({
        ...this.snapshot,
        promptProgress: { ...progress, phase: 'failed', message: errorText(error) },
      })
      this.tracePromptPhase('failed', progress.startedAt, { sessionId, message: errorText(error) })
      throw error
    }
  }

  /** Park an undelivered prompt for automatic redelivery once the channel is live. */
  private queuePromptRedelivery(entry: PendingRedelivery): void {
    if (this.disposed) return
    if (this.redeliverQueue.some(existing => existing.requestId === entry.requestId)) return
    this.redeliverQueue.push(entry)
    void this.pumpPromptRedeliveries()
  }

  /** Re-pump the redelivery queue after a backoff, for the hostd-unreachable
   *  case where the live socket won't otherwise wake us. Coalesced: a single
   *  pending timer covers the whole queue. */
  private scheduleRedeliveryRetry(): void {
    if (this.disposed || this.redeliveryTimer !== undefined) return
    this.redeliveryTimer = window.setTimeout(() => {
      this.redeliveryTimer = undefined
      void this.pumpPromptRedeliveries()
    }, REDELIVERY_BACKOFF_MS)
  }

  /** Redeliver queued prompts in order once the socket is live again.
   *  Drops entries whose session the user left, and gives up (surfacing a
   *  failed progress) after bounded attempts or wall-clock age. */
  private async pumpPromptRedeliveries(): Promise<void> {
    if (this.disposed || this.redeliveryBusy || this.connectionPhase !== 'ready') return
    const current = this.snapshot.currentSessionId
    if (this.redeliverQueue.some(entry => entry.sessionId !== current)) {
      this.redeliverQueue = this.redeliverQueue.filter(entry => entry.sessionId === current)
      if (this.redeliverQueue.length === 0) return
    }
    const entry = this.redeliverQueue[0]
    if (entry === undefined) return
    if (Date.now() - entry.startedAt > REDELIVERY_MAX_AGE_MS || entry.attempts >= REDELIVERY_MAX_ATTEMPTS) {
      this.redeliverQueue.shift()
      this.publish({
        ...withoutError(this.snapshot),
        promptProgress: {
          projectId: entry.projectId, sessionId: entry.sessionId, phase: 'failed',
          startedAt: entry.startedAt, baselineSeq: entry.baselineSeq,
          message: '多次重连仍未送达，请点击「重发」再试。',
        },
      })
      this.tracePromptPhase('failed', entry.startedAt, { sessionId: entry.sessionId, stage: 'redeliveryGaveUp' })
      void this.pumpPromptRedeliveries()
      return
    }
    this.redeliveryBusy = true
    let redelivered = false
    try {
      await this.call('session.prompt', {
        sessionId: entry.sessionId, clientId: entry.clientId, requestId: entry.requestId, text: entry.text,
      })
      redelivered = true
    } catch (error) {
      if (isTransportDropError(error)) {
        // The socket is down; the reconnect (setPhase 'ready') re-pumps us.
        entry.attempts += 1
        this.tracePromptPhase('sending', entry.startedAt, {
          sessionId: entry.sessionId, stage: 'redeliveryDeferred', attempts: entry.attempts,
        })
      } else if (isHoldUnreachableError(error)) {
        // hostd is momentarily unreachable (restart/redeploy) but the socket is
        // live, so nothing else will re-pump us — retry on a backoff timer,
        // bounded by the age window checked at the top of the loop (not the
        // reconnect attempt cap, which a fast timer would exhaust in seconds).
        this.tracePromptPhase('sending', entry.startedAt, {
          sessionId: entry.sessionId, stage: 'redeliveryBackoff',
        })
        this.scheduleRedeliveryRetry()
      } else {
        this.redeliverQueue.shift()
        this.publish({
          ...withoutError(this.snapshot),
          promptProgress: {
            projectId: entry.projectId, sessionId: entry.sessionId, phase: 'failed',
            startedAt: entry.startedAt, baselineSeq: entry.baselineSeq,
            message: `自动重发失败：${errorText(error)}`,
          },
        })
        this.tracePromptPhase('failed', entry.startedAt, { sessionId: entry.sessionId, stage: 'redeliveryFailed' })
        void this.pumpPromptRedeliveries()
      }
    } finally {
      this.redeliveryBusy = false
    }
    if (!redelivered) return
    this.redeliverQueue.shift()
    await this.reload(entry.sessionId)
    void this.catchupTranscript(entry.sessionId, 'high')
    this.ensureLiveTranscriptSync()
    const progress = this.snapshot.promptProgress
    if (progress !== undefined && progress.sessionId === entry.sessionId) {
      const current = this.snapshot.state.sessions.find(candidate => candidate.sessionId === entry.sessionId)
      if (current?.turnState === 'running') {
        this.publish({
          ...withoutError(this.snapshot),
          promptProgress: { ...progress, phase: 'waiting' },
        })
        this.tracePromptPhase('waiting', entry.startedAt, { sessionId: entry.sessionId, stage: 'redelivered' })
      } else {
        const { promptProgress: _cleared, ...rest } = this.snapshot
        this.publish(rest)
      }
    }
    void this.pumpPromptRedeliveries()
  }

  /** Park the next user message locally while a previous turn is still in flight.
   *  The result renders as a "queued" bubble in the conversation; the browser
   *  drains the slot automatically once `promptProgress` settles to `undefined`.
   * @param sessionId - target session that will receive the prompt.
   * @param text - user text forwarded unchanged once drained.
   */
  enqueuePrompt(sessionId: ReturnType<typeof RemoteSessionId>, text: string): void {
    const session = this.snapshot.state.sessions.find(candidate => candidate.sessionId === sessionId)
    if (session === undefined) throw new Error(`unknown session ${sessionId}`)
    const trimmed = text.trim()
    if (trimmed === '') return
    const clientId = this.clientId()
    const queuedAt = Date.now()
    const queued: RemoteQueuedPrompt = {
      sessionId,
      text: trimmed,
      requestId: `${clientId}-${queuedAt}-${++this.requestSerial}-q`,
      queuedAt,
    }
    const { queuedPrompt: _drop, ...snapshot } = withoutError(this.snapshot)
    void _drop
    this.publish({ ...snapshot, queuedPrompt: queued })
    this.drainQueuedPromptIfIdle()
  }

  /** Drop the browser-local queued bubble without sending anything. */
  cancelQueuedPrompt(): void {
    if (this.snapshot.queuedPrompt === undefined) return
    const { queuedPrompt: _drop, ...snapshot } = withoutError(this.snapshot)
    void _drop
    this.publish(snapshot)
    this.drainQueuedPromptIfIdle()
  }

  /** When the live turn just settled, fire the queued slot through `prompt`. */
  private drainQueuedPromptIfIdle(): void {
    if (this.disposed) return
    const queued = this.snapshot.queuedPrompt
    if (queued === undefined) return
    const live = this.snapshot.promptProgress
    const liveBusyFor = live?.sessionId === queued.sessionId
      && live.phase !== 'failed'
      && live.phase !== 'reconnecting'
    if (liveBusyFor) return
    const current = this.snapshot.currentSessionId
    // Belt-and-braces: if the user has switched sessions in the meantime, drop.
    if (current !== queued.sessionId) {
      const { queuedPrompt: _drop, ...snapshot } = withoutError(this.snapshot)
      void _drop
      this.publish(snapshot)
      return
    }
    const { queuedPrompt: _drop, ...snapshot } = withoutError(this.snapshot)
    void _drop
    const text = queued.text
    this.publish(snapshot)
    void this.prompt(queued.sessionId, text).catch(() => undefined)
  }

  /** Cancel the selected backend-native turn.
   * @param sessionId - session whose current work should stop.
   */
  cancel(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    return this.mutate('session.cancel', { sessionId })
  }

  /** Rename one browser-catalogued session without touching its remote hold. */
  renameSession(sessionId: ReturnType<typeof RemoteSessionId>, title: string): Promise<void> {
    return this.mutate('session.rename', { sessionId, title })
  }

  /** Hide one browser-catalogued session from the normal session tree while preserving data.
   * The session is dropped from the sidebar immediately; if it was the current session, the
   * most-recent sibling session under the same project is selected, or — if no siblings
   * remain — a fresh draft is opened so the user lands on the create-session surface.
   */
  async archiveSession(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    const target = this.snapshot.state.sessions.find(candidate => candidate.sessionId === sessionId)
    if (target === undefined) {
      // Session is not in the local snapshot (already hidden on the server or never visible);
      // fall back to the plain mutate so the server side still records the archive.
      await this.mutate('session.archive', { sessionId })
      return
    }
    const wasCurrent = this.snapshot.currentSessionId === sessionId
    const projectId = target.projectId
    await this.run(async () => {
      await this.call('session.archive', { sessionId })
    })
    const remaining = this.snapshot.state.sessions.filter(candidate => candidate.sessionId !== sessionId)
    if (wasCurrent) {
      // Pick the most-recent sibling under the same project so the user stays in context.
      const siblings = remaining
        .filter(candidate => candidate.projectId === projectId)
        .slice()
        .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
      const next = siblings[0]?.sessionId
      if (next !== undefined) {
        this.publish({
          ...withoutError(this.snapshot),
          state: { ...this.snapshot.state, sessions: remaining },
          currentSessionId: next,
        })
        // Fire-and-forget: pulling the next session's transcript is unrelated
        // to the archive action the user just confirmed. Awaiting here couples
        // the archive button's UI reset to whatever `selectSession` happens to
        // do (catchupTranscript → applyCacheToSession → IndexedDB), and an
        // IndexedDB request that never settles in this browser would freeze
        // the button on "归档中…" forever. Let selectSession settle on its
        // own clock; its own call() timeout caps the worst case.
        void this.selectSession(next).catch(() => undefined)
        return
      }
      // No sibling left: clear the current selection and open a fresh draft for this
      // project so the create-session surface (DraftConversation) is visible.
      const { currentSessionId: _stale, ...cleared } = withoutError(this.snapshot)
      this.publish({
        ...cleared,
        state: { ...this.snapshot.state, sessions: remaining },
        draftSession: { projectId, title: '新会话' },
      })
      return
    }
    // Non-current session: just drop it from the visible sidebar.
    this.publish({
      ...withoutError(this.snapshot),
      state: { ...this.snapshot.state, sessions: remaining },
    })
  }

  /** Restore a previously archived session to the normal session tree. */
  unarchiveSession(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    return this.mutate('session.unarchive', { sessionId })
  }

  /** Permanently delete one session subtree and its projected transcript. */
  deleteSession(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    return this.mutate('session.delete', { sessionId })
  }

  /** Read the current sidebar display preferences. Pure read; never throws. */
  getDisplayPreferences(): DisplayPreferences {
    return readDisplayPreferences()
  }

  /** Persist updated display preferences and re-run the auto-archive job so a
   *  tightening of the threshold takes effect without waiting for the next
   *  catalog reload. The settings UI binds its inputs to this method so the
   *  sidebar immediately reflects a fresh cap or threshold value. */
  updateDisplayPreferences(next: Partial<DisplayPreferences>): DisplayPreferences {
    const current = readDisplayPreferences()
    const merged: DisplayPreferences = {
      sessionsPerProjectLimit: next.sessionsPerProjectLimit ?? current.sessionsPerProjectLimit,
      autoHideSessionsAfterDays: next.autoHideSessionsAfterDays ?? current.autoHideSessionsAfterDays,
    }
    writeDisplayPreferences(merged)
    void this.archiveStaleSessions().catch(() => undefined)
    return merged
  }

  /** Archive every visible, non-archived session whose `updatedAt` is older
   *  than the configured auto-hide threshold. The job is idempotent — calling
   *  it twice with the same threshold archives nothing on the second pass
   *  because the gateway filter drops archived sessions from the projection.
   *  Failures from individual archives are caught and logged but never bubble
   *  up: one stale session with a broken transport must not block the rest.
   *  A wall-clock budget caps how long one sweep can keep the settings panel
   *  button on "清理中…"; whatever is left is picked up by the next reload. */
  async archiveStaleSessions(): Promise<number> {
    if (this.autoArchiveInFlight) return 0
    const prefs = readDisplayPreferences()
    const cutoff = archiveCutoff(Date.now(), prefs.autoHideSessionsAfterDays)
    if (cutoff === null) return 0
    this.autoArchiveInFlight = true
    try {
      const targets = this.snapshot.state.sessions.filter(session => {
        if (session.archivedAt !== undefined) return false
        return session.updatedAt < cutoff
      })
      let archived = 0
      const startedAt = Date.now()
      for (const session of targets) {
        if (Date.now() - startedAt > ARCHIVE_BUDGET_MS) {
          console.warn('threadharbor: auto-archive budget exceeded; deferring remaining sessions to the next sweep')
          break
        }
        try {
          await this.call('session.archive', { sessionId: session.sessionId })
          archived += 1
        } catch (error) {
          console.warn('threadharbor: auto-archive failed for session', session.sessionId, error)
        }
      }
      if (archived > 0) {
        // Refresh the catalog so the sidebar drops the archived rows immediately.
        void this.reload().catch(() => undefined)
      }
      return archived
    } finally {
      this.autoArchiveInFlight = false
    }
  }

  /** Hide one catalogued host from the normal projection while preserving its data.
   * Only the `host.hide` RPC is awaited: once the server confirms, the host
   * (and its projects and sessions) leave the sidebar through a local projection
   * commit, and the follow-up catalog reload runs fire-and-forget. A slow
   * `state` round-trip can therefore never hold the hide UI on "隐藏中…".
   */
  async hideHost(hostId: ReturnType<typeof RemoteHostId>): Promise<void> {
    const target = this.snapshot.state.hosts.find(candidate => candidate.hostId === hostId)
    if (target === undefined) {
      // Host is not in the local projection (already hidden on the server or
      // never visible); fall back to the plain mutate so the server side still
      // records the hide.
      await this.mutate('host.hide', { hostId })
      return
    }
    await this.run(async () => {
      await this.call('host.hide', { hostId })
      const hiddenProjects = new Set(this.snapshot.state.projects
        .filter(project => project.hostId === hostId)
        .map(project => project.projectId))
      this.dropHiddenRows(new Set([hostId]), hiddenProjects)
    })
    void this.reload().catch(() => undefined)
  }

  /** Restore a previously hidden host so it shows up in the sidebar again. */
  unhideHost(hostId: ReturnType<typeof RemoteHostId>): Promise<void> {
    return this.mutate('host.unhide', { hostId })
  }

  /** Permanently delete one catalogued host and every project + session that lives on it. */
  deleteHost(hostId: ReturnType<typeof RemoteHostId>): Promise<void> {
    return this.mutate('host.delete', { hostId })
  }

  /** Hide one catalogued project from the normal projection while preserving its data.
   * Same convergence contract as `hideHost`: the row leaves the sidebar as soon
   * as the `project.hide` RPC confirms; the catalog reload is background work.
   */
  async hideProject(projectId: ReturnType<typeof RemoteProjectId>): Promise<void> {
    const target = this.snapshot.state.projects.find(candidate => candidate.projectId === projectId)
    if (target === undefined) {
      // Project is not in the local projection (already hidden on the server or
      // never visible); fall back to the plain mutate so the server side still
      // records the hide.
      await this.mutate('project.hide', { projectId })
      return
    }
    await this.run(async () => {
      await this.call('project.hide', { projectId })
      this.dropHiddenRows(new Set(), new Set([projectId]))
    })
    void this.reload().catch(() => undefined)
  }

  /** Restore a previously hidden project so it shows up in the sidebar again. */
  unhideProject(projectId: ReturnType<typeof RemoteProjectId>): Promise<void> {
    return this.mutate('project.unhide', { projectId })
  }

  /** Permanently delete one catalogued project and every session that lives on it. */
  deleteProject(projectId: ReturnType<typeof RemoteProjectId>): Promise<void> {
    return this.mutate('project.delete', { projectId })
  }

  /** Remove rows whose hide the server just confirmed from the local projection,
   *  mirroring the way a server `state()` refresh drops them: hidden host and
   *  project rows vanish along with every session of a removed project, and a
   *  draft whose project row vanished is discarded (its create surface needs a
   *  visible project). `commitProjection` re-anchors current selection and
   *  prompt progress under the same rules a catalog reload would apply. */
  private dropHiddenRows(
    hostIds: ReadonlySet<ReturnType<typeof RemoteHostId>>,
    projectIds: ReadonlySet<ReturnType<typeof RemoteProjectId>>,
  ): void {
    const state = this.snapshot.state
    const draft = this.snapshot.draftSession !== undefined && projectIds.has(this.snapshot.draftSession.projectId)
      ? undefined
      : this.snapshot.draftSession
    this.commitProjection(
      {
        ...state,
        hosts: state.hosts.filter(host => !hostIds.has(host.hostId)),
        projects: state.projects.filter(project => !projectIds.has(project.projectId)),
        sessions: state.sessions.filter(session => !projectIds.has(session.projectId)),
      },
      undefined,
      draft,
    )
  }

  /** Switch one backend-advertised session setting (permission mode, model,
   *  effort …) on the running agent. Resolves once the backend acknowledged
   *  it; the returned view already carries the new `currentValue`.
   * @param sessionId - session whose agent should switch.
   * @param configId - id from `session.configOptions`.
   * @param value - one of that option's advertised values.
   */
  configureSession(sessionId: ReturnType<typeof RemoteSessionId>, configId: string, value: string): Promise<void> {
    return this.run(async () => {
      const result = await this.call('session.configure', { sessionId, configId, value })
      const session = parseSession(result)
      this.publish({ ...withoutError(this.snapshot), state: withSessionView(this.snapshot.state, session) })
    })
  }

  /** Answer one backend-native permission request.
   * @param sessionId - session that emitted the request.
   * @param requestId - backend-native request id.
   * @param outcome - backend-native option value.
   */
  permission(sessionId: ReturnType<typeof RemoteSessionId>, requestId: string, outcome: JsonValue): Promise<void> {
    return this.run(async () => {
      await this.call('session.permission', { sessionId, requestId, outcome })
      await this.reload()
      await this.catchupTranscript(sessionId, 'high')
    })
  }

  private async startOperation(params: Record<string, JsonValue>): Promise<RemoteOperationView> {
    const operation = await this.run(async () => {
      const operation = parseOperation(await this.call('operation.start', params))
      const operations = [
        operation,
        ...this.snapshot.state.operations.filter(candidate => candidate.operationId !== operation.operationId),
      ]
      this.publish({ ...withoutError(this.snapshot), state: { ...this.snapshot.state, operations } })
      return operation
    })
    this.scheduleOperationPoll(0)
    return operation
  }

  private async mutate(method: string, params: Record<string, JsonValue>): Promise<void> {
    await this.run(async () => {
      await this.call(method, params)
      await this.reload()
    })
  }

  private sessionHasTranscript(sessionId: string): boolean {
    return this.snapshot.state.transcript.some(entry => entry.sessionId === sessionId)
  }

  private sessionNeedsLiveTranscript(sessionId: ReturnType<typeof RemoteSessionId>): boolean {
    const session = this.snapshot.state.sessions.find(candidate => candidate.sessionId === sessionId)
    if (session === undefined) return false
    if (session.turnState === 'running' || session.turnState === 'waiting-permission') return true
    const progress = this.snapshot.promptProgress
    if (progress?.sessionId === sessionId && progress.phase !== 'failed') return true
    return (session.latestTranscriptSeq ?? -1) > lastTranscriptSeq(this.snapshot.state, sessionId)
  }

  private liveTranscriptDelayMs(): number {
    const capped = Math.min(Math.max(this.liveBackoffIndex, 0), LIVE_BACKOFF_MS.length - 1)
    return LIVE_BACKOFF_MS[capped] ?? 8_000
  }

  private waitForLiveTranscript(delayMs = this.liveTranscriptDelayMs()): Promise<void> {
    return new Promise(resolve => {
      const timer = window.setTimeout(() => {
        if (this.liveWait?.timer === timer) this.liveWait = undefined
        resolve()
      }, delayMs)
      this.liveWait = { timer, resolve }
    })
  }

  private ensureLiveTranscriptSync(): void {
    if (this.disposed || this.liveSyncing) return
    const sessionId = this.snapshot.currentSessionId
    if (sessionId === undefined || !this.sessionNeedsLiveTranscript(sessionId)) return
    this.liveSyncing = true
    void this.runLiveTranscriptLoop()
      .catch(() => undefined)
      .finally(() => { this.liveSyncing = false })
  }

  private async runLiveTranscriptLoop(): Promise<void> {
    while (!this.disposed) {
      const sessionId = this.snapshot.currentSessionId
      if (sessionId === undefined || !this.sessionNeedsLiveTranscript(sessionId)) return
      const delay = this.liveTranscriptDelayMs()
      const got = await this.catchupTranscript(sessionId, 'high')
      if (got) this.liveBackoffIndex = 0
      else this.liveBackoffIndex = Math.min(this.liveBackoffIndex + 1, LIVE_BACKOFF_MS.length - 1)
      // Reconcile the session row after sustained transcript silence: a finished
      // turn whose `session.view` idle push was missed (WS drop / frozen tab)
      // otherwise leaves turnState stuck at 'running', stranding the "正在生成回复"
      // banner and this loop. Gated on max backoff so it never perturbs an active
      // turn's fast path — only a genuinely quiet, seemingly-stuck turn reloads.
      if (!got && this.liveBackoffIndex >= LIVE_BACKOFF_MS.length - 1) {
        await this.reload(sessionId).catch(() => undefined)
      }
      if (this.disposed || !this.sessionNeedsLiveTranscript(sessionId)) return
      await this.waitForLiveTranscript(delay)
    }
  }

  private async readTranscriptPage(params: Record<string, JsonValue>): Promise<RemoteTranscriptPage | undefined> {
    try {
      return parseTranscriptPage(await this.call('transcript.read', params))
    } catch {
      return undefined
    }
  }

  private async catchupTranscript(
    sessionId: ReturnType<typeof RemoteSessionId>,
    priority: 'high' | 'low',
  ): Promise<boolean> {
    if (this.disposed) return false
    // Bring cached entries into the in-memory snapshot before talking to the
    // gateway. Without this step a switched-into background session would
    // look empty until the HTTP round-trip completes. Cache is read lazily
    // and only when the snapshot itself has no rows for this session, so
    // a hot session that already has fresh data does not pay an extra IDB
    // round-trip per catchup.
    if (!this.sessionHasTranscript(sessionId)) await this.applyCacheToSession(sessionId)
    const hasLocal = this.sessionHasTranscript(sessionId)
    const afterSeq = hasLocal ? lastTranscriptSeq(this.snapshot.state, sessionId) : undefined
    const page = await this.readTranscriptPage({
      sessionId,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      limit: REMOTE_TRANSCRIPT_PAGE_SIZE,
    })
    if (page === undefined || this.disposed) return false
    if (page.entries.length === 0) return false
    this.applyTranscriptEntries(sessionId, page.entries, { countUnread: priority === 'low' && hasLocal })
    const latest = page.latestSeq
    const localLast = lastTranscriptSeq(this.snapshot.state, sessionId)
    if (priority === 'high' && latest > localLast) {
      await this.catchupTranscript(sessionId, priority)
      return true
    }
    if (priority === 'low' && latest > localLast) this.enqueueBackgroundTranscript(sessionId)
    return true
  }

  /** Read one session from the cache and apply it to the in-memory snapshot.
   *  Used both by `start` (warm every catalog session) and by `catchupTranscript`
   *  (rescue a switched-into background session before the HTTP catchup). */
  private async applyCacheToSession(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    if (this.cache === null) return
    let cached: readonly RemoteTranscriptEntry[] | undefined
    try {
      cached = await this.cache.getEntries(sessionId)
    } catch {
      return
    }
    if (cached === undefined || cached.length === 0) return
    this.applyTranscriptEntries(sessionId, cached)
  }

  /** Apply cached entries for every catalog session. Best-effort: a single
   *  failed session is logged and skipped so one bad IDB row cannot block
   *  the others. */
  private async warmCacheFromLocal(): Promise<void> {
    if (this.cache === null) return
    const sessions = this.snapshot.state.sessions
    await Promise.all(sessions.map(session => this.applyCacheToSession(session.sessionId)))
  }

  private async backfillOpenedTranscript(
    sessionId: ReturnType<typeof RemoteSessionId>,
    work: number,
  ): Promise<void> {
    while (!this.disposed && work === this.transcriptWork && this.snapshot.currentSessionId === sessionId) {
      const oldest = this.snapshot.state.transcript
        .filter(entry => entry.sessionId === sessionId)
        .at(0)?.seq
      if (oldest === undefined || oldest <= 0) return
      const page = await this.readTranscriptPage({
        sessionId, beforeSeq: oldest, limit: REMOTE_TRANSCRIPT_PAGE_SIZE,
      })
      if (page === undefined || this.disposed || work !== this.transcriptWork) return
      if (page.entries.length === 0) return
      this.applyTranscriptEntries(sessionId, page.entries)
      if (!page.hasMore) return
    }
  }

  private queueBackgroundTranscripts(): void {
    const current = this.snapshot.currentSessionId
    for (const session of this.snapshot.state.sessions) {
      if (session.sessionId === current) continue
      const remoteLatest = session.latestTranscriptSeq ?? -1
      const localLast = lastTranscriptSeq(this.snapshot.state, session.sessionId)
      if (remoteLatest > localLast || !this.sessionHasTranscript(session.sessionId)) {
        this.enqueueBackgroundTranscript(session.sessionId)
      }
    }
  }

  private enqueueBackgroundTranscript(sessionId: string): void {
    if (this.disposed || sessionId === this.snapshot.currentSessionId) return
    if (this.backgroundQueue.includes(sessionId)) return
    this.backgroundQueue.push(sessionId)
    this.pumpBackgroundTranscripts()
  }

  private pumpBackgroundTranscripts(): void {
    if (this.disposed || this.backgroundBusy) return
    const sessionId = this.backgroundQueue.shift()
    if (sessionId === undefined) return
    if (sessionId === this.snapshot.currentSessionId) {
      this.pumpBackgroundTranscripts()
      return
    }
    this.backgroundBusy = true
    void this.catchupTranscript(RemoteSessionId(sessionId), 'low')
      .catch(() => undefined)
      .finally(() => {
        this.backgroundBusy = false
        this.pumpBackgroundTranscripts()
      })
  }

  private async reload(preferredSessionId?: ReturnType<typeof RemoteSessionId>): Promise<void> {
    const serial = ++this.reloadSerial
    const catalog = parseRemoteAgentState(await this.call('state', {}))
    if (this.disposed || serial !== this.reloadSerial) return
    this.commitProjection(catalog, preferredSessionId)
    // Every successful catalog reload is a chance to retire sessions that have
    // been quiet past the auto-hide threshold. Run it fire-and-forget so a slow
    // archive call never blocks the next reload tick.
    void this.archiveStaleSessions().catch(() => undefined)
  }

  /** Merge a fresh catalog projection into the snapshot under one set of rules.
   *  Sessions the projection no longer lists but that are the current selection
   *  or are driving prompt progress survive as in-flight rows (a `session.start`
   *  catalog race must not yank a live turn), and current/draft/prompt progress
   *  are re-anchored so nothing points at a vanished row. Shared by full catalog
   *  reloads and by the optimistic local removal after a hide, so both paths
   *  converge on identical projection semantics.
   * @param projection - authoritative rows: the server `state()` result, or the
   *  current snapshot minus rows whose hide the server just confirmed.
   * @param preferredSessionId - session to prefer when re-anchoring current.
   * @param draft - draft to keep; pass `undefined` to discard a draft whose
   *  project row was just removed.
   */
  private commitProjection(
    projection: RemoteAgentState,
    preferredSessionId?: ReturnType<typeof RemoteSessionId>,
    draft: RemoteSessionDraft | undefined = this.snapshot.draftSession,
  ): void {
    const inFlight = this.snapshot.state.sessions.filter(session => {
      if (projection.sessions.some(existing => existing.sessionId === session.sessionId)) return false
      return session.sessionId === this.snapshot.currentSessionId
        || this.snapshot.promptProgress?.sessionId === session.sessionId
    })
    const state = {
      ...projection,
      transcript: this.snapshot.state.transcript,
      // Prepend in-flight sessions so a session the server has not yet
      // committed (rare, but possible if `session.start` and the resulting
      // catalog reload race) still shows up at the top of the project list
      // rather than disappearing behind the existing rows.
      sessions: inFlight.length === 0 ? projection.sessions : [...inFlight, ...projection.sessions],
    }
    const persisted = readPersistedCurrentSessionId()
    const adopted = inFlightCreatedSessionId(
      state, draft, this.snapshot.promptProgress, this.snapshot.currentSessionId,
    )
    const keepDraft = draft !== undefined && adopted === undefined
    const current = adopted
      ?? (keepDraft
        ? undefined
        : [this.snapshot.currentSessionId, preferredSessionId, persisted === undefined ? undefined : RemoteSessionId(persisted)]
          .find(sessionId => sessionId !== undefined && state.sessions.some(session => session.sessionId === sessionId))
          ?? state.sessions.at(0)?.sessionId)
    const promptProgress = this.reconcilePromptProgress(state)
    this.publish({
      phase: 'ready', state, pending: this.snapshot.pending,
      ...(this.snapshot.panel === undefined ? {} : { panel: this.snapshot.panel }),
      ...(keepDraft ? { draftSession: draft } : {}),
      ...(this.snapshot.attachingSessionId === undefined ? {} : { attachingSessionId: this.snapshot.attachingSessionId }),
      ...(promptProgress === undefined ? {} : { promptProgress }),
      ...(current === undefined ? {} : { currentSessionId: current }),
    })
    if (adopted !== undefined) {
      this.liveBackoffIndex = 0
      void this.catchupTranscript(adopted, 'high')
      this.ensureLiveTranscriptSync()
    }
    this.drainQueuedPromptIfIdle()
  }

  /** One HTTP `state` snapshot while the socket is down. Not a live journal loop. */
  private rebuildFromHttp(): void {
    if (this.disposed || this.rebuildInFlight) return
    this.rebuildInFlight = true
    void this.reload()
      .catch((error: unknown) => {
        this.publish({ ...this.snapshot, phase: 'error', error: String(error) })
      })
      .finally(() => { this.rebuildInFlight = false })
  }

  /** Poll management operations independently so a serialized long mutation cannot hide its own progress. */
  private scheduleOperationPoll(delay = this.snapshot.state.pollIntervalMs): void {
    if (this.disposed) return
    if (this.operationTimer !== undefined) window.clearTimeout(this.operationTimer)
    this.operationTimer = window.setTimeout(() => {
      this.operationTimer = undefined
      void this.call('operation.list', {})
        .then((value) => {
          const operations = array(value, 'operations').map(parseOperation)
          this.publish({ ...this.snapshot, state: { ...this.snapshot.state, operations } })
          if (operations.some(operation => operation.status === 'queued' || operation.status === 'running')) {
            this.scheduleOperationPoll()
          }
        })
        .catch((error: unknown) => {
          this.publish({ ...this.snapshot, phase: 'error', error: errorText(error) })
          if (this.snapshot.state.operations.some(operation => operation.status === 'queued' || operation.status === 'running')) {
            this.scheduleOperationPoll()
          }
        })
    }, delay)
  }

  private reconcilePromptProgress(state: RemoteAgentState, snapshot = this.snapshot): RemotePromptProgress | undefined {
    const progress = snapshot.promptProgress
    if (progress?.sessionId === undefined) return progress
    const session = state.sessions.find(candidate => candidate.sessionId === progress.sessionId)
    // The catalog can lag session.start; keep in-flight progress until a later
    // upsert, reload, or RPC error settles the row.
    if (session === undefined) return progress
    if (session.turnState === 'failed' || session.channelState === 'lost' || session.channelState === 'closed') {
      return { ...progress, phase: 'failed', message: this.snapshot.error ?? '远程会话未能完成本轮请求。' }
    }
    // While the socket is down a catalog reload must not clear a prompt that is
    // still waiting to be (re)delivered — otherwise the header would flip to a
    // misleading idle state and a queued redelivery would lose its context.
    if (this.connectionPhase === 'reconnecting'
      && (progress.phase === 'sending' || progress.phase === 'connecting')) {
      return progress
    }
    if (session.channelState === 'connecting') return progress
    if (session.turnState === 'idle' || session.turnState === 'stopped') return undefined
    const hasBackendEvent = state.transcript.some(entry =>
      entry.sessionId === progress.sessionId && entry.seq > progress.baselineSeq && entry.role !== 'user')
    if (hasBackendEvent) return undefined
    if (session.channelState === 'reconnecting') return { ...progress, phase: 'reconnecting' }
    if (progress.phase === 'sending') return progress
    const { message: _message, ...rest } = progress
    return { ...rest, phase: 'waiting' }
  }

  private async run<T>(operation: () => Promise<T>, blocksConversation = false): Promise<T> {
    if (blocksConversation) this.pendingCount += 1
    this.publish({ ...withoutError(this.snapshot), pending: this.pendingCount > 0 })
    try {
      const value = await operation()
      if (blocksConversation) this.pendingCount -= 1
      this.publish({ ...withoutError(this.snapshot), phase: 'ready', pending: this.pendingCount > 0 })
      return value
    } catch (error) {
      if (blocksConversation) this.pendingCount -= 1
      this.publish({ ...this.snapshot, phase: 'error', pending: this.pendingCount > 0, error: String(error) })
      throw error
    }
  }

  private async call(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    if (this.transport !== undefined) return this.transport.call(method, params)
    const id = crypto.randomUUID()
    const response = await fetch(REMOTE_AGENT_GATEWAY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, method, params }),
      signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
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
    const next = this.withConnectionPhase(snapshot)
    this.snapshot = next
    if (next.currentSessionId !== undefined) writePersistedCurrentSessionId(next.currentSessionId)
    if (this.followedSessionId !== next.currentSessionId) {
      this.followedSessionId = next.currentSessionId
      this.followHandler?.(next.currentSessionId)
    }
    for (const listener of this.listeners) listener()
  }

  /** Catalog reloads and RPC errors must not clobber a reconnecting transport phase. */
  private withConnectionPhase(snapshot: RemoteAgentSnapshot): RemoteAgentSnapshot {
    if (snapshot.phase === 'loading') return snapshot
    if (this.connectionPhase === 'reconnecting' && snapshot.phase !== 'reconnecting') {
      return { ...snapshot, phase: 'reconnecting' }
    }
    return snapshot
  }
}

/** Backends shown in stable picker order. */
export const BACKEND_ORDER = REMOTE_AGENT_BACKENDS
