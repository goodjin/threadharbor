/**
 * How a peer's push lands in this host's registry.
 *
 * The local registry is the operator's list: an entry that is already here
 * keeps its address, SSH facts, and remote read. What a peer can do is
 * (a) introduce itself so a host nobody typed in still becomes reachable, and
 * (b) refresh its own launch token when the token is the same origin the local
 * entry already points at. Everything else is add-if-missing only, which is
 * what makes a mesh converge without letting one peer rewrite another's
 * bookkeeping.
 */

import { parseRegistration, type HostRegistration } from './registry.ts'
import { normalizeAddress, normalizeLaunchUrl } from './registry.ts'
import { parseSelfRecord } from './federation-keys.ts'
import type { HostSelfRecord } from './federation-keys.ts'

export type FederationMergeResult = {
  /** The registry value to store (only meaningful when `changed`). */
  readonly json: string
  readonly changed: boolean
  readonly added: number
  readonly refreshed: number
  /** Host ids that appeared or gained a token, i.e. hosts this host can now push to. */
  readonly learned: readonly string[]
}

/**
 * Merge one push into the local registry JSON.
 * @param localRaw - the current `dsh.host.registry` value, if any.
 * @param incoming - the push body (`{self, hosts}`), untrusted.
 * @param localSelfId - this host's own id, when it has announced itself.
 * @param now - clock for entries added by the push.
 */
export function mergeFederationRegistry(
  localRaw: string | undefined,
  incoming: unknown,
  localSelfId: string | undefined,
  now: number,
): FederationMergeResult {
  const entries = parseLocal(localRaw)
  const byId = new Map(entries.map(entry => [entry.hostId, entry]))
  const record = isRecord(incoming) ? incoming : {}
  const self = parseSelfRecord(record['self'])
  const added: HostRegistration[] = []
  const learned: string[] = []
  let refreshed = 0

  if (self !== undefined && self.hostId !== localSelfId) {
    const existing = byId.get(self.hostId)
    if (existing === undefined) {
      const fresh = entryFrom(self, now)
      byId.set(fresh.hostId, fresh)
      added.push(fresh)
      learned.push(fresh.hostId)
    } else {
      // The sender owns its name and its token — but only the token whose
      // origin matches the address this operator already kept, or the stored
      // pair would fail the gateway's origin check.
      const next: HostRegistration = {
        ...existing,
        hostTitle: self.hostTitle,
        ...(existing.address === self.address ? { launchUrl: self.launchUrl } : {}),
      }
      if (next.hostTitle !== existing.hostTitle || next.launchUrl !== existing.launchUrl) {
        byId.set(next.hostId, next)
        if (existing.launchUrl === undefined && next.launchUrl !== undefined) learned.push(next.hostId)
      }
    }
  }

  const hosts = Array.isArray(record['hosts']) ? record['hosts'] : []
  for (const item of hosts) {
    const parsed = parseRegistration(item)
    if (parsed === undefined) continue
    if (parsed.hostId === localSelfId || parsed.hostId === self?.hostId) continue
    const address = normalizeAddress(parsed.address)
    if (!address.ok) continue
    const launch = parsed.launchUrl === undefined
      ? undefined
      : normalizeLaunchUrl(parsed.launchUrl, address.origin)
    if (launch === undefined || !launch.ok) continue
    const existing = byId.get(parsed.hostId)
    if (existing === undefined) {
      const fresh: HostRegistration = {
        hostId: parsed.hostId,
        hostTitle: parsed.hostTitle,
        address: address.origin,
        launchUrl: launch.url,
        createdAt: now,
      }
      byId.set(fresh.hostId, fresh)
      added.push(fresh)
      learned.push(fresh.hostId)
      continue
    }
    // Local entry wins in every field except a missing token whose origin
    // matches — that is a host this operator registered before federation
    // could fill it in.
    if (existing.launchUrl === undefined && existing.address === address.origin) {
      byId.set(existing.hostId, { ...existing, launchUrl: launch.url })
      refreshed += 1
      learned.push(existing.hostId)
    }
  }

  const next = [...byId.values()]
  const json = JSON.stringify(next)
  return {
    json,
    changed: localRaw === undefined ? next.length > 0 : json !== localRaw,
    added: added.length,
    refreshed,
    learned,
  }
}

function parseLocal(raw: string | undefined): HostRegistration[] {
  if (raw === undefined || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(item => {
    const entry = parseRegistration(item)
    return entry === undefined ? [] : [entry]
  })
}

function entryFrom(self: HostSelfRecord, now: number): HostRegistration {
  return {
    hostId: self.hostId,
    hostTitle: self.hostTitle,
    address: self.address,
    launchUrl: self.launchUrl,
    createdAt: now,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
