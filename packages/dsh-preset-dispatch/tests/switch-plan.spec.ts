/**
 * The whole plan for a requested switch, in one decision.
 *
 * Two independent things can stand in the way of switching: the session may be
 * locked (it has already produced turns), and the history may not fit in the
 * target. They combine, and the combination is where the careless cases live —
 * a plan that says "fork it" without noticing the history will not fit is a
 * plan that produces a new session that is silently missing the conversation.
 */

import { describe, expect, it } from 'vitest'
import { planSwitch } from '../src/switch-plan.ts'
import { providerRoute } from '../src/catalog.ts'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' },
    'acp-claude': { agent: 'claude', command: 'claude-agent-acp' },
  },
}

const modelsOf = (presetId: string) => presetId === 'acp-grok'
  ? [{ id: 'grok-4.7', name: 'Grok 4.7' }]
  : [{ id: 'claude-opus-4', name: 'Claude Opus 4' }]

const deps = { modelsOf, dialectOf: () => undefined }

const selection = { provider: providerRoute('acp-claude'), model: 'claude-opus-4' }

const session = (over: Partial<Parameters<typeof planSwitch>[3]> = {}) => ({
  currentPreset: 'acp-grok' as string | undefined,
  started: false,
  historyTokens: 1_000,
  targetContextWindow: 200_000 as number | undefined,
  reservedForOutput: 8_000,
  ...over,
})

describe('planSwitch', () => {
  it('does nothing when the selection is already in use', () => {
    expect(planSwitch(CONFIG, deps, { provider: providerRoute('acp-grok'), model: 'grok-4.7' }, session(), {}))
      .toEqual({ kind: 'noop' })
  })

  it('switches in place on a session that has not started', () => {
    expect(planSwitch(CONFIG, deps, selection, session(), {}))
      .toEqual({ kind: 'switch-here', preset: 'acp-claude' })
  })

  it('switches in place even when the history fits exactly', () => {
    expect(planSwitch(CONFIG, deps, selection, session({ historyTokens: 192_000 }), {}).kind).toBe('switch-here')
  })

  it('forks to a new session when the session is locked', () => {
    expect(planSwitch(CONFIG, deps, selection, session({ started: true }), {}))
      .toEqual({ kind: 'fork', preset: 'acp-claude', carriesAllHistory: true })
  })

  it('refuses when the history does not fit, whether or not the session is locked', () => {
    // Forking does not make the history smaller — the new session carries the
    // same conversation. So an oversized conversation is refused either way;
    // forking would only produce a second session with the same problem.
    expect(planSwitch(CONFIG, deps, selection, session({ historyTokens: 300_000 }), {}))
      .toMatchObject({ kind: 'refuse', shortBy: 108_000 })
  })

  it('refuses when the session is locked and the history does not fit either', () => {
    // Forking would produce a new session that is missing the conversation —
    // exactly the silent truncation this exists to prevent.
    const plan = planSwitch(CONFIG, deps, selection, session({ started: true, historyTokens: 300_000 }), {})
    expect(plan.kind).toBe('refuse')
  })

  it('explains both problems when refusing', () => {
    // Only reporting one of them leaves the user fixing the wrong thing.
    const plan = planSwitch(CONFIG, deps, selection, session({ started: true, historyTokens: 300_000 }), {})
    expect(plan.kind === 'refuse' && plan.locked).toBe(true)
    expect(plan.kind === 'refuse' && plan.shortBy).toBe(108_000)
  })

  it('trims only when trimming was asked for', () => {
    const locked = session({ started: true, historyTokens: 300_000 })
    expect(planSwitch(CONFIG, deps, selection, locked, {})).toMatchObject({ kind: 'refuse' })
    // With trimming allowed, a locked session still needs a fork, and that
    // fork plainly reports carrying only part of the conversation.
    expect(planSwitch(CONFIG, deps, selection, locked, { trim: true }))
      .toMatchObject({ kind: 'fork', preset: 'acp-claude', carriesAllHistory: false, droppedTokens: 108_000 })
  })

  it('never lets a fork claim it carries the whole conversation when it cannot', () => {
    const plan = planSwitch(CONFIG, deps, selection, session({ started: true, historyTokens: 300_000 }), { trim: true })
    expect(plan.kind === 'fork' && plan.carriesAllHistory).toBe(false)
  })

  it('switches back to the native agent', () => {
    expect(planSwitch(CONFIG, deps, { provider: 'deepseek', model: 'deepseek-chat' }, session(), {}))
      .toEqual({ kind: 'switch-here', preset: undefined })
  })

  it('hands a locked session back to the native agent in place', () => {
    // Unlike an ACP preset, going back to native does not go through
    // `agent-preset/select` — it withdraws the takeover — so DSH's lock on a
    // session that has already produced turns does not apply. And the history
    // was written as native events throughout, so the native agent picks it up
    // from the session log as-is.
    expect(planSwitch(CONFIG, deps, { provider: 'deepseek', model: 'deepseek-chat' }, session({ started: true }), {}))
      .toEqual({ kind: 'switch-here', preset: undefined })
  })

  it('does nothing for a model the target agent does not serve', () => {
    expect(planSwitch(CONFIG, deps, { provider: providerRoute('acp-grok'), model: 'claude-opus-4' }, session(), {}))
      .toEqual({ kind: 'noop' })
  })

  it('refuses when the history size is not a usable number', () => {
    expect(planSwitch(CONFIG, deps, selection, session({ historyTokens: -1 }), {}).kind).toBe('refuse')
  })
})