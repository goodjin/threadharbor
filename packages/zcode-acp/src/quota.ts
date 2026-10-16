/**
 * The GLM Coding Plan quota: what the desktop app's usage view runs on.
 *
 * One GET against the plan's monitor address with the same decrypted key the
 * message call uses. Measured 2026-10-16 (and cross-checked against the
 * desktop app's own bundle): the answer carries a `limits` array whose
 * `TOKENS_LIMIT`/`CREDIT_LIMIT` rows state their window as `unit`/`number` —
 * unit 3 is hours (number 5 → the rolling five-hour window), unit 6 is weeks
 * (number 1 → the weekly window) — with `currentValue` used, `usage` total,
 * `percentage` the consumed share, and `nextResetTime` the unix-ms reset.
 * `TIME_LIMIT` rows (the monthly MCP budget) are not consumed here.
 *
 * The key lives in memory only and is stripped from every thrown message.
 */

import { BIGMODEL_CODING_PLAN_BASE } from './anthropic.ts'
import { resolveApiKey, resolveEndpoint, scrub } from './glm.ts'

/** The monitor path every coding-plan origin serves the quota on. */
const QUOTA_PATH = '/api/monitor/usage/quota/limit'

/** One consumed window: the five-hour cycle or the weekly one. */
export type GlmQuotaWindow = {
  readonly kind: 'five-hour' | 'weekly'
  /** Credits spent in the window (`currentValue`). */
  readonly used: number
  /** Credits the window grants (`usage`). */
  readonly total: number
  /** Consumed share in percent: the row's `percentage`, or used/total. */
  readonly percent: number
  /** Unix ms when the window resets (`nextResetTime`). */
  readonly resetAt?: number
}

/** The quota one coding plan reports: its level plus whichever windows it states. */
export type GlmCodingPlanQuota = {
  /** The plan tier (`level`, e.g. `max`). */
  readonly level?: string
  readonly fiveHour?: GlmQuotaWindow
  readonly weekly?: GlmQuotaWindow
}

/** What one quota call takes; the same override faces `streamGlm` accepts. */
export type GlmQuotaRequest = {
  readonly signal?: AbortSignal
  /** Overrides the decrypted key. Tests pass one so they never touch a real login. */
  readonly apiKey?: string
  /** Overrides `ZCODE_ACP_CREDENTIALS_FILE` and `~/.zcode/v2/credentials.json`. */
  readonly credentialsFile?: string
  /** Coding-plan base or messages URL; the quota address derives from its origin. */
  readonly endpoint?: string
  readonly fetchImpl?: typeof fetch
}

/**
 * The quota address of a coding-plan base: its origin plus the monitor path.
 * A full messages URL serves the same — only the origin survives.
 * @param base - a coding-plan base or messages URL.
 * @returns the `…/api/monitor/usage/quota/limit` address.
 */
export function quotaUrl(base: string): string {
  try {
    return `${new URL(base).origin}${QUOTA_PATH}`
  } catch {
    throw new Error(`cannot derive the GLM quota address from ${base === '' ? 'an empty base' : base}`)
  }
}

/**
 * Read the monitor answer's `data` object into the two windows.
 * @param data - the response's `data` member.
 * @returns the quota, or null when no recognised window is present.
 */
export function parseQuotaLimits(data: unknown): GlmCodingPlanQuota | null {
  if (!isRecord(data) || !Array.isArray(data['limits'])) return null
  const quota: { level?: string; fiveHour?: GlmQuotaWindow; weekly?: GlmQuotaWindow } = {}
  const level = data['level']
  if (typeof level === 'string' && level !== '') quota.level = level
  for (const raw of data['limits']) {
    if (!isRecord(raw)) continue
    const window = windowOf(raw)
    if (window === undefined) continue
    if (window.kind === 'five-hour' && quota.fiveHour === undefined) quota.fiveHour = window
    if (window.kind === 'weekly' && quota.weekly === undefined) quota.weekly = window
  }
  return quota.fiveHour === undefined && quota.weekly === undefined ? null : quota
}

/**
 * Fetch the coding plan's quota once.
 * @param request - the key/endpoint overrides and fetch implementation.
 * @returns the parsed quota, or null when the endpoint answers an
 * unrecognised shape. Refusals and network faults throw with the key
 * scrubbed; caller aborts rethrow as-is.
 */
export async function fetchCodingPlanQuota(request: GlmQuotaRequest): Promise<GlmCodingPlanQuota | null> {
  const apiKey = await resolveApiKey(request)
  const url = quotaUrl(resolveEndpoint(request.endpoint))
  const fetchImpl = request.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error) {
    if (isAbort(error) || request.signal?.aborted === true) throw error
    throw new Error(scrub(error instanceof Error ? error.message : String(error), apiKey))
  }
  if (!response.ok) {
    const detail = scrub(await response.text().catch(() => ''), apiKey).slice(0, 500)
    throw new Error(`GLM quota request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(scrub(
      `GLM quota answer was not JSON: ${error instanceof Error ? error.message : String(error)}`,
      apiKey,
    ))
  }
  return parseQuotaLimits(isRecord(body) ? body['data'] : undefined)
}

/** One limits row as a window, or undefined when it is neither of the two. */
function windowOf(row: Record<string, unknown>): GlmQuotaWindow | undefined {
  const type = row['type']
  if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT') return undefined
  const kind = windowKindOf(row['unit'], row['number'])
  if (kind === undefined) return undefined
  const total = finite(row['usage'])
  const used = finite(row['currentValue'])
  if (total === undefined || used === undefined) return undefined
  const stated = finite(row['percentage'])
  const percent = stated !== undefined ? stated : total > 0 ? (used / total) * 100 : undefined
  if (percent === undefined) return undefined
  const resetAt = finite(row['nextResetTime'])
  return { kind, used, total, percent, ...(resetAt === undefined ? {} : { resetAt }) }
}

/** `unit` 3 + `number` 5 is the five-hour window; `unit` 6 + `number` 1 the weekly. */
function windowKindOf(unit: unknown, count: unknown): 'five-hour' | 'weekly' | undefined {
  if (unit === 3 && count === 5) return 'five-hour'
  if (unit === 6 && count === 1) return 'weekly'
  return undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
