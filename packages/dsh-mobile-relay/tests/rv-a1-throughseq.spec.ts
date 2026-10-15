/**
 * 【评审反向验证用例——验证后删除】
 * 断言：转发 session/page 时必须带上手机查询串里的 throughSeq/maxMessages
 * （游标探测协议靠它；直连模式同款语义）。
 */
import { describe, expect, it } from 'vitest'
import { Relay } from '../src/relay.ts'
import type { MachineClient } from '../src/machine-client.ts'

describe('RV-A1：messages 转发必须透传查询串分页参数', () => {
  it('throughSeq=42&maxMessages=7 原样进上游 args', async () => {
    const calls: { endpoint: string; args: unknown }[] = []
    const fake = {
      call: async (endpoint: string, args: unknown) => {
        calls.push({ endpoint, args })
        return { ok: true as const, value: { records: [], hasMore: false } }
      },
      onEvent: () => () => {},
      connect: () => {},
      close: () => {},
      answer: async () => ({ ok: true }),
    } as unknown as MachineClient
    const relay = new Relay({
      knownHostIds: new Set(['host-a']),
      clients: { clientFor: async () => fake, invalidate: () => {}, closeAll: () => {} },
    })
    const url = '/threadharbor/relay/hosts/host-a/sessions/s1/messages?throughSeq=42&maxMessages=7'
    const res = { writeHead() {}, end() {} }
    await relay.handleMessages({ method: 'GET', url, headers: {} } as never, res as never, new URL(`http://x${url}`))
    const args = calls[0]?.args as { request?: { throughSeq?: number; maxMessages?: number } }
    expect(args.request?.throughSeq).toBe(42)
    expect(args.request?.maxMessages).toBe(7)
  })
})
