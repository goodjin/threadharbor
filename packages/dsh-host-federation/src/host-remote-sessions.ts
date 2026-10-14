/**
 * Pull workspace/session snapshots from a remote DSH Web using a launch URL token.
 *
 * Runs on the machine serving the management UI (server-side fetch), so browser
 * CORS does not block cross-origin reads.
 */

import type { HostSession } from './federation.ts'

export type RemoteSessionSnapshot = {
  readonly sessions: readonly HostSession[]
  readonly note?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * @param launchUrl - full DSH entry URL including `?token=`.
 */
export async function fetchRemoteSessions(launchUrl: string): Promise<RemoteSessionSnapshot> {
  let parsed: URL
  try {
    parsed = new URL(launchUrl.trim())
  } catch {
    return { sessions: [], note: 'launchUrl 无效' }
  }
  const token = parsed.searchParams.get('token')
  if (token === null || token === '') {
    return { sessions: [], note: 'launchUrl 缺少 token' }
  }
  const origin = parsed.origin
  const candidates = [
    `${origin}/api/workspace/list?token=${encodeURIComponent(token)}`,
    `${origin}/api/workspaces?token=${encodeURIComponent(token)}`,
  ]
  let lastStatus = 'network error'
  for (const url of candidates) {
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'follow' })
      if (!response.ok) {
        lastStatus = `HTTP ${response.status}`
        continue
      }
      const body: unknown = await response.json()
      const sessions = parseWorkspacePayload(body)
      if (sessions.length > 0) return { sessions }
      lastStatus = 'empty payload'
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : 'network error'
    }
  }
  return {
    sessions: [],
    note: `未能从远端读取项目/会话列表（API 路径或版本不匹配，最后尝试结果：${lastStatus}）。请在该主机打开 DSH 标签页，或确认 launchUrl 仍有效。`,
  }
}

function parseWorkspacePayload(body: unknown): HostSession[] {
  if (!isRecord(body)) return []
  const items = body['items'] ?? body['workspaces'] ?? body['value']
  if (!Array.isArray(items)) return []
  const sessions: HostSession[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const projectId = item['workspaceId'] ?? item['projectId']
    const projectTitle = item['title'] ?? item['name']
    const sessionIds = item['sessionIds']
    if (typeof projectId !== 'string' || !Array.isArray(sessionIds)) continue
    const titleBase = typeof projectTitle === 'string' ? projectTitle : projectId
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      sessions.push({
        projectId,
        sessionId,
        title: `会话 ${sessionId}`,
        projectTitle: titleBase,
      })
    }
  }
  return sessions
}
