/**
 * Projection tests for the shared ACP layer.
 *
 * Every frame sequence below is a real capture, not a hand-written shape:
 * `tests/fixtures/captured-frames.json` was recorded from a live
 * `claude-agent-acp@0.76.0` and a live `codex-acp` (2026-10-09). The three
 * agents disagree about where a tool's name lives, where its output lives and
 * how it reports token counts, so the dialect — not the shared projection — is
 * what these tests pin down.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { projectStepContent, projectTurn, withoutNonFinite } from '../src/projection.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import type { AcpFrame } from '../src/acp-client.ts'

/** The real captures, read from disk so a test can never drift from them. */
const captured = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/captured-frames.json', import.meta.url)), 'utf8'),
) as Record<string, Record<string, unknown>>

const claudeTool = captured['claude']!['tool'] as AcpFrame[]
const codexTool = captured['codex']!['tool'] as AcpFrame[]

describe('projectTurn with the claude dialect', () => {
  it("takes the tool name from _meta.claudeCode.toolName, not the human title", () => {
    const events = projectTurn(claudeTool, { turn: 1, dialect: claudeDialect })
    const call = events.find(event => event.type === 'tool/call')!
    expect((call.payload as { name: string }).name).toBe('Bash')
  })
})

describe('projectTurn with the codex dialect', () => {
  it('reads tool output from rawOutput.formatted_output, which is the only place codex puts it', () => {
    const events = projectTurn(codexTool, { turn: 1, dialect: codexDialect })
    const result = events.find(event => event.type === 'tool/result')!
    const message = (result.payload as { message: { content: { text: string }[] } }).message
    expect(message.content.map(part => part.text).join('')).toContain('total 544')
  })
})

describe('projectStepContent', () => {
  // Synthetic frames are fine here: this pins the event shape the replaced step
  // writes, not a dialect's reading of an agent's frames.
  const frames: AcpFrame[] = [
    { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'let me think' } } } },
    { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the answer' } } } },
  ]

  it('writes one assistant message per step, reasoning blocks before the answer', () => {
    // The conversation view folds each step's message into one node by keeping
    // the LAST assistant/message, so a second message would erase the first on
    // screen. Both blocks ride one message, in canonical order.
    const events = projectStepContent(frames, { turn: 4, step: 2, dialect: codexDialect })
    const messages = events.filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    const payload = messages[0]!.payload as {
      turn: number
      step: number
      message: { content: { type: string; text: string }[]; source: { kind: string; provider: string; model: string } }
    }
    expect(payload.turn).toBe(4)
    expect(payload.step).toBe(2)
    expect(payload.message.content).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'the answer' },
    ])
  })

  it('carries a model source the host can replay: kind "model" plus provider and model', () => {
    // The host's fork re-validates every message event; a source without
    // `kind` appends fine and then fails the session at fork time
    // ("message has invalid source"). This is that contract, pinned.
    const events = projectStepContent(frames, { turn: 1, step: 1, dialect: grokDialect })
    const payload = (events.find(event => event.type === 'assistant/message')!.payload) as {
      message: { source: { kind: string; provider: string; model: string } }
    }
    expect(payload.message.source).toEqual({ kind: 'model', provider: 'acp-grok', model: 'grok' })
  })

  it('carries the step the caller announced, not a hardcoded one', () => {
    const events = projectStepContent(frames, { turn: 7, step: 3, dialect: codexDialect })
    const payload = (events.find(event => event.type === 'assistant/message')!.payload) as { step: number }
    expect(payload.step).toBe(3)
  })
})

/**
 * The session history used to fail its whole projection with
 * `uncachedInputTokens: expected number, received NaN`: a turn's usage was
 * written without `inputTokens`, and DSH's token projection computes that
 * bucket straight from the field. These tests pin the rule that repaired it —
 * a usage is written only when the agent reported the pair DSH requires.
 */
describe('writing the turn usage into the durable message', () => {
  const answer: AcpFrame[] = [
    { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } },
  ]
  const reply = (usage: unknown): AcpFrame => ({ jsonrpc: '2.0', id: 9, result: { stopReason: 'end_turn', usage } })

  function usageOf(dialect: typeof codexDialect, ...extra: readonly AcpFrame[]): unknown {
    const events = projectStepContent([...answer, ...extra], { turn: 1, step: 1, dialect })
    const payload = (events.find(event => event.type === 'assistant/message')!.payload) as { usage?: unknown }
    return payload.usage
  }

  it('writes the codex reply usage with every bucket the agent reported', () => {
    expect(usageOf(codexDialect, reply({ totalTokens: 18050, inputTokens: 1182, cachedReadTokens: 16768, outputTokens: 100, thoughtTokens: 0 })))
      .toEqual({ inputTokens: 1182, outputTokens: 100, cacheReadTokens: 16768, reasoningTokens: 0, totalTokens: 18050 })
  })

  it('writes no usage at all when the agent reports only a bare total', () => {
    // grok's `_meta.totalTokens` cannot be split into the pair DSH requires,
    // and a one-sided usage is what once turned the session's own token
    // projection into NaN. Nothing honest to write means nothing written.
    const grokFrames: AcpFrame[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' }, _meta: { totalTokens: 21576 } } } },
    ]
    const events = projectStepContent(grokFrames, { turn: 1, step: 1, dialect: grokDialect })
    const payload = (events.find(event => event.type === 'assistant/message')!.payload) as { usage?: unknown }
    expect(payload.usage).toBeUndefined()
  })

  it('writes no usage when the required pair is incomplete', () => {
    expect(usageOf(codexDialect, reply({ outputTokens: 5 }))).toBeUndefined()
  })

  it('drops an unbelievable optional bucket but keeps the honest pair', () => {
    // `1e999` parses as Infinity: JSON carries no Infinity, but a large enough
    // literal becomes one. One such bucket must not cost the whole turn.
    expect(usageOf(codexDialect, reply({ inputTokens: 1182, outputTokens: 100, totalTokens: 1e999 })))
      .toEqual({ inputTokens: 1182, outputTokens: 100 })
  })

  it('keeps the same payload untouched when every number is finite', () => {
    const payload = { turn: 1, step: 1, stream: [{ type: 'text-chunks', time0: 5, index: 0, dt: [3, 9], texts: ['a'] }] }
    expect(withoutNonFinite(payload)).toBe(payload)
  })
})

describe('withoutNonFinite, the projection exit gate', () => {
  it('drops a number that is not finite, at any depth', () => {
    expect(withoutNonFinite({ a: Number.NaN })).toEqual({})
    expect(withoutNonFinite({ a: Number.POSITIVE_INFINITY })).toEqual({})
    expect(withoutNonFinite({ a: Number.NEGATIVE_INFINITY })).toEqual({})
    expect(withoutNonFinite({ a: { b: [1, Number.NaN, 3] } })).toEqual({ a: { b: [1, 3] } })
  })

  it('keeps finite numbers and everything that is not a number', () => {
    expect(withoutNonFinite({ a: 0, b: -12, c: 'x', d: null, e: true, f: [Number.EPSILON] }))
      .toEqual({ a: 0, b: -12, c: 'x', d: null, e: true, f: [Number.EPSILON] })
  })
})