/**
 * Opening local sessions through DSH's own `uiWorkspace` service.
 *
 * The service belongs to another plugin; nothing about its presence is
 * guaranteed on any given build. Every call narrows structurally and turns
 * absence or failure into `false`, so the tree can say why nothing happened
 * instead of crashing the sidebar it lives in.
 */

type CtxLike = { get(name: string): unknown }

const asOpenSession = (value: unknown): ((sessionId: string) => void) | undefined =>
  typeof (value as { openSession?: unknown } | undefined)?.['openSession'] === 'function'
    ? (value as { openSession: (sessionId: string) => void }).openSession
    : undefined

const asStartSession = (value: unknown): ((workspaceId: string) => void) | undefined =>
  typeof (value as { startSession?: unknown } | undefined)?.['startSession'] === 'function'
    ? (value as { startSession: (workspaceId: string) => void }).startSession
    : undefined

/** Open an existing session. `false` means: not dispatched, caller shows why. */
export function openLocalSession(ctx: CtxLike, sessionId: string): boolean {
  const openSession = asOpenSession(ctx.get('uiWorkspace'))
  if (openSession === undefined) return false
  try {
    openSession(sessionId)
    return true
  } catch {
    return false
  }
}

/** Start a new session inside a project. `false` means: not dispatched. */
export function startSessionInProject(ctx: CtxLike, workspaceId: string): boolean {
  const startSession = asStartSession(ctx.get('uiWorkspace'))
  if (startSession === undefined) return false
  try {
    startSession(workspaceId)
    return true
  } catch {
    return false
  }
}
