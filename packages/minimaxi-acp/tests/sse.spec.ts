/**
 * The stream, read the way MiniMax sends it.
 *
 * MiniMax's gateway is anthropic messages over SSE, so thinking arrives as
 * `thinking_delta` and its signature as a separate `signature_delta` — the
 * signature has to be carried out on the finish envelope, because that is what
 * the next request replays.
 */

import { describe, expect, it } from 'vitest'
import { chunksFromEvents, readSseEvents } from '../src/sse.ts'

function sse(events: readonly unknown[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
}

async function read(body: string): Promise<Record<string, unknown>[]> {
  const chunks: Record<string, unknown>[] = []
  const stream = new Response(sse(body === '' ? [] : [JSON.parse(body)]), {
    headers: { 'content-type': 'text/event-stream' },
  }).body as ReadableStream<Uint8Array>
  for await (const chunk of chunksFromEvents(readSseEvents(stream))) chunks.push(chunk as Record<string, unknown>)
  return chunks
}

async function readEvents(events: readonly unknown[]): Promise<Record<string, unknown>[]> {
  const chunks: Record<string, unknown>[] = []
  const stream = new Response(sse(events)).body as ReadableStream<Uint8Array>
  for await (const chunk of chunksFromEvents(readSseEvents(stream))) chunks.push(chunk as Record<string, unknown>)
  return chunks
}

describe('readSseEvents', () => {
  it('skips a malformed frame instead of ending the stream', async () => {
    const body = new Response('data: {not json\n\ndata: {"type":"message_stop"}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }).body as ReadableStream<Uint8Array>
    const seen: unknown[] = []
    for await (const event of readSseEvents(body)) seen.push(event)
    expect(seen).toEqual([{ type: 'message_stop' }])
  })
})

describe('chunksFromEvents', () => {
  it('turns thinking into a reasoning block and keeps the signature for the next turn', async () => {
    const chunks = await readEvents([
      { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '9.9' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
    ])
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'weighing it' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: '9.9' })
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { blocks: [{ signature: 'sig-1' }, {}] },
    })
  })

  it('assembles a tool call and ends the turn on tool-use', async () => {
    const chunks = await readEvents([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-9', name: 'read' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ])
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-9', name: 'read', arguments: '{"path":"a.txt"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('reports usage with the cached tokens MiniMax bills separately', async () => {
    const chunks = await readEvents([
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 900 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } },
    ])
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 3, outputTokens: 25, cacheReadTokens: 900, totalTokens: 928 },
    })
  })

  it('ends the stream on a server-side error rather than reporting a clean stop', async () => {
    const chunks = await readEvents([
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
    ])
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'slow down', code: 'minimaxi' } },
    })
  })

  it('says the turn ran out of output when that is the stop reason', async () => {
    const chunks = await readEvents([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }])
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'max-tokens' } })
  })
})

describe('empty stream', () => {
  it('still finishes, so the loop is never left hanging', async () => {
    const chunks = await read('')
    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { stopReason: 'end_turn' }, blocks: [] } },
    ])
  })
})
