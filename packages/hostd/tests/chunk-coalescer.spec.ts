import { describe, expect, it } from 'vitest'
import { ChunkCoalescer, CHUNK_COALESCE_IDLE_MS } from '../src/chunk-coalescer.ts'

function messageChunk(text: string, messageId = 'm1'): object {
  return {
    jsonrpc: '2.0', method: 'session/update',
    params: {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
    },
  }
}

function thoughtChunk(text: string): object {
  return {
    jsonrpc: '2.0', method: 'session/update',
    params: {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
    },
  }
}

function toolCall(): object {
  return {
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', title: 'Read', toolCallId: 't1' } },
  }
}

describe('ChunkCoalescer', () => {
  it('exposes a 40ms idle flush window for hold workers', () => {
    expect(CHUNK_COALESCE_IDLE_MS).toBe(40)
  })

  it('merges consecutive ACP message tokens and flushes before a tool call', () => {
    const coalescer = new ChunkCoalescer()
    expect(coalescer.push(messageChunk('虚'))).toEqual([])
    expect(coalescer.push(messageChunk('惊'))).toEqual([])
    expect(coalescer.push(messageChunk('一场'))).toEqual([])
    const flushed = coalescer.push(toolCall())
    expect(flushed).toHaveLength(2)
    const merged = flushed[0] as { params: { update: { content: { text: string } } } }
    expect(merged.params.update.content.text).toBe('虚惊一场')
    expect(flushed[1]).toMatchObject({ params: { update: { sessionUpdate: 'tool_call' } } })
  })

  it('does not merge thought chunks into message chunks', () => {
    const coalescer = new ChunkCoalescer()
    coalescer.push(thoughtChunk('think '))
    const flushed = coalescer.push(messageChunk('hello'))
    expect(flushed).toHaveLength(1)
    expect((flushed[0] as { params: { update: { sessionUpdate: string; content: { text: string } } } }).params.update)
      .toMatchObject({ sessionUpdate: 'agent_thought_chunk', content: { text: 'think ' } })
    expect(coalescer.flush()[0]).toMatchObject({
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } } },
    })
  })
})
