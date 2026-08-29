/** Backend-native frame to Web transcript projection. */

import type { JsonValue, RemoteAgentBackend } from '@threadharbor/protocol'

/** One display fragment derived from a native frame. */
export interface ProjectedFragment {
  readonly role: 'assistant' | 'system' | 'tool' | 'permission'
  readonly kind: 'message' | 'reasoning' | 'tool-call' | 'tool-result' | 'status' | 'permission'
  readonly text: string
  readonly requestId?: string
  readonly turnState?: 'idle' | 'running' | 'waiting-permission' | 'failed'
}

function object(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function textContent(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((entry) => {
    const block = object(entry)
    return typeof block?.['text'] === 'string' ? [block['text']] : []
  }).join('')
}

function frameMethod(frame: Record<string, JsonValue>): string {
  return typeof frame['method'] === 'string' ? frame['method'] : ''
}

function requestId(frame: Record<string, JsonValue>): string | undefined {
  const id = frame['id']
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
}

function projectAcp(frame: Record<string, JsonValue>): ProjectedFragment[] {
  const method = frameMethod(frame)
  const params = object(frame['params'])
  if (method === 'session/request_permission' || method === 'session/requestPermission') {
    const id = requestId(frame)
    return [{
      role: 'permission',
      kind: 'permission',
      text: typeof params?.['title'] === 'string' ? params['title'] : '等待权限确认',
      ...(id === undefined ? {} : { requestId: id }),
      turnState: 'waiting-permission',
    }]
  }
  if (method === '_x.ai/session/prompt_complete') {
    const failed = params?.['stopReason'] === 'error'
    return [{
      role: 'system', kind: 'status', text: failed ? '远程轮次失败' : '远程轮次完成',
      turnState: failed ? 'failed' : 'idle',
    }]
  }
  if (method !== 'session/update') return []
  const update = object(params?.['update'])
  const kind = update?.['sessionUpdate']
  const content = object(update?.['content'])
  const text = typeof content?.['text'] === 'string' ? content['text'] : ''
  if (kind === 'agent_message_chunk' && text !== '') {
    return [{ role: 'assistant', kind: 'message', text, turnState: 'running' }]
  }
  if (kind === 'agent_thought_chunk' && text !== '') {
    return [{ role: 'assistant', kind: 'reasoning', text, turnState: 'running' }]
  }
  if (kind === 'tool_call') {
    const title = typeof update?.['title'] === 'string' ? update['title'] : '远程工具调用'
    return [{ role: 'tool', kind: 'tool-call', text: title, turnState: 'running' }]
  }
  if (kind === 'tool_call_update') {
    const title = typeof update?.['title'] === 'string' ? update['title'] : '远程工具更新'
    return [{ role: 'tool', kind: 'tool-result', text: title, turnState: 'running' }]
  }
  if (kind === 'plan') {
    return [{ role: 'system', kind: 'status', text: '远程计划已更新', turnState: 'running' }]
  }
  return []
}

function projectDsh(frame: Record<string, JsonValue>): ProjectedFragment[] {
  const method = frameMethod(frame)
  const params = object(frame['params'])
  if (method === 'session.status') {
    const status = params?.['status']
    const running = status === 'running' || params?.['running'] === true
    return [{ role: 'system', kind: 'status', text: running ? '远程轮次运行中' : '远程轮次完成', turnState: running ? 'running' : 'idle' }]
  }
  if (method !== 'session.event') return []
  const event = object(params?.['event'])
  const type = event?.['type']
  const data = object(event?.['data'])
  if (type === 'assistant/chunk') {
    const chunk = object(data?.['chunk'])
    const chunkText = typeof chunk?.['text'] === 'string' ? chunk['text'] : ''
    const chunkType = chunk?.['type']
    if (chunkText === '') return []
    return [{
      role: 'assistant',
      kind: chunkType === 'reasoning' || chunkType === 'reasoning-delta' ? 'reasoning' : 'message',
      text: chunkText,
      turnState: 'running',
    }]
  }
  if (type === 'assistant/message') {
    const message = object(data?.['message'])
    const text = textContent(message?.['content'])
    return text === '' ? [] : [{ role: 'assistant', kind: 'message', text, turnState: 'running' }]
  }
  if (type === 'tool/call') {
    const name = typeof data?.['name'] === 'string' ? data['name'] : 'tool'
    return [{ role: 'tool', kind: 'tool-call', text: name, turnState: 'running' }]
  }
  if (type === 'tool/result') {
    const message = object(data?.['message'])
    return [{ role: 'tool', kind: 'tool-result', text: textContent(message?.['content']) || '工具执行完成', turnState: 'running' }]
  }
  if (type === 'turn/end') {
    const reason = object(data?.['reason'])
    const failed = reason?.['kind'] === 'error'
    return [{ role: 'system', kind: 'status', text: failed ? '远程轮次失败' : '远程轮次完成', turnState: failed ? 'failed' : 'idle' }]
  }
  return []
}

/**
 * Derive browser display fragments without translating or mutating the native frame.
 * @param backend - immutable session backend.
 * @param frame - backend-native JSON frame.
 * @returns zero or more display fragments.
 */
export function projectNativeFrame(backend: RemoteAgentBackend, frame: JsonValue): ProjectedFragment[] {
  const record = object(frame)
  if (record === undefined) return []
  return backend === 'dsh' ? projectDsh(record) : projectAcp(record)
}
