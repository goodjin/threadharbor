/**
 * Opening local sessions through DSH's own `uiWorkspace` service.
 *
 * The service belongs to another plugin; nothing about its presence is
 * guaranteed on any given build. Every call narrows structurally and turns
 * absence or failure into `false`, so the tree can say why nothing happened
 * instead of crashing the sidebar it lives in.
 */

type CtxLike = { get(name: string): unknown }

/** cordis throws for a service it has not granted yet; that is "not yet", not a crash. */
const tryGet = (ctx: CtxLike, name: string): unknown => {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Call through the receiver: these are prototype methods, and a detached call loses `this`. */
type WithOpenSession = { readonly openSession: (sessionId: string) => void }

const hasOpenSession = (value: unknown): value is WithOpenSession =>
  typeof (value as { openSession?: unknown } | null | undefined)?.['openSession'] === 'function'

/** Open an existing session. `false` means: not dispatched, caller shows why. */
export function openLocalSession(ctx: CtxLike, sessionId: string): boolean {
  const ui = tryGet(ctx, 'uiWorkspace')
  if (!hasOpenSession(ui)) return false
  try {
    ui.openSession(sessionId)
    return true
  } catch {
    return false
  }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The workspace's unarchived blank sessions, straight from the two snapshots. */
function blankSessionIdsOf(ctx: CtxLike, workspaceId: string): string[] {
  try {
    const workspaces = ctx.get('workspaces') as {
      list?: { getSnapshot(): { items?: { workspaceId: string; sessionIds: readonly string[] }[]; archivedSessionIds?: readonly string[] } }
    } | undefined
    const sessions = ctx.get('sessions') as {
      list?: { getSnapshot(): { ids?: readonly string[]; byId?: Record<string, { blank?: boolean }> } }
    } | undefined
    const snapshot = workspaces?.list?.getSnapshot()
    const workspace = snapshot?.items?.find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) return []
    const archived = new Set(snapshot?.archivedSessionIds ?? [])
    const summaries = sessions?.list?.getSnapshot()
    return workspace.sessionIds.filter(id => summaries?.byId?.[id]?.blank === true && !archived.has(id))
  } catch {
    return []
  }
}

/** The controller's create resolves to the new session id directly; the
 * Remote envelope ({ok, value}) appears on other builds — accept both. */
type CreateOutcome = string | { readonly ok: boolean; readonly value?: { readonly sessionId?: string }; readonly error?: { readonly message?: string } }
type SessionsCreateHost = {
  readonly create?: (options: { workspaceId: string; sessionId?: string }) => Promise<CreateOutcome>
}

const sessionIdOf = (outcome: CreateOutcome): { sessionId?: string | undefined; rejected?: string } => {
  if (typeof outcome === 'string') return { sessionId: outcome }
  if (outcome.ok === true) return { sessionId: outcome.value?.sessionId }
  return { rejected: outcome.error?.message ?? '会话创建被拒绝' }
}

/**
 * Start a new session inside a project, the native flow rebuilt from parts
 * this tree has already proven live (2026-10-16)： the sessions controller's
 * create (same channel rename uses) plus uiWorkspace.openSession (same call
 * row clicks use). Native's own uiWorkspace.startSession dispatches but then
 * dies silently inside its navigation hop — no RPC, no notice, no console —
 * so the tree drives the two verified ends itself.
 *
 * Blank reuse mirrors the native rule: an existing blank session of this
 * workspace is re-created-in-place instead of piling up new blanks.
 */
export async function startSessionInProject(ctx: CtxLike, workspaceId: string): Promise<string | undefined> {
  try {
    const sessions = ctx.get('sessions') as SessionsCreateHost | undefined
    if (typeof sessions?.create !== 'function') return 'sessions 服务未就绪'
    const ui = tryGet(ctx, 'uiWorkspace')
    if (!hasOpenSession(ui)) return 'uiWorkspace 服务未就绪'
    // Blank reuse, native rule: an unarchived blank session this workspace
    // already claims is re-created-in-place instead of piling up new blanks.
    const blankIds = blankSessionIdsOf(ctx, workspaceId)
    for (const blankId of blankIds) {
      const reused = sessionIdOf(await sessions.create({ workspaceId, sessionId: blankId }))
      if (reused.sessionId !== undefined) {
        ui.openSession(reused.sessionId)
        return undefined
      }
      // A held writer means the blank got claimed; fall through to a fresh one.
    }
    const created = sessionIdOf(await sessions.create({ workspaceId }))
    if (created.rejected !== undefined) return created.rejected
    if (created.sessionId === undefined) return '会话创建未返回编号'
    ui.openSession(created.sessionId)
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

/** Workspace-row actions: called through the receiver so `this` survives. */

export async function renameWorkspace(ctx: CtxLike, workspaceId: string, title: string): Promise<string | undefined> {
  try {
    const workspaces = ctx.get('workspaces') as { rename?: (id: string, title: string) => Promise<unknown> } | undefined
    if (typeof workspaces?.rename !== 'function') return 'workspaces 服务未就绪'
    await workspaces.rename(workspaceId, title)
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

export async function deleteWorkspace(ctx: CtxLike, workspaceId: string): Promise<string | undefined> {
  try {
    const workspaces = ctx.get('workspaces') as { delete?: (id: string) => Promise<unknown> } | undefined
    if (typeof workspaces?.delete !== 'function') return 'workspaces 服务未就绪'
    await workspaces.delete(workspaceId)
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

/** Session-row actions through uiWorkspace (all take the bare session id). */

async function viaUiWorkspace(ctx: CtxLike, method: string, sessionId: string): Promise<string | undefined> {
  try {
    const ui = ctx.get('uiWorkspace') as Record<string, unknown> | undefined
    const action = ui?.[method]
    if (typeof action !== 'function') return 'uiWorkspace 服务未就绪'
    await (action as (id: string) => Promise<unknown>).call(ui, sessionId)
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

export function archiveSession(ctx: CtxLike, sessionId: string): Promise<string | undefined> {
  return viaUiWorkspace(ctx, 'archiveSession', sessionId)
}

export function unarchiveSession(ctx: CtxLike, sessionId: string): Promise<string | undefined> {
  return viaUiWorkspace(ctx, 'unarchiveSession', sessionId)
}

export function pinSession(ctx: CtxLike, sessionId: string): Promise<string | undefined> {
  return viaUiWorkspace(ctx, 'pinSession', sessionId)
}

export function unpinSession(ctx: CtxLike, sessionId: string): Promise<string | undefined> {
  return viaUiWorkspace(ctx, 'unpinSession', sessionId)
}

export function forkSession(ctx: CtxLike, sessionId: string): Promise<string | undefined> {
  return viaUiWorkspace(ctx, 'forkSession', sessionId)
}

/**
 * Session rename follows the controller's binding hop: `sessions.using`
 * hands the callback a reference whose binding carries the session facade.
 */
export async function renameSession(ctx: CtxLike, sessionId: string, title: string): Promise<string | undefined> {
  try {
    const sessions = ctx.get('sessions') as {
      using?: (id: string, opts: { source: string }, run: (reference: unknown) => unknown) => Promise<unknown>
    } | undefined
    if (typeof sessions?.using !== 'function') return 'sessions 服务未就绪'
    const result: unknown = await sessions.using(sessionId, { source: 'workspaceOperation' }, reference => {
      const rename = (reference as { binding?: { session?: { rename?: (title: string) => Promise<unknown> } } })?.binding?.session?.rename
      if (typeof rename !== 'function') throw new Error('会话绑定缺失 rename')
      return rename.call((reference as { binding: { session: object } }).binding.session, title)
    })
    if (result !== undefined && result !== null && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok === false) {
      return messageOf((result as { error?: { message?: unknown } }).error ?? '重命名被拒绝')
    }
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}
