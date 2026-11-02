/**
 * Anthropic SSE events, translated into the chunk vocabulary DSH's loop assembles.
 *
 * Text and thinking become text and reasoning blocks. A `tool_use` block becomes
 * a tool-call whose arguments stay a raw JSON string. The thinking signature
 * (from `signature_delta`, or from the start block when a compatible gateway
 * puts it there instead) is stored on the finish envelope, one entry per
 * emitted block, which is the shape the loop writes back onto the assistant
 * message and the next request reads.
 */

export type GlmBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }

export type GlmUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export type GlmFinish =
  | { readonly kind: 'stop' }
  | { readonly kind: 'tool-calls' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'error'; readonly failure: { readonly message: string; readonly code: string } }

export type GlmReplayBlock =
  | { readonly signature: string }
  | { readonly redactedData: string }
  | Record<string, never>

export type GlmStreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: 'text' | 'reasoning' | 'tool-call' }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: GlmBlock }
  | { readonly type: 'usage'; readonly usage: GlmUsage }
  | {
    readonly type: 'finish'
    readonly reason: GlmFinish
    readonly replayState?: { readonly response: { readonly stopReason: string }; readonly blocks: readonly GlmReplayBlock[] }
  }

type OpenBlock = {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call' | 'redacted'
  text: string
  id: string
  name: string
  args: string
  signature: string
  sawSignatureDelta: boolean
  pendingSignature: string
  redactedData: string
  named: boolean
}

/** Turn one SSE byte stream into JSON event objects. Malformed frames are skipped. */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const read = await reader.read()
      if (read.done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(read.value, { stream: true })
      buffer = buffer.replace(/\r\n/gu, '\n')
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const event = parseFrame(frame)
        if (event !== undefined) yield event
        split = buffer.indexOf('\n\n')
      }
    }
    if (buffer.trim() !== '') {
      const event = parseFrame(buffer)
      if (event !== undefined) yield event
    }
  } finally {
    reader.releaseLock()
  }
}

function parseFrame(frame: string): unknown {
  const data = frame
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
  if (data === '' || data === '[DONE]') return undefined
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

/** Translate Anthropic stream events into DSH chunks. A stream error finishes the iterator. */
export async function* chunksFromEvents(events: AsyncIterable<unknown>): AsyncGenerator<GlmStreamChunk> {
  const open = new Map<number, OpenBlock>()
  // Filled by our block index, which is assigned in first-seen order. The loop
  // keeps replay entries in that same order and drops the envelope if the
  // lengths disagree, so a later stop must not append out of sequence.
  const replay: GlmReplayBlock[] = []
  let nextIndex = 0
  let stopReason = ''
  let sawTool = false
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, saw: false }

  const close = function* close(sourceIndex: number): Generator<GlmStreamChunk> {
    const block = open.get(sourceIndex)
    if (block === undefined) return
    open.delete(sourceIndex)
    if (block.kind === 'redacted') {
      yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: '' } }
      replay[block.index] = { redactedData: block.redactedData }
      return
    }
    if (block.kind === 'text') {
      yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      replay[block.index] = {}
      return
    }
    if (block.kind === 'reasoning') {
      const signature = block.sawSignatureDelta ? block.signature : block.pendingSignature || block.signature
      yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      replay[block.index] = { signature }
      return
    }
    const args = block.args.trim() === '' ? '{}' : block.args
    yield {
      type: 'block-end',
      index: block.index,
      block: { type: 'tool-call', id: block.id, name: block.name, arguments: args },
    }
    replay[block.index] = {}
  }

  for await (const event of events) {
    if (!isRecord(event)) continue
    const type = event['type']
    if (type === 'error') {
      const detail = isRecord(event['error']) ? event['error'] : event
      const message = typeof detail['message'] === 'string' ? detail['message'] : 'GLM stream failed'
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'glm' } } }
      return
    }
    if (type === 'message_start') {
      readUsage(isRecord(event['message']) ? event['message']['usage'] : undefined, usage)
      continue
    }
    if (type === 'message_delta') {
      const delta = event['delta']
      if (isRecord(delta) && typeof delta['stop_reason'] === 'string') stopReason = delta['stop_reason']
      readUsage(event['usage'], usage)
      continue
    }
    if (type === 'content_block_start') {
      const sourceIndex = typeof event['index'] === 'number' ? event['index'] : nextIndex
      const content = isRecord(event['content_block']) ? event['content_block'] : {}
      const kind = blockKind(content['type'])
      if (kind === undefined) continue
      const block: OpenBlock = {
        index: nextIndex,
        kind,
        text: '',
        id: typeof content['id'] === 'string' ? content['id'] : `call-${String(nextIndex)}`,
        name: typeof content['name'] === 'string' ? content['name'] : '',
        args: '',
        signature: '',
        sawSignatureDelta: false,
        pendingSignature: typeof content['signature'] === 'string' ? content['signature'] : '',
        redactedData: typeof content['data'] === 'string' ? content['data'] : '',
        named: false,
      }
      nextIndex += 1
      open.set(sourceIndex, block)
      replay[block.index] = {}
      if (kind === 'tool-call') sawTool = true
      yield { type: 'block-start', index: block.index, blockType: kind === 'redacted' ? 'reasoning' : kind }
      if (kind === 'text' && typeof content['text'] === 'string' && content['text'] !== '') {
        block.text = content['text']
        yield { type: 'text-delta', index: block.index, text: content['text'] }
      }
      if (kind === 'reasoning' && typeof content['thinking'] === 'string' && content['thinking'] !== '') {
        block.text = content['thinking']
        yield { type: 'reasoning-delta', index: block.index, text: content['thinking'] }
      }
      continue
    }
    if (type === 'content_block_delta') {
      const sourceIndex = typeof event['index'] === 'number' ? event['index'] : undefined
      if (sourceIndex === undefined) continue
      const block = open.get(sourceIndex)
      const delta = event['delta']
      if (block === undefined || !isRecord(delta)) continue
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text'] !== '') {
        block.text += delta['text']
        yield { type: 'text-delta', index: block.index, text: delta['text'] }
      }
      if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string' && delta['thinking'] !== '') {
        block.text += delta['thinking']
        yield { type: 'reasoning-delta', index: block.index, text: delta['thinking'] }
      }
      if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string' && delta['partial_json'] !== '') {
        block.args += delta['partial_json']
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.id,
          ...(block.named ? {} : { name: block.name }),
          argumentsDelta: delta['partial_json'],
        }
        block.named = true
      }
      if (delta['type'] === 'signature_delta' && typeof delta['signature'] === 'string') {
        block.signature += delta['signature']
        block.sawSignatureDelta = true
      }
      continue
    }
    if (type === 'content_block_stop') {
      const sourceIndex = typeof event['index'] === 'number' ? event['index'] : undefined
      if (sourceIndex === undefined) continue
      yield* close(sourceIndex)
    }
  }

  for (const sourceIndex of [...open.keys()]) yield* close(sourceIndex)
  if (usage.saw) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        ...(usage.cacheRead === 0 ? {} : { cacheReadTokens: usage.cacheRead }),
        ...(usage.cacheWrite === 0 ? {} : { cacheWriteTokens: usage.cacheWrite }),
        totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      },
    }
  }
  yield {
    type: 'finish',
    reason: finishOf(stopReason, sawTool),
    replayState: { response: { stopReason: stopReason === '' ? 'end_turn' : stopReason }, blocks: replay },
  }
}

function blockKind(type: unknown): OpenBlock['kind'] | undefined {
  if (type === 'text') return 'text'
  if (type === 'thinking') return 'reasoning'
  if (type === 'tool_use') return 'tool-call'
  if (type === 'redacted_thinking') return 'redacted'
  return undefined
}

function finishOf(stopReason: string, sawTool: boolean): GlmFinish {
  if (stopReason === 'max_tokens') return { kind: 'max-tokens' }
  if (stopReason === 'tool_use' || (stopReason === '' && sawTool)) return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

function readUsage(
  value: unknown,
  into: { input: number; output: number; cacheRead: number; cacheWrite: number; saw: boolean },
): void {
  if (!isRecord(value)) return
  into.saw = true
  if (typeof value['input_tokens'] === 'number') into.input = value['input_tokens']
  if (typeof value['output_tokens'] === 'number') into.output = value['output_tokens']
  if (typeof value['cache_read_input_tokens'] === 'number') into.cacheRead = value['cache_read_input_tokens']
  if (typeof value['cache_creation_input_tokens'] === 'number') into.cacheWrite = value['cache_creation_input_tokens']
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
