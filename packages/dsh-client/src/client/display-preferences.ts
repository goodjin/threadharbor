/** Browser-side preferences that control how the sidebar lists sessions and how
 *  the browser archives stale ones. Pure user-interface state — not a server
 *  catalog value — so it lives in `localStorage` and never round-trips through
 *  the gateway. Mirrors the hide/unhide architecture: small settings object,
 *  defaults provided, listener fan-out for cross-component updates. */

/** Hard upper bound on `sessionsPerProjectLimit`. The UI clamps to this so the
 *  cap stays well under the page size and never blows past the project row. */
export const MAX_SESSIONS_PER_PROJECT_LIMIT = 64
/** Hard upper bound on `autoHideSessionsAfterDays`. A year is plenty for the
 *  "auto-archive" knob without letting a stray value wipe a catalog. */
export const MAX_AUTO_HIDE_AFTER_DAYS = 365

/** Browser-side preferences consumed by the sidebar and the auto-archive job. */
export interface DisplayPreferences {
  /** Cap on visible top-level sessions per project in the sidebar tree. */
  readonly sessionsPerProjectLimit: number
  /** Sessions whose `updatedAt` is older than this many days get archived on
   *  the next catalog refresh. `0` disables auto-archiving. */
  readonly autoHideSessionsAfterDays: number
}

/** Defaults shipped with a fresh profile. The limit is the 8-session cap
 *  the user expects; 30 days matches the standard "stale chat" rule of thumb. */
export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = Object.freeze({
  sessionsPerProjectLimit: 8,
  autoHideSessionsAfterDays: 30,
})

const DISPLAY_PREFERENCES_STORAGE_KEY = 'dsh.remote-agent.display-preferences'

function clampLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < 1) return fallback
  if (value > MAX_SESSIONS_PER_PROJECT_LIMIT) return MAX_SESSIONS_PER_PROJECT_LIMIT
  return Math.floor(value)
}

function clampDays(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < 0) return fallback
  if (value > MAX_AUTO_HIDE_AFTER_DAYS) return MAX_AUTO_HIDE_AFTER_DAYS
  return Math.floor(value)
}

function parseDisplayPreferences(value: unknown): DisplayPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_DISPLAY_PREFERENCES
  }
  const record = value as Record<string, unknown>
  return {
    sessionsPerProjectLimit: clampLimit(record['sessionsPerProjectLimit'], DEFAULT_DISPLAY_PREFERENCES.sessionsPerProjectLimit),
    autoHideSessionsAfterDays: clampDays(record['autoHideSessionsAfterDays'], DEFAULT_DISPLAY_PREFERENCES.autoHideSessionsAfterDays),
  }
}

/** Read the persisted preferences. Always returns a valid object — corrupted,
 *  missing, or invalid entries silently fall back to the defaults. */
export function readDisplayPreferences(): DisplayPreferences {
  if (typeof window === 'undefined') return DEFAULT_DISPLAY_PREFERENCES
  try {
    const raw = window.localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY)
    if (raw === null) return DEFAULT_DISPLAY_PREFERENCES
    const parsed: unknown = JSON.parse(raw)
    return parseDisplayPreferences(parsed)
  } catch {
    return DEFAULT_DISPLAY_PREFERENCES
  }
}

/** Persist the preferences. Quota errors and disabled storage are swallowed so
 *  the UI never surfaces storage failures for a setting the user can re-enter. */
export function writeDisplayPreferences(preferences: DisplayPreferences): void {
  if (typeof window === 'undefined') return
  try {
    const sanitized = parseDisplayPreferences(preferences)
    window.localStorage.setItem(DISPLAY_PREFERENCES_STORAGE_KEY, JSON.stringify(sanitized))
    notifyDisplayPreferencesListeners()
  } catch {
    // ignore quota / disabled storage
  }
}

const displayPreferencesListeners = new Set<() => void>()

function notifyDisplayPreferencesListeners(): void {
  for (const listener of displayPreferencesListeners) {
    try {
      listener()
    } catch {
      // listener errors must not break the publish loop
    }
  }
}

/** Subscribe to in-tab preference changes. The store uses this so a save in
 *  the settings panel ripples to the sidebar and to the auto-archive job
 *  without polling. Returns the unsubscribe handle. */
export function subscribeDisplayPreferences(listener: () => void): () => void {
  displayPreferencesListeners.add(listener)
  return () => { displayPreferencesListeners.delete(listener) }
}

/** Result of `applyLimitToSessions`. `visible` is the slice that should be
 *  rendered; `overflow` is the number of sessions hidden behind the toggle;
 *  `showToggle` is `true` exactly when an overflow is currently hidden. */
export interface SessionOverflowResult<T> {
  readonly visible: readonly T[]
  readonly overflow: number
  readonly showToggle: boolean
}

/** Pure helper used by the sidebar to decide which sessions to show. The cap
 *  applies only to top-level sessions under a project; child sessions are
 *  never folded (they live under their parent's row). When `expanded` is
 *  `true` the cap is bypassed and the full list is returned; when `expanded`
 *  is `false` the first `limit` items render and the rest are counted into
 *  `overflow`. The two `parentSessionId`-aware collections are split so
 *  children render after the toggle without being truncated. */
export function applyLimitToSessions<T extends { readonly sessionId: string; readonly parentSessionId?: string }>(
  sessions: readonly T[],
  limit: number,
  expanded: boolean,
): SessionOverflowResult<T> {
  if (sessions.length === 0) {
    return { visible: [], overflow: 0, showToggle: false }
  }
  const roots = sessions.filter(candidate => candidate.parentSessionId === undefined)
  // `limit <= 0` means "no cap" — keep the existing always-render behavior.
  const capped = limit <= 0 || roots.length <= limit || expanded
  if (capped) {
    return { visible: sessions, overflow: 0, showToggle: false }
  }
  const visibleRoots = roots.slice(0, limit)
  const visibleRootIds = new Set(visibleRoots.map(root => root.sessionId))
  // Walk the original input so each surviving root renders with its children
  // in the order they appear, dropping anything whose parent is folded.
  const visible: T[] = []
  for (const candidate of sessions) {
    if (candidate.parentSessionId === undefined) {
      if (visibleRootIds.has(candidate.sessionId)) visible.push(candidate)
      continue
    }
    if (visibleRootIds.has(candidate.parentSessionId)) visible.push(candidate)
  }
  return {
    visible,
    overflow: roots.length - limit,
    showToggle: true,
  }
}

/** Cutoff helper for the auto-archive job. Returns the ISO timestamp the
 *  catalog compares `updatedAt` against; `null` means auto-archive is off. */
export function archiveCutoff(now: number, autoHideSessionsAfterDays: number): string | null {
  if (autoHideSessionsAfterDays <= 0) return null
  const cutoffMs = now - autoHideSessionsAfterDays * 86_400_000
  return new Date(cutoffMs).toISOString()
}