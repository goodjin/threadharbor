/**
 * The approximations this turn closes out, pinned so they stay honest.
 *
 * Each test here pins a place where a number or a list could be fabricated
 * and must not be: a usage the agent never reported, a model list nobody
 * served, a step count nobody announced. The rule they all share: the session
 * log carries what the agent actually said, and nothing in its place.
 */

import { describe, expect, it } from 'vitest'
import { projectTurn } from '../src/projection.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import { cursorDialect } from '../src/dialects/cursor.ts'
import type { AcpFrame } from '../src/acp-client.ts'

/**
 * One turn's frames: an answer chunk plus the `session/prompt` reply, which is
 * the only frame a usage can ride. `usage` is spelt the way codex and claude
 * send it; grok and cursor send no usage object at all.
 */
function turnFrames(usage: unknown): AcpFrame[] {
  return [
    { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the answer' } } } },
    { jsonrpc: '2.0', id: 9, result: { stopReason: 'end_turn', ...(usage === undefined ? {} : { usage }) } },
  ]
}

function usageOf(dialect: typeof codexDialect | typeof grokDialect | typeof cursorDialect | typeof claudeDialect, usage: unknown): unknown {
  const events = projectTurn(turnFrames(usage), { turn: 1, dialect })
  const message = events.find(event => event.type === 'assistant/message')
  return (message!.payload as { usage?: unknown }).usage
}

describe('context usage is written only when the agent reported it', () => {
  it('codex reports the pair, so the message carries a usage', () => {
    expect(usageOf(codexDialect, { inputTokens: 1182, outputTokens: 100, totalTokens: 18050 }))
      .toEqual({ inputTokens: 1182, outputTokens: 100, totalTokens: 18050 })
  })

  it('claude reports the pair, so the message carries a usage', () => {
    expect(usageOf(claudeDialect, { inputTokens: 50, outputTokens: 20 })).toEqual({ inputTokens: 50, outputTokens: 20 })
  })

  it('grok 回合不带 usage', () => {
    // grok keeps a running session total on update frames' `_meta`, which
    // cannot be split into the input/output pair a DSH usage requires —
    // so there is nothing honest to write, and nothing may be written.
    expect(grokDialect.readReplyUsage({ stopReason: 'end_turn' })).toBeUndefined()
    expect(usageOf(grokDialect, undefined)).toBeUndefined()
  })

  it('cursor 回合不带 usage', () => {
    expect(cursorDialect.readReplyUsage({ stopReason: 'end_turn' })).toBeUndefined()
    expect(usageOf(cursorDialect, undefined)).toBeUndefined()
  })

  it('a usage object on the wire that grok cannot read stays unwritten', () => {
    // Defensive symmetry: even if some grok version started sending a usage
    // shape, its dialect does not read one — the pin is that the projection
    // never invents the pair from a total or a fragment.
    expect(usageOf(grokDialect, { totalTokens: 4096 })).toBeUndefined()
  })
})
