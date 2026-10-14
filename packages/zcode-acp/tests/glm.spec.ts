/**
 * The GLM coding-plan call, against a fake fetch.
 *
 * Nothing here talks to a real model. The assertions are the address, the
 * auth headers, the thinking signature round-trip, and the chunks the native
 * loop needs in order to run a tool.
 */

import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveKey, messagesUrl, streamGlm } from '../src/index.ts'
import { BIGMODEL_CODING_PLAN_BASE } from '../src/anthropic.ts'

const KEY = 'test-coding-plan-secret'

function sse(events: readonly unknown[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
}

function textTurn(text: string): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
}

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function fakeFetch(events: readonly unknown[], captured: Captured): typeof fetch {
  return (async (input, init) => {
    captured.url = String(input)
    const headers = init?.headers
    captured.headers = headers instanceof Headers
      ? Object.fromEntries(headers.entries())
      : { ...(headers as Record<string, string>) }
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}

async function read(iterable: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const chunks: Record<string, unknown>[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

describe('messagesUrl', () => {
  it('appends /v1/messages the way the anthropic adapter does', () => {
    expect(messagesUrl(BIGMODEL_CODING_PLAN_BASE)).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
    expect(messagesUrl('https://api.z.ai/api/anthropic/')).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(messagesUrl('https://open.bigmodel.cn/api/anthropic/v1')).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
  })
})

describe('streamGlm', () => {
  it('sends the coding-plan address, both auth headers, tools, and adaptive thinking', async () => {
    const captured: Captured = { url: '', headers: {}, body: {} }
    const chunks = await read(streamGlm({
      model: 'GLM-5.3',
      apiKey: KEY,
      endpoint: BIGMODEL_CODING_PLAN_BASE,
      fetchImpl: fakeFetch(textTurn('你好'), captured),
      reasoningEffort: 'medium',
      messages: [
        { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
        { role: 'user', content: [{ type: 'text', text: '读一下' }] },
      ],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    }))
    expect(captured.url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
    expect(captured.headers['x-api-key']).toBe(KEY)
    expect(captured.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(captured.headers['anthropic-version']).toBe('2023-06-01')
    expect(captured.body).toMatchObject({
      model: 'GLM-5.3',
      stream: true,
      system: '你是助手',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: '读一下' }] }],
    })
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({
      usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 2, totalTokens: 9 },
    })
  })

  it('turns a tool_use stream into tool-call chunks and replays the thinking signature', async () => {
    const captured: Captured = { url: '', headers: {}, body: {} }
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
    ]
    const first = await read(streamGlm({
      model: 'GLM-5.3',
      apiKey: KEY,
      endpoint: BIGMODEL_CODING_PLAN_BASE,
      fetchImpl: fakeFetch(events, captured),
      messages: [{ role: 'user', content: [{ type: 'text', text: '读' }] }],
    }))
    const tool = first.find(chunk => chunk.type === 'tool-call-delta')
    expect(tool).toMatchObject({ id: 'toolu_1', name: 'read', argumentsDelta: '{"path":' })
    expect(first.find(chunk => chunk.type === 'block-end' && 'block' in chunk && (chunk as { block: { type: string } }).block.type === 'tool-call'))
      .toMatchObject({ block: { type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{"path":"a.ts"}' } })
    expect(first.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: { blocks: [{ signature: 'sig-1' }, {}] },
    })

    const replay = (first.at(-1) as { replayState: unknown }).replayState
    const again: Captured = { url: '', headers: {}, body: {} }
    await read(streamGlm({
      model: 'GLM-5.3',
      apiKey: KEY,
      endpoint: BIGMODEL_CODING_PLAN_BASE,
      fetchImpl: fakeFetch(textTurn('好'), again),
      messages: [
        { role: 'user', content: [{ type: 'text', text: '读' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先看' },
            { type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{"path":"a.ts"}' },
          ],
          source: { kind: 'model', provider: 'acp:acp-zcode', model: 'GLM-5.3', replayState: replay },
        },
        { role: 'tool', toolCallId: 'toolu_1', content: [{ type: 'text', text: '文件内容' }] },
      ],
    }))
    expect(again.body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: '读' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先看', signature: 'sig-1' },
          { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '文件内容' }] },
    ])
  })

  it('disables thinking when the effort is none', async () => {
    const captured: Captured = { url: '', headers: {}, body: {} }
    await read(streamGlm({
      model: 'GLM-5.2',
      apiKey: KEY,
      endpoint: 'https://api.z.ai/api/anthropic',
      reasoningEffort: 'none',
      fetchImpl: fakeFetch(textTurn('ok'), captured),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    expect(captured.url).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(captured.body['thinking']).toEqual({ type: 'disabled' })
    expect(captured.body['output_config']).toBeUndefined()
  })

  it('keeps the api key out of a failed response', async () => {
    const fetchImpl = (async () => new Response(`bad ${KEY}`, { status: 401 })) as typeof fetch
    await expect(read(streamGlm({
      model: 'GLM-5.3',
      apiKey: KEY,
      endpoint: BIGMODEL_CODING_PLAN_BASE,
      fetchImpl,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))).rejects.toThrow(/401/)
    await expect(read(streamGlm({
      model: 'GLM-5.3',
      apiKey: KEY,
      endpoint: BIGMODEL_CODING_PLAN_BASE,
      fetchImpl,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))).rejects.toThrow(/^(?![\s\S]*test-coding-plan-secret)/)
  })

  it('reads the decrypted coding-plan key and does not echo it', async () => {
    const secret = 'local-login-key-0123456789'
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv)
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    const packed = `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
    const dir = await mkdtemp(join(tmpdir(), 'zcode-glm-'))
    const file = join(dir, 'credentials.json')
    await writeFile(file, JSON.stringify({
      'account-provider:other:api-key': 'plain',
      'account-provider:coding-plan:bigmodel:api-key': packed,
    }))
    const captured: Captured = { url: '', headers: {}, body: {} }
    await read(streamGlm({
      model: 'GLM-5.3',
      credentialsFile: file,
      endpoint: BIGMODEL_CODING_PLAN_BASE,
      fetchImpl: fakeFetch(textTurn('ok'), captured),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    expect(captured.headers['x-api-key']).toBe(secret)
    expect(JSON.stringify(captured.body)).not.toContain(secret)
  })

  it('stops when the caller aborts', async () => {
    const fetchImpl = (async (_input, init) => {
      expect(init?.signal?.aborted).toBe(true)
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    }) as typeof fetch
    await expect(read(streamGlm({
      model: 'GLM-5.3',
      apiKey: KEY,
      endpoint: BIGMODEL_CODING_PLAN_BASE,
      signal: AbortSignal.abort(),
      fetchImpl,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))).rejects.toMatchObject({ name: 'AbortError' })
  })
})
