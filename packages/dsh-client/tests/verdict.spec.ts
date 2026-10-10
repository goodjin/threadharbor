/**
 * What a probe verdict is, and how the evidence maps onto one.
 *
 * The judgement lives beside the wording (`describeVerdict`), because the four
 * verdicts ask for four different reactions and two of them look identical
 * from the outside: a slow answer and a hung agent both present as "nothing
 * yet". Merging them sends the operator the wrong way — slow asks for
 * patience, hung says the agent is not doing its work, and unreachable is not
 * about the agent's speed at all.
 */

import { describe, expect, it } from 'vitest'
import { PROBE_DEFAULTS, judgeProbe } from '../src/verdict.ts'
import type { ProbeEvidence } from '../src/verdict.ts'

describe('judgeProbe', () => {
  it('回复及时就是正常，带上耗时', () => {
    expect(judgeProbe({ kind: 'replied', ms: 800 }, { slowAfterMs: 15_000 })).toEqual({ kind: 'ok', ms: 800 })
  })

  it('回复了但超过阈值算偏慢——慢和卡是两回事，处置也不同', () => {
    expect(judgeProbe({ kind: 'replied', ms: 20_000 }, { slowAfterMs: 15_000 })).toEqual({ kind: 'slow', ms: 20_000 })
  })

  it('阈值刚好踩线算正常：超过才算慢', () => {
    // The wording of the contract is "longer than this is slow", so a reply at
    // exactly the threshold is still 正常.
    expect(judgeProbe({ kind: 'replied', ms: 15_000 }, { slowAfterMs: 15_000 })).toEqual({ kind: 'ok', ms: 15_000 })
  })

  it('到点没回复也没报错就是卡住', () => {
    expect(judgeProbe({ kind: 'silent', ms: 60_000 }, { slowAfterMs: 15_000 })).toEqual({ kind: 'hung', ms: 60_000 })
  })

  it('根本没问出去就是连不上，带原因', () => {
    expect(judgeProbe({ kind: 'failed', reason: 'connect ECONNREFUSED' }, { slowAfterMs: 15_000 }))
      .toEqual({ kind: 'unreachable', reason: 'connect ECONNREFUSED' })
  })

  it('证据种类一样、耗时一样，结论才可能一样——四类结论互不重叠', () => {
    const evidence: ProbeEvidence[] = [
      { kind: 'replied', ms: 100 },
      { kind: 'silent', ms: 100 },
      { kind: 'failed', reason: 'x' },
    ]
    const kinds = evidence.map(item => judgeProbe(item, { slowAfterMs: 15_000 }).kind)
    expect(new Set(kinds).size).toBe(3)
  })

  it('默认值：15 秒算慢，60 秒算卡，探针只说一个词', () => {
    expect(PROBE_DEFAULTS.slowAfterMs).toBe(15_000)
    expect(PROBE_DEFAULTS.timeoutMs).toBe(60_000)
    expect(PROBE_DEFAULTS.prompt).toBe('ping')
  })
})
