/**
 * Reading the session's own model choice and deciding who serves it.
 *
 * The replaced step never fires a model request, so the picker's choice would
 * otherwise sit unused while the preset's agent answers anyway — the exact
 * "the interface shows one thing, the session does another" state these tests
 * pin down. The linkage (`follow.ts`) keeps the two picks in step, so the
 * refusal here is the fallback for picks nothing can serve, and the host
 * default — which nobody picked — is no opinion at all.
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
    })).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
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
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
    expect(selectionOf(null)).toBeUndefined()
    expect(selectionOf({ provider: 'x' })).toBeUndefined()
  })

  it('treats the host default as no opinion, whatever it names', () => {
    // A fresh session on a preset shows the host default in its composer
    // without anyone picking it. The preset answers with its own default
    // instead of refusing — refusing here would make scenario 1 impossible.
    expect(decideSelection(CONFIG, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, 'host-default'))
      .toEqual({ kind: 'none' })
    expect(decideSelection(CONFIG, { provider: 'acp:acp-codex', model: 'gpt-5.2' }, 'host-default'))
      .toEqual({ kind: 'none' })
    expect(decideSelection(CONFIG, { provider: 'acp:acp-grok', model: 'dropped-model' }, 'host-default'))
      .toEqual({ kind: 'none' })
  })

  it('refuses an explicit native pick, saying why and what would work', () => {
    // The visible failure this module exists to prevent: the picker shows the
    // whole catalog, so a native selection lands here looking servable.
    const decision = decideSelection(CONFIG, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.reason).toContain('deepseek-official / deepseek-v4-pro')
    expect(decision.reason).toContain('acp-grok')
    expect(decision.reason).toContain('新建')
  })

  it('refuses an explicit pick of another preset\'s model, naming that preset', () => {
    // Two ACP rows can be live at once. The follow should have moved the
    // session; when it could not — the target preset not on this host, or the
    // session started — the turn says what stood in the way.
    const decision = decideSelection(CONFIG, { provider: 'acp:acp-codex', model: 'gpt-5.2' })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.reason).toContain('acp-codex')
    expect(decision.reason).toContain('自动切换没有发生')
  })

  it('refuses this preset route naming a model the preset never advertised', () => {
    // The picker shows every catalog group; "provider matches" alone would let
    // a model this agent never offered through.
    const decision = decideSelection(CONFIG, { provider: 'acp:acp-grok', model: 'grok-4.7-fast' })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.reason).toContain('grok-4.7-fast')
    expect(decision.reason).toContain('grok-4.5')
  })

  it('says so honestly when the preset declares no models at all', () => {
    const decision = decideSelection({ presetId: 'acp-x', models: [] }, { provider: 'acp:acp-x', model: 'm' })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.reason).toContain('没有声明任何模型')
  })

  it('serves a base-model pick even when the preset only declares suffixed ids', () => {
    // 思考强度已被收进 reasoning.efforts，picker 选的是基础 id
    // （gpt-6-astra）。选择层必须按基础 id 认账并原样放行基础 id——
    // effort 走 DSH 自己的 reasoningEffort 字段，不经过这一层，所以这里返回
    // 的 modelId 就是基础 id，不带任何 [后缀]。
    const codex = { presetId: 'acp-codex', models: [{ id: 'gpt-6-astra[low]' }, { id: 'gpt-6-astra[high]' }] }
    const decision = decideSelection(codex, { provider: 'acp:acp-codex', model: 'gpt-6-astra' })
    expect(decision.kind).toBe('own')
    if (decision.kind === 'own') expect(decision.modelId).toBe('gpt-6-astra')
  })

  it('matches a suffixed pick to its base entry, serving the declared wire id', () => {
    // 一个仍带 [后缀] 的旧选择（或 host default）也要认账：按基础 id 对上声明项，
    // 返回声明的那条带后缀的 wire id——agent 只认它。
    const codex = { presetId: 'acp-codex', models: [{ id: 'gpt-6-astra[low]' }, { id: 'gpt-6-astra[high]' }] }
    const decision = decideSelection(codex, { provider: 'acp:acp-codex', model: 'gpt-6-astra[high]' })
    expect(decision.kind).toBe('own')
    if (decision.kind === 'own') expect(decision.modelId).toBe('gpt-6-astra[high]')
  })

  it('still refuses a base model the preset never advertised at any effort', () => {
    const codex = { presetId: 'acp-codex', models: [{ id: 'gpt-6-astra[low]' }, { id: 'gpt-6-astra[high]' }] }
    const decision = decideSelection(codex, { provider: 'acp:acp-codex', model: 'gpt-9-unknown' })
    expect(decision.kind).toBe('refuse')
  })
})
