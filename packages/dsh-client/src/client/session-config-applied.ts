/**
 * Which sessions already had the remembered composer settings pushed to their
 * agent. The push is meant for an agent that *just* announced its options — a
 * new session or a restarted hold — so it runs once per (session, hold
 * generation). That marker used to live in a React ref, which a page reload or
 * a web restart wiped: every reconnect re-pushed the host-wide remembered mode
 * onto whatever session the user opened next, silently overriding a mode that
 * session had been running with for hours (see docs/bugfix/2026-09-14-
 * reconnect-repushes-remembered-mode.md). Mirroring the marker into
 * localStorage makes it survive reloads; a new hold generation still gets the
 * push because its key differs.
 */

export const SESSION_CONFIG_APPLIED_KEY = 'threadharbor.sessionConfigApplied'
/** Newest markers kept; older ones fall off (their sessions are long idle). */
const MAX_APPLIED_MARKERS = 200

interface MarkerStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storage(): MarkerStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** One marker per session and hold generation. */
export function configAppliedKey(sessionId: string, generation: string | undefined): string {
  return `${sessionId}:${generation ?? 'none'}`
}

/** Markers in insertion order; malformed or unavailable storage yields none. */
export function readAppliedConfigMarkers(store: MarkerStorage | undefined = storage()): readonly string[] {
  try {
    const raw = store?.getItem(SESSION_CONFIG_APPLIED_KEY)
    if (raw === null || raw === undefined) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return []
  }
}

/** Record that a session+generation had its settings pushed; bounded, newest last. */
export function withAppliedConfigMarker(markers: readonly string[], key: string): readonly string[] {
  const next = [...markers.filter(entry => entry !== key), key]
  return next.length > MAX_APPLIED_MARKERS ? next.slice(next.length - MAX_APPLIED_MARKERS) : next
}

/** Persist markers; storage failures (quota, private mode) are ignored. */
export function writeAppliedConfigMarkers(markers: readonly string[], store: MarkerStorage | undefined = storage()): void {
  try {
    store?.setItem(SESSION_CONFIG_APPLIED_KEY, JSON.stringify(markers))
  } catch {
    // Best effort: without storage the in-memory set still guards this page load.
  }
}
