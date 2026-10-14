/**
 * Opening local sessions through DSH's own `uiWorkspace` service.
 *
 * The service belongs to another plugin; nothing about its presence is
 * guaranteed on any given build. Every call narrows structurally and turns
 * absence or failure into `false`, so the tree can say why nothing happened
 * instead of crashing the sidebar it lives in.
 */

type CtxLike = { get(name: string): unknown }

/** Call through the receiver: these are prototype methods, and a detached call loses `this`. */
type WithOpenSession = { readonly openSession: (sessionId: string) => void }
type WithStartSession = { readonly startSession: (workspaceId: string) => void }

const hasOpenSession = (value: unknown): value is WithOpenSession =>
  typeof (value as { openSession?: unknown } | null | undefined)?.['openSession'] === 'function'

const hasStartSession = (value: unknown): value is WithStartSession =>
  typeof (value as { startSession?: unknown } | null | undefined)?.['startSession'] === 'function'

/** Open an existing session. `false` means: not dispatched, caller shows why. */
export function openLocalSession(ctx: CtxLike, sessionId: string): boolean {
  const ui = ctx.get('uiWorkspace')
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
  const ui = ctx.get('uiWorkspace')
  if (!hasStartSession(ui)) return false
  try {
    ui.startSession(workspaceId)
    return true
  } catch {
    return false
  }
}
