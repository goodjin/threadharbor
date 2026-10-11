/**
 * The preset ↔ model linkage.
 *
 * DSH's own composition keeps a session's preset and its model independent —
 * a native session may run preset X with model Y from any provider. The
 * takeover cannot route turns to another provider's adapter, so independence
 * degrades into a collision unless the two picks follow each other. This pins
 * the follow rules: a preset pick selects that preset's first model, a model
 * pick moves the session to the preset that serves it, and the refusal stays
 * only for picks nothing can serve.
 */

import { describe, expect, it } from 'vitest'
import { decideModelFollow, decidePresetFollow, followModelSelection, followPresetSelection } from '../src/follow.ts'
import type { FollowServices } from '../src/follow.ts'
import type { SelectionLike } from '../src/selection.ts'

const GROK = { presetId: 'acp-grok', models: [{ id: 'grok-4.7' }, { id: 'grok-4.6' }] }

describe('decidePresetFollow — a preset pick selects its first model', () => {
  it('writes the first model when nothing is pending', () => {
    // A fresh session on a preset shows the host default in its composer; the
    // preset's own first model is what makes the two picks agree.
    expect(decidePresetFollow(GROK, undefined)).toEqual({ kind: 'write', modelId: 'grok-4.7' })
  })

  it('keeps a pending model the preset serves', () => {
    const pending: SelectionLike = { provider: 'acp:acp-grok', model: 'grok-4.6' }
    expect(decidePresetFollow(GROK, pending)).toEqual({ kind: 'keep' })
  })

  it('overwrites a pending pick the preset cannot serve', () => {
    // A native pick, or another preset's model, older than the preset choice:
    // the preset pick is the newer intent, and leaving the stale one pending
    // would refuse the next turn for a wish the user has already replaced.
    expect(decidePresetFollow(GROK, { provider: 'acp:acp-codex', model: 'gpt-6' })).toEqual({ kind: 'write', modelId: 'grok-4.7' })
    expect(decidePresetFollow(GROK, { provider: 'deepseek', model: 'deepseek-chat' })).toEqual({ kind: 'write', modelId: 'grok-4.7' })
  })
})

describe('decideModelFollow — a model pick follows its preset', () => {
  it('does nothing for a model this preset serves', () => {
    expect(decideModelFollow(GROK, { provider: 'acp:acp-grok', model: 'grok-4.6' }, 'acp-grok'))
      .toEqual({ kind: 'none' })
  })

  it('does nothing for a native model — the turn refuses with the reason', () => {
    expect(decideModelFollow(GROK, { provider: 'deepseek', model: 'deepseek-chat' }, 'acp-grok'))
      .toEqual({ kind: 'none' })
  })

  it('does nothing once the session is no longer on this preset', () => {
    expect(decideModelFollow(GROK, { provider: 'acp:acp-codex', model: 'gpt-6' }, 'acp-codex'))
      .toEqual({ kind: 'none' })
  })

  it('switches in place when the session is still blank', () => {
    expect(decideModelFollow(GROK, { provider: 'acp:acp-codex', model: 'gpt-6' }, 'acp-grok'))
      .toEqual({ kind: 'switch', target: 'acp-codex' })
  })

  it('calls a started session locked instead of planning a fork that cannot take the preset', () => {
    // Verified on a real host: the host only takes a preset on a blank session,
    // and a fork of a started session carries the started state across — the
    // fork is created, then select fails with "This session has already
    // started". Planning one anyway strands an empty copy beside a refused
    // pick, so the started case is reported locked and the turn refuses.
    expect(decideModelFollow(GROK, { provider: 'acp:acp-codex', model: 'gpt-6' }, 'acp-grok', true))
      .toEqual({ kind: 'locked', target: 'acp-codex' })
  })
})

/** A service set with one blank session, an agents registry, and a preset registry. */
function services(overrides: {
  started?: boolean
  pending?: unknown
  currentPreset?: string | undefined
  mounted?: readonly string[]
} = {}): {
  services: FollowServices
  appends: { type: string; data: unknown }[]
  selected: [agent: unknown, preset: string][]
  forks: string[]
  reports: string[]
} {
  const appends: { type: string; data: unknown }[] = []
  const selected: [agent: unknown, preset: string][] = []
  const forks: string[] = []
  const reports: string[] = []
  const session = {
    id: 's1',
    append(type: string, data: unknown): { seq: number } {
      appends.push({ type, data })
      return { seq: appends.length }
    },
  }
  const agent = { id: 's1', session }
  const mounted = overrides.mounted ?? ['acp-grok', 'acp-codex']
  const services: FollowServices = {
    projections: (_session, key) => {
      if (key === 'turnBoundary') {
        return overrides.started === true ? { lastTurn: 1 } : {}
      }
      if (key === 'modelSelection') return overrides.pending ?? {}
      if (key === 'agentPreset') return overrides.currentPreset === undefined ? null : { agentPreset: overrides.currentPreset }
      return {}
    },
    agents: () => agent,
    sessions: () => session,
    presets: (candidate, presetId) => {
      if (!mounted.includes(presetId)) throw new Error(`agent-preset/not-found: ${presetId}`)
      selected.push([candidate, presetId])
      return Promise.resolve({})
    },
    createSession: request => {
      forks.push(`create:${request.agentPreset ?? 'native'}`)
      return Promise.resolve({ sessionId: 'created-1' })
    },
    promptSession: () => Promise.resolve({ accepted: true }),
  }
  return { services, appends, selected, forks, reports }
}

describe('followPresetSelection — the write that lands on the session', () => {
  it('appends this preset\'s first model to a blank session', async () => {
    const fixture = services()
    await followPresetSelection(fixture.services, 'acp-grok', GROK.models, 's1', { session: fixture.services.sessions?.('s1') }, message => fixture.reports.push(message))
    expect(fixture.appends).toEqual([
      { type: 'model/selection', data: { provider: 'acp:acp-grok', model: 'grok-4.7' } },
    ])
    expect(fixture.reports).toHaveLength(1)
  })

  it('keeps a pending model the preset serves, writing nothing', async () => {
    const fixture = services({ pending: { lastUsed: null, pending: { provider: 'acp:acp-grok', model: 'grok-4.6' } } })
    await followPresetSelection(fixture.services, 'acp-grok', GROK.models, 's1', { session: fixture.services.sessions?.('s1') }, message => fixture.reports.push(message))
    expect(fixture.appends).toEqual([])
  })

  it('leaves a started session alone', async () => {
    const fixture = services({ started: true })
    await followPresetSelection(fixture.services, 'acp-grok', GROK.models, 's1', { session: fixture.services.sessions?.('s1') }, message => fixture.reports.push(message))
    expect(fixture.appends).toEqual([])
  })

  it('skips quietly when this host composes no projections', async () => {
    // Without the service the blank check cannot be made, and writing a model
    // onto a started session would rewrite a choice the user may have made on
    // purpose. Scenario 1 still works: the turn reads the host default.
    const fixture = services()
    await followPresetSelection({ ...fixture.services, projections: undefined }, 'acp-grok', GROK.models, 's1', { session: {} }, message => fixture.reports.push(message))
    expect(fixture.appends).toEqual([])
  })
})

describe('followModelSelection — the move that lands on the session', () => {
  const pick = { provider: 'acp:acp-codex', model: 'gpt-6' }

  it('selects the target preset on a blank session', async () => {
    const fixture = services({ currentPreset: 'acp-grok' })
    await followModelSelection(fixture.services, 'acp-grok', pick, 's1', { session: fixture.services.sessions?.('s1') }, message => fixture.reports.push(message))
    expect(fixture.selected).toHaveLength(1)
    expect(fixture.selected[0]![1]).toBe('acp-codex')
    expect(fixture.forks).toEqual([])
  })

  it('does not move a started session, and says why', async () => {
    // The host locks a started session's preset, and a fork replays the lock
    // (the copy's prefix carries the source's turn boundaries). The pick stays
    // pending; the mounted switch performs it at the next turn.
    const fixture = services({ currentPreset: 'acp-grok', started: true })
    await followModelSelection(fixture.services, 'acp-grok', pick, 's1', { session: fixture.services.sessions?.('s1') }, message => fixture.reports.push(message))
    expect(fixture.selected).toEqual([])
    expect(fixture.forks).toEqual([])
    expect(fixture.reports.join('\n')).toContain('has started')
    expect(fixture.reports.join('\n')).toContain('new-session handover')
  })

  it('says so, and moves nothing, when the target preset is not on this host', async () => {
    const fixture = services({ currentPreset: 'acp-grok', mounted: ['acp-grok'] })
    await followModelSelection(fixture.services, 'acp-grok', pick, 's1', { session: fixture.services.sessions?.('s1') }, message => fixture.reports.push(message))
    expect(fixture.selected).toEqual([])
    expect(fixture.forks).toEqual([])
    expect(fixture.reports.join('\n')).toContain('acp-codex')
  })
})
