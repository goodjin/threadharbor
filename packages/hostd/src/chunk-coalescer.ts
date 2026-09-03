/** Merge token-sized ACP/DSH stream chunks before they become journal events. */

import type { JsonValue } from '@threadharbor/protocol'

const MAX_MERGED_CHARS = 240

interface PendingChunk {
  frame: Record<string, JsonValue>
  key: string
  text: string
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function cloneFrame(frame: JsonValue): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(frame)) as Record<string, JsonValue>
}

function classify(frame: JsonValue): { key: string; text: string; frame: Record<string, JsonValue> } | undefined {
  const record = asRecord(frame)
  if (record === undefined) return undefined
  const method = record['method']
  const params = asRecord(record['params'])
  if (method === 'session/update') {
    const update = asRecord(params?.['update'])
    const kind = update?.['sessionUpdate']
    const content = asRecord(update?.['content'])
    const text = typeof content?.['text'] === 'string' ? content['text'] : ''
    if (text === '' || (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk')) return undefined
    const sessionId = typeof params?.['sessionId'] === 'string' ? params['sessionId'] : ''
    const messageId = typeof update?.['messageId'] === 'string' ? update['messageId'] : ''
    return { key: `acp:${kind}:${sessionId}:${messageId}`, text, frame: cloneFrame(frame) }
  }
  if (method === 'session.event') {
    const event = asRecord(params?.['event'])
    if (event?.['type'] !== 'assistant/chunk') return undefined
    const data = asRecord(event['data'])
    const chunk = asRecord(data?.['chunk'])
    const text = typeof chunk?.['text'] === 'string' ? chunk['text'] : ''
    const chunkType = typeof chunk?.['type'] === 'string' ? chunk['type'] : 'text'
    if (text === '') return undefined
    const sessionId = typeof params?.['sessionId'] === 'string' ? params['sessionId'] : ''
    return { key: `dsh:${chunkType}:${sessionId}`, text, frame: cloneFrame(frame) }
  }
  return undefined
}

function writeText(pending: PendingChunk): void {
  const params = asRecord(pending.frame['params'])
  if (params === undefined) return
  if (pending.key.startsWith('acp:')) {
    const update = asRecord(params['update'])
    const content = asRecord(update?.['content'])
    if (content !== undefined) content['text'] = pending.text
    return
  }
  const event = asRecord(params['event'])
  const data = asRecord(event?.['data'])
  const chunk = asRecord(data?.['chunk'])
  if (chunk !== undefined) chunk['text'] = pending.text
}

/** Buffer consecutive token chunks into fewer journal frames. */
export class ChunkCoalescer {
  private pending: PendingChunk | undefined

  /** Accept one native frame. Returns zero or more frames that should be journaled now. */
  push(frame: JsonValue): JsonValue[] {
    const chunk = classify(frame)
    if (chunk === undefined) return [...this.flush(), frame]
    if (this.pending !== undefined && this.pending.key === chunk.key) {
      this.pending.text += chunk.text
      writeText(this.pending)
      return this.pending.text.length >= MAX_MERGED_CHARS ? this.flush() : []
    }
    const emitted = this.flush()
    this.pending = chunk
    return this.pending.text.length >= MAX_MERGED_CHARS ? [...emitted, ...this.flush()] : emitted
  }

  /** Emit any buffered chunk. */
  flush(): JsonValue[] {
    if (this.pending === undefined) return []
    const frame = this.pending.frame
    this.pending = undefined
    return [frame]
  }

  /** Whether a chunk is waiting to be journaled. */
  get buffered(): boolean {
    return this.pending !== undefined
  }
}
