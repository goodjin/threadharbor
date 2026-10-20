/**
 * The history a model plugin hands to the provider.
 *
 * A model plugin answers as the model, so the request it sends carries the
 * whole conversation. A history whose tool calls and results are not paired is
 * refused by the provider (MiniMax: "tool call result does not follow tool
 * call"), so the plugin re-pairs the history on the way out.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PresetConfig } from '../src/registry.ts'

interface Sent {
  messages?: readonly unknown[]
}

const sent: { minimax?: Sent, glm?: Sent } = {}

vi.mock('@threadharbor/minimaxi-acp', () => ({
  streamMiniMax: (request: Sent) => {
    sent.minimax = request
    return (async function* noChunks(): AsyncGenerator<never> { /* the provider is not the subject here */ })()
  },
}))

vi.mock('@threadharbor/zcode-acp', () => ({
  streamGlm: (request: Sent) => {
    sent.glm = request
    return (async function* noChunks(): AsyncGenerator<never> { /* the provider is not the subject here */ })()
  },
}))

const { modelPluginStream } = await import('../src/model-plugins.ts')

const config = {
  presets: {
    'acp-minimax': { agent: 'minimaxi', models: [{ id: 'MiniMax-M3.1-Flash', name: 'M3.1 Flash' }] },
    'acp-zcode': { agent: 'zcode', models: [{ id: 'GLM-5.3', name: 'GLM 5.3' }] },
  },
} as unknown as PresetConfig

const role = (message: unknown): string => (message as { role: string }).role
const callId = (message: unknown): string => (message as { toolCallId: string }).toolCallId

/** The call the assistant message carries, and the result the log kept far away. */
const drifted = [
  { role: 'user', content: [{ type: 'text', text: '开始' }] },
  {
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call-a', name: 'subagent', arguments: '{}' }],
    source: { kind: 'model', provider: 'acp:acp-minimax', model: 'MiniMax-M3.1-Flash' },
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '我先做别的' }],
    source: { kind: 'model', provider: 'acp:acp-minimax', model: 'MiniMax-M3.1-Flash' },
  },
  {
    role: 'tool',
    toolCallId: 'call-a',
    isError: true,
    source: { kind: 'tool', callId: 'call-a' },
    content: [{ type: 'text', text: '结果未知' }],
  },
]

describe('the history a model plugin sends', () => {
  it('moves the result back to the call it answers', () => {
    modelPluginStream(config)('acp-minimax', {
      provider: 'acp:acp-minimax',
      model: 'MiniMax-M3.1-Flash',
      messages: drifted,
    })
    const messages = sent.minimax?.messages ?? []
    expect(messages.map(role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(callId(messages[2])).toBe('call-a')
  })

  it('answers the GLM row the same way', () => {
    modelPluginStream(config)('acp-zcode', {
      provider: 'acp:acp-zcode',
      model: 'GLM-5.3',
      messages: drifted,
    })
    const messages = sent.glm?.messages ?? []
    expect(messages.map(role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(callId(messages[2])).toBe('call-a')
  })

  it('answers a call that never got a result', () => {
    modelPluginStream(config)('acp-minimax', {
      provider: 'acp:acp-minimax',
      model: 'MiniMax-M3.1-Flash',
      messages: [drifted[0], drifted[1]],
    })
    const messages = sent.minimax?.messages ?? []
    expect(messages.map(role)).toEqual(['user', 'assistant', 'tool'])
    expect(callId(messages[2])).toBe('call-a')
  })
})
