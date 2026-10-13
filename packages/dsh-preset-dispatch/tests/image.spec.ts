/**
 * Routing image and file attachments by the capability table.
 *
 * An agent that cannot take an image must never be sent one — and the user must
 * see that it was held back, not watch the attachment vanish. The row that says
 * so is written through the same writer every other event rides, so its
 * reload-safety is decided in one place.
 */

import { claudeDialect, codexDialect } from '@threadharbor/dsh-acp-agent'
import { describe, expect, it } from 'vitest'
import { makeContentWriter, UNDELIVERED } from '../src/content-writer.ts'
import { promptContent, AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort } from '../src/runner.ts'

const IMAGE = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
const FILE = { type: 'file', data: 'JVBERi0xLjQ=', mimeType: 'application/pdf' }

/** Records every call so the tests can assert on the prompt payload. */
function fakeClient() {
  const calls: { method: string; params: unknown }[] = []
  const client: AcpClientPort & { calls: typeof calls } = {
    calls,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    },
    notify: () => {},
    onFrame: () => {},
  }
  return client
}

/** A turn context whose writer lands on a recording session, like the real wiring. */
function turnWithWriter() {
  const appends: { type: string; payload: unknown; intent?: { surfaceOp?: string; sourceEventSeqs?: readonly number[] } }[] = []
  let seq = 0
  const append = (type: string, payload: unknown, intent?: { surfaceOp?: string; sourceEventSeqs?: readonly number[] }) => {
    appends.push({ type, payload, ...(intent === undefined ? {} : { intent }) })
    seq += 1
    return { seq }
  }
  return {
    appends,
    turn: {
      sessionId: 's1',
      position: { turn: 1, step: 1 },
      produce: () => [],
      write: makeContentWriter(append),
    },
  }
}

const questionOf = (client: { calls: { method: string; params: unknown }[] }) => {
  const prompt = client.calls.find(call => call.method === 'session/prompt')
  if (prompt === undefined) throw new Error('no session/prompt was sent')
  return (prompt.params as { prompt: { type: string; text?: string }[] }).prompt
}

describe('AcpTurnRunner — attachments', () => {
  it('claude 拦下图片：prompt 不带图片块，并写一条未送达错误行', async () => {
    const client = fakeClient()
    const { appends, turn } = turnWithWriter()
    await new AcpTurnRunner(client, { cwd: '/tmp', dialect: claudeDialect }).run({
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么颜色' }, IMAGE] }],
    }, turn)

    const prompt = questionOf(client)
    expect(prompt.some(block => block.type === 'image')).toBe(false)
    expect(prompt[0]?.text).toBe('这是什么颜色')

    const call = appends.find(entry => entry.type === 'tool/call')
    expect(call).toBeDefined()
    const result = appends.find(entry => entry.type === 'tool/result') as {
      payload: { message: { isError?: boolean; content: { type: string; text: string }[] } }
    }
    expect(result).toBeDefined()
    expect(result.payload.message.isError).toBe(true)
    expect(result.payload.message.content.map(block => block.text).join('')).toContain('未送达')
  })

  it('codex 带上图片：图片块原样进入 prompt，不写未送达行', async () => {
    const client = fakeClient()
    const { appends, turn } = turnWithWriter()
    await new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect }).run({
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么颜色' }, IMAGE] }],
    }, turn)

    expect(questionOf(client)).toEqual([
      { type: 'text', text: '这是什么颜色' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ])
    expect(appends.filter(entry => entry.type === 'tool/call' || entry.type === 'tool/result')).toEqual([])
  })

  it('文件块暂不发：codex 也拦下并写未送达行', async () => {
    const client = fakeClient()
    const { appends, turn } = turnWithWriter()
    await new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect }).run({
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '看下这份材料' }, FILE] }],
    }, turn)

    const prompt = questionOf(client)
    expect(prompt.some(block => block.type === 'file')).toBe(false)
    expect(prompt[0]?.text).toBe('看下这份材料')
    const result = appends.find(entry => entry.type === 'tool/result') as {
      payload: { message: { isError?: boolean; content: { text: string }[] } }
    }
    expect(result).toBeDefined()
    expect(result.payload.message.isError).toBe(true)
    expect(result.payload.message.content.map(block => block.text).join('')).toContain('未送达')
  })

  it('没有 dialect 时不发图片，按不支持处理', async () => {
    // An unknown capability must read as "cannot": sending what we cannot
    // verify the agent takes is the one outcome this routing exists to prevent.
    const client = fakeClient()
    const { appends, turn } = turnWithWriter()
    await new AcpTurnRunner(client, { cwd: '/tmp' }).run({
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么颜色' }, IMAGE] }],
    }, turn)

    expect(questionOf(client).some(block => block.type === 'image')).toBe(false)
    expect(appends.some(entry => entry.type === 'tool/result')).toBe(true)
  })
})

describe('promptContent', () => {
  it('claude 的能力表把图片归入未送达', () => {
    const content = promptContent([{ role: 'user', content: [{ type: 'text', text: 'hi' }, IMAGE] }], claudeDialect)
    expect(content.text).toBe('hi')
    expect(content.images).toEqual([])
    expect(content.undelivered).toEqual([{ kind: 'image', mimeType: 'image/png' }])
  })

  it('codex 的能力表放行图片', () => {
    const content = promptContent([{ role: 'user', content: [{ type: 'text', text: 'hi' }, IMAGE] }], codexDialect)
    expect(content.images).toEqual([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }])
    expect(content.undelivered).toEqual([])
  })

  it('文件与 resource 块一律不发，按出现顺序记录', () => {
    const content = promptContent(
      [{ role: 'user', content: [IMAGE, { type: 'resource', uri: 'file:///a.txt' }, FILE] }],
      codexDialect,
    )
    expect(content.images).toEqual([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }])
    expect(content.undelivered).toEqual([
      { kind: 'file' },
      { kind: 'file', mimeType: 'application/pdf' },
    ])
  })

  it('只读 user 消息，其余角色的内容不计入', () => {
    const content = promptContent(
      [{ role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      codexDialect,
    )
    expect(content.text).toBe('hi')
    expect(content.images).toEqual([])
    expect(content.undelivered).toEqual([])
  })
})

describe('makeContentWriter — 未送达行', () => {
  it('把未送达标记展开成一对错误行，且不改写返回的序号', () => {
    // The marker is this plugin's internal event — it must never reach the log
    // as itself, and the seq the writer returns must stay the assistant
    // message's, so the live stream keeps pointing at the answer.
    const target = turnWithWriter()
    const marker = {
      type: UNDELIVERED,
      payload: { turn: 1, step: 1, attachments: [{ kind: 'image', mimeType: 'image/png' }] },
    }
    const message = { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }
    const returned = target.turn.write([marker, { type: 'assistant/message', payload: message }])

    expect(target.appends.map(entry => entry.type)).toEqual(['tool/call', 'tool/result', 'assistant/message'])
    expect(target.appends[0]!.intent).toBeUndefined()
    const result = target.appends[1]!
    expect(result.intent).toEqual({ surfaceOp: 'append', sourceEventSeqs: [1] })
    expect((result.payload as { message: { isError?: boolean } }).message.isError).toBe(true)
    expect(returned).toBe(3)
  })
})
