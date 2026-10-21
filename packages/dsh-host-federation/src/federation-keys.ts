/**
 * The wires between a browser's host list and the host-side federation entry.
 *
 * Kept pure and free of node imports: the browser announces its identity and
 * reads the same keys through the settings channel, while the host entry uses
 * the paths below to accept announces and peer pushes. One module means the
 * two halves cannot drift apart.
 */

import { normalizeAddress } from './registry.ts'

/** The single self record the host entry maintains; browser-visible JSON. */
export const HOST_SELF_KEY = 'dsh.host.self'

/**
 * The origin peers (and phones) should use for this machine, when the origin
 * the browser happens to be on is not reachable from outside (localhost).
 */
export const HOST_ACCESS_ORIGIN_KEY = 'dsh.host.accessOrigin'

export const FEDERATION_PREFIX = '/threadharbor/federation'

/** The browser tells its host who it is; the host mints the launch URL. */
export const FEDERATION_ANNOUNCE_PATH = `${FEDERATION_PREFIX}/announce`

/** A peer host pushes its self record and registry here. */
export const FEDERATION_PUSH_PATH = `${FEDERATION_PREFIX}/push`

/**
 * Pairing URL for the full DSH UI (not the relay's reduced SPA). It lives
 * under the federation prefix on purpose: the legacy mobile entry and the
 * relay still serve `/threadharbor/mobile/pair-url` for their reduced SPA, and
 * registering the same exact route twice fails the whole plugin. Every host
 * running this federation entry serves the path below, so a phone pairs with
 * one machine and can then switch to any host that machine knows.
 */
export const FULL_UI_PAIR_PATH = `${FEDERATION_PREFIX}/pair-url`

/** One host's own claim: who it is, where it lives, and its launch token URL. */
export type HostSelfRecord = {
  readonly hostId: string
  readonly hostTitle: string
  readonly address: string
  readonly launchUrl: string
  readonly announcedAt: number
}

/**
 * What a peer pushes: its own record (authoritative for that hostId) plus the
 * registry it knows. Registry entries without a launch URL are not propagated:
 * a peer cannot open them, so they would only be inventory clutter.
 */
export type FederationPush = {
  readonly self: HostSelfRecord
  readonly hosts: readonly unknown[]
}

/** Parse a stored or received self record; anything inconsistent drops whole. */
export function parseSelfRecord(value: unknown): HostSelfRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const hostId = nonEmpty(record['hostId'])
  const address = nonEmpty(record['address'])
  const launchUrl = nonEmpty(record['launchUrl'])
  if (hostId === undefined || address === undefined || launchUrl === undefined) return undefined
  const normalized = normalizeAddress(address)
  if (!normalized.ok) return undefined
  let launch: URL
  try {
    launch = new URL(launchUrl)
  } catch {
    return undefined
  }
  if (launch.origin !== normalized.origin) return undefined
  if (launch.searchParams.get('token') === null || launch.searchParams.get('token') === '') return undefined
  const hostTitle = typeof record['hostTitle'] === 'string' && record['hostTitle'].trim() !== ''
    ? record['hostTitle'].trim()
    : hostId
  const announcedAt = typeof record['announcedAt'] === 'number' && Number.isFinite(record['announcedAt'])
    ? record['announcedAt']
    : 0
  return { hostId, hostTitle, address: normalized.origin, launchUrl, announcedAt }
}

/**
 * An origin the operator configured for outside access. Only the origin is
 * kept: a path would make the minted launch URL land somewhere else than the
 * DSH index, and the token exchange only happens at the root.
 */
export type AccessOriginProblem = 'empty' | 'syntax' | 'protocol' | 'credentials'

export function normalizeAccessOrigin(
  value: string,
): { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly reason: AccessOriginProblem; readonly detail: string } {
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, reason: 'empty', detail: '访问地址不能为空' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'syntax', detail: '访问地址要带协议，例如 https://mac1.example.ts.net' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'protocol', detail: `只支持 http/https 地址，收到的是 ${parsed.protocol}` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'credentials', detail: '访问地址里不能带用户名或密码' }
  }
  return { ok: true, origin: parsed.origin }
}

/** The origin a request was addressed to, as this process sees it. */
export function originOfRequest(headers: Readonly<Record<string, string | string[] | undefined>>, encrypted: boolean): string | undefined {
  const host = headerString(headers['host'])
  if (host === undefined || host.trim() === '') return undefined
  const forwarded = headerString(headers['x-forwarded-proto'])?.split(',', 1)[0]?.trim().toLowerCase()
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : encrypted ? 'https' : 'http'
  try {
    const url = new URL(`${proto}://${host.trim()}`)
    return url.origin
  } catch {
    return undefined
  }
}

/** Whether an origin only means something on the machine itself. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)
  } catch {
    return false
  }
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
