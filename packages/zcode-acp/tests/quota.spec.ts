/**
 * The coding-plan quota call, against a fake fetch.
 *
 * The address, auth headers, and the limits-array parsing are what the desktop
 * app's own quota view runs on (measured against the live endpoint
 * 2026-10-16): `GET {origin}/api/monitor/usage/quota/limit`, where rows with
 * `unit` 3 (hours) / `number` 5 are the five-hour window and `unit` 6 (weeks)
 * / `number` 1 the weekly one. Nothing here talks to the real service.
 */

import { describe, expect, it } from 'vitest'
import { fetchCodingPlanQuota, parseQuotaLimits, quotaUrl } from '../src/quota.ts'
import { BIGMODEL_CODING_PLAN_BASE, ZAI_CODING_PLAN_BASE } from '../src/anthropic.ts'

const KEY = 'test-coding-plan-secret'

/** The measured body of one real answer, field for field. */
const MEASURED_DATA = {
  limits: [
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 98, remaining: 27901, percentage: 1, nextResetTime: 1792150126523 },
    { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140000, currentValue: 66064, remaining: 73935, percentage: 47, nextResetTime: 1792564552999 },
  ],
  level: 'max',
}

describe('quotaUrl', () => {
  it('derives the monitor address from either coding-plan base', () => {
    expect(quotaUrl(BIGMODEL_CODING_PLAN_BASE)).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit')
    expect(quotaUrl(ZAI_CODING_PLAN_BASE)).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
  })

  it('accepts a full messages URL or a trailing slash the same way', () => {
    expect(quotaUrl('https://open.bigmodel.cn/api/anthropic/v1/messages')).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit')
    expect(quotaUrl('https://api.z.ai/api/anthropic/')).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
  })

  it('refuses a base it cannot parse, saying what it got', () => {
    expect(() => quotaUrl('not a url')).toThrow(/not a url/)
  })
})

describe('parseQuotaLimits', () => {
  it('reads the measured answer into the two windows and the plan level', () => {
    expect(parseQuotaLimits(MEASURED_DATA)).toEqual({
      level: 'max',
      fiveHour: { kind: 'five-hour', used: 98, total: 28000, percent: 1, resetAt: 1792150126523 },
      weekly: { kind: 'weekly', used: 66064, total: 140000, percent: 47, resetAt: 1792564552999 },
    })
  })

  it('takes TOKENS_LIMIT rows as the same two windows', () => {
    const quota = parseQuotaLimits({
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 1000, currentValue: 405, percentage: 40.5 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 300, currentValue: 156 },
      ],
    })
    expect(quota?.fiveHour).toMatchObject({ used: 405, total: 1000, percent: 40.5 })
    expect(quota?.weekly).toMatchObject({ used: 156, total: 300 })
  })

  it('computes the percent from used and total when the row carries none', () => {
    const quota = parseQuotaLimits({
      limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 98 }],
    })
    expect(quota?.fiveHour?.percent).toBeCloseTo(0.35, 5)
  })

  it('ignores rows that are neither of the two windows', () => {
    const quota = parseQuotaLimits({
      limits: [
        { type: 'TIME_LIMIT', percentage: 12.3, nextResetTime: 1789000000000 },
        { type: 'CREDIT_LIMIT', unit: 2, number: 30, percentage: 9 },
        { type: 'SOMETHING_ELSE', unit: 3, number: 5, percentage: 8 },
      ],
    })
    expect(quota).toBeNull()
  })

  it('answers null when there is no limits array to read', () => {
    expect(parseQuotaLimits(null)).toBeNull()
    expect(parseQuotaLimits({})).toBeNull()
    expect(parseQuotaLimits({ limits: 'nope' })).toBeNull()
  })
})

describe('fetchCodingPlanQuota', () => {
  it('GETs the monitor address with both auth headers and parses the answer', async () => {
    const seen: { url: string; method: string; headers: Record<string, string> }[] = []
    const quota = await fetchCodingPlanQuota({
      apiKey: KEY,
      endpoint: BIGMODEL_CODING_PLAN_BASE,
      fetchImpl: (async (input, init) => {
        seen.push({
          url: String(input),
          method: String(init?.method),
          headers: init?.headers instanceof Headers
            ? Object.fromEntries(init.headers.entries())
            : { ...(init?.headers as Record<string, string>) },
        })
        return new Response(JSON.stringify({ code: 200, msg: '操作成功', success: true, data: MEASURED_DATA }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })
    expect(seen).toEqual([{
      url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      method: 'GET',
      headers: expect.objectContaining({
        'x-api-key': KEY,
        authorization: `Bearer ${KEY}`,
      }),
    }])
    expect(quota).toMatchObject({ level: 'max', fiveHour: { percent: 1 }, weekly: { percent: 47 } })
  })

  it('defaults to the BigModel monitor address when no endpoint is given', async () => {
    const quota = await fetchCodingPlanQuota({
      apiKey: KEY,
      fetchImpl: (async (input: RequestInfo | URL) => {
        expect(String(input)).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit')
        return jsonResponse(MEASURED_DATA)
      }) as typeof fetch,
    })
    expect(quota).not.toBeNull()
  })

  it('answers null when the endpoint answers a shape it does not recognise', async () => {
    const quota = await fetchCodingPlanQuota({
      apiKey: KEY,
      fetchImpl: (async () => jsonResponse({ limits: 'nope' })) as typeof fetch,
    })
    expect(quota).toBeNull()
  })

  it('throws the status and a scrubbed body on a refused answer', async () => {
    const fetchImpl = (async () => new Response(`bad ${KEY}`, { status: 401 })) as typeof fetch
    await expect(fetchCodingPlanQuota({ apiKey: KEY, fetchImpl })).rejects.toThrow(/401/)
    await expect(fetchCodingPlanQuota({ apiKey: KEY, fetchImpl })).rejects.toThrow(/^(?![\s\S]*test-coding-plan-secret)/)
  })

  it('throws a scrubbed message when the network itself fails', async () => {
    const fetchImpl = (async () => { throw new Error(`socket gone ${KEY}`) }) as typeof fetch
    await expect(fetchCodingPlanQuota({ apiKey: KEY, fetchImpl })).rejects.toThrow(/socket gone \[redacted\]/)
  })
})

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ code: 200, success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
