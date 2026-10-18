import { afterEach, describe, expect, it } from 'vitest'
import { performRemoteOp, turnsFromRecords } from '../src/host-remote-ops.ts'

describe('turnsFromRecords', () => {
  it('只留下人能读的几类事件', () => {
    const turns = turnsFromRecords([
      { event: { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } } },
      { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在' }] } } } },
      { event: { type: 'tool/call', data: { title: '读文件' } } },
      { event: { type: 'agent/noise', data: {} } },
    ])
    expect(turns).toEqual([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '在' },
      { role: 'note', text: '读文件' },
    ])
  })
})

describe('performRemoteOp', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('读记录：先探测游标，再取那一页', async () => {
    const seen: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push(url)
      if (url.includes('/?token=') && !url.includes('/api/')) {
        return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth=abc; Path=/', location: './' } })
      }
      const body = JSON.parse(String(init?.body)) as { method?: string; payload?: { args?: { request?: { throughSeq?: number } } } }
      const through = body.payload?.args?.request?.throughSeq
      if (through === Number.MAX_SAFE_INTEGER) {
        return Response.json({ result: { ok: false, error: { message: 'past cursor 2' } } })
      }
      return Response.json({
        result: {
          ok: true,
          value: {
            records: [{ event: { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } } }],
            hasMore: false,
          },
        },
      })
    }) as typeof fetch

    const value = await performRemoteOp({
      op: 'transcript',
      launchUrl: 'http://127.0.0.1:4000/?token=tk',
      sessionId: 's1',
    })
    expect(value).toMatchObject({ turns: [{ role: 'user', text: '你好' }], hasMore: false })
    expect(seen.some(url => url.includes('/api/session/page'))).toBe(true)
  })

  it('不认识的操作直接拒绝', async () => {
    await expect(performRemoteOp({ op: 'shell', launchUrl: 'http://127.0.0.1/?token=tk' })).rejects.toThrow('不认识的远端操作')
  })
})
