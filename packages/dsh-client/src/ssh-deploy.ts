/**
 * Browser client for ThreadHarbor SSH auto-deploy routes on the serving host.
 */

import type { HostSession, PeerStatus, SshConnectResult, SshConnectionInput, SshDeployOperationView, SshDeployRequest, SshHostKeyCandidate } from '@threadharbor/dsh-host-federation'
import type { RuntimeT } from './locales.ts'
import { fallbackT } from './locales.ts'

export const ROUTE_INSPECT = '/api/threadharbor.host-ssh.inspect'
export const ROUTE_DEPLOY = '/api/threadharbor.host-ssh.deploy'
export const ROUTE_OPERATION = '/api/threadharbor.host-ssh.operation'
export const ROUTE_PEER = '/api/threadharbor.host-ssh.peer'
export const ROUTE_CONNECT = '/api/threadharbor.host-ssh.connect'
export const ROUTE_REMOTE_SESSIONS = '/api/threadharbor.host-remote.sessions'

type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

async function postJson<T>(path: string, body: unknown, t: RuntimeT = fallbackT): Promise<ApiResult<T>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed: unknown = await response.json()
  if (!isRecord(parsed)) return { ok: false, error: t('panel.ssh.httpInvalid', { status: response.status }) }
  if (parsed['ok'] === true) return { ok: true, value: parsed['value'] as T }
  const error = typeof parsed['error'] === 'string' ? parsed['error'] : t('panel.ssh.httpFailed', { status: response.status })
  return { ok: false, error }
}

async function getJson<T>(path: string, t: RuntimeT = fallbackT): Promise<ApiResult<T>> {
  const response = await fetch(path)
  const parsed: unknown = await response.json()
  if (!isRecord(parsed)) return { ok: false, error: t('panel.ssh.httpInvalid', { status: response.status }) }
  if (parsed['ok'] === true) return { ok: true, value: parsed['value'] as T }
  const error = typeof parsed['error'] === 'string' ? parsed['error'] : t('panel.ssh.httpFailed', { status: response.status })
  return { ok: false, error }
}

export async function inspectSshHost(ssh: SshConnectionInput, t: RuntimeT = fallbackT): Promise<ApiResult<{ readonly keys: readonly SshHostKeyCandidate[] }>> {
  return await postJson(ROUTE_INSPECT, { ssh }, t)
}

export async function readRemotePeer(
  ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
  t: RuntimeT = fallbackT,
): Promise<ApiResult<PeerStatus>> {
  return await postJson(ROUTE_PEER, { ssh }, t)
}

/** Reach an already-deployed host: read its record, ensure the route, get the URL to open. */
export async function connectRemoteHost(
  ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
  remoteWebPort?: number,
  t: RuntimeT = fallbackT,
): Promise<ApiResult<SshConnectResult>> {
  return await postJson(ROUTE_CONNECT, { ssh, ...(remoteWebPort === undefined ? {} : { remoteWebPort }) }, t)
}

export async function startSshDeploy(request: SshDeployRequest, t: RuntimeT = fallbackT): Promise<ApiResult<{ readonly operationId: string }>> {
  return await postJson(ROUTE_DEPLOY, request, t)
}

export async function readSshDeployOperation(operationId: string, t: RuntimeT = fallbackT): Promise<ApiResult<SshDeployOperationView>> {
  return await getJson(`${ROUTE_OPERATION}?operationId=${encodeURIComponent(operationId)}`, t)
}

export async function waitSshDeployOperation(
  operationId: string,
  onProgress?: (view: SshDeployOperationView) => void,
  pollMs = 800,
  t: RuntimeT = fallbackT,
): Promise<ApiResult<SshDeployOperationView>> {
  for (;;) {
    const snapshot = await readSshDeployOperation(operationId, t)
    if (!snapshot.ok) return snapshot
    onProgress?.(snapshot.value)
    if (snapshot.value.status === 'succeeded' || snapshot.value.status === 'failed') return snapshot
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
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

/** Pull a remote host's project/session list through the host-side route. */
export async function fetchRemoteHostSessions(launchUrl: string, t: RuntimeT = fallbackT): Promise<ApiResult<{ readonly sessions: readonly HostSession[]; readonly note?: string }>> {
  return await postJson(ROUTE_REMOTE_SESSIONS, { launchUrl }, t)
}
