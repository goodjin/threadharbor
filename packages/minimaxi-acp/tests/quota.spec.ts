/**
 * The MiniMax Token Plan quota + credit call, against a fake fetch.
 *
 * The address, signing, and the model_remains parsing are what the MiniMax
 * Code desktop app's own usage view runs on (measured 2026-10-30 against the
 * installed `MiniMax Code.app`, cross-checked with a live read-only probe on a
 * cn/prod login): a signed `/matrix/` lookup for the group id and credit, then
 * an unsigned open-platform `coding_plan/remains` GET for the two windows.
 * Nothing here talks to the real service.
 */

import { describe, expect, it } from 'vitest'
import { fetchMiniMaxQuota } from '../src/quota.ts'
import type { MiniMaxCredential } from '../src/credential.ts'

const TOKEN = 'test-minimax-token-secret'
const GROUP_ID = '1999459129545986565'

const CREDENTIAL: MiniMaxCredential = {
  accessToken: TOKEN,
  expiresAtMs: Date.now() + 3_600_000,
  region: 'cn',
  buildEnv: 'prod',
  baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
}

/** The measured `general` row of a real `remains` answer (cn/prod, Max plan). */
const GENERAL_ROW = {
  model_name: 'general',
  current_interval_status: 2,
  current_interval_remaining_percent: 0,
  current_interval_total_count: 0,
  current_interval_usage_count: 0,
  current_interval_end_time: 1793498400000,
  current_weekly_status: 3,
  current_weekly_remaining_percent: 100,
  current_weekly_total_count: 0,
  current_weekly_usage_count: 0,
  current_weekly_end_time: 1793548800000,
}

/** A `remains` answer whose weekly window is metered, to exercise the math. */
const METERED_WEEKLY = {
  model_name: 'general',
  current_interval_status: 2,
  current_interval_remaining_percent: 30,
  current_interval_total_count: 0,
  current_interval_usage_count: 0,
  current_weekly_status: 1,
  current_weekly_remaining_percent: 64,
  current_weekly_total_count: 21,
  current_weekly_usage_count: 7,
}

type SeenCall = { url: string; method: string; headers: Record<string, string>; body: string }

/**
 * A fake fetch that routes by pathname and records every call. The matrix
 * calls answer the signed identity/membership lookups; the open-platform call
 * answers `remains` with the row the test chooses.
 */
function fakeFetch(options: { remains?: unknown; extraInfo?: unknown; membership?: unknown; userInfo?: unknown } = {}) {
  const calls: SeenCall[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : { ...(init?.headers as Record<string, string>) }
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ url, method: String(init?.method), headers, body })
    const path = new URL(url).pathname
    if (path === '/v1/api/user/info') {
      return jsonResponse(options.userInfo ?? { data: { userInfo: { realUserID: '483260861993279496', userID: '1LXkvGLZaey8' } } })
    }
    if (path === '/matrix/api/v1/user/get_user_extra_info') {
      return jsonResponse(options.extraInfo ?? {
        workspaces: [{
          workspace_id: 0,
          workspace_type: 0,
          op_group_id: GROUP_ID,
          has_token_plan: true,
          token_plan_tier: 'Max',
          total_remains_credit: 0,
          opcredit_balance: 0,
        }],
        base_resp: { status_code: 0 },
      })
    }
    if (path === '/matrix/api/v1/commerce/get_membership_info') {
      return jsonResponse(options.membership ?? {
        has_token_plan: true,
        token_plan_tier: 'Max',
        op_group_id: GROUP_ID,
        op_credit_summary: { total_remaining_amount: '0', purchased_remaining_amount: '0', free_remaining_amount: '0' },
        base_resp: { status_code: 0 },
      })
    }
    if (path === '/v1/api/openplatform/coding_plan/remains') {
      return jsonResponse({ model_remains: options.remains ?? [GENERAL_ROW] })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { calls, fetch: impl }
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
}

function headersOf(calls: SeenCall[], path: string): Record<string, string> {
  const call = calls.find(c => new URL(c.url).pathname === path)
  if (call === undefined) throw new Error(`no call to ${path}`)
  return call.headers
}

describe('fetchMiniMaxQuota', () => {
  it('reads the two windows and the credit from the measured answer', async () => {
    const { fetch: fetchImpl } = fakeFetch()
    const quota = await fetchMiniMaxQuota({ credential: CREDENTIAL, fetchImpl })
    expect(quota).toMatchObject({
      subscribed: true,
      level: 'Max',
      credit: { remaining: 0 },
      fiveHour: { kind: 'five-hour', percent: 0, unlimited: false },
      weekly: { kind: 'weekly', unlimited: true },
    })
  })

  it('marks a metered weekly window with its remaining percent', async () => {
    const { fetch: fetchImpl } = fakeFetch({ remains: [METERED_WEEKLY] })
    const quota = await fetchMiniMaxQuota({ credential: CREDENTIAL, fetchImpl })
    expect(quota?.weekly).toMatchObject({ kind: 'weekly', percent: 64, unlimited: false })
    expect(quota?.fiveHour).toMatchObject({ percent: 30 })
  })

  it('signs the managed-gateway calls and leaves the open-platform read unsigned', async () => {
    const { calls, fetch: fetchImpl } = fakeFetch()
    await fetchMiniMaxQuota({ credential: CREDENTIAL, fetchImpl })
    for (const path of ['/v1/api/user/info', '/matrix/api/v1/user/get_user_extra_info', '/matrix/api/v1/commerce/get_membership_info']) {
      const headers = headersOf(calls, path)
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(headers.yy).toMatch(/^[0-9a-f]{32}$/)
      expect(headers['x-signature']).toMatch(/^[0-9a-f]{32}$/)
      expect(headers['x-timestamp']).toMatch(/^\d+$/)
    }
    const remains = calls.find(c => new URL(c.url).pathname === '/v1/api/openplatform/coding_plan/remains')
    expect(remains?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(remains?.headers['x-group-id']).toBe(GROUP_ID)
    expect(remains?.headers.yy).toBeUndefined()
    expect(remains?.headers['x-signature']).toBeUndefined()
  })

  it('sends the personal workspace id as a number and the group id as a string', async () => {
    const { calls, fetch: fetchImpl } = fakeFetch()
    await fetchMiniMaxQuota({ credential: CREDENTIAL, fetchImpl })
    const membership = calls.find(c => new URL(c.url).pathname === '/matrix/api/v1/commerce/get_membership_info')
    expect(membership?.body).toBe('{"workspace_id":0}')
    const remains = calls.find(c => new URL(c.url).pathname === '/v1/api/openplatform/coding_plan/remains')
    expect(new URL(remains!.url).origin).toBe('https://www.minimaxi.com')
  })

  it('reports an unsubscribed login without reading the windows', async () => {
    const { calls, fetch: fetchImpl } = fakeFetch({
      extraInfo: { workspaces: [{ workspace_id: 0, workspace_type: 0, has_token_plan: false }], base_resp: { status_code: 0 } },
      membership: { has_token_plan: false, base_resp: { status_code: 0 } },
    })
    const quota = await fetchMiniMaxQuota({ credential: CREDENTIAL, fetchImpl })
    expect(quota).toEqual({ subscribed: false })
    expect(calls.some(c => new URL(c.url).pathname === '/v1/api/openplatform/coding_plan/remains')).toBe(false)
  })

  it('prefers an exact model row over the shared general quota', async () => {
    const { fetch: fetchImpl } = fakeFetch({
      remains: [
        GENERAL_ROW,
        { model_name: 'MiniMax-M3', current_interval_status: 1, current_interval_remaining_percent: 88, current_weekly_status: 1, current_weekly_remaining_percent: 42 },
      ],
    })
    const quota = await fetchMiniMaxQuota({ credential: CREDENTIAL, modelName: 'MiniMax-M3', fetchImpl })
    expect(quota?.fiveHour).toMatchObject({ percent: 88 })
    expect(quota?.weekly).toMatchObject({ percent: 42 })
  })

  it('answers null when the remains answer carries no model rows', async () => {
    const { fetch: fetchImpl } = fakeFetch({ remains: [] })
    const quota = await fetchMiniMaxQuota({ credential: CREDENTIAL, fetchImpl })
    expect(quota).toMatchObject({ subscribed: true })
    expect(quota?.fiveHour).toBeUndefined()
    expect(quota?.weekly).toBeUndefined()
  })

  it('throws a scrubbed message on a refused answer', async () => {
    const fetchImpl = (async () => new Response(`denied ${TOKEN}`, { status: 401 })) as typeof fetch
    await expect(fetchMiniMaxQuota({ credential: CREDENTIAL, fetchImpl })).rejects.toThrow(/401/)
    await expect(fetchMiniMaxQuota({ credential: CREDENTIAL, fetchImpl })).rejects.toThrow(/^(?![\s\S]*test-minimax-token-secret)/)
  })

  it('throws a scrubbed message when the network itself fails', async () => {
    const fetchImpl = (async () => { throw new Error(`socket gone ${TOKEN}`) }) as typeof fetch
    await expect(fetchMiniMaxQuota({ credential: CREDENTIAL, fetchImpl })).rejects.toThrow(/socket gone \[redacted\]/)
  })
})
