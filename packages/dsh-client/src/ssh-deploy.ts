/**
 * Browser client for ThreadHarbor SSH auto-deploy routes on the serving host.
 */

import type { PeerStatus, SshConnectionInput, SshDeployOperationView, SshDeployRequest, SshHostKeyCandidate } from '@threadharbor/dsh-host-federation'

export const ROUTE_INSPECT = '/api/threadharbor.host-ssh.inspect'
export const ROUTE_DEPLOY = '/api/threadharbor.host-ssh.deploy'
export const ROUTE_OPERATION = '/api/threadharbor.host-ssh.operation'
export const ROUTE_REMOTE_SESSIONS = '/api/threadharbor.host-remote.sessions'
export const ROUTE_PEER = '/api/threadharbor.host-ssh.peer'

type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

async function postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed: unknown = await response.json()
  if (!isRecord(parsed)) return { ok: false, error: `无效响应（HTTP ${response.status}）` }
  if (parsed['ok'] === true) return { ok: true, value: parsed['value'] as T }
  const error = typeof parsed['error'] === 'string' ? parsed['error'] : `请求失败（HTTP ${response.status}）`
  return { ok: false, error }
}

async function getJson<T>(path: string): Promise<ApiResult<T>> {
  const response = await fetch(path)
  const parsed: unknown = await response.json()
  if (!isRecord(parsed)) return { ok: false, error: `无效响应（HTTP ${response.status}）` }
  if (parsed['ok'] === true) return { ok: true, value: parsed['value'] as T }
  const error = typeof parsed['error'] === 'string' ? parsed['error'] : `请求失败（HTTP ${response.status}）`
  return { ok: false, error }
}

export async function inspectSshHost(ssh: SshConnectionInput): Promise<ApiResult<{ readonly keys: readonly SshHostKeyCandidate[] }>> {
  return await postJson(ROUTE_INSPECT, { ssh })
}

export async function readRemotePeer(
  ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
): Promise<ApiResult<PeerStatus>> {
  return await postJson(ROUTE_PEER, { ssh })
}

export async function startSshDeploy(request: SshDeployRequest): Promise<ApiResult<{ readonly operationId: string }>> {
  return await postJson(ROUTE_DEPLOY, request)
}

export async function readSshDeployOperation(operationId: string): Promise<ApiResult<SshDeployOperationView>> {
  return await getJson(`${ROUTE_OPERATION}?operationId=${encodeURIComponent(operationId)}`)
}

export async function waitSshDeployOperation(
  operationId: string,
  onProgress?: (view: SshDeployOperationView) => void,
  pollMs = 800,
): Promise<ApiResult<SshDeployOperationView>> {
  for (;;) {
    const snapshot = await readSshDeployOperation(operationId)
    if (!snapshot.ok) return snapshot
    onProgress?.(snapshot.value)
    if (snapshot.value.status === 'succeeded' || snapshot.value.status === 'failed') return snapshot
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

export async function fetchRemoteHostSessions(launchUrl: string): Promise<ApiResult<{ readonly sessions: readonly { projectId: string; sessionId: string; title: string; projectTitle?: string }[]; readonly note?: string }>> {
  return await postJson(ROUTE_REMOTE_SESSIONS, { launchUrl })
}

export async function probeSshDeployApi(): Promise<boolean> {
  try {
    const response = await fetch(ROUTE_OPERATION, { method: 'HEAD' })
    return response.status !== 404
  } catch {
    return false
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
