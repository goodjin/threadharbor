/**
 * Local OpenSSH assets on the machine serving DSH Web (~/.ssh/config, keys).
 */

import type { SshLocalAssets } from '@threadharbor/dsh-host-federation'
import type { RuntimeT } from './locales.ts'
import { fallbackT } from './locales.ts'

export const ROUTE_LOCAL_ASSETS = '/api/threadharbor.host-ssh.local.assets'
export const ROUTE_LOCAL_PICK_IDENTITY = '/api/threadharbor.host-ssh.local.pick-identity'

type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

async function getJson<T>(path: string, t: RuntimeT = fallbackT): Promise<ApiResult<T>> {
  const response = await fetch(path)
  const parsed: unknown = await response.json()
  if (!isRecord(parsed)) return { ok: false, error: t('panel.ssh.httpInvalid', { status: response.status }) }
  if (parsed['ok'] === true) return { ok: true, value: parsed['value'] as T }
  const error = typeof parsed['error'] === 'string' ? parsed['error'] : t('panel.ssh.httpFailed', { status: response.status })
  return { ok: false, error }
}

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

export async function loadSshLocalAssets(t: RuntimeT = fallbackT): Promise<ApiResult<SshLocalAssets>> {
  return await getJson(ROUTE_LOCAL_ASSETS, t)
}

export async function pickSshIdentityFile(t: RuntimeT = fallbackT): Promise<ApiResult<{ readonly cancelled: boolean; readonly path?: string }>> {
  return await postJson(ROUTE_LOCAL_PICK_IDENTITY, {}, t)
}
