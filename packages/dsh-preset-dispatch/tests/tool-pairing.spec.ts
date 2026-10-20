/**
 * 把一次请求要带的历史重新配对。
 *
 * 会话日志里，工具调用和它的结果不一定挨着：后台子代理的调用一直没等到结果，
 * 等这一轮被打断时，补救逻辑把「结果未知」补在日志末尾，而不是补在它应答的
 * 那次调用旁边。重放时这份历史原样发出去，严格的服务商会拒（MiniMax 报
 * 「tool call result does not follow tool call」）。
 *
 * 这里把历史重新配对：每个工具调用紧跟它自己的结果，调用没有结果就补一条
 * 「结果未知」，找不到调用的结果不进请求。
 */

import { describe, expect, it } from 'vitest'
import { buildAnthropicBody } from '@threadharbor/minimaxi-acp'
import { pairToolResults } from '../src/tool-pairing.ts'

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })

const assistantText = (text: string) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'acp:acp-minimax', model: 'MiniMax-M3.1-Flash' },
})

const assistantCall = (id: string, name = 'subagent') => ({
  role: 'assistant',
  content: [{ type: 'tool-call', id, name, arguments: '{}' }],
  source: { kind: 'model', provider: 'acp:acp-minimax', model: 'MiniMax-M3.1-Flash' },
})

const toolResult = (id: string, text = 'ok') => ({
  role: 'tool',
  toolCallId: id,
  isError: false,
  source: { kind: 'tool', callId: id },
  content: [{ type: 'text', text }],
})

const role = (message: unknown): string => (message as { role: string }).role
const callId = (message: unknown): string => (message as { toolCallId: string }).toolCallId
const text = (message: unknown): string => ((message as { content: { text: string }[] }).content)
  .map(block => block.text)
  .join('\n')

/**
 * The pairing faults of one anthropic body: a tool_use the next user message
 * does not answer, or a tool_result that answers no tool_use before it.
 */
function pairingFaults(messages: readonly { role: string, content: readonly { type: string, id?: string, tool_use_id?: string }[] }[]): string[] {
  const faults: string[] = []
  let calls: string[] = []
  messages.forEach((message, index) => {
    const uses = message.content.filter(block => block.type === 'tool_use').map(block => block.id ?? '')
    const results = message.content.filter(block => block.type === 'tool_result').map(block => block.tool_use_id ?? '')
    if (message.role === 'assistant') {
      calls = uses
      return
    }
    for (const id of results) {
      if (!calls.includes(id)) faults.push(`message ${index}: tool_result ${id} does not follow its tool_use`)
    }
    for (const id of calls) {
      if (!results.includes(id)) faults.push(`message ${index}: tool_use ${id} is not answered`)
    }
    calls = []
  })
  return faults
}

describe('pairToolResults', () => {
  it('leaves a history alone when every result already follows its call', () => {
    const messages = [user('开始'), assistantCall('c1'), toolResult('c1')]
    expect(pairToolResults(messages)).toEqual(messages)
  })

  it('moves a result back to the call it answers', () => {
    // The shape the reported session ended up with: the call is early, the
    // result the interrupted-turn recovery wrote is at the tail of the log.
    const messages = [assistantCall('c1'), user('继续'), toolResult('c1', '结果未知')]
    const repaired = pairToolResults(messages)
    expect(repaired.map(role)).toEqual(['assistant', 'tool', 'user'])
    expect(callId(repaired[1])).toBe('c1')
    expect(text(repaired[1])).toBe('结果未知')
  })

  it('answers a call that never got a result with an unknown-outcome error', () => {
    const repaired = pairToolResults([assistantCall('c1')])
    expect(repaired.map(role)).toEqual(['assistant', 'tool'])
    expect(callId(repaired[1])).toBe('c1')
    expect((repaired[1] as { isError: boolean }).isError).toBe(true)
    expect(text(repaired[1])).toContain('outcome is unknown')
  })

  it('keeps a result that answers no call out of the request', () => {
    expect(pairToolResults([toolResult('ghost')])).toEqual([])
  })

  it('answers every call of one assistant message in the same user message', () => {
    const repaired = pairToolResults([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
          { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'acp:acp-minimax', model: 'MiniMax-M3.1-Flash' },
      },
      toolResult('c2'),
      toolResult('c1'),
    ])
    expect(repaired.map(role)).toEqual(['assistant', 'tool', 'tool'])
    expect(repaired.slice(1).map(callId)).toEqual(['c1', 'c2'])
  })

  it('sends an anthropic body whose tool calls are all answered', () => {
    const history = [
      user('开始'),
      assistantCall('call-a'),
      assistantText('我先做别的'),
      user('继续'),
      assistantCall('call-b'),
      toolResult('call-b', 'b 的结果'),
      toolResult('call-a', 'a 的结果未知'),
    ]
    const body = buildAnthropicBody({
      model: 'MiniMax-M3.1-Flash',
      messages: pairToolResults(history),
    })
    expect(pairingFaults(body.messages)).toEqual([])
  })
})
