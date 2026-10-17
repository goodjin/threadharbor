/**
 * Pull workspace/session snapshots from a remote DSH Web using a launch URL token.
 *
 * Runs on the machine serving the management UI (server-side fetch), so browser
 * CORS does not block cross-origin reads.
 *
 * Auth: DSH only exchanges `?token=` on `GET /` into a session cookie; API paths
 * reject a bare token query. We mint that cookie first, then call the same RPCs
 * the mobile client uses (`workspace/list` + `session/list`) so each row carries
 * `updatedAt` / `running` for the tree's sort and active marker.
 */

import type { HostSession } from './federation.ts'

export type RemoteSessionSnapshot = {
  readonly sessions: readonly HostSession[]
  readonly note?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type SessionMeta = {
  readonly updatedAt?: number
  readonly running?: boolean
  readonly blank?: boolean
  readonly title?: string
}

type WorkspaceRow = {
  readonly projectId: string
  readonly projectTitle: string
  readonly sessionIds: readonly string[]
}

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

  let cookie: string | undefined
  try {
    cookie = await exchangeAuthCookie(origin, token)
  } catch (error) {
    return {
      sessions: [],
      note: `换取远端登录 cookie 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (cookie === undefined) {
    // Legacy fallback: some older/proxied builds accepted ?token= on workspace GET.
    return await legacyWorkspaceGet(origin, token)
  }

  let lastStatus = 'network error'
  try {
    const { workspaces, archived } = await rpcWorkspaceList(origin, cookie)
    const { byId } = await rpcSessionList(origin, cookie)
    const sessions = mergeRemoteSessions(workspaces, byId, archived)
    // Both lists answered. Zero projects is an empty machine, not a failed fetch —
    // treating it as failure made a healthy host look broken and wiped its row.
    return { sessions }
  } catch (error) {
    lastStatus = error instanceof Error ? error.message : 'network error'
  }

  // Cookie worked enough to authenticate, but RPC shape mismatched — try legacy GET once.
  const legacy = await legacyWorkspaceGet(origin, token)
  if (legacy.sessions.length > 0) return legacy

  return {
    sessions: [],
    note: `未能从远端读取项目/会话列表（API 路径或版本不匹配，最后尝试结果：${lastStatus}）。请在该主机打开 DSH 标签页，或确认 launchUrl 仍有效。`,
  }
}

/** GET /?token= → Set-Cookie (DSH only mints auth on the index path). */
async function exchangeAuthCookie(origin: string, token: string): Promise<string | undefined> {
  const response = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, {
    method: 'GET',
    redirect: 'manual',
  })
  const cookie = cookieHeaderFrom(response)
  if (cookie !== undefined) return cookie
  // Some builds may 200 the index with Set-Cookie while still redirecting in browsers.
  if (response.status >= 200 && response.status < 400) {
    // Follow once if Location is same-origin and we still have no cookie.
    const location = response.headers.get('location')
    if (location !== null && location !== '') {
      const next = new URL(location, origin)
      if (next.origin === origin) {
        const followed = await fetch(next.href, { method: 'GET', redirect: 'manual', headers: cookie === undefined ? {} : { cookie } })
        return cookieHeaderFrom(followed) ?? cookie
      }
    }
  }
  return undefined
}

function cookieHeaderFrom(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const listed = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const parts = listed.length > 0
    ? listed
    : (() => {
        const single = response.headers.get('set-cookie')
        return single === null ? [] : [single]
      })()
  const pairs = parts
    .map(entry => entry.split(';', 1)[0]?.trim())
    .filter((pair): pair is string => typeof pair === 'string' && pair.includes('='))
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

async function rpcCall(origin: string, cookie: string, endpoint: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `th-remote-${endpoint.replace(/\W+/g, '-')}-${Date.now()}`,
      method: endpoint,
      payload: { args },
    }),
    redirect: 'follow',
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error(`HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error('非 JSON 对象应答')
  const result = body['result']
  if (isRecord(result) && result['ok'] === true) return result['value']
  if (isRecord(result) && result['ok'] === false) {
    const message = isRecord(result['error']) && typeof result['error']['message'] === 'string'
      ? result['error']['message']
      : 'RPC 被拒绝'
    throw new Error(message)
  }
  // Some gateways unwrap to {ok,value} at the top level.
  if (body['ok'] === true) return body['value']
  return body
}

async function rpcWorkspaceList(origin: string, cookie: string): Promise<{
  readonly workspaces: readonly WorkspaceRow[]
  readonly archived: ReadonlySet<string>
}> {
  // Prefer slash form (mobile/gateway); fall back to dotted apiproxy path.
  const attempts: ReadonlyArray<{ endpoint: string; args: Record<string, unknown> }> = [
    { endpoint: 'workspace/list', args: {} },
    { endpoint: 'workspace.list', args: {} },
  ]
  let lastError: unknown
  for (const attempt of attempts) {
    try {
      const value = await rpcCall(origin, cookie, attempt.endpoint, attempt.args)
      const rows = parseWorkspaceRows(value)
      const archived = parseArchivedIds(value)
      if (rows.length > 0 || isRecord(value)) return { workspaces: rows, archived }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'workspace/list 失败'))
}

async function rpcSessionList(origin: string, cookie: string): Promise<{
  readonly byId: ReadonlyMap<string, SessionMeta>
}> {
  const attempts: ReadonlyArray<{ endpoint: string; args: Record<string, unknown> }> = [
    { endpoint: 'session/list', args: { _request: {} } },
    { endpoint: 'session.list', args: {} },
  ]
  let lastError: unknown
  for (const attempt of attempts) {
    try {
      const value = await rpcCall(origin, cookie, attempt.endpoint, attempt.args)
      return { byId: parseSessionList(value) }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'session/list 失败'))
}

export type RemoteRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }

const ENDPOINT_PATTERN = /^[A-Za-z0-9_$./-]+$/

/**
 * One authenticated RPC against the DSH named by a launch URL.
 *
 * The browser never talks to that origin itself (cookie and CORS live on the
 * machine serving this page). Callers pass a fixed endpoint, never a URL.
 */
export async function callRemoteDsh(
  launchUrl: string,
  endpoint: string,
  args: Record<string, unknown>,
): Promise<RemoteRpcResult> {
  if (!ENDPOINT_PATTERN.test(endpoint) || endpoint.includes('//')) {
    return { ok: false, error: '远端接口名不合法' }
  }
  let parsed: URL
  try {
    parsed = new URL(launchUrl.trim())
  } catch {
    return { ok: false, error: 'launchUrl 无效' }
  }
  const token = parsed.searchParams.get('token')
  if (token === null || token === '') return { ok: false, error: 'launchUrl 缺少 token' }
  let cookie: string | undefined
  try {
    cookie = await exchangeAuthCookie(parsed.origin, token)
  } catch (error) {
    return { ok: false, error: `换取远端登录 cookie 失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (cookie === undefined) return { ok: false, error: '远端没有换出登录 cookie，打开地址可能已失效' }
  try {
    const value = await rpcCallWithFallback(parsed.origin, cookie, endpoint, args)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Slash form first; a 404 retries the dotted apiproxy name. */
async function rpcCallWithFallback(
  origin: string,
  cookie: string,
  endpoint: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await rpcCall(origin, cookie, endpoint, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const dotted = endpoint.replaceAll('/', '.')
    if (message === 'HTTP 404' && dotted !== endpoint) return await rpcCall(origin, cookie, dotted, args)
    throw error
  }
}

function parseWorkspaceRows(value: unknown): WorkspaceRow[] {
  if (!isRecord(value)) return []
  const items = value['items'] ?? value['workspaces']
  if (!Array.isArray(items)) return []
  const rows: WorkspaceRow[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const projectId = item['workspaceId'] ?? item['projectId']
    const projectTitle = item['title'] ?? item['name']
    const sessionIds = item['sessionIds']
    if (typeof projectId !== 'string' || !Array.isArray(sessionIds)) continue
    rows.push({
      projectId,
      projectTitle: typeof projectTitle === 'string' && projectTitle !== '' ? projectTitle : projectId,
      sessionIds: sessionIds.filter((id): id is string => typeof id === 'string' && id !== ''),
    })
  }
  return rows
}

function parseArchivedIds(value: unknown): ReadonlySet<string> {
  if (!isRecord(value)) return new Set()
  const raw = value['archivedSessionIds']
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter((id): id is string => typeof id === 'string'))
}

function parseSessionList(value: unknown): ReadonlyMap<string, SessionMeta> {
  const byId = new Map<string, SessionMeta>()
  if (!isRecord(value)) return byId
  const items = value['items']
  if (!Array.isArray(items)) return byId
  for (const item of items) {
    if (!isRecord(item)) continue
    const sessionId = item['sessionId']
    if (typeof sessionId !== 'string' || sessionId === '') continue
    const updatedAt = item['updatedAt']
    const running = item['running']
    const blank = item['blank']
    const projections = item['projections']
    let title: string | undefined
    if (isRecord(projections)) {
      const values = projections['values']
      if (isRecord(values) && typeof values['title'] === 'string' && values['title'] !== '') {
        title = values['title']
      }
    }
    byId.set(sessionId, {
      ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
      ...(running === true ? { running: true } : {}),
      ...(blank === true ? { blank: true } : {}),
      ...(title === undefined ? {} : { title }),
    })
  }
  return byId
}

/**
 * Join workspace membership with session/list metadata.
 * Blank sessions stay out (native list rule). Sessions only in the list land in 未归组.
 */
export function mergeRemoteSessions(
  workspaces: readonly WorkspaceRow[],
  byId: ReadonlyMap<string, SessionMeta>,
  archived: ReadonlySet<string>,
): HostSession[] {
  const sessions: HostSession[] = []
  const placed = new Set<string>()

  const push = (projectId: string, projectTitle: string, sessionId: string): void => {
    if (placed.has(sessionId)) return
    const meta = byId.get(sessionId)
    if (meta?.blank === true) return
    // If session/list is authoritative and omits a workspace member, still show the id
    // (cold list lag); prefer meta when present.
    placed.add(sessionId)
    sessions.push({
      projectId,
      sessionId,
      title: meta?.title ?? `会话 ${sessionId}`,
      projectTitle,
      ...(archived.has(sessionId) ? { archived: true } : {}),
      ...(typeof meta?.updatedAt === 'number' ? { updatedAt: meta.updatedAt } : {}),
      ...(meta?.running === true ? { running: true } : {}),
    })
  }

  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      push(workspace.projectId, workspace.projectTitle, sessionId)
    }
  }
  for (const [sessionId, meta] of byId) {
    if (placed.has(sessionId) || meta.blank === true) continue
    push('ungrouped', '未归组', sessionId)
  }
  return sessions
}

async function legacyWorkspaceGet(origin: string, token: string): Promise<RemoteSessionSnapshot> {
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
      const sessions = parseWorkspacePayloadLegacy(body)
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

function parseWorkspacePayloadLegacy(body: unknown): HostSession[] {
  if (!isRecord(body)) return []
  // RPC-shaped {result:{ok,value}} or bare {items|workspaces}.
  const root = isRecord(body['result']) && body['result']['ok'] === true
    ? body['result']['value']
    : body['ok'] === true
      ? body['value']
      : body
  const rows = parseWorkspaceRows(root)
  return mergeRemoteSessions(rows, new Map(), new Set())
}
