/**
 * Carrying out a switch plan.
 *
 * The plan says what should happen; this does it. The risky part is the fork:
 * a fork that is created and then fails to take the new preset leaves two
 * sessions behind, one of them an empty copy of the conversation the user was
 * working in. So a failure part-way has to say what it made and what it did
 * not, rather than reporting only the error.
 */

import { describe, expect, it } from 'vitest'
import { applySwitchPlan } from '../src/apply-plan.ts'
import type { SwitchPorts } from '../src/apply-plan.ts'
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
const toClaude = { provider: providerRoute('acp-claude'), model: 'claude-opus-4' }

function ports(over: Partial<SwitchPorts> = {}) {
  const calls: string[] = []
  const made: Partial<SwitchPorts> = {
    select: async (sessionId, preset) => { calls.push(`select:${sessionId}:${preset}`) },
    fork: async request => {
      calls.push(`fork:${request.sessionId}`)
      return { sessionId: `${request.sessionId}-copy` }
    },
    ...over,
  }
  return { ports: made as SwitchPorts, calls }
}

const fresh = (over: Partial<Parameters<typeof planSwitch>[3]> = {}) => ({
  currentPreset: 'acp-grok' as string | undefined,
  started: false,
  historyTokens: 1_000,
  targetContextWindow: 200_000 as number | undefined,
  reservedForOutput: 8_000,
  ...over,
})

describe('applySwitchPlan', () => {
  it('does nothing for a plan that says do nothing', async () => {
    const { ports: p, calls } = ports()
    const plan = planSwitch(CONFIG, deps, toClaude, fresh({ currentPreset: 'acp-claude' }), {})
    expect(await applySwitchPlan(plan, 's1', p)).toEqual({ kind: 'nothing' })
    expect(calls).toEqual([])
  })

  it('selects on the same session for a plan that switches here', async () => {
    const { ports: p, calls } = ports()
    const plan = planSwitch(CONFIG, deps, toClaude, fresh(), {})
    expect(await applySwitchPlan(plan, 's1', p)).toEqual({ kind: 'switched', sessionId: 's1' })
    expect(calls).toEqual(['select:s1:acp-claude'])
  })

  it('hands a session back to the native agent by clearing its preset', async () => {
    const { ports: p, calls } = ports()
    const plan = planSwitch(CONFIG, deps, { provider: 'deepseek', model: 'deepseek-chat' }, fresh({ started: true }), {})
    expect(await applySwitchPlan(plan, 's1', p)).toEqual({ kind: 'switched', sessionId: 's1' })
    expect(calls).toEqual(['select:s1:undefined'])
  })

  it('creates the new session on the target preset and carries the conversation', async () => {
    // A started session cannot take a preset in place, and a DSH fork replays
    // the lock, so the executor's fork port creates a blank session bound to
    // the target and hands it the conversation — no select on the source.
    const { ports: p, calls } = ports()
    const plan = planSwitch(CONFIG, deps, toClaude, fresh({ started: true }), {})
    expect(await applySwitchPlan(plan, 's1', p, { history: [{ role: 'user', text: '问' }], prompt: '问' }))
      .toEqual({ kind: 'switched', sessionId: 's1-copy' })
    expect(calls).toEqual(['fork:s1'])
  })

  it('refuses to create a session when the conversation could not be read', async () => {
    // A new session that silently continues without the history is exactly the
    // quiet truncation this chain exists to prevent.
    const { ports: p, calls } = ports()
    const plan = planSwitch(CONFIG, deps, toClaude, fresh({ started: true }), {})
    await expect(applySwitchPlan(plan, 's1', p)).rejects.toThrow(/could not be read/)
    await expect(applySwitchPlan(plan, 's1', p, { history: [], prompt: '问' })).rejects.toThrow(/could not be read/)
    expect(calls).toEqual([])
  })

  it('refuses to act on a plan that refuses', async () => {
    const { ports: p, calls } = ports()
    const plan = planSwitch(CONFIG, deps, toClaude, fresh({ started: true, historyTokens: 300_000 }), {})
    await expect(applySwitchPlan(plan, 's1', p, { history: [{ role: 'user', text: '问' }], prompt: '问' })).rejects.toThrow(/108000|108,000/)
    expect(calls).toEqual([])
  })

  it('surfaces a selection failure', async () => {
    const { ports: p } = ports({ select: async () => { throw new Error('target unreachable') } })
    const plan = planSwitch(CONFIG, deps, toClaude, fresh(), {})
    await expect(applySwitchPlan(plan, 's1', p)).rejects.toThrow(/target unreachable/)
  })

  it('propagates the fork port\'s failure, which names the session it made', async () => {
    // The mounted fork port wraps part-way failures with the created session's
    // id; the executor passes that through untouched.
    const { ports: p, calls } = ports({
      fork: async request => {
        calls.push(`fork:${request.sessionId}`)
        throw new Error('created-1: handover failed')
      },
    })
    const plan = planSwitch(CONFIG, deps, toClaude, fresh({ started: true }), {})
    await expect(applySwitchPlan(plan, 's1', p, { history: [{ role: 'user', text: '问' }], prompt: '问' }))
      .rejects.toThrow(/created-1.*handover failed/)
    expect(calls).toEqual(['fork:s1'])
  })
})