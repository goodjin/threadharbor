/**
 * Sidebar actions for a session that runs on another host.
 *
 * Each call is one allowlisted operation on this machine's proxy. A string
 * return is the failure the tree prints; success is `undefined` (or a new id).
 */
import type { RemoteTreeActions } from './host-session-tree.tsx'
import type { RuntimeT } from './locales.ts'
import { remoteSessionOp } from './ssh-deploy.ts'

function sessionIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function remoteTreeActions(t: RuntimeT): RemoteTreeActions {
  const call = (body: Record<string, unknown>) => remoteSessionOp(body, t)
  const done = async (body: Record<string, unknown>): Promise<string | undefined> => {
    const result = await call(body)
    return result.ok ? undefined : result.error
  }
  return {
    async startSession(launchUrl, projectId) {
      const result = await call({ op: 'create', launchUrl, workspaceId: projectId })
      if (!result.ok) return { error: result.error }
      const sessionId = sessionIdOf(result.value)
      return sessionId === undefined ? { error: '远端没有返回新会话编号' } : { sessionId }
    },
    renameWorkspace: (launchUrl, projectId, title) => done({ op: 'rename-workspace', launchUrl, workspaceId: projectId, title }),
    deleteWorkspace: (launchUrl, projectId) => done({ op: 'delete-workspace', launchUrl, workspaceId: projectId }),
    renameSession: (launchUrl, sessionId, title) => done({ op: 'rename-session', launchUrl, sessionId, title }),
    archiveSession: (launchUrl, sessionId) => done({ op: 'archive-session', launchUrl, sessionId }),
    pinSession: (launchUrl, sessionId, pinned) => done({
      op: pinned ? 'pin-session' : 'unpin-session',
      launchUrl,
      sessionId,
    }),
    async forkSession(launchUrl, sessionId) {
      const result = await call({ op: 'fork-session', launchUrl, sessionId })
      if (!result.ok) return { error: result.error }
      const child = sessionIdOf(result.value)
      return child === undefined ? { error: '远端没有返回分叉后的会话编号' } : { sessionId: child }
    },
  }
}
