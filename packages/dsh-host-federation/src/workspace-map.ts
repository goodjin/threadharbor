/**
 * Turning a host's workspaces into the sessions a roll-up lists.
 *
 * DSH's own workspace store keeps sessions whose directory has gone as
 * *ungrouped* rather than deleting them (`packages/workspace/workspace/src/entity.ts:3-13`).
 * A roll-up that quietly dropped them would show a shorter conversation list
 * than the host itself, with nothing to say why.
 *
 * The shapes are structural rather than DSH's own types, because a roll-up also
 * has to cope with a host reporting something older than this package.
 */

/** A workspace as the host reports it: this is DSH's `WorkspaceView`. */
export type WorkspaceLike = {
  readonly workspaceId: string
  readonly title: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** A session as the host reports it. */
export type SessionLike = {
  readonly sessionId: string
  readonly title: string
  readonly archived?: boolean
  /** Pinned rows lead their project in the tree. */
  readonly pinned?: boolean
  /** Last activity stamp; orders the tree's 最近更新 sort (last human prompt). */
  readonly updatedAt?: number
  /** True while a turn is in flight. */
  readonly running?: boolean
  /** Native amber-dot: approval / plan-review / question. */
  readonly pendingInteraction?: 'approval' | 'plan-review' | 'question'
}

export type WorkspaceSession = {
  /** The workspace, or `ungrouped` for a session whose directory is gone. */
  readonly projectId: string
  readonly sessionId: string
  readonly title: string
  readonly projectTitle: string
  readonly projectPath: string
  /** View-option flags that must survive the mapping (pinned/archived/stamp). */
  readonly pinned?: boolean
  readonly archived?: boolean
  readonly updatedAt?: number
  readonly running?: boolean
  readonly pendingInteraction?: 'approval' | 'plan-review' | 'question'
}

/** The bucket for sessions that belong to no workspace. */
export const UNGROUPED = 'ungrouped'

export function sessionsFromWorkspaces(
  workspaces: readonly WorkspaceLike[],
  options: { readonly sessions: readonly SessionLike[]; readonly includeArchived?: boolean },
): WorkspaceSession[] {
  const entries: WorkspaceSession[] = []
  const placed = new Set<string>()

  for (const workspace of workspaces) {
    // A half-built workspace must not become a group with nothing in it.
    if (workspace.workspaceId === '' || workspace.title === '') continue
    for (const sessionId of workspace.sessionIds) {
      // Two workspaces claiming one session would list the same conversation
      // twice, and clicking either would look like two different ones.
      if (placed.has(sessionId)) continue
      placed.add(sessionId)
      const session = find(options.sessions, sessionId)
      if (session === undefined) continue
      if (session.archived === true && options.includeArchived !== true) continue
      entries.push(describe(session, workspace.workspaceId, workspace.title, workspace.path))
    }
  }

  // Whatever the host still lists but no workspace claims is kept, under the
  // ungrouped bucket: the host is showing it, so the roll-up shows it too.
  for (const session of options.sessions) {
    if (placed.has(session.sessionId)) continue
    if (session.archived === true && options.includeArchived !== true) continue
    placed.add(session.sessionId)
    entries.push(describe(session, UNGROUPED, '未归组', ''))
  }

  return entries
}

function describe(
  session: SessionLike,
  projectId: string,
  projectTitle: string,
  projectPath: string,
): WorkspaceSession {
  return {
    projectId,
    sessionId: session.sessionId,
    // A session with no title still needs something to click on.
    title: session.title.trim() === '' ? `会话 ${session.sessionId}` : session.title,
    projectTitle,
    projectPath,
    ...(session.pinned === true ? { pinned: true } : {}),
    ...(session.archived === true ? { archived: true } : {}),
    ...(typeof session.updatedAt === 'number' ? { updatedAt: session.updatedAt } : {}),
    ...(session.running === true ? { running: true } : {}),
    ...(session.pendingInteraction === 'approval'
      || session.pendingInteraction === 'plan-review'
      || session.pendingInteraction === 'question'
      ? { pendingInteraction: session.pendingInteraction }
      : {}),
  }
}

function find(sessions: readonly SessionLike[], sessionId: string): SessionLike | undefined {
  return sessions.find(session => session.sessionId === sessionId)
}