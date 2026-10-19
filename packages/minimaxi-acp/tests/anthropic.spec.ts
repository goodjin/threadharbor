/**
 * The MiniMax request body.
 *
 * Three things distinguish it from a plain anthropic call: the depth ladder is
 * MiniMax's own, a model that must always think may not be told to stop, and the
 * thinking block carries a signature that has to come back unchanged.
 */

import { describe, expect, it } from 'vitest'
import { buildAnthropicBody, defaultMaxTokens, reasoningFields } from '../src/anthropic.ts'

const FLASH = 'MiniMax-M3.1-Flash'
const M3 = 'MiniMax-M3'

describe('reasoningFields', () => {
  it('turns on adaptive thinking and maps DSH effort onto MiniMax depth', () => {
    expect(reasoningFields(FLASH, 'medium')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    })
  })

  it('keeps the whole ladder, including the ones only one model publishes', () => {
    expect(reasoningFields(M3, 'xhigh')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    })
  })

  it('turns thinking off for a model that allows it', () => {
    expect(reasoningFields(M3, 'none')).toEqual({ thinking: { type: 'disabled' } })
  })

  it('refuses to turn thinking off for a model that always thinks', () => {
    // Sending `disabled` to M3.1-Flash is a hard 400, so the request to stop is
    // dropped and the model simply keeps thinking.
    expect(reasoningFields(FLASH, 'none')).toEqual({ thinking: { type: 'adaptive' } })
  })

  it('defaults to high when the caller names no effort', () => {
    expect(reasoningFields(M3, undefined)).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    })
  })
})

describe('buildAnthropicBody', () => {
  it('asks for the anthropic messages shape with the managed gateway model', () => {
    const body = buildAnthropicBody({ model: FLASH, messages: [{ role: 'user', content: 'hi' }] })
    expect(body).toMatchObject({
      model: FLASH,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
  })

  it('replays the previous thinking block with its signature, unchanged', () => {
    const body = buildAnthropicBody({
      model: FLASH,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'the user greeted me' },
            { type: 'text', text: 'hello' },
          ],
          source: { replayState: { blocks: [{ signature: 'sig-abc' }, {}] } },
        },
      ],
    })
    expect(body.messages[1]?.content).toEqual([
      { type: 'thinking', thinking: 'the user greeted me', signature: 'sig-abc' },
      { type: 'text', text: 'hello' },
    ])
  })

  it('never drops a thinking block that lost its signature, since the chain must stay whole', () => {
    const body = buildAnthropicBody({
      model: FLASH,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking without a signature' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    })
    expect(body.messages[1]?.content).toEqual([
      { type: 'thinking', thinking: 'thinking without a signature', signature: '' },
      { type: 'text', text: 'hello' },
    ])
  })

  it('returns tool calls as tool_use blocks a later turn can answer', () => {
    const body = buildAnthropicBody({
      model: FLASH,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }] },
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'hello file' }] },
      ],
    })
    expect(body.messages[1]?.content).toEqual([
      { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.txt' } },
    ])
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'hello file' }],
    })
  })

  it('passes DSH tools through as anthropic tools', () => {
    const body = buildAnthropicBody({
      model: FLASH,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read', description: 'read a file', parameters: { properties: { path: { type: 'string' } } } }],
    })
    expect(body.tools).toEqual([
      {
        name: 'read',
        description: 'read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ])
  })

  it('caps the output at what the model publishes, even when the caller asks for more', () => {
    expect(defaultMaxTokens(M3)).toBe(128000)
    const body = buildAnthropicBody({ model: M3, messages: [{ role: 'user', content: 'hi' }], maxTokens: 999_999 })
    expect(body.max_tokens).toBe(128000)
  })
})
