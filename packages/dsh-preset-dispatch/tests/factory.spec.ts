/**
 * How configuration becomes a reachable agent.
 *
 * Scope note, deliberately narrow: this covers the decisions the factory makes
 * — which dialect an agent speaks, and what happens when a preset does not
 * exist. Actually connecting is the transport's own business and already has
 * its own tests; duplicating it here would only test `WebSocket` and `spawn`.
 */

import { describe, expect, it } from 'vitest'
import { claudeDialect, codexDialect, grokDialect } from '@threadharbor/dsh-acp-agent'
import { makeSessionFactory } from '../src/factory.ts'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419', model: 'grok-4.7' },
    'acp-claude': { agent: 'claude', command: 'claude-agent-acp', mode: 'default' },
    'acp-codex': { agent: 'codex', command: 'codex-acp' },
  },
}

const deps = { answerPermission: async () => ({ outcome: 'reject' as const }) }

describe('makeSessionFactory', () => {
  it('gives each agent its own dialect', () => {
    const factory = makeSessionFactory(CONFIG, deps)
    expect(factory.dialectFor('acp-grok', CONFIG.presets['acp-grok']!)).toBe(grokDialect)
    expect(factory.dialectFor('acp-claude', CONFIG.presets['acp-claude']!)).toBe(claudeDialect)
    expect(factory.dialectFor('acp-codex', CONFIG.presets['acp-codex']!)).toBe(codexDialect)
  })

  it('refuses an agent it does not drive, rather than guessing a dialect', () => {
    // Guessing here would parse a native session's frames as ACP and write
    // whatever came out into its log.
    const factory = makeSessionFactory(CONFIG, deps)
    expect(factory.dialectFor('dsh', { agent: 'native' })).toBeUndefined()
    expect(factory.dialectFor('dsh', {})).toBeUndefined()
  })

  it('reports a preset that is not configured instead of opening nothing', () => {
    // Opening nothing would leave the session running with no agent, which
    // looks exactly like an agent that is merely slow.
    const factory = makeSessionFactory(CONFIG, deps)
    expect(() => factory.open('acp-missing', { cwd: '/tmp' })).toThrow(/no preset named/)
  })
})
