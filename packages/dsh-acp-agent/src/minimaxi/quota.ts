/**
 * MiniMax Token Plan quota and credit, read the way the MiniMax Code desktop
 * app's own usage view reads them (measured 2026-10-30 against the installed
 * `MiniMax Code.app`, cross-checked with a live read-only probe on a cn/prod
 * login).
 *
 * Unlike the GLM coding plan — one GET to a monitor address with the api key —
 * MiniMax splits the readout across two hosts:
 *
 * 1. The **group id** and the **credit balance** come from the managed gateway
 *    (`agent.minimax.cn`), but only through *signed* `/matrix/` calls. The
 *    signature is the desktop app's own: an md5 of the path+search, the body,
 *    and two hardcoded secrets (`I*7Cf%WZ#S&%1RlZJ&C2`, `ooui`). We copy it
 *    verbatim because there is no unsigned way to learn the account's group.
 * 2. The **five-hour / weekly windows** come from the open platform
 *    (`www.minimaxi.com`) on `/v1/api/openplatform/coding_plan/remains`, which
 *    needs only the login Bearer plus `X-Group-Id` — no signing.
 *
 * The five-hour window is the row's `current_interval_*`, the weekly one
 * `current_weekly_*`; `status === 3` means unlimited. The credit is the
 * membership answer's `op_credit_summary.total_remaining_amount`.
 *
 * The token lives in memory only and is stripped from every thrown message.
 */

import { createHash } from 'node:crypto'
import { matrixOrigin, openPlatformBaseUrl } from './vendor/mcode-runtime/endpoints.ts'
import type { CredentialOverrides, MiniMaxCredential } from './credential.ts'
import { resolveCredential } from './credential.ts'

/** The desktop app's signing secret and salt, copied verbatim (see header). */
const SIGNING_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2'
const SIGNING_SALT = 'ooui'

/** The coding-plan remains path on the open-platform origin. */
const REMAINS_PATH = '/v1/api/openplatform/coding_plan/remains'

/** One consumed window: the rolling five-hour cycle or the weekly one. */
export type MiniMaxQuotaWindow = {
  readonly kind: 'five-hour' | 'weekly'
  /** Consumed share in percent (the remaining percent for MiniMax windows). */
  readonly percent: number
  /** True when the window is unlimited (`status === 3`). */
  readonly unlimited: boolean
  /** Unix ms when the window resets (`*_end_time`), when the answer carries it. */
  readonly resetAt?: number
}

/** The Token Plan credit balance, in the account's own credit unit. */
export type MiniMaxCredit = {
  /** Remaining credits (`op_credit_summary.total_remaining_amount`). */
  readonly remaining: number
}

/** The quota one MiniMax account reports. */
export type MiniMaxCodingPlanQuota = {
  /** The plan tier (`token_plan_tier`, e.g. `Max`). */
  readonly level?: string
  /** Whether the login actually carries a Token Plan. */
  readonly subscribed: boolean
  readonly fiveHour?: MiniMaxQuotaWindow
  readonly weekly?: MiniMaxQuotaWindow
  readonly credit?: MiniMaxCredit
}

/** What one quota call takes; tests pass overrides so they never touch a real login. */
export type MiniMaxQuotaRequest = {
  readonly signal?: AbortSignal
  /** A ready credential; when absent it resolves from the local MiniMax Code login. */
  readonly credential?: MiniMaxCredential
  /** Everything `resolveCredential` takes; tests pass overrides so no real login is needed. */
  readonly credentialOverrides?: CredentialOverrides
  /** The model whose windows to read; defaults to the shared `general` quota. */
  readonly modelName?: string
  readonly fetchImpl?: typeof fetch
}

/**
 * Read the account's Token Plan quota and credit once.
 * @param request - the credential/model/fetch overrides.
 * @returns the parsed quota, or null when no recognised window is present.
 * Refusals and network faults throw with the token scrubbed; caller aborts
 * rethrow as-is.
 */
export async function fetchMiniMaxQuota(request: MiniMaxQuotaRequest = {}): Promise<MiniMaxCodingPlanQuota | null> {
  const credential = request.credential ?? await resolveCredential(request.credentialOverrides ?? {})
  const fetchImpl = request.fetchImpl ?? fetch
  const realUserID = await resolveRealUserID(credential, fetchImpl, request.signal)
  const membership = await readMembership(credential, realUserID, fetchImpl, request.signal)
  if (!membership.subscribed) {
    return { subscribed: false, ...(membership.level === undefined ? {} : { level: membership.level }) }
  }
  const base: MiniMaxCodingPlanQuota = {
    subscribed: true,
    ...(membership.level === undefined ? {} : { level: membership.level }),
    ...(membership.credit === undefined ? {} : { credit: membership.credit }),
  }
  // 订阅了却没有组 id：无从问 remains，照实回订阅态（没有窗口，浏览器那头不画）。
  if (membership.groupId === undefined) return base
  const remains = await readRemains(credential, membership.groupId, fetchImpl, request.signal)
  const quota = projectQuota(remains, request.modelName ?? 'general')
  return {
    ...base,
    ...(quota.fiveHour === undefined ? {} : { fiveHour: quota.fiveHour }),
    ...(quota.weekly === undefined ? {} : { weekly: quota.weekly }),
  }
}

/** The signed identity + membership facts needed before the windows can be read. */
type Membership = {
  subscribed: boolean
  groupId?: string
  level?: string
  credit?: MiniMaxCredit
}

/**
 * The login's real user id, via the signed `/v1/api/user/info`. The gateway
 * refuses requests that name a user it cannot reconcile, so every later `/matrix/`
 * call carries this id.
 */
async function resolveRealUserID(
  credential: MiniMaxCredential,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<string> {
  const body = await signedMatrixGet(credential, '/v1/api/user/info', {}, fetchImpl, signal)
  const data = dataOf(body)
  const user = record(data['userInfo']) ?? record(data['user_info'])
  const realUserID = field(user, 'realUserID', 'real_user_id')
  if (realUserID === undefined) throw new Error('MiniMax user-info answer carried no real user id')
  return realUserID
}

/**
 * The account's Token Plan facts: which workspace is personal, its group id,
 * whether it carries a plan, and the remaining credit. Two signed `/matrix/`
 * calls — the personal workspace's own membership is authoritative, the
 * commerce membership confirms it.
 */
async function readMembership(
  credential: MiniMaxCredential,
  realUserID: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Membership> {
  const extra = await signedMatrixPost(credential, '/matrix/api/v1/user/get_user_extra_info', {}, realUserID, fetchImpl, signal)
  const extraData = dataOf(extra)
  const workspaces = extraData['workspaces']
  const personal = Array.isArray(workspaces)
    ? workspaces.map(record).find((w): w is Record<string, unknown> => w !== undefined && w['workspace_type'] === 0)
    : undefined
  const workspaceId = finite(personal?.['workspace_id'])
  const groupId = text(personal?.['op_group_id'])
  const commerce = workspaceId === undefined
    ? {}
    : await signedMatrixPost(credential, '/matrix/api/v1/commerce/get_membership_info', { workspace_id: workspaceId }, realUserID, fetchImpl, signal)
  const commerceData = dataOf(commerce)
  const subscribed = [personal?.['has_token_plan'], commerceData['has_token_plan']]
    .some(fact => fact === true)
  const level = text(personal?.['token_plan_tier']) ?? text(commerceData['token_plan_tier'])
  const credit = creditOf(personal) ?? creditOf(commerceData)
  return {
    subscribed,
    ...(groupId === undefined ? {} : { groupId }),
    ...(level === undefined ? {} : { level }),
    ...(credit === undefined ? {} : { credit }),
  }
}

/** The Token Plan credit from a workspace/membership answer, when present. */
function creditOf(value: Record<string, unknown> | undefined): MiniMaxCredit | undefined {
  const summary = record(value?.['op_credit_summary'])
  const remaining = finite(summary?.['total_remaining_amount']) ?? finite(value?.['total_remains_credit'])
  return remaining === undefined ? undefined : { remaining }
}

/** The open-platform `remains` answer for one group (Bearer + X-Group-Id). */
async function readRemains(
  credential: MiniMaxCredential,
  groupId: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const url = new URL(REMAINS_PATH, openPlatformBaseUrl(credential.region, credential.buildEnv))
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential.accessToken}`,
        'x-group-id': groupId,
      },
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (isAbort(error) || signal?.aborted === true) throw error
    throw new Error(scrub(error instanceof Error ? error.message : String(error), credential.accessToken))
  }
  if (!response.ok) {
    const detail = scrub(await response.text().catch(() => ''), credential.accessToken).slice(0, 500)
    throw new Error(`MiniMax quota request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`)
  }
  try {
    return await response.json()
  } catch (error) {
    throw new Error(scrub(`MiniMax quota answer was not JSON: ${error instanceof Error ? error.message : String(error)}`, credential.accessToken))
  }
}

/**
 * The `remains` answer's `model_remains` into the two windows. The shared
 * `general` row is the text quota; an exact model row (non-video) wins when the
 * answer carries one, mirroring the desktop app's projection.
 */
function projectQuota(body: unknown, modelName: string): { fiveHour?: MiniMaxQuotaWindow; weekly?: MiniMaxQuotaWindow } {
  const data = dataOf(body)
  const items = Array.isArray(data['model_remains']) ? data['model_remains'] : []
  const models = items.map(record).filter((m): m is Record<string, unknown> => m !== undefined)
  const modelId = modelName.slice(modelName.indexOf('/') + 1).toLowerCase()
  const primary = models.find(m => text(m['model_name'])?.toLowerCase() === modelId && !/video/iu.test(modelId))
    ?? models.find(m => text(m['model_name'])?.toLowerCase() === 'general')
  if (primary === undefined) return {}
  const fiveHour = quotaWindow(primary, 'interval')
  const weekly = quotaWindow(primary, 'weekly')
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(weekly === undefined ? {} : { weekly }),
  }
}

/** One `current_<kind>_*` group into a window, or undefined when it states none. */
function quotaWindow(row: Record<string, unknown>, kind: string): MiniMaxQuotaWindow | undefined {
  const prefix = `current_${kind}`
  const status = finite(row[`${prefix}_status`])
  if (status === 3) return { kind: kind === 'interval' ? 'five-hour' : 'weekly', percent: 0, unlimited: true }
  const explicit = finite(row[`${prefix}_remaining_percent`])
  const total = finite(row[`${prefix}_total_count`])
  // The old remains protocol's usage_count is the *remaining* count, not spent.
  const remaining = finite(row[`${prefix}_usage_count`])
  let percent: number | undefined
  if (explicit !== undefined) percent = explicit
  else if (total !== undefined && total > 0 && remaining !== undefined) percent = (remaining / total) * 100
  if (percent === undefined) return undefined
  const resetAt = finite(row[`${kind === 'interval' ? 'end_time' : 'weekly_end_time'}`])
  return {
    kind: kind === 'interval' ? 'five-hour' : 'weekly',
    percent,
    unlimited: false,
    ...(resetAt === undefined ? {} : { resetAt }),
  }
}

/** A signed GET to the managed gateway (`/v1/api/user/info`). */
async function signedMatrixGet(
  credential: MiniMaxCredential,
  path: string,
  query: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return signedMatrix(credential, path, query, undefined, fetchImpl, signal)
}

/** A signed POST to the managed gateway with a JSON body. */
async function signedMatrixPost(
  credential: MiniMaxCredential,
  path: string,
  payload: Record<string, unknown>,
  realUserID: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return signedMatrix(credential, path, {}, payload, fetchImpl, signal, realUserID)
}

/**
 * One signed managed-gateway call. The signature is the desktop app's: an md5
 * over the encoded path+search, the body (or `{}`), a md5 of the timestamp, and
 * the salt — plus an `x-signature` md5 over the second, the secret, and the
 * body. The token never enters the signature; it rides the Bearer header.
 */
async function signedMatrix(
  credential: MiniMaxCredential,
  path: string,
  query: Record<string, string>,
  payload: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  realUserID?: string,
): Promise<unknown> {
  const now = Date.now()
  const url = new URL(path, matrixOrigin(credential.baseUrl))
  const language = credential.region === 'cn' ? 'zh' : 'en'
  url.search = new URLSearchParams({
    device_platform: 'web',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    unix: String(now),
    timezone_offset: String(new Date(now).getTimezoneOffset() * -1),
    sys_language: language,
    lang: language,
    device_id: '0',
    user_id: realUserID ?? '0',
    client: 'desktop',
    region: credential.region,
    is_desktop: '1',
    ...query,
  }).toString()
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const second = Math.floor(now / 1000)
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${credential.accessToken}`,
        yy: md5(`${encodeURIComponent(`${url.pathname}${url.search}`)}_${body || '{}'}${md5(String(now))}${SIGNING_SALT}`),
        'x-timestamp': String(second),
        'x-signature': md5(`${second}${SIGNING_SECRET}${body}`),
      },
      ...(body === '' ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (isAbort(error) || signal?.aborted === true) throw error
    throw new Error(scrub(error instanceof Error ? error.message : String(error), credential.accessToken))
  }
  if (!response.ok) {
    const detail = scrub(await response.text().catch(() => ''), credential.accessToken).slice(0, 500)
    throw new Error(`MiniMax quota request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`)
  }
  try {
    return await response.json()
  } catch (error) {
    throw new Error(scrub(`MiniMax quota answer was not JSON: ${error instanceof Error ? error.message : String(error)}`, credential.accessToken))
  }
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function scrub(text: string, secret: string): string {
  if (secret.length < 8) return text
  return text.split(secret).join('[redacted]')
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function field(value: unknown, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = record(value)?.[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** The answer's payload: the `data` envelope when present, else the body itself. */
function dataOf(body: unknown): Record<string, unknown> {
  const root = record(body) ?? {}
  return record(root['data']) ?? root
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
