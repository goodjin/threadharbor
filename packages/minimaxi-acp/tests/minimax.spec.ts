/**
 * One turn against the managed gateway, over a fake network.
 *
 * The token comes from a fake login, so nothing here touches the real MiniMax
 * account. What is pinned down is the address, the headers, and the rule that
 * the token must not survive into anything a user or a log can see.
 */

import { describe, expect, it } from 'vitest'
import { scrub, streamMiniMax } from '../src/minimax.ts'
import type { MiniMaxCredential } from '../src/credential.ts'

const TOKEN = 'mmoat_secret_access_token_value'

const credential: MiniMaxCredential = {
  accessToken: TOKEN,
  expiresAtMs: Date.now() + 3_600_000,
  region: 'cn',
  buildEnv: 'prod',
  baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
}

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function fakeFetch(response: { status?: number; body: string }, captured: Captured): typeof fetch {
  return (async (input, init) => {
    captured.url = String(input)
    const headers = init?.headers
    captured.headers = headers instanceof Headers
      ? Object.fromEntries(headers.entries())
      : { ...(headers as Record<string, string>) }
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: { 'content-type': response.status === undefined || response.status === 200 ? 'text/event-stream' : 'application/json' },
    })
  }) as typeof fetch
}

async function collect(iterable: AsyncIterable<unknown>): Promise<Record<string, unknown>[]> {
  const chunks: Record<string, unknown>[] = []
  for await (const chunk of iterable) chunks.push(chunk as Record<string, unknown>)
  return chunks
}

describe('streamMiniMax', () => {
  it('posts to the managed gateway with the login as a bearer token', async () => {
    const captured: Captured = { url: '', headers: {}, body: {} }
    const chunks = await collect(streamMiniMax({
      credential,
      model: 'MiniMax-M3.1-Flash',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch({
        body: 'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      }, captured),
    }))
    expect(captured.url).toBe('https://agent.minimax.cn/mavis/api/v1/llm/v1/messages')
    expect(captured.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(captured.headers['anthropic-version']).toBe('2023-06-01')
    expect(captured.body).toMatchObject({ model: 'MiniMax-M3.1-Flash', stream: true })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reports a rejected login as such, without echoing the token back', async () => {
    const captured: Captured = { url: '', headers: {}, body: {} }
    const error = await collect(streamMiniMax({
      credential,
      model: 'MiniMax-M3.1-Flash',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch({ status: 401, body: `{"error":"invalid access token"} ${TOKEN}` }, captured),
    })).then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toMatch(/401/)
    expect(error?.message).toMatch(/log in again/)
    expect(error?.message).not.toContain(TOKEN)
  })

  it('strips the token from whatever the gateway says about a failure', async () => {
    const captured: Captured = { url: '', headers: {}, body: {} }
    const failure = collect(streamMiniMax({
      credential,
      model: 'MiniMax-M3.1-Flash',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeFetch({ status: 429, body: `{"error":"rate limited for ${TOKEN}"}` }, captured),
    }))
    await expect(failure).rejects.toThrow(/rate limited for \[redacted\]/)
    await expect(failure).rejects.not.toThrow(TOKEN)
  })

  it('propagates a cancellation instead of reporting a failed turn', async () => {
    const controller = new AbortController()
    const stream = streamMiniMax({
      credential,
      model: 'MiniMax-M3.1-Flash',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      fetchImpl: (async () => {
        controller.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }) as typeof fetch,
    })
    await expect(collect(stream)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('scrub', () => {
  it('leaves a short secret alone rather than mangling every short string', () => {
    expect(scrub('hello', 'ab')).toBe('hello')
  })
})
