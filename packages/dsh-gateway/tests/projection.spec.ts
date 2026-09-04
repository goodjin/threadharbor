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
    expect(projectNativeFrame('claude', {
      jsonrpc: '2.0', method: '_dsh/transport_closed', params: { code: null, signal: 'SIGTERM' },
    })).toEqual([{
      role: 'system', kind: 'status', text: '远程 Agent 已停止（signal SIGTERM）', turnState: 'failed',
    }])
    expect(projectNativeFrame('claude', {
      jsonrpc: '2.0', id: 3, method: 'elicitation/create',
      params: { mode: 'form', message: '选哪种方案？', requestedSchema: { type: 'object', properties: {} } },
    })).toEqual([{
      role: 'permission', kind: 'permission', text: '选哪种方案？', requestId: '3', turnState: 'waiting-permission',
    }])
    expect(projectNativeFrame('grok', {
      jsonrpc: '2.0', method: 'session/update', params: {
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: '阅读鉴权', priority: 'high', status: 'in_progress' },
            { content: '补测试', priority: 'medium', status: 'pending' },
          ],
        },
      },
    })).toEqual([{ role: 'system', kind: 'status', text: '阅读鉴权；补测试', turnState: 'running' }])
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

  it('treats synthesized _x.ai/session/prompt_complete as a DSH turn end so the UI is not stuck waiting', () => {
    // DSH backends occasionally skip `session.status=idle` / `turn/end` after the
    // JSON-RPC response. Hold worker synthesizes `_x.ai/session/prompt_complete`
    // for DSH too; the projector must recognize it so the conversation flips
    // back to idle and the queued next prompt can drain.
    expect(projectNativeFrame('dsh', {
      jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' },
    })).toEqual([{ role: 'system', kind: 'status', text: '远程轮次完成', turnState: 'idle' }])
    expect(projectNativeFrame('dsh', {
      jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { stopReason: 'error' },
    })).toEqual([{ role: 'system', kind: 'status', text: '远程轮次失败', turnState: 'failed' }])
  })
})
