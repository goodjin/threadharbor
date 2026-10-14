/**
 * This host's sessions, read from DSH's own client services.
 *
 * The roll-up used to say on screen that a page cannot read the session list.
 * That sentence was wrong, and this module is its correction: the workspace
 * controller and the session controller both project host state into the
 * browser (`workspaces.list`, `sessions.list`), and DSH's own sidebar reads
 * exactly these. The shapes below are checked structurally — nothing arriving
 * from `ctx.get` is trusted without a predicate — so a missing or half-loaded
 * service reads as "not ready, here is why", never as an empty tree that looks
 * like the truth.
 *
 * Placement and the 未归组 bucket come from the federation's own
 * `sessionsFromWorkspaces`, the same rules the roll-up applies to published
 * lists from other tabs.
 */

import { sessionsFromWorkspaces } from '@threadharbor/dsh-host-federation'
import type { SessionLike, WorkspaceLike } from '@threadharbor/dsh-host-federation'
import { fallbackT } from './locales.ts'
import type { RuntimeT } from './locales.ts'

/** One session as the roll-up publishes and lists it. */
export type SourceSession = {
  readonly projectId: string
  readonly sessionId: string
  readonly title: string
  readonly projectTitle: string
}

/** What one read produced: rows, or the reason there are none. */
export type SessionRead =
  | { readonly ok: true; readonly sessions: readonly SourceSession[] }
  | { readonly ok: false; readonly note: string }

/** The workspace projection this module needs, narrowed from `ctx.get('workspaces')`. */
export type WorkspaceListSource = {
  readonly items: readonly {
    readonly workspaceId: string
    readonly title: string
    readonly path: string
    readonly sessionIds: readonly string[]
  }[]
  readonly archivedSessionIds: readonly string[]
  readonly state: string
  /** Present when the service exposes one; change notifications for republish. */
  readonly subscribe?: (listener: () => void) => () => void
}

/** The session projection this module needs, narrowed from `ctx.get('sessions')`. */
export type SessionListSource = {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, { readonly displayTitle?: string; readonly title?: string }>>
  /** Present when the service exposes one; change notifications for republish. */
  readonly subscribe?: (listener: () => void) => () => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Read the two projections off the context, or name what is missing.
 *
 * Both services are provided by DSH's own client packages and may still be
 * arriving when this panel applies, so absence here is "not yet": the caller
 * retries on the next publish instead of giving up for the page's lifetime.
 * Each read is guarded because a context that has not granted a service yet
 * throws instead of answering undefined.
 */
export function readSessionSources(ctx: { readonly workspaces: unknown; readonly sessions: unknown }): {
  readonly workspaces: WorkspaceListSource | undefined
  readonly sessions: SessionListSource | undefined
} {
  return {
    workspaces: workspaceSource(tryRead(ctx, 'workspaces')),
    sessions: sessionSource(tryRead(ctx, 'sessions')),
  }
}

function tryRead(ctx: { readonly workspaces: unknown; readonly sessions: unknown }, name: 'workspaces' | 'sessions'): unknown {
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

function workspaceSource(value: unknown): WorkspaceListSource | undefined {
  if (!isRecord(value)) return undefined
  const snapshot = snapshotOf(value)
  if (snapshot === undefined) return undefined
  const items = snapshot['items']
  const archived = snapshot['archivedSessionIds']
  const state = snapshot['state']
  if (!Array.isArray(items) || !Array.isArray(archived) || typeof state !== 'string') return undefined
  type WorkspaceRow = {
    readonly workspaceId: string
    readonly title: string
    readonly path: string
    readonly sessionIds: readonly string[]
  }
  const rows: WorkspaceRow[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const workspaceId = item['workspaceId']
    const title = item['title']
    const path = item['path']
    const sessionIds = item['sessionIds']
    if (typeof workspaceId !== 'string' || typeof title !== 'string' || typeof path !== 'string') continue
    if (!Array.isArray(sessionIds) || !sessionIds.every(id => typeof id === 'string')) continue
    rows.push({ workspaceId, title, path, sessionIds })
  }
  const subscribe = subscriberOf(value)
  return {
    items: rows,
    archivedSessionIds: archived.filter((id): id is string => typeof id === 'string'),
    state,
    ...(subscribe === undefined ? {} : { subscribe }),
  }
}

function sessionSource(value: unknown): SessionListSource | undefined {
  if (!isRecord(value)) return undefined
  const snapshot = snapshotOf(value)
  if (snapshot === undefined) return undefined
  const ids = snapshot['ids']
  const byId = snapshot['byId']
  if (!Array.isArray(ids) || !isRecord(byId)) return undefined
  const rows: Record<string, { displayTitle?: string; title?: string }> = {}
  for (const [id, row] of Object.entries(byId)) {
    if (!isRecord(row)) continue
    const displayTitle = row['displayTitle']
    const title = row['title']
    rows[id] = {
      ...(typeof displayTitle === 'string' ? { displayTitle } : {}),
      ...(typeof title === 'string' ? { title } : {}),
    }
  }
  const subscribe = subscriberOf(value)
  return {
    ids: ids.filter((id): id is string => typeof id === 'string'),
    byId: rows,
    ...(subscribe === undefined ? {} : { subscribe }),
  }
}

/**
 * Find the list snapshot on a projection service. DSH's client services expose
 * their list through `.list.getSnapshot()` (the shape the stock sidebar reads),
 * while the federation-facing shapes carry `getSnapshot` on the service root —
 * accept either rather than guessing which half this page got.
 */
function snapshotOf(service: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = readSnapshot(service)
  if (direct !== undefined) return direct
  const list = service['list']
  return isRecord(list) ? readSnapshot(list) : undefined
}

function readSnapshot(shape: Record<string, unknown>): Record<string, unknown> | undefined {
  const getSnapshot = shape['getSnapshot']
  if (typeof getSnapshot !== 'function') return undefined
  try {
    const snapshot: unknown = getSnapshot.call(shape)
    return isRecord(snapshot) ? snapshot : undefined
  } catch {
    // A service that throws on read is a service this page cannot use yet.
    return undefined
  }
}

/** The service's subscribe, bound to it, when it really is one. */
function subscriberOf(service: Record<string, unknown>): ((listener: () => void) => () => void) | undefined {
  // The subscription lives next to the snapshot: on the list store for DSH's
  // client services, on the service root for the federation-facing shapes.
  const list = service['list']
  const holder = isRecord(list) && typeof list['subscribe'] === 'function' ? list : service
  const subscribe = holder['subscribe']
  if (typeof subscribe !== 'function') return undefined
  return listener => {
    const detach: unknown = subscribe.call(holder, listener)
    return typeof detach === 'function' ? detach as () => void : () => {}
  }
}

/**
 * Build this host's session rows from the two projections.
 *
 * Every failure mode names itself, so the panel can say why a host shows no
 * rows instead of looking caught up when it never read anything.
 * @param workspaces - the workspace projection, or undefined while absent.
 * @param sessions - the session projection, or undefined while absent.
 * @param t - reads the not-ready notes in the active language; absent
 * (tests, no locale service) it falls back to the dictionary's source text.
 * @returns rows grouped host-side into projects, or the reason there are none.
 */
export function buildHostSessions(
  workspaces: WorkspaceListSource | undefined,
  sessions: SessionListSource | undefined,
  t: RuntimeT = fallbackT,
): SessionRead {
  if (workspaces === undefined) {
    return { ok: false, note: t('panel.session.noWorkspacesService') }
  }
  if (workspaces.state === 'error') {
    return { ok: false, note: t('panel.session.readFailed') }
  }
  if (workspaces.state === 'loading') {
    return { ok: false, note: t('panel.session.stillLoading') }
  }
  const workspacesLike: readonly WorkspaceLike[] = workspaces.items.map(row => ({
    workspaceId: row.workspaceId,
    title: row.title,
    path: row.path,
    sessionIds: row.sessionIds,
  }))
  // With the session projection present, rows carry real titles and the
  // host's own list order decides the 未归组 bucket. Without it, the
  // workspaces still know which sessions exist and where they belong — the
  // rows fall back to their ids as titles rather than the tree going empty.
  // The empty string is deliberate: the federation's own describe() turns an
  // empty title into 「会话 <id>」, so the fallback lives in one place.
  // Archived marks ride the workspace projection's registry-global set; the
  // federation filters on them, so a set-aside session leaves the tree.
  const sessionLikes: readonly SessionLike[] = sessions !== undefined
    ? sessions.ids.map(id => ({
        sessionId: id,
        title: sessions.byId[id]?.displayTitle ?? sessions.byId[id]?.title ?? '',
        ...(workspaces.archivedSessionIds.includes(id) ? { archived: true } : {}),
      }))
    : [...new Set(workspaces.items.flatMap(row => [...row.sessionIds]))].map(id => ({
        sessionId: id,
        title: '',
        ...(workspaces.archivedSessionIds.includes(id) ? { archived: true } : {}),
      }))
  const placed = sessionsFromWorkspaces(workspacesLike, { sessions: sessionLikes })
  return {
    ok: true,
    sessions: placed.map(row => ({
      projectId: row.projectId,
      sessionId: row.sessionId,
      title: row.title,
      projectTitle: row.projectTitle,
    })),
  }
}
