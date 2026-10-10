/**
 * The switch chain as the host actually reaches it: a model request landing on
 * one of this row's routes for a session the row does not drive.
 *
 * The load-bearing properties:
 *
 * - the chain runs in the host's order — judge, plan, hand over, apply — and a
 *   locked session is forked first, selected second, never the reverse;
 * - a second request for a target already forked to says where to go instead
 *   of duplicating the conversation;
 * - every dead end throws by name. The one outcome this must never produce is
 *   a request that quietly does nothing.
 */

import { describe, expect, it } from 'vitest'
import { estimateTokens, mountSwitchOnForeignModelRequest } from '../src/switch-mount.ts'
import { providerRoute } from '../src/catalog.ts'
import type { CatalogDeps } from '../src/catalog.ts'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' },
    'acp-claude': { agent: 'claude', command: 'claude-agent-acp' },
  },
}

const deps: CatalogDeps = {
  modelsOf: presetId => presetId === 'acp-grok'
    ? [{ id: 'grok-4.7', name: 'Grok 4.7' }]
    : [{ id: 'claude-opus-4', name: 'Claude Opus 4' }],
  dialectOf: () => undefined,
}

/** A host context exposing exactly the services named, with recorded effects. */
function hostWith(over: {
  sessions?: Map<string, unknown>
  projection?: (session: unknown, key: string) => unknown
  fork?: (request: { sessionId: string }) => Promise<unknown>
  agents?: Map<string, unknown>
  select?: (agent: unknown, presetId: string) => Promise<unknown>
} = {}): { ctx: object; effects: { forks: string[]; selections: [unknown, string][] } } {
  const sessions = over.sessions ?? new Map([['s1', { id: 's1' }]])
  // The live-agent registry answers for every session on this host, forks
  // included; the fork's agent exists by the time select runs.
  const agents = over.agents ?? new Map([['s1', { id: 's1' }], ['s1-copy', { id: 's1-copy' }]])
  const effects = { forks: [] as string[], selections: [] as [unknown, string][] }
  const projection = over.projection ?? (() => undefined)
  const ctx = {
    get: (key: string) => {
      switch (key) {
        case 'sessions': return { get: (id: string) => sessions.get(id) }
        case 'sessionProjections': return { stateOf: (session: unknown, k: string) => projection(session, k) }
        case 'sessionController': return {
          fork: over.fork ?? (async (request: { sessionId: string }) => {
            effects.forks.push(request.sessionId)
            return { sessionId: `${request.sessionId}-copy` }
          }),
        }
        case 'agents': return { get: (id: string) => agents.get(id) }
        case 'agentPresets': return {
          select: over.select ?? (async (agent: unknown, presetId: string) => {
            effects.selections.push([agent, presetId])
            return presetId
          }),
        }
        default: return undefined
      }
    },
  }
  return { ctx, effects }
}

const request = {
  provider: providerRoute('acp-claude'),
  model: 'claude-opus-4',
  sessionId: 's1',
}

const switchedBoundary = { openTurnStartSeq: 12, lastTurn: 1 }
const untouchedBoundary = { openTurnStartSeq: null, lastTurn: 0 }

describe('mountSwitchOnForeignModelRequest', () => {
  it('refuses by name when the host does not expose the switch services', async () => {
    // A context without even `get`: every service is missing, and the refusal
    // names the whole list, because "nothing happened" is the failure to avoid.
    const handler = mountSwitchOnForeignModelRequest({}, CONFIG, deps, () => {})
    await expect(handler(request)).rejects.toThrow(
      /does not expose: sessions, sessionProjections, sessionController, agents, agentPresets/,
    )
  })

  it('refuses when the session is gone', async () => {
    const { ctx } = hostWith()
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, () => {})
    await expect(handler({ ...request, sessionId: 's-gone' })).rejects.toThrow(/s-gone.*not on this host/)
  })

  it('says the takeover failed rather than switching a session that is already there', async () => {
    // currentPreset === target is the "our own takeover silently failed" case:
    // forking here would duplicate the conversation to fix nothing.
    const { ctx } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-claude' : switchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, () => {})
    await expect(handler(request)).rejects.toThrow(/takeover did not happen/)
  })

  it('switches a fresh session in place, without forking', async () => {
    const { ctx, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : untouchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, () => {})
    await expect(handler(request)).rejects.toThrow(/switched in place to acp-claude/)
    expect(effects.forks).toEqual([])
    expect(effects.selections).toEqual([[{ id: 's1' }, 'acp-claude']])
  })

  it('forks a started session first and selects on the fork', async () => {
    // The host locks a session that has produced turns; the fork is not locked,
    // so the order fork-then-select is the only one that works.
    const { ctx, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, () => {})
    await expect(handler(request)).rejects.toThrow(/forked to session s1-copy.*continue there/)
    expect(effects.forks).toEqual(['s1'])
    expect(effects.selections).toEqual([[{ id: 's1-copy' }, 'acp-claude']])
  })

  it('points at the existing fork instead of duplicating it', async () => {
    const { ctx, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, () => {})
    await expect(handler(request)).rejects.toThrow(/forked to session s1-copy/)
    await expect(handler(request)).rejects.toThrow(/already forked to acp-claude as session s1-copy/)
    expect(effects.forks).toEqual(['s1'])
    expect(effects.selections).toHaveLength(1)
  })

  it('names the forked session when selecting on it fails', async () => {
    // The worst mid-switch outcome is a stray empty copy nobody can name.
    const { ctx } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
      select: async () => { throw new Error('target unreachable') },
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, () => {})
    await expect(handler(request)).rejects.toThrow(/s1-copy.*target unreachable/)
  })

  it('says which agent it could not select when the fork has no live agent', async () => {
    const { ctx } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : switchedBoundary,
      agents: new Map(),
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, () => {})
    await expect(handler(request)).rejects.toThrow(/s1-copy.*cannot be selected/)
  })

  it('refuses to hand a session back to the native agent it cannot name', async () => {
    // Only reachable from a future caller — this hook is invoked for this row's
    // own routes, which always name one of its presets — but the port refuses
    // honestly rather than guessing the host's native preset id.
    const { ctx, effects } = hostWith({
      projection: (_session, key) => key === 'agentPreset' ? 'acp-grok' : untouchedBoundary,
    })
    const handler = mountSwitchOnForeignModelRequest(ctx, CONFIG, deps, () => {})
    await expect(handler({ ...request, provider: 'deepseek' }))
      .rejects.toThrow(/cannot hand a session back to the native agent/)
    expect(effects.selections).toEqual([])
  })
})

describe('estimateTokens', () => {
  it('counts nothing for a request without messages', () => {
    expect(estimateTokens(undefined)).toBe(0)
  })

  it('estimates from the conversation the request carried', () => {
    // '{"a":1}' is seven characters; about four characters to a token.
    expect(estimateTokens([{ a: 1 }])).toBe(2)
  })
})
