/**
 * The `session/prompt` reply's usage object, as codex and claude both spell it.
 *
 * Both agents put a breakdown under `usage` on the reply, with the cache
 * buckets spelled `cachedReadTokens`/`cachedWriteTokens` and codex adding
 * `thoughtTokens` for the reasoning subset of the output. DSH's own usage
 * buckets use different names (`cacheRead*`, `reasoningTokens`), so the object
 * is translated rather than passed through.
 *
 * Two rules come from the session log's writer and DSH's token accounting:
 *
 * - a bucket the agent did not report stays absent — a written `0` would claim
 *   a fact nobody reported, and an explicit `undefined` is not lossless JSON;
 * - the required `inputTokens`/`outputTokens` pair must both be present
 *   numbers, or there is no usage to report. A partial usage is exactly what
 *   once turned DSH's own token projection into `NaN` and took a whole
 *   session's history down with it.
 */

import type { TurnUsage } from './types.ts'

/** Read one agent's reply usage, or `undefined` when it reports none. */
export function replyUsageOf(result: unknown): TurnUsage | undefined {
  const usage = recordOf(recordOf(result)['usage'])
  const input = usage['inputTokens']
  const output = usage['outputTokens']
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...numberBucket(usage['cachedReadTokens'], 'cacheReadTokens'),
    ...numberBucket(usage['cachedWriteTokens'], 'cacheWriteTokens'),
    ...numberBucket(usage['thoughtTokens'], 'reasoningTokens'),
    ...numberBucket(usage['totalTokens'], 'totalTokens'),
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** One renamed bucket, present only when the agent reported a finite number. */
function numberBucket(value: unknown, as: string): { readonly [k: string]: number } {
  return typeof value === 'number' && Number.isFinite(value) ? { [as]: value } : {}
}
