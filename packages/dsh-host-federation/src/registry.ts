/**
 * The operator's list of hosts worth reaching, kept beside the roll-up.
 *
 * A registration is bookkeeping, not a connection: this page cannot open one to
 * another origin (the browser refuses cross-origin reads, and DSH's
 * authentication is bound to the serving origin), so the registry records what
 * exists, where, and under which hostId — the facts an operator needs to open
 * that host's page and to keep the inventory straight. Adding and removing
 * entries touches this list only; nothing is sent to, or deleted on, the
 * registered machine.
 *
 * Records are keyed by hostId (§8.2): settings and identity bind per host, so
 * one hostId is one entry, and a duplicate id is refused rather than silently
 * merged.
 */

import { isValidHostId } from './identity.ts'
import { parseRemoteReport } from './remote-report.ts'
import type { RemoteReport } from './remote-report.ts'

/** One registered host, as the operator entered it. */
export type HostRegistration = {
  /** The hostId that machine's panel is configured to claim. */
  readonly hostId: string
  /** Human-readable name; shown wherever the id is too terse. */
  readonly hostTitle: string
  /** The origin to open in a browser, normalized (`http(s)://host[:port]`). */
  readonly address: string
  /**
   * Optional full entry URL with launch `?token=` (sensitive). When present the
   * UI can open the host without hunting stderr; origin must match `address`.
   */
  readonly launchUrl?: string
  /**
   * Optional non-secret SSH facts for the deploy/connect flows: where to ssh,
   * as whom, with which key file and approved host-key fingerprint. Passwords
   * and pasted private keys never live here — they are session-only.
   */
  readonly ssh?: HostSshInfo
  /** 最近一次从这台主机读到的远端读数（remote-report.ts 的形状）；没读到过就没有。 */
  readonly remote?: RemoteReport
  /** When the registration was made, in the page's clock. */
  readonly createdAt: number
}

/** The SSH facts worth remembering between sessions; secrets excluded. */
export type HostSshInfo = {
  /** Host or IP to ssh to. */
  readonly target: string
  /** SSH port; 22 when omitted. */
  readonly port?: number
  /** Login user. */
  readonly user?: string
  /** Optional ProxyJump hop. */
  readonly proxyJump?: string
  /** How the session authenticates; pem/password still need re-entry. */
  readonly authMode: 'identityFile' | 'identityPem' | 'password'
  /** Absolute path of the private key on this machine (identityFile only). */
  readonly identityFile?: string
  /** The approved host-key fingerprint, so later connects need no re-approval. */
  readonly hostKeyFingerprint?: string
  /** The remote DSH web port the deploy used. */
  readonly remoteWebPort?: number
}

/** Why an addition was refused; each kind maps to one actionable sentence. */
export type RegistrationError =
  | { readonly kind: 'bad-id'; readonly detail: string }
  | { readonly kind: 'bad-address'; readonly detail: string }
  | { readonly kind: 'bad-ssh'; readonly detail: string }
  | { readonly kind: 'duplicate'; readonly detail: string }

export type RegistrationResult =
  | { readonly ok: true; readonly value: HostRegistration }
  | { readonly ok: false; readonly error: RegistrationError }

/** The slice of Web Storage the registry persists through. */
export type RegistryStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The one storage key the registry lives under. */
export const HOST_REGISTRY_KEY = 'dsh.host.registry'

/**
 * Normalize an entered address to the origin a browser would open.
 *
 * Accepts a full URL; the scheme is required because http and https lead to
 * different pages on the same authority, and guessing would send the operator
 * somewhere they did not mean. Everything after the origin is dropped: the
 * registry stores where a host lives, not a deep link.
 */
export function normalizeAddress(input: string): { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly detail: string } {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: false, detail: '地址不能为空' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, detail: '地址要带协议，例如 http://192.168.1.10:3081' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, detail: `只支持 http/https 地址，收到的是 ${parsed.protocol}` }
  }
  return { ok: true, origin: parsed.origin }
}

/** What callers may hand to add-time validation: typed callers cannot construct the secret fields at all. */
type SshInfoInput = HostSshInfo & { readonly password?: unknown; readonly identityPem?: unknown }

/**
 * The registry over a Web Storage.
 * @param storage - localStorage or a stand-in with the same two methods.
 * @param now - the clock stamped on new entries; injectable for tests.
 * @returns add/remove/list over the persisted registration list.
 */
export function hostRegistry(storage: RegistryStorage, now: () => number = Date.now): {
  list(): readonly HostRegistration[]
  add(input: {
    readonly hostId: string
    readonly hostTitle: string
    readonly address: string
    readonly launchUrl?: string
    /** May carry smuggled secrets from untyped callers; validation refuses them by name. */
    readonly ssh?: SshInfoInput
  }): RegistrationResult
  remove(hostId: string): boolean
  /**
   * 记下最近一次从这台主机读到的远端读数。读数是读回来的事实，不是操作者
   * 输入，所以不走 add 的校验路径：只按 parseRemoteReport 复核一次，站不住
   * 的值返回 false 什么都不写；其余字段原样保留。
   */
  recordRemote(hostId: string, report: RemoteReport): boolean
} {
  const read = (): HostRegistration[] => {
    const raw = storage.getItem(HOST_REGISTRY_KEY)
    if (raw === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Unreadable storage reads as an empty registry: the operator re-adds,
      // which is cheaper than a panel that cannot start.
      return []
    }
    if (!Array.isArray(parsed)) return []
    const entries: HostRegistration[] = []
    for (const item of parsed) {
      const entry = parseEntry(item)
      if (entry !== undefined) entries.push(entry)
    }
    return entries
  }
  const write = (entries: readonly HostRegistration[]): void => {
    storage.setItem(HOST_REGISTRY_KEY, JSON.stringify(entries))
  }
  return {
    list: () => read(),
    add: input => {
      const hostId = input.hostId.trim()
      if (!isValidHostId(hostId)) {
        return {
          ok: false,
          error: { kind: 'bad-id', detail: '主机标识要非空、不含 / 或 \\、不超过 64 字符' },
        }
      }
      const address = normalizeAddress(input.address)
      if (!address.ok) return { ok: false, error: { kind: 'bad-address', detail: address.detail } }
      let launchUrl: string | undefined
      if (input.launchUrl !== undefined && input.launchUrl.trim() !== '') {
        const parsed = normalizeLaunchUrl(input.launchUrl, address.origin)
        if (!parsed.ok) return { ok: false, error: { kind: 'bad-address', detail: parsed.detail } }
        launchUrl = parsed.url
      }
      let ssh: HostSshInfo | undefined
      if (input.ssh !== undefined) {
        const parsed = validateSshInfo(input.ssh)
        if (!parsed.ok) return { ok: false, error: { kind: 'bad-ssh', detail: parsed.detail } }
        ssh = parsed.value
      }
      const entries = read()
      if (entries.some(entry => entry.hostId === hostId)) {
        return {
          ok: false,
          error: { kind: 'duplicate', detail: `已有一台主机标识为 ${hostId} 的登记；先删除它，或换一个标识` },
        }
      }
      const entry: HostRegistration = {
        hostId,
        hostTitle: input.hostTitle.trim() === '' ? hostId : input.hostTitle.trim(),
        address: address.origin,
        ...(launchUrl === undefined ? {} : { launchUrl }),
        ...(ssh === undefined ? {} : { ssh }),
        createdAt: now(),
      }
      write([...entries, entry])
      return { ok: true, value: entry }
    },
    remove: hostId => {
      const entries = read()
      const next = entries.filter(entry => entry.hostId !== hostId)
      if (next.length === entries.length) return false
      write(next)
      return true
    },
    recordRemote: (hostId, report) => {
      const parsed = parseRemoteReport(report)
      if (parsed === undefined) return false
      const entries = read()
      const index = entries.findIndex(entry => entry.hostId === hostId)
      if (index === -1) return false
      write(entries.map((entry, i) => i === index ? { ...entry, remote: parsed } : entry))
      return true
    },
  }
}

function parseEntry(item: unknown): HostRegistration | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  const hostId = record['hostId']
  const address = record['address']
  if (typeof hostId !== 'string' || !isValidHostId(hostId)) return undefined
  if (typeof address !== 'string' || normalizeAddress(address).ok !== true) return undefined
  const hostTitle = record['hostTitle']
  const createdAt = record['createdAt']
  const launchUrl = record['launchUrl']
  const ssh = parseSshInfo(record['ssh'])
  const remote = parseRemoteReport(record['remote'])
  return {
    hostId,
    hostTitle: typeof hostTitle === 'string' && hostTitle !== '' ? hostTitle : hostId,
    address,
    ...(typeof launchUrl === 'string' && launchUrl !== '' ? { launchUrl } : {}),
    ...(ssh === undefined ? {} : { ssh }),
    ...(remote === undefined ? {} : { remote }),
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
  }
}

const SSH_AUTH_MODES = ['identityFile', 'identityPem', 'password'] as const

const isUsablePort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const asAuthMode = (value: unknown): HostSshInfo['authMode'] | undefined =>
  typeof value === 'string' && (SSH_AUTH_MODES as readonly string[]).includes(value)
    ? value as HostSshInfo['authMode']
    : undefined

/**
 * Strict add-time validation: the registry only accepts the non-secret facts,
 * and says so by name when a password or pasted key tries to move in.
 */
function validateSshInfo(input: SshInfoInput): { readonly ok: true; readonly value: HostSshInfo } | { readonly ok: false; readonly detail: string } {
  const record = input as Record<string, unknown>
  if ('password' in record || 'identityPem' in record) {
    return { ok: false, detail: '登记簿不保存密码或粘贴的私钥：它们只在当次部署里使用，请改用密钥文件路径或重新输入' }
  }
  const target = nonEmptyString(record['target'])
  if (target === undefined) return { ok: false, detail: 'SSH 地址不能为空' }
  const authMode = asAuthMode(record['authMode'])
  if (authMode === undefined) {
    return { ok: false, detail: `SSH 认证方式要属于 ${SSH_AUTH_MODES.join(' / ')}` }
  }
  if (isUsablePort(record['port']) === false && record['port'] !== undefined) {
    return { ok: false, detail: 'SSH 端口要在 1–65535 之间' }
  }
  if (isUsablePort(record['remoteWebPort']) === false && record['remoteWebPort'] !== undefined) {
    return { ok: false, detail: '远端网页端口要在 1–65535 之间' }
  }
  const user = nonEmptyString(record['user'])
  const proxyJump = nonEmptyString(record['proxyJump'])
  const identityFile = nonEmptyString(record['identityFile'])
  const hostKeyFingerprint = nonEmptyString(record['hostKeyFingerprint'])
  const value: HostSshInfo = {
    target,
    ...(isUsablePort(record['port']) ? { port: record['port'] } : {}),
    ...(user === undefined ? {} : { user }),
    ...(proxyJump === undefined ? {} : { proxyJump }),
    authMode,
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint }),
    ...(isUsablePort(record['remoteWebPort']) ? { remoteWebPort: record['remoteWebPort'] } : {}),
  }
  return { ok: true, value }
}

/**
 * Tolerant read-side parsing: legacy entries carry no ssh block, hand-edited
 * ones may carry junk. Secrets never come back; a block missing its core
 * facts drops entirely rather than half-remembering a host.
 */
function parseSshInfo(item: unknown): HostSshInfo | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  const target = nonEmptyString(record['target'])
  if (target === undefined) return undefined
  const authMode = asAuthMode(record['authMode'])
  if (authMode === undefined) return undefined
  const user = nonEmptyString(record['user'])
  const proxyJump = nonEmptyString(record['proxyJump'])
  const identityFile = nonEmptyString(record['identityFile'])
  const hostKeyFingerprint = nonEmptyString(record['hostKeyFingerprint'])
  return {
    target,
    ...(isUsablePort(record['port']) ? { port: record['port'] } : {}),
    ...(user === undefined ? {} : { user }),
    ...(proxyJump === undefined ? {} : { proxyJump }),
    authMode,
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint }),
    ...(isUsablePort(record['remoteWebPort']) ? { remoteWebPort: record['remoteWebPort'] } : {}),
  }
}

function normalizeLaunchUrl(input: string, expectedOrigin: string): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly detail: string } {
  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch {
    return { ok: false, detail: 'launchUrl 必须是完整 URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, detail: 'launchUrl 只支持 http/https' }
  }
  if (parsed.origin !== expectedOrigin) {
    return { ok: false, detail: `launchUrl 的源（${parsed.origin}）必须与地址（${expectedOrigin}）一致` }
  }
  if (parsed.searchParams.get('token') === null || parsed.searchParams.get('token') === '') {
    return { ok: false, detail: 'launchUrl 必须包含 ?token=' }
  }
  return { ok: true, url: parsed.toString() }
}
