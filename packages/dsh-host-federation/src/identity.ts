/**
 * Working out which host this tab is.
 *
 * The load-bearing requirement is stability: two tabs opened on the same machine
 * must resolve to the same id, or the roll-up treats one machine as two and
 * every session under it appears twice.
 *
 * Where these values come from — the plugin's configuration reaching the page —
 * is the caller's business; this only resolves and validates them.
 */

export type IdentitySources = {
  /** The host id the operator configured, if any. */
  readonly configuredHostId: string | undefined
  readonly configuredHostTitle: string | undefined
  /** Enough about this page to distinguish one machine's origin from another's. */
  readonly origin: string
  readonly pathname: string
  /**
   * The visiting browser. Deliberately not part of the derived id: the desktop
   * shell and a phone browser reaching one deployment are the same host, and
   * deriving per browser would make them overwrite each other's self record.
   */
  readonly userAgent: string
}

export type HostIdentity = {
  readonly hostId: string
  readonly hostTitle: string
  /** True when the id was derived rather than configured. */
  readonly derived: boolean
}

/** Longest usable configured id; longer ones are rejected rather than truncated. */
const MAX_ID_LENGTH = 64

/**
 * Whether a configured id can be used as-is.
 *
 * Ids end up in storage keys and in the UI as a label, so path separators and
 * whitespace-only values are rejected here rather than producing keys that
 * collide or read badly. Exported because the host registry admits a
 * registration only under the same rules the identity resolver applies.
 */
export function isValidHostId(id: string | undefined): id is string {
  if (id === undefined) return false
  const trimmed = id.trim()
  if (trimmed === '' || trimmed.length > MAX_ID_LENGTH) return false
  // A separator inside the id would let one host's slot read another's.
  return !trimmed.includes('/') && !trimmed.includes('\\')
}

function usable(id: string | undefined): id is string {
  return isValidHostId(id)
}

/**
 * Resolve this tab's host identity.
 *
 * Nothing time-varying goes into the derived id: a reload that changed it would
 * make the host look like it had gone away and come back.
 */
export function resolveHostIdentity(sources: IdentitySources): HostIdentity {
  const configured = usable(sources.configuredHostId)
  const hostId = configured ? sources.configuredHostId!.trim() : deriveId(sources)
  const title = sources.configuredHostTitle?.trim()
  return {
    hostId,
    hostTitle: title !== undefined && title !== '' ? title : readableFallback(sources, hostId),
    derived: !configured,
  }
}

/**
 * Derive a stable id from what distinguishes one machine from another.
 *
 * Only the origin goes in. Every browser reaching the same deployment is the
 * same host; keying on the user agent would let the desktop shell and a phone
 * announce two different ids for one machine and overwrite each other.
 *
 * A short digest rather than the raw origin, so the id keeps one shape however
 * long the origin is and stays safe to use as a key.
 */
function deriveId(sources: IdentitySources): string {
  const material = sources.origin
  let hash = 0x811c9dc5
  for (let index = 0; index < material.length; index++) {
    hash ^= material.charCodeAt(index)
    // FNV-1a: multiply by the prime, staying in 32 bits.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `host-${hash.toString(16).padStart(8, '0')}`
}

/** A title to show when the operator configured none. */
function readableFallback(sources: IdentitySources, hostId: string): string {
  // The host part of the origin is the closest thing to a name this page has.
  const host = sources.origin.replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0]
  return host !== undefined && host !== '' ? host : hostId
}