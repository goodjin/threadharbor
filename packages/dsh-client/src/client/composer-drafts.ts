/**
 * Per-session composer drafts. The conversation surface is one component
 * that re-renders for whichever session is selected, so a single `draft`
 * state followed the user from session to session. Drafts are keyed by
 * session id and mirrored into sessionStorage so a reload keeps them too.
 */

export type ComposerDrafts = Readonly<Record<string, string>>

export const COMPOSER_DRAFTS_KEY = 'threadharbor.composerDrafts'
/** Longest draft kept per session (characters). */
const MAX_DRAFT_CHARS = 20_000
/** Sessions whose drafts are remembered; oldest keys are dropped beyond this. */
const MAX_DRAFT_SESSIONS = 50

interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storage(): DraftStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

/** Load remembered drafts; malformed or unavailable storage yields none. */
export function readComposerDrafts(store: DraftStorage | undefined = storage()): ComposerDrafts {
  try {
    const raw = store?.getItem(COMPOSER_DRAFTS_KEY)
    if (raw === null || raw === undefined) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const drafts: Record<string, string> = {}
    for (const [sessionId, text] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof text === 'string' && text !== '') drafts[sessionId] = text
    }
    return drafts
  } catch {
    return {}
  }
}

/** Persist drafts; storage failures (quota, private mode) are ignored. */
export function writeComposerDrafts(drafts: ComposerDrafts, store: DraftStorage | undefined = storage()): void {
  try {
    store?.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(drafts))
  } catch {
    // Best effort only: the in-memory copy still drives the composer.
  }
}

/**
 * Return drafts with one session's text replaced. Empty text removes the
 * entry; the newest entries win when the session cap is exceeded.
 */
export function withComposerDraft(drafts: ComposerDrafts, sessionId: string, text: string): ComposerDrafts {
  const { [sessionId]: _previous, ...rest } = drafts
  if (text === '') return rest
  const next: Record<string, string> = { ...rest, [sessionId]: text.slice(0, MAX_DRAFT_CHARS) }
  const keys = Object.keys(next)
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_DRAFT_SESSIONS))) delete next[stale]
  return next
}
