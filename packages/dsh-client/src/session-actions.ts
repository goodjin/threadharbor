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
type WithStartSession = { readonly startSession: (workspaceId: string) => void }

const hasOpenSession = (value: unknown): value is WithOpenSession =>
  typeof (value as { openSession?: unknown } | null | undefined)?.['openSession'] === 'function'

const hasStartSession = (value: unknown): value is WithStartSession =>
  typeof (value as { startSession?: unknown } | null | undefined)?.['startSession'] === 'function'

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

/** Start a new session inside a project. `false` means: not dispatched. */
export function startSessionInProject(ctx: CtxLike, workspaceId: string): boolean {
  const ui = tryGet(ctx, 'uiWorkspace')
  if (!hasStartSession(ui)) return false
  try {
    ui.startSession(workspaceId)
    return true
  } catch {
    return false
  }
}

/** Workspace-row actions: called through the receiver so `this` survives. */

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

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
