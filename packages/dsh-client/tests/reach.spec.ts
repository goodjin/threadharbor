/**
 * The reachability probe, against a stand-in fetch.
 *
 * The contract is narrow on purpose: reachable means "something answered over
 * HTTP", and every other ending must name what actually happened — a probe
 * that reports 连不上 for a browser-side block would send an operator chasing
 * the wrong machine.
 */

import { describe, expect, it } from 'vitest'
import { describeProbeTarget, probeReach } from '../src/reach.ts'

const ADDRESS = 'http://192.168.1.20:3081'

describe('describeProbeTarget', () => {
  it('地址不带端口时补出 80 且 hasPort 为假', () => {
    const target = describeProbeTarget('http://100.101.1.7')
    expect(target.text).toContain('100.101.1.7')
    expect(target.text).toContain('80')
    expect(target.hasPort).toBe(false)
  })

  it('地址带端口时 hasPort 为真且 text 含该端口', () => {
    const target = describeProbeTarget('http://100.101.1.7:3081')
    expect(target.text).toContain('3081')
    expect(target.hasPort).toBe(true)
  })
})

describe('probeReach', () => {
  it('reports reachable with the elapsed time when anything answers', async () => {
    const outcome = await probeReach(() => Promise.resolve(new Response()), ADDRESS, 1000)
    expect(outcome.kind).toBe('reachable')
    if (outcome.kind === 'reachable') expect(outcome.ms).toBeGreaterThanOrEqual(0)
  })

  it('names the network layer when the request fails outright', async () => {
    const outcome = await probeReach(() => Promise.reject(new TypeError('fetch failed')), ADDRESS, 1000)
    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind === 'unreachable') expect(outcome.reason).toContain('网络层失败')
  })

  it('calls it a timeout when the wait runs out first', async () => {
    const outcome = await probeReach(() => new Promise((resolve, reject) => {
      // Reject exactly the way an aborted fetch does, once the probe's own
      // abort has fired.
      setTimeout(() => { reject(new DOMException('The operation was aborted.', 'AbortError')) }, 50)
    }), ADDRESS, 20)
    expect(outcome.kind).toBe('timeout')
  })

  it('不可达的原因写出实际检测的目标与端口', async () => {
    const outcome = await probeReach(() => Promise.reject(new TypeError('fetch failed')), 'http://100.101.1.7', 1000)
    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind === 'unreachable') {
      expect(outcome.reason).toContain('http://100.101.1.7')
      expect(outcome.reason).toContain('80')
    }
  })

  it('地址带端口时原因里不出现「没写端口」', async () => {
    const outcome = await probeReach(() => Promise.reject(new TypeError('fetch failed')), ADDRESS, 1000)
    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind === 'unreachable') expect(outcome.reason).not.toContain('没写端口')
  })

  it('reports non-TYPEError failures with their name', async () => {
    const outcome = await probeReach(() => Promise.reject(new RangeError('bad input')), ADDRESS, 1000)
    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind === 'unreachable') expect(outcome.reason).toContain('RangeError')
  })
})
