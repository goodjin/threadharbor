/**
 * Browser client for ThreadHarbor SSH auto-deploy routes on the serving host.
 */

import type { HostSession, PeerCheckReport, PeerReport, PeerStatus, SshConnectResult, SshConnectionInput, SshDeployOperationView, SshDeployRequest, SshHostKeyCandidate } from '@threadharbor/dsh-host-federation'
import type { RuntimeT } from './locales.ts'
import { fallbackT } from './locales.ts'

export const ROUTE_INSPECT = '/api/threadharbor.host-ssh.inspect'
export const ROUTE_DEPLOY = '/api/threadharbor.host-ssh.deploy'
export const ROUTE_OPERATION = '/api/threadharbor.host-ssh.operation'
export const ROUTE_PEER = '/api/threadharbor.host-ssh.peer'
export const ROUTE_CONNECT = '/api/threadharbor.host-ssh.connect'
export const ROUTE_CHECK = '/api/threadharbor.host-ssh.check'
export const ROUTE_SERVE = '/api/threadharbor.host-ssh.serve'
export const ROUTE_SERVICE = '/api/threadharbor.host-ssh.service'
export const ROUTE_START = '/api/threadharbor.host-ssh.start'
export const ROUTE_KEYS = '/api/threadharbor.host-ssh.keys'
export const ROUTE_REMOTE_SESSIONS = '/api/threadharbor.host-remote.sessions'
export const ROUTE_REMOTE_OP = '/api/threadharbor.host-remote.op'

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

/**
 * Private-key paths on the serving host (`~/.ssh`) to offer as suggestions.
 * A missing route or unreadable directory is an empty list, not an error: the
 * path field still accepts whatever the operator types.
 */
export async function listSshIdentityFiles(t: RuntimeT = fallbackT): Promise<readonly string[]> {
  const result = await postJson<{ readonly keys?: readonly string[] }>(ROUTE_KEYS, {}, t)
  return result.ok && Array.isArray(result.value.keys) ? result.value.keys : []
}

export async function readRemotePeer(
  ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
  t: RuntimeT = fallbackT,
): Promise<ApiResult<PeerReport>> {
  return await postJson(ROUTE_PEER, { ssh }, t)
}

/** Start the peer's DSH Web on a chosen port (the serving host runs the ssh). */
export async function startRemotePeer(
  ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
  port: number,
  t: RuntimeT = fallbackT,
): Promise<ApiResult<{ readonly port: number }>> {
  return await postJson(ROUTE_START, { ssh, port }, t)
}

/** Reach an already-deployed host: read its record, ensure the route, get the URL to open. */
export async function connectRemoteHost(
  ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
  remoteWebPort?: number,
  t: RuntimeT = fallbackT,
): Promise<ApiResult<SshConnectResult>> {
  return await postJson(ROUTE_CONNECT, { ssh, ...(remoteWebPort === undefined ? {} : { remoteWebPort }) }, t)
}

/** Start an async peer readiness check (poll with {@link waitSshDeployOperation}). */
export async function startRemotePeerCheck(
  ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
  remoteWebPort?: number,
  t: RuntimeT = fallbackT,
): Promise<ApiResult<{ readonly operationId: string }>> {
  return await postJson(ROUTE_CHECK, { ssh, ...(remoteWebPort === undefined ? {} : { remoteWebPort }) }, t)
}

/** Step-by-step readiness check of a peer reached over `tailscale serve`. */
export async function checkRemotePeer(
  ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
  remoteWebPort?: number,
  onProgress?: (view: SshDeployOperationView) => void,
  t: RuntimeT = fallbackT,
): Promise<ApiResult<PeerCheckReport>> {
  const started = await startRemotePeerCheck(ssh, remoteWebPort, t)
  if (!started.ok) return started
  const done = await waitSshDeployOperation(started.value.operationId, onProgress, undefined, t)
  if (!done.ok) return done
  if (done.value.status !== 'succeeded' || done.value.checkReport === undefined) {
    return { ok: false, error: done.value.error ?? t('panel.check.failedGeneric') }
  }
  return { ok: true, value: done.value.checkReport }
}

/** Why `tailscale serve` could not be configured, with the commands to run by hand. */
export type ServeFailure = { readonly error: string; readonly manualCommands?: readonly string[] }

/** Configure `tailscale serve` on the peer (user, then `sudo -n`), then re-check. */
export async function configureRemoteServe(
  ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
  remoteWebPort?: number,
  t: RuntimeT = fallbackT,
): Promise<ApiResult<{ readonly report: PeerCheckReport; readonly failure?: ServeFailure }>> {
  return await postJson(ROUTE_SERVE, { ssh, ...(remoteWebPort === undefined ? {} : { remoteWebPort }) }, t)
}

/** `systemctl start|restart` the peer's DSH Web unit, refresh its token, then re-check. */
export async function controlRemoteService(
  ssh: SshConnectionInput & { readonly hostKeyFingerprint: string },
  action: 'start' | 'restart',
  remoteWebPort?: number,
  t: RuntimeT = fallbackT,
): Promise<ApiResult<{ readonly report: PeerCheckReport }>> {
  return await postJson(ROUTE_SERVICE, { ssh, action, ...(remoteWebPort === undefined ? {} : { remoteWebPort }) }, t)
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

/** Forward one allowlisted operation to the host that owns the session. */
export async function remoteSessionOp<T>(body: Record<string, unknown>, t: RuntimeT = fallbackT): Promise<ApiResult<T>> {
  return await postJson(ROUTE_REMOTE_OP, body, t)
}
