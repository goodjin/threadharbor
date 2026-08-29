import { describe, expect, it } from 'vitest'
import { projectNativeFrame } from '../src/projection.ts'

describe('projectNativeFrame', () => {
  it('projects ACP content, permissions, and prompt completion without rewriting native frames', () => {
    const permission = {
      jsonrpc: '2.0', id: 7, method: 'session/request_permission',
      params: { title: 'Allow shell?', options: [{ optionId: 'once', name: 'Allow once' }] },
    }
    expect(projectNativeFrame('codex', permission)).toEqual([{
      role: 'permission', kind: 'permission', text: 'Allow shell?', requestId: '7', turnState: 'waiting-permission',
    }])
    expect(projectNativeFrame('codex', {
      jsonrpc: '2.0', method: 'session/update', params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      },
    })).toEqual([{ role: 'assistant', kind: 'message', text: 'done', turnState: 'running' }])
    expect(projectNativeFrame('codex', {
      jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' },
    })).toEqual([{ role: 'system', kind: 'status', text: '远程轮次完成', turnState: 'idle' }])
  })

  it('keeps dsh session events out of SessionEventMap while deriving display fragments', () => {
    expect(projectNativeFrame('dsh', {
      jsonrpc: '2.0', method: 'session.event', params: {
        sessionId: 'native', event: {
          type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hello' } },
        },
      },
    })).toEqual([{ role: 'assistant', kind: 'message', text: 'hello', turnState: 'running' }])
  })
})
