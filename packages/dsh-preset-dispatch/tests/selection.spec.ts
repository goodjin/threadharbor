/**
 * Reading the session's own model choice and deciding who serves it.
 *
 * The replaced step never fires a model request, so the picker's choice would
 * otherwise sit unused while the preset's agent answers anyway — the exact
 * "the interface shows one thing, the session does another" state these tests
 * pin down. Both directions matter: a selection the preset serves must reach
 * the turn, and one it does not serve must refuse with a reason that names the
 * models involved.
 */

import { describe, expect, it } from 'vitest'
import { decideSelection, pendingSelectionOf, selectionOf } from '../src/selection.ts'

const CONFIG = {
  presetId: 'acp-grok',
  models: [{ id: 'grok-4.7' }, { id: 'grok-4.6' }, { id: 'grok-4.5' }],
}

describe('pendingSelectionOf', () => {
  it('reads a pending selection out of the projection state', () => {
    expect(pendingSelectionOf({
      lastUsed: { provider: 'acp:acp-grok', model: 'grok-4.7' },
      pending: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    })).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  })

  it('reads nothing when the selection was already consumed', () => {
    expect(pendingSelectionOf({ lastUsed: { provider: 'acp:acp-grok', model: 'grok-4.7' }, pending: null })).toBeUndefined()
  })

  it('reads nothing from a state this host does not compose', () => {
    expect(pendingSelectionOf(undefined)).toBeUndefined()
    expect(pendingSelectionOf('nope')).toBeUndefined()
    expect(pendingSelectionOf({ pending: { provider: 1 } })).toBeUndefined()
  })
})

describe('decideSelection', () => {
  it('serves a selection this preset routes and names', () => {
    expect(decideSelection(CONFIG, { provider: 'acp:acp-grok', model: 'grok-4.6' }))
      .toEqual({ kind: 'own', modelId: 'grok-4.6' })
  })

  it('reads a bare selection value, as the host default reports it', () => {
    expect(selectionOf({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(selectionOf(null)).toBeUndefined()
    expect(selectionOf({ provider: 'x' })).toBeUndefined()
  })

  it('refuses a foreign provider, naming the models on both sides', () => {
    // The visible failure this module exists to prevent: the picker shows the
    // whole catalog, so a native selection lands here looking servable.
    const decision = decideSelection(CONFIG, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.reason).toContain('deepseek-official / deepseek-v4-pro')
    expect(decision.reason).toContain('acp-grok')
    expect(decision.reason).toContain('grok-4.7')
  })

  it('refuses a model routed to another ACP preset too', () => {
    // Two ACP rows can be live at once; a session on one must not answer with
    // the other's agent just because both are external.
    expect(decideSelection(CONFIG, { provider: 'acp:acp-codex', model: 'gpt-5.2' }).kind).toBe('refuse')
  })

  it('refuses this preset route naming a model the preset never advertised', () => {
    // The picker shows every catalog group; "provider matches" alone would let
    // a model this agent never offered through.
    expect(decideSelection(CONFIG, { provider: 'acp:acp-grok', model: 'grok-4.7-fast' }).kind).toBe('refuse')
  })

  it('names the host default as the source when the refusal is about it', () => {
    const decision = decideSelection(CONFIG, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, 'host-default')
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.reason).toContain('这台主机的默认模型 deepseek-official / deepseek-v4-pro')
  })

  it('says so honestly when the preset declares no models at all', () => {
    const decision = decideSelection({ presetId: 'acp-x', models: [] }, { provider: 'acp:acp-x', model: 'm' })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.reason).toContain('没有声明任何模型')
  })
})
