/**
 * What should happen when the selection changes.
 *
 * Decided before performing anything, because two of the three outcomes differ
 * only in *why* they do nothing, and a session that silently keeps the wrong
 * agent is the worst of them:
 *
 *   - same agent  → nothing to do (the common case)
 *   - native model → switch back to the native agent
 *   - different agent → switch, unless the session has already produced turns
 *     and is therefore locked; then say so rather than truncating history
 */

import { describe, expect, it } from 'vitest'
import { decideOnSelection } from '../src/switch.ts'
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

// The decision takes (config, deps, selection, state) — state is the fourth.
const state = (over: Partial<Parameters<typeof decideOnSelection>[3]> = {}) => ({
  currentPreset: 'acp-grok' as string | undefined,
  started: false,
  ...over,
})

describe('decideOnSelection', () => {
  it('does nothing when the selected model is already in use', () => {
    const d = decideOnSelection(CONFIG, deps, {
      provider: providerRoute('acp-grok'), model: 'grok-4.7',
    }, state())
    expect(d.kind).toBe('none')
  })

  it('switches to the other agent when the selection belongs to another', () => {
    const d = decideOnSelection(CONFIG, deps, {
      provider: providerRoute('acp-claude'), model: 'claude-opus-4',
    }, state())
    expect(d).toEqual({ kind: 'switch', preset: 'acp-claude' })
  })

  it('switches back to the native agent when a native model is selected', () => {
    const d = decideOnSelection(CONFIG, deps, { provider: 'deepseek', model: 'deepseek-chat' }, state())
    expect(d).toEqual({ kind: 'switch', preset: undefined })
  })

  it('refuses to switch a session that has already produced turns', () => {
    // DSH locks the preset once a turn has run. Silently keeping the old agent
    // would leave the user typing to grok while the selector says claude.
    const d = decideOnSelection(CONFIG, deps, {
      provider: providerRoute('acp-claude'), model: 'claude-opus-4',
    }, state({ started: true }))
    expect(d.kind).toBe('locked')
  })

  it('offers a way forward rather than only refusing', () => {
    // The user needs somewhere to go, not just a refusal.
    const d = decideOnSelection(CONFIG, deps, {
      provider: providerRoute('acp-claude'), model: 'claude-opus-4',
    }, state({ started: true }))
    expect(d.kind === 'locked' && d.forkTo === 'acp-claude').toBe(true)
  })

  it('still does nothing when a locked session keeps its own model', () => {
    const d = decideOnSelection(CONFIG, deps, {
      provider: providerRoute('acp-grok'), model: 'grok-4.7',
    }, state({ started: true }))
    expect(d.kind).toBe('none')
  })

  it('ignores a model under an external route the agent does not serve', () => {
    // Otherwise a mislabelled entry could switch the session to an agent that
    // cannot answer with that model.
    const d = decideOnSelection(CONFIG, deps, {
      provider: providerRoute('acp-grok'), model: 'claude-opus-4',
    }, state())
    expect(d.kind).toBe('none')
  })

  it('ignores a route for a preset that is not configured', () => {
    const d = decideOnSelection(CONFIG, deps, {
      provider: providerRoute('acp-gone'), model: 'whatever',
    }, state())
    expect(d.kind).toBe('none')
  })
})