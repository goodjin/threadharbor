/**
 * Dialect tests, over the `session/new` replies and the non-content frames
 * captured from live agents on 2026-10-09.
 *
 * The model list is the case that proves the dialect split was necessary: the
 * three agents put it in three different places, and claude's is the one that
 * is not where the design assumed — its `session/new` reply has no `models`
 * key at all.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { projectTurn } from '../src/projection.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import type { AcpFrame } from '../src/acp-client.ts'

const captured = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/captured-frames.json', import.meta.url)), 'utf8'),
) as Record<string, Record<string, unknown>>

const claudeNew = captured['claude']!['sessionNew']
const codexNew = captured['codex']!['sessionNew']

describe('reading the model list offered at session/new', () => {
  it("reads codex's models from models.availableModels", () => {
    const models = codexDialect.readModels(codexNew)
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]!.id).toBe('gpt-6-astra[low]')
  })

  it("reads claude's models from configOptions, because its reply has no models key", () => {
    expect('models' in (claudeNew as Record<string, unknown>)).toBe(false)
    const models = claudeDialect.readModels(claudeNew)
    expect(models.map(model => model.id)).toContain('opus')
  })

  it('gives an empty list rather than throwing when an agent offers no models', () => {
    expect(codexDialect.readModels({ sessionId: 'x' })).toEqual([])
    expect(claudeDialect.readModels({ sessionId: 'x' })).toEqual([])
  })
})

describe('separating conversation content from chatter', () => {
  it('ignores the command list and context-window updates codex emits mid-turn', () => {
    const noise = (captured['codex']!['noise'] ?? []) as AcpFrame[]
    const kinds = noise
      .map(frame => (frame.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate)
      .filter(Boolean)
    expect(kinds).toContain('available_commands_update')
    for (const kind of kinds) {
      expect(codexDialect.isContent({ sessionUpdate: kind })).toBe(false)
    }
  })

  it('drops the account-bearing auth status frame before any dialect sees it', () => {
    const noise = (captured['codex']!['noise'] ?? []) as AcpFrame[]
    const auth = noise.find(frame => frame.method === '_auth/status_update')
    expect(auth).toBeDefined()
    // The address sits one level deeper than it looks — under `account`.
    const status = (auth!.params as { authStatus?: { account?: { email?: string } } }).authStatus
    expect(status?.account?.email).toBe('goodjin2@gmail.com')

    // `_auth/status_update` is a top-level method rather than a session/update,
    // so the projection drops the whole frame. That method check — not the
    // dialect's chatter list — is what keeps the address out of the log.
    const events = projectTurn([auth!, ...noise], { turn: 1, dialect: codexDialect })
    expect(events.map(event => event.type)).toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])
    expect(JSON.stringify(events)).not.toContain('goodjin2@gmail.com')
  })

  it('does not mistake a context-window reading for a token count', () => {
    // codex/claude send `usage_update {used, size}`; `size` is the window, not
    // a billable count, and reading it as one would report 1,000,000 tokens.
    // The window reading is on an update frame, which `readReplyUsage` never
    // looks at — it reads only the prompt reply.
    expect(codexDialect.readReplyUsage({ update: { sessionUpdate: 'usage_update', used: 19978, size: 1000000 } })).toBeUndefined()
  })
})

describe('reading the turn usage off the session/prompt reply', () => {
  const codexReply = (captured['codex']!['promptReply'] as readonly unknown[])[0]
  const claudeReply = (captured['claude']!['promptReply'] as readonly unknown[])[0]

  it("reads codex's breakdown and renames its buckets into DSH's names", () => {
    // Real capture: `cachedReadTokens`/`thoughtTokens` are the agent's spellings;
    // DSH's usage buckets are `cacheReadTokens`/`reasoningTokens`.
    expect(codexDialect.readReplyUsage(codexReply)).toEqual({
      inputTokens: 1182,
      outputTokens: 100,
      cacheReadTokens: 16768,
      reasoningTokens: 0,
      totalTokens: 18050,
    })
  })

  it("reads claude's breakdown, whose cachedWrite bucket codex does not send", () => {
    expect(claudeDialect.readReplyUsage(claudeReply)).toEqual({
      inputTokens: 21411,
      outputTokens: 721,
      cacheReadTokens: 19344,
      cacheWriteTokens: 0,
      totalTokens: 41476,
    })
  })

  it('reports nothing for grok, whose only number is an unusable running total', () => {
    // grok keeps `totalTokens` on update frames' `_meta` — a session-to-date
    // total. Split into input and output it cannot be, and DSH's own token
    // projection would compute `NaN` from half a usage, so grok reports none.
    expect(grokDialect.readReplyUsage({ stopReason: 'end_turn' })).toBeUndefined()
  })

  it('reports nothing when the reply has no usage object', () => {
    expect(codexDialect.readReplyUsage({ stopReason: 'end_turn' })).toBeUndefined()
    expect(codexDialect.readReplyUsage(undefined)).toBeUndefined()
  })
})