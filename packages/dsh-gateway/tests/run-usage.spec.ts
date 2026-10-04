import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@threadharbor/protocol'
import {
  frameUsageReading, isRoundTerminalFrame, mergeUsage,
} from '../src/run-usage.ts'

function resp(frame: Record<string, unknown>): JsonValue {
  return frame as JsonValue
}

describe('run-usage frame reading', () => {
  it('reads the Claude/Codex prompt-response usage block', () => {
    const reading = frameUsageReading('claude', resp({
      jsonrpc: '2.0', id: 'p1',
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 23949, outputTokens: 34, cachedReadTokens: 7176122, cachedWriteTokens: 0, totalTokens: 7199821 },
      },
    }))
    expect(reading).toEqual({
      accumulate: 'replace',
      usage: {
        inputTokens: 23949, outputTokens: 34, cachedReadTokens: 7176122, cachedWriteTokens: 0, totalTokens: 7199821,
      },
    })
  })

  it('reads the Grok usage from result._meta.usage and maps cache writes', () => {
    const reading = frameUsageReading('grok', resp({
      jsonrpc: '2.0', id: 'g1',
      result: {
        stopReason: 'end_turn',
        _meta: {
          usage: {
            inputTokens: 120, outputTokens: 40, cachedReadTokens: 8_000,
            cacheCreationTokens: 200, reasoningTokens: 5, totalTokens: 8_365,
          },
        },
      },
    }))
    expect(reading?.usage).toEqual({
      inputTokens: 120, outputTokens: 40, cachedReadTokens: 8_000,
      cachedWriteTokens: 200, reasoningTokens: 5, totalTokens: 8_365,
    })
    expect(reading?.accumulate).toBe('replace')
  })

  it('sums DSH stream usage payloads while the round is open', () => {
    const reading = frameUsageReading('dsh', resp({
      jsonrpc: '2.0', method: 'session.event',
      params: {
        sessionId: 's1',
        event: {
          type: 'assistant/chunk',
          data: { chunk: { type: 'usage', usage: { inputTokens: 90, outputTokens: 639, cacheReadTokens: 294272, reasoningTokens: 169 } } },
        },
      },
    }))
    expect(reading).toEqual({
      accumulate: 'sum',
      usage: { inputTokens: 90, outputTokens: 639, cachedReadTokens: 294272, reasoningTokens: 169 },
    })
  })

  it('ignores frames without a usage payload', () => {
    expect(frameUsageReading('claude', resp({ jsonrpc: '2.0', method: 'session/update', params: { update: {} } })))
      .toBeUndefined()
    expect(frameUsageReading('dsh', resp({ jsonrpc: '2.0', method: 'session.status', params: { status: 'running' } })))
      .toBeUndefined()
    expect(frameUsageReading('codex', resp({ jsonrpc: '2.0', id: 'x', result: { accepted: true } })))
      .toBeUndefined()
  })

  it('replaces on ACP turn responses and sums DSH stream readings', () => {
    const replace = frameUsageReading('claude', resp({ id: 'p', result: { usage: { inputTokens: 5, outputTokens: 6 } } }))
    const sum = frameUsageReading('dsh', resp({
      jsonrpc: '2.0', method: 'session.event', params: { event: { type: 'assistant/chunk', data: { chunk: { usage: { inputTokens: 7, outputTokens: 8 } } } } },
    }))
    const afterReplace = mergeUsage({ inputTokens: 100, outputTokens: 100 }, replace)
    expect(afterReplace).toEqual({ inputTokens: 5, outputTokens: 6 })
    const afterSum = mergeUsage({ inputTokens: 100, outputTokens: 100 }, sum)
    expect(afterSum).toEqual({ inputTokens: 107, outputTokens: 108 })
  })
})

describe('round terminal detection', () => {
  it('recognizes the completion frames of every backend', () => {
    expect(isRoundTerminalFrame('claude', resp({ jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: {} }))).toBe(true)
    // The Agent process exiting is a lifecycle frame, not a turn ending: it
    // must not steal the round's usage totals off the completion frame.
    expect(isRoundTerminalFrame('codex', resp({ jsonrpc: '2.0', method: '_dsh/transport_closed', params: {} }))).toBe(false)
    expect(isRoundTerminalFrame('grok', resp({ jsonrpc: '2.0', method: 'session.status', params: { status: 'idle' } }))).toBe(true)
    expect(isRoundTerminalFrame('dsh', resp({
      jsonrpc: '2.0', method: 'session.event',
      params: { sessionId: 's', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
    }))).toBe(true)
    expect(isRoundTerminalFrame('dsh', resp({ jsonrpc: '2.0', method: 'session.status', params: { status: 'running' } }))).toBe(false)
    expect(isRoundTerminalFrame('claude', resp({ jsonrpc: '2.0', method: 'session/update', params: { update: {} } }))).toBe(false)
  })
})
