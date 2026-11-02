/**
 * The fabric every mounted row shares: the mounted-preset directory the
 * planner reads, and the handover/switch ledgers a cross-row switch writes and
 * consumes.
 */

import { describe, expect, it } from 'vitest'
import { makeSwitchShared } from '../src/switch-shared.ts'

const GROK = { agent: 'grok', url: 'ws://127.0.0.1:2419' } as const
const CODEX = {
  agent: 'codex',
  command: 'codex-acp',
  models: [{ id: 'gpt-6', name: 'GPT-6', contextWindow: 272_000 }],
} as const

describe('mounted-preset directory', () => {
  it('shows every registered preset to the planner', () => {
    const shared = makeSwitchShared()
    shared.registerPreset('acp-grok', GROK, [])
    shared.registerPreset('acp-codex', CODEX, [{ id: 'gpt-6', name: 'GPT-6', contextWindow: 272_000 }])
    expect(Object.keys(shared.config().presets)).toEqual(['acp-grok', 'acp-codex'])
    expect(shared.modelsOf('acp-codex').map(model => model.id)).toEqual(['gpt-6'])
    expect(shared.modelsOf('acp-unknown')).toEqual([])
  })

  it('answers the declared window, and only a usable one', () => {
    const shared = makeSwitchShared()
    shared.registerPreset('acp-codex', CODEX, [
      { id: 'gpt-6', name: 'GPT-6', contextWindow: 272_000 },
      { id: 'gpt-5', name: 'GPT-5' },
    ])
    expect(shared.contextWindowOf('acp-codex', 'gpt-6')).toBe(272_000)
    expect(shared.contextWindowOf('acp-codex', 'gpt-5')).toBeUndefined()
    expect(shared.contextWindowOf('acp-unknown', 'gpt-6')).toBeUndefined()
  })
})

describe('handover ledger', () => {
  it('hands the priming to the first taker and only them', () => {
    const shared = makeSwitchShared()
    shared.primeHandover('n1', '记录')
    expect(shared.takeHandover('n1')).toBe('记录')
    expect(shared.takeHandover('n1')).toBeUndefined()
  })

  it('restores priming that failed to deliver', () => {
    const shared = makeSwitchShared()
    shared.primeHandover('n1', '记录')
    expect(shared.takeHandover('n1')).toBe('记录')
    shared.restoreHandover('n1', '记录')
    expect(shared.takeHandover('n1')).toBe('记录')
  })
})

describe('switch records', () => {
  it('remembers the switch a source session made', () => {
    const shared = makeSwitchShared()
    shared.recordSwitch('s1', { target: 'acp-codex', sessionId: 'n1' })
    expect(shared.switchFor('s1')).toEqual({ target: 'acp-codex', sessionId: 'n1' })
    expect(shared.switchFor('s2')).toBeUndefined()
  })

  it('stops pointing at a new session that no longer exists', () => {
    // A deleted session is not a place to send anyone; the switch may be made
    // again instead.
    const sessions = new Map([['n1', { id: 'n1' }]])
    const shared = makeSwitchShared({ sessionById: id => sessions.get(id) })
    shared.recordSwitch('s1', { target: 'acp-codex', sessionId: 'n1' })
    expect(shared.switchFor('s1')).toEqual({ target: 'acp-codex', sessionId: 'n1' })
    sessions.delete('n1')
    expect(shared.switchFor('s1')).toBeUndefined()
  })
})
