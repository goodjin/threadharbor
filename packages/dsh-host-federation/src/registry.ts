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
  /** When the registration was made, in the page's clock. */
  readonly createdAt: number
}

/** Why an addition was refused; each kind maps to one actionable sentence. */
export type RegistrationError =
  | { readonly kind: 'bad-id'; readonly detail: string }
  | { readonly kind: 'bad-address'; readonly detail: string }
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
  }): RegistrationResult
  remove(hostId: string): boolean
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
  return {
    hostId,
    hostTitle: typeof hostTitle === 'string' && hostTitle !== '' ? hostTitle : hostId,
    address,
    ...(typeof launchUrl === 'string' && launchUrl !== '' ? { launchUrl } : {}),
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
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
